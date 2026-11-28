# =============================================================================
# core.py: The Lyra service object, board view, and background sweeper.
# =============================================================================

import logging
import shutil
import threading
import time

from . import __version__
from .accounts import AccountsMixin
from .attachments import AttachmentMixin
from .db import Database, loads
from .events import EventLog
from .messaging import MessagingMixin
from .registry import RegistryMixin
from .projects import ProjectsMixin
from .security import LoginThrottle


log = logging.getLogger('lyra')


class Lyra(AccountsMixin, RegistryMixin, MessagingMixin, AttachmentMixin, ProjectsMixin):
  """All business rules; the HTTP layer only authenticates and translates."""

  def __init__(self, settings, clock=time.time):
    self.settings = settings
    self.now = clock
    self.db = Database(settings.db_path)
    self.events = EventLog(self.db, clock)
    self.throttle = LoginThrottle(settings.login_max_failures, settings.login_window_sec, clock)
    self._init_messaging()
    self._started_at = self.now()
    self._stop = threading.Event()
    self._sweeper = None

  # --- background sweeper --------------------------------------------------

  def sweep_once(self):
    now = self.now()
    with self.db.tx() as c:
      went_offline = self.sweep_presence(c, now)
      reaped_progress = self.sweep_progress(c, now)
      derived_changed = self.sweep_derived_presence(c, now)
      expired, _lapsed = self.sweep_messages(c, now)
      self.events.prune(c, now - self.settings.event_retention_days * 86400)
      self.prune_sessions(c, now)
      self.sweep_orphan_attachments(c, now)
    if went_offline or expired or reaped_progress or derived_changed:
      self.events.notify()
    # i. Lapsed leases become claimable again; wake long-pollers to retry.
    self.delivery_cv_notify()
    return {'offline': went_offline, 'expired': expired, 'reaped_progress': reaped_progress,
            'derived_changed': derived_changed}

  def start(self, interval=2.0):
    def loop():
      while not self._stop.wait(interval):
        try:
          self.sweep_once()
        except Exception:  # noqa: BLE001 - keep sweeping
          log.exception('sweep failed')
    self._sweeper = threading.Thread(target=loop, name='lyra-sweeper', daemon=True)
    self._sweeper.start()

  def stop(self):
    self._stop.set()
    self.events.notify()
    self.delivery_cv_notify()

  # --- board ---------------------------------------------------------------

  def owner_principal(self):
    return self.db.one("SELECT * FROM principals WHERE kind='owner' LIMIT 1")

  def agent_view(self, p):
    pres = self.presence_view(p['id'])
    pool = self.db.one('SELECT id, provider, label, reporter_principal_id FROM pools WHERE id=?',
                       (p['pool_id'],)) if p['pool_id'] else None
    counts = self.waiting_counts(p['id'])
    return {
      'id': p['id'], 'kind': p['kind'], 'handle': p['handle'], 'role': p['role'],
      'display_name': p['display_name'], 'avatar': loads(p['avatar']), 'address': p['address'], 'status': p['status'],
      'hold': ({'reason': p['hold_reason'], 'since': p['hold_since']} if p['hold_since'] is not None else None),
      'admitted_at': p['admitted_at'], 'revoked_at': p['revoked_at'],
      'pool': ({'id': pool['id'], 'provider': pool['provider'], 'label': pool['label'],
                'is_reporter': pool['reporter_principal_id'] == p['id']} if pool else None),
      'presence': pres,
      'waiting': counts.get('waiting', 0), 'unconfirmed': counts.get('unconfirmed', 0),
    }

  def storage_view(self):
    db_path = self.settings.db_path
    db_bytes = sum(p.stat().st_size for p in (
      db_path, db_path.parent / (db_path.name + '-wal'), db_path.parent / (db_path.name + '-shm'),
    ) if p.is_file())
    att_root = self.settings.attachments_path
    att_files = list(att_root.rglob('*')) if att_root.is_dir() else []
    att_bytes = sum(p.stat().st_size for p in att_files if p.is_file())
    att_count = sum(1 for p in att_files if p.is_file())
    bk_dir = db_path.parent / 'backups'
    bk_files = [p for p in bk_dir.glob('*.sqlite') if p.is_file()] if bk_dir.is_dir() else []
    bk_bytes = sum(p.stat().st_size for p in bk_files)
    with self.db.lock:
      c = self.db.conn
      events_count = c.execute('SELECT COUNT(*) FROM events').fetchone()[0]
      messages_count = c.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
      orphan_row = c.execute("""
        SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments a
        WHERE NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id=a.id)
      """).fetchone()
    total_bytes = db_bytes + att_bytes + bk_bytes
    quota_bytes = max(1, int(float(self.settings.storage_quota_gb) * (1024 ** 3)))
    used_pct = round(100.0 * total_bytes / quota_bytes, 2)
    try:
      disk = shutil.disk_usage(self.settings.data_path)
      host_disk = {'total_bytes': disk.total, 'free_bytes': disk.free}
    except OSError:
      host_disk = {'total_bytes': None, 'free_bytes': None}
    return {
      'quota_gb': self.settings.storage_quota_gb,
      'quota_bytes': quota_bytes,
      'total_bytes': total_bytes,
      'free_bytes': max(0, quota_bytes - total_bytes),
      'used_pct': used_pct,
      'db_bytes': db_bytes,
      'attachments_bytes': att_bytes,
      'attachments_count': att_count,
      'orphan_attachments_count': int(orphan_row[0]),
      'orphan_attachments_bytes': int(orphan_row[1]),
      'backups_bytes': bk_bytes,
      'backups_count': len(bk_files),
      'events_count': int(events_count),
      'messages_count': int(messages_count),
      'data_dir': str(self.settings.data_path),
      'host_disk': host_disk,
      'uptime_sec': round(max(0.0, self.now() - self._started_at), 1),
    }

  def cleanup_storage(self, action='all', keep_backups=5, event_days=7, orphan_grace_sec=300):
    if action not in ('all', 'sweep_orphans', 'prune_events', 'prune_backups', 'vacuum_wal'):
      raise ApiError(422, 'bad_cleanup_action', 'unknown cleanup action')
    now = self.now()
    cleaned = {'orphans_removed': 0, 'events_deleted': 0, 'backups_removed': 0, 'wal_checkpointed': False}
    if action in ('all', 'sweep_orphans'):
      cutoff = now - max(0, int(orphan_grace_sec))
      with self.db.tx() as c:
        rows = c.execute(
          'SELECT id, storage_relpath FROM attachments a WHERE created_at < ? '
          'AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id=a.id)',
          (cutoff,),
        ).fetchall()
        for row in rows:
          try:
            (self.settings.attachments_path / row['storage_relpath']).unlink(missing_ok=True)
          except OSError:
            pass
          c.execute('DELETE FROM attachments WHERE id=?', (row['id'],))
        cleaned['orphans_removed'] = len(rows)
    if action in ('all', 'prune_events'):
      cutoff = now - max(1, int(event_days)) * 86400
      with self.db.tx() as c:
        cur = c.execute('DELETE FROM events WHERE ts < ?', (cutoff,))
        cleaned['events_deleted'] = cur.rowcount
    if action in ('all', 'prune_backups'):
      bk_dir = self.settings.db_path.parent / 'backups'
      if bk_dir.is_dir():
        files = sorted((p for p in bk_dir.glob('*.sqlite') if p.is_file()),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[max(1, int(keep_backups)):]:
          try:
            old.unlink()
            cleaned['backups_removed'] += 1
          except OSError:
            pass
    if action in ('all', 'vacuum_wal'):
      with self.db.lock:
        self.db.conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      cleaned['wal_checkpointed'] = True
    return {'cleaned': cleaned, 'storage': self.storage_view()}

  def board(self):
    # Hold db.lock across every snapshot query and latest_id() so concurrent mutations
    # cannot update last_event_id after stale rows were read.
    with self.db.lock:
      now = self.now()
      agents = self.db.all("SELECT * FROM principals WHERE kind='agent' ORDER BY status, display_name")
      owner = self.owner_principal()
      all_invites = self.list_invites()
      aliases = {r['host']: r['display_name'] for r in self.db.all('SELECT host, display_name FROM host_aliases')}
      agents = [self.agent_view(p) for p in agents]
      consul = self.consul_view()
      projects = self.projects_view()
      pools = [pool for provider in self.usage_view() for pool in provider['pools']]
      last_event_id = self.events.latest_id()
    hosts = {}
    for agent in agents:
      presence = agent['presence']
      host = presence.get('host')
      if not host or agent['status'] != 'admitted':
        continue
      row = hosts.setdefault(host, {'host': host, 'display_name': aliases.get(host, host),
                                    'online_count': 0, 'agent_ids': [], 'last_seen_at': None,
                                    'metrics': {}, 'metrics_at': None})
      row['agent_ids'].append(agent['id'])
      row['online_count'] += int(presence['online'])
      seen = presence['last_checkin_at']
      if seen is not None:
        row['last_seen_at'] = max(seen, row['last_seen_at'] or seen)
        if presence['host_metrics'] and (row['metrics_at'] is None or seen >= row['metrics_at']):
          row['metrics'], row['metrics_at'] = presence['host_metrics'], seen
    return {
      'now': now, 'version': __version__,
      'owner': {'id': owner['id'], 'display_name': owner['display_name'], 'avatar': loads(owner['avatar'])} if owner else None,
      'consul': consul,
      'agents': agents, 'hosts': [hosts[key] for key in sorted(hosts)], 'projects': projects,
      'invites': [i for i in all_invites if i['state'] == 'open'],
      'senate_invites': [i for i in all_invites if i.get('issued_by') and i['issued_by']['kind'] == 'agent'],
      'pools': pools,
      'server_storage': self.storage_view(),
      'settings': {'max_attachment_bytes': self.settings.max_attachment_bytes,
                   'max_attachments_per_message': self.settings.max_attachments_per_message,
                   'checkin_ttl_sec': self.settings.checkin_ttl_sec,
                   'progress_stale_sec': self.settings.progress_stale_sec,
                   'stall_sec': self.settings.stall_sec,
                   'storage_quota_gb': self.settings.storage_quota_gb,
                   'message_ttl_sec': self.settings.message_ttl_sec,
                   'invite_ttl_sec': self.settings.invite_ttl_sec},
      'last_event_id': last_event_id,
    }
