// Loaded first: records CSP violations so the browser run can report them.
(function () {
  window.__lyraCsp = [];
  document.addEventListener('securitypolicyviolation', function (ev) {
    window.__lyraCsp.push({ directive: ev.violatedDirective || ev.effectiveDirective, source: ev.sourceFile || '',
                            sample: (ev.sample || '').slice(0, 60) });
  });
})();
