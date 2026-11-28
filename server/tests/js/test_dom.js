// Browser tests: real DOM, vendored KaTeX, <dialog>, pointer and wheel events.
(function () {
  'use strict';
  var M = window.LyraMarkdown;
  var I = window.LyraImgPop;
  var A = window.LyraAvatar;
  var L = window.LyraLifecycle;
  var S = window.LyraStore;

  function stage() {
    var el = document.getElementById('stage');
    while (el.firstChild) el.removeChild(el.firstChild);
    el.removeAttribute('style');
    return el;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function until(fn, ms) {
    var t0 = Date.now();
    return new Promise(function (resolve, reject) {
      (function poll() {
        if (fn()) return resolve();
        if (Date.now() - t0 > (ms || 3000)) return reject(new Error('timed out'));
        setTimeout(poll, 20);
      })();
    });
  }
  function allElements(root) { return Array.prototype.slice.call(root.querySelectorAll('*')); }

  // ---------------------------------------------------------------------------
  // markdown.js render stage
  // ---------------------------------------------------------------------------

  test('dom markdown: XSS payloads render as inert text', function () {
    var el = stage();
    var payload = '<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[x](javascript:alert(1)) ' +
      '==red:<svg onload=alert(1)>== [y](https://ok.example/"onmouseover="alert(1))';
    M.renderInto(el, payload);
    assert.eq(el.querySelectorAll('script, img, svg, iframe, object, embed').length, 0, 'no active elements');
    allElements(el).forEach(function (n) {
      Array.prototype.forEach.call(n.attributes, function (a) {
        assert.ok(!/^on/i.test(a.name), 'event attribute ' + a.name);
        assert.ok(!/^\s*javascript:/i.test(a.value), 'javascript URL in ' + a.name);
      });
    });
    assert.ok(el.textContent.indexOf('<script>alert(1)</script>') !== -1, 'source text visible');
    Array.prototype.forEach.call(el.querySelectorAll('a'), function (a) {
      assert.ok(/^https:\/\/[^"'<>\s]+$/.test(a.getAttribute('href')), 'anchor href ' + a.getAttribute('href'));
    });
    assert.eq(el.querySelector('.md-color-red').textContent, '<svg onload=alert(1)>');
  });

  test('dom markdown: structure, tables, code copy, links', function () {
    var el = stage();
    M.renderInto(el, '## Plan\n\n| a | n |\n| --- | ---: |\n| x | 1 |\n\n```python\nprint(1)\n```\n' +
      'See [docs](https://lyra.example/docs) and ==green:PASS==');
    assert.ok(el.querySelector('h4.md-h2'), 'level 2 heading renders as h4 in bubbles');
    var wrap = el.querySelector('.md-table-wrap');
    assert.eq(wrap.getAttribute('role'), 'region');
    assert.eq(wrap.querySelector('th').getAttribute('scope'), 'col');
    assert.ok(wrap.querySelector('td.ta-r'), 'right alignment class');
    var btn = el.querySelector('.md-code-copy');
    assert.eq(btn.getAttribute('type'), 'button');
    assert.eq(el.querySelector('pre code').className, 'language-python');
    var a = el.querySelector('a.md-link');
    assert.eq(a.getAttribute('rel'), 'noopener noreferrer');
    assert.eq(a.getAttribute('target'), '_blank');
    assert.ok(el.querySelector('.md-color.md-color-green'));
  });

  test('dom markdown: vendored KaTeX renders inline and display math, currency stays text', function () {
    var el = stage();
    assert.ok(window.katex && typeof window.katex.render === 'function', 'KaTeX loaded from /static/vendor');
    M.renderInto(el, 'Inline $x_t = \\alpha + \\beta_i$ here.\n\n$$\\sum_{i=1}^n x_i^2$$\n\nBroken $\\broken{$ and Price is $5 to $10');
    assert.ok(el.querySelector('.md-math-inline .katex'), 'inline KaTeX');
    assert.ok(el.querySelector('.md-math-block .katex-display'), 'display KaTeX');
    assert.ok(el.textContent.indexOf('Price is $5 to $10') !== -1, 'currency text intact');
    assert.eq(el.querySelectorAll('.md-math-inline').length, 2, 'currency is not math');
  });

  test('dom markdown: missing KaTeX falls back to source text', function () {
    var el = stage();
    var span = document.createElement('span');
    el.appendChild(span);
    M.renderKatex('a^2', span, false, { render: function () { throw new Error('boom'); } });
    assert.eq(span.textContent, '$a^2$');
    assert.ok(span.classList.contains('md-math-fallback'));
  });

  test('dom markdown: wide table scrolls inside its wrapper on a 390px screen', function () {
    var el = stage();
    el.style.width = '390px';
    var row = '| ' + ['alpha_long_column', 'beta_long_column', 'gamma_long_column', 'delta_long', 'epsilon_long'].join(' | ') + ' |';
    M.renderInto(el, row + '\n| --- | --- | --- | --- | --- |\n' + row);
    var wrap = el.querySelector('.md-table-wrap');
    assert.ok(wrap.scrollWidth > wrap.clientWidth, 'table scrolls horizontally');
    assert.ok(el.scrollWidth <= el.clientWidth + 1, 'container does not widen');
  });

  // ---------------------------------------------------------------------------
  // imgpop.js in a real <dialog>
  // ---------------------------------------------------------------------------

  function testImage(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.fillStyle = '#2d5bd2'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f4f6fa'; g.fillRect(w / 4, h / 4, w / 2, h / 2);
    return c.toDataURL('image/png');
  }

  function centre(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function pe(type, id, x, y, kind) {
    return new PointerEvent(type, { pointerId: id, pointerType: kind || 'mouse', clientX: x, clientY: y,
                                    button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true });
  }

  var thumb = null;
  function openViewer() {
    var el = stage();
    var src = testImage(1600, 800);
    var strip = document.createElement('div');
    strip.className = 'image-strip';
    var a = document.createElement('a');
    a.href = src;
    thumb = document.createElement('img');
    thumb.src = src;
    thumb.alt = 'Test chart';
    thumb.width = 160;
    thumb.height = 80;
    a.appendChild(thumb);
    strip.appendChild(a);
    el.appendChild(strip);
    I.bind(el);
    assert.eq(thumb.getAttribute('role'), 'button');
    assert.eq(thumb.getAttribute('aria-haspopup'), 'dialog');
    thumb.click();
    return until(function () { return I.isOpen() && I.state().baseW > 0; });
  }

  test('dom imgpop: opens fitted inside the rounded frame', function () {
    return openViewer().then(function () {
      var d = document.getElementById('imgpop-dialog');
      var r = d.getBoundingClientRect();
      var margin = window.innerWidth >= 960 ? 64 : 16;   // desktop card vs near-fullscreen mobile frame
      assert.near(r.width, window.innerWidth - margin, 1.5, 'frame width calc(100vw - ' + margin + 'px)');
      var st = I.state();
      var fillsW = Math.abs(st.baseW - st.vpW) < 1;
      var fillsH = Math.abs(st.baseH - st.vpH) < 1;
      assert.ok(fillsW || fillsH, 'one axis fills the frame');
      assert.eq(d.querySelector('.lyra-imgpop-zoom').textContent, '100%');
      assert.ok(d.querySelector('.lyra-imgpop-reset').disabled, '1:1 disabled at 100%');
    });
  });

  test('dom imgpop: wheel zoom keeps the hovered pixel fixed', function () {
    var vp = document.querySelector('.lyra-imgpop-viewport');
    var c = centre(vp);
    var before = I.state();
    var ev = new WheelEvent('wheel', { deltaY: -400, clientX: c.x + 120, clientY: c.y + 60,
                                       bubbles: true, cancelable: true });
    var p = { x: ev.clientX - c.x, y: ev.clientY - c.y };   // init values are truncated to integers
    vp.dispatchEvent(ev);
    var after = I.state();
    assert.ok(after.zoom > 1.5, 'zoomed in to ' + after.zoom);
    // The hovered pixel stays put on every axis where the zoomed image overflows the frame;
    // on an axis where it still fits, the image stays centred (pan clamps to 0).
    [['x', 'baseW', 'vpW'], ['y', 'baseH', 'vpH']].forEach(function (k) {
      var pan = k[0] === 'x' ? 'panX' : 'panY';
      if (after[k[1]] * after.zoom > after[k[2]] + 1) {
        assert.near((p[k[0]] - after[pan]) / after.zoom, (p[k[0]] - before[pan]) / before.zoom, 0.01, k[0] + ' anchor');
      } else {
        assert.near(after[pan], 0, 1e-9, k[0] + ' stays centred while it fits');
      }
    });
    assert.ok(!document.querySelector('.lyra-imgpop-reset').disabled, '1:1 enabled when zoomed');
  });

  test('dom imgpop: drag pans with clamping, dblclick toggles, keys zoom', function () {
    var vp = document.querySelector('.lyra-imgpop-viewport');
    var c = centre(vp);
    var st0 = I.state();
    vp.dispatchEvent(pe('pointerdown', 7, c.x, c.y));
    vp.dispatchEvent(pe('pointermove', 7, c.x + 60, c.y + 30));
    vp.dispatchEvent(pe('pointerup', 7, c.x + 60, c.y + 30));
    var st1 = I.state();
    assert.ok(st1.panX > st0.panX || st1.panX === Math.max(0, (st1.baseW * st1.zoom - st1.vpW) / 2), 'panned right');
    vp.dispatchEvent(pe('pointerdown', 8, c.x, c.y));
    vp.dispatchEvent(pe('pointermove', 8, c.x + 99999, c.y + 99999));
    vp.dispatchEvent(pe('pointerup', 8, c.x + 99999, c.y + 99999));
    var st2 = I.state();
    assert.near(st2.panX, Math.max(0, (st2.baseW * st2.zoom - st2.vpW) / 2), 0.01, 'clamped to the edge');
    vp.dispatchEvent(new MouseEvent('dblclick', { clientX: c.x, clientY: c.y, bubbles: true }));
    assert.eq(I.state().zoom, 1, 'dblclick returns to 100%');
    vp.dispatchEvent(new MouseEvent('dblclick', { clientX: c.x, clientY: c.y, bubbles: true }));
    assert.eq(I.state().zoom, 2.5, 'dblclick toggles to 250%');
    var d = document.getElementById('imgpop-dialog');
    d.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    assert.eq(I.state().zoom, 1);
    d.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    assert.near(I.state().zoom, 1.25, 1e-9);
    d.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
  });

  test('dom imgpop: two-finger pinch zooms and double-tap toggles', function () {
    var vp = document.querySelector('.lyra-imgpop-viewport');
    var c = centre(vp);
    vp.dispatchEvent(pe('pointerdown', 21, c.x - 20, c.y, 'touch'));
    vp.dispatchEvent(pe('pointerdown', 22, c.x + 20, c.y, 'touch'));
    vp.dispatchEvent(pe('pointermove', 21, c.x - 60, c.y, 'touch'));
    vp.dispatchEvent(pe('pointermove', 22, c.x + 60, c.y, 'touch'));
    vp.dispatchEvent(pe('pointerup', 21, c.x - 60, c.y, 'touch'));
    vp.dispatchEvent(pe('pointerup', 22, c.x + 60, c.y, 'touch'));
    var z = I.state().zoom;
    assert.ok(z > 2.5 && z <= 8, 'pinch zoom ' + z);
    return wait(30).then(function () {
      document.getElementById('imgpop-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
      vp.dispatchEvent(pe('pointerdown', 31, c.x, c.y, 'touch'));
      vp.dispatchEvent(pe('pointerup', 31, c.x, c.y, 'touch'));
      vp.dispatchEvent(pe('pointerdown', 32, c.x + 3, c.y + 2, 'touch'));
      vp.dispatchEvent(pe('pointerup', 32, c.x + 3, c.y + 2, 'touch'));
      assert.eq(I.state().zoom, 2.5, 'double-tap toggles to 250%');
    });
  });

  test('dom imgpop: close resets zoom and returns focus; backdrop and keyboard open work', function () {
    var d = document.getElementById('imgpop-dialog');
    d.querySelector('.lyra-imgpop-close').click();
    return wait(20).then(function () {
      assert.eq(I.isOpen(), false);
      assert.eq(I.state().zoom, 1);
      assert.eq(document.activeElement, thumb, 'focus restored to the thumbnail');
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return until(function () { return I.isOpen(); });
    }).then(function () {
      d.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // target is the dialog: backdrop
      return wait(20);
    }).then(function () {
      assert.eq(I.isOpen(), false, 'backdrop click closes');
    });
  });

  // ---------------------------------------------------------------------------
  // avatar.js, lifecycle.js, store.js with real browser APIs
  // ---------------------------------------------------------------------------

  test('dom avatar: colours via CSSOM, status dot, hidden from assistive tech', function () {
    var el = stage();
    var av = A.el({ handle: 'dario', display_name: 'Dario' }, 'md', { status: 'on', consul: true });
    el.appendChild(av);
    assert.ok(av.classList.contains('avatar-md') && av.classList.contains('is-consul'));
    assert.ok(getComputedStyle(av).backgroundColor.indexOf('rgb') === 0);
    assert.eq(av.getAttribute('aria-hidden'), 'true');
    assert.ok(av.querySelector('.avatar-status.is-on'));
    assert.eq(av.getBoundingClientRect().width, 32);
  });

  test('dom lifecycle: receipts with checks and actions; live bubble caps bullets', function () {
    var el = stage();
    var calls = [];
    var base = { id: 3, conversation_id: 1, recipient: { id: 2 } };
    var rc = L.renderReceipt(Object.assign({ state: 'waiting' }, base), {}, { onCancel: function (m) { calls.push('cancel:' + m.id); } });
    el.appendChild(rc);
    assert.eq(rc.getAttribute('data-kind'), 'server');
    assert.eq(rc.querySelectorAll('.rc-checks path').length, 1);
    rc.querySelector('.rc-btn').click();
    L.updateReceipt(rc, Object.assign({ state: 'delivered', delivered_at: 1 }, base), {}, { onDetails: function (m) { calls.push('details:' + m.id); } });
    assert.eq(rc.querySelector('.rc-label').textContent, 'Agent read');
    assert.eq(rc.querySelectorAll('.rc-checks path').length, 3, 'double check');
    rc.querySelector('.rc-btn').click();
    L.updateReceipt(rc, Object.assign({ state: 'unconfirmed' }, base), {}, { onRetryDelivery: function (m) { calls.push('retry:' + m.id); } });
    rc.querySelector('.rc-btn').click();
    assert.deep(calls, ['cancel:3', 'details:3', 'retry:3']);
    var bullets = [];
    for (var i = 0; i < 9; i++) bullets.push({ text: 'Step ' + i, state: i < 5 ? 'done' : i === 5 ? 'active' : 'pending' });
    var msg = Object.assign({ state: 'delivered', delivered_at: 1,
                              progress: { phase: 'working', summary: 'Auditing routes', bullets: bullets } }, base);
    var live = L.renderLive(msg, { now: 76 });
    el.appendChild(live);
    assert.eq(live.getAttribute('data-phase'), 'working');
    assert.eq(live.querySelectorAll('.work-bullet').length, 6);
    assert.ok(live.querySelector('.work-bullet.is-active'));
    assert.eq(live.querySelector('.live-timer').textContent, '1:15');
    assert.ok(live.querySelector('.thinking-dots'));
    L.updateLive(live, msg, { replied: true });
    assert.eq(live.hidden, true);
  });

  test('dom brand: gold logo and provider marks are inline SVG', function () {
    var el = stage();
    var logo = window.LyraBrand.logo(28);
    el.appendChild(logo);
    assert.eq(logo.tagName.toLowerCase(), 'svg');
    assert.eq(logo.querySelectorAll('circle').length, 5);
    assert.eq(logo.querySelector('circle').getAttribute('fill'), '#facc15');
    assert.eq(logo.getAttribute('aria-hidden'), 'true');
    var a = window.LyraBrand.provider('anthropic', 16);
    el.appendChild(a);
    assert.eq(a.getAttribute('aria-label'), 'Anthropic');
    assert.ok(a.querySelector('svg path').getAttribute('d').length > 50);
    var other = window.LyraBrand.provider('acme', 16, { title: null });
    assert.ok(other.classList.contains('prov-other'));
    assert.eq(other.getAttribute('aria-hidden'), 'true');
  });

  test('dom avatar: image avatars crop to the circle and fall back on error', function () {
    var el = stage();
    var av = A.el({ handle: 'gem', display_name: 'Gem', avatar: { image: '/static/avatars/gem.png', icon: 'gem' } }, 'md');
    el.appendChild(av);
    var img = av.querySelector('img.avatar-img');
    assert.ok(img && av.classList.contains('has-image'));
    assert.eq(getComputedStyle(img).borderRadius, '50%');
    img.dispatchEvent(new Event('error'));
    assert.eq(av.querySelector('img'), null, 'broken image is removed');
    assert.ok(!av.classList.contains('has-image'));
    assert.eq(av.querySelector('.avatar-text').textContent, '\u25c6', 'falls back to the icon');
    assert.ok(av.style.backgroundColor !== '');
  });

  test('dom store: drafts persist in real localStorage across instances', function () {
    var a = S.create(undefined, { namespace: 'test' });
    var key = a.drafts.key({ convId: 77 });
    a.drafts.save(key, { text: 'keep me', replyToId: 5 });
    var b = S.create(undefined, { namespace: 'test' });
    assert.eq(b.drafts.load(key).text, 'keep me');
    b.drafts.clear(key);
    assert.eq(a.drafts.load(key), null);
  });
})();
