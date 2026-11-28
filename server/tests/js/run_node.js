// Node loader: evaluates each file in one shared global, like `jsc a.js b.js`.
// Usage: node run_node.js harness.js ../../lyra_server/static/markdown.js ... run_engine.js
'use strict';
const fs = require('fs');
const vm = require('vm');
globalThis.__lyraPrint = (line) => process.stdout.write(line + '\n');
for (const file of process.argv.slice(2)) {
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}
