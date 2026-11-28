// Lyra board. All text is inserted with DOM text nodes; no HTML strings are ever parsed.
'use strict';

const S = { me: null, board: null, convs: [], conv: null, msgs: [], usage: [], replyTo: null,
  tab: 'board', es: null, timer: null, sending: false };
const QUICK = ['👍', '✅', '👀', '❤️', '😄'];
const $ = (id) => document.getElementById(id);

// --- DOM helpers ----------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function clock(ts) {
  return ts ? new Date(ts * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit',
    month: 'short', day: 'numeric' }) : '';
}

// Safe Markdown subset: fenced code, inline code, **bold**, https links.
function inline(text) {
  const out = [];
  const rx = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https:\/\/[^\s<>"')\]]+)/g;
  let last = 0; let m;
  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) out.push(h('code', { text: m[1].slice(1, -1) }));
    else if (m[2]) out.push(h('strong', { text: m[2].slice(2, -2) }));
    else out.push(h('a', { href: m[3], target: '_blank', rel: 'noopener noreferrer', text: m[3] }));
    last = rx.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function renderBody(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text || '').split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      frag.append(h('pre', {}, h('code', { text: part.replace(/^[a-zA-Z0-9_-]*\n/, '') })));
      return;
    }
    const lines = part.split('\n');
    lines.forEach((line, j) => {
      inline(line).forEach((n) => frag.append(n));
      if (j < lines.length - 1) frag.append(h('br'));
    });
  });
  return frag;
}

// --- API ------------------------------------------------------------------

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (_e) { data = {}; }
  if (res.status === 401 && path !== '/api/v1/auth/login') { showLogin(); }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// --- session --------------------------------------------------------------

function showLogin() {
  $('main').hidden = true; $('login').hidden = false;
  if (S.es) { S.es.close(); S.es = null; }
}

async function boot() {
  try {
    const r = await api('GET', '/api/v1/auth/me');
    S.me = r.user;
    $('login').hidden = true; $('main').hidden = false;
    connectEvents();
    await refreshAll();
  } catch (_e) { showLogin(); }
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('POST', '/api/v1/auth/login', { username: $('login-user').value,
      password: $('login-pass').value, remember: $('login-remember').checked });
    $('login-pass').value = '';
    await boot();
  } catch (e) { $('login-error').textContent = e.message; }
});

$('logout').addEventListener('click', async () => {
  try { await api('POST', '/api/v1/auth/logout', {}); } catch (_e) { /* ignore */ }
  showLogin();
});

// --- live updates ---------------------------------------------------------

function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/v1/events');
  S.es = es;
  es.onopen = () => { $('live').textContent = 'live'; $('live').classList.add('on'); };
  es.onerror = () => { $('live').textContent = 'reconnecting'; $('live').classList.remove('on'); };
  for (const t of ['presence', 'principal', 'invite', 'pool', 'message', 'message_state', 'reaction']) {
    es.addEventListener(t, scheduleRefresh);
  }
}

function scheduleRefresh() {
  clearTimeout(S.timer);
  S.timer = setTimeout(() => { refreshAll().catch(() => {}); }, 250);
}

async function refreshAll() {
  const [board, convs, usage] = await Promise.all([
    api('GET', '/api/v1/board'), api('GET', '/api/v1/conversations'), api('GET', '/api/v1/usage')]);
  S.board = board; S.convs = convs.conversations; S.usage = usage.providers;
  renderRoster(); renderConvList(); renderUsage(); renderAdmin();
  if (S.conv) await loadConv(S.conv.id, true);
}

// --- tabs -----------------------------------------------------------------

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// --- roster ---------------------------------------------------------------

function agentCard(a) {
  const p = a.presence || {}; const st = p.status || {};
  const unknown = (v) => (v === null || v === undefined || v === '' ? 'unknown' : v);
  const busy = st.busy === true ? h('span', { class: 'pill busy', text: 'busy' })
    : st.busy === false ? h('span', { class: 'pill idle', text: 'idle' })
      : h('span', { class: 'pill', text: 'activity unknown' });
  const ctx = typeof st.context_pct === 'number' ? `${Math.round(st.context_pct)}%` : 'unknown';
  const modes = (p.modes || ['queue']).map((m) => (m === 'jump' ? 'Jump queue' : 'Queue')).join(', ');
  const actions = h('div', { class: 'agent-actions' });
  if (a.status === 'admitted') {
    actions.append(
      h('button', { onclick: () => openWith(a) }, 'Message'),
      h('button', { class: 'danger', onclick: () => revoke(a) }, 'Revoke'),
      h('button', { class: 'secondary', disabled: true,
        title: 'Recovery is planned for a later version' }, 'Recover'),
    );
  } else {
    actions.append(h('button', { class: 'secondary', onclick: () => readmit(a) }, 'Re-admit'));
  }
  const poolSel = h('select', { 'aria-label': 'Pool', onchange: (ev) => setPool(a, ev.target.value) },
    h('option', { value: '', text: 'No pool' }),
    ...(S.board.pools || []).map((pl) => h('option', { value: pl.id, selected: a.pool && a.pool.id === pl.id,
      text: `${pl.provider}: ${pl.label}` })));
  return h('div', { class: 'card agent' },
    h('div', { class: 'agent-head' },
      h('span', { class: `dot ${p.online ? 'on' : ''}`, title: p.online ? 'online' : 'offline' }),
      h('span', { class: 'agent-name', text: a.display_name }),
      h('span', { class: 'muted', text: `@${a.handle}` }),
      a.status === 'admitted' ? busy : h('span', { class: 'pill', text: a.status })),
    h('div', { class: 'agent-meta' },
      h('span', { text: `last check-in ${ago(p.last_checkin_at)}` }),
      h('span', { text: `model ${unknown(st.model)}${st.effort ? ` (${st.effort})` : ''}` }),
      h('span', { text: `context ${ctx}` }),
      h('span', { text: `delivery ${modes}` }),
      h('span', { text: `waiting ${a.waiting}${a.unconfirmed ? `, unconfirmed ${a.unconfirmed}` : ''}` })),
    h('div', { class: 'agent-meta' },
      h('span', { text: `${unknown(p.provider)} / ${unknown(p.runtime)} / ${unknown(p.connector)}` }),
      h('span', { text: `host ${unknown(p.host)}` }),
      h('span', { text: a.address || '' }),
      st.attached === false ? h('span', { class: 'stale', text: 'stream not attached' }) : null),
    h('div', { class: 'agent-meta' }, h('label', {}, 'Pool', poolSel),
      a.pool && a.pool.is_reporter ? h('span', { class: 'pill', text: 'usage reporter' }) : null),
    actions);
}

function renderRoster() {
  const root = clear($('roster'));
  const agents = S.board.agents || [];
  const groups = [['Online', agents.filter((a) => a.status === 'admitted' && a.presence.online)],
    ['Offline', agents.filter((a) => a.status === 'admitted' && !a.presence.online)],
    ['Revoked', agents.filter((a) => a.status !== 'admitted')]];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    root.append(h('div', { class: 'group-label', text: `${label} (${list.length})` }));
    list.forEach((a) => root.append(agentCard(a)));
  }
  if (!agents.length) root.append(h('p', { class: 'muted', text: 'No agents yet. Create an invite on the Admin tab.' }));
}

async function revoke(a) {
  if (!window.confirm(`Revoke ${a.display_name}? Its waiting messages will fail.`)) return;
  try { await api('POST', `/api/v1/admin/principals/${a.id}/revoke`, {}); await refreshAll(); }
  catch (e) { window.alert(e.message); }
}

async function readmit(a) {
  try {
    const r = await api('POST', '/api/v1/admin/invites', { target_principal_id: a.id });
    showCode(r.code, a.display_name); setTab('admin'); await refreshAll();
  } catch (e) { window.alert(e.message); }
}

async function setPool(a, value) {
  try { await api('PATCH', `/api/v1/admin/principals/${a.id}`, { pool_id: value === '' ? null : Number(value) }); await refreshAll(); }
  catch (e) { window.alert(e.message); }
}

// --- conversations --------------------------------------------------------

function convTitle(c) {
  const names = c.members.filter((m) => m.kind !== 'owner').map((m) => m.display_name);
  return c.kind === 'agent_agent' ? `${names.join(' and ')} (team)` : names.join(', ');
}

function renderConvList() {
  const root = clear($('conv-list'));
  const own = S.convs.filter((c) => c.kind === 'owner_agent');
  const team = S.convs.filter((c) => c.kind === 'agent_agent');
  const item = (c) => h('button', { class: `conv ${S.conv && S.conv.id === c.id ? 'active' : ''}`,
    onclick: () => loadConv(c.id) }, convTitle(c), h('small', { text: c.last ? c.last.excerpt : 'no messages yet' }));
  if (own.length) { root.append(h('div', { class: 'group-label', text: 'With you' })); own.forEach((c) => root.append(item(c))); }
  if (team.length) { root.append(h('div', { class: 'group-label', text: 'Team (read-only)' })); team.forEach((c) => root.append(item(c))); }
  if (!S.convs.length) root.append(h('p', { class: 'muted', text: 'No conversations yet.' }));
}

function openWith(agent) {
  const c = S.convs.find((x) => x.kind === 'owner_agent' && x.members.some((m) => m.id === agent.id));
  setTab('chats');
  if (c) { loadConv(c.id); return; }
  S.conv = { id: null, kind: 'owner_agent', pendingTo: agent };
  S.msgs = []; S.replyTo = null;
  renderConv();
}

async function loadConv(id, quiet) {
  try {
    const r = await api('GET', `/api/v1/conversations/${id}/messages`);
    const meta = S.convs.find((c) => c.id === id) || {};
    S.conv = { id, kind: r.kind, read_only: r.read_only, members: meta.members || [] };
    S.msgs = r.messages;
    if (!quiet) { S.replyTo = null; setTab('chats'); }
    renderConvList(); renderConv();
  } catch (e) { if (!quiet) window.alert(e.message); }
}

function recipientAgent() {
  if (!S.conv) return null;
  if (S.conv.pendingTo) return S.conv.pendingTo;
  const m = (S.conv.members || []).find((x) => x.kind === 'agent');
  return m ? (S.board.agents || []).find((a) => a.id === m.id) : null;
}

function stateBadge(m) {
  const label = { waiting: m.queue_position ? `Waiting (#${m.queue_position})` : 'Waiting',
    delivered: 'Delivered', unconfirmed: 'Delivery unconfirmed', failed: 'Failed' }[m.state] || m.state;
  const title = [m.state_reason, m.attempts ? `attempts ${m.attempts}` : null].filter(Boolean).join(', ');
  return h('span', { class: `state ${m.state}`, title: title || null },
    label + (m.state === 'failed' && m.state_reason ? `: ${m.state_reason}` : ''));
}

function renderConv() {
  const root = clear($('messages'));
  const agent = recipientAgent();
  const header = $('conv-header');
  if (!S.conv) { header.textContent = 'Select a conversation.'; $('composer').hidden = true; return; }
  header.textContent = S.conv.kind === 'agent_agent'
    ? `Team conversation: ${(S.conv.members || []).map((m) => m.display_name).join(' and ')}`
    : `Conversation with ${agent ? agent.display_name : 'agent'}${agent && !agent.presence.online ? ' (offline: messages wait)' : ''}`;
  const meId = S.board.owner && S.board.owner.id;
  for (const m of S.msgs) {
    const mine = m.sender.id === meId;
    const foot = h('div', { class: 'msg-foot' });
    if (m.recipient.kind === 'agent' || mine) foot.append(stateBadge(m));
    const grouped = {};
    for (const r of m.reactions) { (grouped[r.emoji] = grouped[r.emoji] || []).push(r); }
    for (const [emoji, list] of Object.entries(grouped)) {
      const minePick = list.some((r) => r.by === meId);
      foot.append(h('button', { class: `reaction ${minePick ? 'mine' : ''}`, title: list.map((r) => r.by_name).join(', '),
        disabled: S.conv.read_only, onclick: () => toggleReaction(m, emoji, minePick) }, `${emoji} ${list.length}`));
    }
    if (!S.conv.read_only) {
      foot.append(h('button', { class: 'link', onclick: () => { S.replyTo = m; renderComposer(); } }, 'Reply'));
      QUICK.forEach((e) => {
        if (!grouped[e]) foot.append(h('button', { class: 'link', title: `React ${e}`, onclick: () => toggleReaction(m, e, false) }, e));
      });
      if (m.state === 'unconfirmed') foot.append(h('button', { class: 'secondary', onclick: () => retry(m) }, 'Retry delivery'));
    }
    root.append(h('div', { class: `msg ${mine ? 'mine' : ''}` },
      h('div', { class: 'msg-head' }, h('strong', { text: m.sender.display_name }),
        h('span', { text: `to ${m.recipient.display_name}` }), h('span', { text: clock(m.created_at) }),
        m.mode === 'jump' ? h('span', { class: 'pill', text: 'Jump queue' }) : null,
        m.retry ? h('span', { class: 'pill', text: 'retried' }) : null),
      m.reply_to ? h('div', { class: 'quote', text: `${m.reply_to.sender_name}: ${m.reply_to.excerpt}` }) : null,
      h('div', { class: 'msg-body' }, renderBody(m.body)), foot));
  }
  root.scrollTop = root.scrollHeight;
  renderComposer();
}

function renderComposer() {
  const ro = S.conv && (S.conv.read_only || S.conv.kind === 'agent_agent');
  $('read-only').hidden = !ro;
  $('composer').hidden = !S.conv || ro;
  if (!S.conv || ro) return;
  const agent = recipientAgent();
  const modes = (agent && agent.presence && agent.presence.modes) || ['queue'];
  const sel = clear($('compose-mode'));
  modes.forEach((m) => sel.append(h('option', { value: m, text: m === 'jump' ? 'Jump queue' : 'Queue' })));
  const rt = clear($('reply-to'));
  rt.hidden = !S.replyTo;
  if (S.replyTo) {
    rt.append(h('span', { text: `Replying to ${S.replyTo.sender.display_name}: ${S.replyTo.body.slice(0, 80)}` }),
      h('button', { class: 'link', onclick: () => { S.replyTo = null; renderComposer(); } }, 'cancel'));
  }
}

$('compose-body').addEventListener('keydown', (ev) => {
  if (ev.isComposing || ev.keyCode === 229) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
    ev.preventDefault();
    if (!S.sending && $('compose-body').value.trim()) {
      $('composer').requestSubmit();
    }
  }
});

$('composer').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (S.sending) return;
  $('compose-error').textContent = '';
  const body = $('compose-body').value;
  const mode = $('compose-mode').value || 'queue';
  const cid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  S.sending = true;
  $('compose-send').disabled = true;
  try {
    let r;
    if (S.replyTo) r = await api('POST', `/api/v1/messages/${S.replyTo.id}/reply`, { body, mode, client_msg_id: cid });
    else {
      const agent = recipientAgent();
      r = await api('POST', '/api/v1/messages', { to: agent.id, body, mode, client_msg_id: cid });
    }
    $('compose-body').value = ''; S.replyTo = null;
    const convId = r.message.conversation_id;
    const convs = await api('GET', '/api/v1/conversations'); S.convs = convs.conversations;
    await loadConv(convId, true);
  } catch (e) { $('compose-error').textContent = e.message; }
  finally {
    S.sending = false;
    $('compose-send').disabled = false;
  }
});

async function toggleReaction(m, emoji, remove) {
  try {
    await api(remove ? 'DELETE' : 'PUT', `/api/v1/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`);
    await loadConv(S.conv.id, true);
  } catch (e) { window.alert(e.message); }
}

async function retry(m) {
  if (!window.confirm('Retry delivery? The agent may have received it already; it will be marked as a retry.')) return;
  try { await api('POST', `/api/v1/admin/messages/${m.id}/retry`, {}); await loadConv(S.conv.id, true); }
  catch (e) { window.alert(e.message); }
}

// --- usage ----------------------------------------------------------------

function renderUsage() {
  const root = clear($('usage'));
  if (!S.usage.length) { root.append(h('p', { class: 'muted', text: 'No account pools yet. Add one on the Admin tab.' })); return; }
  for (const prov of S.usage) {
    const box = h('div', { class: 'provider' }, h('h3', { text: prov.provider }));
    for (const pool of prov.pools) {
      const card = h('div', { class: 'card pool' }, h('strong', { text: pool.label }),
        h('div', { class: 'muted', text: pool.reporter
          ? `Reporter: ${pool.reporter.display_name}, ${pool.reported_at ? `reported ${ago(pool.reported_at)}` : 'no report yet'}`
          : 'No reporter assigned' }),
        pool.stale && pool.reporter ? h('div', { class: 'stale', text: 'stale: reporter offline or no recent report' }) : null);
      const metrics = (pool.usage && pool.usage.metrics) || [];
      if (!metrics.length) card.append(h('div', { class: 'muted', text: 'Usage unknown' }));
      for (const m of metrics) {
        const rem = typeof m.remaining_pct === 'number' ? m.remaining_pct
          : (typeof m.used_pct === 'number' ? 100 - m.used_pct : null);
        const bar = h('span'); if (rem !== null) bar.style.width = `${Math.max(0, Math.min(100, rem))}%`;
        card.append(h('div', { class: 'metric' }, h('span', { text: m.name }), h('div', { class: 'bar' }, bar),
          h('span', { text: rem === null ? 'unknown' : `${Math.round(rem)}% left${m.resets_at ? `, resets ${clock(Date.parse(m.resets_at) / 1000 || Number(m.resets_at))}` : ''}` })));
      }
      card.append(h('div', { class: 'muted', text: `Members: ${pool.members.map((x) => x.display_name).join(', ') || 'none'}` }));
      box.append(card);
    }
    root.append(box);
  }
}

// --- admin ----------------------------------------------------------------

function renderAdmin() {
  const pools = S.board.pools || [];
  const sel = clear($('inv-pool'));
  sel.append(h('option', { value: '', text: 'No pool' }));
  pools.forEach((p) => sel.append(h('option', { value: p.id, text: `${p.provider}: ${p.label}` })));
  const inv = clear($('invites'));
  if (!S.board.invites.length) inv.append(h('p', { class: 'muted', text: 'No open invites.' }));
  for (const i of S.board.invites) {
    inv.append(h('div', { class: 'row' }, h('span', { text: i.display_name || i.handle || `invite ${i.id}` }),
      h('span', { class: 'muted', text: `expires ${clock(i.expires_at)}${i.target_principal_id ? ', re-admission' : ''}` }),
      h('button', { class: 'danger', onclick: () => cancelInvite(i) }, 'Cancel')));
  }
  const pr = clear($('pools'));
  for (const p of pools) {
    const members = (S.board.agents || []).filter((a) => a.pool && a.pool.id === p.id);
    const rep = h('select', { onchange: (ev) => setReporter(p, ev.target.value) },
      h('option', { value: '', text: 'No reporter' }),
      ...members.map((a) => h('option', { value: a.id, selected: p.reporter_principal_id === a.id, text: a.display_name })));
    pr.append(h('div', { class: 'row' }, h('strong', { text: `${p.provider}: ${p.label}` }),
      h('span', { class: 'muted', text: `${members.length} member(s)` }), h('label', {}, 'Usage reporter', rep)));
  }
}

function showCode(code, who) {
  const box = clear($('invite-code'));
  box.hidden = false;
  box.append(h('strong', { text: `One-time invite${who ? ` for ${who}` : ''} (shown once, expires in 24 hours)` }),
    h('code', { text: code }),
    h('span', { class: 'muted', text: 'In the agent session run: /lyra-link join <code> (see the lyra-link skill).' }),
    h('button', { class: 'secondary', onclick: () => navigator.clipboard && navigator.clipboard.writeText(code) }, 'Copy'));
}

$('invite-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('admin-error').textContent = '';
  try {
    const pool = $('inv-pool').value;
    const r = await api('POST', '/api/v1/admin/invites', { display_name: $('inv-name').value || null,
      handle: $('inv-handle').value || null, pool_id: pool === '' ? null : Number(pool) });
    showCode(r.code, $('inv-name').value);
    $('inv-name').value = ''; $('inv-handle').value = '';
    await refreshAll();
  } catch (e) { $('admin-error').textContent = e.message; }
});

$('pool-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('admin-error').textContent = '';
  try {
    await api('POST', '/api/v1/admin/pools', { provider: $('pool-provider').value, label: $('pool-label').value });
    $('pool-provider').value = ''; $('pool-label').value = '';
    await refreshAll();
  } catch (e) { $('admin-error').textContent = e.message; }
});

async function cancelInvite(i) {
  try { await api('DELETE', `/api/v1/admin/invites/${i.id}`); await refreshAll(); }
  catch (e) { $('admin-error').textContent = e.message; }
}

async function setReporter(p, value) {
  try { await api('PATCH', `/api/v1/admin/pools/${p.id}`, { reporter_principal_id: value === '' ? null : Number(value) }); await refreshAll(); }
  catch (e) { $('admin-error').textContent = e.message; }
}

setTab('board');
setInterval(() => { if (S.board && !$('main').hidden) { renderRoster(); } }, 15000);
boot();
