// vscode-port: debugging never marks the waveform document dirty (user report: the dbg.fsdb tab showed the unsaved dot
// at cycle 22 after a condition breakpoint and marker moves, so closing it asked to save). Upstream VaporView marks the
// document dirty on a user's viewer change (StateChangeType.User, 866973b undo/redo; save writes the viewer session),
// and that stays (a marker the user moves in the viewer, or through the waveformViewer.setMarker API, is the user's):
// only the debugger's own marker moves are not.
const { vscode, assert, sleep, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

/** Whether the waveform's editor tab shows the unsaved dot. */
function dirty(uri) {
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const u = t.input && t.input.uri ? String(t.input.uri) : '';
      if (u === uri) { return t.isDirty; }
    }
  }
  throw new Error('no tab for ' + uri);
}

module.exports = D.suite({
  'open a waveform (FSDB / WCZ twin) and let it load: the document is not dirty': async () => {
    const { open, fixture, closeAll } = require('./helpers.cjs');
    await closeAll();
    const uri = String(await open(fixture('dbg/dbg.vcd')));
    await until(async () => { const st = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return st && st.markerTime !== undefined ? st : null; }, 'viewer state');
    await sleep(1500); // (initial fit, restore, first marker all reported)
    assert.strictEqual(dirty(uri), false, 'dirty right after open');
  },
  'dbg: start, next / stepBack, a condition breakpoint and continue (the debugger moving the marker) leave the waveform document clean': async () => {
    const { uri } = await D.start();
    const check = async (what) => { await sleep(400); assert.strictEqual(dirty(uri), false, 'dirty after ' + what); };
    await check('start (entry stop)');
    await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'), 'stop after next');
    await check('next');
    await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepBack'), 'stop after stepBack');
    await check('stepBack');
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u0.cnt changes', true, "cnt == 8'h14")]);
    await check('breakpoint add');
    await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop after continue');
    await check('continue to the condition');
    const s = await D.session();
    assert.ok(s.time > 15, 'stopped at the condition: ' + s.time);
  },
});
