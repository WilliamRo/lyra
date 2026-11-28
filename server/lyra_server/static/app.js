// Lyra v2 board (UI_DESIGN_V2.md). Every node is built with createElement / createTextNode;
// no HTML string is ever parsed. Modules: LyraMarkdown, LyraImgPop, LyraStore, LyraAvatar,
// LyraLifecycle (loaded before this file).
'use strict';

const $ = (id) => document.getElementById(id);
const MOD = {
  md: window.LyraMarkdown || null, pop: window.LyraImgPop || null, store: window.LyraStore || null,
  av: window.LyraAvatar || null, life: window.LyraLifecycle || null,
};
const store = MOD.store ? MOD.store.create() : null;
const mqDesktop = window.matchMedia('(min-width: 960px)');
const mqWide = window.matchMedia('(min-width: 1200px)');
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const TASK_STATES = [['open', 'Open'], ['in_progress', 'In progress'], ['in_review', 'In review'],
  ['blocked', 'Blocked'], ['done', 'Done']];
const PROJECT_STATES = [['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed'], ['archived', 'Archived']];
const PRIORITIES = [[0, 'Low'], [1, 'Normal'], [2, 'High'], [3, 'Urgent']];

const S = {
  me: null, board: null, convs: [], conv: null, msgs: [], replyTo: null, view: null,
  es: null, lastEventId: null, conn: { up: false, attempt: 0, timer: null, tick: null, retryAt: 0, wasDown: false },
  sending: false, staged: [], navigation: 0, optimistic: [], readInFlight: {},
  pending: { board: false, convs: false, conv: false, timer: null }, lifeNodes: new Map(), qs: { items: [], all: [], sel: 0 },
};

// =============================================================================
// DOM helpers
// =============================================================================

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) { if (typeof v === 'function') el.addEventListener(k.slice(2), v); }
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  pin: 'M9 4h6l-1 5 3 3H7l3-3-1-5zM12 15v5',
  back: 'M15 6l-6 6 6 6',
  chevron: 'M9 6l6 6-6 6',
  host: 'M4 5h16v10H4zM8 19h8M12 15v4',
};
function icon(name, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size || 16));
  svg.setAttribute('height', String(size || 16));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name]);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function now() { return Date.now() / 1000; }

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round(now() - ts));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Text node that the 15-second tick updates in place (spec 3.2 rule 5).
function agoNode(ts, prefix) {
  return h('span', { class: 'ago', 'data-ago': ts || 0, 'data-prefix': prefix || '' }, (prefix || '') + ago(ts));
}

function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(d);
}

function fullTime(ts) {
  return ts ? new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts * 1000)) : '';
}

function fmtNum(n, digits) {
  return new Intl.NumberFormat([], { maximumFractionDigits: digits == null ? 0 : digits }).format(n);
}

function isTyping(el) {
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

function anyDialogOpen() { return !!document.querySelector('dialog[open]'); }

// Body text: Markdown + KaTeX through markdown.js. If that module failed to load, fall back to
// plain text with https links only, so a conversation is still readable.
function renderBody(text) {
  if (MOD.md) return MOD.md.render(text);
  const frag = document.createDocumentFragment();
  const rx = /(https:\/\/[^\s<>"')\]]+)/g;
  let last = 0; let m;
  const src = String(text || '');
  while ((m = rx.exec(src)) !== null) {
    if (m.index > last) frag.append(document.createTextNode(src.slice(last, m.index)));
    frag.append(h('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer', text: m[1] }));
    last = rx.lastIndex;
  }
  if (last < src.length) frag.append(document.createTextNode(src.slice(last)));
  return frag;
}

function avatar(p, size, opts) {
  if (MOD.av) return MOD.av.el(p, size, opts || {});
  return h('span', { class: 'avatar avatar-' + (size || 'md'), 'aria-hidden': 'true' },
    (p && (p.display_name || p.handle) || '?').slice(0, 1).toUpperCase());
}

// =============================================================================
// API and session
// =============================================================================

async function api(method, path, body, headers = {}) {
  const opts = { method, credentials: 'same-origin', headers };
  if (body instanceof File) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (_e) { data = {}; }
  if (res.status === 401 && path !== '/api/v1/auth/login') showLogin();
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

function showLogin() {
  // Drafts and view state stay in localStorage, so the same thread returns after sign-in.
  stopEvents();
  $('main').hidden = true;
  $('login').hidden = false;
  setTimeout(() => $('login-user').focus(), 0);
}

async function boot() {
  try {
    const r = await api('GET', '/api/v1/auth/me');
    S.me = r.user;
  } catch (_e) { showLogin(); return; }
  $('login').hidden = true;
  $('main').hidden = false;
  try {
    await refreshAll(true);
  } catch (e) {
    setConn(false, 'Could not load the board: ' + e.message);
  }
  connectEvents();
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

// =============================================================================
// View state (localStorage) and tabs
// =============================================================================

function viewCtx() {
  const b = S.board || {};
  return {
    desktop: mqDesktop.matches,
    convIds: S.convs.map((c) => c.id),
    agentIds: (b.agents || []).map((a) => a.id),
    machineIds: (b.hosts || []).map((x) => x.host).concat(['__unknown__']),
    providerIds: null,
    poolIds: (b.pools || []).map((p) => p.id),
    projectIds: (b.projects || []).map((p) => p.id),
  };
}

function loadView() {
  S.view = store ? store.view.load(viewCtx()) : {
    activeTab: 'chats', agentGroupMode: 'machine', expandedAgentIds: [], expandedMachineIds: [],
    expandedProviderIds: [], expandedPoolIds: [], selectedConvId: null, pendingAgentId: null,
    activeProjectId: null, projectStatusFilter: 'all', taskStatusFilter: 'all', mobileChatView: 'list',
    projectView: 'list' };
}

function saveView() { if (store && S.view) store.view.save(S.view); }

function toggleIn(list, id) {
  const i = list.indexOf(id);
  if (i === -1) list.push(id); else list.splice(i, 1);
  saveView();
}

function currentTab() {
  const t = S.view.activeTab;
  return t === 'agents' && mqDesktop.matches ? 'chats' : t;
}

function setTab(tab) {
  S.view.activeTab = tab;
  saveView();
  renderTabs();
  if (tab === 'chats') maybeMarkRead();
}

function renderTabs() {
  const tab = currentTab();
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  $('pane-chats').querySelector('.chats').dataset.view = S.view.mobileChatView === 'thread' && S.conv ? 'thread' : 'list';
  $('projects').dataset.view = S.view.projectView === 'detail' && activeProject() ? 'detail' : 'list';
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
mqDesktop.addEventListener('change', () => { renderTabs(); autoGrow(); });
mqWide.addEventListener('change', () => { renderTabs(); maybeMarkRead(); });

// =============================================================================
// Loading and live refresh
// =============================================================================

async function refreshAll(initial) {
  const [board, convs] = await Promise.all([api('GET', '/api/v1/board'), api('GET', '/api/v1/conversations')]);
  S.board = board;
  S.convs = convs.conversations || [];
  if (initial || !S.view) loadView();
  renderTabs();
  renderAgents();
  renderConvList();
  renderProjects();
  renderAdminSenate();
  renderUnreadTotals();
  if (initial) {
    if (S.view.selectedConvId != null) await openConv(S.view.selectedConvId, { restore: true });
    else if (S.view.pendingAgentId != null) {
      const a = agentById(S.view.pendingAgentId);
      if (a) openWith(a, { restore: true }); else renderThread();
    } else renderThread();
  } else if (S.conv && S.conv.id) {
    await reloadConv();
  } else {
    renderThread();
  }
}

function schedule(flags) {
  const p = S.pending;
  p.board = p.board || !!flags.board;
  p.convs = p.convs || !!flags.convs;
  p.conv = p.conv || !!flags.conv;
  clearTimeout(p.timer);
  p.timer = setTimeout(runRefresh, 200);
}

async function runRefresh() {
  const p = S.pending;
  const want = { board: p.board, convs: p.convs, conv: p.conv };
  p.board = p.convs = p.conv = false;
  try {
    const [board, convs] = await Promise.all([
      want.board ? api('GET', '/api/v1/board') : null,
      want.convs ? api('GET', '/api/v1/conversations') : null]);
    if (board) {
      S.board = board;
      renderAgents(); renderProjects(); renderAdminSenate();
    }
    if (convs) { S.convs = convs.conversations || []; renderConvList(); renderUnreadTotals(); }
    if ((want.conv || board) && S.conv && S.conv.id) await reloadConv();
    else if (board && S.conv) { renderThreadHeader(); renderComposer(); }
  } catch (_e) { /* the next event or reconnect retries */ }
}

// --- SSE with a visible reconnect banner and jittered backoff (section 8) ------

const EVENT_TYPES = ['presence', 'principal', 'invite', 'pool', 'project', 'message', 'message_state',
  'message_progress', 'conversation'];

function stopEvents() {
  if (S.es) { S.es.close(); S.es = null; }
  clearTimeout(S.conn.timer);
  clearInterval(S.conn.tick);
}

function connectEvents() {
  stopEvents();
  const url = '/api/v1/events' + (S.lastEventId ? '?last=' + encodeURIComponent(S.lastEventId) : '');
  const es = new EventSource(url);
  S.es = es;
  es.onopen = () => {
    const recovered = S.conn.wasDown;
    S.conn.attempt = 0;
    S.conn.wasDown = false;
    setConn(true);
    if (recovered) {
      showBanner('Back online. Refreshing…', true);
      setTimeout(() => { if (S.conn.up) $('conn-banner').hidden = true; }, 2000);
      refreshAll(false).catch(() => {});
    }
  };
  es.onerror = () => {
    es.close();
    if (S.es === es) S.es = null;
    S.conn.wasDown = true;
    setConn(false);
    // A 401 shows the sign-in card (api() handles it); anything else keeps retrying.
    api('GET', '/api/v1/auth/me').then(() => planReconnect(), (e) => { if (e.status !== 401) planReconnect(); });
  };
  for (const t of EVENT_TYPES) es.addEventListener(t, (ev) => onEvent(t, ev));
}

function onEvent(type, ev) {
  if (ev.lastEventId) S.lastEventId = ev.lastEventId;
  let d = {};
  try { d = JSON.parse(ev.data); } catch (_e) { d = {}; }
  const inConv = S.conv && S.conv.id != null && d.conversation_id === S.conv.id;
  switch (type) {
    case 'message': schedule({ convs: true, conv: inConv }); break;
    case 'message_state': schedule({ conv: inConv, convs: false }); break;
    case 'message_progress': schedule({ conv: inConv, board: true }); break;
    case 'conversation': schedule({ convs: true }); break;
    default: schedule({ board: true });
  }
}

function setConn(up, text) {
  S.conn.up = up;
  const live = $('live');
  live.textContent = up ? 'live' : 'offline';
  live.classList.toggle('on', up);
  live.classList.toggle('off', !up);
  if (text) showBanner(text, false);
}

function showBanner(text, ok) {
  const b = $('conn-banner');
  b.hidden = false;
  b.classList.toggle('is-ok', !!ok);
  $('conn-text').textContent = text;
  $('conn-retry').hidden = !!ok;
}

function planReconnect() {
  clearTimeout(S.conn.timer);
  clearInterval(S.conn.tick);
  const base = Math.min(30, Math.pow(2, S.conn.attempt));
  const delay = base * (0.5 + Math.random() * 0.5);
  S.conn.attempt += 1;
  S.conn.retryAt = Date.now() + delay * 1000;
  const paint = () => {
    const s = Math.max(0, Math.ceil((S.conn.retryAt - Date.now()) / 1000));
    showBanner(`Connection lost. Reconnecting… (retry in ${s} s)`, false);
  };
  paint();
  S.conn.tick = setInterval(paint, 1000);
  S.conn.timer = setTimeout(() => { clearInterval(S.conn.tick); connectEvents(); }, delay * 1000);
}

$('conn-retry').addEventListener('click', () => { S.conn.attempt = 0; connectEvents(); });

// =============================================================================
// Agents sidebar: summary-first rows, By machine / By provider
// =============================================================================

function agentById(id) { return ((S.board && S.board.agents) || []).find((a) => a.id === id) || null; }

function activity(a) {
  if (a.status !== 'admitted') return { key: 'revoked', label: 'revoked', cls: 'bad', rank: 5 };
  const st = (a.presence && a.presence.effective_status) || 'offline';
  if (st === 'stale') return { key: st, label: 'stalled', cls: 'warn', rank: 1, title: 'No progress update recently' };
  if (st === 'working') return { key: st, label: 'working', cls: 'warn', rank: 2 };
  if (st === 'idle') return { key: st, label: 'idle', cls: 'ok', rank: 3 };
  return { key: 'offline', label: 'offline', cls: '', rank: 4 };
}

function attentionSort(list) {
  return list.slice().sort((x, y) => {
    const ax = x.unconfirmed > 0 ? 0 : activity(x).rank;
    const ay = y.unconfirmed > 0 ? 0 : activity(y).rank;
    return ax - ay || x.display_name.localeCompare(y.display_name);
  });
}

function convWithAgent(id) {
  return S.convs.find((c) => c.kind === 'owner_agent' && c.members.some((m) => m.id === id)) || null;
}

function supportsImages(agent) { return !!(agent && agent.presence && agent.presence.capabilities &&
  agent.presence.capabilities.images === true); }

function pct(n) { return Math.max(0, Math.min(100, Number(n) || 0)); }

function fillClass(usedPct) { return usedPct >= 90 ? 'bad' : usedPct >= 70 ? 'warn' : ''; }

function meter(label, used, valueText, opts) {
  const fill = h('span', { class: 'fill ' + ((opts && opts.cls) || fillClass(used)) });
  fill.style.width = pct(used) + '%';
  const name = label || (opts && opts.name) || '';
  return h('div', { class: 'meter' + (label ? '' : ' no-label') }, label ? h('span', { class: 'muted', text: label }) : null,
    h('span', { class: 'track', role: 'img', 'aria-label': `${name} ${Math.round(pct(used))}%`.trim() }, fill),
    h('span', { class: 'val', text: valueText }));
}

function miniMeter(label, used) {
  const fill = h('span', { class: 'fill ' + fillClass(used) });
  fill.style.width = pct(used) + '%';
  return h('span', { class: 'mini-meter' }, h('span', { text: `${label} ${Math.round(pct(used))}%` }),
    h('span', { class: 'track' }, fill));
}

function agentRow(a) {
  const p = a.presence || {};
  const st = p.status || {};
  const act = activity(a);
  const consul = a.role === 'consul';
  const expanded = S.view.expandedAgentIds.includes(a.id);
  const detailsId = 'agent-details-' + a.id;
  const conv = convWithAgent(a.id);
  const extras = [];
  if (st.model) extras.push(st.model + (st.effort ? ` (${st.effort})` : ''));
  if (a.waiting) extras.push(`${a.waiting} waiting`);
  if (a.unconfirmed) extras.push(`${a.unconfirmed} unconfirmed`);
  if (conv && conv.unread_count) extras.push(`${conv.unread_count} unread`);
  if (!extras.length) extras.push(p.online ? 'online' : `last seen ${ago(p.last_checkin_at)}`);

  const main = h('button', { type: 'button', class: 'agent-main', 'aria-expanded': String(expanded),
    'aria-controls': detailsId, onclick: () => { toggleIn(S.view.expandedAgentIds, a.id); renderAgents(); } },
    avatar(a, 'md', { status: a.status === 'admitted' ? (p.online ? 'on' : 'off') : null, consul }),
    h('span', { class: 'agent-text' },
      h('span', { class: 'agent-line1' },
        h('span', { class: 'agent-name', text: a.display_name }),
        h('span', { class: 'agent-handle', text: '@' + a.handle }),
        consul ? h('span', { class: 'pill consul', text: 'Consul' }) : null),
      h('span', { class: 'agent-line2' },
        h('span', { class: 'pill ' + act.cls, title: act.title || null, text: act.label }),
        h('span', { class: 'agent-extra', text: extras.join(', ') }))),
    h('span', { class: 'agent-chev', 'aria-hidden': 'true' }, icon('chevron', 14)));

  const row = h('div', { class: 'agent-row' }, main,
    a.status === 'admitted' ? h('button', { type: 'button', class: 'agent-chat ghost',
      'aria-label': `Chat with ${a.display_name}`, onclick: (ev) => { ev.stopPropagation(); openWith(a); } }, 'Chat') : null);
  const wrap = h('div', { class: 'agent' + (consul ? ' is-consul' : ''), 'data-agent-id': a.id }, row);
  if (expanded) wrap.append(agentDetails(a, detailsId));
  return wrap;
}

function agentDetails(a, id) {
  const p = a.presence || {};
  const st = p.status || {};
  const modes = (p.modes || ['queue']).map((m) => (m === 'jump' ? 'Jump queue' : 'Queue')).join(', ');
  const kv = h('dl', { class: 'kv' });
  const add = (k, v) => kv.append(h('dt', { text: k }), h('dd', {}, v));
  add('Last check-in', agoNode(p.last_checkin_at));
  add('Context', typeof st.context_pct === 'number' ? meter('', st.context_pct, Math.round(st.context_pct) + '%', { name: 'Context used' })
    : 'unknown');
  add('Runtime', [p.provider, p.runtime, p.connector].filter(Boolean).join(' / ') || 'unknown');
  add('Delivery', modes);
  add('Images', supportsImages(a) ? 'accepted' : 'text only');
  add('Queue', `${a.waiting || 0} waiting, ${a.unconfirmed || 0} unconfirmed`);
  add('Stream', st.attached === false ? 'not attached' : st.attached ? 'attached' : 'unknown');
  add('Handle', '@' + a.handle);
  add('Host', p.host || 'unknown');
  add('Address', a.address || 'unknown');

  const pools = (S.board.pools || []);
  const poolSel = h('select', { 'aria-label': `Pool for ${a.display_name}`, onchange: (ev) => setPool(a, ev.target.value) },
    h('option', { value: '', text: 'No pool' }),
    ...pools.map((pl) => h('option', { value: pl.id, selected: a.pool && a.pool.id === pl.id,
      text: `${providerName(pl.provider)}: ${pl.label}` })));
  const actions = h('div', { class: 'agent-actions' });
  if (a.status === 'admitted') {
    actions.append(
      h('button', { type: 'button', class: 'primary', onclick: () => openWith(a) }, 'Message'),
      h('button', { type: 'button', class: 'danger', onclick: () => revoke(a) }, 'Revoke'),
      h('button', { type: 'button', class: 'ghost', disabled: true, title: 'Recovery is planned for a later version' }, 'Recover'));
  } else {
    actions.append(h('button', { type: 'button', class: 'ghost', onclick: () => readmit(a) }, 'Re-admit'));
  }
  return h('div', { class: 'agent-details', id },
    kv,
    h('label', {}, a.pool && a.pool.is_reporter ? 'Pool (usage reporter)' : 'Pool', poolSel),
    actions);
}

function providerName(p) {
  const s = String(p || 'other');
  const known = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', moonshot: 'Moonshot',
    deepseek: 'DeepSeek', xai: 'xAI', lyra: 'Lyra' };
  return known[s.toLowerCase()] || s.charAt(0).toUpperCase() + s.slice(1);
}

function hostLabel(name) { return String(name || '').replace(/\.local$/, ''); }

function railGroup(card, agents, details, offline) {
  const g = h('div', { class: 'rail-group' + (offline ? ' is-offline' : '') }, card,
    h('div', { class: 'rail-agents' }, agents.length ? agents.map(agentRow)
      : h('p', { class: 'list-empty', text: 'No agents' })));
  if (details) g.append(details);
  return g;
}

function renderByMachine(root, admitted) {
  const hosts = (S.board.hosts || []).slice().sort((x, y) =>
    (y.online_count > 0) - (x.online_count > 0) || String(x.host).localeCompare(String(y.host)));
  const placed = new Set();
  for (const host of hosts) {
    const agents = attentionSort(host.agent_ids.map(agentById).filter((a) => a && a.status === 'admitted'));
    agents.forEach((a) => placed.add(a.id));
    const m = host.metrics || {};
    const expanded = S.view.expandedMachineIds.includes(host.host);
    const memPct = typeof m.mem_used_pct === 'number' ? m.mem_used_pct
      : (m.mem_total_gb ? 100 * (m.mem_used_gb || (m.mem_total_gb - (m.mem_free_gb || 0))) / m.mem_total_gb : null);
    const diskPct = typeof m.disk_used_pct === 'number' ? m.disk_used_pct
      : (m.disk_total_gb ? 100 * (1 - (m.disk_free_gb || 0) / m.disk_total_gb) : null);
    const detailsId = 'host-details-' + host.host.replace(/[^a-zA-Z0-9_-]/g, '_');
    const card = h('button', { type: 'button', class: 'rail-card', 'aria-expanded': String(expanded),
      'aria-controls': detailsId, title: host.host,
      onclick: () => { toggleIn(S.view.expandedMachineIds, host.host); renderAgents(); } },
      h('span', { class: 'rail-name' }, hostLabel(host.host)),
      h('span', { class: 'rail-sub', text: `${host.online_count} of ${agents.length} online` }),
      m.os ? h('span', { class: 'rail-sub', text: [m.os, m.arch].filter(Boolean).join(' ') }) : null,
      memPct != null ? miniMeter('RAM', memPct) : null,
      diskPct != null ? miniMeter('Disk', diskPct) : null,
      h('span', { class: 'rail-chev', text: expanded ? 'Hide details' : 'Details' }));
    let details = null;
    if (expanded) {
      details = h('div', { class: 'rail-details', id: detailsId });
      if (memPct != null) {
        const used = m.mem_used_gb != null ? m.mem_used_gb : (m.mem_total_gb && m.mem_free_gb != null ? m.mem_total_gb - m.mem_free_gb : null);
        details.append(meter('RAM', memPct, used != null && m.mem_total_gb
          ? `${fmtNum(used, 1)} / ${fmtNum(m.mem_total_gb, 0)} GB` : `${Math.round(memPct)}%`));
      }
      if (diskPct != null) {
        details.append(meter('Disk', diskPct, m.disk_free_gb != null && m.disk_total_gb
          ? `${fmtNum(m.disk_free_gb, 0)} GB free of ${fmtNum(m.disk_total_gb, 0)}` : `${Math.round(diskPct)}% used`));
      }
      const kv = h('dl', { class: 'kv' });
      const add = (k, v) => { if (v != null && v !== '') kv.append(h('dt', { text: k }), h('dd', {}, v)); };
      add('System', [m.os, m.arch].filter(Boolean).join(', '));
      add('CPU cores', m.cpu_count != null ? String(m.cpu_count) : null);
      add('Address', m.ip);
      add('Uptime', m.uptime_sec != null ? uptime(m.uptime_sec) : null);
      add('Reported', agoNode(host.last_seen_at));
      details.append(kv);
      if (host.last_seen_at && now() - host.last_seen_at > 600) {
        details.append(h('span', { class: 'stale-note', text: 'Telemetry is stale (no check-in for over 10 minutes).' }));
      }
      if (!Object.keys(m).length) details.append(h('p', { class: 'muted', text: 'No telemetry reported for this host yet.' }));
    }
    root.append(railGroup(card, agents, details, host.online_count === 0));
  }
  const unknown = attentionSort(admitted.filter((a) => !placed.has(a.id)));
  if (unknown.length) {
    const card = h('div', { class: 'rail-card' }, h('span', { class: 'rail-name', text: 'Unknown host' }),
      h('span', { class: 'rail-sub', text: 'No telemetry' }));
    root.append(railGroup(card, unknown, null, !unknown.some((a) => a.presence.online)));
  }
}

function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  return d ? `${d} d ${hrs} h` : `${hrs} h ${Math.floor((sec % 3600) / 60)} min`;
}

function poolRemaining(pool) {
  const metrics = (pool.usage && pool.usage.metrics) || [];
  let low = null;
  for (const m of metrics) {
    const rem = typeof m.remaining_pct === 'number' ? m.remaining_pct : typeof m.used_pct === 'number' ? 100 - m.used_pct : null;
    if (rem != null && (low == null || rem < low)) low = rem;
  }
  return low;
}

function remClass(rem) { return rem == null ? '' : rem < 10 ? 'bad' : rem < 30 ? 'warn' : 'ok'; }

function resetText(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  const ts = Number.isFinite(n) ? n : Date.parse(v) / 1000;
  return Number.isFinite(ts) ? `resets ${shortTime(ts)}` : '';
}

function renderByProvider(root, admitted) {
  const pools = S.board.pools || [];
  const byProvider = new Map();
  const ensure = (key) => {
    const k = String(key || 'other').toLowerCase();
    if (!byProvider.has(k)) byProvider.set(k, { pools: [], unpooled: [] });
    return byProvider.get(k);
  };
  pools.forEach((p) => ensure(p.provider).pools.push(p));
  admitted.filter((a) => !a.pool).forEach((a) => ensure(a.presence && a.presence.provider).unpooled.push(a));
  const collapsed = S.view.expandedProviderIds;   // stores collapsed provider keys
  for (const [key, group] of Array.from(byProvider.entries()).sort((x, y) => x[0].localeCompare(y[0]))) {
    const isCollapsed = collapsed.includes(key);
    const agentsIn = (pool) => attentionSort(admitted.filter((a) => a.pool && a.pool.id === pool.id));
    const activeCount = admitted.filter((a) => (a.pool ? group.pools.some((p) => p.id === a.pool.id) : group.unpooled.includes(a))
      && a.presence.online).length;
    const section = h('section', { class: 'provider-section' },
      h('button', { type: 'button', class: 'provider-head quiet', 'aria-expanded': String(!isCollapsed),
        onclick: () => { toggleIn(S.view.expandedProviderIds, key); renderAgents(); } },
        h('strong', { text: providerName(key) }),
        h('span', { class: 'muted tnum', text: `${group.pools.length} account${group.pools.length === 1 ? '' : 's'}, ${activeCount} online` })));
    if (!isCollapsed) {
      for (const pool of group.pools) section.append(poolGroup(pool, agentsIn(pool)));
      if (group.unpooled.length) {
        const card = h('div', { class: 'rail-card' }, h('span', { class: 'rail-name', text: 'No pool assigned' }),
          h('span', { class: 'rail-sub', text: 'Assign a pool in agent details' }));
        section.append(railGroup(card, attentionSort(group.unpooled), null, false));
      }
    }
    root.append(section);
  }
  if (!byProvider.size) root.append(h('p', { class: 'list-empty', text: 'No account pools yet. Add one in Admin & Senate.' }));
}

function poolGroup(pool, agents) {
  const expanded = S.view.expandedPoolIds.includes(pool.id);
  const rem = poolRemaining(pool);
  const detailsId = 'pool-details-' + pool.id;
  const card = h('button', { type: 'button', class: 'rail-card', 'aria-expanded': String(expanded), 'aria-controls': detailsId,
    'data-pool-id': pool.id, onclick: () => { toggleIn(S.view.expandedPoolIds, pool.id); renderAgents(); } },
    h('span', { class: 'rail-name', text: pool.label }),
    pool.account_label ? h('span', { class: 'rail-sub', text: pool.account_label }) : null,
    pool.subscription ? h('span', { class: 'pill info', text: pool.subscription }) : null,
    rem != null ? h('span', { class: 'pill ' + remClass(rem), text: `${Math.round(rem)}% left` })
      : h('span', { class: 'rail-sub', text: 'quota unknown' }),
    h('span', { class: 'rail-chev', text: expanded ? 'Hide details' : 'Details' }));
  let details = null;
  if (expanded) {
    details = h('div', { class: 'rail-details', id: detailsId });
    const metrics = (pool.usage && pool.usage.metrics) || [];
    for (const m of metrics) {
      const remain = typeof m.remaining_pct === 'number' ? m.remaining_pct : typeof m.used_pct === 'number' ? 100 - m.used_pct : null;
      if (remain == null) continue;
      details.append(meter(m.name, 100 - remain, `${Math.round(remain)}% left${resetText(m.resets_at) ? ', ' + resetText(m.resets_at) : ''}`,
        { cls: remClass(remain) === 'ok' ? '' : remClass(remain) }));
    }
    if (!metrics.length) details.append(h('p', { class: 'muted', text: 'No usage reported yet.' }));
    const kv = h('dl', { class: 'kv' });
    const add = (k, v) => { if (v) kv.append(h('dt', { text: k }), h('dd', {}, v)); };
    add('Account', pool.account_label);
    add('Subscription', pool.subscription);
    add('Reporter', pool.reporter ? pool.reporter.display_name : 'none assigned');
    add('Reported', pool.reported_at ? agoNode(pool.reported_at) : 'never');
    add('Notes', pool.notes);
    details.append(kv);
    if (pool.reporter && pool.stale) details.append(h('span', { class: 'stale-note', text: 'Stale: reporter offline or no recent report.' }));
  }
  return railGroup(card, agents, details, !agents.some((a) => a.presence.online));
}

function renderQuotaAlert() {
  const box = clear($('quota-alert'));
  const low = (S.board.pools || []).map((p) => ({ p, rem: poolRemaining(p) })).filter((x) => x.rem != null && x.rem < 10);
  box.hidden = !low.length;
  if (!low.length) return;
  const first = low[0];
  box.append(document.createTextNode(`Quota low: ${first.p.label} has ${Math.round(first.rem)}% left. `),
    h('button', { type: 'button', onclick: () => {
      S.view.agentGroupMode = 'provider';
      if (!S.view.expandedPoolIds.includes(first.p.id)) S.view.expandedPoolIds.push(first.p.id);
      const k = String(first.p.provider).toLowerCase();
      S.view.expandedProviderIds = S.view.expandedProviderIds.filter((x) => x !== k);
      saveView(); renderAgents(); setTab('agents');
      const el = document.querySelector(`[data-pool-id="${first.p.id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    } }, 'Show pool'));
}

function renderAgents() {
  if (!S.board) return;
  const agents = S.board.agents || [];
  const admitted = agents.filter((a) => a.status === 'admitted');
  $('agents-count').textContent = `${admitted.filter((a) => a.presence.online).length}/${admitted.length} online`;
  document.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.group === S.view.agentGroupMode)));
  renderQuotaAlert();
  const root = $('roster');
  const keepScroll = root.scrollTop;
  clear(root);
  if (!agents.length) {
    root.append(h('p', { class: 'list-empty', text: 'No agents yet. Create an invite in Admin & Senate.' }));
    return;
  }
  if (S.view.agentGroupMode === 'provider') renderByProvider(root, admitted);
  else renderByMachine(root, admitted);
  const revoked = agents.filter((a) => a.status !== 'admitted');
  if (revoked.length) {
    root.append(h('div', { class: 'group-title' }, 'Revoked', h('span', { class: 'tnum', text: String(revoked.length) })),
      h('div', { class: 'rail-group single' }, h('div', { class: 'rail-agents' }, revoked.map(agentRow))));
  }
  root.scrollTop = keepScroll;
}

document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  S.view.agentGroupMode = b.dataset.group;
  saveView();
  renderAgents();
}));
document.querySelector('.seg').addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  ev.preventDefault();
  S.view.agentGroupMode = S.view.agentGroupMode === 'machine' ? 'provider' : 'machine';
  saveView();
  renderAgents();
  document.querySelector(`.seg-btn[data-group="${S.view.agentGroupMode}"]`).focus();
});

async function revoke(a) {
  if (!window.confirm(`Revoke ${a.display_name}? Its waiting messages will fail.`)) return;
  try { await api('POST', `/api/v1/admin/principals/${a.id}/revoke`, {}); schedule({ board: true, convs: true }); }
  catch (e) { window.alert(e.message); }
}

async function readmit(a) {
  try {
    const r = await api('POST', '/api/v1/admin/invites', { target_principal_id: a.id });
    setTab('admin-senate');
    showCode(r.code, a.display_name);
    schedule({ board: true });
  } catch (e) { window.alert(e.message); }
}

async function setPool(a, value) {
  try { await api('PATCH', `/api/v1/admin/principals/${a.id}`, { pool_id: value === '' ? null : Number(value) }); schedule({ board: true }); }
  catch (e) { window.alert(e.message); }
}

// =============================================================================
// Conversations: pins, unread badges, read receipts
// =============================================================================

function ownerId() { return S.board && S.board.owner ? S.board.owner.id : (S.me && S.me.principal_id); }

function convAgents(c) { return (c.members || []).filter((m) => m.kind === 'agent'); }

function convTitle(c) {
  const names = convAgents(c).map((m) => m.display_name);
  return c.kind === 'agent_agent' ? names.join(' and ') : (names[0] || 'Conversation');
}

function renderUnreadTotals() {
  const total = S.convs.reduce((n, c) => n + (c.unread_count || 0), 0);
  const badge = $('tab-unread');
  badge.hidden = !total;
  badge.textContent = total > 99 ? '99+' : String(total);
  badge.setAttribute('aria-label', `${total} unread`);
  document.title = total ? `(${total > 99 ? '99+' : total}) Lyra` : 'Lyra';
}

function convRow(c) {
  const agents = convAgents(c);
  const consul = c.kind === 'owner_agent' && agents.some((m) => m.role === 'consul');
  const active = S.conv && S.conv.id === c.id;
  const unread = c.unread_count || 0;
  const mine = c.last && c.last.sender_id === ownerId();
  const lead = c.kind === 'agent_agent' && MOD.av ? MOD.av.stack(agents, 'xs')
    : avatar(agents[0] || {}, 'md', { status: null, consul });
  const main = h('button', { type: 'button', class: 'conv-main', 'aria-current': active ? 'true' : null,
    onclick: () => openConv(c.id, { user: true }) },
    lead,
    h('span', { class: 'conv-text' },
      h('span', { class: 'conv-title' }, h('span', { text: convTitle(c) }),
        consul ? h('span', { class: 'tag-consul', text: 'Consul' }) : null),
      h('span', { class: 'conv-excerpt', text: c.last ? (mine ? 'You: ' : '') + c.last.excerpt : 'No messages yet' })),
    h('span', { class: 'conv-meta' },
      h('span', { text: c.last ? shortTime(c.last.created_at) : '' }),
      unread ? h('span', { class: 'count-badge', 'aria-label': `${unread} unread`, text: unread > 99 ? '99+' : String(unread) }) : null));
  const pin = h('button', { type: 'button', class: 'conv-pin quiet', 'aria-pressed': String(!!c.pinned),
    'aria-label': (c.pinned ? 'Unpin ' : 'Pin ') + convTitle(c), title: c.pinned ? 'Unpin conversation' : 'Pin conversation',
    onclick: (ev) => { ev.stopPropagation(); togglePin(c); } }, icon('pin', 16));
  return h('div', { class: 'conv-row' + (active ? ' active' : '') + (unread ? ' unread' : '') + (consul ? ' is-consul' : ''),
    'data-conv-id': c.id }, main, pin);
}

function orderedConvs() {
  const pinned = S.convs.filter((c) => c.pinned);
  const own = S.convs.filter((c) => !c.pinned && c.kind === 'owner_agent');
  const team = S.convs.filter((c) => !c.pinned && c.kind === 'agent_agent');
  return { pinned, own, team, flat: pinned.concat(own, team) };
}

function renderConvList() {
  const root = clear($('conv-list'));
  const g = orderedConvs();
  const section = (title, list) => {
    if (!list.length) return;
    root.append(h('div', { class: 'group-title', text: title }));
    list.forEach((c) => root.append(convRow(c)));
  };
  section('Pinned', g.pinned);
  section('With you', g.own);
  section('Team (read only)', g.team);
  if (!S.convs.length) root.append(h('p', { class: 'conv-empty', text: 'No conversations yet. Choose Chat next to an agent to start one.' }));
}

async function togglePin(c) {
  const was = !!c.pinned;
  c.pinned = !was;                    // optimistic
  c.pinned_at = was ? null : now();
  renderConvList();
  try { await api(was ? 'DELETE' : 'POST', `/api/v1/conversations/${c.id}/pin`, was ? undefined : {}); }
  catch (e) { c.pinned = was; renderConvList(); window.alert(e.message); }
  schedule({ convs: true });
}

function threadVisible() {
  if (!S.conv || S.conv.id == null) return false;
  if (currentTab() !== 'chats') return false;
  return mqWide.matches || S.view.mobileChatView === 'thread';
}

function maybeMarkRead() {
  const c = S.conv && S.conv.id != null ? S.convs.find((x) => x.id === S.conv.id) : null;
  if (!c || !threadVisible() || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  const box = $('messages');
  if (box.scrollHeight - box.scrollTop - box.clientHeight > 48) return;
  const latest = S.msgs.length ? S.msgs[S.msgs.length - 1].id : 0;
  if (!latest || (!c.unread_count && latest <= (c.last_read_message_id || 0))) return;
  if (S.readInFlight[c.id] === latest) return;
  S.readInFlight[c.id] = latest;
  c.unread_count = 0;
  c.last_read_message_id = latest;
  renderConvList(); renderUnreadTotals(); renderAgents();
  api('POST', `/api/v1/conversations/${c.id}/read`, { last_read_message_id: latest })
    .catch(() => { delete S.readInFlight[c.id]; });
}

document.addEventListener('visibilitychange', maybeMarkRead);
window.addEventListener('focus', maybeMarkRead);

// =============================================================================
// Thread
// =============================================================================

function draftKey() {
  if (!store || !S.conv) return null;
  if (S.conv.id != null) return store.drafts.key({ convId: S.conv.id });
  if (S.conv.pendingTo) return store.drafts.key({ agentId: S.conv.pendingTo.id });
  return null;
}

function leaveConv() {
  S.navigation++;
  S.staged = [];
  S.replyTo = null;
  S.lifeNodes.clear();
  $('compose-files').value = '';
  $('compose-error').textContent = '';
  $('new-pill').hidden = true;
}

async function openConv(id, opts) {
  const o = opts || {};
  if (!S.conv || S.conv.id !== id) {
    leaveConv();
    const meta = S.convs.find((c) => c.id === id);
    if (!meta && !o.restore) return;
    S.conv = { id, kind: meta ? meta.kind : 'owner_agent', read_only: meta ? meta.read_only : false,
      members: meta ? meta.members : [] };
    S.msgs = [];
    S.view.selectedConvId = id;
    S.view.pendingAgentId = null;
    if (o.user || !mqWide.matches) S.view.mobileChatView = o.restore ? S.view.mobileChatView : 'thread';
    saveView();
    restoreDraft();
  }
  if (o.user) setTab('chats');
  renderTabs();
  renderConvList();
  renderThread();
  await reloadConv({ toBottom: true });
}

async function reloadConv(opts) {
  if (!S.conv || S.conv.id == null) return;
  const navigation = S.navigation;
  const id = S.conv.id;
  try {
    const r = await api('GET', `/api/v1/conversations/${id}/messages?limit=300`);
    if (navigation !== S.navigation) return;
    const meta = S.convs.find((c) => c.id === id) || {};
    S.conv.kind = r.kind;
    S.conv.read_only = r.read_only;
    S.conv.members = meta.members || S.conv.members;
    const before = S.msgs.length ? S.msgs[S.msgs.length - 1].id : 0;
    S.msgs = r.messages || [];
    S.optimistic = S.optimistic.filter((o) => !S.msgs.some((m) => m.client_msg_id && m.client_msg_id === o.client_msg_id));
    const after = S.msgs.length ? S.msgs[S.msgs.length - 1].id : 0;
    renderThreadHeader();
    renderMessages({ toBottom: opts && opts.toBottom, grew: after > before });
    renderComposer();
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      S.conv = null; S.view.selectedConvId = null; saveView(); renderThread();
    }
  }
}

function openWith(agent, opts) {
  const c = convWithAgent(agent.id);
  if (c) { openConv(c.id, { user: !(opts && opts.restore) }); return; }
  leaveConv();
  S.conv = { id: null, kind: 'owner_agent', pendingTo: agent, members: [] };
  S.msgs = [];
  S.view.selectedConvId = null;
  S.view.pendingAgentId = agent.id;
  S.view.mobileChatView = 'thread';
  saveView();
  if (!(opts && opts.restore)) setTab('chats');
  restoreDraft();
  renderTabs();
  renderConvList();
  renderThread();
  setTimeout(() => $('compose-body').focus(), 0);
}

function recipientAgent() {
  if (!S.conv || !S.board) return null;
  if (S.conv.pendingTo) return agentById(S.conv.pendingTo.id) || S.conv.pendingTo;
  const m = (S.conv.members || []).find((x) => x.kind === 'agent');
  return m ? agentById(m.id) : null;
}

function goBackToList() {
  S.view.mobileChatView = 'list';
  saveView();
  renderTabs();
}

function renderThread() {
  renderThreadHeader();
  renderMessages({ toBottom: true });
  renderComposer();
}

function renderThreadHeader() {
  const head = clear($('conv-header'));
  head.className = 'conv-header';
  const back = h('button', { type: 'button', class: 'conv-back quiet', 'aria-label': 'Back to conversations',
    onclick: goBackToList }, icon('back', 18), h('span', { class: 'sr-only', text: 'Conversations' }));
  if (!S.conv) {
    head.append(h('span', { class: 'muted', text: 'Select a conversation.' }));
    return;
  }
  head.append(back);
  if (S.conv.kind === 'agent_agent') {
    const agents = convAgents(S.conv);
    head.append(MOD.av ? MOD.av.stack(agents, 'sm') : null,
      h('div', { class: 'conv-who' },
        h('div', { class: 'who-name' }, h('span', { text: agents.map((a) => a.display_name).join(' and ') })),
        h('div', { class: 'who-sub', text: 'Team conversation, read only' })));
    return;
  }
  const a = recipientAgent();
  if (!a) { head.append(h('span', { class: 'muted', text: 'Conversation' })); return; }
  const consul = a.role === 'consul';
  if (consul) head.classList.add('is-consul');
  const act = activity(a);
  head.append(avatar(a, 'md', { status: a.status === 'admitted' ? (a.presence && a.presence.online ? 'on' : 'off') : null, consul }),
    h('div', { class: 'conv-who' },
      h('div', { class: 'who-name' }, h('span', { text: a.display_name }),
        consul ? h('span', { class: 'pill consul', text: 'Consul' }) : null,
        h('span', { class: 'pill ' + act.cls, text: act.label })),
      h('div', { class: 'who-sub', text: a.presence && a.presence.online
        ? `@${a.handle}, ${(a.presence.modes || []).includes('jump') ? 'queue and jump queue' : 'queue only'}`
        : `@${a.handle}, offline: messages wait until it reconnects` })));
}

function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight <= 48; }

function messageNode(m, ctx) {
  const mine = m.sender && (m.sender.kind === 'owner' || m.sender.id === ownerId());
  const team = S.conv.kind === 'agent_agent';
  const consul = m.sender && m.sender.role === 'consul';
  const head = h('div', { class: 'msg-head' },
    h('strong', { text: mine ? 'You' : m.sender.display_name }),
    consul ? h('span', { class: 'tag-consul', text: 'Consul' }) : null,
    team ? h('span', { text: `to ${m.recipient.display_name}` }) : null,
    h('time', { datetime: new Date((m.created_at || now()) * 1000).toISOString(), title: fullTime(m.created_at),
      text: shortTime(m.created_at) }),
    m.mode === 'jump' ? h('span', { class: 'pill info', text: 'Jump queue' }) : null,
    m.retry ? h('span', { class: 'pill', text: 'retried' }) : null);
  const bubble = h('div', { class: 'bubble' }, head,
    m.reply_to ? h('div', { class: 'quote', text: `${m.reply_to.sender_name}: ${m.reply_to.excerpt}` }) : null,
    m.body ? h('div', { class: 'msg-body' }, renderBody(m.body)) : null,
    h('div', { class: 'image-strip' }, (m.attachments || []).map(thumb)));
  const foot = h('div', { class: 'msg-foot' });
  if (mine && m.recipient && m.recipient.kind === 'agent' && MOD.life) {
    const handlers = {};
    if (m.local === 'send_failed') { handlers.onRetrySend = retrySend; handlers.onDiscard = discardSend; }
    else if (m.state === 'unconfirmed') handlers.onRetryDelivery = retryDelivery;
    const life = MOD.life.render(m, { replied: MOD.life.replied(m, ctx.msgs), now: now() }, handlers);
    if (m.id != null) S.lifeNodes.set(m.id, { el: life, handlers });
    foot.append(life);
  } else if (team && m.state && m.state !== 'delivered') {
    foot.append(h('span', { class: 'msg-state ' + m.state, text: m.state === 'waiting' ? 'waiting' : m.state === 'failed'
      ? `failed: ${m.state_reason || 'delivery failed'}` : m.state }));
  }
  if (!S.conv.read_only && !team && m.id != null && !m.local) {
    foot.append(h('button', { type: 'button', class: 'quiet', onclick: () => { S.replyTo = m; saveDraft(); renderComposer();
      $('compose-body').focus(); } }, 'Reply'));
  }
  bubble.append(foot);
  const node = h('div', { class: 'msg' + (mine ? ' mine' : '') + (m.local ? ' local' : ''), 'data-msg-id': m.id || '' });
  if (!mine) node.append(avatar(m.sender, 'sm', { consul }));
  node.append(bubble);
  return node;
}

function thumb(image) {
  const url = '/api/v1/attachments/' + Number(image.id);
  const img = h('img', { src: url, alt: image.filename || 'Image', loading: 'lazy', width: 120, height: 72 });
  if (MOD.pop) MOD.pop.enhance(img);
  return img;
}

function renderMessages(opts) {
  const box = $('messages');
  const o = opts || {};
  const wasNear = nearBottom(box);
  const top = box.scrollTop;
  clear(box);
  S.lifeNodes.clear();
  if (!S.conv) {
    box.append(h('div', { class: 'conv-empty-state' }, h('div', {},
      h('h2', { class: 'pane-title', text: 'No conversation selected' }),
      h('p', { text: 'Pick a conversation, or choose Chat next to an agent.' }))));
    return;
  }
  const local = S.optimistic.filter((x) => (S.conv.id != null ? x.conversation_id === S.conv.id
    : S.conv.pendingTo && x.agent_id === S.conv.pendingTo.id));
  const all = S.msgs.concat(local);
  if (!all.length) {
    box.append(h('div', { class: 'conv-empty-state' }, h('p', { text: S.conv.pendingTo
      ? `Start the conversation with ${S.conv.pendingTo.display_name}.` : 'No messages yet.' })));
  }
  const ctx = { msgs: S.msgs };
  for (const m of all) box.append(messageNode(m, ctx));
  if (o.toBottom || wasNear) {
    box.scrollTop = box.scrollHeight;
    $('new-pill').hidden = true;
  } else {
    box.scrollTop = top;
    if (o.grew) $('new-pill').hidden = false;
  }
  maybeMarkRead();
}

$('messages').addEventListener('scroll', () => {
  if (nearBottom($('messages'))) { $('new-pill').hidden = true; maybeMarkRead(); }
}, { passive: true });
$('new-pill').addEventListener('click', () => {
  const box = $('messages');
  box.scrollTo({ top: box.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('new-pill').hidden = true;
  setTimeout(maybeMarkRead, 300);
});

function refreshLifecycles() {
  if (!MOD.life) return;
  const t = now();
  for (const m of S.msgs) {
    const n = S.lifeNodes.get(m.id);
    if (n) MOD.life.update(n.el, m, { replied: MOD.life.replied(m, S.msgs), now: t }, n.handlers);
  }
}

async function retryDelivery(m) {
  if (!window.confirm('Retry delivery? The agent may have received it already; it will be marked as a retry.')) return;
  try { await api('POST', `/api/v1/admin/messages/${m.id}/retry`, {}); await reloadConv(); }
  catch (e) { window.alert(e.message); }
}

// =============================================================================
// Composer: drafts, auto-grow, modes, images, sending
// =============================================================================

function restoreDraft() {
  const key = draftKey();
  const d = key && store ? store.drafts.load(key) : null;
  $('compose-body').value = d ? d.text : '';
  S.replyTo = null;
  if (d && d.replyToId) S.replyTo = { id: d.replyToId, pending: true };
  S.draftMode = d ? d.mode : null;
  $('draft-hint').textContent = d && d.text ? 'Draft restored' : '';
  autoGrow();
}

function saveDraft() {
  const key = draftKey();
  if (!key || !store) return;
  store.drafts.save(key, { text: $('compose-body').value, replyToId: S.replyTo ? S.replyTo.id : null,
    mode: $('compose-mode').value || 'queue' });
  $('draft-hint').textContent = $('compose-body').value ? 'Draft saved' : '';
}

function autoGrow() {
  const el = $('compose-body');
  const max = Math.min(220, window.innerHeight * 0.32);
  el.style.height = 'auto';
  const next = Math.min(Math.max(el.scrollHeight, 40), max);
  el.style.height = next + 'px';
  el.style.overflowY = el.scrollHeight > next ? 'auto' : 'hidden';
  const comp = $('composer');
  if (!comp.hidden) $('pane-chats').style.setProperty('--composer-h', comp.offsetHeight + 'px');
}

function resolveReply() {
  if (S.replyTo && S.replyTo.pending) {
    const m = S.msgs.find((x) => x.id === S.replyTo.id);
    S.replyTo = m || null;
  }
}

function renderComposer() {
  const ro = !S.conv || S.conv.read_only || S.conv.kind === 'agent_agent';
  $('read-only').hidden = !(S.conv && ro);
  $('composer').hidden = ro;
  if (ro) return;
  resolveReply();
  const agent = recipientAgent();
  const modes = (agent && agent.presence && agent.presence.modes) || ['queue'];
  const prev = $('compose-mode').value;
  const sel = clear($('compose-mode'));
  const want = S.draftMode && modes.includes(S.draftMode) ? S.draftMode : (modes.includes(prev) ? prev : modes[0]);
  modes.forEach((m) => sel.append(h('option', { value: m, selected: m === want, text: m === 'jump' ? 'Jump queue' : 'Queue' })));
  sel.parentElement.hidden = modes.length < 2;
  $('compose-mode-static').hidden = modes.length >= 2;
  $('compose-mode-static').textContent = modes[0] === 'jump' ? 'Jump queue' : 'Queue';
  const rt = clear($('reply-to'));
  rt.hidden = !S.replyTo;
  if (S.replyTo) {
    const excerpt = S.replyTo.body ? S.replyTo.body.slice(0, 120) : ((S.replyTo.attachments || []).length ? '[Image]' : '');
    rt.append(h('span', { text: `Replying to ${S.replyTo.sender ? S.replyTo.sender.display_name : 'message'}: ${excerpt}` }),
      h('button', { type: 'button', class: 'quiet', 'aria-label': 'Cancel reply', onclick: () => {
        S.replyTo = null; saveDraft(); renderComposer(); } }, 'Cancel'));
  }
  renderImages();
  autoGrow();
}

function renderImages() {
  const agent = recipientAgent();
  const allowed = supportsImages(agent);
  const note = $('compose-image-note');
  note.hidden = allowed || !S.conv;
  note.textContent = allowed ? '' : 'Image sending is disabled for this agent (text only).';
  const attach = $('compose-attach');
  attach.disabled = !allowed || S.sending;
  attach.title = allowed ? 'Attach images' : 'Images disabled: this agent does not support image input';
  if (!allowed && S.staged.length) S.staged = [];
  const strip = clear($('compose-attachments'));
  for (const item of S.staged) {
    strip.append(h('div', { class: 'staged-image' },
      item.image ? thumb(item.image) : h('span', { class: 'staged-uploading', text: 'Uploading…' }),
      h('button', { type: 'button', class: 'remove', disabled: S.sending, 'aria-label': 'Remove ' + item.name,
        onclick: () => { S.staged.splice(S.staged.indexOf(item), 1); renderImages(); } }, '×')));
  }
  $('compose-send').disabled = S.sending || S.staged.some((item) => !item.image)
    || !($('compose-body').value.trim() || S.staged.length);
}

async function stageImages(files) {
  const error = $('compose-error');
  if (!supportsImages(recipientAgent()) || !S.conv || S.conv.read_only) {
    error.textContent = 'Image sending is disabled for this agent (text only).';
    return;
  }
  if (S.sending) return;
  error.textContent = '';
  const staged = S.staged;
  const settings = S.board.settings || {};
  if (staged.length + files.length > (settings.max_attachments_per_message || 4)) {
    error.textContent = 'You can attach up to ' + (settings.max_attachments_per_message || 4) + ' images.';
    return;
  }
  for (const file of files) {
    if (!file.size || file.size > (settings.max_attachment_bytes || 10485760)) {
      error.textContent = file.name + ' is empty or exceeds the image size limit.';
      continue;
    }
    const item = { name: file.name };
    staged.push(item);
    renderImages();
    api('POST', '/api/v1/attachments', file, { 'X-Filename': encodeURIComponent(file.name) })
      .then((r) => { item.image = r.attachment; })
      .catch((e) => {
        if (staged === S.staged && staged.includes(item)) {
          staged.splice(staged.indexOf(item), 1);
          error.textContent = e.message;
        }
      }).finally(() => { if (staged === S.staged) renderImages(); });
  }
}

$('compose-attach').addEventListener('click', () => $('compose-files').click());
$('compose-files').addEventListener('change', (ev) => { stageImages(Array.from(ev.target.files)); ev.target.value = ''; });
$('composer').addEventListener('paste', (ev) => {
  const files = Array.from(ev.clipboardData.files);
  if (files.length) { ev.preventDefault(); stageImages(files); }
});
$('composer').addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('Files')) ev.preventDefault(); });
$('composer').addEventListener('drop', (ev) => {
  const files = Array.from(ev.dataTransfer.files);
  if (files.length) { ev.preventDefault(); stageImages(files); }
});
$('compose-body').addEventListener('input', () => { saveDraft(); autoGrow(); renderImages(); });
$('compose-mode').addEventListener('change', () => { S.draftMode = $('compose-mode').value; saveDraft(); });
window.addEventListener('resize', autoGrow);

$('compose-body').addEventListener('keydown', (ev) => {
  if (ev.isComposing || ev.keyCode === 229) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
    ev.preventDefault();
    if (!$('compose-send').disabled) $('composer').requestSubmit();
  }
});

function clientId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if ($('compose-send').disabled || !S.conv || S.conv.read_only) return;
  const agent = recipientAgent();
  if (!agent) return;
  // Sending the same text again after a failure retries that message (same client id).
  const failed = S.optimistic.find((x) => x.local === 'send_failed' && x.agent_id === agent.id
    && x.body === $('compose-body').value && !S.staged.length);
  if (failed) { retrySend(failed); return; }
  const entry = {
    local: 'sending', id: null, client_msg_id: clientId(), body: $('compose-body').value,
    attachment_ids: S.staged.map((item) => item.image.id),
    attachments: S.staged.map((item) => item.image),
    mode: $('compose-mode').value || 'queue', reply_to_id: S.replyTo ? S.replyTo.id : null,
    reply_to: S.replyTo ? { id: S.replyTo.id, sender_name: S.replyTo.sender ? S.replyTo.sender.display_name : '',
      excerpt: (S.replyTo.body || '').slice(0, 160) } : null,
    created_at: now(), sender: { id: ownerId(), kind: 'owner', display_name: 'You' },
    recipient: { id: agent.id, kind: 'agent', display_name: agent.display_name },
    conversation_id: S.conv.id, agent_id: agent.id, draftKey: draftKey(),
  };
  S.optimistic.push(entry);
  sendEntry(entry);
});

async function sendEntry(entry) {
  entry.local = 'sending';
  S.sending = true;
  renderMessages({ toBottom: true });
  renderImages();
  const payload = { body: entry.body, mode: entry.mode, attachment_ids: entry.attachment_ids, client_msg_id: entry.client_msg_id };
  try {
    const r = entry.reply_to_id
      ? await api('POST', `/api/v1/messages/${entry.reply_to_id}/reply`, payload)
      : await api('POST', '/api/v1/messages', Object.assign({ to: entry.agent_id }, payload));
    S.optimistic.splice(S.optimistic.indexOf(entry), 1);
    // Clear the composer and the draft only after the server accepted the message.
    if (store && entry.draftKey) {
      const convKey = store.drafts.key({ convId: r.message.conversation_id });
      store.drafts.migrate(entry.draftKey, convKey);
    }
    const sameConv = S.conv && ((S.conv.id != null && S.conv.id === r.message.conversation_id)
      || (S.conv.pendingTo && S.conv.pendingTo.id === entry.agent_id));
    if (sameConv && $('compose-body').value === entry.body) {
      $('compose-body').value = '';
      $('draft-hint').textContent = '';
      S.staged = [];
      S.replyTo = null;
    }
    S.sending = false;
    const convs = await api('GET', '/api/v1/conversations');
    S.convs = convs.conversations || [];
    renderConvList();
    if (sameConv && S.conv.id == null) {
      S.conv.id = r.message.conversation_id;
      S.conv.pendingTo = null;
      S.view.selectedConvId = S.conv.id;
      S.view.pendingAgentId = null;
      saveView();
    }
    if (sameConv) await reloadConv({ toBottom: true });
  } catch (e) {
    entry.local = 'send_failed';
    entry.local_error = e.status ? e.message : 'network error';
    S.sending = false;
    $('compose-error').textContent = `Not sent: ${entry.local_error}. Your text is still in the box.`;
    renderMessages({ toBottom: true });
  } finally {
    S.sending = false;
    renderComposer();
  }
}

function retrySend(entry) {
  $('compose-error').textContent = '';
  sendEntry(entry);
}

function discardSend(entry) {
  S.optimistic.splice(S.optimistic.indexOf(entry), 1);
  $('compose-error').textContent = '';
  renderMessages({});
}

// =============================================================================
// Projects and tasks
// =============================================================================

function activeProject() {
  const list = (S.board && S.board.projects) || [];
  return list.find((p) => p.id === (S.view && S.view.activeProjectId)) || null;
}

function stateLabel(list, key) { const f = list.find((x) => x[0] === key); return f ? f[1] : key; }

function taskPill(status) {
  const cls = { done: 'ok', blocked: 'bad', in_review: 'info', in_progress: 'warn' }[status] || '';
  return h('span', { class: 'pill ' + cls, text: stateLabel(TASK_STATES, status) });
}

function projectPill(status) {
  const cls = { active: 'ok', paused: 'warn', completed: 'info' }[status] || '';
  return h('span', { class: 'pill ' + cls, text: stateLabel(PROJECT_STATES, status) });
}

function avatarRow(people, size) {
  return h('span', { class: 'avatar-row' }, (people || []).slice(0, 6).map((p) => avatar(p, size || 'xs',
    { label: p.display_name, consul: p.role === 'consul' })));
}

function renderProjects() {
  if (!S.board) return;
  const root = clear($('projects'));
  const projects = S.board.projects || [];
  const filter = S.view.projectStatusFilter;
  const list = h('div', { class: 'proj-list' },
    h('div', { class: 'proj-toolbar' }, h('h2', { class: 'pane-title', text: 'Projects' }),
      h('button', { type: 'button', class: 'primary', onclick: () => openProjectDialog(null) }, 'New project')),
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter projects by status' },
      [['all', 'All']].concat(PROJECT_STATES).map(([k, label]) => h('button', { type: 'button', class: 'filter',
        'aria-pressed': String(filter === k), onclick: () => { S.view.projectStatusFilter = k; saveView(); renderProjects(); } }, label))));
  const shown = projects.filter((p) => filter === 'all' || p.status === filter);
  if (!shown.length) list.append(h('p', { class: 'list-empty', text: projects.length ? 'No projects with this status.' : 'No projects yet.' }));
  for (const p of shown) {
    const done = p.tasks.filter((t) => t.status === 'done').length;
    list.append(h('button', { type: 'button', class: 'proj-card' + (S.view.activeProjectId === p.id ? ' active' : ''),
      onclick: () => { S.view.activeProjectId = p.id; S.view.projectView = 'detail'; saveView(); renderProjects(); renderTabs(); } },
      h('span', { class: 'proj-card-top' }, h('span', { class: 'proj-card-name', text: p.name }), projectPill(p.status)),
      h('span', { class: 'proj-card-foot' },
        h('span', { class: 'person' }, p.pm ? avatar(p.pm, 'xs') : null, p.pm ? p.pm.display_name : 'No manager'),
        avatarRow(p.members), h('span', { class: 'tnum', text: `${done}/${p.tasks.length} done` }))));
  }
  const detail = h('div', { class: 'proj-detail' });
  const p = activeProject();
  if (!p) {
    detail.append(h('div', { class: 'conv-empty-state' }, h('div', {},
      h('h2', { class: 'pane-title', text: 'Projects and tasks' }),
      h('p', { text: 'Choose a project to see its tasks, or create one.' }))));
  } else {
    detail.append(projectDetail(p));
  }
  root.append(list, detail);
  root.dataset.view = S.view.projectView === 'detail' && p ? 'detail' : 'list';
}

function projectDetail(p) {
  const tf = S.view.taskStatusFilter;
  const frag = document.createDocumentFragment();
  frag.append(h('div', { class: 'proj-head' },
    h('div', { class: 'proj-head-top' },
      h('button', { type: 'button', class: 'proj-back conv-back quiet', 'aria-label': 'Back to projects',
        onclick: () => { S.view.projectView = 'list'; saveView(); renderTabs(); } }, icon('back', 18)),
      h('h2', { class: 'pane-title', text: p.name }), projectPill(p.status),
      h('button', { type: 'button', class: 'ghost', onclick: () => openProjectDialog(p) }, 'Edit project')),
    p.description ? h('div', { class: 'msg-body' }, renderBody(p.description)) : null,
    h('div', { class: 'people' },
      h('span', {}, 'Manager ', p.pm ? h('span', { class: 'person' }, avatar(p.pm, 'xs'), p.pm.display_name) : 'none'),
      h('span', {}, `Members (${p.members.length}) `, avatarRow(p.members)))));
  frag.append(h('div', { class: 'proj-toolbar' },
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter tasks by status' },
      [['all', 'All']].concat(TASK_STATES).map(([k, label]) => h('button', { type: 'button', class: 'filter',
        'aria-pressed': String(tf === k), onclick: () => { S.view.taskStatusFilter = k; saveView(); renderProjects(); } },
        label + (k === 'all' ? '' : ` ${p.tasks.filter((t) => t.status === k).length}`)))),
    h('button', { type: 'button', class: 'primary', disabled: !p.members.length,
      title: p.members.length ? null : 'Add members before creating tasks', onclick: () => openTaskDialog(p, null) }, 'New task')));
  const tasks = p.tasks.filter((t) => tf === 'all' || t.status === tf)
    .sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.priority - a.priority || a.id - b.id);
  const list = h('div', { class: 'tasks' });
  if (!tasks.length) list.append(h('p', { class: 'list-empty', text: p.tasks.length ? 'No tasks with this status.' : 'No tasks yet.' }));
  for (const t of tasks) {
    const statusSel = h('select', { 'aria-label': `Status of ${t.title}`, onchange: (ev) => patchTask(t, { status: ev.target.value }) },
      TASK_STATES.map(([k, label]) => h('option', { value: k, selected: t.status === k, text: label })));
    list.append(h('div', { class: 'task' },
      h('span', { class: 'prio p' + Math.max(0, Math.min(3, t.priority)), title: 'Priority',
        text: stateLabel(PRIORITIES, Math.max(0, Math.min(3, t.priority))) }),
      h('span', { class: 'task-title', text: t.title }),
      h('span', { class: 'task-side' }, statusSel,
        h('button', { type: 'button', class: 'quiet', onclick: () => openTaskDialog(p, t) }, 'Edit')),
      t.description ? h('span', { class: 'task-desc', text: t.description.slice(0, 180) }) : null,
      h('span', { class: 'task-who' }, t.assignees.map((a) => h('button', { type: 'button', title: `Chat with ${a.display_name}`,
        'aria-label': `Chat with ${a.display_name}`, onclick: () => { const ag = agentById(a.id); if (ag) openWith(ag); } },
        avatar(a, 'xs'))))));
  }
  frag.append(list);
  return frag;
}

async function patchTask(t, data) {
  try { await api('PATCH', `/api/v1/tasks/${t.id}`, data); schedule({ board: true }); }
  catch (e) { window.alert(e.message); schedule({ board: true }); }
}

function memberChecks(root, people, selected, locked) {
  clear(root);
  if (!people.length) root.append(h('p', { class: 'list-empty', text: 'No eligible agents.' }));
  for (const p of people) {
    const id = `${root.id}-${p.id}`;
    root.append(h('label', { class: 'pick', for: id },
      h('input', { type: 'checkbox', id, value: p.id, checked: selected.includes(p.id), disabled: locked === p.id }),
      avatar(p, 'xs'), p.display_name, p.role === 'consul' ? h('span', { class: 'tag-consul', text: 'Consul' }) : null));
  }
}

let editingProject = null;
let editingTask = null;
let taskProject = null;

function openProjectDialog(p) {
  editingProject = p;
  $('project-dialog-title').textContent = p ? 'Edit project' : 'New project';
  $('pf-submit').textContent = p ? 'Save project' : 'Create project';
  $('pf-name').value = p ? p.name : '';
  $('pf-desc').value = p ? (p.description || '') : '';
  const statusSel = clear($('pf-status'));
  PROJECT_STATES.forEach(([k, label]) => statusSel.append(h('option', { value: k, selected: (p ? p.status : 'active') === k, text: label })));
  statusSel.disabled = !p;
  const agents = (S.board.agents || []).filter((a) => a.status === 'admitted');
  const pm = clear($('pf-pm'));
  pm.append(h('option', { value: '', text: 'No manager' }));
  agents.forEach((a) => pm.append(h('option', { value: a.id, selected: p && p.pm_principal_id === a.id, text: a.display_name })));
  const selected = p ? p.members.map((m) => m.id) : [];
  const paint = () => memberChecks($('pf-members'), agents, selected.concat(pm.value ? [Number(pm.value)] : []),
    pm.value ? Number(pm.value) : null);
  pm.onchange = () => {
    selected.splice(0, selected.length, ...Array.from($('pf-members').querySelectorAll('input:checked')).map((i) => Number(i.value)));
    paint();
  };
  paint();
  $('pf-error').textContent = '';
  $('project-dialog').showModal();
  $('pf-name').focus();
}

$('project-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pm = $('pf-pm').value ? Number($('pf-pm').value) : null;
  const ids = Array.from($('pf-members').querySelectorAll('input:checked')).map((i) => Number(i.value));
  if (pm && !ids.includes(pm)) ids.push(pm);
  const body = { name: $('pf-name').value.trim(), description: $('pf-desc').value.trim() || null,
    pm_principal_id: pm, member_ids: ids };
  if (!body.name) { $('pf-error').textContent = 'Enter a project name.'; return; }
  try {
    let r;
    if (editingProject) r = await api('PATCH', `/api/v1/projects/${editingProject.id}`, Object.assign(body, { status: $('pf-status').value }));
    else r = await api('POST', '/api/v1/projects', body);
    $('project-dialog').close();
    S.view.activeProjectId = r.project.id;
    S.view.projectView = 'detail';
    saveView();
    schedule({ board: true });
  } catch (e) {
    $('pf-error').textContent = e.data && e.data.error === 'member_has_sole_task'
      ? 'A member you removed is the only assignee of an unfinished task. Reassign that task first.' : e.message;
  }
});

function openTaskDialog(p, t) {
  taskProject = p;
  editingTask = t;
  $('task-dialog-title').textContent = t ? 'Edit task' : 'New task';
  $('tf-submit').textContent = t ? 'Save task' : 'Create task';
  $('tf-project').textContent = `Project: ${p.name}`;
  $('tf-title').value = t ? t.title : '';
  $('tf-desc').value = t ? (t.description || '') : '';
  const st = clear($('tf-status'));
  TASK_STATES.forEach(([k, label]) => st.append(h('option', { value: k, selected: (t ? t.status : 'open') === k, text: label })));
  const pr = clear($('tf-priority'));
  PRIORITIES.forEach(([k, label]) => pr.append(h('option', { value: k, selected: (t ? t.priority : 1) === k, text: label })));
  // Assignees come strictly from the project's members (spec 8.3).
  memberChecks($('tf-assignees'), p.members, t ? t.assignees.map((a) => a.id) : []);
  $('tf-error').textContent = '';
  $('task-dialog').showModal();
  $('tf-title').focus();
}

$('task-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ids = Array.from($('tf-assignees').querySelectorAll('input:checked')).map((i) => Number(i.value));
  if (!ids.length) { $('tf-error').textContent = 'Select at least one project member.'; return; }
  const body = { title: $('tf-title').value.trim(), description: $('tf-desc').value.trim() || null,
    status: $('tf-status').value, priority: Number($('tf-priority').value), assignee_ids: ids };
  if (!body.title) { $('tf-error').textContent = 'Enter a task title.'; return; }
  try {
    if (editingTask) await api('PATCH', `/api/v1/tasks/${editingTask.id}`, body);
    else await api('POST', `/api/v1/projects/${taskProject.id}/tasks`, body);
    $('task-dialog').close();
    schedule({ board: true });
  } catch (e) { $('tf-error').textContent = e.message; }
});

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// =============================================================================
// Admin & Senate
// =============================================================================

function listRow(...kids) { return h('div', { class: 'list-row' }, ...kids); }

function renderAdminSenate() {
  if (!S.board) return;
  renderSenate();
  renderAdmin();
}

function renderSenate() {
  const box = clear($('senate-status'));
  const consul = S.board.consul;
  box.classList.toggle('has-consul', !!consul);
  if (consul) {
    box.append(avatar(consul, 'lg', { consul: true, status: consul.presence && consul.presence.online ? 'on' : 'off' }),
      h('div', {},
        h('div', { class: 'consul-name', text: consul.display_name }),
        h('div', { class: 'muted' }, `@${consul.handle}, `, consul.presence && consul.presence.online ? 'online' : 'offline'),
        h('span', { class: 'pill consul', text: 'Consul' })));
  } else {
    box.append(h('p', { class: 'muted', text: 'No Consul currently appointed.' }));
  }
  const sel = clear($('senate-agent'));
  const admitted = (S.board.agents || []).filter((a) => a.status === 'admitted');
  if (!admitted.length) sel.append(h('option', { value: '', text: 'No admitted agents available' }));
  admitted.forEach((a) => sel.append(h('option', { value: a.id, selected: !!(consul && consul.id === a.id),
    text: `${a.display_name} (@${a.handle})` })));
  $('senate-dismiss').disabled = !consul;
  const list = clear($('senate-invites'));
  const items = S.board.senate_invites || [];
  if (!items.length) list.append(h('p', { class: 'list-empty', text: 'No Consul-issued invites yet.' }));
  for (const i of items) {
    list.append(listRow(
      h('strong', { text: i.display_name || i.handle || `invite ${i.id}` }),
      h('span', { class: 'pill ' + (i.state === 'open' ? 'info' : i.state === 'redeemed' ? 'ok' : ''), text: i.state }),
      h('span', { class: 'grow muted', text: `issued by @${i.issued_by ? i.issued_by.handle : 'unknown'}${i.reason ? `: ${i.reason}` : ''}` }),
      h('span', { class: 'muted', title: fullTime(i.created_at), text: shortTime(i.created_at) }),
      i.state === 'open' ? h('button', { type: 'button', class: 'danger', onclick: () => cancelInvite(i) }, 'Cancel') : null));
  }
}

$('senate-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('senate-error').textContent = '';
  const pid = $('senate-agent').value;
  if (!pid) { $('senate-error').textContent = 'Select an admitted agent to appoint.'; return; }
  try { await api('POST', '/api/v1/senate/consul', { principal_id: Number(pid) }); schedule({ board: true, convs: true }); }
  catch (e) { $('senate-error').textContent = e.message; }
});

$('senate-dismiss').addEventListener('click', async () => {
  $('senate-error').textContent = '';
  const c = S.board.consul;
  if (!c || !window.confirm(`Dismiss ${c.display_name} as Consul?`)) return;
  try { await api('DELETE', '/api/v1/senate/consul'); schedule({ board: true, convs: true }); }
  catch (e) { $('senate-error').textContent = e.message; }
});

function poolLabel(p) { return `${providerName(p.provider)}: ${p.label}`; }

function renderAdmin() {
  const pools = S.board.pools || [];
  const keep = $('inv-pool').value;
  const sel = clear($('inv-pool'));
  sel.append(h('option', { value: '', text: 'No pool' }));
  pools.forEach((p) => sel.append(h('option', { value: p.id, selected: String(p.id) === keep, text: poolLabel(p) })));

  const inv = clear($('invites'));
  if (!S.board.invites.length) inv.append(h('p', { class: 'list-empty', text: 'No open invites.' }));
  for (const i of S.board.invites) {
    inv.append(listRow(
      h('strong', { text: i.display_name || i.handle || `invite ${i.id}` }),
      i.target_principal_id ? h('span', { class: 'pill info', text: 're-admission' }) : null,
      h('span', { class: 'grow muted', text: [i.issued_by ? `by ${i.issued_by.display_name}` : null,
        i.reason ? `reason: ${i.reason}` : null].filter(Boolean).join(', ') }),
      h('span', { class: 'muted', title: fullTime(i.expires_at), text: `expires ${shortTime(i.expires_at)}` }),
      h('button', { type: 'button', class: 'danger', onclick: () => cancelInvite(i) }, 'Cancel')));
  }

  const rev = clear($('revoked'));
  const revoked = (S.board.agents || []).filter((a) => a.status !== 'admitted');
  if (!revoked.length) rev.append(h('p', { class: 'list-empty', text: 'No revoked agents.' }));
  for (const a of revoked) {
    rev.append(listRow(avatar(a, 'sm'), h('strong', { text: a.display_name }), h('span', { class: 'grow muted', text: '@' + a.handle }),
      h('button', { type: 'button', class: 'ghost', onclick: () => readmit(a) }, 'Re-admit')));
  }

  const pr = clear($('pools'));
  if (!pools.length) pr.append(h('p', { class: 'list-empty', text: 'No account pools yet.' }));
  for (const p of pools) {
    const members = (S.board.agents || []).filter((a) => a.pool && a.pool.id === p.id);
    const field = (label, key, value) => h('label', {}, label, h('input', { value: value || '', 'data-key': key, autocomplete: 'off' }));
    const form = h('form', { class: 'pool-edit', onsubmit: (ev) => { ev.preventDefault(); savePool(p, form); } },
      field('Label', 'label', p.label), field('Account', 'account_label', p.account_label),
      field('Subscription', 'subscription', p.subscription), field('Notes', 'notes', p.notes),
      h('label', {}, 'Usage reporter', h('select', { onchange: (ev) => setReporter(p, ev.target.value) },
        h('option', { value: '', text: 'No reporter' }),
        ...members.map((a) => h('option', { value: a.id, selected: p.reporter_principal_id === a.id, text: a.display_name })))),
      h('button', { type: 'submit', class: 'ghost' }, 'Save'));
    pr.append(h('div', { class: 'list-row' },
      h('strong', { class: 'grow', text: poolLabel(p) }), h('span', { class: 'muted', text: `${members.length} member(s)` }), form));
  }
}

async function savePool(p, form) {
  $('pool-error').textContent = '';
  const body = {};
  form.querySelectorAll('input[data-key]').forEach((i) => { body[i.dataset.key] = i.value.trim() || null; });
  if (!body.label) delete body.label;
  try { await api('PATCH', `/api/v1/admin/pools/${p.id}`, body); schedule({ board: true }); }
  catch (e) { $('pool-error').textContent = e.message; }
}

function showCode(code, who) {
  const box = clear($('invite-code'));
  box.hidden = false;
  const status = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  const copy = h('button', { type: 'button', class: 'ghost', onclick: () => {
    const done = (t) => { copy.textContent = t; status.textContent = t; setTimeout(() => { copy.textContent = 'Copy'; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => done('Copied'), () => done('Copy failed'));
    else done('Copy failed');
  } }, 'Copy');
  box.append(h('strong', { text: `One-time invite${who ? ` for ${who}` : ''} (shown once, expires in 24 hours)` }),
    h('code', { text: code }),
    h('span', { class: 'muted', text: 'In the agent session run: /lyra-link join <code> (see the lyra-link skill).' }),
    h('div', {}, copy, status));
  box.scrollIntoView({ block: 'nearest' });
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
    schedule({ board: true });
  } catch (e) { $('admin-error').textContent = e.message; }
});

$('pool-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('pool-error').textContent = '';
  try {
    await api('POST', '/api/v1/admin/pools', { provider: $('pool-provider').value, label: $('pool-label').value,
      account_label: $('pool-account').value || null, subscription: $('pool-subscription').value || null });
    ['pool-provider', 'pool-label', 'pool-account', 'pool-subscription'].forEach((id) => { $(id).value = ''; });
    schedule({ board: true });
  } catch (e) { $('pool-error').textContent = e.message; }
});

async function cancelInvite(i) {
  if (!window.confirm('Cancel this invite? The code will stop working.')) return;
  try { await api('DELETE', `/api/v1/admin/invites/${i.id}`); schedule({ board: true }); }
  catch (e) { $('admin-error').textContent = e.message; }
}

async function setReporter(p, value) {
  try { await api('PATCH', `/api/v1/admin/pools/${p.id}`, { reporter_principal_id: value === '' ? null : Number(value) }); schedule({ board: true }); }
  catch (e) { $('pool-error').textContent = e.message; }
}

// =============================================================================
// Power-user ergonomics: quick switcher, conversation stepping, shortcuts
// =============================================================================

function fuzzy(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100 - t.length / 100;
  const idx = t.indexOf(q);
  if (idx !== -1) return 60 - idx / 10;
  let ti = 0; let score = 0; let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return 0;
    run = at === ti ? run + 1 : 0;
    score += 1 + run + (at === 0 || /[\s@._-]/.test(t[at - 1]) ? 3 : 0);
    ti = at + 1;
  }
  return Math.min(50, score);
}

function quickItems() {
  const items = [];
  for (const c of orderedConvs().flat) {
    items.push({ kind: 'Conversation', label: convTitle(c), sub: c.last ? c.last.excerpt : '', avatar: convAgents(c)[0],
      run: () => openConv(c.id, { user: true }) });
  }
  for (const a of (S.board.agents || []).filter((x) => x.status === 'admitted')) {
    items.push({ kind: 'Agent', label: `${a.display_name} @${a.handle}`, sub: activity(a).label, avatar: a,
      run: () => openWith(a) });
  }
  for (const p of (S.board.projects || [])) {
    items.push({ kind: 'Project', label: p.name, sub: stateLabel(PROJECT_STATES, p.status), run: () => {
      S.view.activeProjectId = p.id; S.view.projectView = 'detail'; saveView(); setTab('projects'); renderProjects(); } });
  }
  [['chats', 'Chats'], ['projects', 'Projects'], ['admin-senate', 'Admin & Senate'], ['agents', 'Agents']].forEach(([k, label]) =>
    items.push({ kind: 'Section', label, sub: '', run: () => setTab(k) }));
  return items;
}

function renderQuick() {
  const q = $('qs-input').value.trim();
  const scored = S.qs.all.map((it, i) => ({ it, s: fuzzy(q, it.label), i })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 30);
  S.qs.items = scored.map((x) => x.it);
  S.qs.sel = Math.min(S.qs.sel, Math.max(0, S.qs.items.length - 1));
  const list = clear($('qs-list'));
  S.qs.items.forEach((it, i) => {
    const li = h('li', { class: 'qs-item', role: 'option', id: 'qs-opt-' + i, 'aria-selected': String(i === S.qs.sel),
      onclick: () => runQuick(i), onmousemove: () => { if (S.qs.sel !== i) { S.qs.sel = i; renderQuick(); } } },
      it.avatar ? avatar(it.avatar, 'sm') : h('span', { class: 'qs-icon', 'aria-hidden': 'true', text: it.kind[0] }),
      h('span', { class: 'conv-text' }, h('span', { class: 'conv-title', text: it.label }),
        it.sub ? h('span', { class: 'conv-excerpt', text: it.sub }) : null),
      h('span', { class: 'qs-kind', text: it.kind }));
    list.append(li);
  });
  if (!S.qs.items.length) list.append(h('li', { class: 'list-empty', text: 'No matches' }));
  $('qs-input').setAttribute('aria-activedescendant', S.qs.items.length ? 'qs-opt-' + S.qs.sel : '');
  const active = $('qs-opt-' + S.qs.sel);
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function openQuick() {
  if (!S.board || $('main').hidden) return;
  const d = $('qs-dialog');
  S.qs.all = quickItems();
  S.qs.sel = 0;
  $('qs-input').value = '';
  renderQuick();
  if (!d.open) d.showModal();
  $('qs-input').focus();
}

function runQuick(i) {
  const it = S.qs.items[i];
  $('qs-dialog').close();
  if (it) it.run();
}

$('qs-open').addEventListener('click', openQuick);
$('qs-input').addEventListener('input', () => { S.qs.sel = 0; renderQuick(); });
$('qs-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); S.qs.sel = Math.min(S.qs.items.length - 1, S.qs.sel + 1); renderQuick(); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); S.qs.sel = Math.max(0, S.qs.sel - 1); renderQuick(); }
  else if (ev.key === 'Enter') { ev.preventDefault(); runQuick(S.qs.sel); }
});
$('qs-kbd').textContent = IS_MAC ? '⌘ K' : 'Ctrl K';

function stepConversation(dir) {
  const flat = orderedConvs().flat;
  if (!flat.length) return;
  const at = S.conv && S.conv.id != null ? flat.findIndex((c) => c.id === S.conv.id) : -1;
  const next = flat[Math.max(0, Math.min(flat.length - 1, at === -1 ? 0 : at + dir))];
  if (next) openConv(next.id, { user: true });
}

document.addEventListener('keydown', (ev) => {
  if ($('main').hidden) return;
  const key = ev.key;
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && key.toLowerCase() === 'k') {
    ev.preventDefault();
    openQuick();
    return;
  }
  if (anyDialogOpen()) return;
  if (ev.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    ev.preventDefault();
    stepConversation(key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (isTyping(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (key === '/') {
    if (!$('composer').hidden) { ev.preventDefault(); setTab('chats'); $('compose-body').focus(); }
  } else if (key === '?') {
    ev.preventDefault();
    $('help-dialog').showModal();
  }
});

// =============================================================================
// Ticks and start
// =============================================================================

setInterval(() => {
  if ($('main').hidden) return;
  document.querySelectorAll('[data-ago]').forEach((el) => {
    const ts = Number(el.getAttribute('data-ago')) || 0;
    el.textContent = (el.getAttribute('data-prefix') || '') + ago(ts);
  });
  refreshLifecycles();
}, 15000);

loadView();
if (MOD.pop) MOD.pop.bind(document.body);
boot();
