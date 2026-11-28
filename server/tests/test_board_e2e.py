# =============================================================================
# test_board_e2e.py: The wired v2 board end to end in headless Chrome
# (opt-in: LYRA_BROWSER_TESTS=1). Each test seeds a real Lyra server through
# the public API (tests/js/qa_board.py), serves the board with its live CSP
# through a sign-in proxy, and drives it over the DevTools pipe (tests/js/cdp.py):
#   - desktop 1440x900 and phone 390x844 (touch, DPR 2) feature probes
#     (tests/js/qa/probe.js): sidebar groupings, pins, unread and read receipts,
#     Markdown + KaTeX, imgpop, lifecycle, drafts, projects and tasks,
#     Admin & Senate, quick switcher, shortcuts, SSE reconnect banner
#   - zero page errors and zero console errors or CSP violations
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

  def run_probe(self, width, height, mobile=False, dpr=1):
    chrome = Chrome().open_page(width, height, mobile=mobile, dpr=dpr)
    try:
      chrome.navigate(self.proxy.base + '/?qa=probe')
      chrome.wait_for("!!document.getElementById('lyra-qa')", timeout=150)   # app.js owns the title
      result = json.loads(chrome.eval("document.getElementById('lyra-qa').textContent"))
      result['console'] = chrome.console_problems()
    finally:
      chrome.close()
    return result

  def check(self, result, layout, min_steps):
    self.assertEqual(result['layout'], layout)
    failed = [f"{r['name']}: {r.get('error')}" for r in result['results'] if not r['ok']]
    self.assertEqual(failed, [])
    self.assertGreaterEqual(len(result['results']), min_steps)
    self.assertEqual(result['errors'], [], 'uncaught page errors')
    self.assertEqual(result['console'], [], 'console errors or CSP violations under the live CSP')

  def test_desktop_board(self):
    self.check(self.run_probe(1440, 900), 'desktop', 20)

  def test_phone_board(self):
    r = self.run_probe(390, 844, mobile=True, dpr=2)
    self.assertEqual(r['viewport'], [390, 844])
    self.check(r, 'mobile', 4)

  def test_visual_qa_screenshots(self):
    keep = os.environ.get('LYRA_QA_SHOTS')
    out = keep or tempfile.mkdtemp(prefix='lyra-shots-', dir=os.environ.get('LYRA_TEST_TMP'))
    if not keep:
      self.addCleanup(shutil.rmtree, out, True)
    paths, problems = qa_shots.capture_all(Chrome, self.proxy.base, out)
    self.assertEqual(problems, [])
    names = {Path(p).name for p in paths}
    for name in ('desktop-chats-thread.png', 'desktop-chats-thread-dark.png', 'desktop-projects.png',
                 'desktop-admin-senate.png', 'mobile-chats-list.png', 'mobile-thread.png', 'mobile-agents.png',
                 'mobile-project-detail.png', 'mobile-imgpop.png', 'mobile-thread-dark.png'):
      self.assertIn(name, names)
    for p in paths:
      data = Path(p).read_bytes()
      self.assertTrue(data.startswith(b'\x89PNG') and len(data) > 10_000, p)
      if 'mobile' in Path(p).name:   # 390x844 CSS px at DPR 2
        self.assertEqual((int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')), (780, 1688), p)


if __name__ == '__main__':
  unittest.main()
