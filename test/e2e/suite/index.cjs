// vscode-port: minimal test runner inside the VS Code extension host (no mocha). Each *.test.cjs exports
// { name: async (t) => {...} }; t is the helper object from helpers.cjs. Prints PASS/FAIL per test, fails on any FAIL.
const fs = require('fs');
const path = require('path');
const t = require('./helpers.cjs');
exports.run = async function () {
  const filter = process.env.E2E_FILTER || '';
  // vscode-port: E2E_VISUAL=1 runs the screenshot scenarios in test/visual instead.
  const visual = process.env.E2E_VISUAL === '1';
  const dir = visual ? path.join(process.env.E2E_ROOT, 'test/visual') : __dirname;
  // vscode-port: E2E_EXCLUDE=<comma list of name parts> leaves those files out (the rc gate runs demo-sweep
  // on its own, in the demo's multi-root workspace)
  const exclude = (process.env.E2E_EXCLUDE || '').split(',').filter(Boolean);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(visual ? '.visual.cjs' : '.test.cjs') && f.includes(filter) && !exclude.some((x) => f.includes(x))).sort();
  // vscode-port: a test that prints "NOT RUN …" or "SKIP …" and returns is SKIP, never PASS; a run where
  // no test ran (every test skipped, or none matched) fails with "no test ran".
  let fail = 0, pass = 0, skip = 0;
  const log0 = console.log;
  let skipped = null;
  const hook = (...a) => { const t = a.map(String).join(' '); if (skipped === null && /^\s*(NOT RUN|SKIP)\b/.test(t)) { skipped = t.trim(); } log0.apply(console, a); };
  // (the extension host's console may not take a plain assignment: define it, and say if the hook is not in place)
  try { Object.defineProperty(console, 'log', { value: hook, writable: true, configurable: true }); } catch { console.log = hook; }
  if (console.log !== hook) { log0.call(console, 'E2E RUNNER WARNING: cannot hook console.log; NOT RUN tests count as PASS'); }
  for (const f of files) {
    const mod = require(path.join(dir, f));
    for (const [name, fn] of Object.entries(mod)) {
      const t0 = Date.now();
      // vscode-port: every trace step a test makes is checked against the dump (TraceCore.invariants);
      // a step the dump contradicts fails the test, whatever the test itself asserts.
      const traceInvariants = async () => { try { return (await t.vscode.commands.executeCommand('vaporview.e2e.traceInvariants')) || []; } catch { return []; } };
      await traceInvariants();
      skipped = null;
      try {
        await fn(t);
        const bad = await traceInvariants();
        if (bad.length) { throw new Error(`trace invariant: ${bad.length} step(s) contradict the dump:\n  ${bad.join('\n  ')}`); }
        if (skipped !== null) { skip++; console.log(`SKIP ${f} :: ${name}: ${skipped.replace(/^(NOT RUN|SKIP)\s*/, '')}`); }
        else { pass++; console.log(`PASS ${f} :: ${name} (${Date.now() - t0} ms)`); }
      }
      catch (e) { fail++; console.log(`FAIL ${f} :: ${name}: ${e && e.stack ? e.stack : e}`); }
      finally { try { await t.closeAll(); } catch {} }
    }
  }
  try { Object.defineProperty(console, 'log', { value: log0, writable: true, configurable: true }); } catch { console.log = log0; }
  console.log(`E2E SUMMARY pass=${pass} fail=${fail} skip=${skip}`);
  if (!pass && !fail) { throw new Error(`no test ran (${skip} skipped)`); }
  if (fail) { throw new Error(`${fail} failed, ${pass} passed, ${skip} skipped`); }
};
