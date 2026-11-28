// Lyra board, Stage 3 (UI_DESIGN_V2.md, schema v5). Every node is built with createElement /
// createTextNode; no HTML string is ever parsed. Modules loaded first: LyraBrand (head),
// LyraMarkdown, LyraImgPop, LyraStore, LyraAvatar, LyraLifecycle.
'use strict';

const $ = (id) => document.getElementById(id);
const MOD = {
  md: window.LyraMarkdown || null, pop: window.LyraImgPop || null, store: window.LyraStore || null,
  av: window.LyraAvatar || null, life: window.LyraLifecycle || null, brand: window.LyraBrand || null,
};
const store = MOD.store ? MOD.store.create() : null;
const mqDesktop = window.matchMedia('(min-width: 960px)');
const mqWide = window.matchMedia('(min-width: 1200px)');
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const TASK_STATES = [['open', 'Open'], ['in_progress', 'In progress'], ['in_review', 'In review'],
  ['blocked', 'Blocked'], ['done', 'Done'], ['cancelled', 'Cancelled']];
const PROJECT_STATES = [['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed'], ['archived', 'Archived']];
const PRIORITIES = [[0, 'Low'], [1, 'Normal'], [2, 'High'], [3, 'Urgent']];
const SIDEBAR = MOD.store ? MOD.store.SIDEBAR : { min: 280, max: 560, initial: 360 };
const WATCHDOG_MS = 30000;          // the server sends `event: tick` every 15 s
const FAILED_WINDOW = 86400;        // "recent" failed deliveries for Needs you

// Honest presence chips (schema v5 effective_status). rank orders rows by attention.
const STATUS = {
  needs_input: { label: 'needs input', cls: 'info', rank: 0, title: 'Waiting for your input' },
  stalled: { label: 'stalled', cls: 'bad', rank: 1, title: 'Busy, but no activity for a long time' },
  stale: { label: 'no updates', cls: 'warn', rank: 2, title: 'Working, but progress updates stopped' },
  detached: { label: 'detached', cls: 'warn', rank: 3, title: 'Online, but its session stream is not attached' },
  working: { label: 'working', cls: 'info', rank: 4 },
  unknown: { label: 'unknown', cls: '', rank: 5, title: 'Online, activity not reported' },
  idle: { label: 'idle', cls: 'ok', rank: 6 },
  offline: { label: 'offline', cls: '', rank: 7 },
};

const S = {
  me: null, board: null, convs: [], conv: null, msgs: [], replyTo: null, view: null,
  es: null, lastEventId: null,
  conn: { up: false, attempt: 0, timer: null, tick: null, retryAt: 0, wasDown: false, lastBeat: 0 },
  sending: false, staged: [], navigation: 0, optimistic: [], readInFlight: {},
  pending: { board: false, convs: false, conv: false, timer: null }, receiptNodes: new Map(),
  qs: { items: [], all: [], sel: 0 }, needs: [], needsKeys: null, failed: new Map(), notifyConvs: new Set(),
  audio: null, menuHost: null, seenEventId: null,
  resync: { pending: false, inflight: false, again: false, attempt: 0, timer: null, latest: null },
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
  bell: 'M6 16V11a6 6 0 0112 0v5l1.5 2h-15L6 16zM10 20.5a2.2 2.2 0 004 0',
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

function prov(name, size, title) {
  if (!MOD.brand) return null;
  return MOD.brand.provider(name, size || 14, { title: title === undefined ? null : title });
}

function providerName(p) { return MOD.brand ? MOD.brand.providerName(p) : String(p || 'Other'); }

function now() { return Date.now() / 1000; }

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round(now() - ts));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function span(ts) {
  const s = Math.max(0, Math.round(now() - ts));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

// Text node that the 15-second tick updates in place (spec 3.2 rule 5).
function agoNode(ts, prefix) {
  return h('span', { class: 'ago', 'data-ago': ts || 0, 'data-prefix': prefix || '' }, (prefix || '') + ago(ts));
}

function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (d.toDateString() === new Date().toDateString()) {
    return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(d);
}

function fullTime(ts) {
  return ts ? new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts * 1000)) : '';
}

function preciseTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const t = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  return `${t}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtNum(n, digits) {
  return new Intl.NumberFormat([], { maximumFractionDigits: digits == null ? 0 : digits }).format(n);
}

// 22.5 / 32 GB, 492 / 1858 GB: no digit grouping, one decimal under 100.
function fmtGB(n) {
  return new Intl.NumberFormat([], { maximumFractionDigits: n < 100 ? 1 : 0, useGrouping: false }).format(n);
}

function fmtBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n); let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${fmtNum(v, v < 10 && i ? 1 : 0)} ${units[i]}`;
}

function fmtMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${fmtNum(s, 1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
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

// extra: { signal } to cancel, or { timeoutMs } to bound a request that might stall.
async function api(method, path, body, headers = {}, extra = {}) {
  const opts = { method, credentials: 'same-origin', headers };
  if (body instanceof File) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let timer = null;
  if (extra.signal) opts.signal = extra.signal;
  else if (extra.timeoutMs) {
    const ac = new AbortController();
    opts.signal = ac.signal;
    timer = setTimeout(() => ac.abort(), extra.timeoutMs);
  }
  let res;
  try { res = await fetch(path, opts); } finally { clearTimeout(timer); }
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
// View state, theme, tabs and sidebar
// =============================================================================

function viewCtx() {
  const b = S.board || {};
  return {
    desktop: mqDesktop.matches,
    convIds: S.board ? S.convs.map((c) => c.id) : null,
    agentIds: S.board ? (b.agents || []).map((a) => a.id) : null,
    machineIds: S.board ? (b.hosts || []).map((x) => x.host).concat(['__unknown__']) : null,
    providerIds: null,
    poolIds: S.board ? (b.pools || []).map((p) => p.id) : null,
    projectIds: S.board ? (b.projects || []).map((p) => p.id) : null,
  };
}

function loadView() {
  S.view = store ? store.view.load(viewCtx()) : {
    activeTab: 'chats', agentGroupMode: 'machine', expandedAgentIds: [], expandedMachineIds: [],
    expandedProviderIds: [], expandedPoolIds: [], selectedConvId: null, pendingAgentId: null,
    activeProjectId: null, projectStatusFilter: 'all', taskStatusFilter: 'all', mobileChatView: 'list',
    projectView: 'list', theme: null, sidebarCollapsed: false, sidebarWidth: SIDEBAR.initial, notify: false,
    mutedAgentIds: [] };
}

function saveView() { if (store && S.view) store.view.save(S.view); }

function toggleIn(list, id) {
  const i = list.indexOf(id);
  if (i === -1) list.push(id); else list.splice(i, 1);
  saveView();
}

// --- theme -----------------------------------------------------------------

function effectiveTheme() {
  return S.view && S.view.theme ? S.view.theme : (mqDark.matches ? 'dark' : 'light');
}

function applyTheme() {
  if (MOD.brand) MOD.brand.applyTheme(S.view.theme);
  const dark = effectiveTheme() === 'dark';
  const t = $('themeToggle');
  t.setAttribute('aria-checked', String(dark));
  t.title = dark ? 'Dark theme (switch to light)' : 'Light theme (switch to dark)';
  t.querySelector('.sr-only').textContent = 'Dark theme';
}

$('themeToggle').addEventListener('click', () => {
  S.view.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  saveView();
  applyTheme();
});
mqDark.addEventListener('change', () => { if (!S.view.theme) applyTheme(); });

// --- tabs ------------------------------------------------------------------

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

// --- collapsible and resizable sidebar ---------------------------------------

// The sidebar never takes more than 42% of the window (CSS clamps with min(var, 42vw) as well).
function sidebarMax() { return Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, Math.floor(window.innerWidth * 0.42))); }

function applySidebar() {
  const collapsed = !!S.view.sidebarCollapsed;
  $('layout').classList.toggle('sidebar-collapsed', collapsed);
  document.documentElement.style.setProperty('--sidebar-w', S.view.sidebarWidth + 'px');
  const t = $('sidebar-toggle');
  t.setAttribute('aria-expanded', String(!collapsed));
  t.title = collapsed ? 'Show agents sidebar (H)' : 'Hide agents sidebar (H)';
  const r = $('sidebar-resizer');
  r.setAttribute('aria-valuemax', String(sidebarMax()));
  r.setAttribute('aria-valuenow', String(Math.min(S.view.sidebarWidth, sidebarMax())));
}

function toggleSidebar() {
  if (!mqDesktop.matches) { setTab(currentTab() === 'agents' ? 'chats' : 'agents'); return; }
  const collapsing = !S.view.sidebarCollapsed;
  if (collapsing && $('pane-agents').contains(document.activeElement)) $('sidebar-toggle').focus();
  S.view.sidebarCollapsed = collapsing;
  saveView();
  applySidebar();
}

function setSidebarWidth(w, persist) {
  S.view.sidebarWidth = Math.max(SIDEBAR.min, Math.min(sidebarMax(), Math.round(w)));
  applySidebar();
  if (persist) saveView();
}

window.addEventListener('resize', () => { if (S.view) applySidebar(); });

$('sidebar-toggle').addEventListener('click', toggleSidebar);
(function wireResizer() {
  const r = $('sidebar-resizer');
  let startX = 0; let startW = 0;
  const move = (ev) => setSidebarWidth(startW + (ev.clientX - startX), false);
  const up = (ev) => {
    r.releasePointerCapture(ev.pointerId);
    r.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing');
    r.removeEventListener('pointermove', move);
    r.removeEventListener('pointerup', up);
    r.removeEventListener('pointercancel', up);
    saveView();
  };
  r.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    startX = ev.clientX;
    startW = $('pane-agents').getBoundingClientRect().width;
    r.setPointerCapture(ev.pointerId);
    r.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up);
    r.addEventListener('pointercancel', up);
  });
  r.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR.initial, true));
  r.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 48 : 16;
    const keys = { ArrowLeft: -step, ArrowRight: step };
    if (keys[ev.key]) { ev.preventDefault(); setSidebarWidth(S.view.sidebarWidth + keys[ev.key], true); }
    else if (ev.key === 'Home') { ev.preventDefault(); setSidebarWidth(SIDEBAR.min, true); }
    else if (ev.key === 'End') { ev.preventDefault(); setSidebarWidth(sidebarMax(), true); }
  });
})();

// =============================================================================
// Loading and live refresh
// =============================================================================

async function refreshAll(initial) {
  // Board first: its last_event_id is the SSE cursor, so everything after it replays on connect.
  // Conversations are read after that cursor, never before it, so no message can slip between them.
  const board = await api('GET', '/api/v1/board');
  const convs = await api('GET', '/api/v1/conversations');
  S.board = board;
  S.convs = convs.conversations || [];
  if (S.lastEventId == null && board.last_event_id != null) S.lastEventId = String(board.last_event_id);
  if (initial || !S.view) { loadView(); applyTheme(); applySidebar(); renderNotifyToggle(); }
  renderTabs();
  renderAgents();
  renderConvList();
  renderProjects();
  renderSenate();
  renderTitle();
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
      renderAgents(); renderProjects(); renderSenate();
    }
    if (convs) {
      S.convs = convs.conversations || [];
      renderConvList();
      notifyNewMessages();
      if (S.board && !board) renderAgents();      // agent rows show unread counts
    }
    if (board || convs) renderTitle();
    if ((want.conv || board) && S.conv && S.conv.id) await reloadConv();
    else if (board && S.conv) { renderThreadHeader(); renderComposer(); }
  } catch (_e) { /* the next event or reconnect retries */ }
}

// --- SSE: cursor seeded from /board, reset reloads, tick watchdog, reconnect banner --------

const EVENT_TYPES = ['presence', 'principal', 'invite', 'pool', 'host', 'project', 'message', 'message_state',
  'message_progress', 'conversation', 'reset', 'tick'];

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
  S.conn.lastBeat = Date.now();
  es.onopen = () => {
    const recovered = S.conn.wasDown;
    S.conn.attempt = 0;
    S.conn.wasDown = false;
    S.conn.lastBeat = Date.now();
    setConn(true);
    if (recovered) {
      showBanner('Back online. Refreshing…', true);
      startResync(null);
    } else if (!S.resync.pending) {
      $('conn-banner').hidden = true;
    }
  };
  es.onerror = () => dropConnection(es);      // also covers failures before the stream ever opened
  for (const t of EVENT_TYPES) es.addEventListener(t, (ev) => onEvent(t, ev));
}

function dropConnection(es) {
  if (es) es.close();
  if (!es || S.es === es) S.es = null;
  S.conn.wasDown = true;
  setConn(false);
  planReconnect();          // the banner shows now and the retry is scheduled no matter what follows
  // A bounded session check runs alongside: a 401 shows the sign-in card (api() handles it and
  // stops the retries); a stalled or failed check is simply abandoned.
  api('GET', '/api/v1/auth/me', undefined, {}, { timeoutMs: 5000 }).catch(() => {});
}

// Reload the board after a reset or a reconnect. The cursor only moves once the reload worked;
// failures retry with backoff behind the banner.
async function startResync(latest) {
  const r = S.resync;
  if (latest != null) r.latest = String(latest);
  r.pending = true;
  if (r.inflight) { r.again = true; return; }
  clearTimeout(r.timer);
  r.inflight = true;
  try {
    await refreshAll(false);
    r.inflight = false;
    if (r.again) { r.again = false; startResync(null); return; }
    r.pending = false;
    r.attempt = 0;
    S.lastEventId = S.seenEventId || r.latest || S.lastEventId;
    if (S.conn.up) {
      showBanner('Back online.', true);
      setTimeout(() => { if (S.conn.up && !S.resync.pending) $('conn-banner').hidden = true; }, 1500);
    }
  } catch (_e) {
    r.inflight = false;
    r.again = false;
    r.attempt += 1;
    const delay = Math.min(30, Math.pow(2, r.attempt)) * (0.5 + Math.random() * 0.5);
    showBanner(`Could not reload the board. Resyncing in ${Math.max(1, Math.round(delay))} s…`, false);
    r.timer = setTimeout(() => startResync(null), delay * 1000);
  }
}

// Health watchdog: a silent stream (no tick or event for 30 s) is treated as dead.
setInterval(() => {
  if (S.es && S.conn.up && Date.now() - S.conn.lastBeat > WATCHDOG_MS) dropConnection(S.es);
}, 5000);

function onEvent(type, ev) {
  S.conn.lastBeat = Date.now();
  if (ev.lastEventId) {
    S.seenEventId = ev.lastEventId;
    if (!S.resync.pending) S.lastEventId = ev.lastEventId;    // held back until a pending reload succeeds
  }
  if (type === 'tick') return;
  let d = {};
  try { d = JSON.parse(ev.data); } catch (_e) { d = {}; }
  if (type === 'reset') {           // our cursor is outside the server's window: reload everything
    startResync(d.latest_id);
    return;
  }
  const inConv = S.conv && S.conv.id != null && d.conversation_id === S.conv.id;
  switch (type) {
    case 'message':
      if (d.state === 'delivered') S.notifyConvs.add(d.conversation_id);   // a message to the owner
      schedule({ convs: true, conv: inConv, board: true });
      break;
    case 'message_state':
      if (d.state === 'failed') noteFailed(d.conversation_id);
      schedule({ conv: inConv, board: true });
      break;
    case 'message_progress': schedule({ conv: inConv, board: true }); break;
    case 'conversation': schedule({ convs: true }); break;
    default: schedule({ board: true });
  }
}

function setConn(up, text) {
  S.conn.up = up;
  const live = $('live');
  live.querySelector('.live-text').textContent = up ? 'live' : 'offline';
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

$('conn-retry').addEventListener('click', () => {
  if (S.resync.pending && S.conn.up) { S.resync.attempt = 0; startResync(null); return; }
  S.conn.attempt = 0;
  connectEvents();
});

// =============================================================================
// Notifications: hidden-tab desktop notices, a soft chime, per-agent mute
// =============================================================================

function notifySupported() { return 'Notification' in window; }

function renderNotifyToggle() {
  const b = $('notifyToggle');
  const perm = notifySupported() ? Notification.permission : 'unsupported';
  const on = !!S.view.notify && perm === 'granted';
  b.setAttribute('aria-pressed', String(on));
  b.title = perm === 'unsupported' ? 'Desktop notifications are not supported in this browser'
    : perm === 'denied' ? 'Desktop notifications are blocked in the browser settings'
      : on ? 'Desktop notifications are on (when this tab is hidden)' : 'Desktop notifications are off';
}

$('notifyToggle').addEventListener('click', async () => {
  if (!notifySupported()) { renderNotifyToggle(); return; }
  primeAudio();
  if (S.view.notify) {
    S.view.notify = false;
  } else {
    let perm = Notification.permission;
    if (perm === 'default') {
      try { perm = await Notification.requestPermission(); } catch (_e) { perm = 'denied'; }
    }
    S.view.notify = perm === 'granted';
    if (S.view.notify) chime();
  }
  saveView();
  renderNotifyToggle();
});

function primeAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!S.audio) { try { S.audio = new Ctx(); } catch (_e) { S.audio = null; } }
  if (S.audio && S.audio.state === 'suspended') S.audio.resume().catch(() => {});
  return S.audio;
}

// Two short sine tones, quiet and soft-edged.
function chime() {
  const ctx = primeAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  [[880, 0], [1318.5, 0.11]].forEach(([freq, at]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.25);
  });
}

function isMuted(agentId) { return S.view.mutedAgentIds.includes(agentId); }

function notify(title, body, tag, onOpen) {
  if (!S.view.notify || !document.hidden || !notifySupported() || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag, icon: '/static/favicon.svg', silent: true });
    n.onclick = () => { window.focus(); n.close(); if (onOpen) onOpen(); };
  } catch (_e) { return false; }
  chime();
  return true;
}

function notifyNewMessages() {
  const ids = Array.from(S.notifyConvs);
  S.notifyConvs.clear();
  for (const id of ids) {
    const c = S.convs.find((x) => x.id === id);
    if (!c || c.kind !== 'owner_agent' || !c.last || c.last.sender_id === ownerId()) continue;
    const a = convAgents(c)[0];
    if (!a || isMuted(a.id)) continue;
    notify(`${a.display_name}`, c.last.excerpt, `lyra-conv-${c.id}`, () => openConv(c.id, { user: true }));
  }
}

function notifyNeeds(items) {
  const keys = new Set(items.flatMap((n) => n.kinds.map((k) => `${n.agent.id}:${k}`)));
  if (S.needsKeys) {
    for (const n of items) {
      const k = `${n.agent.id}:${n.kind}`;
      if (n.kinds.every((x) => S.needsKeys.has(`${n.agent.id}:${x}`)) || isMuted(n.agent.id)) continue;
      notify(`${n.agent.display_name} needs you`, n.why, `lyra-needs-${k}`, () => openWith(n.agent));
    }
  }
  S.needsKeys = keys;
}

// =============================================================================
// Agents sidebar: Needs you, summary-first rows, By machine / By provider
// =============================================================================

function agentById(id) { return ((S.board && S.board.agents) || []).find((a) => a.id === id) || null; }

function activity(a) {
  if (a.status !== 'admitted') return { key: 'revoked', label: 'revoked', cls: 'bad', rank: 9 };
  const p = a.presence || {};
  const key = STATUS[p.effective_status] ? p.effective_status : (p.online ? 'unknown' : 'offline');
  const meta = STATUS[key];
  const since = p.effective_since ? ` for ${span(p.effective_since)}` : '';
  return { key, label: meta.label, cls: meta.cls, rank: meta.rank,
    title: (meta.title ? meta.title + ', ' : '') + (p.effective_since ? `${meta.label}${since}` : meta.label) };
}

function statusPill(a) {
  const act = activity(a);
  return h('span', { class: 'pill ' + act.cls, title: act.title, 'data-status': act.key, text: act.label });
}

function attentionSort(list) {
  return list.slice().sort((x, y) => {
    const ax = x.unconfirmed > 0 ? -1 : activity(x).rank;
    const ay = y.unconfirmed > 0 ? -1 : activity(y).rank;
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

// Context window bands: under 30% calm, 30 to 60% normal, 60 to 80% warning, 80% and up critical.
function ctxBand(p) { return p >= 80 ? 'bad' : p >= 60 ? 'warn' : p >= 30 ? '' : 'ok'; }

// A 14 px ring for the context window, colored by band; the exact value is in the label.
function ctxRing(p) {
  const v = pct(p);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const circ = 2 * Math.PI * 6;
  [['ring-track', circ], ['ring-fill', circ * v / 100]].forEach(([cls, len]) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '8'); c.setAttribute('cy', '8'); c.setAttribute('r', '6');
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', 'currentColor'); c.setAttribute('stroke-width', '2.6');
    c.setAttribute('stroke-dasharray', `${len.toFixed(2)} ${circ.toFixed(2)}`);
    c.setAttribute('transform', 'rotate(-90 8 8)');
    if (cls === 'ring-fill') c.setAttribute('stroke-linecap', v > 0 ? 'round' : 'butt');
    svg.append(c);
  });
  return h('span', { class: 'ctx-ring ' + (ctxBand(v) || 'mid'), role: 'img', title: `Context window ${Math.round(v)}% used`,
    'aria-label': `Context window ${Math.round(v)}% used`, 'data-pct': Math.round(v) }, svg);
}

function meter(label, used, valueText, opts) {
  const fill = h('span', { class: 'fill ' + ((opts && opts.cls != null) ? opts.cls : fillClass(used)) });
  fill.style.width = pct(used) + '%';
  const name = label || (opts && opts.name) || '';
  return h('div', { class: 'meter' + (label ? '' : ' no-label') }, label ? h('span', { class: 'muted', text: label }) : null,
    h('span', { class: 'track', role: 'img', 'aria-label': `${name} ${Math.round(pct(used))}%`.trim() }, fill),
    h('span', { class: 'val', text: valueText }));
}

function miniMeter(label, used, gb) {
  const fill = h('span', { class: 'fill ' + fillClass(used) });
  fill.style.width = pct(used) + '%';
  return h('span', { class: 'mini-meter' },
    h('span', { class: 'mm-top' }, h('span', { text: label }), h('span', { class: 'tnum', text: `${Math.round(pct(used))}%` })),
    h('span', { class: 'track', role: 'img', 'aria-label': `${label} ${Math.round(pct(used))}% used` }, fill),
    gb ? h('span', { class: 'rail-gb', text: gb }) : null);
}

function agentRow(a) {
  const p = a.presence || {};
  const st = p.status || {};
  const consul = a.role === 'consul';
  const expanded = S.view.expandedAgentIds.includes(a.id);
  const detailsId = 'agent-details-' + a.id;
  const conv = convWithAgent(a.id);
  const extras = [];
  if (st.model) extras.push(st.model + (st.effort ? ` (${st.effort})` : ''));
  if (a.waiting) extras.push(`${a.waiting} waiting`);
  if (a.unconfirmed) extras.push(`${a.unconfirmed} unconfirmed`);
  if (conv && conv.unread_count) extras.push(`${conv.unread_count} unread`);
  if (isMuted(a.id)) extras.push('muted');
  if (!extras.length) extras.push(p.online ? 'online' : `last seen ${ago(p.last_checkin_at)}`);
  const ctx = typeof st.context_pct === 'number' ? ctxRing(st.context_pct) : null;

  const main = h('button', { type: 'button', class: 'agent-main', 'aria-expanded': String(expanded),
    'aria-controls': detailsId, onclick: () => { toggleIn(S.view.expandedAgentIds, a.id); renderAgents(); } },
    avatar(a, 'md', { status: a.status === 'admitted' ? (p.online ? 'on' : 'off') : null, consul }),
    h('span', { class: 'agent-text' },
      h('span', { class: 'agent-line1' },
        h('span', { class: 'agent-name', title: a.display_name, text: a.display_name }),
        p.provider ? prov(p.provider, 13, null) : null,
        h('span', { class: 'agent-handle', text: '@' + a.handle }),
        consul ? h('span', { class: 'pill consul', text: 'Consul' }) : null),
      h('span', { class: 'agent-line2' },
        a.hold ? h('span', { class: 'pill hold', title: `Held${a.hold.reason ? ': ' + a.hold.reason : ''}`, text: 'held' }) : null,
        statusPill(a),
        ctx,
        h('span', { class: 'agent-extra', title: extras.join(', '), text: extras.join(', ') }))),
    h('span', { class: 'agent-chev', 'aria-hidden': 'true' }, icon('chevron', 14)));

  const row = h('div', { class: 'agent-row' }, main,
    a.status === 'admitted' ? h('button', { type: 'button', class: 'agent-chat ghost',
      'aria-label': `Chat with ${a.display_name}`, onclick: (ev) => { ev.stopPropagation(); openWith(a); } }, 'Chat') : null);
  const wrap = h('div', { class: 'agent' + (consul ? ' is-consul' : '') + (a.hold ? ' is-held' : ''), 'data-agent-id': a.id }, row);
  if (expanded) wrap.append(agentDetails(a, detailsId));
  return wrap;
}

function agentDetails(a, id) {
  const p = a.presence || {};
  const st = p.status || {};
  const act = activity(a);
  const modes = (p.modes || ['queue']).map((m) => (m === 'jump' ? 'Jump queue' : 'Queue')).join(', ');
  const kv = h('dl', { class: 'kv' });
  const add = (k, v) => kv.append(h('dt', { text: k }), h('dd', {}, v));
  add('Status', [statusPill(a), p.effective_since ? h('span', { class: 'muted' }, ' since ', agoNode(p.effective_since)) : null]);
  add('Last check-in', agoNode(p.last_checkin_at));
  add('Context', typeof st.context_pct === 'number'
    ? meter('', st.context_pct, Math.round(st.context_pct) + '%', { name: 'Context used', cls: ctxBand(st.context_pct) }) : 'unknown');
  add('Runtime', [p.provider ? prov(p.provider, 14) : null, ' ',
    [providerName(p.provider), p.runtime, p.connector].filter(Boolean).join(' / ') || 'unknown']);
  add('Delivery', modes);
  add('Images', supportsImages(a) ? 'accepted' : 'text only');
  add('Queue', `${a.waiting || 0} waiting, ${a.unconfirmed || 0} unconfirmed`);
  add('Stream', st.attached === false ? 'not attached' : st.attached ? 'attached' : 'unknown');
  if (a.hold) add('Hold', [`since ${fullTime(a.hold.since)}`, a.hold.reason ? `, ${a.hold.reason}` : '']);
  add('Handle', '@' + a.handle);
  add('Host', p.host ? hostName(p.host) : 'unknown');
  add('Address', a.address || 'unknown');
  void act;

  const pools = (S.board.pools || []);
  const poolSel = h('select', { 'aria-label': `Pool for ${a.display_name}`, onchange: (ev) => setPool(a, ev.target.value) },
    h('option', { value: '', text: 'No pool' }),
    ...pools.map((pl) => h('option', { value: pl.id, selected: a.pool && a.pool.id === pl.id,
      text: `${providerName(pl.provider)}: ${pl.label}` })));
  const muted = isMuted(a.id);
  const actions = h('div', { class: 'agent-actions' });
  if (a.status === 'admitted') {
    actions.append(
      h('button', { type: 'button', class: 'primary', onclick: () => openWith(a) }, 'Message'),
      a.hold ? h('button', { type: 'button', class: 'ghost', onclick: () => setHold(a, false) }, 'Resume delivery')
        : h('button', { type: 'button', class: 'ghost', title: 'Stop handing it new messages without revoking access',
          onclick: () => setHold(a, true) }, 'Hold delivery'),
      h('button', { type: 'button', class: 'ghost', 'aria-pressed': String(muted),
        onclick: () => { toggleIn(S.view.mutedAgentIds, a.id); renderAgents(); } }, muted ? 'Unmute' : 'Mute notifications'),
      h('button', { type: 'button', class: 'danger', onclick: () => revoke(a) }, 'Revoke'));
  } else {
    actions.append(h('button', { type: 'button', class: 'ghost', onclick: () => readmit(a) }, 'Re-admit'));
  }
  return h('div', { class: 'agent-details', id },
    kv,
    a.hold ? h('p', { class: 'hold-note', text: 'Delivery is held: messages wait on the server until you resume.' }) : null,
    h('label', {}, a.pool && a.pool.is_reporter ? 'Pool (usage reporter)' : 'Pool', poolSel),
    actions);
}

function hostRow(host) { return ((S.board && S.board.hosts) || []).find((x) => x.host === host) || null; }
function hostName(host) { const r = hostRow(host); return (r && r.display_name) || host.replace(/\.local$/, ''); }

function railGroup(card, agents, details, offline) {
  const g = h('div', { class: 'rail-group' + (offline ? ' is-offline' : '') }, card,
    h('div', { class: 'rail-agents' }, agents.length ? agents.map(agentRow)
      : h('p', { class: 'list-empty', text: 'No agents' })));
  if (details) g.append(details);
  return g;
}

function hostMem(m) {
  const total = m.mem_total_gb;
  const used = m.mem_used_gb != null ? m.mem_used_gb : (total != null && m.mem_free_gb != null ? total - m.mem_free_gb : null);
  const p = typeof m.mem_used_pct === 'number' ? m.mem_used_pct : (total && used != null ? 100 * used / total : null);
  return { p, gb: used != null && total ? `${fmtGB(used)} / ${fmtGB(total)} GB` : null };
}

function hostDisk(m) {
  const total = m.disk_total_gb;
  const used = total != null && m.disk_free_gb != null ? total - m.disk_free_gb : null;
  const p = typeof m.disk_used_pct === 'number' ? m.disk_used_pct : (total && used != null ? 100 * used / total : null);
  return { p, gb: used != null && total ? `${fmtGB(used)} / ${fmtGB(total)} GB` : null };
}

function renderByMachine(root, admitted) {
  const hosts = (S.board.hosts || []).slice().sort((x, y) =>
    (y.online_count > 0) - (x.online_count > 0) || String(x.display_name || x.host).localeCompare(String(y.display_name || y.host)));
  const placed = new Set();
  for (const host of hosts) {
    const agents = attentionSort(host.agent_ids.map(agentById).filter((a) => a && a.status === 'admitted'));
    agents.forEach((a) => placed.add(a.id));
    const m = host.metrics || {};
    const mem = hostMem(m);
    const disk = hostDisk(m);
    const expanded = S.view.expandedMachineIds.includes(host.host);
    const name = host.display_name || host.host;
    const aliased = name !== host.host;
    const detailsId = 'host-details-' + host.host.replace(/[^a-zA-Z0-9_-]/g, '_');
    const card = h('button', { type: 'button', class: 'rail-card', 'aria-expanded': String(expanded),
      'aria-controls': detailsId, 'data-host': host.host, 'aria-haspopup': 'menu',
      title: aliased ? `${name} (${host.host}). Right-click to rename.` : `${host.host}. Right-click to rename.`,
      onclick: () => { toggleIn(S.view.expandedMachineIds, host.host); renderAgents(); },
      oncontextmenu: (ev) => openHostMenu(ev, host),
      onkeydown: (ev) => {
        if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) openHostMenu(ev, host);
      } },
      h('span', { class: 'rail-name', text: aliased ? name : name.replace(/\.local$/, '') }),
      h('span', { class: 'rail-sub', text: `${host.online_count} of ${agents.length} online` }),
      m.os ? h('span', { class: 'rail-sub', text: [m.os, m.arch].filter(Boolean).join(' ') }) : null,
      mem.p != null ? miniMeter('RAM', mem.p, mem.gb) : null,
      disk.p != null ? miniMeter('Disk', disk.p, disk.gb) : null,
      h('span', { class: 'rail-chev', text: expanded ? 'Hide details' : 'Details' }));
    let details = null;
    if (expanded) {
      details = h('div', { class: 'rail-details', id: detailsId });
      if (mem.p != null) details.append(meter('RAM', mem.p, mem.gb || `${Math.round(mem.p)}%`));
      if (disk.p != null) details.append(meter('Disk', disk.p, disk.gb || `${Math.round(disk.p)}% used`));
      const kv = h('dl', { class: 'kv' });
      const add = (k, v) => { if (v != null && v !== '') kv.append(h('dt', { text: k }), h('dd', {}, v)); };
      add('Host name', host.host);
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
      details.append(h('div', { class: 'rail-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => openHostDialog(host) }, 'Rename machine'),
        aliased ? h('button', { type: 'button', class: 'quiet', onclick: () => saveHostAlias(host.host, null) }, 'Use the host name') : null));
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
  if (sec < 60) return 'under a minute';
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
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
    const k = MOD.brand ? MOD.brand.key(key) : String(key || 'other').toLowerCase();
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
    const section = h('section', { class: 'provider-section', 'data-provider': key },
      h('button', { type: 'button', class: 'provider-head quiet', 'aria-expanded': String(!isCollapsed),
        onclick: () => { toggleIn(S.view.expandedProviderIds, key); renderAgents(); } },
        h('span', { class: 'ph-name' }, prov(key, 18), providerName(key)),
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
  if (!byProvider.size) root.append(h('p', { class: 'list-empty', text: 'No account pools yet. Add one in Senate.' }));
}

function norm(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function poolGroup(pool, agents) {
  const expanded = S.view.expandedPoolIds.includes(pool.id);
  const rem = poolRemaining(pool);
  const detailsId = 'pool-details-' + pool.id;
  // Show each distinct piece of metadata once: account and subscription often repeat the label.
  const seen = [norm(pool.label)];
  const phrase = (hay, needle) => (' ' + hay + ' ').includes(' ' + needle + ' ');
  const distinct = (v) => {
    const k = norm(v);
    if (!k || seen.some((x) => x === k || phrase(x, k))) return null;   // also "Ultra" inside "Google AI Ultra"
    seen.push(k);
    return v;
  };
  const account = distinct(pool.account_label);
  const plan = distinct(pool.subscription);
  const card = h('button', { type: 'button', class: 'rail-card pool-card', 'aria-expanded': String(expanded), 'aria-controls': detailsId,
    'data-pool-id': pool.id, title: [pool.label, pool.account_label, pool.subscription].filter(Boolean)
      .filter((v, i, arr) => arr.findIndex((x) => norm(x) === norm(v)) === i).join(', '),
    onclick: () => { toggleIn(S.view.expandedPoolIds, pool.id); renderAgents(); } },
    h('span', { class: 'rail-title' }, prov(pool.provider, 13), h('span', { class: 'rail-name', text: pool.label })),
    account ? h('span', { class: 'rail-sub', text: account }) : null,
    plan ? h('span', { class: 'pill info', text: plan }) : null,
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
    add('Provider', [prov(pool.provider, 14), ' ', providerName(pool.provider)]);
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
      const k = MOD.brand ? MOD.brand.key(first.p.provider) : String(first.p.provider).toLowerCase();
      S.view.expandedProviderIds = S.view.expandedProviderIds.filter((x) => x !== k);
      saveView(); renderAgents();
      if (!mqDesktop.matches) setTab('agents');      // on desktop the sidebar is already visible
      const el = document.querySelector(`[data-pool-id="${first.p.id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    } }, 'Show pool'));
}

// --- Needs you ----------------------------------------------------------------

function noteFailed(convId) {
  const c = S.convs.find((x) => x.id === convId);
  const a = c && c.kind === 'owner_agent' ? convAgents(c)[0] : null;
  if (a) S.failed.set(a.id, { at: now(), convId });
}

function computeNeeds() {
  const out = [];
  const t = now();
  for (const [id, f] of S.failed) if (t - f.at > FAILED_WINDOW) S.failed.delete(id);
  for (const a of ((S.board && S.board.agents) || []).filter((x) => x.status === 'admitted')) {
    const p = a.presence || {};
    const since = p.effective_since || p.last_checkin_at || null;
    if (p.effective_status === 'needs_input') out.push({ agent: a, kind: 'input', rank: 0, why: 'Waiting for your input', since });
    else if (p.effective_status === 'stalled') out.push({ agent: a, kind: 'stalled', rank: 1, why: 'Stalled: busy with no activity', since });
    if (!p.online && (a.waiting || a.unconfirmed)) {
      out.push({ agent: a, kind: 'offline', rank: 2, why: `Offline with ${a.waiting || a.unconfirmed} message${(a.waiting || a.unconfirmed) === 1 ? '' : 's'} waiting`,
        since: p.last_checkin_at });
    } else if (a.unconfirmed) {
      out.push({ agent: a, kind: 'unconfirmed', rank: 2, why: 'Delivery unconfirmed: check and retry', since });
    }
    const f = S.failed.get(a.id);
    if (f) out.push({ agent: a, kind: 'failed', rank: 3, why: 'A message to it failed', since: f.at });
  }
  // One entry per agent: the most urgent reason leads, the others follow.
  const byAgent = new Map();
  for (const n of out.sort((x, y) => x.rank - y.rank || (x.since || 0) - (y.since || 0))) {
    const e = byAgent.get(n.agent.id);
    if (!e) byAgent.set(n.agent.id, Object.assign({}, n, { kinds: [n.kind] }));
    else { e.kinds.push(n.kind); e.why += `; ${n.why.charAt(0).toLowerCase()}${n.why.slice(1)}`; }
  }
  return Array.from(byAgent.values());
}

function renderNeeds() {
  const box = clear($('needs'));
  const items = S.needs;
  box.hidden = !items.length;
  if (!items.length) return;
  box.append(h('div', { class: 'needs-head' },
    h('h3', { id: 'needs-title' }, `Needs you (${items.length})`),
    h('span', { class: 'muted note', text: 'N to step through' })));
  for (const n of items) {
    box.append(h('button', { type: 'button', class: 'needs-item', 'data-agent-id': n.agent.id, 'data-kind': n.kind,
      'data-kinds': n.kinds.join(' '), title: `${n.agent.display_name}: ${n.why}`,
      onclick: () => openWith(n.agent) },
      avatar(n.agent, 'sm', { consul: n.agent.role === 'consul' }),
      h('span', { class: 'needs-text' }, h('span', { class: 'needs-name', text: n.agent.display_name }),
        h('span', { class: 'needs-why', text: n.why })),
      n.since ? agoNode(n.since) : null));
  }
}

function renderAgents() {
  if (!S.board) return;
  const agents = S.board.agents || [];
  const admitted = agents.filter((a) => a.status === 'admitted');
  $('agents-count').textContent = `${admitted.filter((a) => a.presence.online).length}/${admitted.length} online`;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.group === S.view.agentGroupMode;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;                       // roving tabindex: one stop for the group
  });
  renderQuotaAlert();
  S.needs = computeNeeds();
  notifyNeeds(S.needs);
  renderNeeds();
  const roster = $('roster');
  const keepScroll = roster.scrollTop;
  const root = clear($('roster-groups'));
  if (!agents.length) {
    root.append(h('p', { class: 'list-empty', text: 'No agents yet. Create an invite in Senate.' }));
    return;
  }
  if (S.view.agentGroupMode === 'provider') renderByProvider(root, admitted);
  else renderByMachine(root, admitted);
  const revoked = agents.filter((a) => a.status !== 'admitted');
  if (revoked.length) {
    root.append(h('div', { class: 'group-title' }, 'Revoked', h('span', { class: 'tnum', text: String(revoked.length) })),
      h('div', { class: 'rail-group single' }, h('div', { class: 'rail-agents' }, revoked.map(agentRow))));
  }
  roster.scrollTop = keepScroll;
}

document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  S.view.agentGroupMode = b.dataset.group;
  saveView();
  renderAgents();
}));
document.querySelector('.seg').addEventListener('keydown', (ev) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
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
    setTab('senate');
    showCode(r.code, a.display_name);
    schedule({ board: true });
  } catch (e) { window.alert(e.message); }
}

async function setPool(a, value) {
  try { await api('PATCH', `/api/v1/admin/principals/${a.id}`, { pool_id: value === '' ? null : Number(value) }); schedule({ board: true }); }
  catch (e) { window.alert(e.message); }
}

async function setHold(a, hold) {
  try {
    if (hold) await api('POST', `/api/v1/admin/principals/${a.id}/hold`, { reason: 'paused by the owner' });
    else await api('DELETE', `/api/v1/admin/principals/${a.id}/hold`);
    schedule({ board: true });
  } catch (e) { window.alert(e.message); }
}

// --- machine aliases: right-click menu and rename dialog -------------------------

function openHostMenu(ev, host) {
  ev.preventDefault();
  const menu = $('host-menu');
  S.menuHost = host;
  menu.querySelector('[data-act="clear"]').hidden = !(host.display_name && host.display_name !== host.host);
  menu.hidden = false;
  const r = ev.currentTarget.getBoundingClientRect();
  const fromKeys = ev.type === 'keydown' || !ev.clientX;     // keyboard: anchor to the card, not the pointer
  const x = fromKeys ? r.left + 12 : ev.clientX;
  const y = fromKeys ? r.top + 24 : ev.clientY;
  const w = menu.offsetWidth; const hgt = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - hgt - 8)) + 'px';
  menu.querySelector('button:not([hidden])').focus();
}

function closeHostMenu(restoreFocus) {
  const menu = $('host-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  if (restoreFocus && S.menuHost) {
    const card = document.querySelector(`.rail-card[data-host="${CSS.escape(S.menuHost.host)}"]`);
    if (card) card.focus();
  }
}

$('host-menu').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b || !S.menuHost) return;
  const host = S.menuHost;
  closeHostMenu(false);
  if (b.dataset.act === 'rename') openHostDialog(host);
  else if (b.dataset.act === 'clear') saveHostAlias(host.host, null);
  else if (b.dataset.act === 'details') {
    if (!S.view.expandedMachineIds.includes(host.host)) toggleIn(S.view.expandedMachineIds, host.host);
    renderAgents();
  }
});
$('host-menu').addEventListener('keydown', (ev) => {
  const items = Array.from($('host-menu').querySelectorAll('button:not([hidden])'));
  const i = items.indexOf(document.activeElement);
  if (ev.key === 'Escape') { ev.preventDefault(); closeHostMenu(true); }
  else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (ev.key === 'Tab') closeHostMenu(false);
});
document.addEventListener('pointerdown', (ev) => { if (!ev.target.closest('#host-menu')) closeHostMenu(false); });
window.addEventListener('resize', () => closeHostMenu(false));
$('roster').addEventListener('scroll', () => closeHostMenu(false), { passive: true });

let editingHost = null;
function openHostDialog(host) {
  editingHost = host;
  $('host-dialog-host').textContent = `Host name: ${host.host}`;
  $('host-alias').value = host.display_name && host.display_name !== host.host ? host.display_name : '';
  $('host-error').textContent = '';
  $('host-dialog').showModal();
  $('host-alias').focus();
}

async function saveHostAlias(host, name) {
  try {
    await api('PUT', `/api/v1/admin/hosts/${encodeURIComponent(host)}`, { display_name: name && name.trim() ? name.trim() : null });
    schedule({ board: true });
    return true;
  } catch (e) {
    if ($('host-dialog').open) $('host-error').textContent = e.message; else window.alert(e.message);
    return false;
  }
}

$('host-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!editingHost) return;
  if (await saveHostAlias(editingHost.host, $('host-alias').value)) $('host-dialog').close();
});

// =============================================================================
// Conversations: pins, unread badges, read receipts
// =============================================================================

function ownerId() { return S.board && S.board.owner ? S.board.owner.id : (S.me && S.me.principal_id); }

function convAgents(c) { return (c.members || []).filter((m) => m.kind === 'agent'); }

function convTitle(c) {
  const names = convAgents(c).map((m) => m.display_name);
  return c.kind === 'agent_agent' ? names.join(' and ') : (names[0] || 'Conversation');
}

function renderTitle() {
  const unread = S.convs.reduce((n, c) => n + (c.unread_count || 0), 0);
  const needs = S.needs.length;
  const badge = $('tab-unread');
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.setAttribute('aria-label', `${unread} unread`);
  const nb = $('tab-needs');
  nb.hidden = !needs;
  nb.textContent = String(needs);
  nb.setAttribute('aria-label', `${needs} need you`);
  const total = unread + needs;      // everything waiting on the owner
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
  renderConvList(); renderTitle(); renderAgents();
  api('POST', `/api/v1/conversations/${c.id}/read`, { last_read_message_id: latest })
    .catch(() => { delete S.readInFlight[c.id]; });
}

document.addEventListener('visibilitychange', maybeMarkRead);
window.addEventListener('focus', maybeMarkRead);

// =============================================================================
// Thread: bubbles, compact receipts, the live agent-side bubble
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
  S.receiptNodes.clear();
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
  // Tapping the same conversation again after going back must reopen it on phones.
  if (o.user && !mqWide.matches && S.view.mobileChatView !== 'thread') { S.view.mobileChatView = 'thread'; saveView(); }
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
    for (const m of S.msgs) {
      if (m.state === 'failed' && m.recipient && m.recipient.kind === 'agent' && m.failed_at && now() - m.failed_at < FAILED_WINDOW
        && !S.failed.has(m.recipient.id)) S.failed.set(m.recipient.id, { at: m.failed_at, convId: id });
    }
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
  const p = a.presence || {};
  head.append(avatar(a, 'md', { status: a.status === 'admitted' ? (p.online ? 'on' : 'off') : null, consul }),
    h('div', { class: 'conv-who' },
      h('div', { class: 'who-name' }, h('span', { text: a.display_name }),
        consul ? h('span', { class: 'pill consul', text: 'Consul' }) : null,
        a.hold ? h('span', { class: 'pill hold', text: 'held' }) : null,
        statusPill(a)),
      h('div', { class: 'who-sub', text: [`@${a.handle}`, p.provider ? providerName(p.provider) : null,
        p.online ? ((p.modes || []).includes('jump') ? 'queue and jump queue' : 'queue only')
          : 'offline: messages wait until it reconnects'].filter(Boolean).join(', ') })));
}

function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight <= 48; }

function receiptHandlers(m) {
  if (m.local === 'send_failed') return { onRetrySend: retrySend, onDiscard: discardSend };
  return { onCancel: cancelMessage, onRetryDelivery: retryDelivery, onDetails: showDetails };
}

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
    h('div', { class: 'image-strip' }, (m.attachments || []).map((img) => thumb(img))));
  const foot = h('div', { class: 'msg-foot' });
  if (mine && m.recipient && m.recipient.kind === 'agent' && MOD.life) {
    const handlers = receiptHandlers(m);
    const rc = MOD.life.renderReceipt(m, { replied: MOD.life.replied(m, ctx.msgs) }, handlers);
    if (m.id != null) S.receiptNodes.set(m.id, { el: rc, handlers });
    foot.append(rc);
  } else if (team && m.state && m.state !== 'delivered') {
    foot.append(h('span', { class: 'msg-state ' + m.state, text: m.state === 'waiting' ? 'waiting' : m.state === 'failed'
      ? `failed: ${m.state_reason || 'delivery failed'}` : m.state }));
  }
  if (!mine && !S.conv.read_only && !team && m.id != null && !m.local) {
    foot.append(h('button', { type: 'button', class: 'quiet', onclick: () => { S.replyTo = m; saveDraft(); renderComposer();
      $('compose-body').focus(); } }, 'Reply'));
  }
  bubble.append(foot);
  const node = h('div', { class: 'msg' + (mine ? ' mine' : '') + (m.local ? ' local' : ''), 'data-msg-id': m.id || '' });
  if (!mine) node.append(avatar(m.sender, 'sm', { consul }));
  node.append(bubble);
  return node;
}

// Placeholder response from the agent: avatar, animated status, steps and elapsed time.
function liveNode(m, ctx) {
  if (!MOD.life) return null;
  const agent = agentById(m.recipient.id) || m.recipient;
  const lctx = { replied: MOD.life.replied(m, ctx.msgs), agentStatus: agent.presence && agent.presence.effective_status };
  const info = MOD.life.live(m, lctx);
  if (!info) return null;
  const body = MOD.life.renderLive(m, lctx);
  const consul = agent.role === 'consul';
  return h('div', { class: `msg live is-${info.phase}${info.stale ? ' is-stale' : ''}`, 'data-live-for': m.id },
    avatar(agent, 'sm', { consul }),
    h('div', { class: 'bubble', 'aria-label': `${agent.display_name} is responding` },
      h('div', { class: 'msg-head' }, h('strong', { text: agent.display_name }),
        h('span', { class: 'live-tag', text: info.phase === 'input_required' ? 'waiting for you' : 'live' })),
      body));
}

function thumb(image, opts) {
  const url = '/api/v1/attachments/' + Number(image.id);
  const img = h('img', { alt: image.filename || 'Image', loading: 'lazy', width: 120, height: 72 });
  if (opts && opts.onError) img.addEventListener('error', () => opts.onError(img), { once: true });
  img.src = url;
  if (MOD.pop) MOD.pop.enhance(img);
  return img;
}

function renderMessages(opts) {
  const box = $('messages');
  const o = opts || {};
  const wasNear = nearBottom(box);
  const top = box.scrollTop;
  clear(box);
  S.receiptNodes.clear();
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
  if (S.conv.kind === 'owner_agent') {
    for (const m of S.msgs) {
      if (m.recipient && m.recipient.kind === 'agent' && m.progress) {
        const n = liveNode(m, ctx);
        if (n) box.append(n);
      }
    }
  }
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

function refreshLiveTimers() {
  if (!MOD.life) return;
  const t = now();
  document.querySelectorAll('.live-timer[data-since]').forEach((el) => {
    el.textContent = MOD.life.clock(t - Number(el.getAttribute('data-since')));
  });
}

async function retryDelivery(m) {
  if (!window.confirm('Retry delivery? The agent may have received it already; it will be marked as a retry.')) return;
  try { await api('POST', `/api/v1/admin/messages/${m.id}/retry`, {}); await reloadConv(); }
  catch (e) { window.alert(e.message); }
}

async function cancelMessage(m) {
  $('compose-error').textContent = '';
  try {
    await api('POST', `/api/v1/messages/${m.id}/cancel`, { reason: 'cancelled by the owner' });
  } catch (e) {
    $('compose-error').textContent = e.data && e.data.error === 'message_claimed'
      ? 'Too late to cancel: the agent already picked up this message.' : `Could not cancel: ${e.message}`;
  }
  await reloadConv();
  schedule({ board: true });
}

// --- Details: lifecycle timestamps and stage latency -----------------------------

const DURATIONS = [['client_to_server', 'Browser to server'], ['server_to_claim', 'Server to claim'],
  ['claim_to_agent_read', 'Claim to agent read'], ['agent_think_to_reply', 'Agent think to reply'],
  ['total_round_trip', 'Total round trip']];

// Only the newest request may render: closing the dialog or opening another message cancels the rest.
let detailsSeq = 0;
let detailsAbort = null;
function cancelDetails() {
  detailsSeq += 1;
  if (detailsAbort) { detailsAbort.abort(); detailsAbort = null; }
}
// The close event is queued: if another message reopened the dialog meanwhile, keep that request.
$('lifecycle-dialog').addEventListener('close', () => { if (!$('lifecycle-dialog').open) cancelDetails(); });

async function showDetails(m) {
  cancelDetails();
  const seq = detailsSeq;
  const ac = new AbortController();
  detailsAbort = ac;
  const body = clear($('lifecycle-body'));
  body.dataset.messageId = String(m.id);
  body.append(h('p', { class: 'muted', text: 'Loading…' }));
  $('lifecycle-title').textContent = 'Delivery details';
  if (!$('lifecycle-dialog').open) $('lifecycle-dialog').showModal();
  let r;
  try { r = await api('GET', `/api/v1/messages/${m.id}/lifecycle`, undefined, {}, { signal: ac.signal }); }
  catch (e) {
    if (seq !== detailsSeq || e.name === 'AbortError') return;
    clear(body).append(h('p', { class: 'error', text: e.message }));
    return;
  }
  if (seq !== detailsSeq || !$('lifecycle-dialog').open) return;
  detailsAbort = null;
  clear(body);
  const stateCls = { delivered: 'ok', failed: 'bad', cancelled: '', unconfirmed: 'warn', waiting: 'info' }[r.state] || '';
  body.append(h('div', { class: 'storage-head' },
    h('span', { class: 'muted', text: `Message #${r.message_id}${m.body ? ': ' + m.body.slice(0, 60) : ''}` }),
    h('span', { class: 'pill ' + stateCls, text: r.state })));
  const steps = [['Sent from this browser', r.client_sent_at], ['Received by the server', r.server_received_at],
    ['Claimed by the agent connector', r.first_claimed_at], ['Read by the agent', r.agent_read_at],
    [r.progress_phase ? `Progress: ${r.progress_phase.replace('_', ' ')}` : 'Progress', r.progress_updated_at],
    ['Reply received', r.replied_at]];
  if (r.cancelled_at) steps.push(['Cancelled', r.cancelled_at]);
  if (r.failed_at) steps.push(['Failed', r.failed_at]);
  body.append(h('ol', { class: 'lc-steps' }, steps.map(([label, ts]) => h('li', { class: ts ? '' : 'is-missing' },
    h('span', { text: label }),
    ts ? h('time', { datetime: new Date(ts * 1000).toISOString(), title: fullTime(ts), text: preciseTime(ts) })
      : h('span', { class: 'muted', text: 'not yet' })))));
  const d = r.durations_ms || {};
  const max = Math.max(1, ...DURATIONS.map(([k]) => d[k] || 0));
  body.append(h('div', { class: 'dur', role: 'list', 'aria-label': 'Stage latency' },
    DURATIONS.map(([k, label]) => {
      const fill = h('span', { class: 'fill' + (k === 'total_round_trip' ? ' ok' : '') });
      fill.style.width = (d[k] != null ? Math.max(1.5, 100 * d[k] / max) : 0) + '%';
      return h('div', { class: 'dur-row' + (k === 'total_round_trip' ? ' is-total' : ''), role: 'listitem' },
        h('span', { text: label }), h('span', { class: 'track' }, fill), h('span', { class: 'val', text: fmtMs(d[k]) }));
    })));
  const attempts = r.attempts || [];
  body.append(h('h3', { text: `Delivery attempts (${attempts.length})` }));
  if (attempts.length) {
    body.append(h('table', { class: 'attempts' },
      h('thead', {}, h('tr', {}, ['#', 'Claimed', 'Lease until', 'Outcome'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, attempts.map((a, i) => h('tr', {},
        h('td', { text: String(i + 1) }), h('td', { text: preciseTime(a.claimed_at) }),
        h('td', { text: preciseTime(a.lease_until) }),
        h('td', { text: a.outcome ? `${a.outcome}${a.outcome_at ? ' at ' + preciseTime(a.outcome_at) : ''}` : 'open' }))))));
  } else {
    body.append(h('p', { class: 'muted', text: 'Not claimed by the agent yet.' }));
  }
}

// =============================================================================
// Composer: drafts with images, auto-grow, modes, sending
// =============================================================================

function restoreDraft() {
  const key = draftKey();
  const d = key && store ? store.drafts.load(key) : null;
  $('compose-body').value = d ? d.text : '';
  S.replyTo = null;
  if (d && d.replyToId) S.replyTo = { id: d.replyToId, pending: true };
  S.draftMode = d ? d.mode : null;
  S.staged = d ? d.attachments.map((a) => ({ name: a.filename, image: a, restored: true, draftKey: key, token: clientId() })) : [];
  $('draft-hint').textContent = d && (d.text || d.attachments.length) ? 'Draft restored' : '';
  autoGrow();
}

function attachmentMeta(img, name) {
  return { id: img.id, filename: img.filename || name, mime_type: img.mime_type, size_bytes: img.size_bytes };
}

// An upload that finishes after the owner switched chats still lands in the draft it started in.
function addToStoredDraft(key, item) {
  if (!store || !key || item.removed) return;
  const d = store.drafts.load(key) || { text: '', replyToId: null, mode: 'queue', attachments: [] };
  if (!d.attachments.some((a) => a.id === item.image.id)) d.attachments.push(attachmentMeta(item.image, item.name));
  store.drafts.save(key, d);
  if (draftKey() === key && !S.staged.some((x) => x.image && x.image.id === item.image.id)) {
    S.staged.push(Object.assign(item, { restored: true }));      // back on that chat already
    renderImages();
  }
}

function removeFromStoredDraft(key, id) {
  if (!store || !key) return;
  const d = store.drafts.load(key);
  if (!d) return;
  d.attachments = d.attachments.filter((a) => a.id !== id);
  store.drafts.save(key, d);
}

function saveDraft() {
  const key = draftKey();
  if (!key || !store) return;
  const attachments = S.staged.filter((i) => i.image).map((i) => attachmentMeta(i.image, i.name));
  store.drafts.save(key, { text: $('compose-body').value, replyToId: S.replyTo ? S.replyTo.id : null,
    mode: $('compose-mode').value || 'queue', attachments });
  $('draft-hint').textContent = $('compose-body').value || attachments.length ? 'Draft saved' : '';
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

function setAttachTip(text) {
  $('compose-attach-tip').setAttribute('data-tip', text);
  $('compose-attach').setAttribute('aria-label', text);
}

// A restored image that fails to load is only dropped when the server says it is gone (404 or
// 410); network errors and 5xx keep it in the draft with a retry.
async function attachmentStatus(id) {
  try {
    const r = await fetch('/api/v1/attachments/' + Number(id), { credentials: 'same-origin', cache: 'no-store' });
    return r.status;
  } catch (_e) { return 0; }
}

async function onDraftImageError(item, img) {
  // Ignore thumbnails a re-render already replaced, and check each item once at a time.
  if ((img && !img.isConnected) || item.checking || item.removed) return;
  item.checking = true;
  const status = await attachmentStatus(item.image.id);
  item.checking = false;
  if (status === 404 || status === 410) {
    item.removed = true;
    const i = S.staged.indexOf(item);
    if (i !== -1) S.staged.splice(i, 1);
    removeFromStoredDraft(item.draftKey, item.image.id);
    if (draftKey() === item.draftKey) {
      renderImages();
      $('compose-error').textContent = `${item.name} is no longer on the server and was removed from the draft.`;
    }
    return;
  }
  item.broken = true;
  if (S.staged.includes(item)) renderImages();
}

function renderImages() {
  const agent = recipientAgent();
  const allowed = supportsImages(agent);
  const note = $('compose-image-note');
  const attach = $('compose-attach');
  // aria-disabled keeps the control focusable, so keyboard and touch users still get the tooltip.
  attach.setAttribute('aria-disabled', String(!allowed || S.sending));
  setAttachTip(allowed ? 'Attach image' : 'Text only: this agent does not accept images');
  // Staged or restored images stay in the draft; they just cannot be sent while images are off.
  note.hidden = !(S.conv && !allowed && S.staged.length);
  note.textContent = 'This agent does not accept images right now. Remove them or send when it does.';
  const strip = clear($('compose-attachments'));
  for (const item of S.staged) {
    let tile;
    if (!item.image) tile = h('span', { class: 'staged-uploading', text: 'Uploading…' });
    else if (item.broken) {
      tile = h('button', { type: 'button', class: 'staged-uploading staged-retry', title: `${item.name} could not be loaded`,
        onclick: () => { item.broken = false; renderImages(); } }, 'Could not load. Retry');
    } else {
      tile = thumb(item.image, { onError: item.restored ? (img) => onDraftImageError(item, img) : null });
    }
    strip.append(h('div', { class: 'staged-image', 'data-attachment-id': item.image ? item.image.id : null }, tile,
      h('button', { type: 'button', class: 'remove', disabled: S.sending, 'aria-label': 'Remove ' + item.name,
        onclick: () => {
          item.removed = true;
          S.staged.splice(S.staged.indexOf(item), 1);
          saveDraft();
          renderImages();
        } }, '×')));
  }
  $('compose-send').disabled = S.sending || S.staged.some((item) => !item.image) || (!allowed && S.staged.length > 0)
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
  const key = draftKey();
  for (const file of files) {
    if (!file.size || file.size > (settings.max_attachment_bytes || 10485760)) {
      error.textContent = file.name + ' is empty or exceeds the image size limit.';
      continue;
    }
    const item = { name: file.name, token: clientId(), draftKey: key };
    staged.push(item);
    renderImages();
    api('POST', '/api/v1/attachments', file, { 'X-Filename': encodeURIComponent(file.name) })
      .then((r) => {
        item.image = r.attachment;
        if (item.removed) return;
        if (staged === S.staged) saveDraft();           // still on the chat it started in
        else addToStoredDraft(item.draftKey, item);      // the owner moved on: keep it in that draft
      })
      .catch((e) => {
        if (staged === S.staged && staged.includes(item)) {
          staged.splice(staged.indexOf(item), 1);
          error.textContent = e.message;
        }
      }).finally(() => { if (staged === S.staged) renderImages(); });
  }
}

$('compose-attach').addEventListener('click', () => {
  if ($('compose-attach').getAttribute('aria-disabled') === 'true') return;   // the tooltip explains why
  $('compose-files').click();
});
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
    local: 'sending', id: null, client_msg_id: clientId(), client_sent_at: now(), body: $('compose-body').value,
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
  const payload = { body: entry.body, mode: entry.mode, attachment_ids: entry.attachment_ids,
    client_msg_id: entry.client_msg_id, client_sent_at: entry.client_sent_at };
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

function findTask(id) {
  for (const p of (S.board.projects || [])) {
    const t = p.tasks.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

function stateLabel(list, key) { const f = list.find((x) => x[0] === key); return f ? f[1] : key; }

function projectPill(status) {
  const cls = { active: 'ok', paused: 'warn', completed: 'info' }[status] || '';
  return h('span', { class: 'pill ' + cls, text: stateLabel(PROJECT_STATES, status) });
}

function avatarRow(people, size) {
  return h('span', { class: 'avatar-row' }, (people || []).slice(0, 6).map((p) => avatar(p, size || 'xs',
    { label: p.display_name, consul: p.role === 'consul' })));
}

function taskCounts(p) {
  if (p.task_counts) return p.task_counts;
  const c = { total: p.tasks.length };
  TASK_STATES.forEach(([k]) => { c[k] = p.tasks.filter((t) => t.status === k).length; });
  return c;
}

function countBar(counts) {
  const bar = h('span', { class: 'count-bar', role: 'img', 'aria-label':
    TASK_STATES.filter(([k]) => counts[k]).map(([k, l]) => `${counts[k]} ${l.toLowerCase()}`).join(', ') || 'No tasks' });
  if (!counts.total) return bar;
  for (const k of ['done', 'in_review', 'in_progress', 'blocked', 'cancelled']) {
    if (!counts[k]) continue;
    const seg = h('span', { class: 'cb-' + k, title: `${counts[k]} ${stateLabel(TASK_STATES, k).toLowerCase()}` });
    seg.style.width = (100 * counts[k] / counts.total) + '%';
    bar.append(seg);
  }
  return bar;
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
    const counts = taskCounts(p);
    list.append(h('button', { type: 'button', class: 'proj-card' + (S.view.activeProjectId === p.id ? ' active' : ''),
      onclick: () => { S.view.activeProjectId = p.id; S.view.projectView = 'detail'; saveView(); renderProjects(); renderTabs(); } },
      h('span', { class: 'proj-card-top' }, h('span', { class: 'proj-card-name', text: p.name }), projectPill(p.status)),
      countBar(counts),
      h('span', { class: 'proj-card-foot' },
        h('span', { class: 'person' }, p.pm ? avatar(p.pm, 'xs') : null, p.pm ? p.pm.display_name : 'No manager'),
        avatarRow(p.members),
        h('span', { class: 'tnum', text: `${counts.done || 0}/${counts.total - (counts.cancelled || 0)} done` +
          (counts.blocked ? `, ${counts.blocked} blocked` : '') }))));
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
  const counts = taskCounts(p);
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
      h('span', {}, `Members (${p.members.length}) `, avatarRow(p.members))),
    countBar(counts)));
  frag.append(h('div', { class: 'proj-toolbar' },
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter tasks by status' },
      [['all', 'All']].concat(TASK_STATES).map(([k, label]) => h('button', { type: 'button', class: 'filter',
        'aria-pressed': String(tf === k), onclick: () => { S.view.taskStatusFilter = k; saveView(); renderProjects(); } },
        label + (k === 'all' ? '' : ` ${counts[k] || 0}`)))),
    h('button', { type: 'button', class: 'primary', disabled: !p.members.length,
      title: p.members.length ? null : 'Add members before creating tasks', onclick: () => openTaskDialog(p, null) }, 'New task')));
  const closed = (s) => (s === 'done' || s === 'cancelled' ? 1 : 0);
  const tasks = p.tasks.filter((t) => tf === 'all' || t.status === tf)
    .sort((a, b) => closed(a.status) - closed(b.status) || b.priority - a.priority || a.id - b.id);
  const list = h('div', { class: 'tasks' });
  if (!tasks.length) list.append(h('p', { class: 'list-empty', text: p.tasks.length ? 'No tasks with this status.' : 'No tasks yet.' }));
  for (const t of tasks) {
    const statusSel = h('select', { 'aria-label': `Status of ${t.title}`, onchange: (ev) => changeTaskStatus(p, t, ev.target) },
      TASK_STATES.map(([k, label]) => h('option', { value: k, selected: t.status === k, text: label })));
    const prio = Math.max(0, Math.min(3, t.priority));
    list.append(h('div', { class: 'task is-' + t.status, 'data-task-id': t.id },
      h('span', { class: 'prio p' + prio, title: 'Priority', text: stateLabel(PRIORITIES, prio) }),
      h('span', { class: 'task-title', text: t.title }),
      h('span', { class: 'task-side' }, statusSel,
        h('button', { type: 'button', class: 'quiet', onclick: () => openTaskDialog(p, t) }, 'Edit')),
      t.description || (t.status === 'blocked' && t.blocked_reason) ? h('span', { class: 'task-desc' },
        t.status === 'blocked' && t.blocked_reason ? h('span', { class: 'task-blocked', text: `Blocked: ${t.blocked_reason}` }) : null,
        t.description ? h('span', { text: t.description.slice(0, 180) }) : null) : null,
      h('span', { class: 'task-who' }, t.assignees.map((a) => h('button', { type: 'button', title: `Chat with ${a.display_name}`,
        'aria-label': `Chat with ${a.display_name}`, onclick: () => { const ag = agentById(a.id); if (ag) openWith(ag); } },
        avatar(a, 'xs'))))));
  }
  frag.append(list);
  return frag;
}

function changeTaskStatus(p, t, sel) {
  if (sel.value === 'blocked') {        // a blocked task needs a reason: ask in the task dialog
    const want = sel.value;
    sel.value = t.status;
    openTaskDialog(p, t, { status: want });
    return;
  }
  patchTask(t, { status: sel.value });
}

function conflictMessage(e) {
  return e.data && e.data.error === 'version_conflict'
    ? 'Someone changed this task meanwhile. The latest version is loaded; apply your change again.' : e.message;
}

async function patchTask(t, data) {
  try { await api('PATCH', `/api/v1/tasks/${t.id}`, Object.assign({ expected_version: t.version }, data)); }
  catch (e) { window.alert(conflictMessage(e)); }
  schedule({ board: true });
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
let editingTaskVersion = null;      // the version the owner opened; a newer one on the server is a conflict
let conflictTask = null;
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

function syncBlockedField() {
  const blocked = $('tf-status').value === 'blocked';
  $('tf-blocked-wrap').hidden = !blocked;
}

function openTaskDialog(p, t, preset) {
  taskProject = p;
  editingTask = t;
  editingTaskVersion = t ? t.version : null;
  conflictTask = null;
  $('tf-conflict').hidden = true;
  $('task-dialog-title').textContent = t ? 'Edit task' : 'New task';
  $('tf-submit').textContent = t ? 'Save task' : 'Create task';
  $('tf-project').textContent = `Project: ${p.name}`;
  $('tf-title').value = t ? t.title : '';
  $('tf-desc').value = t ? (t.description || '') : '';
  const status = (preset && preset.status) || (t ? t.status : 'open');
  const st = clear($('tf-status'));
  TASK_STATES.forEach(([k, label]) => st.append(h('option', { value: k, selected: status === k, text: label })));
  const pr = clear($('tf-priority'));
  PRIORITIES.forEach(([k, label]) => pr.append(h('option', { value: k, selected: (t ? t.priority : 1) === k, text: label })));
  $('tf-blocked').value = t && t.blocked_reason ? t.blocked_reason : '';
  syncBlockedField();
  // Assignees come strictly from the project's members (spec 8.3).
  memberChecks($('tf-assignees'), p.members, t ? t.assignees.map((a) => a.id) : []);
  $('tf-error').textContent = '';
  $('task-dialog').showModal();
  if (preset && preset.status === 'blocked') $('tf-blocked').focus(); else $('tf-title').focus();
}

$('tf-status').addEventListener('change', syncBlockedField);

$('task-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ids = Array.from($('tf-assignees').querySelectorAll('input:checked')).map((i) => Number(i.value));
  if (!ids.length) { $('tf-error').textContent = 'Select at least one project member.'; return; }
  const body = { title: $('tf-title').value.trim(), description: $('tf-desc').value.trim() || null,
    status: $('tf-status').value, priority: Number($('tf-priority').value), assignee_ids: ids };
  if (!body.title) { $('tf-error').textContent = 'Enter a task title.'; return; }
  if (body.status === 'blocked') body.blocked_reason = $('tf-blocked').value.trim() || null;
  try {
    if (editingTask) {
      await api('PATCH', `/api/v1/tasks/${editingTask.id}`, Object.assign({ expected_version: editingTaskVersion }, body));
    } else {
      await api('POST', `/api/v1/projects/${taskProject.id}/tasks`, body);
    }
    $('task-dialog').close();
    schedule({ board: true });
  } catch (e) {
    if (e.data && e.data.error === 'version_conflict') await showTaskConflict();
    else $('tf-error').textContent = e.message;
  }
});

// Someone else saved first: show their version next to the owner's unsaved edits. Saving again
// is then a deliberate overwrite of exactly that version.
async function showTaskConflict() {
  $('tf-error').textContent = '';
  try {
    S.board = await api('GET', '/api/v1/board');
    renderAgents(); renderProjects(); renderSenate();
  } catch (e) { $('tf-error').textContent = `This task changed elsewhere and the latest version could not be loaded: ${e.message}`; return; }
  const latest = editingTask && findTask(editingTask.id);
  if (!latest) { $('tf-error').textContent = 'This task no longer exists.'; return; }
  conflictTask = latest;
  editingTaskVersion = latest.version;
  const kv = clear($('tf-conflict-fields'));
  const add = (k, v) => kv.append(h('dt', { text: k }), h('dd', { text: v || 'none' }));
  add('Title', latest.title);
  add('Status', stateLabel(TASK_STATES, latest.status) + (latest.status === 'blocked' && latest.blocked_reason ? `: ${latest.blocked_reason}` : ''));
  add('Priority', stateLabel(PRIORITIES, Math.max(0, Math.min(3, latest.priority))));
  add('Assignees', latest.assignees.map((a) => a.display_name).join(', '));
  add('Description', (latest.description || '').slice(0, 200));
  $('tf-conflict').hidden = false;
  $('tf-submit').textContent = 'Save my version';
}

$('tf-use-latest').addEventListener('click', () => {
  const t = conflictTask;
  if (!t) return;
  $('tf-title').value = t.title;
  $('tf-desc').value = t.description || '';
  $('tf-status').value = t.status;
  $('tf-priority').value = String(Math.max(0, Math.min(3, t.priority)));
  $('tf-blocked').value = t.blocked_reason || '';
  syncBlockedField();
  const ids = t.assignees.map((a) => a.id);
  $('tf-assignees').querySelectorAll('input[type="checkbox"]').forEach((i) => { i.checked = ids.includes(Number(i.value)); });
  $('tf-conflict').hidden = true;
  $('tf-submit').textContent = 'Save task';
  conflictTask = null;
});

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// =============================================================================
// Senate: Consul, invites, pools, server storage
// =============================================================================

function listRow(...kids) { return h('div', { class: 'list-row' }, ...kids); }

function renderSenate() {
  if (!S.board) return;
  renderConsul();
  renderAdmin();
  renderStorage(S.board.server_storage);
}

function renderConsul() {
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
      h('button', { type: 'button', class: 'ghost', onclick: () => savePool(p, form) }, 'Save'));
    pr.append(h('div', { class: 'list-row' },
      h('strong', { class: 'grow pool-title', title: poolLabel(p) }, prov(p.provider, 18), h('span', { class: 'clip', text: poolLabel(p) })),
      h('span', { class: 'muted', text: `${members.length} member(s)` }), form));
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

// --- Lyra Server Storage ------------------------------------------------------

function renderStorage(st) {
  const box = clear($('storage'));
  if (!st) { box.append(h('p', { class: 'muted', text: 'Storage information is not available.' })); return; }
  const used = pct(st.used_pct);
  const fill = h('span', { class: 'fill ' + (used >= 90 ? 'bad' : used >= 70 ? 'warn' : 'ok') });
  fill.style.width = Math.max(used, used > 0 ? 0.6 : 0) + '%';
  const quota = `${fmtNum(st.quota_gb, 1)} GB`;
  box.append(h('div', { class: 'storage-head' },
    h('span', { class: 'storage-used' }, fmtBytes(st.total_bytes), h('small', { text: ` used of ${quota}` })),
    h('span', { class: 'muted tnum', text: `${fmtNum(st.used_pct, used < 1 ? 2 : 1)}% of quota, ${fmtBytes(st.free_bytes)} free` })),
    h('div', { class: 'storage-bar' }, h('span', { class: 'track', role: 'img', 'aria-label': `${fmtNum(st.used_pct, 1)}% of the storage quota used` }, fill)));
  const disk = st.host_disk || {};
  const stat = (label, value, sub) => h('div', { class: 'stat' }, h('dt', { text: label }), h('dd', {}, value,
    sub ? h('div', { class: 'stat-sub', text: sub }) : null));
  box.append(h('dl', { class: 'storage-grid' },
    stat('Database', fmtBytes(st.db_bytes), 'SQLite with WAL'),
    stat('Attachments', fmtBytes(st.attachments_bytes), `${fmtNum(st.attachments_count)} files`),
    stat('Orphaned uploads', `${fmtNum(st.orphan_attachments_count)}`, fmtBytes(st.orphan_attachments_bytes)),
    stat('Backups', fmtBytes(st.backups_bytes), `${fmtNum(st.backups_count)} files`),
    stat('Events', fmtNum(st.events_count), 'SSE replay log'),
    stat('Messages', fmtNum(st.messages_count)),
    stat('Host disk', disk.free_bytes != null ? `${fmtBytes(disk.free_bytes)} free` : 'unknown',
      disk.total_bytes != null ? `of ${fmtBytes(disk.total_bytes)}` : null),
    stat('Server uptime', st.uptime_sec != null ? uptime(st.uptime_sec) : 'unknown')));
  box.append(h('p', { class: 'muted note', title: st.data_dir, text: `Data directory: ${st.data_dir}` }));
}

const CLEANUP_CONFIRM = {
  prune_events: 'Delete server events older than 7 days? Live clients that are far behind will do a full reload.',
  prune_backups: 'Delete all but the 5 newest backups?',
  all: 'Run every cleanup step: remove orphaned uploads, prune events older than 7 days, keep the 5 newest backups and compact the WAL?',
};

document.querySelectorAll('[data-cleanup]').forEach((b) => b.addEventListener('click', async () => {
  const action = b.dataset.cleanup;
  if (CLEANUP_CONFIRM[action] && !window.confirm(CLEANUP_CONFIRM[action])) return;
  $('storage-error').textContent = '';
  const buttons = document.querySelectorAll('[data-cleanup]');
  buttons.forEach((x) => { x.disabled = true; });
  $('storage-result').textContent = 'Cleaning up…';
  try {
    const r = await api('POST', '/api/v1/admin/cleanup', { action });
    const c = r.cleaned || {};
    const parts = [];
    if (action === 'all' || action === 'sweep_orphans') parts.push(`${c.orphans_removed || 0} orphaned uploads removed`);
    if (action === 'all' || action === 'prune_events') parts.push(`${c.events_deleted || 0} old events deleted`);
    if (action === 'all' || action === 'prune_backups') parts.push(`${c.backups_removed || 0} old backups removed`);
    if (c.wal_checkpointed) parts.push('WAL compacted');
    $('storage-result').textContent = `Done: ${parts.join(', ')}.`;
    if (r.storage) { S.board.server_storage = r.storage; renderStorage(r.storage); }
    schedule({ board: true });
  } catch (e) {
    $('storage-result').textContent = '';
    $('storage-error').textContent = e.message;
  } finally {
    buttons.forEach((x) => { x.disabled = false; });
  }
}));

// =============================================================================
// Power-user ergonomics: quick switcher, stepping, shortcuts
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
  [['chats', 'Chats'], ['projects', 'Projects'], ['senate', 'Senate'], ['agents', 'Agents']].forEach(([k, label]) =>
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

// n / N: next or previous agent that needs you (wraps).
function stepNeeds(dir) {
  const items = S.needs;
  if (!items.length) return;
  const current = recipientAgent();
  const at = current ? items.findIndex((n) => n.agent.id === current.id) : -1;
  const next = items[at === -1 ? (dir > 0 ? 0 : items.length - 1) : (at + dir + items.length) % items.length];
  openWith(next.agent);
}

// x: next unread conversation after the current one (wraps).
function nextUnread() {
  const flat = orderedConvs().flat;
  const at = S.conv && S.conv.id != null ? flat.findIndex((c) => c.id === S.conv.id) : -1;
  for (let i = 1; i <= flat.length; i++) {
    const c = flat[(at + i + flat.length) % flat.length];
    if (c.unread_count) { openConv(c.id, { user: true }); return; }
  }
}

document.addEventListener('keydown', (ev) => {
  if ($('main').hidden) return;
  const key = ev.key;
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && key.toLowerCase() === 'k') {
    ev.preventDefault();
    openQuick();
    return;
  }
  if (key === 'Escape' && !$('host-menu').hidden) { closeHostMenu(true); return; }
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
  } else if (key === 'n' || key === 'N') {
    ev.preventDefault();
    stepNeeds(key === 'N' ? -1 : 1);
  } else if (key.toLowerCase() === 'x') {
    ev.preventDefault();
    nextUnread();
  } else if (key.toLowerCase() === 'h') {
    ev.preventDefault();
    toggleSidebar();
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
}, 15000);
setInterval(() => { if (!$('main').hidden && !document.hidden) refreshLiveTimers(); }, 1000);

document.querySelectorAll('.logo-slot').forEach((slot) => {
  if (MOD.brand) slot.append(MOD.brand.logo(Number(slot.dataset.size) || 28));
});
if (MOD.brand) {
  const row = $('login-providers');
  ['anthropic', 'openai', 'google', 'moonshot'].forEach((p) => row.append(MOD.brand.provider(p, 18)));
}

loadView();
applyTheme();
applySidebar();
renderNotifyToggle();
if (MOD.pop) MOD.pop.bind(document.body);
boot();
