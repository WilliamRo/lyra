// CSP probe (tests only): served with the live Lyra CSP header. Renders KaTeX through markdown.js,
// then tries each unsafe vector and reports what ran plus the recorded CSP violations.
(function () {
  'use strict';
  window.__probe = { inlineScript: false, handler: false, evalRan: false, dataScript: false };

  function finish(r) {
    var out = document.createElement('pre');
    out.id = 'lyra-result';
    out.textContent = JSON.stringify(r);
    document.body.appendChild(out);
    document.title = 'LYRA_DONE';
  }

  window.addEventListener('load', function () {
    var r = { flags: {}, csp: [] };

    // i. KaTeX through markdown.js: needs inline style attributes only.
    var math = document.getElementById('math');
    window.LyraMarkdown.renderInto(math, 'Inline $x_i^2 + \\frac{a}{b}$ and display\n\n$$\\sum_{i=1}^{n} x_i$$');
    var strut = math.querySelector('.katex .strut');
    r.flags.katexRendered = !!math.querySelector('.katex-html') && !math.querySelector('.katex-error');
    r.flags.katexStyleApplied = !!strut && strut.style.height !== '' && strut.getBoundingClientRect().height > 0;

    // ii. A style attribute set by script is allowed (style-src-attr 'unsafe-inline').
    var styled = document.getElementById('styled');
    styled.setAttribute('style', 'outline: 3px solid rgb(1, 2, 3)');
    r.flags.styleAttrApplied = getComputedStyle(styled).outlineColor === 'rgb(1, 2, 3)';

    // iii. A <style> element is blocked (style-src-elem 'self').
    var st = document.createElement('style');
    st.textContent = '#styled { color: rgb(4, 5, 6) !important; }';
    document.head.appendChild(st);
    r.flags.styleElemApplied = getComputedStyle(styled).color === 'rgb(4, 5, 6)';

    // iv. An inline <script> is blocked (script-src 'self').
    var s = document.createElement('script');
    s.textContent = 'window.__probe.inlineScript = true;';
    document.head.appendChild(s);

    // v. An inline event handler attribute is blocked.
    var img = document.createElement('img');
    img.setAttribute('onerror', 'window.__probe.handler = true');
    img.src = 'data:image/png;base64,broken';
    document.body.appendChild(img);

    // vi. eval and a data: script are blocked.
    try { (0, eval)('window.__probe.evalRan = true'); } catch (_e) { /* EvalError under CSP */ }
    var ds = document.createElement('script');
    ds.src = 'data:text/javascript,window.__probe.dataScript=true';
    document.head.appendChild(ds);

    setTimeout(function () {
      r.flags.inlineScript = window.__probe.inlineScript;
      r.flags.handler = window.__probe.handler;
      r.flags.evalRan = window.__probe.evalRan;
      r.flags.dataScript = window.__probe.dataScript;
      r.csp = window.__lyraCsp || [];
      finish(r);
    }, 400);
  });
})();
