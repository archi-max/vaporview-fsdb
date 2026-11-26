// vscode-port: screenshots of the waveform debugger (vsc/debugger, merged 4effe8c) on fixtures/dbg
// (dbg_top.sv + dbg.vcd: clock edges at 5, 15, ... ns; u0.cnt counts every cycle from 15 ns, u1.cnt every other cycle).
// Same flows as test/e2e/suite/dbg-*.test.cjs; this file only adds the pictures:
//   dbg-step:  two steps with the SystemVerilog editor beside the waveform (changed signals + drivers tinted, the rest
//              dimmed), the Run and Debug view with Locals and a Watch, both themes. Default settings (debug.inlineValues
//              auto). Inline values do not show in the SV editor yet, even with debug.inlineValues on: VS Code asks
//              the InlineValuesProvider only for the editor of the stopped frame's source, and that source is the
//              waveform (dbg.vcd). The baseline changes when that is fixed.
//   dbg-break: Break When Changes on dbg_top.u1.cnt, Continue stops at 15 ns (Breakpoints view, paused on breakpoint).
const t = require('../e2e/suite/helpers.cjs');
const { vscode, assert, until, query, sleep } = t;
const D = require('../e2e/suite/dbg-helpers.cjs');

const ROWS = ['dbg_top.clk', 'dbg_top.c0', 'dbg_top.c1', 'dbg_top.instr'];
async function rows(uri) {
  for (const p of ROWS) { await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p }); }
  await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).length >= ROWS.length, 'debug rows');
}
/** Waits until the adapter answered a set*Breakpoints request with `n` verified breakpoints (as dbg-break.test.cjs). */
const verified = (command, n) => until(async () => {
  const r = [...D.sent].reverse().find((m) => m.type === 'response' && m.command === command);
  return r && r.body.breakpoints.length === n && r.body.breakpoints.every((b) => b.verified) ? r.body.breakpoints : null;
}, `${command} verified x${n}`);
const step = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
/** The Run and Debug view, the debug console panel closed (its log is not what these shots are about). */
async function debugView() {
  await vscode.commands.executeCommand('workbench.view.debug');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  // Opening the view gives its Start Debugging button keyboard focus, and on Linux (the window has OS focus) VS Code then
  // shows the button's "Start Debugging (F5)" hover in the shot. Focus goes back to the editor.
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await sleep(500);
}

// D.start states vaporview.wisp.outsideWrites=none for the VCS twins (their port copies carry values); later files
// (trace's converted twins) open with the setting unset, as the dbg suites' D.suite wrapper leaves it.
async function unstate() {
  const c = vscode.workspace.getConfiguration('vaporview');
  if ((c.inspect('wisp.outsideWrites') || {}).globalValue !== undefined) { await c.update('wisp.outsideWrites', undefined, vscode.ConfigurationTarget.Global); }
}

module.exports = {
  'dbg-step: two steps, SV editor tint, Locals and a Watch (inline values: see the header) (both themes)': async () => {
    try {
      const { uri } = await D.start();
      await rows(uri);
      const ed = await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Beside });
      await step(); // 15 ns: u0.cnt 0 -> 1, u1.cnt 0 -> 1, rst low
      const r = await step(); // 25 ns: u1 holds
      assert.strictEqual(r.s.time, 25);
      await D.markerAt(uri, 25);
      await until(async () => { const d = ((await D.e2e({ kind: 'editor' })) || {})[String(D.SV())]; return d && d.some((m) => m.module === 'dbg_top') ? d : null; }, 'editor tint');
      // A Watch from the editor selection ("c0" in the u0 port list): Add Selection to Watch. The Run and Debug view
      // must be open first, and the editor focused when the command runs.
      await debugView();
      const line = ed.document.getText().split('\n').findIndex((l) => /\.cnt\(c0\)/.test(l));
      const col = ed.document.lineAt(line).text.indexOf('c0)');
      const ed2 = await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false });
      ed2.selection = new vscode.Selection(line, col, line, col + 2);
      await vscode.commands.executeCommand('editor.debug.action.selectionToWatch');
      await sleep(500);
      ed2.selection = new vscode.Selection(line, 0, line, 0);
      // The Call Stack row's selection after a step is a race (row selected in some runs, unselected with a dim file name
      // in others, either format): select the top frame, then debugView() gives the focus back to the editor.
      await vscode.commands.executeCommand('workbench.action.debug.callStackTop');
      await sleep(300);
      await debugView();
      await t.screenshotThemes('dbg-step', { sidebar: true, settle: 1200, view: [0, 100] });
    } finally { await D.stopAll(); await unstate(); await vscode.commands.executeCommand('workbench.action.closeSidebar'); } // the next file's waveform must open at full width
  },
  'dbg-break: Break When Changes on u1.cnt, Continue stops at the change (15 ns)': async () => {
    try {
      const { uri } = await D.start();
      await rows(uri);
      const name = await vscode.commands.executeCommand('vaporview.debugger.breakWhenChanges', { webviewSection: 'signal', scopePath: 'dbg_top.u1', signalName: 'cnt' });
      assert.strictEqual(name, 'dbg_top.u1.cnt changes');
      await verified('setFunctionBreakpoints', 1);
      const r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'breakpoint stop');
      assert.strictEqual(r.ev.body.reason, 'breakpoint');
      assert.strictEqual(r.s.time, 15);
      await D.markerAt(uri, 15);
      await debugView();
      await t.screenshot('dbg-break-dark', { sidebar: true, settle: 1200, view: [0, 320] });
    } finally { await D.stopAll(); await unstate(); await vscode.commands.executeCommand('workbench.action.closeSidebar'); } // the next file's waveform must open at full width
  },
};
