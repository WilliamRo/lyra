// Lyra lifecycle.js v3: compact delivery receipts under the owner's messages, and the live
// agent-side bubble (thinking, working, input required) shown at the bottom of a thread.
//
//   LyraLifecycle.receipt(msg, ctx)                 -> { kind, checks, label, tone, actions[] }
//   LyraLifecycle.renderReceipt(msg, ctx, handlers) -> <div class="receipt"> (DOM)
//   LyraLifecycle.updateReceipt(el, msg, ctx, handlers) re-renders in place
//   LyraLifecycle.live(msg, ctx)                    -> null, or { phase, label, stale, bullets, since }
//   LyraLifecycle.renderLive(msg, ctx) / updateLive(el, msg, ctx)
//   LyraLifecycle.replied(msg, msgs), cleanProgress(p), clock(seconds)
// ctx: { now, replied, agentStatus, document }. msg.local is 'sending' or 'send_failed' for
// optimistic entries. handlers: { onCancel, onRetryDelivery, onRetrySend, onDiscard, onDetails }.
(function (root) {
  'use strict';

  var PHASES = ['thinking', 'working', 'input_required'];
  var BULLET_STATES = ['done', 'active', 'pending'];
  var MAX_VISIBLE = 6;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function cleanProgress(p) {
    if (!p || typeof p !== 'object' || PHASES.indexOf(p.phase) === -1) return null;
    var bullets = Array.isArray(p.bullets) ? p.bullets.slice(0, 50) : [];
    return {
      phase: p.phase,
      summary: typeof p.summary === 'string' ? p.summary.slice(0, 240) : '',
      bullets: bullets.filter(function (b) { return b && typeof b.text === 'string' && b.text.trim(); })
        .map(function (b) {
          var st = b.status || b.state;                    // the server sends `state`
          return { text: b.text.slice(0, 200), status: BULLET_STATES.indexOf(st) !== -1 ? st : 'pending' };
        }),
      updated_at: typeof p.updated_at === 'number' ? p.updated_at : null,
      stale: p.stale === true,
    };
  }

  function replied(msg, msgs) {
    if (!msg || msg.id == null || !Array.isArray(msgs)) return false;
    var to = msg.recipient && msg.recipient.id;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || m.id === msg.id) continue;
      if (m.reply_to && m.reply_to.id === msg.id) return true;
      if (to != null && m.sender && m.sender.id === to && m.id > msg.id &&
          m.conversation_id === msg.conversation_id) return true;
    }
    return false;
  }

  function minutes(sec) {
    var m = Math.max(1, Math.round(sec / 60));
    return m < 60 ? m + ' min' : Math.round(m / 60) + ' h';
  }

  // 0:42, 3:05, 1:02:10
  function clock(sec) {
    var s = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
  }

  // --- owner receipts ---------------------------------------------------------

  function receipt(msg, ctx) {
    var m = msg || {};
    var c = ctx || {};
    if (m.local === 'sending') return { kind: 'sending', checks: 0, label: 'Sending…', tone: 'muted', actions: [] };
    if (m.local === 'send_failed') {
      return { kind: 'send_failed', checks: 0, label: 'Not sent: ' + (m.local_error || 'network error'), tone: 'bad',
               actions: ['retrySend', 'discard'] };
    }
    switch (m.state) {
      case 'waiting': {
        var q = typeof m.queue_position === 'number' && m.queue_position > 1 ? m.queue_position : null;
        return { kind: 'server', checks: 1, label: 'Server' + (q ? ', #' + q + ' in queue' : ''), tone: 'muted',
                 actions: ['cancel'] };
      }
      case 'unconfirmed':
        return { kind: 'unconfirmed', checks: 1, label: 'Delivery unconfirmed', tone: 'warn', actions: ['retry', 'details'] };
      case 'failed':
        return { kind: 'failed', checks: 0, label: 'Failed: ' + (m.state_reason || 'delivery failed'), tone: 'bad',
                 actions: ['details'] };
      case 'cancelled':
        return { kind: 'cancelled', checks: 0, label: 'Cancelled', tone: 'muted', actions: ['details'] };
      case 'delivered':
        return { kind: c.replied ? 'replied' : 'read', checks: 2, label: 'Agent read', tone: 'ok', actions: ['details'] };
      default:
        return { kind: 'server', checks: 1, label: 'Server', tone: 'muted', actions: [] };
    }
  }

  function node(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function checks(doc, count) {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'rc-checks');
    svg.setAttribute('viewBox', count === 2 ? '0 0 22 14' : '0 0 16 14');
    svg.setAttribute('width', count === 2 ? '18' : '13');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var paths = count === 2 ? ['M1.5 7.5l3.5 3.5 7.5-8', 'M9 11l7.5-8', 'M7.6 9.6l1.4 1.4'] : ['M2 7.5l3.5 3.5 8-8.5'];
    paths.forEach(function (d) {
      var p = doc.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    });
    return svg;
  }

  function button(doc, cls, text, fn, msg) {
    var b = node(doc, 'button', cls, text);
    b.type = 'button';
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(msg, b); });
    return b;
  }

  var ACTIONS = {
    cancel: ['onCancel', 'Cancel', 'rc-btn'],
    retry: ['onRetryDelivery', 'Retry', 'rc-btn'],
    retrySend: ['onRetrySend', 'Retry', 'rc-btn'],
    discard: ['onDiscard', 'Discard', 'rc-btn rc-quiet'],
    details: ['onDetails', 'Details', 'rc-btn rc-quiet'],
  };

  function updateReceipt(el, msg, ctx, handlers) {
    var doc = el.ownerDocument;
    var h = handlers || {};
    var info = receipt(msg, ctx);
    while (el.firstChild) el.removeChild(el.firstChild);
    el.className = 'receipt is-' + info.kind + ' tone-' + info.tone;
    el.setAttribute('data-kind', info.kind);
    var status = node(doc, 'span', 'rc-status');
    status.setAttribute('role', 'status');
    if (info.kind === 'sending') status.appendChild(node(doc, 'span', 'rc-spinner'));
    else if (info.checks) status.appendChild(checks(doc, info.checks));
    status.appendChild(node(doc, 'span', 'rc-label', info.label));
    el.appendChild(status);
    info.actions.forEach(function (a) {
      var spec = ACTIONS[a];
      if (spec && h[spec[0]]) el.appendChild(button(doc, spec[2], spec[1], h[spec[0]], msg));
    });
    return info;
  }

  function renderReceipt(msg, ctx, handlers) {
    var doc = (ctx && ctx.document) || root.document;
    var el = doc.createElement('div');
    updateReceipt(el, msg, ctx, handlers);
    return el;
  }

  // --- live agent-side bubble ---------------------------------------------------

  function live(msg, ctx) {
    var m = msg || {};
    var c = ctx || {};
    if (m.local || m.state !== 'delivered' || c.replied) return null;
    var prog = cleanProgress(m.progress);
    if (!prog) return null;
    var now = typeof c.now === 'number' ? c.now : Date.now() / 1000;
    var since = typeof m.delivered_at === 'number' ? m.delivered_at : (prog.updated_at || now);
    var stalled = c.agentStatus === 'stalled';
    var stale = prog.stale || stalled || c.agentStatus === 'stale';
    var label;
    if (prog.phase === 'input_required') label = 'Needs your input' + (prog.summary ? ': ' + prog.summary : '');
    else if (prog.phase === 'working') label = prog.summary || 'Working';
    else label = prog.summary || 'Thinking';
    if (stale && prog.phase !== 'input_required') {
      var quiet = prog.updated_at != null ? ' for ' + minutes(now - prog.updated_at) : '';
      label = (stalled ? 'Stalled, no activity' : 'No update') + quiet + ': ' + label;
    }
    return { phase: prog.phase, label: label, stale: stale, stalled: stalled, bullets: prog.bullets,
             since: since, elapsed: Math.max(0, now - since) };
  }

  function visibleWindow(bullets) {
    if (bullets.length <= MAX_VISIBLE) return { start: 0, end: bullets.length };
    var active = bullets.findIndex(function (b) { return b.status === 'active'; });
    if (active === -1) active = bullets.findIndex(function (b) { return b.status === 'pending'; });
    if (active === -1) active = bullets.length - 1;
    var start = Math.max(0, Math.min(active - 2, bullets.length - MAX_VISIBLE));
    return { start: start, end: start + MAX_VISIBLE };
  }

  function updateLive(el, msg, ctx) {
    var doc = el.ownerDocument;
    var info = live(msg, ctx);
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!info) { el.hidden = true; return null; }
    el.hidden = false;
    el.className = 'live-status is-' + info.phase + (info.stale ? ' is-stale' : '') + (info.stalled ? ' is-stalled' : '');
    el.setAttribute('data-phase', info.phase);
    var head = node(doc, 'div', 'live-head');
    if (!info.stale && info.phase !== 'input_required') {
      var dots = node(doc, 'span', 'thinking-dots');
      dots.setAttribute('aria-hidden', 'true');
      for (var d = 0; d < 3; d++) dots.appendChild(doc.createElement('span'));
      head.appendChild(dots);
    }
    var label = node(doc, 'span', 'live-label', info.label);
    label.setAttribute('role', 'status');
    head.appendChild(label);
    var timer = node(doc, 'span', 'live-timer', clock(info.elapsed));
    timer.setAttribute('data-since', String(info.since));
    timer.setAttribute('title', 'Time since the agent picked this up');
    head.appendChild(timer);
    el.appendChild(head);
    if (info.bullets.length && info.phase !== 'thinking') {
      var card = node(doc, 'div', 'work-card');
      var win = visibleWindow(info.bullets);
      if (win.start > 0) card.appendChild(node(doc, 'div', 'work-more', win.start + ' earlier steps done'));
      var ul = node(doc, 'ul', 'work-bullets');
      info.bullets.slice(win.start, win.end).forEach(function (b) {
        var li = node(doc, 'li', 'work-bullet is-' + b.status);
        var mark = node(doc, 'span', 'work-mark');
        mark.setAttribute('aria-hidden', 'true');
        li.appendChild(mark);
        li.appendChild(node(doc, 'span', 'work-text', b.text));
        li.appendChild(node(doc, 'span', 'lc-sr', b.status === 'done' ? ' (done)' : b.status === 'active' ? ' (in progress)' : ' (pending)'));
        ul.appendChild(li);
      });
      card.appendChild(ul);
      if (win.end < info.bullets.length) card.appendChild(node(doc, 'div', 'work-more', '+' + (info.bullets.length - win.end) + ' more'));
      el.appendChild(card);
    }
    return info;
  }

  function renderLive(msg, ctx) {
    var doc = (ctx && ctx.document) || root.document;
    var el = doc.createElement('div');
    updateLive(el, msg, ctx);
    return el;
  }

  root.LyraLifecycle = {
    version: '3.0.0',
    receipt: receipt,
    renderReceipt: renderReceipt,
    updateReceipt: updateReceipt,
    live: live,
    renderLive: renderLive,
    updateLive: updateLive,
    replied: replied,
    cleanProgress: cleanProgress,
    clock: clock,
  };
})(typeof window !== 'undefined' ? window : globalThis);
