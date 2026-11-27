# =============================================================================
# web.py: Stdlib HTTP(S) front end: routing, auth, static files, SSE.
# =============================================================================

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
import json
import logging
import re
import socket
import ssl
from urllib.parse import parse_qs, unquote, urlsplit

from .accounts import COOKIE_NAME
from .config import is_loopback
from .events import ApiError


log = logging.getLogger('lyra.web')

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; "
       "base-uri 'none'; form-action 'self'")
STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
                '.json': 'application/json'}
ADMIN, AGENT, EITHER, PUBLIC = 'admin', 'agent', 'either', 'public'

ROUTES = []


def route(method, pattern, auth):
  rx = re.compile('^' + pattern + '$')

  def deco(fn):
    ROUTES.append((method, rx, auth, fn))
    return fn
  return deco


# =============================================================================
# Handlers (each receives the request context and path groups)
# =============================================================================

@route('GET', r'/healthz', PUBLIC)
def h_health(ctx):
  return {'ok': True}


@route('POST', r'/api/v1/auth/login', PUBLIC)
def h_login(ctx):
  ctx.check_origin()
  b = ctx.body()
  token, max_age, user = ctx.app.login(b.get('username'), b.get('password'),
                                       bool(b.get('remember')), ctx.client_ip())
  ctx.set_cookie(token, max_age)
  return {'user': user, 'remember': bool(b.get('remember'))}


@route('POST', r'/api/v1/auth/logout', PUBLIC)
def h_logout(ctx):
  ctx.check_origin()
  ctx.app.logout(ctx.cookie())
  ctx.set_cookie('', 0)
  return {'ok': True}


@route('GET', r'/api/v1/auth/me', ADMIN)
def h_me(ctx):
  return {'user': ctx.app._user_view(ctx.user)}


@route('GET', r'/api/v1/board', ADMIN)
def h_board(ctx):
  return ctx.app.board()


@route('GET', r'/api/v1/usage', ADMIN)
def h_usage(ctx):
  return {'providers': ctx.app.usage_view()}


@route('GET', r'/api/v1/admin/invites', ADMIN)
def h_invites(ctx):
  return {'invites': ctx.app.list_invites()}


@route('POST', r'/api/v1/admin/invites', ADMIN)
def h_invite_new(ctx):
  b = ctx.body()
  return ctx.app.create_invite(b.get('display_name'), b.get('handle'), _int(b.get('pool_id')),
                               _int(b.get('target_principal_id')))


@route('DELETE', r'/api/v1/admin/invites/(\d+)', ADMIN)
def h_invite_cancel(ctx, iid):
  return ctx.app.cancel_invite(int(iid))


@route('POST', r'/api/v1/admin/principals/(\d+)/revoke', ADMIN)
def h_revoke(ctx, pid):
  return ctx.app.revoke(int(pid))


@route('PATCH', r'/api/v1/admin/principals/(\d+)', ADMIN)
def h_principal_patch(ctx, pid):
  b = ctx.body()
  data = {}
  if 'pool_id' in b:
    data['pool_id'] = _int(b.get('pool_id'))
  if b.get('display_name'):
    data['display_name'] = b['display_name']
  return ctx.app.update_principal(int(pid), data)


@route('POST', r'/api/v1/admin/pools', ADMIN)
def h_pool_new(ctx):
  b = ctx.body()
  return ctx.app.create_pool(b.get('provider'), b.get('label'))


@route('PATCH', r'/api/v1/admin/pools/(\d+)', ADMIN)
def h_pool_patch(ctx, pool_id):
  b = ctx.body()
  data = {}
  if 'reporter_principal_id' in b:
    data['reporter_principal_id'] = _int(b.get('reporter_principal_id'))
  if b.get('label'):
    data['label'] = b['label']
  return ctx.app.update_pool(int(pool_id), data)


@route('POST', r'/api/v1/admin/messages/(\d+)/retry', ADMIN)
def h_retry(ctx, mid):
  return ctx.app.retry(int(mid))


@route('GET', r'/api/v1/conversations', EITHER)
def h_convs(ctx):
  return {'conversations': ctx.app.conversations_for(ctx.principal, include_all=ctx.is_admin)}


@route('GET', r'/api/v1/conversations/(\d+)/messages', EITHER)
def h_conv_msgs(ctx, cid):
  q = ctx.query()
  return ctx.app.conversation_messages(ctx.principal, int(cid), after=_int(q.get('after')) or 0,
                                       limit=_int(q.get('limit')) or 200,
                                       include_all=ctx.is_admin)


@route('POST', r'/api/v1/messages', EITHER)
def h_send(ctx):
  b = ctx.body()
  return ctx.app.send(ctx.principal, b.get('to'), b.get('body'), mode=b.get('mode'),
                      client_msg_id=b.get('client_msg_id'))


@route('POST', r'/api/v1/messages/(\d+)/reply', EITHER)
def h_reply(ctx, mid):
  b = ctx.body()
  return ctx.app.reply(ctx.principal, int(mid), b.get('body'), mode=b.get('mode'),
                       client_msg_id=b.get('client_msg_id'))


@route('PUT', r'/api/v1/messages/(\d+)/reactions/([^/]+)', EITHER)
def h_react_add(ctx, mid, emoji):
  return ctx.app.react(ctx.principal, int(mid), unquote(emoji), add=True)


@route('DELETE', r'/api/v1/messages/(\d+)/reactions/([^/]+)', EITHER)
def h_react_del(ctx, mid, emoji):
  return ctx.app.react(ctx.principal, int(mid), unquote(emoji), add=False)


@route('POST', r'/api/v1/join', PUBLIC)
def h_join(ctx):
  key = f'join:{ctx.client_ip()}'
  wait = ctx.app.throttle.retry_after([key])
  if wait:
    raise ApiError(429, 'too_many_attempts', 'too many bad invite codes', retry_after=wait)
  try:
    return ctx.app.join(ctx.body())
  except ApiError as exc:
    if exc.code == 'bad_invite':
      ctx.app.throttle.fail([key])
    raise


@route('POST', r'/api/v1/checkin', AGENT)
def h_checkin(ctx):
  return ctx.app.checkin(ctx.principal, ctx.body())


@route('GET', r'/api/v1/me', AGENT)
def h_agent_me(ctx):
  p = ctx.principal
  return {'principal': {'id': p['id'], 'handle': p['handle'], 'display_name': p['display_name'],
                        'address': p['address']}, 'presence': ctx.app.presence_view(p['id'])}


@route('GET', r'/api/v1/teammates', AGENT)
def h_teammates(ctx):
  return {'teammates': ctx.app.teammates(ctx.principal)}


@route('GET', r'/api/v1/history', AGENT)
def h_history(ctx):
  q = ctx.query()
  return ctx.app.history_with(ctx.principal, (q.get('with') or 'owner').lower(),
                              limit=_int(q.get('limit')) or 20)


@route('POST', r'/api/v1/deliveries/claim', AGENT)
def h_claim(ctx):
  q = ctx.query()
  wait = float(q.get('wait') or 25)
  got = ctx.app.claim(ctx.principal, wait=wait)
  return got or {'lease_id': None, 'message': None}


@route('POST', r'/api/v1/deliveries/([A-Za-z0-9_\-]+)/(delivered|unconfirmed|failed)', AGENT)
def h_ack(ctx, lease_id, outcome):
  b = ctx.body()
  return ctx.app.ack(ctx.principal, lease_id, outcome, reason=b.get('reason'))


def _int(v):
  if v is None or v == '':
    return None
  try:
    return int(v)
  except (TypeError, ValueError):
    raise ApiError(422, 'bad_number', f'expected an integer, got {v!r}') from None


# =============================================================================
# Request context and handler
# =============================================================================

class Ctx:
  def __init__(self, handler):
    self.h = handler
    self.app = handler.server.app
    self.settings = self.app.settings
    self.user = None
    self.principal = None
    self.is_admin = False
    self._body = None
    self.cookie_out = None

  def query(self):
    q = parse_qs(urlsplit(self.h.path).query)
    return {k: v[-1] for k, v in q.items()}

  def body(self):
    if self._body is not None:
      return self._body
    n = int(self.h.headers.get('Content-Length') or 0)
    if n > self.settings.max_body_bytes:
      raise ApiError(413, 'body_too_large', 'request body is too large')
    raw = self.h.rfile.read(n) if n else b''
    if not raw:
      self._body = {}
      return self._body
    try:
      data = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
      raise ApiError(400, 'bad_json', 'request body must be JSON') from None
    if not isinstance(data, dict):
      raise ApiError(400, 'bad_json', 'request body must be a JSON object')
    self._body = data
    return data

  def client_ip(self):
    ip = self.h.client_address[0]
    if self.settings.trust_proxy_headers and is_loopback(ip):
      fwd = self.h.headers.get('X-Forwarded-For')
      if fwd:
        return fwd.split(',')[0].strip()
    return ip

  def request_scheme(self):
    if self.settings.trust_proxy_headers and is_loopback(self.h.client_address[0]):
      proto = self.h.headers.get('X-Forwarded-Proto')
      if proto in ('http', 'https'):
        return proto
    return self.settings.scheme

  def cookie(self):
    raw = self.h.headers.get('Cookie') or ''
    for part in raw.split(';'):
      k, _, v = part.strip().partition('=')
      if k == COOKIE_NAME:
        return v
    return None

  def set_cookie(self, token, max_age):
    attrs = [f'{COOKIE_NAME}={token}', 'Path=/', 'HttpOnly', 'SameSite=Strict']
    if self.settings.secure_cookies() or self.request_scheme() == 'https':
      attrs.append('Secure')
    if max_age is not None:
      attrs.append(f'Max-Age={int(max_age)}')
    self.cookie_out = '; '.join(attrs)

  def check_origin(self):
    """Cookie-authenticated writes must come from the board's own origin."""
    origin = (self.h.headers.get('Origin') or '').lower().rstrip('/')
    if self.settings.public_url:
      allowed = self.settings.allowed_origins()
    else:
      host = (self.h.headers.get('Host') or '').lower()
      allowed = {f'{self.request_scheme()}://{host}'} | self.settings.allowed_origins()
    if not origin:
      if (self.h.headers.get('Sec-Fetch-Site') or '') == 'same-origin':
        return
      raise ApiError(403, 'origin_required', 'missing Origin header')
    if origin not in allowed:
      raise ApiError(403, 'bad_origin', 'request origin is not allowed')

  def authenticate(self, mode, method):
    auth = self.h.headers.get('Authorization') or ''
    if auth.startswith('Bearer ') and mode in (AGENT, EITHER):
      p = self.app.principal_for_token(auth[7:].strip())
      if not p:
        raise ApiError(401, 'bad_token', 'agent credential is invalid or revoked')
      self.principal = p
      return
    if mode == AGENT:
      raise ApiError(401, 'agent_auth_required', 'agent bearer token required')
    user = self.app.user_for_cookie(self.cookie())
    if not user:
      raise ApiError(401, 'login_required', 'please sign in')
    if method not in ('GET', 'HEAD'):
      self.check_origin()
    self.user = user
    self.is_admin = user['role'] == 'admin'
    if mode == ADMIN and not self.is_admin:
      raise ApiError(403, 'admin_only', 'administrator access required')
    self.principal = self.app.db.one('SELECT * FROM principals WHERE id=?', (user['principal_id'],))


class Handler(BaseHTTPRequestHandler):
  protocol_version = 'HTTP/1.1'
  server_version = 'Lyra'
  sys_version = ''
  timeout = 90  # idle keep-alive sockets close instead of pinning threads

  def setup(self):
    if isinstance(self.request, ssl.SSLSocket):
      self.request.settimeout(15)
      self.request.do_handshake()
    super().setup()

  def handle(self):
    try:
      super().handle()
    except (ssl.SSLError, ConnectionResetError, BrokenPipeError, TimeoutError):
      self.close_connection = True

  def log_message(self, fmt, *args):
    log.info('%s %s', self.address_string(), fmt % args)

  def _headers(self, status, ctype, length, extra=None, cache='no-store'):
    self.send_response(status)
    self.send_header('Content-Type', ctype)
    if length is not None:
      self.send_header('Content-Length', str(length))
    self.send_header('Cache-Control', cache)
    self.send_header('Content-Security-Policy', CSP)
    self.send_header('X-Content-Type-Options', 'nosniff')
    self.send_header('Referrer-Policy', 'no-referrer')
    self.send_header('X-Frame-Options', 'DENY')
    for k, v in (extra or {}).items():
      self.send_header(k, v)
    self.end_headers()

  def _json(self, status, obj, cookie=None):
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    extra = {'Set-Cookie': cookie} if cookie else {}
    if status == 429 and isinstance(obj, dict) and obj.get('retry_after'):
      extra['Retry-After'] = str(obj['retry_after'])
    self._headers(status, 'application/json; charset=utf-8', len(data), extra)
    self.wfile.write(data)

  def _static(self, name):
    if '/' in name or name.startswith('.'):
      return self._json(404, {'error': 'not_found'})
    res = resources.files('lyra_server').joinpath('static', name)
    if not res.is_file():
      return self._json(404, {'error': 'not_found'})
    data = res.read_bytes()
    ext = name[name.rfind('.'):] if '.' in name else ''
    self._headers(200, STATIC_TYPES.get(ext, 'application/octet-stream'), len(data),
                  cache='no-cache')
    self.wfile.write(data)

  def _dispatch(self, method):
    path = urlsplit(self.path).path
    if method == 'GET' and path in ('/', '/index.html'):
      return self._static('index.html')
    if method == 'GET' and path.startswith('/static/'):
      return self._static(path[len('/static/'):])
    if method == 'GET' and path == '/api/v1/events':
      return self._sse()
    ctx = Ctx(self)
    try:
      for m, rx, auth, fn in ROUTES:
        if m != method:
          continue
        hit = rx.match(path)
        if not hit:
          continue
        if auth != PUBLIC:
          ctx.authenticate(auth, method)
        out = fn(ctx, *hit.groups())
        return self._json(200, out, ctx.cookie_out)
      known = any(rx.match(path) for _m, rx, _a, _f in ROUTES)
      return self._json(405 if known else 404, {'error': 'method_not_allowed' if known else 'not_found'})
    except ApiError as exc:
      return self._json(exc.status, exc.body(), ctx.cookie_out)
    except (BrokenPipeError, ConnectionResetError):
      return None
    except Exception:  # noqa: BLE001
      log.exception('unhandled error on %s %s', method, path)
      return self._json(500, {'error': 'internal', 'message': 'internal server error'})

  def _sse(self):
    ctx = Ctx(self)
    try:
      ctx.authenticate(ADMIN, 'GET')
    except ApiError as exc:
      return self._json(exc.status, exc.body())
    app = self.server.app
    q = ctx.query()
    last = self.headers.get('Last-Event-ID') or q.get('last')
    try:
      last = int(last) if last not in (None, '') else app.events.latest_id()
    except ValueError:
      last = app.events.latest_id()
    self.close_connection = True
    self._headers(200, 'text/event-stream; charset=utf-8', None,
                  {'X-Accel-Buffering': 'no', 'Connection': 'close'}, cache='no-cache')
    try:
      self.wfile.write(b'retry: 3000\n\n')
      self.wfile.flush()
      while not self.server.stopping:
        batch = app.events.since(last)
        for ev in batch:
          payload = json.dumps({'type': ev['type'], **ev['payload']}, ensure_ascii=False)
          self.wfile.write(f"id: {ev['id']}\nevent: {ev['type']}\ndata: {payload}\n\n".encode('utf-8'))
          last = ev['id']
        if batch:
          self.wfile.flush()
          continue
        if not app.events.wait(last, 15.0):
          self.wfile.write(b': ping\n\n')
          self.wfile.flush()
          if not app.user_for_cookie(ctx.cookie()):
            return None
    except (BrokenPipeError, ConnectionResetError, ssl.SSLError, OSError):
      return None
    except Exception:  # noqa: BLE001 - e.g. database closed during shutdown
      log.debug('sse stream ended', exc_info=True)
      return None
    return None

  def do_GET(self):  # noqa: N802
    self._dispatch('GET')

  def do_POST(self):  # noqa: N802
    self._dispatch('POST')

  def do_PUT(self):  # noqa: N802
    self._dispatch('PUT')

  def do_PATCH(self):  # noqa: N802
    self._dispatch('PATCH')

  def do_DELETE(self):  # noqa: N802
    self._dispatch('DELETE')


class LyraHTTPServer(ThreadingHTTPServer):
  daemon_threads = True
  allow_reuse_address = True

  def __init__(self, app):
    s = app.settings
    host = s.bind
    self.address_family = socket.AF_INET6 if ':' in host else socket.AF_INET
    super().__init__((host, s.port), Handler)
    self.app = app
    self.stopping = False
    if s.tls:
      tls = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
      tls.minimum_version = ssl.TLSVersion.TLSv1_2
      tls.load_cert_chain(s.tls_cert, s.tls_key)
      # i. Handshake lazily in the worker thread so a slow client cannot stall accept().
      self.socket = tls.wrap_socket(self.socket, server_side=True, do_handshake_on_connect=False)

  def handle_error(self, request, client_address):
    log.debug('connection error from %s', client_address, exc_info=True)

  def shutdown(self):
    self.stopping = True
    super().shutdown()
