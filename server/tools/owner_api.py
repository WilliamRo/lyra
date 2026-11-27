# =============================================================================
# owner_api.py: Scripted owner actions against a Lyra server (stdlib only).
#   Used for walkthroughs and reviews where a browser is not at hand.
#   Usage: python3 -B owner_api.py --server URL --state DIR <command> [...]
#   The password comes from LYRA_ADMIN_PASSWORD or --password-file (0600).
# =============================================================================

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit


def opener_for(state, server):
  state = Path(state).expanduser()
  state.mkdir(parents=True, exist_ok=True)
  os.chmod(state, 0o700)
  jar = http.cookiejar.MozillaCookieJar(str(state / 'owner-cookies.txt'))
  if (state / 'owner-cookies.txt').exists():
    jar.load(ignore_discard=True, ignore_expires=True)
  handlers = [urllib.request.HTTPCookieProcessor(jar)]
  if (urlsplit(server).hostname or '') in ('127.0.0.1', 'localhost', '::1'):
    handlers.append(urllib.request.ProxyHandler({}))
  return urllib.request.build_opener(*handlers), jar, state


def call(op, server, method, path, body=None):
  data = json.dumps(body).encode() if body is not None else None
  req = urllib.request.Request(server.rstrip('/') + path, data=data, method=method)
  req.add_header('Content-Type', 'application/json')
  u = urlsplit(server)
  req.add_header('Origin', f'{u.scheme}://{u.netloc}')
  try:
    with op.open(req, timeout=30) as r:
      return r.status, json.loads(r.read() or b'{}')
  except urllib.error.HTTPError as e:
    raw = e.read()
    return e.code, (json.loads(raw) if raw else {})


def main(argv=None):
  p = argparse.ArgumentParser(prog='owner_api.py')
  p.add_argument('--server', required=True)
  p.add_argument('--state', required=True, help='directory for the owner cookie (outside sync)')
  p.add_argument('--username', default='owner')
  p.add_argument('--password-file')
  sub = p.add_subparsers(dest='cmd', required=True)
  sub.add_parser('login')
  sub.add_parser('board')
  sub.add_parser('usage')
  sub.add_parser('conversations')
  sp = sub.add_parser('invite')
  sp.add_argument('--name')
  sp.add_argument('--handle')
  sp.add_argument('--pool', type=int)
  sp.add_argument('--readmit', type=int)
  sp = sub.add_parser('pool')
  sp.add_argument('provider')
  sp.add_argument('label')
  sp = sub.add_parser('reporter')
  sp.add_argument('pool', type=int)
  sp.add_argument('principal', type=int)
  sp = sub.add_parser('assign')
  sp.add_argument('principal', type=int)
  sp.add_argument('pool', type=int)
  sp = sub.add_parser('send')
  sp.add_argument('to')
  sp.add_argument('body')
  sp.add_argument('--mode', default='queue')
  sp = sub.add_parser('reply')
  sp.add_argument('message', type=int)
  sp.add_argument('body')
  sp = sub.add_parser('react')
  sp.add_argument('message', type=int)
  sp.add_argument('emoji')
  sp = sub.add_parser('messages')
  sp.add_argument('conversation', type=int)
  sp = sub.add_parser('revoke')
  sp.add_argument('principal', type=int)
  sp = sub.add_parser('retry')
  sp.add_argument('message', type=int)
  a = p.parse_args(argv)

  op, jar, _state = opener_for(a.state, a.server)
  if a.cmd == 'login':
    pw = os.environ.get('LYRA_ADMIN_PASSWORD')
    if a.password_file:
      pw = Path(a.password_file).read_text().strip()
    st, out = call(op, a.server, 'POST', '/api/v1/auth/login',
                   {'username': a.username, 'password': pw, 'remember': True})
    jar.save(ignore_discard=True, ignore_expires=True)
    os.chmod(jar.filename, 0o600)
  else:
    routes = {
      'board': ('GET', '/api/v1/board', None),
      'usage': ('GET', '/api/v1/usage', None),
      'conversations': ('GET', '/api/v1/conversations', None),
    }
    if a.cmd in routes:
      st, out = call(op, a.server, *routes[a.cmd])
    elif a.cmd == 'invite':
      st, out = call(op, a.server, 'POST', '/api/v1/admin/invites',
                     {'display_name': a.name, 'handle': a.handle, 'pool_id': a.pool,
                      'target_principal_id': a.readmit})
    elif a.cmd == 'pool':
      st, out = call(op, a.server, 'POST', '/api/v1/admin/pools',
                     {'provider': a.provider, 'label': a.label})
    elif a.cmd == 'reporter':
      st, out = call(op, a.server, 'PATCH', f'/api/v1/admin/pools/{a.pool}',
                     {'reporter_principal_id': a.principal})
    elif a.cmd == 'assign':
      st, out = call(op, a.server, 'PATCH', f'/api/v1/admin/principals/{a.principal}',
                     {'pool_id': a.pool})
    elif a.cmd == 'send':
      to = int(a.to) if a.to.isdigit() else a.to
      st, out = call(op, a.server, 'POST', '/api/v1/messages', {'to': to, 'body': a.body, 'mode': a.mode})
    elif a.cmd == 'reply':
      st, out = call(op, a.server, 'POST', f'/api/v1/messages/{a.message}/reply', {'body': a.body})
    elif a.cmd == 'react':
      st, out = call(op, a.server, 'PUT', f'/api/v1/messages/{a.message}/reactions/{quote(a.emoji, safe="")}')
    elif a.cmd == 'messages':
      st, out = call(op, a.server, 'GET', f'/api/v1/conversations/{a.conversation}/messages')
    elif a.cmd == 'revoke':
      st, out = call(op, a.server, 'POST', f'/api/v1/admin/principals/{a.principal}/revoke', {})
    elif a.cmd == 'retry':
      st, out = call(op, a.server, 'POST', f'/api/v1/admin/messages/{a.message}/retry', {})
  print(json.dumps({'status': st, **out} if isinstance(out, dict) else {'status': st, 'body': out},
                   ensure_ascii=False, indent=1))
  return 0 if st == 200 else 1


if __name__ == '__main__':
  sys.exit(main())
