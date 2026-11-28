# =============================================================================
# test_board_e2e.py: The wired v2 board end to end in headless Chrome
# (opt-in: LYRA_BROWSER_TESTS=1). Each test seeds a real Lyra server through
# the public API (tests/js/qa_board.py), serves the board with its live CSP
# through a sign-in proxy, and drives it over the DevTools pipe (tests/js/cdp.py):
#   - desktop 1440x900 and phone 390x844 (touch, DPR 2) feature probes
#     (tests/js/qa/probe.js): Needs you, honest status chips, hold, context
#     rings, host aliases (right-click), pools, collapsible and resizable
#     sidebar, theme switch, live agent bubble, receipts, Cancel, delivery
#     Details, draft images, projects and tasks (cancelled, blocked reason,
#     versions), Senate with Server Storage cleanup, notifications toggle,
#     shortcuts (Ctrl+K, N, X, H, Alt+arrows), SSE reconnect banner
#   - zero page errors, console errors or CSP violations, and no element that
#     crosses its rail, card or row container
#   - visual QA screenshots in light and dark (kept when LYRA_QA_SHOTS=<dir>)
# =============================================================================

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

JS = Path(__file__).resolve().parent / 'js'
sys.path.insert(0, str(JS))

from cdp import Chrome, find_chrome  # noqa: E402
import qa_shots  # noqa: E402
from qa_board import QAProxy, SeededBoard  # noqa: E402


@unittest.skipUnless(os.environ.get('LYRA_BROWSER_TESTS') == '1' and find_chrome(),
                     'set LYRA_BROWSER_TESTS=1 with Chrome or Chromium installed')
class WiredBoardTests(unittest.TestCase):

  def setUp(self):
    self.board = SeededBoard().seed()
    self.proxy = QAProxy(self.board)
    self.addCleanup(self.board.close)
    self.addCleanup(self.proxy.close)

  def run_probe(self, width, height, mobile=False, dpr=1, theme='light'):
    chrome = Chrome().open_page(width, height, mobile=mobile, dpr=dpr)
    try:
      chrome.send('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': theme}]})
      chrome.grant(self.proxy.base, ['notifications'])
      chrome.navigate(self.proxy.base + '/?qa=probe')
      chrome.wait_for("!!document.getElementById('lyra-qa')", timeout=150)   # app.js owns the title
      result = json.loads(chrome.eval("document.getElementById('lyra-qa').textContent"))
      result['console'] = chrome.console_problems()
    finally:
      chrome.close()
    return result

  def check(self, result, layout, min_steps, theme='light'):
    self.assertEqual(result['layout'], layout)
    self.assertEqual(result['theme'], theme)
    failed = [f"{r['name']}: {r.get('error')}" for r in result['results'] if not r['ok']]
    self.assertEqual(failed, [])
    self.assertGreaterEqual(len(result['results']), min_steps)
    self.assertEqual(result['errors'], [], 'uncaught page errors')
    self.assertEqual(result['console'], [], 'console errors or CSP violations under the live CSP')
    self.assertEqual(result['overflow'], [], 'elements crossing their containers')

  def test_desktop_board_light(self):
    self.check(self.run_probe(1440, 900), 'desktop', 32)

  def test_desktop_board_dark(self):
    self.check(self.run_probe(1440, 900, theme='dark'), 'desktop', 32, theme='dark')

  def test_phone_board_light(self):
    r = self.run_probe(390, 844, mobile=True, dpr=2)
    self.assertEqual(r['viewport'], [390, 844])
    self.check(r, 'mobile', 6)

  def test_phone_board_dark(self):
    r = self.run_probe(390, 844, mobile=True, dpr=2, theme='dark')
    self.assertEqual(r['viewport'], [390, 844])
    self.check(r, 'mobile', 6, theme='dark')

  def test_visual_qa_screenshots(self):
    keep = os.environ.get('LYRA_QA_SHOTS')
    out = keep or tempfile.mkdtemp(prefix='lyra-shots-', dir=os.environ.get('LYRA_TEST_TMP'))
    if not keep:
      self.addCleanup(shutil.rmtree, out, True)
    paths, problems = qa_shots.capture_all(Chrome, self.proxy.base, out)
    self.assertEqual(problems, [])
    names = {Path(p).name for p in paths}
    for theme in ('light', 'dark'):
      for view in ('desktop-chats-live', 'desktop-needs-input', 'desktop-pools-queue', 'desktop-details', 'desktop-host-menu',
                   'desktop-composer-attach', 'desktop-projects', 'desktop-senate', 'desktop-senate-pools', 'desktop-storage',
                   'desktop-sidebar-collapsed', 'mobile-chats-list', 'mobile-thread-live', 'mobile-agents', 'mobile-machines',
                   'mobile-pools', 'mobile-project-detail', 'mobile-senate', 'mobile-senate-pools', 'mobile-storage'):
        self.assertIn(f'{view}-{theme}.png', names)
    self.assertIn('favicon-sizes.png', names)
    self.assertEqual(len(paths), 45)
    for p in paths:
      data = Path(p).read_bytes()
      self.assertTrue(data.startswith(b'\x89PNG') and len(data) > 10_000, p)
      if 'mobile' in Path(p).name:   # 390x844 CSS px at DPR 2
        self.assertEqual((int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')), (780, 1688), p)


if __name__ == '__main__':
  unittest.main()
