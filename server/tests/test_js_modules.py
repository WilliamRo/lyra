# =============================================================================
# test_js_modules.py: Tests for the zero-dependency board modules in static/.
#   - static hygiene: no HTML-string sinks in the modules or app.js, and the
#     live web.CSP allows only what KaTeX needs (inline style attributes)
#   - engine tests (tests/js/test_engine.js) under JavaScriptCore `jsc` or Node
#   - browser tests in headless Chrome when LYRA_BROWSER_TESTS=1, served with
#     the live Lyra CSP header: the DOM suite (tests/js/test_dom.js) and a CSP
#     probe proving KaTeX renders while unsafe scripts and styles are blocked
#   (the wired board end to end lives in test_board_e2e.py)
# =============================================================================

import html
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

SERVER = Path(__file__).resolve().parents[1]
STATIC = SERVER / 'lyra_server' / 'static'
JS = SERVER / 'tests' / 'js'
MODULES = ['markdown.js', 'imgpop.js', 'store.js', 'avatar.js', 'lifecycle.js']
SCANNED = MODULES + ['app.js']
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'
CHROMES = [
  os.environ.get('LYRA_CHROME', ''),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  shutil.which('google-chrome') or '', shutil.which('chromium') or '', shutil.which('chromium-browser') or '',
]
RESULT_RE = re.compile(r'<pre id="lyra-result">(.*?)</pre>', re.S)

sys.path.insert(0, str(SERVER))
from lyra_server.web import CSP  # noqa: E402  (read-only: the CSP the server sends)


def csp_directives(policy=CSP):
  out = {}
  for part in policy.split(';'):
    bits = part.split()
    if bits:
      out[bits[0]] = bits[1:]
  return out


def engine_command():
  files = [str(JS / 'harness.js')] + [str(STATIC / m) for m in MODULES] + \
    [str(JS / 'test_engine.js'), str(JS / 'run_engine.js')]
  if os.path.exists(JSC):
    return [JSC] + files
  node = shutil.which('node')
  if node:
    return [node, str(JS / 'run_node.js')] + files
  return None


def find_chrome():
  return next((c for c in CHROMES if c and os.path.exists(c)), None)


def parse_result(text, marker='LYRA_JS_RESULT '):
  lines = [ln for ln in text.splitlines() if ln.startswith(marker)]
  if not lines:
    raise AssertionError('no result line in output:\n' + text[-2000:])
  return json.loads(lines[-1][len(marker):])


def failures(result):
  return [f"{r['name']}: {r.get('error')}" for r in result['results'] if not r['ok']]


class StaticHygieneTests(unittest.TestCase):

  SINKS = ('innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function',
           "setAttribute('style'", 'setAttribute("style"')

  def test_modules_never_parse_html_strings(self):
    for name in SCANNED:
      src = (STATIC / name).read_text(encoding='utf-8')
      for sink in self.SINKS:
        with self.subTest(module=name, sink=sink):
          self.assertNotIn(sink, src)

  def test_modules_never_set_event_handler_attributes(self):
    for name in SCANNED:
      src = (STATIC / name).read_text(encoding='utf-8')
      self.assertIsNone(re.search(r"setAttribute\(\s*['\"]on", src), name)

  def test_live_csp_allows_katex_style_attributes_only(self):
    d = csp_directives()
    self.assertEqual(d.get('default-src'), ["'none'"])
    self.assertEqual(d.get('script-src'), ["'self'"])            # no inline, eval or remote scripts
    self.assertEqual(d.get('style-src'), ["'self'"])
    self.assertEqual(d.get('style-src-elem'), ["'self'"])        # no <style> elements or remote sheets
    self.assertEqual(d.get('style-src-attr'), ["'unsafe-inline'"])  # KaTeX sizing attributes only
    self.assertEqual(d.get('font-src'), ["'self'"])              # vendored KaTeX fonts
    self.assertNotIn('script-src-attr', d)                        # falls back to script-src 'self'
    for name, values in d.items():
      if name != 'style-src-attr':
        self.assertNotIn("'unsafe-inline'", values, name)
      self.assertNotIn("'unsafe-eval'", values, name)

  def test_vendored_katex_is_present_and_licensed(self):
    k = STATIC / 'vendor' / 'katex'
    for rel in ('katex.min.js', 'katex.min.css', 'LICENSE'):
      self.assertTrue((k / rel).is_file(), rel)
    self.assertTrue(list((k / 'fonts').glob('*.woff2')))


@unittest.skipUnless(engine_command(), 'no JavaScript engine (jsc or node) available')
class EngineTests(unittest.TestCase):

  def test_engine_suite(self):
    out = subprocess.run(engine_command(), capture_output=True, text=True, timeout=120)
    result = parse_result(out.stdout + out.stderr)
    self.assertGreater(result['total'], 20)
    self.assertEqual(failures(result), [])


class _StaticHandler(SimpleHTTPRequestHandler):
  extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript',
                    '.woff2': 'font/woff2', '.css': 'text/css'}

  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(SERVER), **kwargs)

  def end_headers(self):
    u = urlsplit(self.path)
    if u.path.endswith('.html'):
      mode = parse_qs(u.query).get('csp', ['live'])[0]
      if mode != 'off':                       # 'off' only for phone.html visual QA framing
        self.send_header('Content-Security-Policy', CSP)
    self.send_header('X-Content-Type-Options', 'nosniff')
    self.send_header('Cache-Control', 'no-store')
    super().end_headers()

  def log_message(self, *_args):
    pass


@unittest.skipUnless(os.environ.get('LYRA_BROWSER_TESTS') == '1' and find_chrome(),
                     'set LYRA_BROWSER_TESTS=1 with Chrome or Chromium installed')
class BrowserTests(unittest.TestCase):

  @classmethod
  def setUpClass(cls):
    cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), _StaticHandler)
    cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
    cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
    cls.thread.start()
    cls.profile = tempfile.mkdtemp(prefix='lyra-chrome-')

  @classmethod
  def tearDownClass(cls):
    cls.httpd.shutdown()
    cls.httpd.server_close()
    shutil.rmtree(cls.profile, ignore_errors=True)

  def run_page(self, page='browser.html', size='1280,800'):
    cmd = [find_chrome(), '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
           '--disable-extensions', f'--user-data-dir={self.profile}', f'--window-size={size}',
           '--virtual-time-budget=15000', '--dump-dom', f'{self.base}/tests/js/{page}?csp=live']
    if sys.platform.startswith('linux'):
      cmd.insert(1, '--no-sandbox')
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    m = RESULT_RE.search(out.stdout)
    self.assertIsNotNone(m, 'browser produced no result:\n' + out.stdout[-1500:] + out.stderr[-1500:])
    return json.loads(html.unescape(m.group(1)))

  def test_browser_suite_under_live_csp(self):
    r = self.run_page()
    self.assertEqual(failures(r), [])
    self.assertGreater(r['total'], 30)
    self.assertEqual(r['csp'], [], 'KaTeX and the modules must render without CSP violations')

  def test_live_csp_allows_katex_and_blocks_unsafe_scripts_and_styles(self):
    r = self.run_page('csp_probe.html')
    f = r['flags']
    # i. Allowed: KaTeX output and inline style attributes (style-src-attr 'unsafe-inline').
    self.assertTrue(f['katexRendered'], r)
    self.assertTrue(f['katexStyleApplied'], r)
    self.assertTrue(f['styleAttrApplied'], r)
    # ii. Blocked: inline <script>, inline handlers, eval, data: scripts and <style> elements.
    for flag in ('inlineScript', 'handler', 'evalRan', 'dataScript', 'styleElemApplied'):
      self.assertFalse(f[flag], flag)
    directives = [v['directive'] for v in r['csp']]
    self.assertFalse(any(d.startswith('style-src-attr') for d in directives), r['csp'])
    self.assertTrue(any(d.startswith('style-src') for d in directives), r['csp'])        # the <style> element
    self.assertGreaterEqual(sum(d.startswith('script-src') for d in directives), 3, r['csp'])

  def test_mobile_viewport(self):
    r = self.run_page(size='390,844')
    self.assertEqual(failures(r), [])


if __name__ == '__main__':
  unittest.main()
