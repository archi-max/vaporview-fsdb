// vscode-port: a file opens fitted to the waveform area, and that fit follows the area's settled width
// until the first zoom. Before, the first fit could run before the panel had its final width (an editor opening beside,
// the side bar or panel laying out) and a later resize kept that first zoom ratio, so the same file opened at different
// views run to run (dbg rulers 25/100/150 vs 0/25/50/100). After a zoom, a resize keeps the user's zoom.
const { vscode, assert, query, open, sleep, until, format } = require('./helpers.cjs');
const path = require('path');

const view = () => query({ kind: 'view' });
const settled = async (pred, what) => until(async () => { const v = await view(); return v && pred(v) ? v : null; }, what, 15000, 200)
  .catch(async (e) => { throw new Error(`${e.message}: view ${JSON.stringify(await view())}`); });

module.exports = {
  'View fit: the opening fit follows a resize until the first zoom; after a zoom, a resize keeps it': async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      const uri = String(await open('dbg/dbg.vcd'));
      const v0 = await settled((v) => v.width > 0 && v.right > 0, 'opening view');
      const end = v0.right;
      assert.strictEqual(v0.left, 0, 'opens at the start: ' + JSON.stringify(v0));
      // Narrow the waveform area (an editor beside), no zoom yet: still the whole file.
      const sv = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(path.dirname(vscode.Uri.parse(uri).fsPath), 'dbg_top.sv')))
        .catch(() => vscode.workspace.openTextDocument({ content: '// beside\n' }));
      await vscode.window.showTextDocument(sv, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      const v1 = await settled((v) => v.width < v0.width * 0.8, 'narrower waveform area');
      await sleep(500);
      const v1s = await view();
      assert.ok(v1s.left === 0 && Math.abs(v1s.right - end) <= end * 0.01, `narrowed before any zoom: still 0..${end}, got ${JSON.stringify(v1s)} (was ${JSON.stringify(v0)})`);
      // Back to full width: whole file again.
      // (close the text editor itself: its group goes, the waveform's group takes the whole width again)
      const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input && t.input.uri && String(t.input.uri) === String(sv.uri));
      if (tab) { await vscode.window.tabGroups.close(tab); }
      const v2 = await settled((v) => v.width >= v0.width * 0.95, 'full width again');
      assert.ok(v2.left === 0 && Math.abs(v2.right - end) <= end * 0.01, `widened: still 0..${end}, got ${JSON.stringify(v2)}`);
      // A zoom ends the opening fit: a later resize keeps the zoom ratio (the right edge moves with the width).
      await query({ kind: 'zoomRange', t0: 0, t1: Math.round(end / 4) });
      const z = await settled((v) => v.right < end * 0.5, 'zoomed to a quarter');
      await vscode.window.showTextDocument(sv, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      const z1 = await settled((v) => v.width < z.width * 0.8, 'narrower after the zoom');
      await sleep(500);
      const z1s = await view();
      const ratio = (v) => v.width / (v.right - v.left);
      assert.ok(Math.abs(ratio(z1s) / ratio(z) - 1) < 0.02, `zoom kept through the resize: ${JSON.stringify(z)} -> ${JSON.stringify(z1s)}`);
      console.log(`VIEWFIT ${format}: open ${JSON.stringify(v0)}; narrowed ${JSON.stringify(v1s)}; widened ${JSON.stringify(v2)}; zoomed ${JSON.stringify(z)} -> narrowed ${JSON.stringify(z1s)} (${v1.width}, ${z1.width})`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  },
};
