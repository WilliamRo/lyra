# =============================================================================
# qa_board.py: End-to-end QA harness for the wired v2 board (tests only).
#   SeededBoard  - a real lyra-server on loopback with realistic v4 data, seeded
#                  only through the public HTTP API (owner cookie, agent tokens)
#   QAProxy      - a test-only reverse proxy in front of it that signs the
#                  browser in (cookie + Origin), injects /__qa/probe.js into "/"
#                  when ?qa=probe, and can drop live SSE streams (/__qa/drop-sse)
#                  to exercise the reconnect banner
# Nothing here ships: it lives under server/tests and the server is unchanged.
# =============================================================================

import base64
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
SERVER = HERE.parents[1]
sys.path.insert(0, str(SERVER))

from lyra_server import config  # noqa: E402
from lyra_server.core import Lyra  # noqa: E402
from lyra_server.web import LyraHTTPServer  # noqa: E402

PASSWORD = 'correct horse battery'
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def png_bytes(w=320, h=180):
  """Small gradient PNG built with zlib only."""
  rows = []
  for y in range(h):
    row = bytearray([0])
    for x in range(w):
      row += bytes((45 + x * 150 // w, 91 + y * 100 // h, 210 - x * 80 // w))
    rows.append(bytes(row))
  raw = b''.join(rows)

  def chunk(tag, data):
    c = tag + data
    return len(data).to_bytes(4, 'big') + c + zlib.crc32(c).to_bytes(4, 'big')
  ihdr = w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + bytes([8, 2, 0, 0, 0])
  return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


class Http:
  def __init__(self, base, token=None, cookie=None):
    self.base = base
    self.token = token
    self.cookie = cookie

  def call(self, method, path, body=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(self.base + path, data=data, method=method)
    if raw is None:
      req.add_header('Content-Type', 'application/json')
    req.add_header('Origin', self.base)
    if self.token:
      req.add_header('Authorization', 'Bearer ' + self.token)
    if self.cookie:
      req.add_header('Cookie', self.cookie)
    for k, v in (headers or {}).items():
      req.add_header(k, v)
    try:
      with NO_PROXY.open(req, timeout=30) as r:
        cookie = r.headers.get('Set-Cookie')
        if cookie and not self.cookie:
          self.cookie = cookie.split(';', 1)[0]
        return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
      raise AssertionError(f'{method} {path} -> {e.code} {e.read()[:300]!r}') from None


class SeededBoard:
  """A live server plus seed data that exercises every board feature."""

  def __init__(self):
    self.dir = tempfile.mkdtemp(prefix='lyra-qa-', dir=os.environ.get('LYRA_TEST_TMP'))
    env = {'LYRA_DATA_DIR': self.dir, 'LYRA_PORT': '0'}
    self.settings = config.validate(config.load(env=env))
    self.app = Lyra(self.settings)
    self.app.init_admin('owner', PASSWORD, display_name='Owner')
    self.httpd = LyraHTTPServer(self.app)
    self.settings.port = self.httpd.server_address[1]
    self.base = f'http://127.0.0.1:{self.settings.port}'
    self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': 0.2}, daemon=True)
    self.thread.start()
    self.app.start(interval=1.0)
    self.owner = Http(self.base)
    self.owner.call('POST', '/api/v1/auth/login', {'username': 'owner', 'password': PASSWORD, 'remember': True})
    self.agents = {}
    self.ids = {}
    self.live = {}
    self._stop = threading.Event()
    threading.Thread(target=self._keepalive, daemon=True).start()

  def _keepalive(self):
    while not self._stop.wait(10):
      for handle, kw in list(self.live.items()):
        try:
          self.checkin(handle, **kw)
        except AssertionError:
          pass

  def close(self):
    self._stop.set()
    self.app.stop()
    self.httpd.shutdown()
    self.httpd.server_close()
    self.app.db.close()
    shutil.rmtree(self.dir, ignore_errors=True)

  # --- seeding helpers -------------------------------------------------------

  def join(self, handle, name, host, provider, pool=None, images=False, metrics=None, status=None, usage=None,
           checkin=True):
    inv = self.owner.call('POST', '/api/v1/admin/invites', {'display_name': name, 'handle': handle, 'pool_id': pool})
    a = Http(self.base)
    j = a.call('POST', '/api/v1/join', {
      'invite_code': inv['code'], 'client_key': f'qa-{handle}-client-key-0123', 'handle': handle,
      'host': host, 'provider': provider, 'runtime': 'claude-code', 'connector': 'lyra-link',
      'address': f'{provider}://{host}/{handle}', 'modes': ['queue', 'jump'],
      'capabilities': {'images': images}})
    a.token = j['token']
    a.pid = j['principal']['id']
    a.handle = handle
    self.agents[handle] = a
    self.ids[handle] = a.pid
    if checkin:
      self.checkin(handle, metrics=metrics, status=status, usage=usage, images=images)
    return a

  def checkin(self, handle, metrics=None, status=None, usage=None, images=False, host=None):
    a = self.agents[handle]
    body = {'instance_id': f'qa-{handle}', 'modes': ['queue', 'jump'], 'capabilities': {'images': images},
            'status': status or {}, 'host_metrics': metrics or {}}
    if host:
      body['host'] = host
    if usage:
      body['usage'] = usage
    self.live[handle] = {'metrics': metrics, 'status': status, 'usage': usage, 'images': images, 'host': host}
    return a.call('POST', '/api/v1/checkin', body)

  def deliver(self, handle):
    a = self.agents[handle]
    got = a.call('POST', '/api/v1/deliveries/claim?wait=0')
    if got.get('message'):
      a.call('POST', f"/api/v1/deliveries/{got['lease_id']}/delivered", {})
    return got.get('message')

  def seed(self):
    o = self.owner
    pa = o.call('POST', '/api/v1/admin/pools', {'provider': 'anthropic', 'label': 'Claude Max', 'account_label': 'Lab workspace',
                                               'subscription': 'Max', 'notes': 'Shared by the research group'})['id']
    pb = o.call('POST', '/api/v1/admin/pools', {'provider': 'anthropic', 'label': 'Claude Pro', 'account_label': 'Personal',
                                               'subscription': 'Pro'})['id']
    pc = o.call('POST', '/api/v1/admin/pools', {'provider': 'openai', 'label': 'Codex team', 'subscription': 'Team'})['id']
    # A long label repeated as account and plan (owner screenshot #131): shown once, never overflowing.
    pg = o.call('POST', '/api/v1/admin/pools', {'provider': 'google', 'label': 'Google AI Ultra (MiniMAC)',
                                               'account_label': 'Google AI Ultra (MiniMAC)',
                                               'subscription': 'Google AI Ultra (MiniMAC)'})['id']
    pk = o.call('POST', '/api/v1/admin/pools', {'provider': 'moonshot', 'label': 'Kimi Coding', 'account_label': 'Moonshot console',
                                               'subscription': 'Allegretto'})['id']
    t0 = time.time()
    mac = {'os': 'macOS 26.2', 'arch': 'arm64', 'ip': '192.168.0.108', 'cpu_count': 10, 'mem_total_gb': 32,
           'mem_used_gb': 18.4, 'mem_used_pct': 57.5, 'disk_total_gb': 1800, 'disk_free_gb': 412, 'disk_used_pct': 77.1,
           'uptime_sec': 432100}
    lin = {'os': 'Ubuntu 24.04', 'arch': 'x86_64', 'ip': '10.0.0.21', 'cpu_count': 32, 'mem_total_gb': 128,
           'mem_used_gb': 117, 'mem_used_pct': 91.4, 'disk_total_gb': 3700, 'disk_free_gb': 2900, 'disk_used_pct': 21.6,
           'uptime_sec': 86400 * 9}
    self.join('dario', 'Dario', 'mac-mini.local', 'anthropic', pool=pa, images=True, metrics=mac,
              status={'model': 'Opus 5.5', 'effort': 'high', 'context_pct': 41, 'busy': False})
    self.join('claude', 'Claude', 'mac-mini.local', 'anthropic', pool=pb, metrics=mac,
              status={'model': 'Opus 5.5', 'effort': 'medium', 'context_pct': 12, 'busy': False})
    self.join('gem', 'Gem', 'studio-linux', 'google', pool=pg, metrics=lin,
              status={'model': 'Gemini 3 Pro', 'context_pct': 63, 'busy': True})
    # Echo is busy but its last activity is 15 minutes old: the server derives "stalled".
    self.join('echo', 'Echo', 'studio-linux', 'google', metrics=lin, status={'model': 'echo', 'busy': True, 'activity': {
              'state': 'busy', 'since': t0 - 1500, 'last_activity_at': t0 - 900, 'turn_started_at': t0 - 1500}})
    box = {'os': 'Debian 13', 'arch': 'x86_64', 'ip': '10.0.0.40', 'cpu_count': 16, 'mem_total_gb': 64, 'mem_used_gb': 22.5,
           'mem_used_pct': 35.2, 'disk_total_gb': 1858, 'disk_free_gb': 1366, 'disk_used_pct': 26.5, 'uptime_sec': 86400 * 2}
    self.join('kimi', 'Kimi', 'build-box', 'moonshot', pool=pk, metrics=box,
              status={'model': 'Kimi K3', 'effort': 'high', 'context_pct': 86, 'busy': False})
    self.join('codex', 'Codex', 'build-box', 'openai', pool=pc, checkin=False)
    o.call('PATCH', f"/api/v1/admin/principals/{self.ids['gem']}", {'avatar': {'image': '/static/avatars/gem.png', 'icon': 'gem'}})
    o.call('PATCH', f"/api/v1/admin/principals/{self.ids['kimi']}", {'avatar': {'image': '/static/avatars/kimi.png'}})
    o.call('PUT', '/api/v1/admin/hosts/mac-mini.local', {'display_name': 'Malaysia Mac mini'})
    old = self.join('old', 'Old helper', 'mac-mini.local', 'anthropic', checkin=False)
    o.call('POST', f'/api/v1/admin/principals/{old.pid}/revoke', {})
    o.call('PATCH', f'/api/v1/admin/pools/{pa}', {'reporter_principal_id': self.ids['dario']})
    o.call('PATCH', f'/api/v1/admin/pools/{pb}', {'reporter_principal_id': self.ids['claude']})
    self.checkin('dario', metrics=mac, images=True,
                 status={'model': 'Opus 5.5', 'effort': 'high', 'context_pct': 41, 'busy': False},
                 usage={'metrics': [{'name': '5-hour window', 'used_pct': 82, 'resets_at': '2026-11-28T18:00:00Z'},
                                    {'name': 'Weekly window', 'used_pct': 40}]})
    self.checkin('claude', metrics=mac, status={'model': 'Opus 5.5', 'effort': 'medium', 'context_pct': 12, 'busy': False},
                 usage={'metrics': [{'name': '5-hour window', 'used_pct': 95}, {'name': 'Weekly window', 'used_pct': 71}]})
    o.call('POST', '/api/v1/senate/consul', {'principal_id': self.ids['gem']})

    # Owner and Dario: delivered, working progress, rich reply with an image.
    ask = o.call('POST', '/api/v1/messages', {'to': self.ids['dario'], 'body': 'Please audit the **static routes** and report blockers.',
                                              'client_sent_at': time.time() - 0.05})['message']
    self.deliver('dario')
    d = self.agents['dario']
    d.call('PUT', f"/api/v1/messages/{ask['id']}/progress", {'phase': 'working', 'summary': 'Auditing REST routes and CSP headers',
           'bullets': [{'text': 'Inspect static file handler', 'state': 'done'},
                       {'text': 'Draft CSP and KaTeX rules', 'state': 'active'},
                       {'text': 'Write acceptance QA checks', 'state': 'pending'}]})
    att = d.call('POST', '/api/v1/attachments', raw=png_bytes(), headers={'X-Filename': 'latency.png'})['attachment']
    reply = '\n'.join([
      '### Route audit', '==green:PASS== static paths ==amber:REVIEW== cache headers', '',
      '| Check | Result | ms |', '| --- | :---: | ---: |', '| KaTeX CSS | ==green:200== | 12 |', '| KaTeX fonts | ==green:200== | 3 |', '',
      'Expected load is $\\mathbb{E}[x_t] = \\alpha + \\beta_i$:', '$$\\sum_{i=1}^{n} x_i^2 \\le n \\max_i x_i^2$$',
      '```python', 'def is_safe(part):', "    return part not in ('', '.', '..')", '```'])
    d.call('POST', f"/api/v1/messages/{ask['id']}/reply", {'body': reply, 'attachment_ids': [att['id']]})
    follow = o.call('POST', '/api/v1/messages', {'to': self.ids['dario'], 'body': 'Thanks. Next: wire the board and post screenshots.',
                                                 'client_sent_at': time.time() - 0.02})['message']
    self.deliver('dario')
    d.call('PUT', f"/api/v1/messages/{follow['id']}/progress", {'phase': 'working', 'summary': 'Wiring the v2 board',
           'bullets': [{'text': 'Rebase on upstream', 'state': 'done'}, {'text': 'Wire modules', 'state': 'done'},
                       {'text': 'Run QA in Chrome', 'state': 'active'}, {'text': 'Commit', 'state': 'pending'}]})
    # Agent to agent (team, read only for the owner).
    t = d.call('POST', '/api/v1/messages', {'to': 'claude', 'body': 'Handing over the CSP checklist; see the table above.'})['message']
    self.deliver('claude')
    self.agents['claude'].call('POST', f"/api/v1/messages/{t['id']}/reply", {'body': 'Got it, starting now.'})
    self.deliver('dario')
    # Owner and Claude: queued (never claimed), unread agent note first.
    self.agents['claude'].call('POST', '/api/v1/messages', {'to': 'owner', 'body': 'Ready when you are. Quota is low on my pool.'})
    o.call('POST', '/api/v1/messages', {'to': self.ids['claude'], 'body': 'Hold on, I will queue two tasks.', 'mode': 'queue',
                                        'client_sent_at': time.time() - 0.04})
    o.call('POST', '/api/v1/messages', {'to': self.ids['claude'], 'body': 'Urgent: check the CI run first.', 'mode': 'jump'})
    dropped = o.call('POST', '/api/v1/messages', {'to': self.ids['claude'], 'body': 'Never mind the lint pass.'})['message']
    o.call('POST', f"/api/v1/messages/{dropped['id']}/cancel", {'reason': 'changed my mind'})
    # Claude's delivery is held: messages wait on the server until the owner resumes it.
    o.call('POST', f"/api/v1/admin/principals/{self.ids['claude']}/hold", {'reason': 'quota nearly used up'})
    # Kimi needs the owner's input; Codex is offline with mail waiting.
    k = o.call('POST', '/api/v1/messages', {'to': self.ids['kimi'], 'body': 'Run the ablation on the new dataset.',
                                            'client_sent_at': time.time() - 0.03})['message']
    self.deliver('kimi')
    self.agents['kimi'].call('PUT', f"/api/v1/messages/{k['id']}/progress", {'phase': 'input_required',
                             'summary': 'Which dataset split should I use for the ablation?'})
    o.call('POST', '/api/v1/messages', {'to': self.ids['codex'], 'body': 'Please rebase the release branch when you are back.'})
    # An upload never attached to a message: counted as an orphan in Server Storage.
    o.call('POST', '/api/v1/attachments', raw=png_bytes(64, 40), headers={'X-Filename': 'orphan.png'})
    # Owner and Gem (Consul): thinking.
    g = o.call('POST', '/api/v1/messages', {'to': self.ids['gem'], 'body': 'As Consul, please review the invite ledger.'})['message']
    self.deliver('gem')
    self.agents['gem'].call('PUT', f"/api/v1/messages/{g['id']}/progress", {'phase': 'thinking'})
    # Owner and Echo: unconfirmed handoff.
    o.call('POST', '/api/v1/messages', {'to': self.ids['echo'], 'body': 'Echo this back, please.'})
    e = self.agents['echo']
    got = e.call('POST', '/api/v1/deliveries/claim?wait=0')
    e.call('POST', f"/api/v1/deliveries/{got['lease_id']}/unconfirmed", {'reason': 'stream stopped during handoff'})
    # Pins.
    convs = o.call('GET', '/api/v1/conversations')['conversations']
    self.conv = {}
    for c in convs:
      names = sorted(m['handle'] for m in c['members'] if m['kind'] == 'agent')
      self.conv['+'.join(names)] = c['id']
    o.call('POST', f"/api/v1/conversations/{self.conv['gem']}/pin", {})
    # Projects and tasks.
    proj = o.call('POST', '/api/v1/projects', {'name': 'Route audit', 'description': 'Harden **static serving** and CSP for v2.',
                                               'pm_principal_id': self.ids['dario'],
                                               'member_ids': [self.ids['dario'], self.ids['claude'], self.ids['gem']]})['project']
    for title, status, prio, who in [
        ('Segment-wise static path checks', 'done', 2, ['dario']),
        ('KaTeX font MIME types', 'in_review', 1, ['claude']),
        ('CSP style-src-attr', 'in_progress', 3, ['dario', 'gem']),
        ('Load test on studio-linux', 'blocked', 1, ['gem']),
        ('Write QA checklist', 'open', 0, ['claude']),
        ('Port the legacy migration script', 'cancelled', 0, ['dario'])]:
      body = {'title': title, 'status': status, 'priority': prio, 'assignee_ids': [self.ids[x] for x in who]}
      if status == 'blocked':
        body['blocked_reason'] = 'Waiting for the GPU node to come back online'
      o.call('POST', f"/api/v1/projects/{proj['id']}/tasks", body)
    self.project_id = proj['id']
    o.call('POST', '/api/v1/projects', {'name': 'Lecture notes v2', 'description': 'Course materials refresh.',
                                        'pm_principal_id': self.ids['gem'], 'member_ids': [self.ids['gem']]})
    return self


# =============================================================================
# Test-only proxy
# =============================================================================

QA_FILES = {'probe.js': 'text/javascript', 'favicon.html': 'text/html', 'favicon.css': 'text/css'}


class _ProxyHandler(BaseHTTPRequestHandler):
  protocol_version = 'HTTP/1.1'
  board = None
  sse = set()
  sse_lock = threading.Lock()

  def log_message(self, *_a):
    pass

  def _serve_qa(self, name):
    path = HERE / 'qa' / name
    if name not in QA_FILES or not path.is_file():
      self.send_error(404)
      return
    data = path.read_bytes()
    self.send_response(200)
    self.send_header('Content-Type', QA_FILES[name] + '; charset=utf-8')
    self.send_header('Content-Length', str(len(data)))
    self.send_header('Cache-Control', 'no-store')
    self.end_headers()
    self.wfile.write(data)

  def _forward(self):
    u = urlsplit(self.path)
    if u.path.startswith('/__qa/'):
      name = u.path[len('/__qa/'):]
      if name == 'drop-sse':
        with self.sse_lock:
          for sock in list(self.sse):
            try:
              sock.shutdown(2)      # the browser-facing socket: EventSource sees a dropped stream
            except OSError:
              pass
        body = b'{"dropped": true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return
      return self._serve_qa(name)
    n = int(self.headers.get('Content-Length') or 0)
    body = self.rfile.read(n) if n else None
    board = self.board
    conn = http.client.HTTPConnection('127.0.0.1', board.settings.port, timeout=120)
    headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'cookie', 'origin', 'connection')}
    headers['Host'] = f'127.0.0.1:{board.settings.port}'
    headers['Cookie'] = board.owner.cookie
    if self.command not in ('GET', 'HEAD'):
      headers['Origin'] = board.base
    path = u.path + ('?' + u.query if u.query and not u.query.startswith('qa=') else '')
    conn.request(self.command, path, body=body, headers=headers)
    resp = conn.getresponse()
    is_sse = (resp.getheader('Content-Type') or '').startswith('text/event-stream')
    payload = None if is_sse else resp.read()
    if u.path == '/' and 'qa=probe' in (u.query or '') and payload:
      payload = payload.replace(b'</head>', b'<script src="/__qa/probe.js" defer></script>\n</head>')
    self.send_response(resp.status)
    for k, v in resp.getheaders():
      kl = k.lower()
      if kl in ('content-length', 'transfer-encoding', 'connection', 'set-cookie'):
        continue
      self.send_header(k, v)
    if is_sse:
      self.send_header('Connection', 'close')
      self.end_headers()
      self.close_connection = True
      with self.sse_lock:
        self.sse.add(self.connection)
      try:
        while True:
          chunk = resp.read1(4096)
          if not chunk:
            break
          self.wfile.write(chunk)
          self.wfile.flush()
      except (OSError, ValueError):
        pass
      finally:
        with self.sse_lock:
          self.sse.discard(self.connection)
        conn.close()
      return
    self.send_header('Content-Length', str(len(payload)))
    self.end_headers()
    self.wfile.write(payload)
    conn.close()

  do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _forward


class QAProxy:
  def __init__(self, board):
    handler = type('BoundProxy', (_ProxyHandler,), {'board': board, 'sse': set(), 'sse_lock': threading.Lock()})
    self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    self.httpd.daemon_threads = True
    self.base = f'http://127.0.0.1:{self.httpd.server_address[1]}'
    threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

  def close(self):
    self.httpd.shutdown()
    self.httpd.server_close()


if __name__ == '__main__':
  # Manual QA: python3 -B server/tests/js/qa_board.py  -> prints a URL to open in a browser.
  b = SeededBoard().seed()
  p = QAProxy(b)
  print('board', b.base, 'proxy (signed in):', p.base, flush=True)
  try:
    threading.Event().wait()
  except KeyboardInterrupt:
    p.close()
    b.close()
