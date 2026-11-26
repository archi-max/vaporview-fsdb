// vscode-port P4 acceptance: stepping keeps the user's SystemVerilog tab in front when it shares ONE tab group with the
// waveform (VS Code opens the focused frame's source on every stop, so the frame is the SV line), the frame's line is the
// driver line of the followed instance nearest the cursor, and the marker still moves in the (hidden) waveform. With no
// SV editor showing, the frame falls back to the waveform, which stays the active tab.
const { vscode, assert, sleep, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

const stepOver = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
const stepBack = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepBack'));
const tabUri = (tab) => (tab && tab.input && tab.input.uri ? String(tab.input.uri) : null);
const groupOf = (uri) => vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => tabUri(t) === uri));

/** After a stop VS Code focuses the frame and opens its source; wait until the stack trace was asked and settle. */
async function settled() {
  await until(async () => D.sent.some((m) => m.type === 'response' && m.command === 'stackTrace'), 'stackTrace answered');
  await sleep(400);
}

module.exports = D.suite({
  'dbg: stepping in one tab group keeps the SV editor the active tab; the marker moves in the waveform': async () => {
    const { uri } = await D.start();
    const sv = String(D.SV());
    // The SV editor in the waveform's own group (no Beside), active.
    const ed = await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Active });
    const group = groupOf(uri);
    assert.ok(group && group.tabs.some((t) => tabUri(t) === sv), 'the waveform and the SV editor share one tab group');
    assert.strictEqual(vscode.window.tabGroups.all.filter((g) => g.tabs.some((t) => tabUri(t) === sv || tabUri(t) === uri)).length, 1);
    ed.selection = new vscode.Selection(17, 0, 17, 0); // `assign wrap = ...` in counter (followed instance dbg_top.u0)
    await sleep(300);
    let t = (await D.session()).time;
    for (const [what, act] of [['step', stepOver], ['step', stepOver], ['step back', stepBack], ['step', stepOver]]) {
      D.sent.length = 0;
      const { s } = await act();
      assert.notStrictEqual(s.time, t, `${what} moved the cycle`);
      t = s.time;
      await settled();
      // The marker moved in the waveform although its tab is in the background.
      await D.markerAt(uri, s.time);
      const g = groupOf(sv);
      assert.strictEqual(tabUri(g.activeTab), sv, `${what}: the SV editor stays the active tab of the shared group (active: ${tabUri(g.activeTab)})`);
      assert.ok(g.tabs.some((x) => tabUri(x) === uri), 'the waveform is still in that group');
      assert.strictEqual(String(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri), sv, `${what}: the SV editor stays active`);
      // The frame is the SV file at the followed instance's driver line nearest the cursor: cnt <= next (line 16)
      // whenever u0.cnt changed this cycle (every cycle from 15 ns on).
      const st = await D.custom('stackTrace', { threadId: 1 });
      assert.strictEqual(st.stackFrames[0].source.path, D.SV().fsPath, `${what}: frame source`);
      assert.strictEqual(st.stackFrames[0].line, 16, `${what}: frame line = driver line (cursor was on 18)`);
    }
  },
  'dbg: with no SV editor showing, the frame is the waveform and stepping keeps the waveform tab in front': async () => {
    const { uri } = await D.start();
    const sv = String(D.SV());
    // The SV editor in the same group but behind the waveform.
    await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Active });
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri));
    await until(async () => tabUri(groupOf(uri).activeTab) === uri, 'waveform tab in front');
    assert.ok(!vscode.window.visibleTextEditors.some((e) => String(e.document.uri) === sv), 'SV editor hidden');
    D.sent.length = 0;
    const { s } = await stepOver();
    await settled();
    await D.markerAt(uri, s.time);
    assert.strictEqual(tabUri(groupOf(uri).activeTab), uri, 'the waveform stays the active tab');
    const st = await D.custom('stackTrace', { threadId: 1 });
    assert.strictEqual(st.stackFrames[0].source.path, vscode.Uri.parse(uri).fsPath, 'frame falls back to the waveform');
  },
});
