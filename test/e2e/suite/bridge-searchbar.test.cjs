// vscode-port: a session saved with no marker (markerTime null) restores with an empty search box, not
// the text "null" (control_bar handleMarkerSet wrote String(time)). Seen in every CVA6 draft. FSDB, then WCZ (E2E_FORMAT).
const fs = require('fs'), os = require('os'), path = require('path');
const { vscode, assert, until, open, closeAll, activate } = require('./helpers.cjs');
const { page, pageReady } = require('./bridge-helpers.cjs');

const searchBox = () => page(() => { const e = document.getElementById('search-bar'); return e ? e.value : '(no search bar)'; });
async function rowsOf(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  const out = [];
  const walk = (l) => (l || []).forEach((d) => { if (d.netlistId !== undefined) { out.push(d.netlistId); } walk(d.children); });
  walk(s && s.displayedSignals);
  return out;
}

module.exports = {
  'a session with no marker (markerTime null) restores with an empty search box, not "null"': async () => {
    await closeAll();
    const uri = String(await open('counter.vcd'));
    await pageReady();
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.cnt' });
    await until(async () => (await rowsOf(uri)).length === 1, 'one row');
    const state = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
    assert.strictEqual(state.markerTime, null, 'precondition: no marker saves markerTime null: ' + JSON.stringify(state.markerTime));
    await closeAll();
    const uri2 = String(await open('counter.vcd'));
    await pageReady();
    assert.strictEqual(await searchBox(), '', 'fresh open: empty search box');
    const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vv-sess-')), 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify(state));
    await vscode.commands.executeCommand('waveformViewer.loadViewerState', { documentUri: uri2, sessionFileUri: vscode.Uri.file(sessionFile).toString() });
    await until(async () => (await rowsOf(uri2)).length === 1, 'row restored');
    const v = await searchBox();
    assert.ok(!/null|undefined|NaN/.test(v), `the search box after the session load: ${JSON.stringify(v)}`);
    assert.strictEqual(v, '', 'no marker: the search box stays empty');
    // a real marker still shows its time
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri: uri2, time: 40 });
    await until(async () => (await searchBox()) === '40', 'the marker time in the search box');
    await closeAll();
  },

  // files.save made the trace highlighter's marker time null while the viewer kept its marker.
  // Save writes the session (markerTime from the extension's webviewContext); nothing may emit a null marker on the way.
  'save keeps the marker: the saved session, the extension and the search box keep the time (user and quiet marker)': async () => {
    await closeAll();
    const ext = await activate();
    const uri = String(await open('counter.vcd'));
    await pageReady();
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.cnt' });
    await until(async () => (await rowsOf(uri)).length === 1, 'one row');
    // a session file to save into (save without one asks for a path)
    const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vv-sess-')), 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify(await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri })));
    await vscode.commands.executeCommand('waveformViewer.loadViewerState', { documentUri: uri, sessionFileUri: vscode.Uri.file(sessionFile).toString() });
    await until(async () => (await rowsOf(uri)).length === 1, 'row after the session load');
    const events = [];
    const sub = ext.exports.onDidSetMarker((e) => { if (String(e.uri) === uri) { events.push(e.time); } });
    try {
      for (const [how, t] of [['user', 40], ['quiet', 60]]) {
        if (how === 'user') { await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t }); }
        else { assert.ok(await vscode.commands.executeCommand('vaporview.e2e.driverHighlight', { uri, quietMarker: t }), 'quiet marker posted'); }
        await until(async () => (await searchBox()) === String(t), `${how} marker ${t} in the search box`);
        await until(async () => (await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri })).markerTime === t, `${how} marker ${t} in the extension`);
        const before = events.length;
        await vscode.commands.executeCommand('workbench.action.files.save');
        await until(async () => JSON.parse(fs.readFileSync(sessionFile, 'utf8')).markerTime === t, `the saved session has markerTime ${t} (${how})`, 10000, 200);
        await new Promise((r) => setTimeout(r, 1500)); // (any event the save causes)
        const after = events.slice(before);
        assert.strictEqual(await searchBox(), String(t), `the search box keeps ${t} after save (${how})`);
        assert.strictEqual((await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri })).markerTime, t, `the extension keeps markerTime ${t} after save (${how})`);
        console.log(`  DIAGNOSTIC save (${how} marker ${t}): onDidSetMarker times after save ${JSON.stringify(after)}`);
      }
    } finally { sub.dispose(); }
    await closeAll();
  },
};
