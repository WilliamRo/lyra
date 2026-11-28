// Visual QA page for the v2 modules (not shipped). ?imgpop=1 opens the viewer at 250%.
(function () {
  'use strict';
  var M = window.LyraMarkdown;
  var A = window.LyraAvatar;
  var L = window.LyraLifecycle;
  var I = window.LyraImgPop;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  var dario = { id: 2, handle: 'dario', display_name: 'Dario' };
  var owner = { id: 1, handle: 'owner', display_name: 'Owner' };

  function bubble(who, body, mine, extra) {
    var wrap = el('div', 'g-msg' + (mine ? ' mine' : ''));
    if (!mine) wrap.appendChild(A.el(who, 'sm', { consul: who.consul }));
    var b = el('div', 'g-bubble');
    var head = el('div', 'g-head');
    head.appendChild(el('strong', null, who.display_name));
    if (who.consul) head.appendChild(el('span', 'g-consul', 'Consul'));
    head.appendChild(el('span', null, mine ? 'to Dario, 14:02' : '14:05'));
    b.appendChild(head);
    var md = el('div', 'msg-body');
    M.renderInto(md, body);
    b.appendChild(md);
    if (extra) b.appendChild(extra);
    wrap.appendChild(b);
    return wrap;
  }

  var reply = [
    '### Route audit',
    '==green:PASS== static paths ==red:BLOCKED== `.woff2` MIME ==amber:REVIEW== CSP',
    '',
    '- [x] Inspect static handler',
    '- [x] Draft CSP and KaTeX rules',
    '- [ ] Write acceptance checks',
    '',
    '| Check | Result | ms |',
    '| --- | :---: | ---: |',
    '| KaTeX CSS | ==green:200== | 12 |',
    '| KaTeX fonts | ==red:404== | 3 |',
    '',
    'Expected load is $\\mathbb{E}[x_t] = \\alpha + \\beta_i$, and the bound:',
    '$$\\sum_{i=1}^{n} x_i^2 \\le n \\max_i x_i^2$$',
    '```python',
    'def is_safe(part):',
    "    return part not in ('', '.', '..') and not part.startswith('.')",
    '```',
    '> Price is $5 to $10, so this stays text.',
  ].join('\n');

  var thread = $('thread');
  var ask = bubble(owner, 'Please audit the **static routes** and report blockers.', true,
    L.render({ id: 9, conversation_id: 1, recipient: dario, state: 'delivered', delivered_at: 1,
               progress: { phase: 'working', summary: 'Auditing REST routes and CSP headers', bullets: [
                 { text: 'Inspect static file handler', status: 'done' },
                 { text: 'Draft CSP and KaTeX rules', status: 'active' },
                 { text: 'Write acceptance QA checks', status: 'pending' }] } }, { now: 2 }, {}));
  thread.appendChild(ask);
  var answer = bubble(Object.assign({ consul: true }, dario), reply, false);
  var strip = el('div', 'image-strip');
  var c = document.createElement('canvas');
  c.width = 1600; c.height = 900;
  var g = c.getContext('2d');
  var grad = g.createLinearGradient(0, 0, 1600, 900);
  grad.addColorStop(0, '#2d5bd2'); grad.addColorStop(1, '#0f6e66');
  g.fillStyle = grad; g.fillRect(0, 0, 1600, 900);
  g.fillStyle = 'rgba(255,255,255,.9)';
  for (var i = 0; i < 24; i++) g.fillRect(80 + i * 60, 820 - (i * 37 % 600) - 60, 36, (i * 37 % 600) + 60);
  var img = el('img');
  img.src = c.toDataURL('image/png');
  img.alt = 'Latency chart';
  strip.appendChild(img);
  answer.querySelector('.g-bubble').appendChild(strip);
  thread.appendChild(answer);

  var states = $('states');
  var base = { id: 20, conversation_id: 1, recipient: dario };
  [
    ['Sending', { local: 'sending' }],
    ['Queued', Object.assign({ state: 'waiting', queue_position: 2 }, base)],
    ['Thinking', Object.assign({ state: 'delivered', delivered_at: 1, progress: { phase: 'thinking' } }, base)],
    ['Stale', Object.assign({ state: 'delivered', delivered_at: 1 }, base), { now: 1 + 1500 }],
    ['Unconfirmed', Object.assign({ state: 'unconfirmed' }, base), {}, { onRetryDelivery: function () {} }],
    ['Failed', Object.assign({ state: 'failed', state_reason: 'timeout' }, base), {}, { onRetryDelivery: function () {} }],
    ['Not sent', { local: 'send_failed', local_error: 'offline' }, {}, { onRetrySend: function () {}, onDiscard: function () {} }],
    ['Replied', Object.assign({ state: 'delivered' }, base), { replied: true }],
  ].forEach(function (row) {
    states.appendChild(el('div', 'g-label', row[0]));
    states.appendChild(L.render(row[1], Object.assign({ now: 5 }, row[2] || {}), row[3] || {}));
  });

  var avatars = $('avatars');
  ['dario', 'claude', 'echo', 'gem', 'kimi', 'atlas', 'nova', 'orion'].forEach(function (h, idx) {
    avatars.appendChild(A.el({ handle: h, display_name: h[0].toUpperCase() + h.slice(1) }, 'md',
      { status: idx % 3 ? 'on' : 'off', consul: h === 'dario' }));
  });
  avatars.appendChild(A.el({ handle: 'custom', display_name: 'Custom', avatar: { bg: '#ffd60a', icon: 'star' } }, 'lg'));
  avatars.appendChild(A.stack([dario, { handle: 'claude', display_name: 'Claude' }], 'xs'));

  I.bind(document.body);
  if (/[?&]imgpop=1/.test(location.search)) {
    img.addEventListener('load', function () {
      img.click();
      setTimeout(function () {
        var vp = document.querySelector('.lyra-imgpop-viewport');
        var r = vp.getBoundingClientRect();
        vp.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + r.width * 0.62, clientY: r.top + r.height * 0.45, bubbles: true }));
      }, 200);
    });
  }
})();
