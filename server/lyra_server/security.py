# =============================================================================
# security.py: Password hashing, opaque tokens, and login throttling.
# =============================================================================

import base64
import hashlib
import hmac
import secrets
import threading
import time


SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1


def hash_password(password):
  salt = secrets.token_bytes(16)
  dk = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
                      maxmem=64 * 1024 * 1024, dklen=32)
  b64 = lambda b: base64.b64encode(b).decode('ascii')  # noqa: E731
  return f'scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt)}${b64(dk)}'


def verify_password(password, stored):
  try:
    algo, n, r, p, salt, dk = stored.split('$')
    if algo != 'scrypt':
      return False
    want = base64.b64decode(dk)
    got = hashlib.scrypt(password.encode('utf-8'), salt=base64.b64decode(salt), n=int(n),
                         r=int(r), p=int(p), maxmem=64 * 1024 * 1024, dklen=len(want))
    return hmac.compare_digest(got, want)
  except (ValueError, TypeError):
    return False


def new_token(prefix):
  return f'{prefix}_{secrets.token_urlsafe(32)}'


def token_hash(token):
  return hashlib.sha256(str(token).encode('utf-8')).hexdigest()


class LoginThrottle:
  """In-memory failure window per username and per client address."""

  def __init__(self, max_failures=5, window_sec=900, clock=time.time):
    self.max_failures = max_failures
    self.window = window_sec
    self.clock = clock
    self._fails = {}
    self._lock = threading.Lock()

  def _recent(self, key, now):
    vals = [t for t in self._fails.get(key, []) if now - t < self.window]
    self._fails[key] = vals
    return vals

  def retry_after(self, keys):
    """Seconds to wait if any key is over the limit, else 0."""
    now = self.clock()
    with self._lock:
      worst = 0
      for k in keys:
        vals = self._recent(k, now)
        if len(vals) >= self.max_failures:
          worst = max(worst, int(self.window - (now - vals[0])) + 1)
      return worst

  def fail(self, keys):
    now = self.clock()
    with self._lock:
      for k in keys:
        self._recent(k, now).append(now)

  def clear(self, key):
    with self._lock:
      self._fails.pop(key, None)
