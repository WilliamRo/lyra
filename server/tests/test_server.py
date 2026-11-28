# =============================================================================
# test_server.py: HTTP-level tests for lyra-server (stdlib unittest).
# Run: python3 -B -m unittest discover -s server/tests -t server
# =============================================================================

import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lyra_server import backup, config  # noqa: E402
from lyra_server.core import Lyra  # noqa: E402
from lyra_server.web import LyraHTTPServer  # noqa: E402

PASSWORD = 'correct horse battery'


class Clock:
  def __init__(self):
    self.t = time.time()

  def __call__(self):
    return self.t

  def advance(self, secs):
    self.t += secs


def tmpdir():
  base = os.environ.get('LYRA_TEST_TMP') or tempfile.gettempdir()
  return tempfile.mkdtemp(prefix='lyra-test-', dir=base)


class Client:
  """Tiny JSON client with a cookie jar; sends the board Origin by default."""

  def __init__(self, base, origin=True):
    self.base = base
    self.jar = http.cookiejar.CookieJar()
    self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
    self.origin = base if origin is True else origin
    self.token = None
    self.last_headers = None

  def call(self, method, path, body=None, headers=None):
    data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(self.base + path, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if self.origin:
      req.add_header('Origin', self.origin)
    if self.token:
      req.add_header('Authorization', f'Bearer {self.token}')
    for k, v in (headers or {}).items():
      req.add_header(k, v)
    try:
      with self.opener.open(req, timeout=30) as r:
        self.last_headers = r.headers
        raw = r.read()
        return r.status, json.loads(raw or b'{}') if r.headers.get_content_type() == 'application/json' else raw
    except urllib.error.HTTPError as e:
      self.last_headers = e.headers
      raw = e.read()
      return e.code, (json.loads(raw) if raw else {})


class ServerCase(unittest.TestCase):
  """Fresh server per test class on an ephemeral port with a fake clock."""

  overrides = {}

  @classmethod
  def setUpClass(cls):
    cls.dir = tmpdir()
    env = {'LYRA_DATA_DIR': cls.dir, 'LYRA_PORT': '0', **cls.overrides}
    cls.settings = config.validate(config.load(env=env))
    cls.clock = Clock()
    cls.app = Lyra(cls.settings, clock=cls.clock)
    cls.app.init_admin('owner', PASSWORD, display_name='Owner')
    cls.httpd = LyraHTTPServer(cls.app)
    cls.port = cls.httpd.server_address[1]
    cls.settings.port = cls.port
    cls.base = f'http://127.0.0.1:{cls.port}'
    cls.thread = threading.Thread(target=cls.httpd.serve_forever, kwargs={'poll_interval': 0.1},
                                  daemon=True)
    cls.thread.start()

  @classmethod
  def tearDownClass(cls):
    cls.app.stop()
    cls.httpd.shutdown()
    cls.httpd.server_close()
    cls.app.db.close()
    shutil.rmtree(cls.dir, ignore_errors=True)

  # --- helpers -------------------------------------------------------------

  def owner(self, remember=False):
    c = Client(self.base)
    st, body = c.call('POST', '/api/v1/auth/login',
                      {'username': 'owner', 'password': PASSWORD, 'remember': remember})
    self.assertEqual(st, 200, body)
    return c

  def agent(self, owner, handle, modes=('queue',), pool_id=None, checkin=True):
    st, inv = owner.call('POST', '/api/v1/admin/invites',
                         {'display_name': handle.capitalize(), 'handle': handle, 'pool_id': pool_id})
    self.assertEqual(st, 200, inv)
    a = Client(self.base, origin=None)
    st, j = a.call('POST', '/api/v1/join', {
      'invite_code': inv['code'], 'client_key': f'ck-{handle}-0123456789abcdef',
      'handle': handle, 'host': 'testhost', 'provider': 'test', 'runtime': 'echo',
      'connector': 'echo', 'address': f'echo://testhost/{handle}', 'modes': list(modes)})
    self.assertEqual(st, 200, j)
    a.token = j['token']
    a.pid = j['principal']['id']
    a.handle = handle
    a.invite = inv
    if checkin:
      self.checkin(a, modes)
    return a

  def checkin(self, a, modes=('queue',), **extra):
    st, r = a.call('POST', '/api/v1/checkin', {'instance_id': f'inst-{a.handle}',
                                               'modes': list(modes), **extra})
    self.assertEqual(st, 200, r)
    return r

  def claim(self, a, wait=0):
    st, r = a.call('POST', f'/api/v1/deliveries/claim?wait={wait}')
    self.assertEqual(st, 200, r)
    return r

  def board_agent(self, owner, pid):
    st, b = owner.call('GET', '/api/v1/board')
    self.assertEqual(st, 200)
    return next(x for x in b['agents'] if x['id'] == pid)


# =============================================================================
# Configuration (D1)
# =============================================================================

class ConfigTests(unittest.TestCase):

  def test_refuses_synced_data_dir(self):
    for p in ('~/Library/CloudStorage/Dropbox/x', '/Users/u/Dropbox/lyra', '/home/u/OneDrive - Org/l'):
      with self.subTest(p=p):
        with self.assertRaises(config.ConfigError):
          config.validate(config.load(env={'LYRA_DATA_DIR': p}))

  def test_allows_local_dir_when_home_has_dropbox_app_dir(self):
    fake_home = Path(tmpdir())
    (fake_home / '.dropbox').mkdir()
    local_data = fake_home / 'Library' / 'Application Support' / 'lyra-server'
    orig_home = Path.home
    try:
      Path.home = classmethod(lambda cls: fake_home)
      s = config.validate(config.load(env={'LYRA_DATA_DIR': str(local_data)}))
      self.assertEqual(s.data_path, local_data)
    finally:
      Path.home = orig_home

  def test_refuses_plaintext_non_loopback(self):
    with self.assertRaises(config.ConfigError):
      config.validate(config.load(env={'LYRA_DATA_DIR': tmpdir(), 'LYRA_BIND': '0.0.0.0',
                                       'LYRA_PUBLIC_URL': 'https://lyra.example'}))

  def test_requires_https_public_url_off_loopback(self):
    with self.assertRaises(config.ConfigError):
      config.validate(config.load(env={'LYRA_DATA_DIR': tmpdir(),
                                       'LYRA_PUBLIC_URL': 'http://lyra.example'}))

  def test_toml_then_env_override(self):
    d = tmpdir()
    p = Path(d) / 'lyra.toml'
    p.write_text(f'port = 9001\ndata_dir = {json.dumps(d)}\nmessage_ttl_sec = 120\n')
    if sys.version_info < (3, 11):
      with self.assertRaisesRegex(config.ConfigError, 'TOML configuration requires'):
        config.load(env={'LYRA_CONFIG': str(p)})
      return
    s = config.validate(config.load(env={'LYRA_CONFIG': str(p), 'LYRA_PORT': '9002'}))
    self.assertEqual((s.port, s.message_ttl_sec, str(s.data_path)), (9002, 120, d))

  def test_defaults_match_owner_decisions(self):
    s = config.Settings()
    self.assertEqual((s.message_ttl_sec, s.invite_ttl_sec, s.remember_me_days), (86400, 86400, 30))


# =============================================================================
# Sign-in and authorization (D5)
# =============================================================================

class AuthTests(ServerCase):

  def test_remember_me_cookie_is_persistent(self):
    c = Client(self.base)
    c.call('POST', '/api/v1/auth/login', {'username': 'owner', 'password': PASSWORD, 'remember': True})
    cookie = c.last_headers['Set-Cookie']
    self.assertIn(f'Max-Age={30 * 86400}', cookie)
    self.assertIn('HttpOnly', cookie)
    self.assertIn('SameSite=Strict', cookie)

  def test_browser_session_cookie_without_remember(self):
    c = Client(self.base)
    c.call('POST', '/api/v1/auth/login', {'username': 'owner', 'password': PASSWORD, 'remember': False})
    self.assertNotIn('Max-Age', c.last_headers['Set-Cookie'])
    self.assertEqual(c.call('GET', '/api/v1/board')[0], 200)

  def test_idle_browser_session_expires_but_remembered_persists(self):
    short = self.owner(remember=False)
    longer = self.owner(remember=True)
    self.clock.advance(13 * 3600)
    self.assertEqual(short.call('GET', '/api/v1/board')[0], 401)
    self.assertEqual(longer.call('GET', '/api/v1/board')[0], 200)
    self.clock.advance(31 * 86400)
    self.assertEqual(longer.call('GET', '/api/v1/board')[0], 401)

  def test_logout_ends_session(self):
    c = self.owner()
    self.assertEqual(c.call('POST', '/api/v1/auth/logout', {})[0], 200)
    self.assertEqual(c.call('GET', '/api/v1/board')[0], 401)

  def test_wrong_password_then_throttle(self):
    c = Client(self.base)
    codes = [c.call('POST', '/api/v1/auth/login', {'username': 'ghost', 'password': 'nope'})[0]
             for _ in range(6)]
    self.assertEqual(codes[:5], [401] * 5)
    self.assertEqual(codes[5], 429)
    self.app.throttle._fails.clear()

  def test_cross_origin_write_rejected(self):
    c = self.owner()
    c.origin = 'https://evil.example'
    st, body = c.call('POST', '/api/v1/admin/pools', {'provider': 'x', 'label': 'y'})
    self.assertEqual((st, body['error']), (403, 'bad_origin'))

  def test_agent_token_cannot_reach_admin(self):
    o = self.owner()
    a = self.agent(o, 'scoped')
    for method, path in (('GET', '/api/v1/board'), ('POST', '/api/v1/admin/invites'),
                         ('POST', f'/api/v1/admin/principals/{a.pid}/revoke'), ('GET', '/api/v1/usage')):
      with self.subTest(path=path):
        self.assertEqual(a.call(method, path, {})[0], 401)
    self.assertEqual(self.board_agent(o, a.pid)['status'], 'admitted')

  def test_security_headers(self):
    c = self.owner()
    c.call('GET', '/api/v1/board')
    self.assertIn("script-src 'self'", c.last_headers['Content-Security-Policy'])
    self.assertEqual(c.last_headers['X-Content-Type-Options'], 'nosniff')


# =============================================================================
# One-time invites, re-admission, instances (D6, D2)
# =============================================================================

class InviteTests(ServerCase):

  def test_invite_single_use_and_retry_window(self):
    o = self.owner()
    a = self.agent(o, 'single')
    payload = {'invite_code': a.invite['code'], 'client_key': 'ck-single-0123456789abcdef',
               'handle': 'single', 'address': 'echo://testhost/single'}
    other = Client(self.base, origin=None)
    st, body = other.call('POST', '/api/v1/join', {**payload, 'client_key': 'someone-else-0123456789'})
    self.assertEqual((st, body['error']), (409, 'invite_used'))
    # i. Lost response: same client key inside the window rotates the token.
    st, again = other.call('POST', '/api/v1/join', payload)
    self.assertEqual(st, 200, again)
    self.assertTrue(again['rotated'])
    self.assertEqual(a.call('GET', '/api/v1/me')[0], 401)  # old token revoked
    a.token = again['token']
    self.assertEqual(a.call('GET', '/api/v1/me')[0], 200)
    self.clock.advance(self.settings.invite_retry_window_sec + 1)
    self.assertEqual(other.call('POST', '/api/v1/join', payload)[0], 409)

  def test_expired_and_cancelled_invites(self):
    o = self.owner()
    st, inv = o.call('POST', '/api/v1/admin/invites', {'handle': 'late'})
    self.clock.advance(86400 + 1)
    o = self.owner()  # browser session idles out after 12 hours, as designed
    j = Client(self.base, origin=None)
    st, body = j.call('POST', '/api/v1/join', {'invite_code': inv['code'],
                                              'client_key': 'ck-late-0123456789abcdef'})
    self.assertEqual((st, body['error']), (410, 'invite_expired'))
    st, inv2 = o.call('POST', '/api/v1/admin/invites', {'handle': 'cxl'})
    self.assertEqual(o.call('DELETE', f"/api/v1/admin/invites/{inv2['invite']['id']}")[0], 200)
    st, body = j.call('POST', '/api/v1/join', {'invite_code': inv2['code'],
                                              'client_key': 'ck-cxl-0123456789abcdef'})
    self.assertEqual(st, 410)

  def test_bad_code_rejected(self):
    j = Client(self.base, origin=None)
    st, body = j.call('POST', '/api/v1/join', {'invite_code': 'lyra-inv_nope',
                                              'client_key': 'ck-x-0123456789abcdef'})
    self.assertEqual((st, body['error']), (401, 'bad_invite'))

  def test_revoke_then_readmit_keeps_history(self):
    o = self.owner()
    a = self.agent(o, 'phoenix')
    st, sent = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'before revoke'})
    conv = sent['message']['conversation_id']
    st, r = o.call('POST', f'/api/v1/admin/principals/{a.pid}/revoke', {})
    self.assertEqual((st, r['failed_messages']), (200, 1))
    self.assertEqual(a.call('GET', '/api/v1/me')[0], 401)
    st, msgs = o.call('GET', f'/api/v1/conversations/{conv}/messages')
    self.assertEqual(msgs['messages'][0]['state'], 'failed')
    self.assertEqual(msgs['messages'][0]['state_reason'], 'recipient revoked')
    st, inv = o.call('POST', '/api/v1/admin/invites', {'target_principal_id': a.pid})
    self.assertEqual(st, 200, inv)
    b = Client(self.base, origin=None)
    st, j = b.call('POST', '/api/v1/join', {'invite_code': inv['code'],
                                           'client_key': 'ck-phoenix2-0123456789ab',
                                           'address': 'echo://testhost/phoenix'})
    self.assertEqual(st, 200, j)
    self.assertEqual(j['principal']['id'], a.pid)  # same identity, no UNIQUE error
    b.token = j['token']
    st, hist = b.call('GET', '/api/v1/history?with=owner')
    self.assertEqual(hist['conversation_id'], conv)
    self.assertEqual(hist['messages'][0]['body'], 'before revoke')

  def test_active_identity_clash_rejected(self):
    o = self.owner()
    self.agent(o, 'twin')
    st, inv = o.call('POST', '/api/v1/admin/invites', {'handle': 'twin'})
    j = Client(self.base, origin=None)
    st, body = j.call('POST', '/api/v1/join', {'invite_code': inv['code'],
                                              'client_key': 'ck-twin2-0123456789abcdef'})
    self.assertEqual((st, body['error']), (409, 'identity_in_use'))

  def test_second_live_instance_conflicts(self):
    o = self.owner()
    a = self.agent(o, 'solo')
    st, body = a.call('POST', '/api/v1/checkin', {'instance_id': 'other-process'})
    self.assertEqual((st, body['error']), (409, 'instance_conflict'))
    self.clock.advance(self.settings.checkin_ttl_sec + 1)
    self.assertEqual(a.call('POST', '/api/v1/checkin', {'instance_id': 'other-process'})[0], 200)


# =============================================================================
# Presence and check-ins (brief s2, walkthrough i)
# =============================================================================

class PresenceTests(ServerCase):

  def test_pausing_one_agent_only_takes_it_offline(self):
    o = self.owner()
    a = self.agent(o, 'alpha')
    b = self.agent(o, 'beta')
    self.clock.advance(30)
    self.checkin(b)  # alpha pauses, beta keeps checking in
    self.clock.advance(20)
    self.app.sweep_once()
    self.assertFalse(self.board_agent(o, a.pid)['presence']['online'])
    self.assertTrue(self.board_agent(o, b.pid)['presence']['online'])
    self.checkin(a)
    self.assertTrue(self.board_agent(o, a.pid)['presence']['online'])

  def test_unknown_metadata_and_status(self):
    o = self.owner()
    a = self.agent(o, 'quiet')
    st = self.board_agent(o, a.pid)['presence']['status']
    self.assertIsNone(st.get('model'))
    self.checkin(a, status={'model': 'Opus 5.5', 'effort': 'high', 'context_pct': 140, 'busy': True})
    st = self.board_agent(o, a.pid)['presence']['status']
    self.assertEqual((st['model'], st['effort'], st['context_pct'], st['busy']),
                     ('Opus 5.5', 'high', 100.0, True))

  def test_routine_checkins_add_no_events(self):
    o = self.owner()
    a = self.agent(o, 'steady')
    before = self.app.events.latest_id()
    for _ in range(40):
      self.clock.advance(15)
      self.checkin(a)
    self.assertEqual(self.app.events.latest_id(), before)

  def test_teammates(self):
    o = self.owner()
    a = self.agent(o, 'tm1', modes=('queue', 'jump'))
    b = self.agent(o, 'tm2')
    st, r = b.call('GET', '/api/v1/teammates')
    mates = {t['handle']: t for t in r['teammates']}
    self.assertIn('owner', mates)
    self.assertEqual(mates['tm1']['modes'], ['queue', 'jump'])
    self.assertNotIn('tm2', mates)


# =============================================================================
# Messaging, replies, reactions, visibility (brief s3, D3)
# =============================================================================

class MessagingTests(ServerCase):

  def test_owner_round_trip_with_reply_and_reaction(self):
    o = self.owner()
    a = self.agent(o, 'dario')
    st, sent = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'ping 42', 'from': 999})
    m = sent['message']
    self.assertEqual((m['state'], m['sender']['kind']), ('waiting', 'owner'))
    got = self.claim(a)
    self.assertEqual(got['message']['body'], 'ping 42')
    self.assertEqual(a.call('POST', f"/api/v1/deliveries/{got['lease_id']}/delivered", {})[0], 200)
    st, rep = a.call('POST', f"/api/v1/messages/{m['id']}/reply", {'body': 'pong 42'})
    self.assertEqual(st, 200, rep)
    self.assertEqual(rep['message']['state'], 'delivered')  # owner reads on the board
    self.assertEqual(rep['message']['reply_to']['id'], m['id'])
    self.assertEqual(a.call('PUT', f"/api/v1/messages/{m['id']}/reactions/%E2%8C%A8%EF%B8%8F")[0], 200)
    st, msgs = o.call('GET', f"/api/v1/conversations/{m['conversation_id']}/messages")
    first, second = msgs['messages']
    self.assertEqual(first['state'], 'delivered')
    self.assertEqual(first['reactions'][0]['emoji'], '⌨️')
    self.assertEqual(second['sender']['handle'], 'dario')
    self.assertEqual(a.call('DELETE', f"/api/v1/messages/{m['id']}/reactions/%E2%8C%A8%EF%B8%8F")[0], 200)
    self.assertEqual(o.call('PUT', f"/api/v1/messages/{m['id']}/reactions/bad%20emoji")[0], 422)

  def test_agent_to_agent_identity_and_owner_read_only(self):
    o = self.owner()
    d = self.agent(o, 'dario2')
    c = self.agent(o, 'claude2')
    st, sent = d.call('POST', '/api/v1/messages', {'to': 'claude2', 'body': 'hi claude'})
    m = sent['message']
    self.assertEqual((m['conversation_kind'], m['sender']['handle'], m['recipient']['handle']),
                     ('agent_agent', 'dario2', 'claude2'))
    got = self.claim(c)
    self.assertEqual(got['message']['sender']['handle'], 'dario2')
    c.call('POST', f"/api/v1/deliveries/{got['lease_id']}/delivered", {})
    st, rep = c.call('POST', f"/api/v1/messages/{m['id']}/reply", {'body': 'hi dario'})
    back = self.claim(d)
    self.assertEqual((back['message']['sender']['handle'], back['message']['reply_to']['id']),
                     ('claude2', m['id']))
    # i. Owner can read but not write in agent-to-agent conversations.
    st, convs = o.call('GET', '/api/v1/conversations')
    team = next(x for x in convs['conversations'] if x['id'] == m['conversation_id'])
    self.assertTrue(team['read_only'])
    st, msgs = o.call('GET', f"/api/v1/conversations/{m['conversation_id']}/messages")
    self.assertEqual(len(msgs['messages']), 2)
    st, body = o.call('POST', f"/api/v1/messages/{m['id']}/reply", {'body': 'x'})
    self.assertEqual((st, body['error']), (403, 'read_only'))
    self.assertEqual(o.call('PUT', f"/api/v1/messages/{m['id']}/reactions/%F0%9F%91%8D")[0], 403)

  def test_non_member_cannot_reply_or_read(self):
    o = self.owner()
    a = self.agent(o, 'insider')
    x = self.agent(o, 'outsider')
    st, sent = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'private'})
    mid = sent['message']['id']
    self.assertEqual(x.call('POST', f'/api/v1/messages/{mid}/reply', {'body': 'sneak'})[0], 403)
    self.assertEqual(x.call('GET', f"/api/v1/conversations/{sent['message']['conversation_id']}/messages")[0], 403)

  def test_duplicate_send_is_idempotent(self):
    o = self.owner()
    a = self.agent(o, 'idem')
    one = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'x', 'client_msg_id': 'k1'})[1]
    two = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'x', 'client_msg_id': 'k1'})[1]
    self.assertEqual(one['message']['id'], two['message']['id'])
    self.assertTrue(two['duplicate'])

  def test_agent_loop_guard(self):
    o = self.owner()
    a = self.agent(o, 'loopa')
    self.agent(o, 'loopb')
    codes = [a.call('POST', '/api/v1/messages', {'to': 'loopb', 'body': f'n{i}'})[0] for i in range(21)]
    self.assertEqual(codes[:20], [200] * 20)
    self.assertEqual(codes[20], 429)

  def test_xss_payload_is_stored_verbatim_as_data(self):
    o = self.owner()
    a = self.agent(o, 'xss')
    payload = '<script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1))'
    st, rep = a.call('POST', '/api/v1/messages', {'to': 'owner', 'body': payload})
    self.assertEqual(rep['message']['body'], payload)
    js = (ROOT / 'lyra_server' / 'static' / 'app.js').read_text('utf-8')
    for sink in ('innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval('):
      self.assertNotIn(sink, js, msg=f'unsafe sink {sink} in app.js')
    self.assertIn("(https:\\/\\/", js, msg='links must be restricted to https')


# =============================================================================
# Delivery modes, leases, failures (brief s4, D4, walkthrough iv)
# =============================================================================

class AttachmentTests(ServerCase):
  overrides = {'LYRA_MAX_ATTACHMENT_BYTES': '1024', 'LYRA_MAX_BODY_BYTES': '512'}
  png = b'\x89PNG\r\n\x1a\n' + bytes(600)
  endpoint = '/api/v1/attachments'

  def upload(self, client, data=None):
    st, result = client.call('POST', self.endpoint, self.png if data is None else data,
                             {'X-Filename': '..%2F%22display%22%20name.txt'})
    self.assertEqual(st, 200, result)
    return result['attachment']

  def test_formats_binary_limit_and_headers(self):
    o = self.owner()
    for data, mime in [(self.png, 'png'), (b'\xff\xd8\xff', 'jpeg'), (b'GIF87a', 'gif'),
                       (b'GIF89a', 'gif'), (b'RIFF1234WEBP', 'webp')]:
      with self.subTest(mime=mime):
        image = self.upload(o, data)
        self.assertEqual(set(image), {'id', 'url', 'mime_type', 'size_bytes', 'sha256', 'created_at', 'filename'})
        self.assertEqual(image['mime_type'], 'image/' + mime)
        self.assertEqual(image['size_bytes'], len(data))
        self.assertEqual(image['sha256'], hashlib.sha256(data).hexdigest())
        self.assertNotIn('/', image['filename'])
        self.assertEqual(o.call('GET', image['url']), (200, data))
        self.assertEqual(o.last_headers['Content-Type'], image['mime_type'])
        self.assertEqual(o.last_headers['X-Content-Type-Options'], 'nosniff')
        self.assertIn("img-src 'self' data:", o.last_headers['Content-Security-Policy'])
        self.assertTrue(o.last_headers['Content-Disposition'].startswith('inline; filename="'))
        self.assertEqual(o.last_headers['Cache-Control'], 'private, max-age=86400')
    for data, status, code in [(b'', 422, 'empty_attachment'), (self.png * 2, 413, 'attachment_too_large'),
                               (b'<svg/>', 415, 'unsupported_media_type'), (b'<html>', 415, 'unsupported_media_type'),
                               (b'RIFF1234FAKE', 415, 'unsupported_media_type')]:
      st, res = o.call('POST', self.endpoint, data, {'Content-Type': 'image/png'})
      self.assertEqual((st, res['error']), (status, code))
    cfg = o.call('GET', '/api/v1/board')[1]['settings']
    self.assertEqual((cfg['max_attachments_per_message'], cfg['max_attachment_bytes']), (4, 1024))

  def test_access_before_and_after_binding(self):
    o = self.owner()
    a, b, outsider = (self.agent(o, h) for h in ('imgsender', 'imgreceiver', 'imgoutsider'))
    self.checkin(b, capabilities={'images': True})
    anon = Client(self.base)
    self.assertEqual(anon.call('POST', self.endpoint, self.png)[0], 401)
    self.assertEqual(o.call('POST', self.endpoint, self.png, {'Origin': 'https://elsewhere.invalid'})[0], 403)
    image = self.upload(a)
    for client in (o, b, outsider):
      self.assertEqual(client.call('GET', image['url'])[0], 403)
    self.assertEqual(a.call('GET', image['url']), (200, self.png))
    self.assertEqual(a.call('POST', '/api/v1/messages', {'to': b.pid, 'attachment_ids': [image['id']]})[0], 200)
    for client in (o, a, b):
      self.assertEqual(client.call('GET', image['url']), (200, self.png))
    self.assertEqual(outsider.call('GET', image['url'])[0], 403)
    self.assertEqual(anon.call('GET', image['url'])[0], 401)

  def test_image_only_send_replies_and_order(self):
    o = self.owner()
    a = self.agent(o, 'imgthread')
    self.checkin(a, capabilities={'images': True})
    ids = [self.upload(o)['id'], self.upload(o)['id']][::-1]
    request = {'to': a.pid, 'attachment_ids': ids, 'client_msg_id': 'pictures'}
    st, sent = o.call('POST', '/api/v1/messages', request)
    self.assertEqual(st, 200, sent)
    self.assertTrue(o.call('POST', '/api/v1/messages', request)[1]['duplicate'])
    m = self.claim(a)['message']
    self.assertEqual([i['id'] for i in m['attachments']], ids)
    self.assertEqual(m['body'], '')
    convs = o.call('GET', '/api/v1/conversations')[1]['conversations']
    self.assertEqual(next(c for c in convs if c['id'] == m['conversation_id'])['last']['excerpt'], '[Image x2]')
    rep = a.call('POST', f"/api/v1/messages/{m['id']}/reply", {'attachment_ids': [self.upload(a)['id']]})[1]['message']
    self.assertEqual(rep['reply_to']['excerpt'], '[Image x2]')
    reply_url = f"/api/v1/messages/{rep['id']}/reply"
    quote = o.call('POST', reply_url, {'body': 'received'})[1]['message']
    self.assertEqual((quote['reply_to']['excerpt'], quote['attachments']), ('[Image]', []))
    self.checkin(a)
    st, res = o.call('POST', reply_url, {'attachment_ids': [self.upload(o)['id']]})
    self.assertEqual((st, res['error']), (422, 'recipient_no_images'))

  def test_capability_gating_and_presence_event(self):
    o = self.owner()
    a = self.agent(o, 'imgtoggle')
    aid = self.upload(o)['id']
    body = {'to': a.pid, 'attachment_ids': [aid]}
    st, error = o.call('POST', '/api/v1/messages', body)
    self.assertEqual((st, error['error']), (422, 'recipient_no_images'))
    self.assertEqual(o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'text'})[0], 200)
    n = self.app.events.latest_id()
    self.checkin(a, capabilities={'images': True})
    row = self.app.db.one("SELECT payload FROM events WHERE id>? AND type='presence'", (n,))
    self.assertTrue(json.loads(row[0])['changed'])
    self.assertTrue(self.board_agent(o, a.pid)['presence']['capabilities']['images'])
    observer = self.agent(o, 'imgobserver')
    mates = {p['handle']: p for p in observer.call('GET', '/api/v1/teammates')[1]['teammates']}
    self.assertTrue(all(mates[h]['capabilities']['images'] for h in ('owner', a.handle)))
    self.assertEqual(o.call('POST', '/api/v1/messages', body)[0], 200)
    self.clock.advance(self.settings.checkin_ttl_sec + 1)
    self.assertFalse(self.app.presence_view(a.pid)['capabilities']['images'])

  def test_validation_ownership_and_atomic_reuse(self):
    o = self.owner()
    a = self.agent(o, 'imgbind')
    self.checkin(a, capabilities={'images': True})
    mine, theirs = self.upload(o)['id'], self.upload(a)['id']
    def send(ids):
      return o.call('POST', '/api/v1/messages', {'to': a.pid, 'attachment_ids': ids})
    for ids, status, code in [([], 422, 'empty_body'), ([mine, mine], 422, 'bad_attachment_ids'),
                              ([True], 422, 'bad_attachment_ids'), ([1, 2, 3, 4, 5], 422, 'bad_attachment_ids'),
                              ([mine, 100000], 404, 'no_attachment'), ([mine, theirs], 403, 'attachment_forbidden')]:
      st, res = send(ids)
      self.assertEqual((st, res['error']), (status, code))
    self.assertEqual(send([mine])[0], 200)
    st, res = send([mine])
    self.assertEqual((st, res['error']), (409, 'attachment_in_use'))

  def test_orphan_sweep_and_backup_restore(self):
    o = self.owner()
    a = self.agent(o, 'imgbackup')
    kept, orphan = self.upload(a), self.upload(a)
    self.assertEqual(a.call('POST', '/api/v1/messages', {'to': 'owner', 'attachment_ids': [kept['id']]})[0], 200)
    def path_for(image):
      return self.app.db.one('SELECT storage_relpath FROM attachments WHERE id=?', (image['id'],))[0]
    kept_path, old_path = path_for(kept), path_for(orphan)
    self.clock.advance(self.settings.orphan_attachment_ttl_sec + 1)
    self.app.sweep_once()
    self.assertFalse((self.settings.attachments_path / old_path).exists())
    replacement = self.upload(a)
    self.assertGreater(replacement['id'], orphan['id'])
    self.assertEqual(a.call('GET', orphan['url'])[0], 404)
    self.assertEqual(o.call('GET', kept['url']), (200, self.png))
    with tempfile.TemporaryDirectory() as d:
      snapshot, target = Path(d) / 'archive.sqlite', Path(d) / 'restored' / 'lyra.sqlite'
      info = backup.backup(self.settings.db_path, snapshot)
      self.assertEqual(backup.restore(snapshot, target)['rows'], info['rows'])
      self.assertEqual((target.parent / 'attachments' / kept_path).read_bytes(), self.png)


class StageOneTests(ServerCase):
  def api(self, client, method, path, body=None, expected=200):
    status, result = client.call(method, '/api/v1/' + path, body)
    self.assertEqual(status, expected, (method, path, result))
    return result

  def test_read_cursors_pins_and_member_identity(self):
    o = self.owner()
    a, b = (self.agent(o, h) for h in ('reader', 'observer'))
    icon = {'icon': 'star', 'color': '#aa00ff'}
    self.api(o, 'PATCH', f'admin/principals/{a.pid}', {'avatar': icon})
    self.api(o, 'POST', 'senate/consul', {'principal_id': a.pid})
    m = self.api(o, 'POST', 'messages', {'to': a.pid, 'body': 'first'})['message']
    self.assertEqual(m['recipient']['avatar'], icon)
    cid = m['conversation_id']
    first = m['id']
    second = self.api(o, 'POST', 'messages', {'to': a.pid, 'body': 'second'})['message']['id']
    other = self.api(b, 'POST', 'messages', {'to': 'owner', 'body': 'other'})['message']
    def conversation(client):
      return next(x for x in self.api(client, 'GET', 'conversations')['conversations'] if x['id'] == cid)
    self.assertEqual(conversation(a)['unread_count'], 2)
    self.assertEqual(conversation(o)['unread_count'], 0)
    member = next(m for m in conversation(a)['members'] if m['id'] == a.pid)
    self.assertEqual((member['role'], member['avatar']), ('consul', icon))
    read = f'conversations/{cid}/read'
    self.api(b, 'POST', read, {}, 403)
    self.api(a, 'POST', read, {'last_read_message_id': other['id']}, 422)
    self.assertEqual(self.api(a, 'POST', read, {'last_read_message_id': first})['last_read_message_id'], first)
    self.assertEqual(conversation(a)['unread_count'], 1)
    self.assertEqual(self.api(a, 'POST', read)['last_read_message_id'], second)
    self.assertEqual(self.api(a, 'POST', read, {'last_read_message_id': first})['last_read_message_id'], second)
    self.assertEqual(conversation(a)['unread_count'], 0)
    cursor = self.app.events.latest_id()
    pin = f'conversations/{cid}/pin'
    self.api(a, 'POST', pin, {}, 401)
    self.assertTrue(self.api(o, 'POST', pin)['pinned'])
    self.assertEqual(self.api(o, 'GET', 'conversations')['conversations'][0]['id'], cid)
    self.assertIsNotNone(conversation(o)['pinned_at'])
    self.assertEqual(self.api(o, 'DELETE', pin), {'pinned': False, 'pinned_at': None})
    self.assertEqual([e['type'] for e in self.app.events.since(cursor)], ['conversation', 'conversation'])
    team = self.api(a, 'POST', 'messages', {'to': b.pid, 'body': 'team'})['message']
    self.assertEqual(self.api(o, 'POST', f"conversations/{team['conversation_id']}/read")['last_read_message_id'], team['id'])

  def test_progress_permissions_clipping_acks_and_replies(self):
    o = self.owner()
    a, b = (self.agent(o, h) for h in ('worker', 'bystander'))
    m = self.api(o, 'POST', 'messages', {'to': a.pid, 'body': 'job'})['message']
    self.assertIsNone(m['progress'])
    mid = m['id']
    path = f'messages/{mid}/progress'
    def view():
      return self.app.message_view(mid)['progress']
    self.api(b, 'PUT', path, {'phase': 'done'}, 403)
    self.api(o, 'PUT', path, {'phase': 'done'}, 401)
    self.api(a, 'PUT', path, {'phase': 'bad'}, 422)
    self.api(a, 'PUT', path, {'phase': 'working', 'bullets': [{}]}, 422)
    self.api(a, 'PUT', path, {'phase': 'working', 'bullets': [{}] * 13}, 422)
    lease = self.claim(a)['lease_id']
    before = self.app.events.latest_id()
    ack = f'deliveries/{lease}/delivered'
    self.api(a, 'POST', ack)
    self.assertEqual(view()['phase'], 'thinking')
    result = self.api(a, 'PUT', path, {'phase': 'working', 'summary': 'x' * 280,
                      'bullets': [{'state': 'active', 'text': 'y' * 210}]})['progress']
    self.assertEqual(result, view())
    self.assertEqual((len(result['summary']), len(result['bullets'][0]['text'])), (240, 200))
    self.api(a, 'POST', ack)
    self.assertEqual(view()['phase'], 'working')
    self.api(a, 'POST', f'messages/{mid}/reply', {'body': 'finished'})
    self.assertIsNone(view())
    self.assertEqual([e['payload']['phase'] for e in self.app.events.since(before)
                      if e['type'] == 'message_progress'], ['thinking', 'working', 'done'])
    for text in ('update one', 'update two'):
      msg = self.api(o, 'POST', 'messages', {'to': a.pid, 'body': text})['message']
      self.api(a, 'PUT', f"messages/{msg['id']}/progress", {'phase': 'working'})
    self.api(a, 'POST', 'messages', {'to': 'owner', 'body': 'both finished'})
    self.assertIsNone(self.app.message_view(msg['id'])['progress'])
    late = self.claim(a)
    self.api(a, 'POST', f"deliveries/{late['lease_id']}/delivered")
    self.assertIsNone(self.app.message_view(late['message']['id'])['progress'])

  def test_peer_progress_is_isolated_and_ack_preserves_explicit_updates(self):
    owner = self.owner()
    a, b, c = (self.agent(owner, h) for h in ('peerask', 'peerwork', 'peerother'))
    def incoming(sender, body):
      return self.api(sender, 'POST', 'messages', {'to': b.pid, 'body': body})['message']['id']
    mid, separate = incoming(a, 'first'), incoming(c, 'independent')
    def progress(message, phase):
      return self.api(b, 'PUT', f'messages/{message}/progress', {'phase': phase})['progress']
    progress(mid, 'working')
    progress(separate, 'working')
    lease = self.claim(b)['lease_id']
    self.api(b, 'POST', f'deliveries/{lease}/delivered')
    self.assertEqual(self.app.message_view(mid)['progress']['phase'], 'working')
    self.api(b, 'POST', f'messages/{mid}/reply', {'body': 'answer'})
    self.assertIsNone(self.app.message_view(mid)['progress'])
    self.assertEqual(self.app.message_view(separate)['progress']['phase'], 'working')
    self.assertEqual(progress(separate, 'done')['phase'], 'done')
    self.assertIsNone(self.app.message_view(separate)['progress'])

  def test_pin_order_and_independent_readers(self):
    owner = self.owner()
    a, b = (self.agent(owner, h) for h in ('pinfirst', 'pinlast'))
    messages = [self.api(agent, 'POST', 'messages', {'to': 'owner', 'body': 'ping'})['message']
                for agent in (a, b)]
    first, second = (m['conversation_id'] for m in messages)
    pin = f'conversations/{first}/pin'
    at = self.api(owner, 'POST', pin)['pinned_at']
    self.clock.advance(1)
    self.api(owner, 'POST', f'conversations/{second}/pin')
    self.assertEqual(self.api(owner, 'POST', pin)['pinned_at'], at)
    convs = self.api(owner, 'GET', 'conversations')['conversations']
    self.assertEqual([c['id'] for c in convs[:2]], [second, first])
    self.api(owner, 'POST', f'conversations/{first}/read')
    own = self.api(a, 'GET', 'conversations')['conversations'][0]
    self.assertEqual(own['last_read_message_id'], 0)

  def test_host_aggregation_avatar_and_pool_metadata(self):
    o = self.owner()
    a, b = (self.agent(o, h) for h in ('hosta', 'hostb'))
    board = lambda: self.api(o, 'GET', 'board')
    ownerid = board()['owner']['id']
    self.api(o, 'PATCH', f'admin/principals/{ownerid}', {'avatar': 'sun'})
    self.assertEqual(board()['owner']['avatar'], 'sun')
    mates = self.api(a, 'GET', 'teammates')['teammates']
    self.assertEqual(next(m for m in mates if m['handle'] == 'owner')['avatar'], 'sun')
    for bad in ({'icon': '<image>'}, {'color': 'url(bad)'}, 'x' * 129):
      self.api(o, 'PATCH', f'admin/principals/{a.pid}', {'avatar': bad}, 422)
    metadata = {'os': 'Linux', 'cpu_count': 8, 'arch': 'arm64', 'ip': '127.0.0.1', 'mem_used_pct': 21.1,
                'uptime_sec': 100, 'mem_used_gb': -1, 'junk': 100}
    self.checkin(a, host='shared', host_metrics=metadata)
    before = self.app.events.latest_id()
    self.checkin(a, host='shared', host_metrics={**metadata, 'mem_used_pct': 22, 'uptime_sec': 115})
    self.assertEqual(self.app.events.latest_id(), before)
    self.clock.advance(1)
    self.checkin(b, host='shared', host_metrics={**metadata, 'mem_used_pct': 35})
    hosts = {h['host']: h for h in board()['hosts']}
    host = hosts['shared']
    self.assertEqual((set(host['agent_ids']), host['online_count'], host['last_seen_at']), ({a.pid, b.pid}, 2, self.clock()))
    self.assertEqual(host['metrics']['mem_used_pct'], 35)
    self.assertNotIn('mem_used_gb', host['metrics'])
    self.assertNotIn('junk', host['metrics'])
    before = self.app.events.latest_id()
    self.checkin(b, host='shared', host_metrics={**metadata, 'mem_used_pct': 55})
    self.assertEqual(self.app.events.since(before)[0]['type'], 'presence')
    pid = self.api(o, 'POST', 'admin/pools', {'provider': 'vendor', 'label': 'team', 'account_label': 'Office',
                   'subscription': 'Business', 'notes': 'shared'})['id']
    self.api(o, 'PATCH', f'admin/principals/{a.pid}', {'pool_id': pid})
    self.api(o, 'PATCH', f'admin/pools/{pid}', {'reporter_principal_id': a.pid, 'notes': 'new note'})
    self.checkin(a, usage={'metrics': [{'name': 'weekly', 'used_pct': 10}]})
    pool = next(p for p in board()['pools'] if p['id'] == pid)
    usage = self.api(o, 'GET', 'usage')['providers']
    self.assertEqual(pool, next(p for group in usage for p in group['pools'] if p['id'] == pid))
    self.assertEqual((pool['reporter']['id'], pool['stale'], pool['account_label'], pool['subscription'], pool['notes']),
                     (a.pid, False, 'Office', 'Business', 'new note'))
    self.assertEqual(pool['usage']['metrics'][0]['used_pct'], 10)
    self.assertEqual(pool['reported_at'], self.clock())

  def test_project_roles_tasks_and_membership(self):
    o = self.owner()
    pm, a, b, outside, consul = (self.agent(o, h) for h in ('pmp', 'membera', 'memberb', 'outsidep', 'consulp'))
    self.api(o, 'POST', 'senate/consul', {'principal_id': consul.pid})
    payload = {'name': 'Stage One', 'pm_principal_id': pm.pid, 'member_ids': [a.pid, b.pid]}
    self.api(a, 'POST', 'projects', payload, 403)
    project = self.api(consul, 'POST', 'projects', payload)['project']
    pid = project['id']
    path = f'projects/{pid}'
    tasks = path + '/tasks'
    self.assertEqual((project['pm']['id'], project['slug']), (pm.pid, 'stage-one'))
    self.assertEqual(next(m for m in project['members'] if m['id'] == pm.pid)['project_role'], 'pm')
    self.api(o, 'POST', 'projects', payload, 409)
    self.api(outside, 'PATCH', path, {'name': 'no'}, 403)
    self.api(pm, 'PATCH', path, {'status': 'invalid'}, 422)
    self.api(pm, 'PATCH', path, {'status': 'paused', 'description': 'review'})
    self.api(consul, 'PATCH', path, {'status': 'active'})
    self.api(a, 'PATCH', path, {'name': 'no'}, 403)
    self.api(outside, 'POST', tasks, {'title': 'no', 'assignee_ids': [a.pid]}, 403)
    for ids in ([], [outside.pid], ['2']):
      self.assertEqual(self.api(pm, 'POST', tasks, {'title': 'bad', 'assignee_ids': ids}, 422)['error'], 'bad_assignees')
    t = self.api(a, 'POST', tasks, {'title': 'Write', 'assignee_ids': [b.pid], 'priority': 2})['task']
    task = f"tasks/{t['id']}"
    self.api(a, 'PATCH', task, {'title': 'no'}, 403)
    self.api(outside, 'PATCH', task, {'status': 'done'}, 403)
    self.api(b, 'PATCH', task, {'status': 'blocked'})
    for data in ({'assignee_ids': []}, {'assignee_ids': [outside.pid]}, {'status': 'unknown'}, {'priority': True}):
      self.api(pm, 'PATCH', task, data, 422)
    fail = self.api(pm, 'PATCH', path, {'name': 'rolled back', 'member_ids': [a.pid]}, 409)
    self.assertEqual(fail['error'], 'member_has_sole_task')
    self.api(consul, 'PATCH', task, {'assignee_ids': [a.pid, b.pid]})
    self.api(o, 'PATCH', path, {'member_ids': []}, 409)
    revised = self.api(pm, 'PATCH', path, {'member_ids': [a.pid]})['project']
    self.assertEqual(revised['name'], 'Stage One')
    self.assertEqual([p['id'] for p in revised['tasks'][0]['assignees']], [a.pid])
    self.api(a, 'PATCH', task, {'status': 'done', 'title': 'Written'})
    self.api(o, 'PATCH', path, {'pm_principal_id': b.pid, 'member_ids': []})
    self.api(pm, 'PATCH', path, {'name': 'former manager'}, 403)
    self.api(b, 'PATCH', task, {'status': 'open'}, 422)
    self.api(b, 'PATCH', task, {'status': 'open', 'assignee_ids': [b.pid]})
    view = next(p for p in self.api(outside, 'GET', 'projects')['projects'] if p['id'] == pid)
    self.assertEqual(view['pm']['id'], b.pid)
    self.assertEqual(view, next(p for p in self.api(o, 'GET', 'board')['projects'] if p['id'] == pid))

  def test_vendor_files_and_invalid_names(self):
    for name, mime in [('katex.min.css', 'text/css'), ('fonts/KaTeX_Main-Regular.woff2', 'font/woff2')]:
      with urllib.request.urlopen(self.base + '/static/vendor/katex/' + name) as response:
        self.assertEqual(response.headers.get_content_type(), mime)
        self.assertEqual(response.read(), (ROOT / 'lyra_server/static/vendor/katex' / name).read_bytes())
    for name in ('', '/app.js', 'vendor//katex', '.private', 'vendor/%2e%2e/app.js', 'vendor%5ckatex'):
      with self.assertRaises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(self.base + '/static/' + name)
      self.assertEqual(caught.exception.code, 404)

  def test_v4_backup_and_restore(self):
    o = self.owner()
    a = self.agent(o, 'snapshot')
    m = self.api(o, 'POST', 'messages', {'body': 'snapshot', 'to': a.pid})['message']
    self.api(a, 'POST', f"conversations/{m['conversation_id']}/read")
    self.api(a, 'PUT', f"messages/{m['id']}/progress", {'phase': 'working', 'summary': 'saved'})
    proj = self.api(o, 'POST', 'projects', {'name': 'Snapshot', 'member_ids': [a.pid]})['project']
    self.api(a, 'POST', f"projects/{proj['id']}/tasks", {'title': 'back up', 'assignee_ids': [a.pid]})
    with tempfile.TemporaryDirectory() as d:
      snap, restored = Path(d) / 'backup.sqlite', Path(d) / 'restore' / 'lyra.sqlite'
      rows = backup.backup(self.settings.db_path, out=snap)['rows']
      self.assertEqual(backup.restore(snap, restored)['rows'], rows)
      for table in ('conversation_reads', 'message_progress', 'projects', 'project_members', 'tasks', 'task_assignees'):
        self.assertGreater(rows[table], 0, table)
      conn = sqlite3.connect(str(restored))
      try:
        self.assertEqual(conn.execute('SELECT summary FROM message_progress WHERE message_id=?', (m['id'],)).fetchone()[0], 'saved')
      finally:
        conn.close()


class DeliveryTests(ServerCase):

  def test_jump_goes_first_and_queue_only_rejects_jump(self):
    o = self.owner()
    j = self.agent(o, 'jumper', modes=('queue', 'jump'))
    q = self.agent(o, 'queuer', modes=('queue',))
    m1 = o.call('POST', '/api/v1/messages', {'to': j.pid, 'body': 'M1', 'mode': 'queue'})[1]['message']
    self.clock.advance(1)
    m2 = o.call('POST', '/api/v1/messages', {'to': j.pid, 'body': 'M2', 'mode': 'jump'})[1]['message']
    self.assertEqual((m1['queue_position'], m2['queue_position']), (1, 1))
    first = self.claim(j)
    self.assertEqual(first['message']['body'], 'M2')
    j.call('POST', f"/api/v1/deliveries/{first['lease_id']}/delivered", {})
    self.assertEqual(self.claim(j)['message']['body'], 'M1')
    st, body = o.call('POST', '/api/v1/messages', {'to': q.pid, 'body': 'x', 'mode': 'jump'})
    self.assertEqual((st, body['error'], body['supported']), (422, 'mode_unsupported', ['queue']))

  def test_runtime_mode_downgrade(self):
    o = self.owner()
    a = self.agent(o, 'downgrade', modes=('queue', 'jump'))
    self.assertEqual(o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'ok', 'mode': 'jump'})[0], 200)
    self.checkin(a, modes=('queue',))
    self.assertEqual(o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'no', 'mode': 'jump'})[0], 422)

  def test_lease_expiry_requeues_and_stale_lease_conflicts(self):
    o = self.owner()
    a = self.agent(o, 'leasy')
    o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'lease me'})
    first = self.claim(a)
    self.assertIsNone(self.claim(a)['message'])  # leased, not visible
    self.clock.advance(self.settings.lease_sec + 1)
    second = self.claim(a)
    self.assertEqual(second['attempt'], 2)
    st, body = a.call('POST', f"/api/v1/deliveries/{first['lease_id']}/delivered", {})
    self.assertEqual((st, body['error']), (409, 'stale_lease'))
    self.assertEqual(a.call('POST', f"/api/v1/deliveries/{second['lease_id']}/delivered", {})[0], 200)

  def test_late_ack_after_lapse_reconciles(self):
    o = self.owner()
    a = self.agent(o, 'lateack')
    o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'handed then crashed'})
    got = self.claim(a)
    self.clock.advance(self.settings.lease_sec + 5)  # connector restarts after the lease lapsed
    st, r = a.call('POST', f"/api/v1/deliveries/{got['lease_id']}/delivered", {})
    self.assertEqual((st, r['state']), (200, 'delivered'))
    self.assertIsNone(self.claim(a)['message'])  # never handed out twice

  def test_unconfirmed_then_owner_retry(self):
    o = self.owner()
    a = self.agent(o, 'unsure')
    sent = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'maybe'})[1]['message']
    got = self.claim(a)
    a.call('POST', f"/api/v1/deliveries/{got['lease_id']}/unconfirmed", {'reason': 'stream died mid-handoff'})
    self.assertIsNone(self.claim(a)['message'])  # never retried automatically
    st, msgs = o.call('GET', f"/api/v1/conversations/{sent['conversation_id']}/messages")
    self.assertEqual(msgs['messages'][0]['state'], 'unconfirmed')
    self.assertEqual(o.call('POST', f"/api/v1/admin/messages/{sent['id']}/retry", {})[0], 200)
    again = self.claim(a)
    self.assertTrue(again['message']['retry'])
    self.assertEqual(again['message']['id'], sent['id'])

  def test_ttl_expiry_fails_after_24h(self):
    o = self.owner()
    a = self.agent(o, 'sleepy')
    sent = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'too late'})[1]['message']
    self.clock.advance(86400 + 1)
    self.app.sweep_once()
    o = self.owner()
    st, msgs = o.call('GET', f"/api/v1/conversations/{sent['conversation_id']}/messages")
    self.assertEqual(msgs['messages'][0]['state'], 'failed')
    self.assertIn('24 hours', msgs['messages'][0]['state_reason'])

  def test_attempts_exhausted(self):
    o = self.owner()
    a = self.agent(o, 'flaky')
    sent = o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'retry me'})[1]['message']
    for _ in range(self.settings.max_attempts):
      self.assertIsNotNone(self.claim(a)['message'])
      self.clock.advance(self.settings.lease_sec + 1)
    self.assertIsNone(self.claim(a)['message'])
    st, msgs = o.call('GET', f"/api/v1/conversations/{sent['conversation_id']}/messages")
    self.assertEqual(msgs['messages'][0]['state_reason'], 'delivery attempts exhausted')

  def test_long_poll_wakes_on_new_message(self):
    o = self.owner()
    a = self.agent(o, 'poller')
    out = {}

    def waiter():
      out['r'] = a.call('POST', '/api/v1/deliveries/claim?wait=10')
    t = threading.Thread(target=waiter)
    started = time.monotonic()
    t.start()
    time.sleep(0.4)
    o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'wake up'})
    t.join(10)
    self.assertLess(time.monotonic() - started, 5)
    self.assertEqual(out['r'][1]['message']['body'], 'wake up')


# =============================================================================
# Usage pools (D7)
# =============================================================================

class PoolTests(ServerCase):

  def test_one_entry_per_pool_and_single_reporter(self):
    o = self.owner()
    st, p1 = o.call('POST', '/api/v1/admin/pools', {'provider': 'anthropic', 'label': 'Account A'})
    st, p2 = o.call('POST', '/api/v1/admin/pools', {'provider': 'anthropic', 'label': 'Account B'})
    a = self.agent(o, 'rep', pool_id=p1['id'])
    b = self.agent(o, 'mate', pool_id=p1['id'])
    c = self.agent(o, 'other', pool_id=p2['id'])
    self.assertEqual(o.call('PATCH', f"/api/v1/admin/pools/{p1['id']}",
                            {'reporter_principal_id': a.pid})[0], 200)
    usage = {'metrics': [{'name': '5-hour window', 'used_pct': 30, 'resets_at': '2026-11-27T18:00:00Z'}]}
    self.assertTrue(self.checkin(a, usage=usage)['accepted_usage'])
    self.assertFalse(self.checkin(b, usage={'metrics': [{'name': 'x', 'used_pct': 99}]})['accepted_usage'])
    self.assertFalse(self.checkin(c, usage=usage)['accepted_usage'])  # p2 has no reporter
    st, u = o.call('GET', '/api/v1/usage')
    self.assertEqual(len(u['providers']), 1)
    pools = {p['label']: p for p in u['providers'][0]['pools']}
    self.assertEqual(set(pools), {'Account A', 'Account B'})  # separate under one provider
    self.assertEqual(pools['Account A']['usage']['metrics'][0]['used_pct'], 30.0)
    self.assertEqual({m['display_name'] for m in pools['Account A']['members']}, {'Rep', 'Mate'})
    self.assertIsNone(pools['Account B']['usage'])
    self.assertEqual(o.call('PATCH', f"/api/v1/admin/pools/{p1['id']}",
                            {'reporter_principal_id': c.pid})[0], 422)  # not a member


# =============================================================================
# SSE replay and backup/restore (D1)
# =============================================================================

class SseAndBackupTests(ServerCase):

  def test_sse_replays_from_last_event_id(self):
    o = self.owner()
    start = self.app.events.latest_id()
    a = self.agent(o, 'sse')
    o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': 'evt'})
    req = urllib.request.Request(f'{self.base}/api/v1/events', headers={'Last-Event-ID': str(start)})
    with o.opener.open(req, timeout=10) as r:
      self.assertEqual(r.headers['Content-Type'].split(';')[0], 'text/event-stream')
      seen = b''
      deadline = time.monotonic() + 5
      while b'event: message' not in seen and time.monotonic() < deadline:
        seen += r.read1(4096)
    self.assertIn(b'event: principal', seen)
    self.assertIn(b'event: message', seen)

  def test_backup_while_writing_then_restore(self):
    o = self.owner()
    a = self.agent(o, 'bak')
    stop = threading.Event()

    def writer():
      i = 0
      while not stop.is_set():
        o.call('POST', '/api/v1/messages', {'to': a.pid, 'body': f'w{i}'})
        i += 1
    t = threading.Thread(target=writer)
    t.start()
    time.sleep(0.3)
    out = Path(tmpdir()) / 'snap.sqlite'
    info = backup.backup(self.settings.db_path, out=str(out))
    stop.set()
    t.join()
    self.assertEqual(info['integrity'], 'ok')
    target = Path(tmpdir()) / 'restored' / 'lyra.sqlite'
    res = backup.restore(out, target)
    self.assertEqual(res['rows'], info['rows'])
    self.assertGreater(res['rows']['messages'], 0)
    with self.assertRaises(FileExistsError):
      backup.restore(out, target)


  def test_composer_ctrl_enter_shortcut_present(self):
    with urllib.request.urlopen(f'{self.base}/') as resp:
      html = resp.read().decode('utf-8')
    self.assertIn('placeholder="Write a message (Ctrl+Enter to send)"', html)
    self.assertIn('id="compose-send"', html)
    with urllib.request.urlopen(f'{self.base}/static/app.js') as resp:
      js = resp.read().decode('utf-8')
    self.assertIn("addEventListener('keydown'", js)
    self.assertIn('ev.isComposing', js)
    self.assertIn('requestSubmit()', js)
    self.assertIn('/api/v1/senate/consul', js)


# =============================================================================
# Senate and single-Consul authority
# =============================================================================

class SenateAndConsulTests(ServerCase):

  def test_senate_tab_placed_right_of_admin(self):
    with urllib.request.urlopen(f'{self.base}/') as resp:
      html = resp.read().decode('utf-8')
    admin_pos = html.find('data-tab="admin"')
    senate_pos = html.find('data-tab="senate"')
    self.assertGreater(admin_pos, 0)
    self.assertGreater(senate_pos, admin_pos)
    self.assertIn('Appoint Consul', html)
    self.assertIn('Dismiss Consul', html)

  def test_single_consul_lifecycle_and_invite_authority(self):
    o = self.owner()
    a = self.agent(o, 'gem')
    b = self.agent(o, 'dario')

    # 1. Initially no Consul; non-Consul cannot issue Consul invites; agents cannot appoint.
    st, sen = o.call('GET', '/api/v1/senate')
    self.assertEqual((st, sen['consul']), (200, None))
    st, r = a.call('POST', '/api/v1/consul/invites', {'handle': 'boris', 'reason': 'onboard'})
    self.assertEqual((st, r['error']), (403, 'consul_required'))
    st, _ = a.call('POST', '/api/v1/senate/consul', {'principal_id': a.pid})
    self.assertEqual(st, 401)

    # 2. Owner appoints A as Consul.
    st, ap = o.call('POST', '/api/v1/senate/consul', {'principal_id': a.pid})
    self.assertEqual(st, 200)
    self.assertEqual((ap['consul']['id'], ap['consul']['role']), (a.pid, 'consul'))
    st, me = a.call('GET', '/api/v1/me')
    self.assertEqual((st, me['principal']['role']), (200, 'consul'))
    st, mates = b.call('GET', '/api/v1/teammates')
    self.assertEqual(next(t for t in mates['teammates'] if t['handle'] == 'gem')['role'], 'consul')

    # 3. Consul invite requires a reason and forbids re-admitting revoked agents directly.
    st, r = a.call('POST', '/api/v1/consul/invites', {'handle': 'boris'})
    self.assertEqual((st, r['error']), (422, 'reason_required'))
    st, r = a.call('POST', '/api/v1/consul/invites',
                   {'target_principal_id': 99, 'reason': 're-admit'})
    self.assertEqual((st, r['error']), (403, 'owner_required'))

    # 4. Consul issues an invite with valid justification; new agent redeems it.
    st, inv = a.call('POST', '/api/v1/consul/invites', {
      'handle': 'boris',
      'display_name': 'Boris',
      'reason': 'Requested by @dario for parallel MiniMAC coding duties',
    })
    self.assertEqual(st, 200, inv)
    self.assertEqual(inv['invite']['issued_by']['handle'], 'gem')
    self.assertIn('parallel MiniMAC', inv['invite']['reason'])
    st, mine = a.call('GET', '/api/v1/consul/invites')
    self.assertEqual((st, len(mine['invites'])), (200, 1))

    c = Client(self.base, origin=False)
    st, joined = c.call('POST', '/api/v1/join', {
      'invite_code': inv['code'], 'client_key': 'boris-client-key-123456', 'handle': 'boris',
    })
    self.assertEqual(st, 200, joined)
    st, board = o.call('GET', '/api/v1/board')
    self.assertEqual(board['consul']['handle'], 'gem')
    self.assertEqual(len(board['senate_invites']), 1)
    self.assertEqual(board['senate_invites'][0]['state'], 'redeemed')

    # 5. Appointing B atomically replaces A as sole Consul.
    st, ap2 = o.call('POST', '/api/v1/senate/consul', {'principal_id': b.pid})
    self.assertEqual((st, ap2['consul']['handle']), (200, 'dario'))
    st, r = a.call('POST', '/api/v1/consul/invites', {'handle': 'kimi', 'reason': 'late request'})
    self.assertEqual((st, r['error']), (403, 'consul_required'))
    st, b_ok = b.call('POST', '/api/v1/consul/invites', {'handle': 'kimi', 'reason': 'valid need'})
    self.assertEqual(st, 200, b_ok)

    # 6. Revoking Consul clears role; appointing dismissed works cleanly.
    self.assertEqual(o.call('POST', f'/api/v1/admin/principals/{b.pid}/revoke', {})[0], 200)
    self.assertIsNone(o.call('GET', '/api/v1/senate')[1]['consul'])
    self.assertEqual(o.call('POST', '/api/v1/senate/consul', {'principal_id': a.pid})[0], 200)
    st, dis = o.call('DELETE', '/api/v1/senate/consul')
    self.assertEqual((st, dis['consul']), (200, None))
    self.assertEqual(a.call('POST', '/api/v1/consul/invites',
                            {'handle': 'x1', 'reason': 'after dismissal'})[0], 403)

  def test_schema_v1_to_v4(self):
    self.check_migration(1)

  def test_schema_v2_to_v4(self):
    self.check_migration(2)

  def test_schema_v3_to_v4(self):
    self.check_migration(3)

  def check_migration(self, version):
    from lyra_server.db import Database, SCHEMA_VERSION
    d = tmpdir()
    db_path = Path(d) / f'v{version}.sqlite'
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin',
        status TEXT NOT NULL DEFAULT 'active', principal_id INTEGER NOT NULL, created_at REAL NOT NULL);
      CREATE TABLE web_sessions (id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
        persistent INTEGER NOT NULL, created_at REAL NOT NULL, last_seen_at REAL NOT NULL,
        expires_at REAL NOT NULL);
      CREATE TABLE pools (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL,
        reporter_principal_id INTEGER, usage TEXT, reported_at REAL, created_at REAL NOT NULL);
      CREATE TABLE principals (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, handle TEXT,
        display_name TEXT NOT NULL, address TEXT, status TEXT NOT NULL, pool_id INTEGER,
        created_at REAL NOT NULL, admitted_at REAL, revoked_at REAL);
      CREATE TABLE credentials (id INTEGER PRIMARY KEY, principal_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, invite_id INTEGER, status TEXT NOT NULL,
        created_at REAL NOT NULL, revoked_at REAL);
      CREATE TABLE invites (id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
        display_name TEXT, handle TEXT, pool_id INTEGER, target_principal_id INTEGER,
        created_at REAL NOT NULL, expires_at REAL NOT NULL, redeemed_at REAL,
        redeemed_principal_id INTEGER, client_key_hash TEXT, cancelled_at REAL);
      CREATE TABLE presence (principal_id INTEGER PRIMARY KEY, instance_id TEXT, host TEXT,
        provider TEXT, runtime TEXT, connector TEXT, modes TEXT, status TEXT,
        last_checkin_at REAL, online INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE conversations (id INTEGER PRIMARY KEY, kind TEXT NOT NULL,
        dm_pair_key TEXT NOT NULL UNIQUE, created_at REAL NOT NULL);
      CREATE TABLE conversation_members (conversation_id INTEGER NOT NULL,
        principal_id INTEGER NOT NULL, PRIMARY KEY (conversation_id, principal_id));
      CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL, body TEXT NOT NULL,
        reply_to_id INTEGER, mode TEXT NOT NULL, priority INTEGER NOT NULL,
        state TEXT NOT NULL, state_reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        retry INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until REAL,
        client_msg_id TEXT, created_at REAL NOT NULL, delivered_at REAL, failed_at REAL);
      CREATE TABLE delivery_attempts (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL,
        lease_id TEXT NOT NULL UNIQUE, claimed_at REAL NOT NULL, lease_until REAL NOT NULL,
        outcome TEXT, outcome_at REAL);
      CREATE TABLE reactions (message_id INTEGER NOT NULL, reactor_id INTEGER NOT NULL,
        emoji TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (message_id, reactor_id, emoji));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      INSERT INTO principals(id, kind, handle, display_name, status, created_at, admitted_at)
        VALUES (1, 'owner', 'owner', 'William', 'admitted', 1.0, 1.0),
               (2, 'agent', 'gem', 'Gem', 'admitted', 1.0, 1.0);
    """)
    conn.executescript("""
      INSERT INTO presence(principal_id, host, online) VALUES (2, 'original', 1);
      INSERT INTO conversations VALUES (7, 'owner_agent', '1:2', 1.0);
      INSERT INTO messages(id, conversation_id, sender_id, recipient_id, body, mode, priority, state, created_at)
        VALUES (12, 7, 1, 2, 'original message', 'queue', 0, 'delivered', 2.0);
    """)
    if version >= 2:
      conn.executescript("""
        ALTER TABLE principals ADD COLUMN role TEXT;
        CREATE UNIQUE INDEX uq_principal_consul ON principals(role) WHERE role='consul';
        ALTER TABLE invites ADD COLUMN issued_by_principal_id INTEGER;
        ALTER TABLE invites ADD COLUMN reason TEXT;
      """)
    if version == 3:
      conn.executescript("""
        ALTER TABLE presence ADD COLUMN capabilities TEXT;
        UPDATE presence SET capabilities='{"images":true}';
        CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, uploader_id INTEGER NOT NULL,
          sha256 TEXT NOT NULL, mime_type TEXT NOT NULL, filename TEXT NOT NULL, size_bytes INTEGER NOT NULL,
          storage_relpath TEXT NOT NULL UNIQUE, created_at REAL NOT NULL);
        CREATE TABLE message_attachments (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL UNIQUE,
          position INTEGER NOT NULL, PRIMARY KEY(message_id,attachment_id));
        INSERT INTO attachments VALUES (9,1,'digest','image/png','a.png',12,'aa/image.png',1);
        INSERT INTO message_attachments VALUES(12,9,0);
      """)
    conn.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(version),))
    conn.commit()
    conn.close()

    db = Database(db_path)
    try:
      ver = db.one("SELECT value FROM meta WHERE key='schema_version'")[0]
      self.assertEqual(int(ver), 4)
      self.assertEqual(SCHEMA_VERSION, 4)
      self.assertIn('capabilities', [r['name'] for r in db.all('PRAGMA table_info(presence)')])
      self.assertEqual(db.one('SELECT host FROM presence')[0], 'original')
      self.assertEqual(db.one('SELECT body FROM messages WHERE id=12')[0], 'original message')
      self.assertEqual(tuple(db.one('SELECT pinned,pinned_at FROM conversations')), (0, None))
      for table in ('conversation_reads', 'message_progress', 'projects', 'project_members', 'tasks', 'task_assignees'):
        self.assertEqual(db.all(f'SELECT * FROM {table}'), [])
      if version == 3:
        self.assertEqual(tuple(db.one('SELECT * FROM message_attachments')), (12, 9, 0))
        self.assertTrue(json.loads(db.one('SELECT capabilities FROM presence')[0])['images'])
      else:
        self.assertEqual(db.all('SELECT * FROM message_attachments'), [])
      gem = db.one("SELECT handle, role FROM principals WHERE id=2")
      self.assertEqual((gem['handle'], gem['role']), ('gem', None))
      with db.tx() as c:
        c.execute("UPDATE principals SET role='consul' WHERE id=2")
        c.execute("INSERT INTO invites(code_hash, handle, created_at, expires_at, issued_by_principal_id, reason) "
                  "VALUES ('h1', 'boris', 1.0, 99.0, 2, 'migrated test')")
      with self.assertRaises(sqlite3.IntegrityError):
        with db.tx() as c:
          c.execute("UPDATE principals SET role='consul' WHERE id=1")
    finally:
      db.close()
      shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
  unittest.main()
