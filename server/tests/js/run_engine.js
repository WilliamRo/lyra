// Entry point for engine-only runs (JavaScriptCore `jsc` or Node via run_node.js).
// Prints one line: LYRA_JS_RESULT {"total":..,"failed":..,"results":[..]}
(function (g) {
  var out = typeof g.__lyraPrint === 'function' ? g.__lyraPrint : (typeof print === 'function' ? print : console.log);
  var done = false;
  g.runTests().then(function (r) {
    done = true;
    out('LYRA_JS_RESULT ' + JSON.stringify(r));
  }, function (e) {
    done = true;
    out('LYRA_JS_RESULT ' + JSON.stringify({ total: 0, failed: 1, results: [{ name: 'runner', ok: false, error: String(e) }] }));
  });
  if (typeof drainMicrotasks === 'function') drainMicrotasks();     // jsc
  if (!done && typeof g.__lyraPrint !== 'function' && typeof drainMicrotasks === 'function') {
    out('LYRA_JS_RESULT ' + JSON.stringify({ total: 0, failed: 1, results: [{ name: 'runner', ok: false, error: 'tests did not settle' }] }));
  }
})(globalThis);
