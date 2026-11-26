// vscode-port: Trace uses the design slang already has (no vaporview.trace.designArgs): the link's
// elaboration / Set Top Level, the profile chooser's build file, each folder's own design in a multi-root window.
// FSDB then WCZ (E2E_FORMAT: the dumps open as their twins). Three invocations, one per workspace:
//   tools/linux-test.sh fmt trace-design                                          (dbg: after the link elaborates)
//   E2E_WORKSPACE=link-profiles tools/linux-test.sh fmt trace-design              (Trace follows a profile switch)
//   E2E_WORKSPACE=multiroot.code-workspace tools/linux-test.sh fmt trace-design   (each folder traces its design)
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const { vscode, assert, until, open, root, activate } = require('./helpers.cjs');
const { FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');

const fx = path.join(root, 'test/e2e/fixtures');
const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
const state = () => vscode.commands.executeCommand('vaporview.e2e.traceState');
const LONG = 30 * 60 * 1000; // (the sidecar may need a first build on a new machine)
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

async function noOverride() {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  await cfg.update('trace.designArgs', undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('trace.designRoot', undefined, vscode.ConfigurationTarget.Global);
}
async function openDump(rel) {
  if (FORMAT) { assert.ok(await useHelper('trace design on ' + FORMAT), 'wisp-helper for E2E_FORMAT=' + FORMAT); }
  const uri = String(await open(rel));
  assert.ok(!FORMAT || new RegExp(`\\.${FORMAT}$`).test(uri), `the ${FORMAT} twin: ${uri}`);
  return uri;
}
async function wordPos(uri, lineRe, word) {
  const doc = await vscode.workspace.openTextDocument(uri);
  for (let i = 0; i < doc.lineCount; i++) {
    const t = doc.lineAt(i).text;
    if (!lineRe.test(t)) { continue; }
    const m = new RegExp(`\\b${word}\\b`).exec(t);
    if (m) { return { line: i, character: m.index + 1 }; }
  }
  throw new Error(`no ${word} on ${lineRe}`);
}
/** Trace Driver of a design signal at a time; the step and the design Trace loaded. */
async function trace(uri, designPath, time) {
  const st = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, designPath, time }), LONG, 'trace driver ' + designPath);
  const s = await state();
  return { st, design: s.design, offer: s.noDesignOffer };
}

// (the trace.* settings this suite sets are put back when it ends: trace-settings-guard.cjs)
module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  'Trace with no designArgs uses the design the link elaborated (dbg)': async () => {
    if (folders().length !== 1 || folders()[0] !== fx) { console.log('NOT RUN trace-design dbg: the default workspace only'); return; }
    await activate();
    await noOverride();
    const link = vscode.workspace.getConfiguration('vaporview.sourceLink');
    const before = link.get('elaborate');
    // (independent of suite order: no profile or top level chosen by an earlier suite, no elaboration allowed yet)
    await vscode.commands.executeCommand('vaporview.sourceLink.clearBuildFile').then(undefined, () => false);
    await vscode.commands.executeCommand('vaporview.sourceLink.resetTopLevel').then(undefined, () => false);
    await link.update('elaborate', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset').then(undefined, () => false);
    try {
      const uri = await openDump('dbg/dbg.vcd');
      // Nothing chosen yet: Trace says so and offers the chooser and the dump's top module.
      const r0 = await trace(uri, 'dbg_top.c0', 105);
      assert.ok(r0.st && r0.st.error === 'noDesign' && /Choose the design first/.test(r0.st.message), 'no design yet: ' + JSON.stringify(r0.st));
      assert.deepStrictEqual(r0.offer, ['Pick a slang profile…', 'Set top level to dbg_top'], JSON.stringify(r0.offer));
      // The link elaborates dbg_top (Add Signal from the editor, elaboration allowed without asking).
      await link.update('elaborate', 'always', vscode.ConfigurationTarget.Global);
      const sv = vscode.Uri.file(path.join(fx, 'dbg/dbg_top.sv'));
      const pos = await wordPos(sv, /logic \[7:0\]\s+c0, c1;/, 'c0');
      const add = await vscode.commands.executeCommand('vaporview.sourceLink.addSignal', { uri: sv.toString(), line: pos.line, character: pos.character, waveformUri: uri });
      assert.ok(add && add.added && add.added.includes('dbg_top.c0'), 'Add Signal c0 (elaborates dbg_top): ' + JSON.stringify(add));
      const r1 = await trace(uri, 'dbg_top.c0', 105);
      assert.ok(r1.st && !r1.st.error && r1.st.stmt && r1.st.stmt.src, 'trace after elaboration: ' + JSON.stringify(r1.st));
      assert.ok(r1.design && r1.design.args.includes('--top') && r1.design.args.includes('dbg_top') && r1.design.args.some((a) => /dbg_top\.sv$/.test(a)), 'design: ' + JSON.stringify(r1.design));
      const srcs = r1.design.args.filter((a) => /\.sv$/.test(a));
      assert.strictEqual(new Set(srcs.map((f) => require('fs').realpathSync(f))).size, srcs.length, 'each source once: ' + JSON.stringify(srcs));
      assert.ok(r1.design.rebuilt, 'rebuilt from slang\'s modules: ' + JSON.stringify(r1.design));
      const note = await until(async () => { const t = await vscode.commands.executeCommand('vaporview.e2e.tracePanel', { kind: 'texts', selector: '.design-note' }); return Array.isArray(t) && t.some((x) => /rebuilt from slang's open modules/.test(x)) ? t : null; }, 'the panel says the design was rebuilt', 10000);
      console.log(`  DIAGNOSTIC trace-design dbg panel note: ${note[0]}`);
      console.log(`  DIAGNOSTIC trace-design dbg (${FORMAT || 'vcd'}): ${r1.design.source}; args ${JSON.stringify(r1.design.args)}; step ${r1.st.signal}@${r1.st.time} "${r1.st.stmt.src}" ${path.basename(r1.st.stmt.loc.file)}:${r1.st.stmt.loc.line}`);
    } finally {
      await link.update('elaborate', before === 'ask' ? undefined : before, vscode.ConfigurationTarget.Global);
    }
  },

  'Trace follows a profile switch (link-profiles)': async () => {
    const ws = path.join(fx, 'link-profiles');
    if (!folders().includes(ws) || folders().length !== 1) { console.log('NOT RUN trace-design profiles: E2E_WORKSPACE=link-profiles'); return; }
    await activate();
    await noOverride();
    const simF = path.join(ws, '.slang/sim.f'), coreF = path.join(ws, '.slang/core.f');
    const uri = await openDump('link/fsm.vcd');
    assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.switchProfile', simF), ['tb']);
    const r1 = await trace(uri, 'tb.dut.u_ctl.state', 105);
    const ps1 = await vscode.commands.executeCommand('vaporview.sourceLink.profileStatus');
    assert.ok(/^slang: sim\b/.test(ps1.shown), 'status bar after the switch to sim: ' + JSON.stringify(ps1.shown));
    assert.deepStrictEqual(r1.design && r1.design.args, ['-f', simF], 'sim profile: ' + JSON.stringify(r1.design));
    assert.ok(!r1.design.rebuilt, 'a profile: its own args');
    assert.ok(r1.st && !r1.st.error && r1.st.stmt, 'trace on sim.f: ' + JSON.stringify(r1.st));
    assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.switchProfile', coreF), ['top']);
    const ps2 = await vscode.commands.executeCommand('vaporview.sourceLink.profileStatus');
    assert.ok(/^slang: core\b/.test(ps2.shown), 'status bar after the switch to core: ' + JSON.stringify(ps2.shown));
    const r2 = await trace(uri, 'top.u_ctl.state', 105);
    assert.deepStrictEqual(r2.design && r2.design.args, ['-f', coreF], 'core profile: ' + JSON.stringify(r2.design));
    console.log(`  DIAGNOSTIC trace-design profiles (${FORMAT || 'vcd'}): sim.f step ${r1.st.signal}@${r1.st.time} "${r1.st.stmt.src}"; core.f -> ${r2.st && r2.st.error ? 'error ' + r2.st.error + ' ' + r2.st.message : r2.st.signal + ' "' + r2.st.stmt.src + '"'}`);
    await vscode.commands.executeCommand('vaporview.sourceLink.switchProfile', simF);
  },

  'Multi-root: each folder traces its own design': async () => {
    const mr = path.join(fx, 'multiroot');
    if (!folders().includes(path.join(mr, 'fsm')) || !folders().includes(path.join(mr, 'dbg'))) { console.log('NOT RUN trace-design multiroot: E2E_WORKSPACE=multiroot.code-workspace'); return; }
    await activate();
    await noOverride();
    const cases = [
      { name: 'fsm', dump: 'link/fsm.vcd', sv: 'multiroot/fsm/rtl/dut.sv', path: 'tb.dut.u_ctl.state', file: /fsm\.f$/, sources: ['dut.sv', 'tb.sv', 'fsm_pkg.sv'] },
      { name: 'dbg', dump: 'dbg/dbg.vcd', sv: 'multiroot/dbg/rtl/dbg_top.sv', path: 'dbg_top.c0', file: /dbg\.f$/, sources: ['dbg_top.sv'] },
    ];
    for (const c of cases) {
      const uri = await openDump(c.dump);
      // Link the waveform to its folder (Show the editor, inline values ask its root) so its design root is known.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fx, c.sv))), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      const r = await trace(uri, c.path, 105);
      assert.ok(r.st && !r.st.error && r.st.stmt, `${c.name}: trace: ${JSON.stringify(r.st)}`);
      assert.strictEqual(r.design && r.design.root, path.join(mr, c.name), `${c.name}: design root ${JSON.stringify(r.design)}`);
      assert.ok(r.design.args.some((a) => c.file.test(a)), `${c.name}: its build file: ${JSON.stringify(r.design)}`);
      // (the folder's rtl files link to the fixture's sources; slang reports their real paths)
      assert.ok(c.sources.includes(path.basename(r.st.stmt.loc.file)), `${c.name}: statement in its design's sources: ${r.st.stmt.loc.file}`);
      console.log(`  DIAGNOSTIC trace-design multiroot ${c.name} (${FORMAT || 'vcd'}): ${r.design.source}; step ${r.st.signal}@${r.st.time} "${r.st.stmt.src}" ${path.relative(fx, r.st.stmt.loc.file)}:${r.st.stmt.loc.line}`);
    }
  },
});
