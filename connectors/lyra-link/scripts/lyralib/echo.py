# =============================================================================
# echo.py: Scripted queue-only agent for tests and live checks (no Claude).
# =============================================================================

import socket
import threading
import time

from . import store
from .client import Client, LyraError


def run(handle, server=None, invite=None, delay=0.0, max_messages=0, prefix='echo: '):
  """Join once with an invite, then check in and echo every delivered message."""
  creds = store.read_json(store.creds_path(handle)) or {}
  cfg = store.read_json(store.config_path(handle)) or {}
  if invite:
    client = Client(server)
    res = client.join({'invite_code': invite, 'client_key': f'echo-{handle}-{socket.gethostname()}-key',
                       'handle': handle, 'host': socket.gethostname(), 'provider': 'lyra',
                       'runtime': 'echo', 'connector': 'lyra-link-echo',
                       'address': f'echo://{socket.gethostname()}/{handle}', 'modes': ['queue']})
    creds = {'token': res['token'], 'principal': res['principal']}
    cfg = {'server_url': client.base, 'modes': 'queue', 'runtime': 'echo'}
    store.write_json(store.creds_path(handle), creds)
    store.write_json(store.config_path(handle), cfg)
  client = Client(cfg['server_url'], creds['token'])
  stop = threading.Event()

  def beat():
    while not stop.is_set():
      if not store.paused_path(handle).exists():
        try:
          client.checkin({'instance_id': f'echo:{handle}', 'host': socket.gethostname(),
                          'provider': 'lyra', 'runtime': 'echo', 'connector': 'lyra-link-echo',
                          'modes': ['queue'], 'status': {'busy': False, 'attached': True,
                                                         'model': 'echo', 'gate': 'off'}})
        except LyraError as e:
          if e.status in (401, 403):
            stop.set()
      stop.wait(15)
  threading.Thread(target=beat, daemon=True).start()
  handled = 0
  try:
    while not stop.is_set():
      try:
        got = client.claim(wait=20)
      except LyraError as e:
        if e.status in (401, 403):
          break
        time.sleep(2)
        continue
      if not got.get('message'):
        continue
      m = got['message']
      try:
        client.ack(got['lease_id'], 'delivered')
        if delay:
          time.sleep(delay)
        client.reply(m['id'], f"{prefix}{m['body']}", client_msg_id=f"echo-{m['id']}")
      except LyraError as e:
        if e.status in (401, 403):
          print('credential revoked; stopping', flush=True)
          break
        continue
      handled += 1
      print(f"echoed message {m['id']} from {m['sender']['handle']}", flush=True)
      if max_messages and handled >= max_messages:
        break
  finally:
    stop.set()
  return 0
