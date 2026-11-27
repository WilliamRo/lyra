# =============================================================================
# test_server.py: HTTP-level tests for lyra-server (stdlib unittest).
# Run: python3 -B -m unittest discover -s server/tests -t server
# =============================================================================

import http.cookiejar
import json
import os
from pathlib import Path
import shutil
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
    data = json.dumps(body).encode() if body is not None else None
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
        return r.status, json.loads(r.read() or b'{}')
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
    p.write_text(f'port = 9001\ndata_dir = "{d}"\nmessage_ttl_sec = 120\n')
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
    js = (ROOT / 'lyra_server' / 'static' / 'app.js').read_text()
    for sink in ('innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval('):
      self.assertNotIn(sink, js, msg=f'unsafe sink {sink} in app.js')
    self.assertIn("(https:\\/\\/", js, msg='links must be restricted to https')


# =============================================================================
# Delivery modes, leases, failures (brief s4, D4, walkthrough iv)
# =============================================================================

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


if __name__ == '__main__':
  unittest.main()
