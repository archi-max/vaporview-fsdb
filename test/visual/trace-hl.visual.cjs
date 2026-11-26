// vscode-port: screenshots of the driver highlight in the editor (design A, dout at 60: the dim bar
// on line 33, the full bar, faint background and "drives dout at 60 ns" on line 34). Flow as trace-highlight.test.cjs.
const path = require('path');
const t = require('../e2e/suite/helpers.cjs');
const { vscode, assert, until, open, root } = t;
const { sameTwin } = require('../e2e/suite/format.cjs');

const dir = path.join(root, 'test/e2e/fixtures/trace');
const hl = (a) => vscode.commands.executeCommand('vaporview.e2e.driverHighlight', a);

module.exports = {
  'driver-highlight: the cursor on dout marks its assigning lines, line 34 drives it at 60 (both themes)': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview');
    await cfg.update('trace.designArgs', ['-f', 'a.f'], vscode.ConfigurationTarget.Global);
    await cfg.update('trace.designRoot', dir, vscode.ConfigurationTarget.Global);
    const uri = String(await open(vscode.Uri.file(sameTwin(path.join(dir, 'a.vcd')))));
    // (moved as the debugger moves it: a user's marker move would put the unsaved dot on the a.fsdb tab in the picture)
    assert.ok(await hl({ quietMarker: 60, uri }), 'quiet marker');
    await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === 60; }, 'marker at 60', 10000);
    const sv = await vscode.workspace.openTextDocument(path.join(dir, 'a_uninit.sv'));
    const ed = await vscode.window.showTextDocument(sv, { preview: false });
    const col = sv.lineAt(33).text.indexOf('dout') + 1;
    ed.selection = new vscode.Selection(33, col, 33, col);
    ed.revealRange(new vscode.Range(15, 0, 35, 0), vscode.TextEditorRevealType.AtTop);
    await until(async () => { const x = await hl(); return x && x.active && x.time === 60 ? x : null; }, 'highlight', 180000, 50);
    const painted = await hl({ painted: sv.uri.toString() });
    assert.deepStrictEqual([painted.dim, painted.active], [[33], [34]], JSON.stringify(painted));
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input && x.input.uri && String(x.input.uri) === uri);
    assert.ok(tab && tab.isDirty === false, 'the waveform tab shows no unsaved dot');
    // (the editor covers the waveform, whose idle check would wait for it: no idle wait; a solid cursor so frames settle)
    await vscode.workspace.getConfiguration('editor').update('cursorBlinking', 'solid', vscode.ConfigurationTarget.Global);
    try { await t.screenshotThemes('driver-highlight', { settle: 1200, idle: false }); }
    finally { await vscode.workspace.getConfiguration('editor').update('cursorBlinking', undefined, vscode.ConfigurationTarget.Global); }
  },
};
