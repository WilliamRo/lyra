// QA probe injected by qa_board.QAProxy into "/?qa=probe". Drives the real board through DOM
// events only and writes {results, errors} into <pre id="lyra-qa">.
(function () {
  'use strict';
  const R = { results: [], errors: [], layout: '' };
  window.addEventListener('error', (e) => R.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => R.errors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));
  const q = (s, r) => (r || document).querySelector(s);
  const qa = (s, r) => Array.from((r || document).querySelectorAll(s));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) {
      try { const v = fn(); if (v) return v; } catch (_e) { /* keep polling */ }
      await wait(40);
    }
    throw new Error('timed out waiting for ' + (label || 'condition'));
  }
  function ok(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }
  async function step(name, fn) {
    try { await fn(); R.results.push({ name, ok: true }); }
    catch (e) { R.results.push({ name, ok: false, error: String((e && e.message) || e) }); }
  }
  function key(target, k, extra) {
    target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));
  }
  function convRow(title) {
    return qa('.conv-row').find((r) => q('.conv-title span', r) && q('.conv-title span', r).textContent === title);
  }
  async function openConvByTitle(title) {
    const row = await until(() => convRow(title), 6000, 'conversation ' + title);
    q('.conv-main', row).click();
    await until(() => q('#conv-header .who-name') && q('#conv-header .who-name').textContent.indexOf(title.split(' and ')[0]) !== -1
      && qa('#messages .msg').length > 0, 6000, 'thread for ' + title);
    return row;
  }
  function noOverflow() {
    const d = document.documentElement;
    return d.scrollWidth <= d.clientWidth + 1;
  }
  function tall(el) { const r = el.getBoundingClientRect(); return r.height >= 43.5 || r.height === 0; }

  async function desktop() {
    await step('boot: board renders agents and conversations', async () => {
      await until(() => !q('#main').hidden && qa('#roster .agent').length >= 5 && qa('.conv-row').length >= 4, 8000, 'board');
    });
    await step('tabs: Usage removed, Admin & Senate merged, Agents tab hidden on desktop', async () => {
      ok(!q('[data-tab="usage"]') && !q('[data-tab="senate"]') && !q('[data-tab="admin"]'), 'old tabs still present');
      ok(q('[data-tab="admin-senate"]') && q('[data-tab="projects"]'), 'new tabs missing');
      ok(getComputedStyle(q('.tab-agents')).display === 'none', 'Agents tab visible on desktop');
      ok(getComputedStyle(q('#pane-agents')).display !== 'none', 'sidebar hidden');
    });
    await step('agents: By machine shows host rail cards and summary rows', async () => {
      q('.seg-btn[data-group="machine"]').click();
      await until(() => qa('.rail-group').length >= 3, 3000, 'host groups');
      const names = qa('.rail-name').map((n) => n.textContent);
      ok(names.includes('mac-mini') && names.includes('studio-linux'), 'hosts ' + names.join(','));
      ok(q('#roster .agent.is-consul'), 'Consul gold row');
      const pills = qa('#roster .agent .pill').map((p) => p.textContent);
      ['idle', 'working', 'offline', 'revoked', 'Consul'].forEach((p) => ok(pills.includes(p), 'missing pill ' + p + ' in ' + pills.join(',')));
      ok(!q('#roster .agent-details'), 'rows should start collapsed');
    });
    await step('agents: host card expands RAM and disk', async () => {
      const card = qa('.rail-card').find((c) => c.textContent.indexOf('mac-mini') !== -1);
      card.click();
      await until(() => q('.rail-details .meter'), 3000, 'host details');
      ok(q('.rail-details').textContent.indexOf('GB') !== -1, 'memory or disk sizes');
    });
    await step('agents: summary row expands details; Chat button is separate', async () => {
      const row = qa('#roster .agent').find((a) => a.textContent.indexOf('@dario') !== -1);
      q('.agent-main', row).click();
      await until(() => q('#roster .agent-details'), 3000, 'agent details');
      ok(q('#roster .agent-details').textContent.indexOf('Last check-in') !== -1);
      ok(q('.agent-chat', row) && !q('.agent-main .agent-chat', row), 'Chat must not be nested in the row button');
    });
    await step('agents: By provider shows adjacent pools, quota and alert', async () => {
      q('.seg-btn[data-group="provider"]').click();
      await until(() => qa('.provider-section').length >= 2, 3000, 'providers');
      const anthropic = qa('.provider-section').find((s) => s.textContent.indexOf('Anthropic') !== -1);
      const pools = qa('.rail-card .rail-name', anthropic).map((n) => n.textContent);
      ok(pools.includes('Claude Max') && pools.includes('Claude Pro'), 'pools ' + pools.join(','));
      ok(!q('#quota-alert').hidden && q('#quota-alert').textContent.indexOf('Claude Pro') !== -1, 'quota alert');
      qa('.rail-card', anthropic)[0].click();
      await until(() => q('.rail-details .meter'), 3000, 'pool details');
      ok(q('.rail-details').textContent.indexOf('left') !== -1, 'quota meters');
      q('.seg-btn[data-group="machine"]').click();
    });
    await step('conversations: pinned first, unread badges, Consul highlight', async () => {
      const titles = qa('#conv-list .group-title').map((t) => t.textContent);
      ok(titles[0] === 'Pinned', 'sections ' + titles.join(','));
      const pinned = q('#conv-list .conv-row');
      ok(pinned.classList.contains('is-consul'), 'pinned Gem conversation shows Consul gold');
      ok(q('.conv-pin', pinned).getAttribute('aria-pressed') === 'true', 'pin state');
      ok(qa('#conv-list .count-badge').length >= 1, 'unread badges');
      ok(!q('#tab-unread').hidden, 'Chats tab total');
      ok(/^\(\d+\) Lyra$/.test(document.title), 'document title ' + document.title);
    });
    await step('thread: Markdown, KaTeX, code, image, lifecycle, no reactions', async () => {
      await openConvByTitle('Dario');
      const box = q('#messages');
      ok(q('.md-table-wrap', box) && q('.katex', box) && q('.md-code-wrap', box), 'rich content');
      ok(q('.image-strip img', box), 'image thumbnail');
      const phases = qa('.msg-lifecycle', box).map((l) => l.getAttribute('data-phase'));
      ok(phases.includes('complete') && phases.includes('working'), 'phases ' + phases.join(','));
      ok(q('.work-card .work-bullet.is-active', box), 'progress bullet card');
      ok(box.textContent.indexOf('👍') === -1 && !q('.reaction', box), 'reaction UI removed');
    });
    await step('read receipt clears the unread badge', async () => {
      await until(() => { const r = convRow('Dario'); return r && !q('.count-badge', r); }, 4000, 'badge cleared');
    });
    await step('imgpop: thumbnail opens the zoom dialog and closes', async () => {
      q('#messages .image-strip img').click();
      await until(() => q('#imgpop-dialog') && q('#imgpop-dialog').open && q('.lyra-imgpop-zoom').textContent === '100%', 4000, 'viewer');
      q('.lyra-imgpop-close').click();
      await until(() => !q('#imgpop-dialog').open, 2000, 'viewer closed');
    });
    await step('drafts persist per conversation', async () => {
      const box = q('#compose-body');
      box.value = 'Draft for Dario\nsecond line';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const keys = Object.keys(localStorage).filter((k) => k.indexOf('lyra.ui.v2.draft.conv:') === 0);
      ok(keys.length && localStorage.getItem(keys[0]).indexOf('Draft for Dario') !== -1, 'draft stored');
      ok(box.getBoundingClientRect().height > 41, 'composer grew');
      await openConvByTitle('Claude');
      ok(q('#compose-body').value === '', 'other conversation starts empty');
      await openConvByTitle('Dario');
      ok(q('#compose-body').value === 'Draft for Dario\nsecond line', 'draft restored: ' + q('#compose-body').value);
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await step('queue: jump message ahead of queue, mode select offers both', async () => {
      await openConvByTitle('Claude');
      const labels = qa('#messages .msg.mine .lc-label').map((l) => l.textContent);
      ok(labels.some((t) => t.indexOf('Waiting in queue (#2)') !== -1), 'labels ' + labels.join(' | '));
      ok(qa('#compose-mode option').length === 2 && !q('#compose-mode').parentElement.hidden, 'mode select');
    });
    await step('unconfirmed delivery offers retry', async () => {
      await openConvByTitle('Echo');
      ok(q('#messages .msg-lifecycle[data-phase="unconfirmed"] .lc-btn'), 'Retry delivery button');
    });
    await step('team conversation is read only', async () => {
      await openConvByTitle('Claude and Dario');
      ok(q('#composer').hidden && !q('#read-only').hidden, 'composer hidden');
    });
    await step('quick switcher: Ctrl+K, fuzzy search, Enter opens', async () => {
      key(document.body, 'k', { ctrlKey: true });
      await until(() => q('#qs-dialog').open, 2000, 'switcher');
      const input = q('#qs-input');
      input.value = 'gem';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ok(q('#qs-list .qs-item[aria-selected="true"]').textContent.indexOf('Gem') !== -1, 'first result');
      key(input, 'Enter');
      await until(() => !q('#qs-dialog').open && q('#conv-header').textContent.indexOf('Gem') !== -1, 3000, 'opened Gem');
    });
    await step('shortcuts: ? help, Alt+Down steps, / focuses composer', async () => {
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      key(document.body, '?');
      await until(() => q('#help-dialog').open, 2000, 'help');
      q('#help-dialog').close();
      const before = q('#conv-header').textContent;
      key(document.body, 'ArrowDown', { altKey: true });
      await until(() => q('#conv-header').textContent !== before, 3000, 'next conversation');
      key(document.body, '/');
      ok(document.activeElement === q('#compose-body') || q('#composer').hidden, 'composer focus');
    });
    await step('projects: list, detail, five task states, filter', async () => {
      q('[data-tab="projects"]').click();
      await until(() => qa('.proj-card').length === 2, 3000, 'projects');
      qa('.proj-card').find((c) => c.textContent.indexOf('Route audit') !== -1).click();
      await until(() => qa('.task').length === 5, 3000, 'tasks');
      const states = qa('.task select').map((s) => s.value).sort();
      ok(JSON.stringify(states) === JSON.stringify(['blocked', 'done', 'in_progress', 'in_review', 'open']), 'states ' + states);
      qa('.filter').find((f) => f.textContent.indexOf('In review') === 0).click();
      await until(() => qa('.task').length === 1, 2000, 'filtered');
      qa('.filter').find((f) => f.textContent === 'All').click();
    });
    await step('task dialog lists only project members and requires one', async () => {
      qa('button').find((b) => b.textContent === 'New task').click();
      await until(() => q('#task-dialog').open, 2000, 'task dialog');
      const names = qa('#tf-assignees .pick').map((p) => p.textContent);
      ok(names.length === 3 && !names.some((n) => n.indexOf('Echo') !== -1), 'assignees ' + names.join(','));
      q('#tf-title').value = 'Probe task';
      q('#task-form').requestSubmit();
      await until(() => q('#tf-error').textContent.indexOf('at least one') !== -1, 2000, 'validation');
      q('#task-dialog').close();
    });
    await step('admin & senate: Consul card, pools, invites, revoked', async () => {
      q('[data-tab="admin-senate"]').click();
      await until(() => q('#senate-status.has-consul'), 3000, 'consul');
      ok(q('#senate-status').textContent.indexOf('Gem') !== -1);
      ok(qa('#pools .list-row').length === 3, 'pools');
      ok(q('#revoked').textContent.indexOf('Old helper') !== -1, 'revoked list');
      ok(q('#invite-form') && q('#senate-form'), 'forms');
    });
    await step('reconnect banner appears on SSE loss and clears on reconnect', async () => {
      await until(() => q('#live').classList.contains('on'), 4000, 'live');
      await fetch('/__qa/drop-sse');
      await until(() => !q('#conn-banner').hidden && q('#conn-text').textContent.indexOf('Reconnecting') !== -1, 5000, 'banner');
      await until(() => q('#live').classList.contains('on'), 8000, 'reconnected');
      await until(() => q('#conn-banner').hidden || q('#conn-banner').classList.contains('is-ok'), 3000, 'banner cleared');
    });
    await step('layout: no horizontal page overflow', async () => { ok(noOverflow(), 'page overflows'); });
  }

  async function mobile() {
    await step('mobile boot', async () => {
      await until(() => !q('#main').hidden && qa('.conv-row').length >= 4, 8000, 'board');
    });
    await step('mobile: four tabs, Agents visible, 44px targets', async () => {
      ok(getComputedStyle(q('.tab-agents')).display !== 'none', 'Agents tab hidden');
      qa('.tab').forEach((t) => ok(tall(t), 'short tab ' + t.textContent));
      q('[data-tab="agents"]').click();
      await until(() => getComputedStyle(q('#pane-agents')).display !== 'none', 2000, 'agents pane');
      qa('.agent-chat').forEach((b) => ok(tall(b), 'short Chat button'));
      ok(noOverflow(), 'agents overflow');
    });
    await step('mobile: list to thread to list drill-down', async () => {
      q('[data-tab="chats"]').click();
      const row = await until(() => convRow('Dario'), 4000, 'row');
      qa('.conv-pin').forEach((b) => ok(tall(b), 'short pin button'));
      q('.conv-main', row).click();
      await until(() => q('.chats').dataset.view === 'thread', 3000, 'thread view');
      ok(getComputedStyle(q('.conv-list-wrap')).display === 'none', 'list should hide');
      const back = q('.conv-back');
      ok(back && tall(back), 'back button');
      ok(noOverflow(), 'thread overflow');
      back.click();
      await until(() => q('.chats').dataset.view === 'list', 2000, 'list view');
    });
    await step('mobile: imgpop uses the near-fullscreen frame', async () => {
      q('.conv-main', convRow('Dario')).click();
      await until(() => q('#messages .image-strip img'), 4000, 'thumb');
      q('#messages .image-strip img').click();
      await until(() => q('#imgpop-dialog').open, 3000, 'viewer');
      const r = q('#imgpop-dialog').getBoundingClientRect();
      ok(Math.abs(r.width - (window.innerWidth - 16)) < 2, 'frame width ' + r.width);
      q('.lyra-imgpop-close').click();
    });
  }

  window.addEventListener('load', async () => {
    const mob = window.innerWidth < 960;
    R.layout = mob ? 'mobile' : 'desktop';
    R.viewport = [window.innerWidth, window.innerHeight];
    try { localStorage.clear(); } catch (_e) { /* ignore */ }
    if (mob) await mobile(); else await desktop();
    const out = document.createElement('pre');
    out.id = 'lyra-qa';
    out.textContent = JSON.stringify(R);
    document.body.appendChild(out);
    document.title = 'LYRA_QA_DONE';
  });
})();
