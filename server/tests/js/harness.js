// Minimal test harness shared by the engine runner (jsc / node) and the browser page.
(function (g) {
  'use strict';
  var cases = [];

  function fmt(v) {
    try { return JSON.stringify(v); } catch (_e) { return String(v); }
  }

  function AssertionError(msg) { this.message = msg; this.name = 'AssertionError'; }
  AssertionError.prototype = Object.create(Error.prototype);

  var assert = {
    ok: function (v, msg) { if (!v) throw new AssertionError(msg || 'expected truthy, got ' + fmt(v)); },
    eq: function (a, b, msg) {
      if (a !== b) throw new AssertionError((msg ? msg + ': ' : '') + 'expected ' + fmt(b) + ', got ' + fmt(a));
    },
    near: function (a, b, eps, msg) {
      if (!(Math.abs(a - b) <= (eps || 1e-6))) {
        throw new AssertionError((msg ? msg + ': ' : '') + 'expected ~' + b + ', got ' + a);
      }
    },
    deep: function (a, b, msg) {
      if (fmt(a) !== fmt(b)) throw new AssertionError((msg ? msg + ': ' : '') + 'expected ' + fmt(b) + ', got ' + fmt(a));
    },
  };

  g.test = function (name, fn) { cases.push({ name: name, fn: fn }); };
  g.assert = assert;

  g.runTests = function () {
    var results = [];
    var i = 0;
    function next() {
      if (i >= cases.length) {
        var failed = results.filter(function (r) { return !r.ok; });
        return Promise.resolve({ total: results.length, failed: failed.length, results: results });
      }
      var c = cases[i++];
      var p;
      try { p = Promise.resolve(c.fn()); } catch (e) { p = Promise.reject(e); }
      return p.then(function () { results.push({ name: c.name, ok: true }); },
        function (e) { results.push({ name: c.name, ok: false, error: String(e && e.message || e) }); })
        .then(next);
    }
    return next();
  };
})(typeof window !== 'undefined' ? window : globalThis);
