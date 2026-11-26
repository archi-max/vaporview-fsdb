// vscode-port B1: the marker set through waveformViewer.setMarker must be in the visible time range, also
// after the editor narrows (a panel opening beside it, as Trace Driver does). Seen in the trace-driver screenshots: marker
// at 60 ns, view 0..40 ns after the Trace Driver panel opened.
const path = require('path');
const { vscode, assert, until, open, query, root } = require('./helpers.cjs');
const view = () => query({ kind: 'view' });
const inView = (v, t) => v && t >= v.left && t <= v.right;

module.exports = {
  'setMarker scrolls the marker into view, and it stays in view when a panel opens beside the viewer': async () => {
    const uri = String(await open(vscode.Uri.file(path.join(root, 'test/e2e/fixtures/trace/a.vcd'))));
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'tb_a.dut.dout' });
    await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).some((s) => /dout/.test(s)), 'dout row');
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 60 });
    const v1 = await until(async () => { const v = await view(); return v && v.marker === 60 ? v : null; }, 'marker 60');
    assert.ok(inView(v1, 60), 'marker in view after setMarker: ' + JSON.stringify(v1));
    // A panel beside the viewer narrows it (Trace Driver opens with ViewColumn.Beside).
    const doc = await vscode.workspace.openTextDocument({ content: 'beside' });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    const v2 = await until(async () => { const v = await view(); return v && v.width < v1.width * 0.8 ? v : null; }, 'viewer narrowed');
    const v3 = await until(async () => { const v = await view(); return inView(v, 60) ? v : null; }, 'marker back in view', 5000).catch(() => null);
    assert.ok(v3, 'marker in view after the viewer narrowed: ' + JSON.stringify(await view()) + ' (narrowed: ' + JSON.stringify(v2) + ')');
  },
};
