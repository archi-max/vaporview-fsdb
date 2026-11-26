// vscode-port: vaporview.trace.stopLocation, the debugger's stop frame. Quiet: the statement Trace Driver would
// show ({ kind: 'driver' }), else the declaration, else null; no panel, no history, no prompt. FSDB then WCZ (E2E_FORMAT).
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const { vscode, assert, open, root } = require('./helpers.cjs');
const { sameTwin, FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');

const dir = path.join(root, 'test/e2e/fixtures/trace');
const stop = (a) => vscode.commands.executeCommand('vaporview.trace.stopLocation', a);
const brief = (l) => l && [l.kind, path.basename(l.file), l.line];
// (what the user sees of Trace: its history, chain, panel, prompts; reads and the loaded design are allowed)
const state = async () => { const s = await vscode.commands.executeCommand('vaporview.e2e.traceState'); return JSON.stringify(['at', 'steps', 'step', 'chain', 'panel', 'panelVisible', 'noDesignOffer', 'emphasis'].map((k) => s[k])); };

async function openA() {
  if (FORMAT) { assert.ok(await useHelper('stop location ' + FORMAT), 'wisp-helper for E2E_FORMAT=' + FORMAT); }
  return String(await open(vscode.Uri.file(sameTwin(path.join(dir, 'a.vcd')))));
}

module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  'stopLocation: the driving statement at the time (dout: 34 at 60, 33 at 15), the declaration with no time, null off the design; nothing shown or pushed': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
    await cfg.update('trace.designArgs', ['-f', 'a.f'], G);
    await cfg.update('trace.designRoot', dir, G);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset');
    const uri = await openA();
    const s0 = await state();
    assert.deepStrictEqual(brief(await stop({ uri, path: 'tb_a.dut.dout', time: 60 })), ['driver', 'a_uninit.sv', 34]);
    assert.deepStrictEqual(brief(await stop({ uri, path: 'tb_a.dut.dout', time: 15 })), ['driver', 'a_uninit.sv', 33]);
    const decl = await stop({ uri, path: 'tb_a.dut.dout' });
    assert.deepStrictEqual(brief(decl), ['declaration', 'a_uninit.sv', 9], JSON.stringify(decl));
    assert.ok(decl.col >= 1, 'a column: ' + JSON.stringify(decl));
    assert.strictEqual(await stop({ uri, path: 'tb_a.dut.no_such_signal', time: 60 }), null);
    assert.strictEqual(await stop({ uri, path: '', time: 60 }), null);
    assert.strictEqual(await state(), s0, 'no Trace step, history or panel change');
  },

  'stopLocation: no design chosen gives null, with no prompt and no Trace step': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
    const link = vscode.workspace.getConfiguration('vaporview.sourceLink');
    const before = link.get('elaborate');
    await cfg.update('trace.designArgs', undefined, G);
    await cfg.update('trace.designRoot', undefined, G);
    await vscode.commands.executeCommand('vaporview.sourceLink.clearBuildFile').then(undefined, () => false);
    await vscode.commands.executeCommand('vaporview.sourceLink.resetTopLevel').then(undefined, () => false);
    await link.update('elaborate', 'never', G);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset');
    try {
      const uri = await openA();
      const s0 = await state();
      assert.strictEqual(await stop({ uri, path: 'tb_a.dut.dout', time: 60 }), null);
      assert.strictEqual(await state(), s0, 'no Trace step, history or panel change');
    } finally { await link.update('elaborate', before, G); }
  },
});
