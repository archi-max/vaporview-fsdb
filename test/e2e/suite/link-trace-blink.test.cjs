// vscode-port: Trace with no vaporview.trace.designArgs uses the editor link's design in a multi-root window
// (the demo's "3b link" folder: sources + dump in one folder, no .f / .slang, elaborate "always"). Demo sweep:
// every Trace point in b-link gave noDesign, FSDB and WCZ. Three invocations, one per cause:
//  - blink1.code-workspace (one folder, fixtures/link: sources + dump, no .f, elaborate "always"): (A) Trace first,
//    before any link action: it elaborates the dump's top as a link action would and gives a statement.
//  - blink.code-workspace (the same folder in a multi-root window): (A), then (B) a slang profile (.f) picked: Trace
//    uses it.
//  - multiroot.code-workspace (dump outside every root, elaborate default "ask"): (C) Trace right after open waits for
//    the profile auto-pick in the root whose profile matches the dump's tops (no mid-switch design: the badArgs race).
// E2E_WORKSPACE=<one of them> tools/linux-test.sh fmt link-trace-blink
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const fs = require('fs');
const { vscode, assert, until, root, format, activate, open } = require('./helpers.cjs');

const fx = path.join(root, 'test/e2e/fixtures');
const linkDir = path.join(fx, 'link');
const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
const ws = () => {
  const f = folders();
  if (f.length === 1 && f[0] === linkDir) { return 'blink1'; }
  if (f.length === 2 && f.includes(linkDir) && f.includes(path.join(fx, 'multiroot/dbg'))) { return 'blink'; }
  if (f.length === 2 && f.includes(path.join(fx, 'multiroot/fsm')) && f.includes(path.join(fx, 'multiroot/dbg'))) { return 'multiroot'; }
  return null;
};
const traceState = () => vscode.commands.executeCommand('vaporview.e2e.traceState').then((s) => s || {}, () => ({}));
async function trace(uri, p, time) {
  const st = await vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: p, time });
  return { st, design: (await traceState()).design };
}

// The second Trace after open answers quickly: nothing waits on an auto-pick that already ended (review b524674: a
// never-cleared autoPickPending made every design read wait 30 s).
async function secondFast(k, uri) {
  const t0 = Date.now();
  const r = await trace(uri, 'tb.dut.u_ctl.state', 105);
  const ms = Date.now() - t0;
  console.log(`  BLINK ${format} ${k} second Trace: ${ms} ms`);
  assert.ok(r.st && !r.st.error, `${k}: second Trace: ${JSON.stringify(r.st)}`);
  assert.ok(ms < 2000, `${k}: the second Trace after open answers in < 2 s (${ms} ms)`);
}

module.exports = {
  'Trace in a multi-root window uses the link\'s design (b-link: elaborated top, then a picked profile)': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN link-trace-blink: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    const w = ws();
    if (!w) { console.log('NOT RUN link-trace-blink: its own invocations, E2E_WORKSPACE=blink1 / blink / multiroot .code-workspace tools/linux-test.sh fmt link-trace-blink'); return; }
    await activate();
    if (w === 'multiroot') {
      // (C) the dump outside both roots: Trace right after open, no link action, no SV editor
      const uri = String(await open('link/fsm.vcd'));
      const r = await trace(uri, 'tb.dut.u_ctl.state', 105);
      console.log(`  BLINK ${format} C: ${JSON.stringify({ error: r.st && r.st.error, message: r.st && r.st.message, src: r.st && r.st.stmt && r.st.stmt.src, design: r.design && r.design.source })}`);
      assert.ok(r.st && !r.st.error && r.st.stmt && r.st.stmt.src, 'C: Trace right after open uses the auto-picked design of multiroot/fsm: ' + JSON.stringify({ st: r.st, design: r.design }));
      assert.ok(r.design && r.design.args.some((a) => a.includes(path.join('multiroot', 'fsm'))), 'C: the fsm root\'s design: ' + JSON.stringify(r.design));
      await secondFast('C', uri);
      return;
    }
    // The dump inside the folder, as in the demo (the twin copied next to the sources).
    const twin = vscode.Uri.parse(String(await open('link/fsm.vcd'))).fsPath;
    const inside = path.join(linkDir, `_blink.${format}`);
    fs.copyFileSync(twin, inside);
    const prof = path.join(linkDir, '_blink.f');
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const uri = String(await open(vscode.Uri.file(inside)));
      assert.ok(!vscode.workspace.getConfiguration('vaporview', vscode.Uri.parse(uri)).get('trace.designArgs')?.length, 'no trace.designArgs');
      // (A) nothing chosen; elaborate "always"
      const a = await trace(uri, 'tb.dut.u_ctl.state', 105);
      console.log(`  BLINK ${format} A: ${JSON.stringify({ error: a.st && a.st.error, message: a.st && a.st.message, src: a.st && a.st.stmt && a.st.stmt.src, design: a.design && a.design.source })}`);
      assert.ok(a.st && !a.st.error && a.st.stmt && a.st.stmt.src, 'A: Trace Driver gives a statement with the elaborated top: ' + JSON.stringify(a.st));
      await secondFast('A', uri);
      if (w === 'blink1') { return; }
      // (B) a profile picked: Trace uses it
      fs.writeFileSync(prof, ['fsm_pkg.sv', 'dut.sv', 'tb.sv', '--top tb', ''].join('\n'));
      const set = await vscode.commands.executeCommand('vaporview.sourceLink.useAsBuildFile', vscode.Uri.file(prof));
      console.log(`  BLINK ${format} B: useAsBuildFile -> ${JSON.stringify(set)}`);
      const b = await until(async () => { const r = await trace(uri, 'tb.dut.u_ctl.state', 105); return r.design && /_blink\.f/.test(r.design.source || '') ? r : null; }, 'Trace uses the picked profile', 60000, 2000)
        .catch(async (e) => { const r = await trace(uri, 'tb.dut.u_ctl.state', 105); throw new Error(`${e.message}: ${JSON.stringify({ st: r.st, design: r.design })}`); });
      console.log(`  BLINK ${format} B: ${JSON.stringify({ error: b.st && b.st.error, src: b.st && b.st.stmt && b.st.stmt.src, design: b.design && b.design.source })}`);
      assert.ok(b.st && !b.st.error && b.st.stmt && b.st.stmt.src, 'B: Trace Driver gives a statement with the profile: ' + JSON.stringify(b.st));
    } finally {
      await vscode.commands.executeCommand('vaporview.sourceLink.clearBuildFile').then(undefined, () => false);
      for (const f of [prof]) { try { fs.unlinkSync(f); } catch { /* none */ } }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      try { fs.unlinkSync(inside); } catch { /* none */ }
    }
  },
};
