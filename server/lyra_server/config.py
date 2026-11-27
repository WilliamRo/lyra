# =============================================================================
# config.py: Portable server settings from environment and optional TOML.
# =============================================================================

from dataclasses import dataclass, field, fields
import ipaddress
import os
from pathlib import Path
import sys
import tomllib
from urllib.parse import urlsplit


class ConfigError(ValueError):
  """Raised when settings are unsafe or inconsistent."""


SYNC_DIR_NAMES = (
  'dropbox', 'onedrive', 'google drive', 'googledrive', 'my drive',
  'icloud drive', 'icloud', 'box sync', 'pcloud drive', 'resilio sync',
)
SYNC_MARKERS = ('.dropbox', '.dropbox.cache', '.tmp.drivedownload', '.sync')


def default_data_dir():
  """Platform user data directory; any operator path may override it."""
  home = Path.home()
  if sys.platform == 'darwin':
    return home / 'Library' / 'Application Support' / 'lyra-server'
  if os.name == 'nt':
    base = os.environ.get('LOCALAPPDATA') or str(home / 'AppData' / 'Local')
    return Path(base) / 'lyra-server'
  base = os.environ.get('XDG_DATA_HOME') or str(home / '.local' / 'share')
  return Path(base) / 'lyra-server'


def synced_folder_reason(path):
  """Return why path looks like a file-sync folder, or None (best effort)."""
  p = Path(path).expanduser()
  try:
    real = p.resolve()
  except OSError:
    real = p.absolute()
  home = Path.home().resolve()
  for root in (home / 'Library' / 'CloudStorage', home / 'Library' / 'Mobile Documents'):
    try:
      real.relative_to(root)
      return f'inside {root}'
    except ValueError:
      pass
  for part in real.parts:
    low = part.lower()
    if low in SYNC_DIR_NAMES or low.startswith(('dropbox', 'onedrive')):
      return f'path component {part!r} looks like a sync folder'
  probe = real
  while True:
    for marker in SYNC_MARKERS:
      if (probe / marker).exists():
        return f'sync marker {marker} found in {probe}'
    if probe.parent == probe:
      break
    probe = probe.parent
  return None


def is_loopback(host):
  if host in ('localhost', ''):
    return True
  try:
    return ipaddress.ip_address(host).is_loopback
  except ValueError:
    return False


def _bool(v):
  return str(v).strip().lower() in ('1', 'true', 'yes', 'on')


@dataclass
class Settings:
  bind: str = '127.0.0.1'
  port: int = 8740
  public_url: str = ''
  data_dir: str = ''
  tls_cert: str = ''
  tls_key: str = ''
  trust_proxy_headers: bool = False
  cookie_secure: str = 'auto'
  allow_plaintext_bind: bool = False
  checkin_interval_sec: int = 15
  checkin_ttl_sec: int = 45
  message_ttl_sec: int = 86400
  lease_sec: int = 30
  max_attempts: int = 5
  invite_ttl_sec: int = 86400
  invite_retry_window_sec: int = 600
  remember_me_days: int = 30
  session_idle_hours: int = 12
  max_body_bytes: int = 65536
  max_message_chars: int = 16000
  event_retention_days: int = 30
  agent_rate_per_hour: int = 20
  backup_keep: int = 14
  login_max_failures: int = 5
  login_window_sec: int = 900
  extra: dict = field(default_factory=dict)

  # --- derived -------------------------------------------------------------

  @property
  def data_path(self):
    return Path(self.data_dir).expanduser() if self.data_dir else default_data_dir()

  @property
  def db_path(self):
    return self.data_path / 'lyra.sqlite'

  @property
  def tls(self):
    return bool(self.tls_cert and self.tls_key)

  @property
  def scheme(self):
    return 'https' if self.tls else 'http'

  def allowed_origins(self):
    if self.public_url:
      u = urlsplit(self.public_url)
      return {f'{u.scheme}://{u.netloc}'.lower()}
    out = set()
    for host in ('127.0.0.1', 'localhost', '[::1]'):
      out.add(f'{self.scheme}://{host}:{self.port}')
    return out

  def secure_cookies(self):
    if self.cookie_secure != 'auto':
      return _bool(self.cookie_secure)
    if self.tls or self.public_url.lower().startswith('https://'):
      return True
    return False


_INT_FIELDS = {f.name for f in fields(Settings) if f.type in (int, 'int')}
_BOOL_FIELDS = {f.name for f in fields(Settings) if f.type in (bool, 'bool')}


def _coerce(name, value):
  if name in _INT_FIELDS:
    return int(value)
  if name in _BOOL_FIELDS:
    return value if isinstance(value, bool) else _bool(value)
  return str(value)


def load(env=None, config_path=None):
  """TOML file (LYRA_CONFIG or config_path) first, then LYRA_* env overrides."""
  env = os.environ if env is None else env
  s = Settings()
  names = {f.name for f in fields(Settings) if f.name != 'extra'}
  path = config_path or env.get('LYRA_CONFIG')
  if path:
    with open(path, 'rb') as fh:
      data = tomllib.load(fh)
    for k, v in data.items():
      if k in names:
        setattr(s, k, _coerce(k, v))
      else:
        s.extra[k] = v
  for k in names:
    key = f'LYRA_{k.upper()}'
    if key in env and env[key] != '':
      setattr(s, k, _coerce(k, env[key]))
  return s


def validate(s):
  """Refuse unsafe placements and transports before anything binds."""
  problems = []
  reason = synced_folder_reason(s.data_path)
  if reason:
    problems.append(f'LYRA_DATA_DIR {s.data_path} is in a synced folder ({reason}); '
                    'keep the live database on a local volume')
  if bool(s.tls_cert) != bool(s.tls_key):
    problems.append('set both LYRA_TLS_CERT and LYRA_TLS_KEY, or neither')
  if not is_loopback(s.bind):
    if not s.tls and not s.allow_plaintext_bind:
      problems.append(f'refusing plaintext bind on non-loopback {s.bind}; configure '
                      'LYRA_TLS_CERT/LYRA_TLS_KEY or bind 127.0.0.1 behind a TLS proxy')
    if not s.public_url:
      problems.append('LYRA_PUBLIC_URL is required when binding off loopback')
  if s.public_url:
    u = urlsplit(s.public_url)
    if u.scheme not in ('http', 'https') or not u.netloc:
      problems.append('LYRA_PUBLIC_URL must look like https://host[:port]')
    elif u.scheme == 'http' and not is_loopback(u.hostname or ''):
      problems.append('LYRA_PUBLIC_URL must use https off loopback')
  if s.checkin_ttl_sec <= s.checkin_interval_sec:
    problems.append('LYRA_CHECKIN_TTL_SEC must exceed LYRA_CHECKIN_INTERVAL_SEC')
  if problems:
    raise ConfigError('; '.join(problems))
  return s


def describe(s):
  """Non-secret summary for check-config and startup logs."""
  return {
    'bind': s.bind, 'port': s.port, 'tls': s.tls,
    'public_url': s.public_url or None,
    'data_dir': str(s.data_path), 'db': str(s.db_path),
    'allowed_origins': sorted(s.allowed_origins()),
    'secure_cookies': s.secure_cookies(),
    'trust_proxy_headers': s.trust_proxy_headers,
    'checkin_interval_sec': s.checkin_interval_sec,
    'checkin_ttl_sec': s.checkin_ttl_sec,
    'message_ttl_sec': s.message_ttl_sec,
    'invite_ttl_sec': s.invite_ttl_sec,
    'remember_me_days': s.remember_me_days,
  }
