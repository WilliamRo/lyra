// Lyra brand.js: the Lyra constellation mark, provider marks and theme bootstrapping.
// Loaded without defer in <head> so a stored theme applies before first paint.
//
//   LyraBrand.logo(size, {document, title})        -> <svg class="lyra-logo">
//   LyraBrand.provider(key, size, {document, title}) -> <span class="prov prov-<key>"> with an inline mark
//   LyraBrand.providerName(key)                    -> "Anthropic", "OpenAI", ...
//   LyraBrand.applyTheme('dark' | 'light' | null)  -> effective theme; null follows the system
// Provider marks are the brands' own single-path glyphs, inlined as SVG data (no external URLs):
// Anthropic, Google, Google Gemini and Moonshot AI from Simple Icons (CC0-1.0), OpenAI from
// LobeHub lobe-icons (MIT). They identify the provider an account belongs to.
(function (root) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var GOLD = '#facc15';
  var VIEW_KEY = 'lyra.ui.v2.state';

  var MARKS = {
    anthropic: { name: 'Anthropic', color: '#d97757', d: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" },
    openai: { name: 'OpenAI', color: null, d: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z", evenodd: true },
    google: { name: 'Google', color: '#4285f4', d: "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" },
    gemini: { name: 'Google Gemini', color: '#4285f4', d: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" },
    moonshot: { name: 'Moonshot AI', color: null, d: "m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866" },
  };
  var ALIASES = { claude: 'anthropic', 'openai-codex': 'openai', codex: 'openai', chatgpt: 'openai',
                  'google-gemini': 'gemini', kimi: 'moonshot', moonshotai: 'moonshot' };
  var NAMES = { deepseek: 'DeepSeek', xai: 'xAI', mistral: 'Mistral', lyra: 'Lyra', other: 'Other' };
  // Fallback for providers without a mark: a neutral hexagon with a core.
  var FALLBACK = 'M12 2.5l8.25 4.75v9.5L12 21.5l-8.25-4.75v-9.5L12 2.5zm0 6.25a3.25 3.25 0 100 6.5 3.25 3.25 0 000-6.5z';

  function key(name) {
    var k = String(name || '').trim().toLowerCase();
    return MARKS[k] ? k : (ALIASES[k] || k || 'other');
  }

  function providerName(name) {
    var k = key(name);
    if (MARKS[k]) return MARKS[k].name;
    if (NAMES[k]) return NAMES[k];
    var s = String(name || 'Other');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function svg(doc, viewBox, size) {
    var el = doc.createElementNS(SVG_NS, 'svg');
    el.setAttribute('viewBox', viewBox);
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
    el.setAttribute('focusable', 'false');
    return el;
  }

  function path(doc, d, attrs) {
    var p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) p.setAttribute(k, attrs[k]);
    return p;
  }

  function label(el, title) {
    if (title) {
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', title);
    } else {
      el.setAttribute('aria-hidden', 'true');
    }
    return el;
  }

  function provider(name, size, options) {
    var o = options || {};
    var doc = o.document || root.document;
    var k = key(name);
    var mark = MARKS[k];
    var wrap = doc.createElement('span');
    wrap.className = 'prov prov-' + (mark ? k : 'other');
    var el = svg(doc, '0 0 24 24', size || 16);
    var attrs = { fill: 'currentColor' };
    if (mark && mark.evenodd) attrs['fill-rule'] = 'evenodd';
    el.appendChild(path(doc, mark ? mark.d : FALLBACK, mark ? attrs : { fill: 'currentColor', 'fill-rule': 'evenodd' }));
    el.setAttribute('aria-hidden', 'true');
    wrap.appendChild(el);
    if (mark && mark.color) wrap.style.color = mark.color;
    label(wrap, o.title === undefined ? providerName(name) : o.title);
    return wrap;
  }

  // The Lyra constellation: Vega as a four-point star, then zeta, delta, gamma and beta.
  function logo(size, options) {
    var o = options || {};
    var doc = o.document || root.document;
    var el = svg(doc, '0 0 32 32', size || 28);
    el.setAttribute('class', 'lyra-logo');
    var tile = doc.createElementNS(SVG_NS, 'rect');
    tile.setAttribute('x', '.5'); tile.setAttribute('y', '.5');
    tile.setAttribute('width', '31'); tile.setAttribute('height', '31'); tile.setAttribute('rx', '7.5');
    tile.setAttribute('fill', '#121316');
    tile.setAttribute('stroke', 'rgba(250, 204, 21, .28)');   // a faint gold rim separates it from dark bars
    tile.setAttribute('stroke-width', '1');
    el.appendChild(tile);
    var stroke = { fill: 'none', stroke: GOLD, 'stroke-width': '1.4', 'stroke-linecap': 'round',
                   'stroke-linejoin': 'round', 'stroke-opacity': '.7' };
    el.appendChild(path(doc, 'M10.5 9.5L14.6 13.4M13.6 8.2L14.6 13.4M14.6 13.4L22.4 11.8L24.6 23.6L17.2 25.4Z', stroke));
    el.appendChild(path(doc, 'M9.2 2.8Q9.2 7.6 14 7.6Q9.2 7.6 9.2 12.4Q9.2 7.6 4.4 7.6Q9.2 7.6 9.2 2.8Z', { fill: GOLD }));
    [[13.6, 8.2, 1.25], [14.6, 13.4, 1.7], [22.4, 11.8, 1.7], [24.6, 23.6, 1.95], [17.2, 25.4, 1.95]].forEach(function (s) {
      var c = doc.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(s[0])); c.setAttribute('cy', String(s[1])); c.setAttribute('r', String(s[2]));
      c.setAttribute('fill', GOLD);
      el.appendChild(c);
    });
    return label(el, o.title === undefined ? null : o.title);
  }

  function systemTheme() {
    try { return root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (_e) { return 'light'; }
  }

  var THEME_COLORS = { light: '#eef0f3', dark: '#18191c' };   // the topbar color of each theme

  function applyTheme(theme) {
    var doc = root.document;
    var html = doc && doc.documentElement;
    var t = theme === 'dark' || theme === 'light' ? theme : null;
    if (html) {
      if (t) html.setAttribute('data-theme', t); else html.removeAttribute('data-theme');
      // Browser chrome follows the board: a pinned theme colors both meta tags, none restores the defaults.
      var metas = doc.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) {
        var media = metas[i].getAttribute('media') || '';
        var natural = media.indexOf('dark') !== -1 ? 'dark' : 'light';
        metas[i].setAttribute('content', THEME_COLORS[t || natural]);
      }
    }
    return t || systemTheme();
  }

  function storedTheme() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(VIEW_KEY);
      var v = raw ? JSON.parse(raw) : null;
      return v && (v.theme === 'dark' || v.theme === 'light') ? v.theme : null;
    } catch (_e) { return null; }
  }

  root.LyraBrand = {
    version: '1.0.0',
    GOLD: GOLD,
    PROVIDERS: Object.keys(MARKS),
    key: key,
    logo: logo,
    provider: provider,
    providerName: providerName,
    applyTheme: applyTheme,
    THEME_COLORS: THEME_COLORS,
    systemTheme: systemTheme,
    storedTheme: storedTheme,
  };

  if (root.document && root.document.documentElement) applyTheme(storedTheme());
})(typeof window !== 'undefined' ? window : globalThis);
