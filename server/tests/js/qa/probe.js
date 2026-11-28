// QA probe injected by qa_board.QAProxy into "/?qa=probe". Drives the real board through DOM
// events only and writes {results, errors, overflow} into <pre id="lyra-qa">.
(function () {
  'use strict';
  const R = { results: [], errors: [], layout: '', overflow: [] };
  window.addEventListener('error', (e) => R.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => R.errors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));
  window.confirm = () => true;          // cleanup and cancel confirmations
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
  const hook = (q) => fetch('/__qa/' + q).then((r) => r.json());
  const api = (method, path, body) => fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  const convId = (title) => convRow(title).dataset.convId;
  const state = () => JSON.parse(localStorage.getItem('lyra.ui.v2.state'));
  function rgb(c) { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] == null ? 1 : m[3] }; }
  function over(top, base) { return { r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 }; }
  function lum(c) { return [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0); }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  async function pngFile(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 40;
    const g = canvas.getContext('2d'); g.fillStyle = '#facc15'; g.fillRect(0, 0, 64, 40);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return new File([blob], name, { type: 'image/png' });
  }
  async function upload(name) {
    const r = await fetch('/api/v1/attachments', { method: 'POST', credentials: 'same-origin', headers: { 'X-Filename': name },
      body: await pngFile(name) });
    return (await r.json()).attachment;
  }

  // Nothing may cross its container: every visible descendant of a rail card, row or card must stay
  // inside it horizontally, unless an ancestor in between clips it (overflow hidden, auto or scroll).
  const CONTAINERS = '.rail-card, .agent-row, .needs-item, .list-row, .proj-card, .conv-row, .stat, .task, .composer-row, ' +
    '.topbar, .conv-header, .msg .bubble, .provider-head, .rail-details, .storage-head';
  function overflowCheck(where) {
    const found = [];
    for (const c of qa(CONTAINERS)) {
      const cr = c.getBoundingClientRect();
      if (!cr.width || !c.offsetParent) continue;
      for (const e of c.querySelectorAll('*')) {
        if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(e);
        if (cs.position === 'absolute' || cs.position === 'fixed' || cs.visibility === 'hidden') continue;
        if (r.left >= cr.left - 1 && r.right <= cr.right + 1) continue;
        let clipped = false;
        for (let a = e.parentElement; a && a !== c; a = a.parentElement) {
          if (getComputedStyle(a).overflowX !== 'visible') { clipped = true; break; }
        }
        if (clipped) continue;
        found.push(`${where}: <${e.tagName.toLowerCase()} class="${e.className.baseVal != null ? e.className.baseVal : e.className}"> ` +
          `"${(e.textContent || '').trim().slice(0, 40)}" crosses .${String(c.className).split(' ')[0]} by ` +
          `${Math.round(Math.max(cr.left - r.left, r.right - cr.right))}px`);
        break;
      }
    }
    R.overflow.push(...found.slice(0, 12));
    return found;
  }
  async function noCrossing(where) {
    await wait(60);
    const f = overflowCheck(where);
    ok(!f.length, f.slice(0, 3).join(' | '));
    ok(noOverflow(), where + ': the page scrolls sideways');
  }

  async function desktop() {
    await step('boot: board renders agents and conversations', async () => {
      await until(() => !q('#main').hidden && qa('#roster .agent').length >= 6 && qa('.conv-row').length >= 5, 8000, 'board');
    });
    await step('brand: gold logo, yellow wordmark, SVG favicon', async () => {
      ok(q('.brand .lyra-logo') && q('.brand .lyra-logo circle').getAttribute('fill') === '#facc15', 'logo');
      const link = q('link[rel="icon"]');
      ok(link && link.getAttribute('href') === '/static/favicon.svg', 'favicon link');
      const r = await fetch('/static/favicon.svg');
      ok(r.ok && (r.headers.get('content-type') || '').indexOf('image/svg+xml') === 0, 'favicon served as SVG');
      ok((await r.text()).indexOf('#facc15') !== -1, 'favicon is gold');
    });
    await step('tabs: Senate replaces Admin & Senate; Agents tab hidden on desktop', async () => {
      ok(q('[data-tab="senate"]') && q('[data-tab="senate"]').textContent.trim() === 'Senate', 'Senate tab');
      ok(!q('[data-tab="admin-senate"]') && !q('[data-tab="usage"]') && !q('[data-tab="admin"]'), 'old tabs still present');
      ok(getComputedStyle(q('.tab-agents')).display === 'none', 'Agents tab visible on desktop');
    });
    await step('theme: toggle switches and persists Dark and Light', async () => {
      const t = q('#themeToggle');
      const before = t.getAttribute('aria-checked');
      t.click();
      await until(() => t.getAttribute('aria-checked') !== before, 2000, 'toggle');
      const want = t.getAttribute('aria-checked') === 'true' ? 'dark' : 'light';
      ok(document.documentElement.getAttribute('data-theme') === want, 'html data-theme');
      ok(JSON.parse(localStorage.getItem('lyra.ui.v2.state')).theme === want, 'persisted');
      const metas = qa('meta[name="theme-color"]').map((m) => m.getAttribute('content'));
      ok(metas.every((c) => c === (want === 'dark' ? '#18191c' : '#eef0f3')), 'theme-color ' + metas);
      t.click();
      await until(() => t.getAttribute('aria-checked') === before, 2000, 'toggle back');
    });
    await step('needs you: input, stalled, unconfirmed and offline mail, counted in the title', async () => {
      await until(() => !q('#needs').hidden && qa('#needs .needs-item').length === 3, 4000, 'needs section (one per agent)');
      const kinds = qa('#needs .needs-item').map((n) => n.dataset.kinds).join(' ').split(' ');
      ['input', 'stalled', 'unconfirmed', 'offline'].forEach((k) => ok(kinds.includes(k), 'missing ' + k + ' in ' + kinds));
      ok(q('#needs .needs-item[data-kinds="stalled unconfirmed"] .needs-why').textContent ===
        'Stalled: busy with no activity; delivery unconfirmed: check and retry', 'merged reasons');
      ok(q('#needs-title').textContent.indexOf('Needs you (') === 0, 'title');
      const n = Number((document.title.match(/^\((\d+)\) Lyra$/) || [])[1]);
      ok(n >= qa('#needs .needs-item').length, 'document title ' + document.title);
    });
    await step('agents: honest status chips, held pill, context bands, avatars', async () => {
      const chips = qa('#roster .agent .pill[data-status]').map((p) => p.dataset.status);
      ['needs_input', 'stalled', 'working', 'idle', 'offline'].forEach((k) => ok(chips.includes(k), 'chip ' + k + ' in ' + chips));
      ok(qa('#roster .pill.hold').length === 1, 'held pill');
      ok(q('#roster .ctx-ring.bad[data-pct="86"]') && q('#roster .ctx-ring.warn[data-pct="63"]') &&
        q('#roster .ctx-ring.mid[data-pct="41"]') && q('#roster .ctx-ring.ok[data-pct="12"]'), 'context bands');
      ok(q('#roster .avatar.has-image img.avatar-img'), 'Feishu image avatar');
      await until(() => q('#roster .avatar-img').complete && q('#roster .avatar-img').naturalWidth > 0, 4000, 'avatar image loaded');
    });
    await step('agents: rows follow conversation events (unread sync)', async () => {
      const row = () => qa('#roster .agent').find((a) => a.querySelector('.agent-name') && a.querySelector('.agent-name').textContent === 'Claude');
      await until(() => row().querySelector('.agent-extra').textContent.indexOf('1 unread') !== -1, 3000, 'unread shown');
      const id = convId('Claude');
      const msgs = (await api('GET', `/api/v1/conversations/${id}/messages?limit=300`)).data.messages;
      const r = await api('POST', `/api/v1/conversations/${id}/read`, { last_read_message_id: msgs[msgs.length - 1].id });
      ok(r.status === 200, 'read ' + r.status);
      await until(() => row().querySelector('.agent-extra').textContent.indexOf('unread') === -1, 4000, 'unread cleared by the event');
    });
    await step('agents: group switch is a radiogroup with roving tabindex', async () => {
      const m = q('.seg-btn[data-group="machine"]'); const pv = q('.seg-btn[data-group="provider"]');
      ok(m.tabIndex === 0 && pv.tabIndex === -1, 'roving tabindex');
      m.focus();
      key(m, 'ArrowDown');
      await until(() => q('.seg-btn[data-group="provider"]').getAttribute('aria-checked') === 'true', 2000, 'ArrowDown');
      ok(document.activeElement === q('.seg-btn[data-group="provider"]') && q('.seg-btn[data-group="provider"]').tabIndex === 0, 'focus moved');
      key(document.activeElement, 'ArrowUp');
      await until(() => q('.seg-btn[data-group="machine"]').getAttribute('aria-checked') === 'true', 2000, 'ArrowUp');
    });
    await step('quota alert: Show pool stays on the current tab on desktop', async () => {
      const before = state().activeTab;
      q('#quota-alert button').click();
      await until(() => q('.seg-btn[data-group="provider"]').getAttribute('aria-checked') === 'true', 2000, 'provider view');
      ok(state().activeTab === before, 'tab changed to ' + state().activeTab);
      q('.seg-btn[data-group="machine"]').click();
    });
    await step('machines: alias, nowrap host names, explicit GB on bars that fill', async () => {
      q('.seg-btn[data-group="machine"]').click();
      await until(() => qa('.rail-group').length >= 3, 3000, 'host groups');
      const names = qa('.rail-card .rail-name').map((n) => n.textContent);
      ok(names.includes('Malaysia Mac mini') && names.includes('studio-linux') && names.includes('build-box'), 'hosts ' + names);
      qa('.rail-card .rail-name').forEach((n) => ok(getComputedStyle(n).whiteSpace === 'nowrap', 'host name wraps'));
      const gb = qa('.rail-card .rail-gb').map((n) => n.textContent);
      ok(gb.includes('22.5 / 64 GB') && gb.includes('492 / 1858 GB'), 'GB labels ' + gb);
      const fill = q('.rail-card .mini-meter .fill');
      ok(getComputedStyle(fill).display === 'block' && fill.getBoundingClientRect().height > 0 && fill.getBoundingClientRect().width > 0, 'bar fills');
      await noCrossing('by machine');
    });
    await step('machines: Shift+F10 opens the host menu from the keyboard', async () => {
      const card = qa('.rail-card[data-host]').find((c) => c.textContent.indexOf('build-box') !== -1);
      card.focus();
      key(card, 'F10', { shiftKey: true });
      await until(() => !q('#host-menu').hidden, 2000, 'menu');
      key(q('#host-menu'), 'Escape');
      await until(() => q('#host-menu').hidden && document.activeElement && document.activeElement.dataset.host === 'build-box', 2000, 'focus back');
    });
    await step('machines: right-click menu renames a host without prompt()', async () => {
      const card = qa('.rail-card').find((c) => c.textContent.indexOf('studio-linux') !== -1);
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 300 }));
      await until(() => !q('#host-menu').hidden, 2000, 'menu');
      ok(document.activeElement === q('#host-menu [data-act="rename"]'), 'menu focus');
      q('#host-menu [data-act="rename"]').click();
      await until(() => q('#host-dialog').open, 2000, 'dialog');
      q('#host-alias').value = 'GPU studio';
      q('#host-form').requestSubmit();
      await until(() => qa('.rail-card .rail-name').some((n) => n.textContent === 'GPU studio'), 4000, 'renamed');
      ok(!q('#host-dialog').open, 'dialog closed');
    });
    await step('agents: drawer offers Hold/Resume, Mute and status since', async () => {
      const row = qa('#roster .agent').find((a) => a.textContent.indexOf('@claude') !== -1);
      q('.agent-main', row).click();
      await until(() => q('#roster .agent-details'), 3000, 'drawer');
      const labels = qa('#roster .agent-details button').map((b) => b.textContent);
      ok(labels.includes('Resume delivery') && labels.includes('Mute notifications'), 'buttons ' + labels);
      q('#roster .agent-details [aria-pressed]').click();
      await until(() => JSON.parse(localStorage.getItem('lyra.ui.v2.state')).mutedAgentIds.length === 1, 2000, 'mute persisted');
      q('.agent-main', qa('#roster .agent').find((a) => a.textContent.indexOf('@claude') !== -1)).click();
    });
    await step('pools: provider logos, metadata shown once, nothing crosses the rail divider', async () => {
      q('.seg-btn[data-group="provider"]').click();
      await until(() => qa('.provider-section').length >= 4, 3000, 'providers');
      ok(qa('.provider-head .prov svg').length >= 4, 'provider marks');
      const card = q('.rail-card[data-pool-id]') && qa('.rail-card[data-pool-id]').find((c) => c.textContent.indexOf('Google AI Ultra') !== -1);
      ok(card, 'long pool card');
      const repeats = (card.textContent.match(/Google AI Ultra \(MiniMAC\)/g) || []).length;
      ok(repeats === 1, 'label repeated ' + repeats + ' times');
      ok(!q('#quota-alert').hidden && q('#quota-alert').textContent.indexOf('Claude Pro') !== -1, 'quota alert');
      card.click();
      await until(() => q('.rail-details .kv'), 3000, 'pool details');
      await noCrossing('by provider');
      q('.seg-btn[data-group="machine"]').click();
    });
    await step('sidebar: collapse with the button and H, resize with the keyboard, persisted', async () => {
      q('#sidebar-toggle').click();
      await until(() => q('#layout').classList.contains('sidebar-collapsed'), 2000, 'collapsed');
      ok(getComputedStyle(q('#pane-agents')).display === 'none', 'sidebar hidden');
      key(document.body, 'h');
      await until(() => !q('#layout').classList.contains('sidebar-collapsed'), 2000, 'expanded by H');
      q('.seg-btn[data-group="machine"]').focus();
      key(document.activeElement, 'H', { shiftKey: true });
      await until(() => q('#layout').classList.contains('sidebar-collapsed'), 2000, 'collapsed by Shift+H');
      ok(document.activeElement === q('#sidebar-toggle'), 'focus moved out of the hidden sidebar');
      key(document.activeElement, 'h');
      await until(() => !q('#layout').classList.contains('sidebar-collapsed'), 2000, 'expanded again');
      const r = q('#sidebar-resizer');
      r.focus();
      key(r, 'ArrowRight');
      key(r, 'ArrowRight');
      await until(() => getComputedStyle(q('#pane-agents')).width === '392px', 2000, 'width 392 got ' + getComputedStyle(q('#pane-agents')).width);
      ok(JSON.parse(localStorage.getItem('lyra.ui.v2.state')).sidebarWidth === 392, 'persisted width');
      key(r, 'End');
      ok(r.getAttribute('aria-valuenow') === '560', 'clamped max');
      r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await until(() => getComputedStyle(q('#pane-agents')).width === '360px', 2000, 'reset');
    });
    await step('conversations: pinned Consul first, unread badges', async () => {
      const titles = qa('#conv-list .group-title').map((t) => t.textContent);
      ok(titles[0] === 'Pinned', 'sections ' + titles.join(','));
      ok(q('#conv-list .conv-row').classList.contains('is-consul'), 'pinned Gem conversation shows Consul gold');
      ok(qa('#conv-list .count-badge').length >= 1, 'unread badges');
    });
    await step('thread: live agent bubble with steps and timer; receipts under owner messages', async () => {
      await openConvByTitle('Dario');
      const box = q('#messages');
      ok(q('.md-table-wrap', box) && q('.katex', box) && q('.md-code-wrap', box) && q('.image-strip img', box), 'rich content');
      const live = await until(() => q('.msg.live', box), 3000, 'live bubble');
      ok(live === box.lastElementChild, 'live bubble is last');
      ok(q('.live-status[data-phase="working"] .work-bullet.is-active', live), 'steps');
      ok(/^\d+:\d\d$/.test(q('.live-timer', live).textContent), 'timer ' + q('.live-timer', live).textContent);
      ok(q('.avatar', live), 'agent avatar');
      ok(!q('.msg.mine .work-card', box), 'no progress under the owner bubble');
      const kinds = qa('.msg.mine .receipt', box).map((r) => r.dataset.kind);
      ok(kinds.includes('replied') && kinds.includes('read'), 'receipts ' + kinds);
      ok(q('.msg.mine .receipt .rc-label', box).textContent === 'Agent read', 'double-check label');
      ok(box.textContent.indexOf('👍') === -1 && !q('.reaction', box), 'reaction UI removed');
    });
    await step('details: lifecycle modal with milestones and stage latency', async () => {
      qa('#messages .msg.mine .rc-btn').find((b) => b.textContent === 'Details').click();
      await until(() => q('#lifecycle-dialog').open && qa('#lifecycle-body .dur-row').length === 5, 4000, 'details');
      const steps = qa('#lifecycle-body .lc-steps li').map((li) => li.textContent);
      ok(steps.some((s) => s.indexOf('Received by the server') === 0), 'milestones ' + steps);
      ok(q('#lifecycle-body .dur-row.is-total .val').textContent !== 'n/a', 'round trip');
      ok(q('#lifecycle-body table.attempts tbody tr'), 'attempts');
      q('#lifecycle-dialog [data-close]').click();
    });
    await step('details: a late response never replaces the newer selection', async () => {
      const mine = qa('#messages .msg.mine[data-msg-id]');
      const a = mine[0].dataset.msgId; const b = mine[mine.length - 1].dataset.msgId;
      ok(a !== b, 'two owner messages');
      await hook(`stall?path=/api/v1/messages/${a}/lifecycle&ms=1500&count=1`);
      qa(`#messages .msg[data-msg-id="${a}"] .rc-btn`).find((x) => x.textContent === 'Details').click();
      await wait(100);
      q('#lifecycle-dialog').close();
      qa(`#messages .msg[data-msg-id="${b}"] .rc-btn`).find((x) => x.textContent === 'Details').click();
      await until(() => q('#lifecycle-body .storage-head') && q('#lifecycle-body').textContent.indexOf(`Message #${b}`) !== -1, 4000, 'B shown');
      await wait(1800);
      ok(q('#lifecycle-body').textContent.indexOf(`Message #${b}`) !== -1 && q('#lifecycle-body').textContent.indexOf(`Message #${a}:`) === -1, 'late A overwrote B');
      q('#lifecycle-dialog').close();
    });
    await step('markdown colors follow the board theme, not only the OS', async () => {
      const t = q('#themeToggle');
      t.click();
      await wait(80);
      const el = q('#messages .md-color-green');
      const bubble = el.closest('.bubble');
      const bg = rgb(getComputedStyle(bubble).backgroundColor);
      const fg = rgb(getComputedStyle(el).color);
      const wash = over(rgb(getComputedStyle(el).backgroundColor), bg);
      const cr = contrast(fg, wash);
      t.click();
      ok(cr >= 4.5, `contrast ${cr.toFixed(2)} in ${state().theme || 'system'} theme`);
    });
    await step('a11y: receipts are not live regions, live status keeps text, quick switch is a combobox', async () => {
      ok(!q('#messages .receipt [role="status"]'), 'historical receipts announce');
      ok(q('#live .live-text') && q('#live .live-text').textContent === 'live', 'live text');
      const i = q('#qs-input');
      ok(i.getAttribute('role') === 'combobox' && i.getAttribute('aria-expanded') === 'true' && i.getAttribute('aria-autocomplete') === 'list', 'combobox');
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
    await step('composer: paperclip control with tooltip; draft text and images persist', async () => {
      const attach = q('#compose-attach');
      ok(attach.getAttribute('aria-label') === 'Attach image' && !attach.disabled, 'enabled for an image agent');
      ok(q('#compose-attach-tip').getAttribute('data-tip') === 'Attach image', 'tooltip');
      ok(q('#compose-attach svg'), 'icon');
      // The upload is still running when the owner switches chats: it must land in Dario's draft.
      await hook('stall?path=/api/v1/attachments&ms=1500&count=1');
      const dt = new DataTransfer();
      dt.items.add(await pngFile('sketch.png'));
      q('#composer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await until(() => q('#compose-attachments .staged-uploading'), 2000, 'uploading tile');
      await openConvByTitle('Echo');
      await wait(2000);
      await openConvByTitle('Dario');
      await until(() => q('#compose-attachments .staged-image img'), 4000, 'upload saved into the originating draft');
      const box = q('#compose-body');
      box.value = 'Draft for Dario';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const keyName = Object.keys(localStorage).find((k) => k.indexOf('lyra.ui.v2.draft.conv:') === 0);
      ok(JSON.parse(localStorage.getItem(keyName)).attachments.length === 1, 'image in the draft');
      await openConvByTitle('Echo');
      ok(!q('#compose-attachments .staged-image'), 'other conversation has no images');
      await openConvByTitle('Dario');
      ok(q('#compose-body').value === 'Draft for Dario', 'text restored');
      await until(() => q('#compose-attachments .staged-image img'), 3000, 'image restored');
      await noCrossing('composer');
      q('#compose-attachments .remove').click();
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await step('draft images: a transient error keeps the image, a 404 removes it', async () => {
      const keep = await upload('keep.png');
      const gone = await upload('gone.png');
      const kimi = convId('Kimi'); const codex = convId('Codex');
      const draft = (img) => JSON.stringify({ text: '', replyToId: null, mode: 'queue', updatedAt: 1,
        attachments: [{ id: img.id, filename: img.filename, mime_type: 'image/png', size_bytes: img.size_bytes }] });
      localStorage.setItem('lyra.ui.v2.draft.conv:' + kimi, draft(keep));       // drafts from an earlier session
      localStorage.setItem('lyra.ui.v2.draft.conv:' + codex, draft(gone));
      // Re-renders may request a thumbnail again, so the injected outage covers a few requests.
      await hook(`fail?path=/api/v1/attachments/${keep.id}&status=503&count=3`);
      await openConvByTitle('Kimi');
      await until(() => q('#compose-attachments .staged-retry'), 4000, 'retry tile after a 503');
      ok(JSON.parse(localStorage.getItem('lyra.ui.v2.draft.conv:' + kimi)).attachments.length === 1, 'kept in the draft');
      await wait(300);
      await hook(`fail?path=/api/v1/attachments/${keep.id}&status=503&count=0`);
      const retry = await until(() => q('#compose-attachments .staged-retry'), 2000, 'still a retry tile');
      retry.click();
      await until(() => q('#compose-attachments .staged-image img') && q('#compose-attachments .staged-image img').naturalWidth > 0, 4000, 'loads on retry');
      await hook(`fail?path=/api/v1/attachments/${gone.id}&status=404&count=8`);
      await openConvByTitle('Codex');
      await until(() => q('#compose-error').textContent.indexOf('no longer on the server') !== -1, 4000, 'pruned after a 404');
      const left = localStorage.getItem('lyra.ui.v2.draft.conv:' + codex);
      ok(!left || JSON.parse(left).attachments.length === 0, 'removed from the draft');
      ok(!q('#compose-attachments .staged-image'), 'no tile');
    });
    await step('cancel: a message claimed first answers 409 and says it is too late', async () => {
      await until(() => q('#messages .receipt[data-kind="server"] .rc-btn'), 3000, 'Cancel on the waiting message');
      const waitingId = q('#messages .receipt[data-kind="server"]').closest('.msg').dataset.msgId;
      await hook(`expect?path=/api/v1/messages/${waitingId}/cancel`);
      const claimed = await hook('claim?handle=codex&ack=none');
      ok(claimed.message_id, 'codex claimed ' + JSON.stringify(claimed));
      qa('#messages .receipt[data-kind="server"] .rc-btn').find((b) => b.textContent === 'Cancel').click();
      await until(() => q('#compose-error').textContent.indexOf('Too late to cancel') === 0, 4000, '409 message');
    });
    await step('queue: held agent, cancel a waiting message, cancelled receipt, text-only attach', async () => {
      await openConvByTitle('Claude');
      ok(q('#conv-header .pill.hold'), 'held pill in header');
      const labels = qa('#messages .msg.mine .rc-label').map((l) => l.textContent);
      ok(labels.includes('Server, #2 in queue') && labels.includes('Cancelled'), 'labels ' + labels.join(' | '));
      const attach = q('#compose-attach');
      ok(!attach.disabled && attach.getAttribute('aria-disabled') === 'true' && attach.getAttribute('aria-label').indexOf('Text only') === 0, 'text-only attach');
      attach.focus();
      ok(document.activeElement === attach, 'still focusable');
      await until(() => getComputedStyle(q('#compose-attach-tip'), '::after').opacity === '1', 2000, 'tooltip on focus');
      const files = q('#compose-files'); let opened = false;
      const spy = () => { opened = true; };
      files.addEventListener('click', spy, { once: true });
      attach.click();
      ok(!opened, 'file picker opened while disabled');
      files.removeEventListener('click', spy);
      attach.blur();
      const before = qa('#messages .receipt[data-kind="cancelled"]').length;
      q('#messages .receipt[data-kind="server"] .rc-btn').click();
      await until(() => qa('#messages .receipt[data-kind="cancelled"]').length === before + 1, 4000, 'cancelled');
    });
    await step('needs input: live bubble asks for input; N steps through Needs you', async () => {
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      key(document.body, 'n');
      await until(() => q('#conv-header .who-name') && q('#conv-header .who-name').textContent.indexOf('Kimi') !== -1, 4000, 'Kimi first');
      await until(() => q('#messages .msg.live.is-input_required'), 4000, 'input bubble');
      ok(q('#messages .msg.live .live-label').textContent.indexOf('Needs your input') === 0, 'label');
      key(document.body, 'n');
      await until(() => q('#conv-header .who-name').textContent.indexOf('Echo') !== -1, 4000, 'Echo next');
    });
    await step('unconfirmed: Retry re-queues, the agent claims again, Details shows two attempts', async () => {
      const retryBtn = await until(() => qa('#messages .receipt[data-kind="unconfirmed"] .rc-btn').find((b) => b.textContent === 'Retry'), 4000, 'Retry button');
      const msg = retryBtn.closest('.msg').dataset.msgId;
      retryBtn.click();
      await until(() => q(`#messages .msg[data-msg-id="${msg}"] .receipt[data-kind="server"]`), 4000, 're-queued');
      ok(q(`#messages .msg[data-msg-id="${msg}"] .pill`).textContent === 'retried', 'retried pill');
      const claimed = await hook('claim?handle=echo&ack=delivered');
      ok(String(claimed.message_id) === msg, 'echo claimed ' + JSON.stringify(claimed));
      await until(() => q(`#messages .msg[data-msg-id="${msg}"] .receipt[data-kind="read"]`), 4000, 'agent read');
      qa(`#messages .msg[data-msg-id="${msg}"] .rc-btn`).find((b) => b.textContent === 'Details').click();
      await until(() => qa('#lifecycle-body table.attempts tbody tr').length === 2, 4000, 'two attempts');
      ok(q('#lifecycle-body table.attempts tbody tr:last-child').textContent.indexOf('delivered') !== -1, 'new attempt delivered');
      q('#lifecycle-dialog').close();
    });
    await step('x jumps to the next unread conversation', async () => {
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      const unread = qa('.conv-row.unread').map((r) => r.dataset.convId);
      ok(unread.length >= 1, 'unread rows');
      key(document.body, 'X', { shiftKey: true });
      await until(() => q('.conv-row.active') && unread.includes(q('.conv-row.active').dataset.convId), 3000, 'X opened an unread conversation');
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
      ok(q('#help-dialog').textContent.indexOf('needs you') !== -1, 'help lists N');
      q('#help-dialog').close();
      const before = q('#conv-header').textContent;
      key(document.body, 'ArrowDown', { altKey: true });
      await until(() => q('#conv-header').textContent !== before, 3000, 'next conversation');
      key(document.body, '/');
      ok(document.activeElement === q('#compose-body') || q('#composer').hidden, 'composer focus');
    });
    await step('notifications: explicit toggle turns on once permission is granted', async () => {
      const b = q('#notifyToggle');
      ok(b.getAttribute('aria-pressed') === 'false', 'off by default');
      b.click();
      await until(() => b.getAttribute('aria-pressed') === 'true', 3000, 'on (permission ' + Notification.permission + ')');
      ok(JSON.parse(localStorage.getItem('lyra.ui.v2.state')).notify === true, 'persisted');
    });
    await step('projects: counts bar, six task states, blocked reason, cancelled', async () => {
      q('[data-tab="projects"]').click();
      await until(() => qa('.proj-card').length === 2, 3000, 'projects');
      ok(q('.proj-card .count-bar span'), 'count bar');
      qa('.proj-card').find((c) => c.textContent.indexOf('Route audit') !== -1).click();
      await until(() => qa('.task').length === 6, 3000, 'tasks');
      const states = qa('.task select').map((s) => s.value).sort();
      ok(JSON.stringify(states) === JSON.stringify(['blocked', 'cancelled', 'done', 'in_progress', 'in_review', 'open']), 'states ' + states);
      ok(q('.task.is-blocked .task-blocked').textContent.indexOf('Blocked: Waiting for the GPU node') === 0, 'blocked reason');
      ok(getComputedStyle(q('.task.is-cancelled .task-title')).textDecorationLine === 'line-through', 'cancelled style');
      const taskFilters = () => qa('[aria-label="Filter tasks by status"] .filter');
      taskFilters().find((f) => f.textContent.indexOf('Cancelled') === 0).click();
      await until(() => qa('.task').length === 1, 2000, 'filtered');
      taskFilters().find((f) => f.textContent === 'All').click();
      await until(() => qa('.task').length === 6, 2000, 'all tasks again');
      await noCrossing('projects');
    });
    await step('tasks: choosing Blocked asks for a reason; saves with expected_version', async () => {
      const t = await until(() => qa('.task').find((x) => x.textContent.indexOf('Write QA checklist') !== -1), 3000, 'task row');
      const sel = q('select', t);
      sel.value = 'blocked';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => q('#task-dialog').open && !q('#tf-blocked-wrap').hidden, 2000, 'blocked dialog');
      ok(document.activeElement === q('#tf-blocked'), 'reason focused');
      q('#tf-blocked').value = 'Needs the final rubric';
      q('#task-form').requestSubmit();
      await until(() => !q('#task-dialog').open, 3000, 'saved');
      await until(() => qa('.task-blocked').some((b) => b.textContent === 'Blocked: Needs the final rubric'), 4000, 'reason shown');
    });
    await step('tasks: a second editor\'s save is never overwritten silently (CAS)', async () => {
      const row = await until(() => qa('.task').find((x) => x.querySelector('.task-title').textContent === 'KaTeX font MIME types'), 3000, 'task');
      qa('button', row).find((b) => b.textContent === 'Edit').click();
      await until(() => q('#task-dialog').open, 2000, 'dialog');
      q('#tf-title').value = 'KaTeX font MIME types (mine)';
      // Another editor saves meanwhile, and a board refresh arrives while the dialog stays open.
      const proj = (await api('GET', '/api/v1/projects')).data.projects.find((p) => p.name === 'Route audit');
      const t = proj.tasks.find((x) => x.title === 'KaTeX font MIME types');
      const other = await api('PATCH', `/api/v1/tasks/${t.id}`, { title: 'KaTeX font MIME types (theirs)', expected_version: t.version });
      ok(other.status === 200, 'other editor ' + other.status);
      await until(() => qa('.task-title').some((x) => x.textContent === 'KaTeX font MIME types (theirs)'), 4000, 'refresh with theirs');
      ok(q('#task-dialog').open && q('#tf-title').value === 'KaTeX font MIME types (mine)', 'edits kept during refresh');
      await hook(`expect?path=/api/v1/tasks/${t.id}`);
      q('#task-form').requestSubmit();
      await until(() => !q('#tf-conflict').hidden, 4000, 'conflict shown');
      ok(q('#tf-conflict-fields').textContent.indexOf('KaTeX font MIME types (theirs)') !== -1, 'their version listed');
      ok(qa('.task-title').some((x) => x.textContent === 'KaTeX font MIME types (theirs)'), 'theirs not overwritten');
      ok(q('#tf-title').value === 'KaTeX font MIME types (mine)', 'my edits kept');
      q('#task-form').requestSubmit();
      await until(() => !q('#task-dialog').open, 4000, 'deliberate save');
      await until(() => qa('.task-title').some((x) => x.textContent === 'KaTeX font MIME types (mine)'), 4000, 'mine saved');
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
    await step('senate: Consul card, pools with logos, invites, revoked', async () => {
      q('[data-tab="senate"]').click();
      await until(() => q('#senate-status.has-consul'), 3000, 'consul');
      ok(q('#senate-status').textContent.indexOf('Gem') !== -1);
      ok(qa('#pools .list-row').length === 5, 'pools');
      ok(qa('#pools .pool-title .prov').length === 5, 'pool provider logos');
      ok(q('#revoked').textContent.indexOf('Old helper') !== -1, 'revoked list');
      await noCrossing('senate');
    });
    await step('storage: usage against the 10 GB quota, breakdown, cleanup refreshes', async () => {
      ok(q('#storage .storage-used').textContent.indexOf('used of 10 GB') !== -1, 'quota ' + q('#storage .storage-used').textContent);
      const stats = qa('#storage .stat dt').map((d) => d.textContent);
      ['Database', 'Attachments', 'Orphaned uploads', 'Backups', 'Events', 'Messages', 'Host disk'].forEach((s) => ok(stats.includes(s), 'stat ' + s));
      qa('[data-cleanup]').find((b) => b.dataset.cleanup === 'vacuum_wal').click();
      await until(() => q('#storage-result').textContent === 'Done: WAL compacted.', 4000, 'cleanup result');
      qa('[data-cleanup]').find((b) => b.dataset.cleanup === 'all').click();
      await until(() => q('#storage-result').textContent.indexOf('Done: 0 orphaned uploads removed') === 0, 4000, 'full cleanup');
    });
    await step('reconnect banner appears on SSE loss and clears on reconnect', async () => {
      await until(() => q('#live').classList.contains('on'), 4000, 'live');
      await fetch('/__qa/drop-sse');
      await until(() => !q('#conn-banner').hidden && q('#conn-text').textContent.indexOf('Reconnecting') !== -1, 5000, 'banner');
      await until(() => q('#live').classList.contains('on'), 8000, 'reconnected');
      await until(() => q('#conn-banner').hidden || q('#conn-banner').classList.contains('is-ok'), 3000, 'banner cleared');
    });
    await step('reset: the reload retries after a 503 and the banner clears', async () => {
      await until(() => q('#live').classList.contains('on') && q('#conn-banner').hidden, 8000, 'calm');
      await hook('fail?path=/api/v1/board&status=503&count=1');
      await hook('reset-next');
      await fetch('/__qa/drop-sse');
      await until(() => !q('#conn-banner').hidden && q('#conn-text').textContent.indexOf('Resyncing') !== -1, 8000, 'resync banner');
      await until(() => q('#conn-banner').hidden && q('#live').classList.contains('on'), 10000, 'resynced');
      ok(qa('#roster .agent').length >= 6, 'board reloaded');
    });
    await step('reconnect: a stalled /auth/me never delays the banner or the retry', async () => {
      await hook('stall?path=/api/v1/auth/me&ms=8000&count=1');
      await fetch('/__qa/drop-sse');
      const t0 = Date.now();
      await until(() => !q('#conn-banner').hidden && q('#conn-text').textContent.indexOf('Reconnecting') !== -1, 2000, 'banner');
      ok(Date.now() - t0 < 1500, 'banner after ' + (Date.now() - t0) + ' ms');
      await until(() => q('#live').classList.contains('on'), 6000, 'reconnected while /auth/me stalls');
    });
    await step('layout: no horizontal page overflow', async () => { ok(noOverflow(), 'page overflows'); });
  }

  async function mobile() {
    await step('mobile boot', async () => {
      await until(() => !q('#main').hidden && qa('.conv-row').length >= 5, 8000, 'board');
    });
    await step('mobile: four tabs fit, Senate label, Agents tab shows the needs count, 44px targets', async () => {
      ok(getComputedStyle(q('.tab-agents')).display !== 'none', 'Agents tab hidden');
      ok(!q('#tab-needs').hidden, 'needs badge');
      qa('.tab').forEach((t) => { ok(tall(t), 'short tab ' + t.textContent); ok(t.getBoundingClientRect().right <= innerWidth, 'tab off screen ' + t.textContent); });
      ok(tall(q('#themeToggle')) && tall(q('#notifyToggle')), 'topbar controls');
      ok(getComputedStyle(q('#sidebar-toggle')).display === 'none', 'no desktop sidebar toggle');
      await noCrossing('mobile chats');
    });
    await step('mobile: agents tab with Needs you; pools without overflow', async () => {
      q('[data-tab="agents"]').click();
      await until(() => getComputedStyle(q('#pane-agents')).display !== 'none' && !q('#needs').hidden, 2000, 'agents pane');
      qa('.agent-chat').forEach((b) => ok(tall(b), 'short Chat button'));
      await noCrossing('mobile machines');
      q('.seg-btn[data-group="provider"]').click();
      await until(() => qa('.provider-section').length >= 4, 3000, 'providers');
      await noCrossing('mobile pools');
      q('.seg-btn[data-group="machine"]').click();
    });
    await step('mobile: list to thread to list drill-down with the live bubble', async () => {
      q('[data-tab="chats"]').click();
      const row = await until(() => convRow('Dario'), 4000, 'row');
      qa('.conv-pin').forEach((b) => ok(tall(b), 'short pin button'));
      q('.conv-main', row).click();
      await until(() => q('.chats').dataset.view === 'thread' && q('#messages .msg.live'), 3000, 'thread view');
      ok(getComputedStyle(q('.conv-list-wrap')).display === 'none', 'list should hide');
      ok(tall(q('#compose-attach')), 'attach target 44px');
      await noCrossing('mobile thread');
      const back = q('.conv-back');
      ok(back && tall(back), 'back button');
      back.click();
      await until(() => q('.chats').dataset.view === 'list', 2000, 'list view');
    });
    await step('mobile: 44 px targets for receipts, copy, delivery, Show pool; live text stays readable', async () => {
      const big = (el, what) => { const r = el.getBoundingClientRect(); ok(r.height >= 43.5 && r.width > 0, `${what} is ${Math.round(r.width)}x${Math.round(r.height)}`); };
      q('.conv-main', convRow('Dario')).click();
      await until(() => q('.chats').dataset.view === 'thread' && q('#messages .rc-btn') && q('#messages .md-code-copy'), 4000, 'thread');
      qa('#messages .rc-btn').forEach((b) => big(b, 'receipt button'));
      qa('#messages .md-code-copy').forEach((b) => big(b, 'copy button'));
      big(q('#compose-mode'), 'delivery select');
      big(q('#compose-attach'), 'attach');
      ok(q('#live .live-text').textContent === 'live' && q('#live .live-text').getBoundingClientRect().width <= 1, 'visually hidden live text');
      q('.conv-back').click();
      q('[data-tab="agents"]').click();
      await until(() => q('#quota-alert button').getBoundingClientRect().height > 0, 2000, 'agents tab');
      big(q('#quota-alert button'), 'Show pool');
      q('[data-tab="chats"]').click();
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
    await step('mobile: task assignee buttons are 44 px', async () => {
      q('[data-tab="projects"]').click();
      await until(() => qa('.proj-card').length === 2, 3000, 'projects');
      qa('.proj-card').find((c) => c.textContent.indexOf('Route audit') !== -1).click();
      await until(() => qa('.task').length === 6, 3000, 'tasks');
      qa('.task-who button').forEach((b) => ok(tall(b) && b.getBoundingClientRect().width >= 43.5, 'short assignee button'));
      await noCrossing('mobile tasks');
    });
    await step('mobile: senate and storage fit the phone', async () => {
      q('[data-tab="senate"]').click();
      await until(() => q('#storage .storage-used'), 3000, 'storage');
      await noCrossing('mobile senate');
    });
  }

  window.addEventListener('load', async () => {
    const mob = window.innerWidth < 960;
    R.layout = mob ? 'mobile' : 'desktop';
    R.viewport = [window.innerWidth, window.innerHeight];
    R.theme = document.getElementById('themeToggle').getAttribute('aria-checked') === 'true' ? 'dark' : 'light';
    try { localStorage.clear(); } catch (_e) { /* ignore */ }
    if (mob) await mobile(); else await desktop();
    const out = document.createElement('pre');
    out.id = 'lyra-qa';
    out.textContent = JSON.stringify(R);
    document.body.appendChild(out);
  });
})();
