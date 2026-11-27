# =============================================================================
# daemon.py: Detached check-in loop for one linked handle.
#   Presence follows the owning Claude Code process, not the Monitor re-arms.
# =============================================================================

import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

from . import activity, procwatch, status, store
from .client import Client, LyraError


ATTACHED_FRESH_SEC = 25.0


def _log(handle, msg):
  try:
    with open(store.daemon_log_path(handle), 'a', encoding='utf-8') as fh:
      fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
  except OSError:
    pass


def client_for(handle):
  cfg = store.read_json(store.config_path(handle)) or {}
  creds = store.read_json(store.creds_path(handle)) or {}
  if not cfg.get('server_url') or not creds.get('token'):
    raise RuntimeError(f'{handle} is not joined; run join first')
  return Client(cfg['server_url'], creds['token'], cfg.get('ca_bundle')), cfg, creds


def checkin_payload(handle, cfg, pid):
  modes, g = activity.advertise(pid, cfg.get('modes', 'auto'))
  st, usage = status.read(cfg.get('status_file'))
  age = store.stamp_age(store.attached_path(handle))
  st['attached'] = age is not None and age < ATTACHED_FRESH_SEC
  st['busy'] = {'busy': True, 'idle': False}.get(g['state'])
  st['gate'] = ('stale' if g['stale'] else 'verified' if g['verified'] else 'unverified') \
    if cfg.get('modes', 'auto') != 'queue' else 'off'
  store.write_json(store.advertised_path(handle), {'modes': modes, 'gate': g, 'ts': time.time()})
  return {
    'instance_id': f'{socket.gethostname()}:{pid}', 'host': socket.gethostname(),
    'provider': cfg.get('provider', 'anthropic'), 'runtime': cfg.get('runtime', 'claude-code'),
    'connector': 'lyra-link', 'modes': modes, 'status': st, 'usage': usage,
  }


def run(handle, once=False):
  link = store.read_json(store.link_path(handle)) or {}
  pid = int(link.get('claude_pid') or 0)
  client, cfg, _creds = client_for(handle)
  interval = int(cfg.get('checkin_interval_sec') or 15)
  store.write_json(store.daemon_pid_path(handle), {'pid': os.getpid(), 'claude_pid': pid,
                                                   'started_at': time.time()})
  _log(handle, f'daemon start pid={os.getpid()} claude_pid={pid}')
  stop = {'flag': False}
  signal.signal(signal.SIGTERM, lambda *_a: stop.update(flag=True))
  while not stop['flag']:
    link = store.read_json(store.link_path(handle)) or {}
    if link.get('status') != 'linked' or int(link.get('claude_pid') or 0) != pid:
      _log(handle, 'link released; exiting')
      break
    if not procwatch.is_alive(pid):
      _log(handle, f'owner {pid} exited; exiting')
      break
    if store.revoked_path(handle).exists():
      break
    if not store.paused_path(handle).exists():
      try:
        client.checkin(checkin_payload(handle, cfg, pid))
      except LyraError as e:
        if e.status in (401, 403):
          store.touch(store.revoked_path(handle))
          _log(handle, f'credential rejected ({e.code}); exiting')
          break
        _log(handle, f'check-in failed: {e}')
    if once:
      break
    for _ in range(interval * 2):
      if stop['flag']:
        break
      time.sleep(0.5)
  try:
    rec = store.read_json(store.daemon_pid_path(handle)) or {}
    if rec.get('pid') == os.getpid():
      store.daemon_pid_path(handle).unlink()
  except OSError:
    pass
  return 0


def daemon_alive(handle):
  rec = store.read_json(store.daemon_pid_path(handle)) or {}
  return bool(rec.get('pid')) and procwatch.is_alive(rec['pid']), rec


def spawn(handle, script):
  alive, rec = daemon_alive(handle)
  if alive:
    return {'alive': True, 'pid': rec['pid'], 'spawned': False}
  log = open(store.daemon_log_path(handle), 'a', encoding='utf-8')
  proc = subprocess.Popen(
    [sys.executable, '-B', str(Path(script).resolve()), 'daemon', handle],
    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
  )
  for _ in range(20):
    time.sleep(0.1)
    alive, rec = daemon_alive(handle)
    if alive:
      break
  return {'alive': alive, 'pid': proc.pid, 'spawned': True}


def stop(handle):
  alive, rec = daemon_alive(handle)
  if alive:
    try:
      os.kill(int(rec['pid']), signal.SIGTERM)
    except OSError:
      pass
    for _ in range(30):
      if not procwatch.is_alive(rec['pid']):
        break
      time.sleep(0.1)
  return {'stopped': alive}
