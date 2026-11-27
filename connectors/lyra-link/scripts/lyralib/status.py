# =============================================================================
# status.py: Read session status and quota usage from a status file.
#   The default shape is Claude Code statusline JSON (model, effort,
#   context_window, rate_limits); any host can point --status-file at its own.
# =============================================================================

import json
from pathlib import Path


def _num(v):
  try:
    return float(v)
  except (TypeError, ValueError):
    return None


def _context_pct(snap):
  cw = snap.get('context_window')
  if not isinstance(cw, dict):
    return None
  pct = _num(cw.get('used_percentage'))
  if pct is None:
    size = _num(cw.get('context_window_size'))
    usage = cw.get('current_usage')
    if size and isinstance(usage, dict):
      keys = ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')
      pct = sum((_num(usage.get(k)) or 0.0) for k in keys) * 100.0 / size
  return None if pct is None else max(0.0, min(100.0, pct))


def parse(snap):
  """Return (status, usage) from statusline-shaped JSON; missing values stay None."""
  if not isinstance(snap, dict):
    return {}, None
  model = snap.get('model') if isinstance(snap.get('model'), dict) else {}
  effort = snap.get('effort')
  if isinstance(effort, dict):
    effort = effort.get('level')
  status = {
    'model': model.get('display_name') or model.get('id'),
    'effort': str(effort) if effort else None,
    'context_pct': _context_pct(snap),
    'version': snap.get('version'),
  }
  metrics = []
  limits = snap.get('rate_limits') if isinstance(snap.get('rate_limits'), dict) else {}
  for key, name in (('five_hour', '5-hour window'), ('seven_day', 'Weekly window')):
    win = limits.get(key)
    if not isinstance(win, dict):
      continue
    used = _num(win.get('used_percentage'))
    if used is None:
      continue
    item = {'name': name, 'used_pct': used, 'remaining_pct': max(0.0, 100.0 - used)}
    if win.get('resets_at') is not None:
      item['resets_at'] = str(win.get('resets_at'))
    metrics.append(item)
  return status, ({'metrics': metrics} if metrics else None)


def read(path):
  if not path:
    return {}, None
  try:
    return parse(json.loads(Path(path).expanduser().read_text(encoding='utf-8')))
  except (OSError, ValueError):
    return {}, None
