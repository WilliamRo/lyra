// Lyra avatar.js: deterministic, contrast-checked agent avatars (zero dependencies).
//
//   LyraAvatar.spec(principal)                -> { bg, fg, text, custom }
//   LyraAvatar.el(principal, size, options)   -> <span class="avatar avatar-md"> (DOM)
//   LyraAvatar.contrast('#ffffff', '#3730a3') -> WCAG contrast ratio
// principal.avatar follows the server (schema v4): a preset string (an icon token such as
// "star", a short emoji, or initials) or an object { icon, color } where color is a hex value
// or a palette name. The older { bg, fg } form is also accepted. Colours are validated and
// applied through the CSSOM, never as markup.
(function (root) {
  'use strict';

  // Ten hues that each keep at least 4.5:1 contrast with white text.
  var PALETTE = [
    { name: 'indigo', bg: '#3f37c9' },
    { name: 'teal', bg: '#0f6e66' },
    { name: 'crimson', bg: '#b4233c' },
    { name: 'emerald', bg: '#08704f' },
    { name: 'cobalt', bg: '#1d4fd8' },
    { name: 'plum', bg: '#7b2cbf' },
    { name: 'umber', bg: '#8a4b08' },
    { name: 'slate', bg: '#475569' },
    { name: 'rose', bg: '#be185d' },
    { name: 'petrol', bg: '#0b6584' },
  ];
  var ICONS = { spark: '✦', star: '★', moon: '☾', sun: '☀', bolt: 'ϟ',
                gem: '◆', orbit: '◎', leaf: '❦', wave: '∿', key: '⚷' };
  var SIZES = { xs: 'avatar-xs', sm: 'avatar-sm', md: 'avatar-md', lg: 'avatar-lg' };
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;
  var NAMED = { red: '#b4233c', orange: '#a23d05', amber: '#8a4b08', yellow: '#ffd60a', gold: '#c98a12',
                green: '#08704f', blue: '#1d4fd8', navy: '#1e2f6b', purple: '#7b2cbf', pink: '#be185d',
                gray: '#475569', grey: '#475569', black: '#0f1626', white: '#ffffff' };
  var INK = '#0f1626';

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function channel(c) {
    var v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  }

  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    var hi = Math.max(la, lb);
    var lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  // One letter per word, at most two; the first code point keeps CJK and emoji intact.
  function initials(name, handle) {
    var src = String(name || '').trim() || String(handle || '').replace(/^@/, '').trim();
    if (!src) return '?';
    var words = src.split(/[\s._-]+/).filter(function (w) { return /[\p{L}\p{N}]/u.test(w); });
    if (!words.length) return Array.from(src)[0].toUpperCase();
    var first = Array.from(words[0]).find(function (ch) { return /[\p{L}\p{N}]/u.test(ch); }) || '';
    if (words.length === 1) return first.toUpperCase();
    var last = Array.from(words[words.length - 1]).find(function (ch) { return /[\p{L}\p{N}]/u.test(ch); }) || '';
    return (first + last).toUpperCase();
  }

  function pick(principal) {
    var key = String((principal && (principal.handle || principal.id)) || '?');
    return PALETTE[fnv1a(key) % PALETTE.length];
  }

  // '#abc', '#abcd', '#aabbcc', '#aabbccdd' or a palette / basic colour name -> '#aabbcc'.
  function color(value) {
    var v = String(value || '').trim().toLowerCase();
    if (/^#[0-9a-f]{3,4}$/.test(v)) return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v)) return v.slice(0, 7);
    for (var i = 0; i < PALETTE.length; i++) if (PALETTE[i].name === v) return PALETTE[i].bg;
    return Object.prototype.hasOwnProperty.call(NAMED, v) ? NAMED[v] : null;
  }

  function glyph(icon) {
    var t = String(icon || '').trim();
    if (!t || t === 'initials') return null;
    if (Object.prototype.hasOwnProperty.call(ICONS, t.toLowerCase())) return ICONS[t.toLowerCase()];
    var chars = Array.from(t);
    if (chars.length <= 2 && !/[<>=$]/.test(t)) return /^[a-z]+$/i.test(t) ? t.toUpperCase() : t;
    if (/\p{Extended_Pictographic}/u.test(t) && t.length <= 16) return t;   // emoji with joiners
    return null;
  }

  function spec(principal) {
    var p = principal || {};
    var base = pick(p);
    var bg = base.bg;
    var fg = '#ffffff';
    var custom = false;
    var a = p.avatar;
    if (typeof a === 'string') a = { icon: a };
    if (!a || typeof a !== 'object') a = null;
    var c = a ? color(a.color || a.bg) : null;
    if (c) {
      bg = c;
      custom = true;
      if (HEX_RE.test(a.fg || '') && contrast(a.fg, bg) >= 4.5) fg = a.fg.toLowerCase();
      else fg = contrast('#ffffff', bg) >= contrast(INK, bg) ? '#ffffff' : INK;
    }
    var text = initials(p.display_name, p.handle);
    var g = a ? glyph(a.icon) : null;
    if (g) { text = g; custom = true; }
    return { bg: bg, fg: fg, text: text, custom: custom, hue: c ? null : base.name };
  }

  function el(principal, size, options) {
    var o = options || {};
    var doc = o.document || root.document;
    var s = spec(principal);
    var n = doc.createElement('span');
    n.className = 'avatar ' + (SIZES[size] || SIZES.md);
    if (o.consul) n.classList.add('is-consul');
    n.style.backgroundColor = s.bg;
    n.style.color = s.fg;
    var label = doc.createElement('span');
    label.className = 'avatar-text';
    label.textContent = s.text;
    n.appendChild(label);
    if (o.status === 'on' || o.status === 'off') {
      var dot = doc.createElement('span');
      dot.className = 'avatar-status ' + (o.status === 'on' ? 'is-on' : 'is-off');
      n.appendChild(dot);
    }
    if (o.label) {
      n.setAttribute('role', 'img');
      n.setAttribute('aria-label', o.label);
    } else {
      n.setAttribute('aria-hidden', 'true');
    }
    return n;
  }

  // Overlapping pair for agent-to-agent threads.
  function stack(principals, size, options) {
    var o = options || {};
    var doc = o.document || root.document;
    var wrap = doc.createElement('span');
    wrap.className = 'avatar-stack';
    wrap.setAttribute('aria-hidden', 'true');
    (principals || []).slice(0, 2).forEach(function (p) { wrap.appendChild(el(p, size || 'xs', { document: doc })); });
    return wrap;
  }

  root.LyraAvatar = {
    version: '2.0.0',
    PALETTE: PALETTE.map(function (p) { return Object.assign({}, p); }),
    ICONS: Object.assign({}, ICONS),
    spec: spec,
    el: el,
    stack: stack,
    initials: initials,
    contrast: contrast,
    color: color,
    hash: fnv1a,
  };
})(typeof window !== 'undefined' ? window : globalThis);
