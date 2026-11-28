# =============================================================================
# test_js_modules.py: Tests for the zero-dependency board modules in static/.
#   - static hygiene: no HTML-string sinks in the new modules
#   - engine tests (tests/js/test_engine.js) under JavaScriptCore `jsc` or Node
#   - browser tests (tests/js/test_dom.js) in headless Chrome when
#     LYRA_BROWSER_TESTS=1, served with the real Lyra CSP header and with the
#     proposed v2 CSP that adds style-src-attr for KaTeX
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
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'
CHROMES = [
  os.environ.get('LYRA_CHROME', ''),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  shutil.which('google-chrome') or '', shutil.which('chromium') or '', shutil.which('chromium-browser') or '',
]
RESULT_RE = re.compile(r'<pre id="lyra-result">(.*?)</pre>', re.S)

sys.path.insert(0, str(SERVER))
from lyra_server.web import CSP  # noqa: E402  (read-only: the CSP the server sends today)

CSP_V2 = CSP + "; style-src-attr 'unsafe-inline'"


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
    for name in MODULES:
      src = (STATIC / name).read_text(encoding='utf-8')
      for sink in self.SINKS:
        with self.subTest(module=name, sink=sink):
          self.assertNotIn(sink, src)

  def test_modules_never_set_event_handler_attributes(self):
    for name in MODULES:
      src = (STATIC / name).read_text(encoding='utf-8')
      self.assertIsNone(re.search(r"setAttribute\(\s*['\"]on", src), name)

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
      mode = parse_qs(u.query).get('csp', ['v2'])[0]
      if mode != 'off':                       # 'off' only for phone.html visual QA framing
        self.send_header('Content-Security-Policy', CSP if mode == 'current' else CSP_V2)
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

  def run_page(self, csp, size='1280,800'):
    cmd = [find_chrome(), '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
           '--disable-extensions', f'--user-data-dir={self.profile}', f'--window-size={size}',
           '--virtual-time-budget=15000', '--dump-dom', f'{self.base}/tests/js/browser.html?csp={csp}']
    if sys.platform.startswith('linux'):
      cmd.insert(1, '--no-sandbox')
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    m = RESULT_RE.search(out.stdout)
    self.assertIsNotNone(m, 'browser produced no result:\n' + out.stdout[-1500:] + out.stderr[-1500:])
    return json.loads(html.unescape(m.group(1)))

  def test_browser_suite_under_v2_csp(self):
    r = self.run_page('v2')
    self.assertEqual(failures(r), [])
    self.assertGreater(r['total'], 30)
    self.assertEqual(r['csp'], [], 'no CSP violations with style-src-attr for KaTeX')

  def test_current_csp_blocks_katex_inline_styles(self):
    # Documents the server prerequisite in UI_DESIGN_V2.md: today's CSP rejects
    # KaTeX's style attributes, so the v2 header must add style-src-attr.
    r = self.run_page('current')
    directives = {v['directive'] for v in r['csp']}
    self.assertTrue(any(d.startswith('style-src') for d in directives), r['csp'])
    self.assertFalse(any(d.startswith('script-src') for d in directives), r['csp'])

  def test_mobile_viewport(self):
    r = self.run_page('v2', size='390,844')
    self.assertEqual(failures(r), [])


if __name__ == '__main__':
  unittest.main()
