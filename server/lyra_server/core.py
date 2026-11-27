# =============================================================================
# core.py: The Lyra service object, board view, and background sweeper.
# =============================================================================

import logging
import threading
import time

from . import __version__
from .accounts import AccountsMixin
from .db import Database
from .events import EventLog
from .messaging import MessagingMixin
from .registry import RegistryMixin
from .security import LoginThrottle


log = logging.getLogger('lyra')


class Lyra(AccountsMixin, RegistryMixin, MessagingMixin):
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
      'id': p['id'], 'kind': p['kind'], 'handle': p['handle'],
      'display_name': p['display_name'], 'address': p['address'], 'status': p['status'],
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
    return {
      'now': now, 'version': __version__,
      'owner': {'id': owner['id'], 'display_name': owner['display_name']} if owner else None,
      'agents': [self.agent_view(p) for p in agents],
      'invites': [i for i in self.list_invites() if i['state'] == 'open'],
      'pools': [{'id': r['id'], 'provider': r['provider'], 'label': r['label'],
                 'reporter_principal_id': r['reporter_principal_id']}
                for r in self.db.all('SELECT * FROM pools ORDER BY provider, label')],
      'settings': {'checkin_ttl_sec': self.settings.checkin_ttl_sec,
                   'message_ttl_sec': self.settings.message_ttl_sec,
                   'invite_ttl_sec': self.settings.invite_ttl_sec},
      'last_event_id': self.events.latest_id(),
    }
