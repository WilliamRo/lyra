// Browser entry: runs every registered test and writes JSON into #lyra-result.
(function () {
  window.addEventListener('load', function () {
    window.runTests().then(function (r) {
      r.csp = window.__lyraCsp || [];
      r.userAgent = navigator.userAgent;
      document.getElementById('lyra-result').textContent = JSON.stringify(r);
      document.title = 'LYRA_DONE';
    });
  });
})();
