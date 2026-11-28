# =============================================================================
# cdp.py: Minimal Chrome DevTools Protocol client over --remote-debugging-pipe
# (stdlib only). Used by the opt-in browser tests to emulate exact phone
# viewports (390x844, touch, DPR 2), evaluate scripts and capture screenshots.
# =============================================================================

import base64
import fcntl
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time

CHROME_CANDIDATES = [
  os.environ.get('LYRA_CHROME') or '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  shutil.which('google-chrome') or '', shutil.which('chromium') or '', shutil.which('chromium-browser') or '',
]


def find_chrome():
  for c in CHROME_CANDIDATES:
    if c and os.path.exists(c):
      return c
  return None


class CDPError(RuntimeError):
  pass


class Chrome:
  """One headless browser with one page session."""

  def __init__(self, binary=None):
    binary = binary or find_chrome()
    if not binary:
      raise CDPError('Chrome not found')
    self.profile = tempfile.mkdtemp(prefix='lyra-cdp-', dir=os.environ.get('LYRA_TEST_TMP'))
    to_chrome_r, self._w = os.pipe()
    self._r, from_chrome_w = os.pipe()
    # Chrome reads commands from fd 3 and writes replies to fd 4. Move the child ends above 10
    # first so the shell redirections below can never clobber each other.
    cr = fcntl.fcntl(to_chrome_r, fcntl.F_DUPFD, 10)
    cw = fcntl.fcntl(from_chrome_w, fcntl.F_DUPFD, 10)
    os.close(to_chrome_r)
    os.close(from_chrome_w)
    args = [binary, '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
            '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync',
            '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', f'--user-data-dir={self.profile}',
            'about:blank']
    self.proc = subprocess.Popen(
      ['/bin/sh', '-c', f'exec "$0" "$@" 3<&{cr} 4>&{cw} {cr}<&- {cw}>&-'] + args,
      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=(cr, cw))
    os.close(cr)
    os.close(cw)
    self._id = 0
    self._lock = threading.Lock()
    self._pending = {}
    self.events = []
    self._buf = b''
    self._reader = threading.Thread(target=self._read_loop, daemon=True)
    self._reader.start()
    self.session = None

  # --- transport -------------------------------------------------------------

  def _read_loop(self):
    while True:
      try:
        chunk = os.read(self._r, 1 << 16)
      except OSError:
        break
      if not chunk:
        break
      self._buf += chunk
      while b'\0' in self._buf:
        raw, self._buf = self._buf.split(b'\0', 1)
        msg = json.loads(raw)
        if 'id' in msg:
          slot = self._pending.get(msg['id'])
          if slot:
            slot['msg'] = msg
            slot['ev'].set()
        else:
          self.events.append(msg)
    for slot in list(self._pending.values()):
      slot['ev'].set()

  def send(self, method, params=None, session=True, timeout=30):
    with self._lock:
      self._id += 1
      mid = self._id
      slot = {'ev': threading.Event(), 'msg': None}
      self._pending[mid] = slot
      msg = {'id': mid, 'method': method, 'params': params or {}}
      if session and self.session:
        msg['sessionId'] = self.session
      os.write(self._w, json.dumps(msg).encode() + b'\0')
    if not slot['ev'].wait(timeout):
      raise CDPError(f'{method} timed out')
    self._pending.pop(mid, None)
    got = slot['msg']
    if got is None:
      raise CDPError(f'{method}: browser closed')
    if 'error' in got:
      raise CDPError(f"{method}: {got['error'].get('message')}")
    return got.get('result', {})

  # --- page helpers ----------------------------------------------------------

  def open_page(self, width, height, mobile=False, dpr=1):
    target = self.send('Target.createTarget', {'url': 'about:blank'}, session=False)['targetId']
    self.session = self.send('Target.attachToTarget', {'targetId': target, 'flatten': True}, session=False)['sessionId']
    for m in ('Page.enable', 'Runtime.enable', 'Log.enable'):
      self.send(m)
    self.send('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': dpr,
                                                     'mobile': mobile})
    if mobile:
      self.send('Emulation.setTouchEmulationEnabled', {'enabled': True, 'maxTouchPoints': 5})
    self.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
    return self

  def grant(self, origin, permissions):
    self.send('Browser.grantPermissions', {'origin': origin, 'permissions': permissions}, session=False)

  def navigate(self, url, timeout=20):
    self.events = [e for e in self.events if e.get('method') != 'Page.loadEventFired']
    self.send('Page.navigate', {'url': url})
    t0 = time.time()
    while time.time() - t0 < timeout:
      if any(e.get('method') == 'Page.loadEventFired' for e in self.events):
        return
      time.sleep(0.05)
    raise CDPError('page load timed out')

  def eval(self, expr, timeout=30):
    r = self.send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True,
                                       'userGesture': True}, timeout=timeout)
    if 'exceptionDetails' in r:
      d = r['exceptionDetails']
      raise CDPError('eval failed: ' + str((d.get('exception') or {}).get('description') or d.get('text')))
    return r.get('result', {}).get('value')

  def wait_for(self, expr, timeout=60, interval=0.1):
    t0 = time.time()
    while time.time() - t0 < timeout:
      v = self.eval(expr)
      if v:
        return v
      time.sleep(interval)
    raise CDPError('timed out waiting for ' + expr)

  def screenshot(self, path):
    data = self.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})['data']
    with open(path, 'wb') as f:
      f.write(base64.b64decode(data))
    return path

  def console_problems(self):
    """Errors and CSP violations reported by the page (Log + Runtime domains)."""
    out = []
    for e in self.events:
      m, p = e.get('method'), e.get('params', {})
      if m == 'Log.entryAdded' and p.get('entry', {}).get('level') == 'error':
        entry = p['entry']
        out.append(entry.get('text', '') + (f" [{entry['url']}]" if entry.get('url') else ''))
      elif m == 'Runtime.exceptionThrown':
        d = p.get('exceptionDetails', {})
        out.append('exception: ' + str((d.get('exception') or {}).get('description') or d.get('text')))
      elif m == 'Runtime.consoleAPICalled' and p.get('type') == 'error':
        out.append('console.error: ' + ' '.join(str(a.get('value', a.get('description', ''))) for a in p.get('args', [])))
    return out

  def close(self):
    try:
      self.send('Browser.close', session=False, timeout=5)
    except CDPError:
      pass
    try:
      self.proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
      self.proc.kill()
    for fd in (self._w, self._r):
      try:
        os.close(fd)
      except OSError:
        pass
    shutil.rmtree(self.profile, ignore_errors=True)
