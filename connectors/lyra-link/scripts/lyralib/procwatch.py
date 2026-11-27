# =============================================================================
# procwatch.py: Find the owning Claude Code process and test PID liveness.
# =============================================================================

import os
import subprocess


_OWNER_PREFIX = 'claude'


def _table():
  out = subprocess.run(['ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='],
                       capture_output=True, text=True, check=False).stdout
  table = {}
  for line in out.splitlines():
    parts = line.split(None, 2)
    if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
      table[int(parts[0])] = (int(parts[1]), os.path.basename(parts[2].strip()).lower())
  return table


def find_owner(max_depth=12):
  """Nearest ancestor PID whose executable name starts with 'claude', or None."""
  if os.environ.get('LYRA_LINK_OWNER_PID'):
    return int(os.environ['LYRA_LINK_OWNER_PID'])  # tests and headless agents
  try:
    table = _table()
    pid = os.getpid()
    for _ in range(max_depth):
      ppid, _name = table.get(pid, (0, ''))
      if not ppid or ppid == pid:
        return None
      if table.get(ppid, (0, ''))[1].startswith(_OWNER_PREFIX):
        return ppid
      pid = ppid
  except Exception:  # noqa: BLE001 - fail open
    return None
  return None


def is_alive(pid):
  """True unless the PID is positively known to have exited."""
  if not pid:
    return False
  try:
    os.kill(int(pid), 0)
    return True
  except ProcessLookupError:
    return False
  except PermissionError:
    return True
  except Exception:  # noqa: BLE001
    return True
