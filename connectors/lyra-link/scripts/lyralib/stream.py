# =============================================================================
# stream.py: Monitor emitter. Claims one message at a time, hands it to the
#   session through stdout, and acknowledges with a write-ahead ledger so a
#   lost acknowledgement never becomes a silent duplicate.
# =============================================================================

import hashlib
import json
import os
import threading
import time

from . import activity, procwatch, store
from .client import LyraError
from .daemon import client_for


POST_HANDOFF_WAIT = 180.0     # give the session this long to start and finish its turn
UNREACHABLE_AFTER = 60.0
UNREACHABLE_REMIND = 600.0


def emit(obj, out=None):
  line = json.dumps(obj, ensure_ascii=True)
  if out is not None:
    out.append(obj)
    return
  print(line, flush=True)


def event_for(handle, got):
  m = got['message']
  return {
    'event': 'message', 'source': 'lyra', 'handle': handle,
    'message_id': m['id'], 'conversation_id': m['conversation_id'],
    'conversation_kind': m['conversation_kind'],
    'from': {'handle': m['sender']['handle'], 'display_name': m['sender']['display_name'],
             'kind': m['sender']['kind']},
    'attachments': m.get('attachments', []),
    'text': m['body'], 'mode': m['mode'], 'attempt': got.get('attempt'), 'retry': m['retry'],
    'reply_to': m['reply_to'], 'created_at': m['created_at'],
    'reply_with': f'lyra_link.py reply {handle} --to {m["id"]} --stdin',
  }


class Streamer:
  """One poll step at a time so tests can drive it without a Monitor."""

  def __init__(self, handle, client=None, owner_pid=None, out=None, clock=time.time):
    self.handle = handle
    self.out = out
    self.clock = clock
    if client is None:
      client, self.cfg, _ = client_for(handle)
    else:
      self.cfg = store.read_json(store.config_path(handle)) or {}
    self.client = client
    self.owner_pid = owner_pid
    self.handoff_at = None
    self.unreachable_since = None
    self.unreachable_said = 0.0
    self.should_exit = False

  # --- ledger reconciliation (runs first and after every network error) -----

  def reconcile(self):
    for mid, rec in sorted(store.ledger_read(self.handle).items()):
      state = rec.get('state')
      if state not in ('handing', 'handed'):
        continue
      outcome = 'delivered' if state == 'handed' else 'unconfirmed'
      try:
        self.client.ack(rec['lease_id'], outcome,
                        None if outcome == 'delivered' else 'stream stopped during handoff')
        store.ledger_set(self.handle, mid, state='acked' if outcome == 'delivered' else 'unconfirmed')
      except LyraError as e:
        if e.status in (404, 409):
          store.ledger_set(self.handle, mid, state='acked', note=e.code)
        elif e.status in (401, 403):
          raise
        else:
          return False
    return True

  # --- gate ------------------------------------------------------------------

  def gated(self):
    adv = store.read_json(store.advertised_path(self.handle)) or {}
    return 'jump' in (adv.get('modes') or [])

  def may_claim(self):
    if not self.gated():
      return True
    g = activity.gate(self.owner_pid)
    if g['state'] != 'idle':
      return False
    if self.handoff_at:
      # i. Wait for the turn our last handoff started to finish (or time out).
      if (g['updated_at'] or 0) > self.handoff_at + 0.5:
        self.handoff_at = None
      elif self.clock() - self.handoff_at < POST_HANDOFF_WAIT:
        return False
      else:
        self.handoff_at = None
    return True

  # --- one step --------------------------------------------------------------

  def step(self, wait=20):
    if store.revoked_path(self.handle).exists():
      emit({'event': 'revoked', 'source': 'lyra', 'handle': self.handle}, self.out)
      self.should_exit = True
      return
    if not self.reconcile():
      self._unreachable()
      return
    if not self.may_claim():
      time.sleep(min(1.0, wait)) if self.out is None else None
      return
    try:
      got = self.client.claim(wait=5 if self.gated() else wait)
      self.unreachable_since = None
    except LyraError as e:
      if e.status in (401, 403):
        store.touch(store.revoked_path(self.handle))
        emit({'event': 'revoked', 'source': 'lyra', 'handle': self.handle}, self.out)
        self.should_exit = True
        return
      self._unreachable()
      return
    if not got.get('message'):
      return
    self.deliver(got)

  def deliver(self, got):
    m = got['message']
    mid = m['id']
    prior = store.ledger_get(self.handle, mid)
    if prior and not m.get('retry'):
      # ii. Never hand the same message id over twice on our own.
      outcome = 'delivered' if prior.get('state') in ('handed', 'acked') else 'unconfirmed'
      try:
        self.client.ack(got['lease_id'], outcome, None if outcome == 'delivered' else 'duplicate claim')
      except LyraError:
        pass
      return
    for attachment in m.get('attachments', []):
      try:
        ext = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
               'image/webp': 'webp'}[attachment['mime_type']]
        path = store.attachments_dir(self.handle) / f"{int(attachment['id'])}.{ext}"
        self.client.download_attachment(attachment['id'], path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != attachment['sha256']:
          path.unlink(missing_ok=True)
          raise ValueError('image checksum mismatch')
        attachment['local_path'] = str(path.resolve())
      except (OSError, LyraError, ValueError, TypeError, KeyError) as exc:
        attachment['download_error'] = str(exc)
    store.ledger_set(self.handle, mid, state='handing', lease_id=got['lease_id'])
    emit(event_for(self.handle, got), self.out)
    store.ledger_set(self.handle, mid, state='handed', lease_id=got['lease_id'])
    self.handoff_at = self.clock()
    try:
      self.client.ack(got['lease_id'], 'delivered')
      store.ledger_set(self.handle, mid, state='acked')
    except LyraError:
      pass  # reconcile() retries on the next step

  def _unreachable(self):
    now = self.clock()
    self.unreachable_since = self.unreachable_since or now
    if now - self.unreachable_since >= UNREACHABLE_AFTER and now - self.unreachable_said >= UNREACHABLE_REMIND:
      self.unreachable_said = now
      emit({'event': 'lyra_unreachable', 'source': 'lyra', 'handle': self.handle,
            'since_sec': round(now - self.unreachable_since)}, self.out)
    if self.out is None:
      time.sleep(2.0)


def run(handle):
  link = store.read_json(store.link_path(handle)) or {}
  owner = procwatch.find_owner()
  if link.get('status') != 'linked' or not owner or int(link.get('claude_pid') or 0) != owner:
    emit({'event': 'not_linked', 'source': 'lyra', 'handle': handle,
          'hint': f'run lyra_link.py link {handle} inside the owning session'})
    return 1
  rec = store.read_json(store.stream_owner_path(handle)) or {}
  other = rec.get('pid')
  if other and other != os.getpid() and procwatch.is_alive(other) and \
      (store.stamp_age(store.attached_path(handle)) or 99) < 10:
    emit({'event': 'stream_conflict', 'source': 'lyra', 'handle': handle, 'pid': other})
    return 1
  store.write_json(store.stream_owner_path(handle), {'pid': os.getpid(), 'claude_pid': owner})
  s = Streamer(handle, owner_pid=owner)
  stop = threading.Event()

  def beat():
    while not stop.is_set():
      store.touch(store.attached_path(handle))
      stop.wait(5.0)
  threading.Thread(target=beat, daemon=True).start()
  try:
    while not s.should_exit:
      if not procwatch.is_alive(owner):
        break
      try:
        s.step()
      except LyraError:
        store.touch(store.revoked_path(handle))
        emit({'event': 'revoked', 'source': 'lyra', 'handle': handle})
        break
  finally:
    stop.set()
  return 0
