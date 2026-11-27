# =============================================================================
# accounts.py: The single administrator account and browser sessions.
# =============================================================================

import secrets

from . import security
from .events import ApiError


COOKIE_NAME = 'lyra_session'
USERNAME_MAX = 64
PASSWORD_MIN = 10


class AccountsMixin:
  """Version 1 has exactly one human administrator (guest access is deferred)."""

  # --- provisioning --------------------------------------------------------

  def admin_exists(self):
    return self.db.one("SELECT 1 FROM users WHERE role='admin'") is not None

  def init_admin(self, username, password, display_name=None):
    username = (username or '').strip()
    if not username or len(username) > USERNAME_MAX:
      raise ApiError(422, 'bad_username', 'username must be 1 to 64 characters')
    if len(password or '') < PASSWORD_MIN:
      raise ApiError(422, 'weak_password', f'password must be at least {PASSWORD_MIN} characters')
    if self.admin_exists():
      raise ApiError(409, 'admin_exists', 'an administrator already exists; use reset-password')
    now = self.now()
    pw = security.hash_password(password)
    with self.db.tx() as c:
      cur = c.execute(
        "INSERT INTO principals(kind, handle, display_name, status, created_at, admitted_at) "
        "VALUES ('owner', 'owner', ?, 'admitted', ?, ?)",
        (display_name or username, now, now),
      )
      c.execute(
        "INSERT INTO users(username, password_hash, role, status, principal_id, created_at) "
        "VALUES (?, ?, 'admin', 'active', ?, ?)",
        (username, pw, cur.lastrowid, now),
      )
    return {'username': username}

  def reset_password(self, username, password):
    if len(password or '') < PASSWORD_MIN:
      raise ApiError(422, 'weak_password', f'password must be at least {PASSWORD_MIN} characters')
    with self.db.tx() as c:
      row = c.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone()
      if not row:
        raise ApiError(404, 'no_user', 'unknown username')
      c.execute('UPDATE users SET password_hash=? WHERE id=?',
                (security.hash_password(password), row['id']))
      c.execute('DELETE FROM web_sessions WHERE user_id=?', (row['id'],))
    return {'username': username, 'sessions_cleared': True}

  # --- sign-in -------------------------------------------------------------

  def login(self, username, password, remember, client_ip):
    username = (username or '').strip()[:USERNAME_MAX]
    keys = [f'u:{username.lower()}', f'ip:{client_ip}']
    wait = self.throttle.retry_after(keys)
    if wait:
      raise ApiError(429, 'too_many_attempts', 'too many failed sign-ins; try again later',
                     retry_after=wait)
    row = self.db.one("SELECT * FROM users WHERE username=? AND status='active'", (username,))
    stored = row['password_hash'] if row else security.hash_password(secrets.token_hex(8))
    if not security.verify_password(password or '', stored) or not row:
      self.throttle.fail(keys)
      raise ApiError(401, 'bad_credentials', 'wrong username or password')
    self.throttle.clear(keys[0])
    now = self.now()
    token = security.new_token('lyra_ws')
    if remember:
      expires = now + self.settings.remember_me_days * 86400
    else:
      expires = now + self.settings.session_idle_hours * 3600
    with self.db.tx() as c:
      c.execute(
        'INSERT INTO web_sessions(id_hash, user_id, persistent, created_at, last_seen_at, '
        'expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        (security.token_hash(token), row['id'], 1 if remember else 0, now, now, expires),
      )
    max_age = self.settings.remember_me_days * 86400 if remember else None
    return token, max_age, self._user_view(row)

  def logout(self, token):
    if token:
      with self.db.tx() as c:
        c.execute('DELETE FROM web_sessions WHERE id_hash=?', (security.token_hash(token),))

  def user_for_cookie(self, token):
    """Return the admin user row for a live browser session, sliding idle expiry."""
    if not token:
      return None
    h = security.token_hash(token)
    now = self.now()
    row = self.db.one(
      'SELECT s.persistent, s.expires_at, u.* FROM web_sessions s JOIN users u ON u.id = s.user_id '
      "WHERE s.id_hash=? AND u.status='active'",
      (h,),
    )
    if not row or row['expires_at'] < now:
      return None
    if not row['persistent']:
      with self.db.tx() as c:
        c.execute('UPDATE web_sessions SET last_seen_at=?, expires_at=? WHERE id_hash=?',
                  (now, now + self.settings.session_idle_hours * 3600, h))
    return row

  def _user_view(self, row):
    owner = self.db.one('SELECT display_name FROM principals WHERE id=?', (row['principal_id'],))
    return {
      'username': row['username'], 'role': row['role'],
      'principal_id': row['principal_id'],
      'display_name': owner['display_name'] if owner else row['username'],
    }

  def prune_sessions(self, conn, now):
    conn.execute('DELETE FROM web_sessions WHERE expires_at < ?', (now,))
