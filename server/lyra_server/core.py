# =============================================================================
# core.py: The Lyra service object, board view, and background sweeper.
# =============================================================================

import logging
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
    self._stop = threading.Event()
    self._sweeper = None

  # --- background sweeper --------------------------------------------------

  def sweep_once(self):
    now = self.now()
    with self.db.tx() as c:
      went_offline = self.sweep_presence(c, now)
      expired, _lapsed = self.sweep_messages(c, now)
      self.events.prune(c, now - self.settings.event_retention_days * 86400)
      self.prune_sessions(c, now)
      self.sweep_orphan_attachments(c, now)
    if went_offline or expired:
      self.events.notify()
    # i. Lapsed leases become claimable again; wake long-pollers to retry.
    self.delivery_cv_notify()
    return {'offline': went_offline, 'expired': expired}

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
      'admitted_at': p['admitted_at'], 'revoked_at': p['revoked_at'],
      'pool': ({'id': pool['id'], 'provider': pool['provider'], 'label': pool['label'],
                'is_reporter': pool['reporter_principal_id'] == p['id']} if pool else None),
      'presence': pres,
      'waiting': counts.get('waiting', 0), 'unconfirmed': counts.get('unconfirmed', 0),
    }

  def board(self):
    now = self.now()
    agents = self.db.all("SELECT * FROM principals WHERE kind='agent' ORDER BY status, display_name")
    owner = self.owner_principal()
    all_invites = self.list_invites()
    agents = [self.agent_view(p) for p in agents]
    hosts = {}
    for agent in agents:
      presence = agent['presence']
      host = presence.get('host')
      if not host or agent['status'] != 'admitted':
        continue
      row = hosts.setdefault(host, {'host': host, 'online_count': 0, 'agent_ids': [], 'last_seen_at': None,
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
      'consul': self.consul_view(),
      'agents': agents, 'hosts': [hosts[key] for key in sorted(hosts)], 'projects': self.projects_view(),
      'invites': [i for i in all_invites if i['state'] == 'open'],
      'senate_invites': [i for i in all_invites if i.get('issued_by') and i['issued_by']['kind'] == 'agent'],
      'pools': [pool for provider in self.usage_view() for pool in provider['pools']],
      'settings': {'max_attachment_bytes': self.settings.max_attachment_bytes,
                   'max_attachments_per_message': self.settings.max_attachments_per_message,
                   'checkin_ttl_sec': self.settings.checkin_ttl_sec,
                   'message_ttl_sec': self.settings.message_ttl_sec,
                   'invite_ttl_sec': self.settings.invite_ttl_sec},
      'last_event_id': self.events.latest_id(),
    }
