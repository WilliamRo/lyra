# =============================================================================
# qa_shots.py: Visual QA screenshots of the real wired board (seeded server).
# Drives the UI into each state through DOM clicks (and real hover through the
# DevTools input domain), then captures the viewport.
#   desktop: 1440x900          mobile: 390x844, DPR 2, touch
#   themes: light and dark via prefers-color-scheme (the board follows the system)
# Used by test_board_e2e.py; set LYRA_QA_SHOTS=<dir> to keep the files.
# =============================================================================

import json
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
  tab(name) { this.q(`[data-tab="${name}"]`).click(); return true; },
  group(mode) { this.q(`.seg-btn[data-group="${mode}"]`).click(); return true; },
  closeDialogs() { this.qa('dialog[open]').forEach((d) => d.close()); return true; },
  bottom() { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; return true; },
};
true;
"""


def _ready(c, expr, timeout=10):
  c.wait_for(expr, timeout=timeout)
  time.sleep(0.35)          # let layout, fonts, images and KaTeX settle before the capture


def _shot(c, outdir, name):
  path = os.path.join(outdir, name + '.png')
  c.screenshot(path)
  return path


def _hover(c, selector):
  r = c.eval(f"(() => {{ const r = document.querySelector({json.dumps(selector)}).getBoundingClientRect();"
             " return [r.left + r.width / 2, r.top + r.height / 2]; })()")
  c.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': r[0], 'y': r[1]})


def _start(c, base):
  c.navigate(base + '/')
  c.eval(HELPERS)
  _ready(c, "document.querySelectorAll('.conv-row').length >= 5 && document.querySelectorAll('#roster .agent').length >= 6")


def desktop(c, base, outdir, theme):
  shots = []
  sfx = '-' + theme
  light = theme == 'light'
  _start(c, base)
  # i. Chats: the live agent bubble under Dario's thread, receipts on the owner's messages.
  c.eval("__qa.open('Dario')")
  _ready(c, "!!document.querySelector('#messages .msg.live .work-bullet') && !!document.querySelector('#messages .katex')")
  c.eval("__qa.bottom()")
  shots.append(_shot(c, outdir, 'desktop-chats-live' + sfx))
  # ii. Needs you: Kimi waiting for input.
  c.eval("__qa.q('#needs .needs-item[data-kind=\"input\"]').click()")
  _ready(c, "!!document.querySelector('#messages .msg.live.is-input_required')")
  shots.append(_shot(c, outdir, 'desktop-needs-input' + sfx))
  # iii. Pools by provider with the long duplicated label, and the held Claude queue.
  c.eval("__qa.group('provider')")
  _ready(c, "document.querySelectorAll('.provider-section').length >= 4")
  c.eval("__qa.qa('.rail-card[data-pool-id]').find((x) => x.textContent.includes('Google AI Ultra')).click()")
  _ready(c, "!!document.querySelector('.rail-details .kv')")
  c.eval("""(() => { const g = __qa.qa('.provider-section').find((s) => s.dataset.provider === 'google');
    g.scrollIntoView({ block: 'start' }); return true; })()""")
  c.eval("__qa.open('Claude')")
  _ready(c, "!!document.querySelector('#messages .receipt[data-kind=\"cancelled\"]')")
  shots.append(_shot(c, outdir, 'desktop-pools-queue' + sfx))
  c.eval("__qa.group('machine')")
  # iv. Delivery details for an answered message.
  c.eval("__qa.open('Dario')")
  _ready(c, "!!document.querySelector('#messages .msg.mine .receipt[data-kind=\"replied\"]')")
  c.eval("__qa.qa('#messages .receipt[data-kind=\"replied\"] .rc-btn').find((b) => b.textContent === 'Details').click()")
  _ready(c, "document.querySelectorAll('#lifecycle-body .dur-row').length === 5")
  shots.append(_shot(c, outdir, 'desktop-details' + sfx))
  c.eval("__qa.closeDialogs()")
  # v. Right-click menu on a machine card (agents scrolled to the top).
  c.eval("document.getElementById('roster').scrollTop = 0")
  _ready(c, "true")         # let the scroll event fire first: scrolling the roster closes the menu by design
  c.eval("""(() => { const card = __qa.qa('.rail-card[data-host]').find((x) => x.textContent.includes('Malaysia Mac mini'));
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 30 }));
    return true; })()""")
  _ready(c, "!document.getElementById('host-menu').hidden")
  shots.append(_shot(c, outdir, 'desktop-host-menu' + sfx))
  c.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  # vi. Composer: hover the paperclip so its tooltip shows.
  c.eval("__qa.bottom()")
  _hover(c, '#compose-attach')
  _ready(c, "getComputedStyle(document.getElementById('compose-attach-tip'), '::after').opacity === '1'")
  shots.append(_shot(c, outdir, 'desktop-composer-attach' + sfx))
  c.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 5, 'y': 880})
  # vii. Projects with every task state.
  c.eval("__qa.tab('projects')")
  _ready(c, "document.querySelectorAll('.proj-card').length === 2")
  c.eval("__qa.qa('.proj-card').find((x) => x.textContent.includes('Route audit')).click()")
  _ready(c, "document.querySelectorAll('.task').length === 6")
  shots.append(_shot(c, outdir, 'desktop-projects' + sfx))
  # viii. Senate: Consul and invites, then pools and server storage.
  c.eval("__qa.tab('senate')")
  _ready(c, "!!document.querySelector('#senate-status.has-consul') && !!document.querySelector('#storage .storage-used')")
  shots.append(_shot(c, outdir, 'desktop-senate' + sfx))
  c.eval("document.getElementById('pools-title').scrollIntoView({ block: 'start' })")
  _ready(c, "true")
  shots.append(_shot(c, outdir, 'desktop-senate-pools' + sfx))
  c.eval("document.getElementById('storage-title').scrollIntoView({ block: 'start' })")
  _ready(c, "true")
  shots.append(_shot(c, outdir, 'desktop-storage' + sfx))
  # ix. Sidebar collapsed (H) on the chats view.
  c.eval("__qa.tab('chats'); __qa.open('Dario'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }))")
  _ready(c, "document.getElementById('layout').classList.contains('sidebar-collapsed') && !!document.querySelector('#messages .msg.live')")
  c.eval("__qa.bottom()")
  shots.append(_shot(c, outdir, 'desktop-sidebar-collapsed' + sfx))
  c.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }))")
  if light:
    c.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))")
    _ready(c, "document.getElementById('qs-dialog').open")
    c.eval("""(() => { const i = document.getElementById('qs-input'); i.value = 'ki';
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()""")
    _ready(c, "document.querySelectorAll('#qs-list .qs-item').length > 0")
    shots.append(_shot(c, outdir, 'desktop-quick-switcher' + sfx))
    c.eval("__qa.closeDialogs(); __qa.open('Dario')")
    _ready(c, "!!document.querySelector('#messages .image-strip img')")
    c.eval("document.querySelector('#messages .image-strip img').click()")
    _ready(c, "document.getElementById('imgpop-dialog').open")
    shots.append(_shot(c, outdir, 'desktop-imgpop' + sfx))
    c.eval("__qa.closeDialogs(); fetch('/__qa/drop-sse')")
    _ready(c, "!document.getElementById('conn-banner').hidden && document.getElementById('conn-text').textContent.includes('Reconnecting')")
    shots.append(_shot(c, outdir, 'desktop-reconnect-banner' + sfx))
  return shots


def mobile(c, base, outdir, theme):
  shots = []
  sfx = '-' + theme
  _start(c, base)
  shots.append(_shot(c, outdir, 'mobile-chats-list' + sfx))
  c.eval("__qa.open('Dario')")
  _ready(c, "document.querySelector('.chats').dataset.view === 'thread' && !!document.querySelector('#messages .msg.live')")
  c.eval("__qa.bottom()")
  shots.append(_shot(c, outdir, 'mobile-thread-live' + sfx))
  c.eval("__qa.tab('agents')")
  _ready(c, "getComputedStyle(document.getElementById('pane-agents')).display !== 'none' && !document.getElementById('needs').hidden")
  shots.append(_shot(c, outdir, 'mobile-agents' + sfx))
  c.eval("document.querySelector('.rail-group').scrollIntoView({ block: 'start' })")
  _ready(c, "true")
  shots.append(_shot(c, outdir, 'mobile-machines' + sfx))
  c.eval("__qa.group('provider')")
  _ready(c, "document.querySelectorAll('.provider-section').length >= 4")
  c.eval("__qa.qa('.provider-section').find((s) => s.dataset.provider === 'google').scrollIntoView({ block: 'start' })")
  _ready(c, "true")
  shots.append(_shot(c, outdir, 'mobile-pools' + sfx))
  c.eval("__qa.group('machine')")
  c.eval("__qa.tab('projects')")
  _ready(c, "document.querySelectorAll('.proj-card').length === 2")
  c.eval("__qa.qa('.proj-card').find((x) => x.textContent.includes('Route audit')).click()")
  _ready(c, "document.getElementById('projects').dataset.view === 'detail' && document.querySelectorAll('.task').length === 6")
  shots.append(_shot(c, outdir, 'mobile-project-detail' + sfx))
  c.eval("__qa.tab('senate')")
  _ready(c, "!!document.querySelector('#senate-status.has-consul')")
  shots.append(_shot(c, outdir, 'mobile-senate' + sfx))
  c.eval("document.getElementById('pools-title').scrollIntoView({ block: 'start' })")
  _ready(c, "true")
  shots.append(_shot(c, outdir, 'mobile-senate-pools' + sfx))
  c.eval("document.getElementById('storage-title').scrollIntoView({ block: 'start' })")
  _ready(c, "true")
  shots.append(_shot(c, outdir, 'mobile-storage' + sfx))
  if theme == 'light':
    c.eval("__qa.tab('chats'); __qa.open('Dario')")
    _ready(c, "!!document.querySelector('#messages .image-strip img')")
    c.eval("document.querySelector('#messages .image-strip img').click()")
    _ready(c, "document.getElementById('imgpop-dialog').open")
    shots.append(_shot(c, outdir, 'mobile-imgpop' + sfx))
  return shots


def favicon_sheet(c, base, outdir):
  """The tab icon at the sizes browsers use, on light and dark tab strips (served by the QA proxy)."""
  c.navigate(base + '/__qa/favicon.html')
  _ready(c, "Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0)")
  return _shot(c, outdir, 'favicon-sizes')


def capture_all(chrome_factory, base, outdir):
  """Runs every layout and theme in a fresh browser each; returns (paths, console problems)."""
  os.makedirs(outdir, exist_ok=True)
  paths, problems = [], []
  plans = [(desktop, (1440, 900, False, 1), 'light'), (desktop, (1440, 900, False, 1), 'dark'),
           (mobile, (390, 844, True, 2), 'light'), (mobile, (390, 844, True, 2), 'dark')]
  for fn, (w, h, mob, dpr), theme in plans:
    c = chrome_factory()
    try:
      c.open_page(w, h, mobile=mob, dpr=dpr)
      c.send('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': theme}]})
      paths += fn(c, base, outdir, theme)
      problems += c.console_problems()
    finally:
      c.close()
  c = chrome_factory()
  try:
    c.open_page(520, 200, dpr=2)
    paths.append(favicon_sheet(c, base, outdir))
  finally:
    c.close()
  return paths, problems
