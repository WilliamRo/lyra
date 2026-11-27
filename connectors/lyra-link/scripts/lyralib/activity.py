# =============================================================================
# activity.py: Busy/idle gate fed by supported Claude Code hooks.
#   UserPromptSubmit -> busy; Stop -> idle; Notification(idle_prompt) -> idle.
# =============================================================================

import json
import time

from . import procwatch, store


STALE_BUSY_SEC = 1200.0


def path_for(pid):
  return store.state_root() / 'activity' / f'claude-{int(pid)}.json'


def read(pid):
  return store.read_json(path_for(pid), None) if pid else None


def handle_hook(raw, now=None, pid=None):
  """Hook entry point: never prints, never raises (a stuck hook stalls the session)."""
  try:
    now = time.time() if now is None else now
    try:
      data = json.loads(raw or '{}')
    except ValueError:
      data = {}
    event = str(data.get('hook_event_name') or '')
    pid = pid or procwatch.find_owner()
    if not pid or event not in ('UserPromptSubmit', 'Stop', 'StopFailure', 'Notification'):
      return None
    rec = read(pid) or {'pid': int(pid), 'state': 'unknown', 'cycles': 0}
    prev = rec.get('state')
    if event == 'UserPromptSubmit':
      rec['state'] = 'busy'
      rec['turn_started_at'] = now
    else:
      rec['state'] = 'idle'
      if prev == 'busy':
        rec['cycles'] = int(rec.get('cycles') or 0) + 1
        rec['last_turn_sec'] = round(now - float(rec.get('turn_started_at') or now), 3)
    rec['last_event'] = event
    rec['session_id'] = data.get('session_id') or rec.get('session_id')
    rec['updated_at'] = now
    store.write_json(path_for(pid), rec)
    return rec
  except Exception:  # noqa: BLE001 - fail open
    return None


def gate(pid, now=None, stale_sec=STALE_BUSY_SEC):
  """Summarize the gate: state busy|idle|unknown, verified after one busy->idle cycle."""
  now = time.time() if now is None else now
  rec = read(pid)
  if not rec or not procwatch.is_alive(pid):
    return {'state': 'unknown', 'verified': False, 'stale': False, 'updated_at': None, 'cycles': 0}
  state = rec.get('state', 'unknown')
  updated = float(rec.get('updated_at') or 0)
  stale = state == 'busy' and now - updated > stale_sec
  return {
    'state': 'unknown' if stale else state,
    'verified': int(rec.get('cycles') or 0) >= 1,
    'stale': stale,
    'updated_at': updated or None,
    'cycles': int(rec.get('cycles') or 0),
  }


def advertise(pid, setting='auto', now=None):
  """Offer jump only with a verified, fresh gate; otherwise queue only."""
  g = gate(pid, now=now)
  if setting == 'queue' or not g['verified'] or g['stale'] or g['state'] == 'unknown':
    return ['queue'], g
  return ['queue', 'jump'], g
