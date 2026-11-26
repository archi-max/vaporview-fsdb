// vscode-port: the trace engine's case suite (port of cmux scripts/waveform-viewer-checks/trace/main.swift, which ran
// it in a bare JavaScriptCore context). Loads media/cmux/trace/cmux-expr.js + cmux-trace.js, vcd.js and cases.js into
// a fresh node:vm context with the fixtures (designs/, models/, dumps/; Verdi load lists from TRACE_ORACLE_DIR when set), runs runTraceChecks(), prints
// every line and "N case runs" + TRACE CHECKS PASSED / FAILED like the original.
// Usage: node test/trace/run.cjs [cases.js path] [engine dir]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const here = __dirname;
const root = path.resolve(here, '../..');
const casesPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, 'cases.js');
const engineDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'media/cmux/trace');

function files(sub, ext) {
  const dir = path.isAbsolute(sub) ? sub : path.join(here, sub);
  const out = {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (name.endsWith(ext)) { out[name.slice(0, -ext.length)] = fs.readFileSync(path.join(dir, name), 'utf8'); }
  }
  return out;
}
const designs = {};
for (const [name, text] of Object.entries(files('designs', '.sv'))) { designs[name + '.sv'] = text; }

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  traceFiles: { designs, models: files('models', '.json'), dumps: files('dumps', '.vcd'), loadOracle: process.env.TRACE_ORACLE_DIR ? files(path.resolve(process.env.TRACE_ORACLE_DIR), '.json') : {} },
};
// Extra cases (own red/green checks) can be appended by TRACE_EXTRA_CASES=<file>.
const context = vm.createContext(sandbox);
const scripts = [path.join(engineDir, 'cmux-expr.js'), path.join(engineDir, 'cmux-trace.js'), path.join(here, 'vcd.js'), casesPath];
for (const p of scripts) {
  try { vm.runInContext(fs.readFileSync(p, 'utf8'), context, { filename: p }); }
  catch (error) { console.log('FAIL loading', p, error && error.stack || error); console.log('TRACE CHECKS FAILED: 1'); process.exit(1); }
}
const started = Date.now();
let thrown = null;
process.on('unhandledRejection', (e) => { thrown = String(e && e.stack || e); });
vm.runInContext('runTraceChecks()', context);
const timer = setInterval(() => {
  const done = context.__traceDone;
  if (!done && Date.now() - started < 300000) { return; }
  clearInterval(timer);
  const lines = done ? Array.from(done.lines) : ['FAIL no results (timed out)'];
  for (const l of lines) { console.log(l); }
  if (thrown) { console.log('FAIL', thrown); }
  const failures = lines.filter((l) => l.startsWith('FAIL')).length + (thrown ? 1 : 0);
  const cases = lines.filter((l) => l.startsWith('ok ') || l.startsWith('FAIL ')).length;
  console.log(`${cases} case runs, ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(failures === 0 ? 'TRACE CHECKS PASSED' : `TRACE CHECKS FAILED: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}, 10);
