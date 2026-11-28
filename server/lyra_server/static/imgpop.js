// Lyra imgpop.js: zoom-and-pan image viewer in a native <dialog> (zero dependencies).
//
//   LyraImgPop.bind(root)            delegate clicks / Enter / Space on thumbnails
//   LyraImgPop.enhance(img)          mark one thumbnail as an accessible zoom trigger
//   LyraImgPop.open(src, options)    { alt, href, trigger }
//   LyraImgPop.close()
//
// Zoom runs from 100% (image fitted to the frame) to 800%. Wheel zoom is anchored at the
// cursor, drag pans when zoomed, double-click or double-tap toggles 100% / 250% at the
// pointer, two-finger pinch zooms around the midpoint, and "1:1" resets to the fit.
// Geometry lives in pure functions (LyraImgPop.math) so it can be tested without a DOM.
(function (root) {
  'use strict';

  var MIN = 1;
  var MAX = 8;
  var DOUBLE_ZOOM = 2.5;
  var WHEEL_K = 0.0018;
  var KEY_STEP = 1.25;
  var PAN_STEP = 48;
  var TAP_MS = 300;
  var TAP_SLOP = 24;
  var DRAG_SLOP = 4;
  var THUMBS = '.image-strip img, .staged-image img, img[data-imgpop]';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ===========================================================================
  // Pure geometry
  // ===========================================================================

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Fit so the image fills the frame on one axis (the 100% state).
  function fit(natW, natH, vpW, vpH) {
    if (!(natW > 0 && natH > 0 && vpW > 0 && vpH > 0)) return { w: 0, h: 0, factor: 1 };
    var f = Math.min(vpW / natW, vpH / natH);
    return { w: natW * f, h: natH * f, factor: f };
  }

  function clampPan(pan, base, vp, zoom) {
    var m = Math.max(0, (base * zoom - vp) / 2);
    return clamp(pan, -m, m);
  }

  // Zoom to `next`, keeping the image point under (px, py) fixed. Points are relative to
  // the viewport centre, which is also the image centre at pan (0, 0).
  function zoomAt(st, next, px, py) {
    var z = clamp(next, MIN, MAX);
    var r = z / st.zoom;
    var out = copy(st);
    out.zoom = z;
    out.panX = clampPan(px - (px - st.panX) * r, st.baseW, st.vpW, z);
    out.panY = clampPan(py - (py - st.panY) * r, st.baseH, st.vpH, z);
    return out;
  }

  function panBy(st, dx, dy) {
    var out = copy(st);
    out.panX = clampPan(st.panX + dx, st.baseW, st.vpW, st.zoom);
    out.panY = clampPan(st.panY + dy, st.baseH, st.vpH, st.zoom);
    return out;
  }

  function wheelDelta(ev) {
    var d = ev.deltaY || 0;
    if (ev.deltaMode === 1) d *= 16;
    else if (ev.deltaMode === 2) d *= 240;
    return d;
  }

  function wheelZoom(zoom, delta) { return clamp(zoom * Math.exp(-delta * WHEEL_K), MIN, MAX); }

  function toggleTarget(zoom) { return zoom > 1.001 ? MIN : DOUBLE_ZOOM; }

  function copy(st) {
    return { zoom: st.zoom, panX: st.panX, panY: st.panY, baseW: st.baseW, baseH: st.baseH,
             vpW: st.vpW, vpH: st.vpH };
  }

  function initial() { return { zoom: 1, panX: 0, panY: 0, baseW: 0, baseH: 0, vpW: 0, vpH: 0 }; }

  var math = { MIN: MIN, MAX: MAX, DOUBLE_ZOOM: DOUBLE_ZOOM, clamp: clamp, fit: fit,
               clampPan: clampPan, zoomAt: zoomAt, panBy: panBy, wheelDelta: wheelDelta,
               wheelZoom: wheelZoom, toggleTarget: toggleTarget, initial: initial };

  // ===========================================================================
  // DOM viewer (singleton dialog, built on first use)
  // ===========================================================================

  var ui = null;
  var st = initial();
  var pointers = new Map();
  var gesture = null;
  var lastTap = null;
  var justDragged = false;
  var trigger = null;
  var natural = { w: 0, h: 0 };
  var touchToggleAt = 0;          // browsers may also fire dblclick after a double-tap

  function icon(doc, d) {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function build(doc) {
    var dialog = doc.createElement('dialog');
    dialog.id = 'imgpop-dialog';
    dialog.className = 'lyra-imgpop-dialog';
    dialog.setAttribute('aria-label', 'Image viewer');

    var frame = doc.createElement('div');
    frame.className = 'lyra-imgpop-frame';
    var viewport = doc.createElement('div');
    viewport.className = 'lyra-imgpop-viewport';
    var img = doc.createElement('img');
    img.className = 'lyra-imgpop-img';
    img.setAttribute('alt', '');
    img.setAttribute('draggable', 'false');
    img.setAttribute('decoding', 'async');
    var error = doc.createElement('p');
    error.className = 'lyra-imgpop-error';
    error.hidden = true;
    error.textContent = 'This image could not be loaded.';
    viewport.appendChild(img);
    viewport.appendChild(error);

    var bar = doc.createElement('div');
    bar.className = 'lyra-imgpop-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Image controls');
    var readout = doc.createElement('output');
    readout.className = 'lyra-imgpop-zoom';
    readout.textContent = '100%';
    var reset = doc.createElement('button');
    reset.type = 'button';
    reset.className = 'lyra-imgpop-btn lyra-imgpop-reset';
    reset.textContent = '1:1';
    reset.setAttribute('aria-label', 'Reset zoom to fit');
    reset.title = 'Reset zoom (0)';
    var open = doc.createElement('a');
    open.className = 'lyra-imgpop-btn';
    open.setAttribute('target', '_blank');
    open.setAttribute('rel', 'noopener noreferrer');
    open.setAttribute('aria-label', 'Open original image');
    open.title = 'Open original image';
    open.appendChild(icon(doc, 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'));
    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'lyra-imgpop-btn lyra-imgpop-close';
    close.setAttribute('aria-label', 'Close image viewer');
    close.title = 'Close (Esc)';
    close.appendChild(icon(doc, 'M6 6l12 12M18 6L6 18'));
    bar.appendChild(readout);
    bar.appendChild(reset);
    bar.appendChild(open);
    bar.appendChild(close);

    frame.appendChild(viewport);
    frame.appendChild(bar);
    dialog.appendChild(frame);
    doc.body.appendChild(dialog);

    ui = { doc: doc, dialog: dialog, viewport: viewport, img: img, error: error, readout: readout,
           reset: reset, open: open, close: close };

    reset.addEventListener('click', function () { setState(zoomAt(st, MIN, 0, 0)); });
    close.addEventListener('click', function () { closeViewer(); });
    dialog.addEventListener('click', function (ev) {
      if (ev.target === dialog && !justDragged) closeViewer();
    });
    dialog.addEventListener('close', onClosed);
    dialog.addEventListener('keydown', onKey);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('dblclick', onDblClick);
    img.addEventListener('load', function () {
      natural = { w: img.naturalWidth, h: img.naturalHeight };
      ui.error.hidden = true;
      relayout(true);
    });
    img.addEventListener('error', function () { ui.error.hidden = false; });
    var win = doc.defaultView || root;
    if (typeof win.ResizeObserver === 'function') {
      new win.ResizeObserver(function () { if (dialog.open) relayout(false); }).observe(viewport);
    } else {
      win.addEventListener('resize', function () { if (dialog.open) relayout(false); });
    }
    return ui;
  }

  function ensure(doc) { return ui && ui.doc === doc && ui.dialog.isConnected ? ui : build(doc); }

  function relayout(resetZoom) {
    var vw = ui.viewport.clientWidth;
    var vh = ui.viewport.clientHeight;
    var f = fit(natural.w, natural.h, vw, vh);
    var next = resetZoom ? initial() : copy(st);
    next.baseW = f.w; next.baseH = f.h; next.vpW = vw; next.vpH = vh;
    next.panX = clampPan(next.panX, next.baseW, vw, next.zoom);
    next.panY = clampPan(next.panY, next.baseH, vh, next.zoom);
    setState(next);
  }

  function setState(next) {
    st = next;
    if (!ui) return;
    var img = ui.img;
    if (st.baseW > 0) {
      img.style.width = st.baseW + 'px';
      img.style.height = st.baseH + 'px';
    }
    img.style.transform = 'translate3d(' + st.panX.toFixed(2) + 'px, ' + st.panY.toFixed(2) + 'px, 0) scale(' +
      st.zoom.toFixed(4) + ')';
    var pct = Math.round(st.zoom * 100) + '%';
    ui.readout.textContent = pct;
    ui.readout.setAttribute('aria-label', 'Zoom ' + pct);
    ui.reset.disabled = st.zoom <= 1.001;
    ui.viewport.classList.toggle('is-zoomed', st.zoom > 1.001);
  }

  function centrePoint(ev) {
    var r = ui.viewport.getBoundingClientRect();
    return { x: ev.clientX - (r.left + r.width / 2), y: ev.clientY - (r.top + r.height / 2) };
  }

  function onWheel(ev) {
    ev.preventDefault();
    var p = centrePoint(ev);
    setState(zoomAt(st, wheelZoom(st.zoom, wheelDelta(ev)), p.x, p.y));
  }

  function onDblClick(ev) {
    if (ev.pointerType === 'touch' || Date.now() - touchToggleAt < 600) return;
    var p = centrePoint(ev);
    setState(zoomAt(st, toggleTarget(st.zoom), p.x, p.y));
  }

  function pinchInfo() {
    var pts = Array.from(pointers.values());
    var dx = pts[1].x - pts[0].x;
    var dy = pts[1].y - pts[0].y;
    return { dist: Math.hypot(dx, dy) || 1, mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } };
  }

  function onPointerDown(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try { ui.viewport.setPointerCapture(ev.pointerId); } catch (_e) { /* synthetic or lost pointer */ }
    justDragged = false;
    if (pointers.size === 1) {
      gesture = { kind: 'drag', x: ev.clientX, y: ev.clientY, panX: st.panX, panY: st.panY, moved: 0,
                  t: Date.now(), touch: ev.pointerType !== 'mouse' };
      ui.viewport.classList.toggle('is-dragging', st.zoom > 1.001);
    } else if (pointers.size === 2) {
      var info = pinchInfo();
      gesture = { kind: 'pinch', dist: info.dist, mid: info.mid, moved: 99 };
    }
  }

  function onPointerMove(ev) {
    if (!pointers.has(ev.pointerId) || !gesture) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      var info = pinchInfo();
      var r = ui.viewport.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var next = zoomAt(st, st.zoom * (info.dist / gesture.dist), info.mid.x - cx, info.mid.y - cy);
      next = panBy(next, info.mid.x - gesture.mid.x, info.mid.y - gesture.mid.y);
      gesture.dist = info.dist;
      gesture.mid = info.mid;
      justDragged = true;
      setState(next);
      return;
    }
    if (gesture.kind === 'drag') {
      var dx = ev.clientX - gesture.x;
      var dy = ev.clientY - gesture.y;
      gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
      if (gesture.moved > DRAG_SLOP) justDragged = true;
      if (st.zoom > 1.001) {
        var out = copy(st);
        out.panX = clampPan(gesture.panX + dx, st.baseW, st.vpW, st.zoom);
        out.panY = clampPan(gesture.panY + dy, st.baseH, st.vpH, st.zoom);
        setState(out);
      }
    }
  }

  function onPointerUp(ev) {
    if (!pointers.has(ev.pointerId)) return;
    var wasTap = gesture && gesture.kind === 'drag' && gesture.touch && gesture.moved <= DRAG_SLOP &&
      Date.now() - gesture.t < TAP_MS;
    pointers.delete(ev.pointerId);
    try { ui.viewport.releasePointerCapture(ev.pointerId); } catch (_e) { /* already released */ }
    ui.viewport.classList.remove('is-dragging');
    if (wasTap) {
      var now = Date.now();
      if (lastTap && now - lastTap.t <= TAP_MS &&
          Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) <= TAP_SLOP) {
        var p = centrePoint(ev);
        setState(zoomAt(st, toggleTarget(st.zoom), p.x, p.y));
        lastTap = null;
        touchToggleAt = now;
      } else {
        lastTap = { t: now, x: ev.clientX, y: ev.clientY };
      }
    }
    if (pointers.size === 1) {
      // Pinch ended with one finger still down: continue as a drag from here.
      var rest = Array.from(pointers.values())[0];
      gesture = { kind: 'drag', x: rest.x, y: rest.y, panX: st.panX, panY: st.panY, moved: 99, t: 0, touch: true };
    } else if (pointers.size === 0) {
      gesture = null;
      // Let the click that follows a drag pass without closing the dialog.
      (ui.doc.defaultView || root).setTimeout(function () { justDragged = false; }, 0);
    }
  }

  function onKey(ev) {
    var handled = true;
    switch (ev.key) {
      case '+': case '=': setState(zoomAt(st, st.zoom * KEY_STEP, 0, 0)); break;
      case '-': case '_': setState(zoomAt(st, st.zoom / KEY_STEP, 0, 0)); break;
      case '0': setState(zoomAt(st, MIN, 0, 0)); break;
      case 'ArrowLeft': setState(panBy(st, PAN_STEP, 0)); break;
      case 'ArrowRight': setState(panBy(st, -PAN_STEP, 0)); break;
      case 'ArrowUp': setState(panBy(st, 0, PAN_STEP)); break;
      case 'ArrowDown': setState(panBy(st, 0, -PAN_STEP)); break;
      default: handled = false;
    }
    if (handled) ev.preventDefault();
  }

  function onClosed() {
    pointers.clear();
    gesture = null;
    lastTap = null;
    justDragged = false;
    st = initial();
    if (ui) {
      ui.img.removeAttribute('src');
      ui.img.style.transform = '';
      ui.viewport.classList.remove('is-zoomed', 'is-dragging');
    }
    var t = trigger;
    trigger = null;
    if (t && t.isConnected && typeof t.focus === 'function') t.focus();
  }

  function safeHref(href) {
    var s = String(href || '');
    return /^(https?:\/\/|\/(?!\/))/i.test(s) ? s : null;
  }

  function open(src, options) {
    var o = options || {};
    var doc = o.document || (o.trigger && o.trigger.ownerDocument) || root.document;
    var u = ensure(doc);
    trigger = o.trigger || null;
    natural = { w: 0, h: 0 };
    st = initial();
    u.error.hidden = true;
    u.img.setAttribute('alt', o.alt || '');
    var href = safeHref(o.href || src);
    if (href) { u.open.setAttribute('href', href); u.open.hidden = false; }
    else { u.open.removeAttribute('href'); u.open.hidden = true; }
    if (typeof u.dialog.showModal !== 'function') {
      if (href) (doc.defaultView || root).open(href, '_blank', 'noopener');
      return false;
    }
    if (!u.dialog.open) u.dialog.showModal();
    setState(st);
    u.img.setAttribute('src', src);
    if (u.img.complete && u.img.naturalWidth) {
      natural = { w: u.img.naturalWidth, h: u.img.naturalHeight };
      relayout(true);
    }
    u.close.focus();
    return true;
  }

  function closeViewer() {
    if (!ui || !ui.dialog.open) return;
    ui.dialog.close();
    onClosed();        // reset now; the async 'close' event repeats it harmlessly
  }

  function enhance(img) {
    if (!img || img.dataset.imgpopReady) return img;
    img.dataset.imgpopReady = '1';
    img.classList.add('lyra-imgpop-thumb');
    img.setAttribute('tabindex', '0');
    img.setAttribute('role', 'button');
    img.setAttribute('aria-haspopup', 'dialog');
    if (!img.getAttribute('aria-label')) {
      img.setAttribute('aria-label', 'Open image' + (img.alt ? ': ' + img.alt : ''));
    }
    return img;
  }

  function openFromThumb(img, ev) {
    var link = img.closest('a');
    if (ev) ev.preventDefault();
    open(img.currentSrc || img.src, { alt: img.alt, href: link ? link.href : img.src, trigger: img });
  }

  function bind(container, selector) {
    var rootEl = container || root.document;
    var sel = selector || THUMBS;
    Array.prototype.forEach.call(rootEl.querySelectorAll(sel), enhance);
    rootEl.addEventListener('click', function (ev) {
      var img = ev.target && ev.target.closest ? ev.target.closest(sel) : null;
      if (!img || !rootEl.contains(img)) return;
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;  // keep open-in-new-tab
      enhance(img);
      openFromThumb(img, ev);
    });
    rootEl.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var img = ev.target && ev.target.matches && ev.target.matches(sel) ? ev.target : null;
      if (!img) return;
      openFromThumb(img, ev);
    });
    return rootEl;
  }

  root.LyraImgPop = {
    version: '2.0.0',
    math: math,
    open: open,
    close: closeViewer,
    bind: bind,
    enhance: enhance,
    isOpen: function () { return !!(ui && ui.dialog.open); },
    state: function () { return copy(st); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
