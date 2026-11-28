# =============================================================================
# link.py: Hot-connect join, session link/unlink, and status checks.
# =============================================================================

import hashlib
import secrets
import socket
import sys
import time
from pathlib import Path

from . import activity, daemon, procwatch, store
from .client import Client, LyraError


def _owner_or_raise():
  pid = procwatch.find_owner()
  if not pid:
    raise RuntimeError('run this inside the Claude Code session you want to connect')
  return pid


def monitor_command(handle, script):
  return f'"{sys.executable}" -B "{Path(script).resolve()}" stream {handle}'


def join(handle, server, invite, script, display_name=None, status_file=None, ca_bundle=None,
         modes='auto', provider='anthropic', runtime='claude-code', link_session=True, supports_images=True):
  """Redeem a one-time invite from inside a running session (no restart)."""
  owner = _owner_or_raise() if link_session else None
  if owner:
    other = store.linked_handle_for_pid(owner)
    if other and other != handle:
      # i. Refuse before redeeming, so a one-time invite is never wasted.
      raise RuntimeError(f'this session is already linked to {other}; unlink it first')
  client = Client(server, ca_bundle=ca_bundle)
  pend_path = store.pending_join_path(handle)
  inv_hash = hashlib.sha256(invite.encode()).hexdigest()
  pend = store.read_json(pend_path) or {}
  if pend.get('invite_hash') != inv_hash:
    pend = {'invite_hash': inv_hash, 'client_key': secrets.token_urlsafe(24)}
    store.write_json(pend_path, pend)  # i. reuse the same key if the response is lost
  host = socket.gethostname()
  payload = {
    'invite_code': invite, 'client_key': pend['client_key'], 'handle': handle,
    'display_name': display_name, 'host': host, 'provider': provider, 'runtime': runtime,
    'connector': 'lyra-link', 'address': f'{runtime}://{host}/{handle}',
    'modes': ['queue'], 'capabilities': {'images': supports_images},
  }
  res = client.join(payload)
  got = res['principal']['handle']
  store.write_json(store.creds_path(got), {'token': res['token'], 'principal': res['principal'],
                                           'joined_at': time.time()})
  store.write_json(store.config_path(got), {
    'server_url': client.base, 'ca_bundle': ca_bundle, 'status_file': status_file,
    'supports_images': supports_images,
    'modes': modes, 'provider': provider, 'runtime': runtime,
    'checkin_interval_sec': res['server']['checkin_interval_sec'],
  })
  try:
    pend_path.unlink()
  except OSError:
    pass
  for stale in (store.revoked_path(got), store.paused_path(got)):
    if stale.exists():
      stale.unlink()
  out = {'joined': True, 'handle': got, 'principal': res['principal'], 'rotated': res['rotated']}
  if got != handle:
    out['note'] = f'the invite fixed the handle to {got!r}'
  if link_session:
    out.update(link(got, script, owner=owner))
  return out


def link(handle, script, owner=None):
  owner = owner or _owner_or_raise()
  if not store.creds_path(handle).exists():
    raise RuntimeError(f'{handle} has not joined; run join with an invite first')
  other = store.linked_handle_for_pid(owner)
  if other and other != handle:
    raise RuntimeError(f'this session is already linked to {other}; unlink it first')
  prev = store.read_json(store.link_path(handle)) or {}
  if prev.get('status') == 'linked' and int(prev.get('claude_pid') or 0) != owner and \
      procwatch.is_alive(prev.get('claude_pid')):
    raise RuntimeError(f"{handle} is linked to another live session (pid {prev.get('claude_pid')})")
  store.write_json(store.link_path(handle), {'status': 'linked', 'claude_pid': owner,
                                             'linked_at': time.time(), 'host': socket.gethostname()})
  d = daemon.spawn(handle, script)
  return {'linked': True, 'claude_pid': owner, 'daemon': d,
          'monitor_command': monitor_command(handle, script), 'timeout_ms': 600000}


def unlink(handle=None):
  owner = procwatch.find_owner()
  handle = handle or (store.linked_handle_for_pid(owner) if owner else None)
  if not handle:
    return {'unlinked': False, 'reason': 'no linked handle for this session'}
  rec = store.read_json(store.link_path(handle)) or {}
  store.write_json(store.link_path(handle), {**rec, 'status': 'unlinked', 'unlinked_at': time.time()})
  d = daemon.stop(handle)
  return {'unlinked': True, 'handle': handle, 'daemon': d,
          'note': 'messages keep waiting on the server until the next link or expiry'}


def check(handle=None):
  owner = procwatch.find_owner()
  handle = handle or (store.linked_handle_for_pid(owner) if owner else None)
  out = {'owner_pid': owner, 'handle': handle}
  if not handle:
    out['joined_handles'] = store.handles()
    return out
  cfg = store.read_json(store.config_path(handle)) or {}
  rec = store.read_json(store.link_path(handle)) or {}
  alive, drec = daemon.daemon_alive(handle)
  out.update({
    'server_url': cfg.get('server_url'), 'modes_setting': cfg.get('modes'),
    'capabilities': {'images': bool(cfg.get('supports_images', True))},
    'status_file': cfg.get('status_file'), 'link': rec.get('status'),
    'linked_pid': rec.get('claude_pid'), 'daemon_alive': alive, 'daemon_pid': drec.get('pid'),
    'stream_attached_age': store.stamp_age(store.attached_path(handle)),
    'checkins_paused': store.paused_path(handle).exists(),
    'revoked': store.revoked_path(handle).exists(),
    'advertised': (store.read_json(store.advertised_path(handle)) or {}).get('modes'),
    'gate': activity.gate(rec.get('claude_pid')) if rec.get('claude_pid') else None,
    'ledger_open': sum(1 for v in store.ledger_read(handle).values()
                       if v.get('state') in ('handing', 'handed')),
  })
  try:
    client, _cfg, _ = daemon.client_for(handle)
    me = client.me()
    out['server_view'] = {'principal': me['principal'], 'online': me['presence']['online'],
                          'modes': me['presence']['modes'],
                          'capabilities': me['presence'].get('capabilities', {'images': False})}
  except (LyraError, RuntimeError, KeyError) as e:
    out['server_error'] = str(e)
  return out
