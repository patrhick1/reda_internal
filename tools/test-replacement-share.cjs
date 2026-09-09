// Run with: node tools/test-replacement-share.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('../mobile/node_modules/typescript');
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  return resolve.call(this, name.startsWith('@/') ? path.resolve(__dirname, '../mobile/src', name.slice(2)) : name, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, filename);
const { buildClientShareMessage } = require('../mobile/src/lib/reconcile.ts');
for (const [paid, remit, expected] of [[0,-3000,'Client owes Reda: ₦3,000'],[1800,-1200,'Client owes Reda: ₦1,200'],[3000,0,'No balance due']]) {
 const result = buildClientShareMessage({clientName:'Test',rangeLabel:'Test day',rows:[{orderType:'replacement',customerName:'Test customer',products:[],paid,remit,note:'Exchange completed'}]});
 assert.ok(result.includes(expected),result);
 assert.ok(result.includes(`Customer paid: ₦${paid.toLocaleString('en-NG')}`),result);
 assert.ok(result.includes('Thank you for choosing REDA 🥂'),result);
}
console.log('PASS: zero, partial, full replacement payment client messages');
