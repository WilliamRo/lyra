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


def message_parts(args, client):
  body = sys.stdin.read() if args.stdin else ''
  if not body.strip() and not args.image:
    raise ValueError('provide a message with --stdin or an image with --image PATH')
  return body, [client.upload_attachment(path)['id'] for path in args.image]


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
  j.add_argument('--no-images', action='store_true', help='advertise text-only input')
  j.add_argument('--status-file', help='statusline-shaped JSON for model, effort, usage')
  j.add_argument('--ca-bundle')
  j.add_argument('--modes', choices=('auto', 'queue'), default='auto')

  for name in ('link', 'unlink', 'check', 'stream', 'daemon', 'teammates'):
    sp = sub.add_parser(name)
    sp.add_argument('handle', nargs='?' if name in ('unlink', 'check', 'teammates') else None)

  s = sub.add_parser('send', help='start or continue a direct conversation')
  s.add_argument('handle', nargs='?')
  s.add_argument('--to', required=True)
  s.add_argument('--stdin', action='store_true')
  s.add_argument('--image', action='append', default=[], metavar='PATH')
  s.add_argument('--mode', choices=('queue', 'jump'), default='queue')

  r = sub.add_parser('reply', help='reply to a message')
  r.add_argument('handle', nargs='?')
  r.add_argument('--to', required=True, type=int)
  r.add_argument('--stdin', action='store_true')
  r.add_argument('--image', action='append', default=[], metavar='PATH')
  r.add_argument('--mode', choices=('queue', 'jump'))

  pr = sub.add_parser('progress', help='report progress on a received message')
  pr.add_argument('handle', nargs='?')
  pr.add_argument('--to', type=int, required=True)
  pr.add_argument('--phase', choices=('thinking', 'working', 'done'), required=True)
  pr.add_argument('--summary')
  pr.add_argument('--bullet', action='append', default=[], metavar='STATE:TEXT')

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
                    status_file=a.status_file, ca_bundle=a.ca_bundle, modes=a.modes,
                    supports_images=not a.no_images))
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
    elif a.cmd in ('send', 'reply'):
      h = _resolve(a.handle)
      client = _client(h)
      body, ids = message_parts(a, client)
      if a.cmd == 'reply':
        identity = f'{h}:{a.to}:{body}'
        if ids:
          identity = json.dumps([h, a.to, body, ids])
        key = hashlib.sha256(identity.encode()).hexdigest()[:40]
        out(client.reply(a.to, body, mode=a.mode, client_msg_id=key, attachment_ids=ids))
      else:
        out(client.send(a.to, body, mode=a.mode, client_msg_id=str(uuid.uuid4()), attachment_ids=ids))
    elif a.cmd == 'progress':
      bullets = []
      for item in a.bullet:
        state, _, text = item.partition(':')
        if state not in ('active', 'pending', 'done') or not text.strip():
          raise ValueError('expected --bullet done|active|pending:TEXT')
        bullets.append({'state': state, 'text': text})
      out(_client(_resolve(a.handle)).progress(a.to, a.phase, a.summary, bullets or None))
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
  except (RuntimeError, ValueError, OSError) as exc:
    out({'error': 'local', 'message': str(exc)})
    return 1


if __name__ == '__main__':
  raise SystemExit(main())
