# =============================================================================
# qa_shots.py: Visual QA screenshots of the real wired board (seeded server).
# Drives the UI into each state through DOM clicks, then captures the viewport.
#   desktop: 1440x900          mobile: 390x844, DPR 2, touch
# Used by test_board_e2e.py when LYRA_QA_SHOTS=<dir> is set.
# =============================================================================

import os
import time

# 1. Small JS helpers evaluated in the page (DOM events only, no app internals).
HELPERS = r"""
window.__qa = window.__qa || {
  q: (s) => document.querySelector(s),
  qa: (s) => Array.from(document.querySelectorAll(s)),
  row(title) {
    return this.qa('.conv-row').find((r) => { const t = r.querySelector('.conv-title span'); return t && t.textContent === title; });
  },
  open(title) { const r = this.row(title); if (r) r.querySelector('.conv-main').click(); return !!r; },
  tab(name) { this.q(`[data-tab="${name}"]`).click(); },
  closeDialogs() { this.qa('dialog[open]').forEach((d) => d.close()); },
};
true;
"""


def _ready(c, expr, timeout=10):
  c.wait_for(expr, timeout=timeout)
  time.sleep(0.35)          # let layout, fonts and KaTeX settle before the capture


def _shot(c, outdir, name):
  path = os.path.join(outdir, name + '.png')
  c.screenshot(path)
  return path


def desktop(c, base, outdir, dark=False):
  shots = []
  c.navigate(base + '/')
  c.eval(HELPERS)
  _ready(c, "document.querySelectorAll('.conv-row').length >= 4 && document.querySelectorAll('#roster .agent').length >= 5")
  sfx = '-dark' if dark else ''
  c.eval("__qa.open('Dario')")
  _ready(c, "!!document.querySelector('#messages .katex') && !!document.querySelector('#messages .work-card')")
  c.eval("""(() => { const a = __qa.qa('#roster .agent').find((x) => x.textContent.includes('@dario'));
    a.querySelector('.agent-main').click(); return true; })()""")
  _ready(c, "!!document.querySelector('#roster .agent-details')")
  c.eval("document.getElementById('messages').scrollTop = 1e6")
  shots.append(_shot(c, outdir, 'desktop-chats-thread' + sfx))
  if dark:
    return shots
  c.eval("__qa.q('.seg-btn[data-group=\"provider\"]').click()")
  _ready(c, "document.querySelectorAll('.provider-section').length >= 2")
  c.eval("""(() => { const s = __qa.qa('.provider-section').find((x) => x.textContent.includes('Anthropic'));
    s.querySelectorAll('.rail-card')[1].click(); return true; })()""")
  _ready(c, "!!document.querySelector('.rail-details .meter')")
  c.eval("__qa.open('Claude')")
  _ready(c, "document.querySelector('#conv-header').textContent.includes('Claude')")
  shots.append(_shot(c, outdir, 'desktop-by-provider-queue'))
  c.eval("__qa.q('.seg-btn[data-group=\"machine\"]').click()")
  c.eval("__qa.tab('projects')")
  _ready(c, "document.querySelectorAll('.proj-card').length === 2")
  c.eval("__qa.qa('.proj-card').find((x) => x.textContent.includes('Route audit')).click()")
  _ready(c, "document.querySelectorAll('.task').length === 5")
  shots.append(_shot(c, outdir, 'desktop-projects'))
  c.eval("__qa.tab('admin-senate')")
  _ready(c, "!!document.querySelector('#senate-status.has-consul')")
  shots.append(_shot(c, outdir, 'desktop-admin-senate'))
  c.eval("__qa.tab('chats'); __qa.open('Gem')")
  _ready(c, "document.querySelector('#conv-header').classList.contains('is-consul')")
  c.eval("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', ctrlKey: true, bubbles: true}))")
  _ready(c, "document.getElementById('qs-dialog').open")
  c.eval("""(() => { const i = document.getElementById('qs-input'); i.value = 'da';
    i.dispatchEvent(new Event('input', {bubbles: true})); return true; })()""")
  _ready(c, "document.querySelectorAll('#qs-list .qs-item').length > 0")
  shots.append(_shot(c, outdir, 'desktop-quick-switcher'))
  c.eval("__qa.closeDialogs(); __qa.open('Dario')")
  _ready(c, "!!document.querySelector('#messages .image-strip img')")
  c.eval("document.querySelector('#messages .image-strip img').click()")
  _ready(c, "document.getElementById('imgpop-dialog').open")
  shots.append(_shot(c, outdir, 'desktop-imgpop'))
  c.eval("__qa.closeDialogs(); fetch('/__qa/drop-sse')")
  _ready(c, "!document.getElementById('conn-banner').hidden && document.getElementById('conn-text').textContent.includes('Reconnecting')")
  shots.append(_shot(c, outdir, 'desktop-reconnect-banner'))
  return shots


def mobile(c, base, outdir, dark=False):
  shots = []
  sfx = '-dark' if dark else ''
  c.navigate(base + '/')
  c.eval(HELPERS)
  _ready(c, "document.querySelectorAll('.conv-row').length >= 4")
  shots.append(_shot(c, outdir, 'mobile-chats-list' + sfx))
  c.eval("__qa.open('Dario')")
  _ready(c, "document.querySelector('.chats').dataset.view === 'thread' && !!document.querySelector('#messages .katex')")
  c.eval("document.getElementById('messages').scrollTop = 1e6")
  shots.append(_shot(c, outdir, 'mobile-thread' + sfx))
  if dark:
    return shots
  c.eval("""(() => { const m = __qa.qa('#messages .msg').find((x) => x.textContent.includes('Route audit'));
    m.scrollIntoView({block: 'start'}); return true; })()""")
  shots.append(_shot(c, outdir, 'mobile-thread-markdown'))
  c.eval("__qa.tab('agents')")
  _ready(c, "getComputedStyle(document.getElementById('pane-agents')).display !== 'none'")
  c.eval("""(() => { const a = __qa.qa('#roster .agent').find((x) => x.textContent.includes('@gem'));
    a.querySelector('.agent-main').click(); return true; })()""")
  _ready(c, "!!document.querySelector('#roster .agent-details')")
  shots.append(_shot(c, outdir, 'mobile-agents'))
  c.eval("__qa.tab('projects')")
  _ready(c, "document.querySelectorAll('.proj-card').length === 2")
  shots.append(_shot(c, outdir, 'mobile-projects-list'))
  c.eval("__qa.qa('.proj-card').find((x) => x.textContent.includes('Route audit')).click()")
  _ready(c, "document.getElementById('projects').dataset.view === 'detail' && document.querySelectorAll('.task').length === 5")
  shots.append(_shot(c, outdir, 'mobile-project-detail'))
  c.eval("__qa.tab('admin-senate')")
  _ready(c, "!!document.querySelector('#senate-status.has-consul')")
  shots.append(_shot(c, outdir, 'mobile-admin-senate'))
  c.eval("__qa.tab('chats'); __qa.open('Dario')")
  _ready(c, "!!document.querySelector('#messages .image-strip img')")
  c.eval("document.querySelector('#messages .image-strip img').click()")
  _ready(c, "document.getElementById('imgpop-dialog').open")
  shots.append(_shot(c, outdir, 'mobile-imgpop'))
  return shots


def capture_all(chrome_factory, base, outdir):
  """Runs every layout and theme in a fresh browser each; returns (paths, console problems)."""
  os.makedirs(outdir, exist_ok=True)
  paths, problems = [], []
  plans = [(desktop, (1440, 900, False, 1), False), (desktop, (1440, 900, False, 1), True),
           (mobile, (390, 844, True, 2), False), (mobile, (390, 844, True, 2), True)]
  for fn, (w, h, mob, dpr), dark in plans:
    c = chrome_factory()
    try:
      c.open_page(w, h, mobile=mob, dpr=dpr)
      c.send('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme',
                                                           'value': 'dark' if dark else 'light'}]})
      paths += fn(c, base, outdir, dark=dark)
      problems += c.console_problems()
    finally:
      c.close()
  return paths, problems
