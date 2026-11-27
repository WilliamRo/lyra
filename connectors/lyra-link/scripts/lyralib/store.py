# =============================================================================
# store.py: Local connector state (0600 files outside synced folders).
# =============================================================================

import json
import os
from pathlib import Path
import tempfile
import time


LEDGER_LIMIT = 500


def state_root():
  root = os.environ.get('LYRA_LINK_STATE_DIR') or str(Path.home() / '.local' / 'share' / 'lyra-link')
  p = Path(root).expanduser()
  p.mkdir(parents=True, exist_ok=True)
  try:
    os.chmod(p, 0o700)
  except OSError:
    pass
  return p


def hdir(handle):
  p = state_root() / handle
  p.mkdir(parents=True, exist_ok=True)
  try:
    os.chmod(p, 0o700)
  except OSError:
    pass
  return p


def atomic_write(path, text, mode=0o600):
  path = Path(path)
  path.parent.mkdir(parents=True, exist_ok=True)
  fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix='.tmp-')
  try:
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
      fh.write(text)
      fh.flush()
      os.fsync(fh.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)
  except BaseException:
    try:
      os.unlink(tmp)
    except OSError:
      pass
    raise


def read_json(path, default=None):
  try:
    with open(path, encoding='utf-8') as fh:
      return json.load(fh)
  except (OSError, ValueError):
    return default


def write_json(path, value):
  atomic_write(path, json.dumps(value, ensure_ascii=False, indent=1))


# --- named files -------------------------------------------------------------

def config_path(h): return hdir(h) / 'config.json'
def creds_path(h): return hdir(h) / 'credentials.json'
def link_path(h): return hdir(h) / 'link.json'
def ledger_path(h): return hdir(h) / 'ledger.json'
def daemon_pid_path(h): return hdir(h) / 'daemon.pid'
def daemon_log_path(h): return hdir(h) / 'daemon.log'
def paused_path(h): return hdir(h) / 'checkins.paused'
def attached_path(h): return hdir(h) / 'stream.alive'
def stream_owner_path(h): return hdir(h) / 'stream.json'
def revoked_path(h): return hdir(h) / 'revoked'
def advertised_path(h): return hdir(h) / 'advertised.json'
def pending_join_path(h): return hdir(h) / 'pending_join.json'


def handles():
  root = state_root()
  return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / 'credentials.json').exists())


def linked_handle_for_pid(pid):
  for h in handles():
    rec = read_json(link_path(h)) or {}
    if rec.get('status') == 'linked' and int(rec.get('claude_pid') or 0) == int(pid or -1):
      return h
  return None


# --- stamps ------------------------------------------------------------------

def touch(path):
  Path(path).parent.mkdir(parents=True, exist_ok=True)
  atomic_write(path, str(time.time()))


def stamp_age(path):
  try:
    return max(0.0, time.time() - float(Path(path).read_text().strip()))
  except (OSError, ValueError):
    return None


# --- delivery ledger (write-ahead: handing -> handed -> acked) -----------------

def ledger_read(h):
  return read_json(ledger_path(h), {}) or {}


def ledger_set(h, mid, **fields):
  led = ledger_read(h)
  rec = led.get(str(mid), {})
  rec.update(fields)
  rec['ts'] = time.time()
  led[str(mid)] = rec
  if len(led) > LEDGER_LIMIT:
    for k in sorted(led, key=lambda k: led[k].get('ts', 0))[:len(led) - LEDGER_LIMIT]:
      led.pop(k, None)
  write_json(ledger_path(h), led)
  return rec


def ledger_get(h, mid):
  return ledger_read(h).get(str(mid))
