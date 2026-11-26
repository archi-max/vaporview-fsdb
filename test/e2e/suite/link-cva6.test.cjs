// vscode-port: the CVA6 never-assigned 4-state enum through source link's inline values. In CVA6's
// rv_tracer (instance ariane_tb.dut.i_encoder) packet_f_opt_ext_subformat has its drivers commented out: the VCS dump
// has no change for it at all; its base is logic, so the value is x and inline shows x (x is a value).
// Runs only in its own invocation, with the CVA6 sources as the workspace and the dumps present (NOT RUN otherwise):
//   E2E_WORKSPACE=<dir with cva6.f + cva6/> E2E_CVA6_DIR=<dir with cva6-coremark.fsdb / .wcz> tools/linux-test.sh fmt link-cva6
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, activate, format } = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { keepDesign } = require('./link-design-guard.cjs');

const T = 7114890;
const NAME = 'packet_f_opt_ext_subformat';
const status = () => vscode.commands.executeCommand('vaporview.sourceLink.profileStatus');

module.exports = keepDesign({
  'Inline values , CVA6: rv_tracer packet_f_opt_ext_subformat (never assigned, logic base) shows x, never "no value"': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN link-cva6: FSDB / WCZ only (E2E_FORMAT=${format})`); return; }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const buildFile = path.join(ws, 'cva6.f');
    const dump = path.join(process.env.E2E_CVA6_DIR || path.join(os.homedir(), 'vaporview-demo/cva6'), 'cva6-coremark.' + format);
    const sv = path.join(ws, 'cva6/corev_apu/instr_tracing/rv_tracer-main/rtl/rv_tracer.sv');
    if (!fs.existsSync(buildFile) || !fs.existsSync(sv) || !fs.existsSync(dump)) {
      console.log(`NOT RUN link-cva6: needs E2E_WORKSPACE = the CVA6 sources (cva6.f: ${fs.existsSync(buildFile)}) and ${dump} (${fs.existsSync(dump)})`);
      return;
    }
    await activate();
    assert.ok(await vscode.commands.executeCommand('vaporview.sourceLink.useAsBuildFile', vscode.Uri.file(buildFile)), 'use cva6.f as the build file');
    await until(async () => (await status())?.compilation?.target?.kind === 'buildFile', 'cva6.f compiles', 180000, 1000);
    const uri = String(await open(vscode.Uri.file(dump)));
    const doc = await vscode.workspace.openTextDocument(sv);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    const line = doc.getText().split('\n').findIndex((l) => l.includes(NAME + '[N-1:0]'));
    assert.ok(line >= 0, `declaration of ${NAME}`);
    await vscode.window.activeTextEditor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    const r = await vscode.commands.executeCommand('vaporview.sourceLink.showValuesFor', { module: 'rv_tracer', instance: 'ariane_tb.dut.i_encoder' });
    assert.strictEqual(r && r.chosen, 'ariane_tb.dut.i_encoder', JSON.stringify(r));
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: T });
    const all = await until(async () => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: doc.uri.toString() });
      return (vs || []).some((x) => x.line === line && x.name === NAME) ? vs : null;
    }, `inline ${NAME} at ${T}`, 180000, 500).catch(async (e) => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: doc.uri.toString() });
      throw new Error(`${e.message}; inline near line ${line}: ${JSON.stringify((vs || []).filter((x) => Math.abs(x.line - line) < 3))}`);
    });
    const v = all.find((x) => x.line === line && x.name === NAME);
    // The enum's base is logic[0:0] (te_pkg.sv: typedef enum logic[0:0] {...} f_opt_ext_subformat_e): 4-state, never
    // assigned, so its value is x (x is a value). Inline shows it as x, never "no value" (1-bit: "x"; as hex 1'h? before 0.1.1's
    // x / z spelling, 1'hx after).
    assert.ok(!v.noValue && /^(1'h[?x]|x)$/.test(v.value), `${NAME}: the dumped x, not "${v.value}": ${JSON.stringify(v)}`);
    for (const x of all) { assert.ok(x.value !== 'unavailable', `no "unavailable": ${JSON.stringify(x)}`); }
    console.log(`CVA6X ${format}: ${v.dumpPath} @${T} = ${v.value} (${v.reason}); ${all.length} inline values in rv_tracer.sv`);
  },
});
