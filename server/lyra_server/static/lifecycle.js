// Lyra lifecycle.js: delivery and progress tracker under the owner's sent messages.
// UI_SPEC_AND_QA section 5, plus a "no response yet" stale hint after a quiet period.
//
//   LyraLifecycle.phase(msg, ctx)            -> { phase, step, label, stale, queue }
//   LyraLifecycle.replied(msg, msgs)         -> true once the recipient has answered
//   LyraLifecycle.render(msg, ctx, handlers) -> <div class="msg-lifecycle"> (DOM)
//   LyraLifecycle.update(el, msg, ctx, handlers) re-renders in place (node identity kept)
// msg.local may be 'sending' or 'send_failed' for optimistic entries without a server id.
// handlers: { onRetryDelivery(msg), onRetrySend(msg), onDiscard(msg) }
(function (root) {
  'use strict';

  var STEPS = ['Sent', 'Queued', 'Delivered', 'Working', 'Replied'];
  var PHASES = ['thinking', 'working', 'idle'];
  var BULLET_STATES = ['done', 'active', 'pending'];
  var MAX_VISIBLE = 6;
  var STALE_AFTER = 900;            // seconds without progress or reply after delivery

  function cleanProgress(p) {
    if (!p || typeof p !== 'object' || PHASES.indexOf(p.phase) === -1) return null;
    var bullets = Array.isArray(p.bullets) ? p.bullets.slice(0, 50) : [];
    return {
      phase: p.phase,
      summary: typeof p.summary === 'string' ? p.summary.slice(0, 200) : '',
      bullets: bullets.filter(function (b) { return b && typeof b.text === 'string' && b.text.trim(); })
        .map(function (b) {
          return { text: b.text.slice(0, 160), status: BULLET_STATES.indexOf(b.status) !== -1 ? b.status : 'pending' };
        }),
      updated_at: typeof p.updated_at === 'number' ? p.updated_at : null,
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

  function phase(msg, ctx) {
    var c = ctx || {};
    var m = msg || {};
    var prog = cleanProgress(m.progress);
    var out = { phase: 'waiting', step: 1, label: '', stale: false, queue: null, progress: prog };
    if (m.local === 'sending') return Object.assign(out, { phase: 'sending', step: 0, label: 'Sending…' });
    if (m.local === 'send_failed') {
      return Object.assign(out, { phase: 'send_failed', step: 0, label: 'Not sent: ' + (m.local_error || 'network error') });
    }
    if (m.state === 'failed') {
      return Object.assign(out, { phase: 'failed', step: 1, label: 'Failed: ' + (m.state_reason || 'delivery failed') });
    }
    if (m.state === 'unconfirmed') {
      return Object.assign(out, { phase: 'unconfirmed', step: 2, label: 'Delivery unconfirmed' });
    }
    if (c.replied) return Object.assign(out, { phase: 'complete', step: 4, label: 'Delivered' });
    if (m.state === 'waiting') {
      var q = typeof m.queue_position === 'number' ? m.queue_position : null;
      return Object.assign(out, { phase: 'waiting', step: 1, queue: q,
                                  label: 'Waiting in queue' + (q && q > 1 ? ' (#' + q + ')' : '') });
    }
    if (m.state === 'delivered') {
      if (prog && prog.phase === 'working') {
        return Object.assign(out, { phase: 'working', step: 3, label: prog.summary || 'Working…' });
      }
      if (prog && prog.phase === 'thinking') {
        return Object.assign(out, { phase: 'thinking', step: 3, label: prog.summary || 'Thinking…' });
      }
      var since = (prog && prog.updated_at) || m.delivered_at;
      var now = typeof c.now === 'number' ? c.now : Date.now() / 1000;
      var limit = typeof c.staleAfterSec === 'number' ? c.staleAfterSec : STALE_AFTER;
      if (typeof since === 'number' && now - since >= limit) {
        return Object.assign(out, { phase: 'delivered', step: 2, stale: true,
                                    label: 'Delivered, no reply for ' + minutes(now - since) });
      }
      return Object.assign(out, { phase: 'delivered', step: 2, label: 'Delivered, awaiting agent…' });
    }
    return Object.assign(out, { label: 'Waiting in queue' });
  }

  function node(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(doc, cls, text, fn, msg) {
    var b = node(doc, 'button', cls, text);
    b.type = 'button';
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(msg); });
    return b;
  }

  function visibleWindow(bullets) {
    if (bullets.length <= MAX_VISIBLE) return { start: 0, end: bullets.length };
    var active = bullets.findIndex(function (b) { return b.status === 'active'; });
    if (active === -1) active = bullets.findIndex(function (b) { return b.status === 'pending'; });
    if (active === -1) active = bullets.length - 1;
    var start = Math.max(0, Math.min(active - 2, bullets.length - MAX_VISIBLE));
    return { start: start, end: start + MAX_VISIBLE };
  }

  function fill(container, msg, ctx, handlers) {
    var doc = container.ownerDocument;
    var h = handlers || {};
    var info = phase(msg, ctx);
    while (container.firstChild) container.removeChild(container.firstChild);
    container.className = 'msg-lifecycle is-' + info.phase + (info.stale ? ' is-stale' : '');
    container.setAttribute('data-phase', info.phase);

    if (info.phase === 'complete') {
      container.appendChild(node(doc, 'span', 'lc-pill is-done', info.label));
      return info;
    }

    var rail = node(doc, 'ol', 'lc-rail');
    rail.setAttribute('aria-label', 'Delivery progress');
    var failedStep = info.phase === 'failed' || info.phase === 'send_failed' ? info.step : -1;
    STEPS.forEach(function (name, i) {
      var li = node(doc, 'li', 'lc-step');
      if (i < info.step) li.classList.add('is-done');
      if (i === info.step) li.classList.add(failedStep === i ? 'is-error' : 'is-current');
      li.appendChild(node(doc, 'span', 'lc-dot'));
      li.appendChild(node(doc, 'span', 'lc-step-name', name));
      if (i === info.step) li.setAttribute('aria-current', 'step');
      rail.appendChild(li);
    });
    container.appendChild(rail);

    var status = node(doc, 'div', 'lc-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    if (info.phase === 'thinking' || info.phase === 'sending') {
      var dots = node(doc, 'span', 'thinking-dots');
      dots.setAttribute('aria-hidden', 'true');
      for (var d = 0; d < 3; d++) dots.appendChild(doc.createElement('span'));
      status.appendChild(dots);
    }
    status.appendChild(node(doc, 'span', 'lc-label', info.label));
    container.appendChild(status);

    if (info.phase === 'working' && info.progress && info.progress.bullets.length) {
      var card = node(doc, 'div', 'work-card');
      var bullets = info.progress.bullets;
      var win = visibleWindow(bullets);
      if (win.start > 0) card.appendChild(node(doc, 'div', 'work-more', win.start + ' earlier steps done'));
      var ul = node(doc, 'ul', 'work-bullets');
      bullets.slice(win.start, win.end).forEach(function (b) {
        var li = node(doc, 'li', 'work-bullet is-' + b.status);
        var mark = node(doc, 'span', 'work-mark');
        mark.setAttribute('aria-hidden', 'true');
        li.appendChild(mark);
        li.appendChild(node(doc, 'span', 'work-text', b.text));
        var sr = node(doc, 'span', 'lc-sr', b.status === 'done' ? ' (done)' : b.status === 'active' ? ' (in progress)' : ' (pending)');
        li.appendChild(sr);
        ul.appendChild(li);
      });
      card.appendChild(ul);
      if (win.end < bullets.length) card.appendChild(node(doc, 'div', 'work-more', '+' + (bullets.length - win.end) + ' more'));
      container.appendChild(card);
    }

    var actions = null;
    if ((info.phase === 'unconfirmed' || info.phase === 'failed') && h.onRetryDelivery) {
      actions = node(doc, 'div', 'lc-actions');
      actions.appendChild(button(doc, 'lc-btn', 'Retry delivery', h.onRetryDelivery, msg));
    } else if (info.phase === 'send_failed') {
      actions = node(doc, 'div', 'lc-actions');
      if (h.onRetrySend) actions.appendChild(button(doc, 'lc-btn', 'Retry send', h.onRetrySend, msg));
      if (h.onDiscard) actions.appendChild(button(doc, 'lc-btn lc-btn-quiet', 'Discard', h.onDiscard, msg));
    }
    if (actions && actions.firstChild) container.appendChild(actions);
    return info;
  }

  function render(msg, ctx, handlers) {
    var doc = (ctx && ctx.document) || root.document;
    var el = doc.createElement('div');
    fill(el, msg, ctx, handlers);
    return el;
  }

  root.LyraLifecycle = {
    version: '2.0.0',
    STEPS: STEPS.slice(),
    phase: phase,
    replied: replied,
    cleanProgress: cleanProgress,
    render: render,
    update: fill,
  };
})(typeof window !== 'undefined' ? window : globalThis);
