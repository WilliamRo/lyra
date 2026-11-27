# =============================================================================
# lyra_link.py: CLI for the lyra-link Claude Code connector (stdlib only).
# =============================================================================

import argparse
import hashlib
import json
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lyralib import activity, daemon, echo, link, store, stream  # noqa: E402
from lyralib.client import LyraError  # noqa: E402


SCRIPT = Path(__file__).resolve()


def out(obj):
  print(json.dumps(obj, ensure_ascii=False, indent=1))


def _client(handle):
  c, _cfg, _ = daemon.client_for(handle)
  return c


def _resolve(handle):
  if handle:
    return handle
  from lyralib import procwatch
  pid = procwatch.find_owner()
  h = store.linked_handle_for_pid(pid) if pid else None
  if not h:
    raise RuntimeError('no handle given and this session is not linked')
  return h


def _stdin():
  body = sys.stdin.read()
  if not body.strip():
    raise RuntimeError('empty message on stdin')
  return body


def _invite(value):
  """Read the code from stdin for '-' so it never appears in the process list."""
  if value == '-':
    code = sys.stdin.readline().strip()
    if not code:
      raise RuntimeError('no invite code on stdin')
    return code
  return value


def main(argv=None):
  p = argparse.ArgumentParser(prog='lyra_link.py', description='Lyra connector for Claude Code')
  sub = p.add_subparsers(dest='cmd', required=True)

  j = sub.add_parser('join', help='redeem a one-time invite and hot-connect this session')
  j.add_argument('handle')
  j.add_argument('--server', required=True)
  j.add_argument('--invite', required=True, help="one-time code, or '-' to read it from stdin")
  j.add_argument('--display-name')
  j.add_argument('--status-file', help='statusline-shaped JSON for model, effort, usage')
  j.add_argument('--ca-bundle')
  j.add_argument('--modes', choices=('auto', 'queue'), default='auto')

  for name in ('link', 'unlink', 'check', 'stream', 'daemon', 'teammates'):
    sp = sub.add_parser(name)
    sp.add_argument('handle', nargs='?' if name in ('unlink', 'check', 'teammates') else None)

  s = sub.add_parser('send', help='start or continue a direct conversation')
  s.add_argument('handle', nargs='?')
  s.add_argument('--to', required=True)
  s.add_argument('--stdin', action='store_true', required=True)
  s.add_argument('--mode', choices=('queue', 'jump'), default='queue')

  r = sub.add_parser('reply', help='reply to a message')
  r.add_argument('handle', nargs='?')
  r.add_argument('--to', required=True, type=int)
  r.add_argument('--stdin', action='store_true', required=True)
  r.add_argument('--mode', choices=('queue', 'jump'))

  rc = sub.add_parser('react', help='add or remove an emoji reaction')
  rc.add_argument('handle', nargs='?')
  rc.add_argument('--to', required=True, type=int)
  rc.add_argument('--emoji', required=True)
  rc.add_argument('--remove', action='store_true')

  hs = sub.add_parser('history', help='recent messages with a teammate or the owner')
  hs.add_argument('handle', nargs='?')
  hs.add_argument('--with', dest='with_', default='owner')
  hs.add_argument('--limit', type=int, default=20)

  ck = sub.add_parser('checkins', help='pause or resume check-ins (presence tests)')
  ck.add_argument('handle')
  ck.add_argument('action', choices=('pause', 'resume'))

  sub.add_parser('hook', help='Claude Code hook entry (reads hook JSON on stdin)')

  e = sub.add_parser('echo-agent', help='scripted queue-only agent for tests')
  e.add_argument('handle')
  e.add_argument('--server')
  e.add_argument('--invite', help="one-time code, or '-' to read it from stdin")
  e.add_argument('--delay', type=float, default=0.0)
  e.add_argument('--max', type=int, default=0)

  a = p.parse_args(argv)
  try:
    if a.cmd == 'hook':
      activity.handle_hook(sys.stdin.read())
      return 0  # never print: UserPromptSubmit stdout would enter the conversation
    if a.cmd == 'join':
      out(link.join(a.handle, a.server, _invite(a.invite), SCRIPT, display_name=a.display_name,
                    status_file=a.status_file, ca_bundle=a.ca_bundle, modes=a.modes))
    elif a.cmd == 'link':
      out(link.link(a.handle, SCRIPT))
    elif a.cmd == 'unlink':
      out(link.unlink(a.handle))
    elif a.cmd == 'check':
      out(link.check(a.handle))
    elif a.cmd == 'stream':
      return stream.run(a.handle)
    elif a.cmd == 'daemon':
      return daemon.run(a.handle)
    elif a.cmd == 'teammates':
      out(_client(_resolve(a.handle)).teammates())
    elif a.cmd == 'send':
      h = _resolve(a.handle)
      out(_client(h).send(a.to, _stdin(), mode=a.mode, client_msg_id=str(uuid.uuid4())))
    elif a.cmd == 'reply':
      h = _resolve(a.handle)
      body = _stdin()
      key = hashlib.sha256(f'{h}:{a.to}:{body}'.encode()).hexdigest()[:40]  # safe retries
      out(_client(h).reply(a.to, body, mode=a.mode, client_msg_id=key))
    elif a.cmd == 'react':
      out(_client(_resolve(a.handle)).react(a.to, a.emoji, remove=a.remove))
    elif a.cmd == 'history':
      out(_client(_resolve(a.handle)).history(a.with_, a.limit))
    elif a.cmd == 'checkins':
      if a.action == 'pause':
        store.touch(store.paused_path(a.handle))
      elif store.paused_path(a.handle).exists():
        store.paused_path(a.handle).unlink()
      out({'handle': a.handle, 'checkins': 'paused' if a.action == 'pause' else 'running'})
    elif a.cmd == 'echo-agent':
      return echo.run(a.handle, server=a.server, invite=_invite(a.invite) if a.invite else None,
                      delay=a.delay,
                      max_messages=a.max)
    return 0
  except LyraError as exc:
    out({'error': exc.code, 'status': exc.status, 'message': exc.message, **exc.body})
    return 1
  except (RuntimeError, ValueError) as exc:
    out({'error': 'local', 'message': str(exc)})
    return 1


if __name__ == '__main__':
  raise SystemExit(main())
