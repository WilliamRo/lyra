# =============================================================================
# registry.py: One-time invites, credentials, check-ins, presence, usage pools.
# =============================================================================

import re

from . import security
from .db import dumps, loads
from .events import ApiError


HANDLE_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')
RESERVED_HANDLES = {'owner', 'admin', 'lyra', 'system'}
MODES = ('queue', 'jump')
STATUS_KEYS = ('model', 'effort', 'context_pct', 'busy', 'attached', 'version', 'gate')


def _clip(value, limit):
  if value is None:
    return None
  return str(value).strip()[:limit] or None


def clean_modes(modes):
  out = [m for m in MODES if m in (modes or [])]
  return out if 'queue' in out else ['queue'] + [m for m in out if m != 'queue']


def clean_usage(usage):
  """Provider-neutral metrics: [{name, used_pct, remaining_pct, resets_at, unit, note}]."""
  if not isinstance(usage, dict):
    return None
  metrics = []
  for m in (usage.get('metrics') or [])[:12]:
    if not isinstance(m, dict) or not m.get('name'):
      continue
    item = {'name': _clip(m.get('name'), 40)}
    for k in ('used_pct', 'remaining_pct'):
      v = m.get(k)
      if isinstance(v, (int, float)):
        item[k] = max(0.0, min(100.0, float(v)))
    for k in ('resets_at', 'unit', 'note'):
      if m.get(k) is not None:
        item[k] = _clip(m.get(k), 64)
    metrics.append(item)
  return {'metrics': metrics} if metrics else None


class RegistryMixin:

  # --- invites -------------------------------------------------------------

  def create_invite(self, display_name=None, handle=None, pool_id=None, target_principal_id=None):
    now = self.now()
    handle = _clip(handle, 32)
    if handle:
      handle = handle.lower()
      if not HANDLE_RE.match(handle) or handle in RESERVED_HANDLES:
        raise ApiError(422, 'bad_handle', 'handle must be 1 to 32 of a-z, 0-9, _ or -')
    if pool_id is not None and not self.db.one('SELECT 1 FROM pools WHERE id=?', (pool_id,)):
      raise ApiError(404, 'no_pool', 'unknown pool')
    if target_principal_id is not None:
      t = self.db.one("SELECT * FROM principals WHERE id=? AND kind='agent'", (target_principal_id,))
      if not t:
        raise ApiError(404, 'no_principal', 'unknown agent to re-admit')
      if t['status'] == 'admitted':
        raise ApiError(409, 'already_admitted', 'that agent is already admitted')
      handle = handle or t['handle']
      display_name = display_name or t['display_name']
    code = security.new_token('lyra-inv')
    with self.db.tx() as c:
      cur = c.execute(
        'INSERT INTO invites(code_hash, display_name, handle, pool_id, target_principal_id, '
        'created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (security.token_hash(code), _clip(display_name, 64), handle, pool_id,
         target_principal_id, now, now + self.settings.invite_ttl_sec),
      )
      self.events.append(c, 'invite', id=cur.lastrowid, action='created')
    self.events.notify()
    return {'code': code, 'invite': self.invite_view(self.db.one(
      'SELECT * FROM invites WHERE id=?', (cur.lastrowid,)))}

  def cancel_invite(self, invite_id):
    with self.db.tx() as c:
      row = c.execute('SELECT * FROM invites WHERE id=?', (invite_id,)).fetchone()
      if not row:
        raise ApiError(404, 'no_invite', 'unknown invite')
      if row['redeemed_at']:
        raise ApiError(409, 'invite_used', 'invite already redeemed')
      c.execute('UPDATE invites SET cancelled_at=? WHERE id=?', (self.now(), invite_id))
      self.events.append(c, 'invite', id=invite_id, action='cancelled')
    self.events.notify()
    return {'cancelled': True}

  def invite_view(self, r):
    now = self.now()
    if r['cancelled_at']:
      state = 'cancelled'
    elif r['redeemed_at']:
      state = 'redeemed'
    elif r['expires_at'] < now:
      state = 'expired'
    else:
      state = 'open'
    return {
      'id': r['id'], 'display_name': r['display_name'], 'handle': r['handle'],
      'pool_id': r['pool_id'], 'target_principal_id': r['target_principal_id'],
      'created_at': r['created_at'], 'expires_at': r['expires_at'], 'state': state,
      'redeemed_principal_id': r['redeemed_principal_id'],
    }

  def list_invites(self):
    rows = self.db.all('SELECT * FROM invites ORDER BY id DESC LIMIT 50')
    return [self.invite_view(r) for r in rows]

  # --- join (invite redemption) --------------------------------------------

  def join(self, data):
    code = str(data.get('invite_code') or '')
    client_key = str(data.get('client_key') or '')
    if not code or len(client_key) < 16:
      raise ApiError(422, 'bad_join', 'invite_code and a client_key of 16+ characters are required')
    now = self.now()
    ck = security.token_hash(client_key)
    with self.db.tx() as c:
      inv = c.execute('SELECT * FROM invites WHERE code_hash=?',
                      (security.token_hash(code),)).fetchone()
      if not inv:
        raise ApiError(401, 'bad_invite', 'unknown invite code')
      if inv['cancelled_at']:
        raise ApiError(410, 'invite_cancelled', 'this invite was cancelled')
      if inv['redeemed_at']:
        # i. Retry of a lost response: same client key inside the window rotates the token.
        same = inv['client_key_hash'] == ck
        fresh = now - inv['redeemed_at'] <= self.settings.invite_retry_window_sec
        p = c.execute("SELECT * FROM principals WHERE id=? AND status='admitted'",
                      (inv['redeemed_principal_id'],)).fetchone()
        if not (same and fresh and p):
          raise ApiError(409, 'invite_used', 'this invite has already been used')
        token = self._issue_credential(c, p['id'], inv['id'], now)
        return self._join_result(p, token, rotated=True)
      if inv['expires_at'] < now:
        raise ApiError(410, 'invite_expired', 'this invite has expired')

      handle = (inv['handle'] or _clip(data.get('handle'), 32) or '').lower()
      if not HANDLE_RE.match(handle) or handle in RESERVED_HANDLES:
        raise ApiError(422, 'bad_handle', 'handle must be 1 to 32 of a-z, 0-9, _ or -')
      display = inv['display_name'] or _clip(data.get('display_name'), 64) or handle
      address = _clip(data.get('address'), 200) or f"agent://{handle}"
      clash = c.execute(
        "SELECT id FROM principals WHERE status='admitted' AND (handle=? OR address=?) AND id IS NOT ?",
        (handle, address, inv['target_principal_id']),
      ).fetchone()
      if clash:
        raise ApiError(409, 'identity_in_use', 'an admitted agent already uses this handle or address')

      # ii. Re-admission keeps the durable identity and its history.
      if inv['target_principal_id']:
        pid = inv['target_principal_id']
        c.execute(
          "UPDATE principals SET status='admitted', handle=?, display_name=?, address=?, "
          'admitted_at=?, revoked_at=NULL, pool_id=COALESCE(?, pool_id) WHERE id=?',
          (handle, display, address, now, inv['pool_id'], pid),
        )
      else:
        cur = c.execute(
          'INSERT INTO principals(kind, handle, display_name, address, status, pool_id, '
          "created_at, admitted_at) VALUES ('agent', ?, ?, ?, 'admitted', ?, ?, ?)",
          (handle, display, address, inv['pool_id'], now, now),
        )
        pid = cur.lastrowid
      c.execute('UPDATE invites SET redeemed_at=?, redeemed_principal_id=?, client_key_hash=? '
                'WHERE id=?', (now, pid, ck, inv['id']))
      token = self._issue_credential(c, pid, inv['id'], now)
      self._upsert_presence(c, pid, data, now, online=False)
      self.events.append(c, 'principal', id=pid, action='admitted')
      p = c.execute('SELECT * FROM principals WHERE id=?', (pid,)).fetchone()
    self.events.notify()
    return self._join_result(p, token, rotated=False)

  def _issue_credential(self, c, pid, invite_id, now):
    c.execute("UPDATE credentials SET status='revoked', revoked_at=? WHERE principal_id=? "
              "AND status='active'", (now, pid))
    token = security.new_token('lyra_at')
    c.execute("INSERT INTO credentials(principal_id, token_hash, invite_id, status, created_at) "
              "VALUES (?, ?, ?, 'active', ?)", (pid, security.token_hash(token), invite_id, now))
    return token

  def _join_result(self, p, token, rotated):
    s = self.settings
    return {
      'token': token, 'rotated': rotated,
      'principal': {'id': p['id'], 'handle': p['handle'], 'display_name': p['display_name'],
                    'address': p['address']},
      'server': {'checkin_interval_sec': s.checkin_interval_sec,
                 'checkin_ttl_sec': s.checkin_ttl_sec, 'lease_sec': s.lease_sec},
    }

  def principal_for_token(self, token):
    if not token:
      return None
    return self.db.one(
      "SELECT p.* FROM credentials c JOIN principals p ON p.id = c.principal_id "
      "WHERE c.token_hash=? AND c.status='active' AND p.status='admitted' AND p.kind='agent'",
      (security.token_hash(token),),
    )

  # --- revocation ----------------------------------------------------------

  def revoke(self, pid):
    now = self.now()
    with self.db.tx() as c:
      p = c.execute("SELECT * FROM principals WHERE id=? AND kind='agent'", (pid,)).fetchone()
      if not p:
        raise ApiError(404, 'no_principal', 'unknown agent')
      if p['status'] != 'admitted':
        raise ApiError(409, 'not_admitted', 'agent is not admitted')
      c.execute("UPDATE principals SET status='revoked', revoked_at=? WHERE id=?", (now, pid))
      c.execute("UPDATE credentials SET status='revoked', revoked_at=? WHERE principal_id=? "
                "AND status='active'", (now, pid))
      c.execute('UPDATE presence SET online=0 WHERE principal_id=?', (pid,))
      failed = c.execute(
        "SELECT id FROM messages WHERE recipient_id=? AND state IN ('waiting', 'unconfirmed')",
        (pid,),
      ).fetchall()
      for r in failed:
        self._set_state(c, r['id'], 'failed', 'recipient revoked', now)
      self.events.append(c, 'principal', id=pid, action='revoked')
    self.events.notify()
    self.delivery_cv_notify()
    return {'revoked': True, 'failed_messages': len(failed)}

  def update_principal(self, pid, data):
    with self.db.tx() as c:
      p = c.execute("SELECT * FROM principals WHERE id=? AND kind='agent'", (pid,)).fetchone()
      if not p:
        raise ApiError(404, 'no_principal', 'unknown agent')
      if 'pool_id' in data:
        pool_id = data['pool_id']
        if pool_id is not None and not c.execute('SELECT 1 FROM pools WHERE id=?',
                                                 (pool_id,)).fetchone():
          raise ApiError(404, 'no_pool', 'unknown pool')
        c.execute('UPDATE principals SET pool_id=? WHERE id=?', (pool_id, pid))
        c.execute('UPDATE pools SET reporter_principal_id=NULL WHERE reporter_principal_id=? '
                  'AND id IS NOT ?', (pid, pool_id))
      if data.get('display_name'):
        c.execute('UPDATE principals SET display_name=? WHERE id=?',
                  (_clip(data['display_name'], 64), pid))
      self.events.append(c, 'principal', id=pid, action='updated')
    self.events.notify()
    return {'updated': True}

  # --- check-ins and presence ----------------------------------------------

  def _upsert_presence(self, c, pid, data, now, online):
    status = {k: data.get('status', {}).get(k) for k in STATUS_KEYS} \
      if isinstance(data.get('status'), dict) else {}
    if isinstance(status.get('context_pct'), (int, float)):
      status['context_pct'] = max(0.0, min(100.0, float(status['context_pct'])))
    for k in ('model', 'effort', 'version', 'gate'):
      status[k] = _clip(status.get(k), 64)
    row = (
      pid, _clip(data.get('instance_id'), 120), _clip(data.get('host'), 120),
      _clip(data.get('provider'), 40), _clip(data.get('runtime'), 40),
      _clip(data.get('connector'), 60), dumps(clean_modes(data.get('modes'))), dumps(status),
      now if online else None, 1 if online else 0,
    )
    c.execute(
      'INSERT INTO presence(principal_id, instance_id, host, provider, runtime, connector, modes, '
      'status, last_checkin_at, online) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      'ON CONFLICT(principal_id) DO UPDATE SET instance_id=excluded.instance_id, '
      'host=COALESCE(excluded.host, host), provider=COALESCE(excluded.provider, provider), '
      'runtime=COALESCE(excluded.runtime, runtime), connector=COALESCE(excluded.connector, connector), '
      'modes=excluded.modes, status=excluded.status, '
      'last_checkin_at=COALESCE(excluded.last_checkin_at, last_checkin_at), online=excluded.online',
      row,
    )

  def checkin(self, principal, data):
    now = self.now()
    pid = principal['id']
    ttl = self.settings.checkin_ttl_sec
    instance = _clip(data.get('instance_id'), 120)
    accepted_usage = False
    with self.db.tx() as c:
      prev = c.execute('SELECT * FROM presence WHERE principal_id=?', (pid,)).fetchone()
      if prev and prev['instance_id'] and instance and prev['instance_id'] != instance \
          and prev['last_checkin_at'] and now - prev['last_checkin_at'] <= ttl:
        raise ApiError(409, 'instance_conflict',
                       'another live instance holds this identity', holder=prev['instance_id'])
      old_modes = loads(prev['modes'], []) if prev else []
      old_status = loads(prev['status'], {}) if prev else {}
      was_online = bool(prev and prev['online'])
      self._upsert_presence(c, pid, data, now, online=True)
      cur = c.execute('SELECT modes, status FROM presence WHERE principal_id=?', (pid,)).fetchone()
      if not was_online:
        self.events.append(c, 'presence', id=pid, online=True)
      elif loads(cur['modes'], []) != old_modes or \
          loads(cur['status'], {}).get('busy') != old_status.get('busy'):
        self.events.append(c, 'presence', id=pid, online=True, changed=True)
      # i. Only the pool's designated reporter may write pool usage.
      usage = clean_usage(data.get('usage'))
      if usage and principal['pool_id']:
        pool = c.execute('SELECT * FROM pools WHERE id=?', (principal['pool_id'],)).fetchone()
        if pool and pool['reporter_principal_id'] == pid:
          changed = loads(pool['usage'], None) != usage
          c.execute('UPDATE pools SET usage=?, reported_at=? WHERE id=?',
                    (dumps(usage), now, pool['id']))
          accepted_usage = True
          if changed:
            self.events.append(c, 'pool', id=pool['id'], action='usage')
    self.events.notify()
    return {
      'ok': True, 'accepted_usage': accepted_usage,
      'checkin_interval_sec': self.settings.checkin_interval_sec, 'checkin_ttl_sec': ttl,
    }

  def sweep_presence(self, c, now):
    ttl = self.settings.checkin_ttl_sec
    rows = c.execute('SELECT principal_id FROM presence WHERE online=1 AND '
                     '(last_checkin_at IS NULL OR last_checkin_at < ?)', (now - ttl,)).fetchall()
    for r in rows:
      c.execute('UPDATE presence SET online=0 WHERE principal_id=?', (r['principal_id'],))
      self.events.append(c, 'presence', id=r['principal_id'], online=False)
    return len(rows)

  def presence_view(self, pid):
    r = self.db.one('SELECT * FROM presence WHERE principal_id=?', (pid,))
    if not r:
      return {'online': False, 'last_checkin_at': None, 'modes': ['queue'], 'status': {}}
    online = bool(r['last_checkin_at'] and self.now() - r['last_checkin_at']
                  <= self.settings.checkin_ttl_sec)
    return {
      'online': online, 'last_checkin_at': r['last_checkin_at'], 'instance_id': r['instance_id'],
      'host': r['host'], 'provider': r['provider'], 'runtime': r['runtime'],
      'connector': r['connector'], 'modes': loads(r['modes'], ['queue']),
      'status': loads(r['status'], {}),
    }

  def recipient_modes(self, pid):
    return self.presence_view(pid)['modes']

  def teammates(self, principal):
    rows = self.db.all("SELECT * FROM principals WHERE status='admitted' AND id != ? "
                       'ORDER BY kind DESC, display_name', (principal['id'],))
    out = []
    for p in rows:
      pres = self.presence_view(p['id']) if p['kind'] == 'agent' else None
      out.append({
        'handle': p['handle'], 'display_name': p['display_name'], 'kind': p['kind'],
        'online': pres['online'] if pres else None,
        'modes': pres['modes'] if pres else ['queue'],
        'busy': (pres['status'] or {}).get('busy') if pres else None,
      })
    return out

  # --- usage pools ---------------------------------------------------------

  def create_pool(self, provider, label):
    provider = _clip(provider, 40)
    label = _clip(label, 80)
    if not provider or not label:
      raise ApiError(422, 'bad_pool', 'provider and label are required')
    try:
      with self.db.tx() as c:
        cur = c.execute('INSERT INTO pools(provider, label, created_at) VALUES (?, ?, ?)',
                        (provider, label, self.now()))
        self.events.append(c, 'pool', id=cur.lastrowid, action='created')
    except Exception as exc:  # noqa: BLE001 - unique violation
      if 'UNIQUE' in str(exc):
        raise ApiError(409, 'pool_exists', 'a pool with this provider and label exists') from exc
      raise
    self.events.notify()
    return {'id': cur.lastrowid}

  def update_pool(self, pool_id, data):
    with self.db.tx() as c:
      pool = c.execute('SELECT * FROM pools WHERE id=?', (pool_id,)).fetchone()
      if not pool:
        raise ApiError(404, 'no_pool', 'unknown pool')
      if 'reporter_principal_id' in data:
        rid = data['reporter_principal_id']
        if rid is not None:
          member = c.execute("SELECT 1 FROM principals WHERE id=? AND pool_id=? AND kind='agent'",
                             (rid, pool_id)).fetchone()
          if not member:
            raise ApiError(422, 'not_member', 'the reporter must be an agent in this pool')
        c.execute('UPDATE pools SET reporter_principal_id=?, usage=NULL, reported_at=NULL '
                  'WHERE id=?', (rid, pool_id))
      if data.get('label'):
        c.execute('UPDATE pools SET label=? WHERE id=?', (_clip(data['label'], 80), pool_id))
      self.events.append(c, 'pool', id=pool_id, action='updated')
    self.events.notify()
    return {'updated': True}

  def usage_view(self):
    """One entry per pool, grouped by provider; members change the roster only."""
    now = self.now()
    providers = {}
    for pool in self.db.all('SELECT * FROM pools ORDER BY provider, label'):
      members = self.db.all("SELECT id, display_name, status FROM principals WHERE pool_id=? "
                            "AND kind='agent' ORDER BY display_name", (pool['id'],))
      reporter = None
      stale = True
      if pool['reporter_principal_id']:
        rp = self.db.one('SELECT display_name FROM principals WHERE id=?',
                         (pool['reporter_principal_id'],))
        pres = self.presence_view(pool['reporter_principal_id'])
        reporter = {'id': pool['reporter_principal_id'],
                    'display_name': rp['display_name'] if rp else None,
                    'online': pres['online']}
        stale = not pres['online'] or not pool['reported_at'] or now - pool['reported_at'] > 600
      providers.setdefault(pool['provider'], []).append({
        'id': pool['id'], 'provider': pool['provider'], 'label': pool['label'],
        'reporter': reporter, 'usage': loads(pool['usage'], None),
        'reported_at': pool['reported_at'], 'stale': stale,
        'members': [{'id': m['id'], 'display_name': m['display_name'], 'status': m['status']}
                    for m in members],
      })
    return [{'provider': k, 'pools': v} for k, v in providers.items()]
