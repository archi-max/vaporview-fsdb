// vscode-port: vaporview.trace.designArgs and designRoot come from ONE settings scope. Run with
// E2E_WORKSPACE=trace-scope.code-workspace (two folders, each with its own `-f <x>.f`; the workspace sets a designRoot
// that is wrong for them). Each folder's dump traces with its own design, alternating, 5 rounds: never badArgs
// (the demo sweep saw it once per run). A dump OUTSIDE every folder (the twins under fixtures-fmt; a user's /tmp dump):
// E2E_WORKSPACE=trace-scope/a (single folder, its .vscode designArgs relative) traces with that folder's design;
// trace-scope-one.code-workspace (only a sets designArgs) uses a; trace-scope.code-workspace (both set) says which
// to choose (designAmbiguous) instead of guessing. Each test runs only in its workspace. FSDB then WCZ (E2E_FORMAT).
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { vscode, assert, open, root } = require('./helpers.cjs');
const { sameTwin, FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');

const fixtures = path.join(root, 'test/e2e/fixtures');
const folderOf = (n) => (vscode.workspace.workspaceFolders || []).find((f) => f.uri.fsPath === path.join(fixtures, 'trace-scope', n));
const CASES = [
  { n: 'a', vcd: 'a.vcd', path: 'tb_a.dut.dout', time: 60, want: (st) => st.stmt && st.stmt.loc && st.stmt.loc.line === 34 },
  { n: 'p', vcd: 'p.vcd', path: 'tb_p.dut.sg2', time: 440, want: (st) => !!(st.stmt && st.stmt.loc) },
];

const names = () => (vscode.workspace.workspaceFolders || []).map((f) => path.relative(fixtures, f.uri.fsPath)).sort().join(',');
/** Opens the a twin where it is (outside every workspace folder) and traces dout@60 five times. */
async function outside(expectError) {
  if (FORMAT) { assert.ok(await useHelper('design scope outside ' + FORMAT), 'wisp-helper'); }
  const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
  await cfg.update('trace.designArgs', undefined, G);
  await cfg.update('trace.designRoot', undefined, G);
  await vscode.commands.executeCommand('vaporview.e2e.traceReset');
  const f = sameTwin(path.join(fixtures, 'trace', 'a.vcd'));
  assert.ok(!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f)), 'the twin is outside the workspace: ' + f);
  const uri = String(await open(vscode.Uri.file(f)));
  try {
    for (let round = 1; round <= 5; round++) {
      const st = await vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout', time: 60 });
      if (expectError) {
        assert.strictEqual(st && st.error, expectError, `round ${round}: ${JSON.stringify(st).slice(0, 400)}`);
        assert.ok(/outside every workspace folder/.test(String(st.message)), 'says why: ' + st.message);
      } else {
        assert.ok(st && !st.error, `round ${round}: ${JSON.stringify(st && (st.error ? { error: st.error, message: st.message } : st)).slice(0, 400)}`);
        assert.strictEqual(st.stmt && st.stmt.loc && st.stmt.loc.line, 34, `round ${round}: ${JSON.stringify(st.stmt && st.stmt.loc)}`);
      }
    }
    const s = await vscode.commands.executeCommand('vaporview.e2e.traceState');
    console.log(`  DIAGNOSTIC design scope outside (${names()}) ${FORMAT || 'vcd'}: ${expectError || 'traced'} x5, design ${JSON.stringify(s.design && (s.design.source || s.design)).slice(0, 160)}`);
  } finally { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
}

module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  'designArgs + designRoot from one scope: two folders with relative `-f` and a wrong workspace designRoot trace with their own design, alternating, 5 rounds': async () => {
    if (!folderOf('a') || !folderOf('p')) { console.log('NOT RUN trace design scope: open E2E_WORKSPACE=trace-scope.code-workspace'); return; }
    if (FORMAT) { assert.ok(await useHelper('design scope ' + FORMAT), 'wisp-helper'); }
    const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
    await cfg.update('trace.designArgs', undefined, G);
    await cfg.update('trace.designRoot', undefined, G);
    // (the dumps live in their folders, as a user's do: the folder's settings apply to them)
    const made = [];
    const uris = {};
    try {
      for (const c of CASES) {
        const src = sameTwin(path.join(fixtures, 'trace', c.vcd));
        const dst = path.join(fixtures, 'trace-scope', c.n, c.n + path.extname(src));
        fs.copyFileSync(src, dst); made.push(dst);
        uris[c.n] = String(await open(vscode.Uri.file(dst)));
      }
      for (let round = 1; round <= 5; round++) {
        for (const c of CASES) {
          const st = await vscode.commands.executeCommand('vaporview.traceDriver', { uri: uris[c.n], path: c.path, time: c.time });
          assert.ok(st && !st.error, `round ${round} ${c.n}: ${JSON.stringify(st && (st.error ? { error: st.error, message: st.message } : st)).slice(0, 400)}`);
          assert.ok(c.want(st), `round ${round} ${c.n}: ${JSON.stringify(st.stmt && st.stmt.loc)}`);
        }
      }
      const s = await vscode.commands.executeCommand('vaporview.e2e.traceState');
      console.log(`  DIAGNOSTIC design scope ${FORMAT || 'vcd'}: 10 traces, design ${JSON.stringify(s.design && (s.design.source || s.design)).slice(0, 200)}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const f of made) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    }
  },

  'dump outside the folder, single-folder window (its .vscode designArgs relative, no designRoot): traced with that folder\'s design, 5 rounds': async () => {
    if (names() !== 'trace-scope/a') { console.log('NOT RUN design scope outside, single folder: open E2E_WORKSPACE=trace-scope/a'); return; }
    await outside(null);
  },
  'dump outside every folder, two folders and only one sets designArgs: traced with that folder\'s design, 5 rounds': async () => {
    if (names() !== 'trace,trace-scope/a') { console.log('NOT RUN design scope outside, one of two: open E2E_WORKSPACE=trace-scope-one.code-workspace'); return; }
    await outside(null);
  },
  'dump outside every folder, two folders both set designArgs: designAmbiguous says so (no guess, no badArgs)': async () => {
    if (names() !== 'trace-scope/a,trace-scope/p') { console.log('NOT RUN design scope outside, both set: open E2E_WORKSPACE=trace-scope.code-workspace'); return; }
    await outside('designAmbiguous');
  },
});
