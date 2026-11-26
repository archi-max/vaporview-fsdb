// vscode-port: editor-link inline values outside debug. Default "cursorLine": drawn only on the
// cursor's line and the selected lines; "all": every line with values; "off": none; the old boolean true / false
// means "all" / "off". Values are still computed for the visible lines (getInlineValues); only the drawing follows.
// FSDB, then WCZ.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, root, activate, format } = require('./helpers.cjs');
const path = require('path');
const { keepDesign } = require('./link-design-guard.cjs');

const src = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/trace/a_uninit.sv'));
const tb = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/trace/tb_a.sv'));
const cfg = () => vscode.workspace.getConfiguration('vaporview.sourceLink');
const setMode = (v) => cfg().update('inlineValues', v, vscode.ConfigurationTarget.Global);
const drawn = () => vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString(), drawn: true });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const drawnIs = (want, what) => until(async () => { const d = await drawn(); return same(d.lines, want) ? d : null; }, what, 15000, 200)
  .catch(async (e) => { throw new Error(`${e.message}; drawn ${JSON.stringify(await drawn())}`); });

module.exports = keepDesign({
  'Inline values : cursor line by default, "all", "off", old booleans': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN link-cursor-line: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    await activate();
    try {
      await setMode(undefined);
      assert.strictEqual(cfg().get('inlineValues'), 'cursorLine', 'default is "cursorLine"');
      await until(async () => {
        const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: tb.toString() });
        return Array.isArray(r) && r.includes('tb_a') ? r : null;
      }, 'slang top level tb_a', 60000, 1000);
      const uri = String(await open('trace/a.vcd'));
      const doc = await vscode.workspace.openTextDocument(src);
      const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 55 });
      const values = await until(async () => {
        const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
        return Array.isArray(vs) && new Set(vs.map((v) => v.line)).size >= 3 ? vs : null;
      }, 'inline values on >= 3 lines at 55', 30000, 250);
      const lines = [...new Set(values.map((v) => v.line))].sort((a, b) => a - b);
      // Cursor on a line with values: only that line is drawn.
      const at = (l) => new vscode.Selection(l, 0, l, 0);
      ed.selections = [at(lines[1])];
      await drawnIs([lines[1]], `cursorLine: only line ${lines[1]}`);
      // Cursor on a line without values: nothing drawn.
      const bare = [...Array(doc.lineCount).keys()].find((l) => !lines.includes(l));
      ed.selections = [at(bare)];
      await drawnIs([], `cursorLine: nothing on bare line ${bare}`);
      // A selection over lines[0]..lines[2] (and a second cursor on the last value line) draws those lines.
      ed.selections = [new vscode.Selection(lines[0], 0, lines[2], 0), at(lines[lines.length - 1])];
      const want = lines.filter((l) => l <= lines[2] || l === lines[lines.length - 1]);
      await drawnIs(want, `cursorLine: selected lines ${want}`);
      // "all": every line with values, whatever the cursor.
      await setMode('all');
      ed.selections = [at(bare)];
      await drawnIs(lines, '"all": every value line');
      // "off": none drawn.
      await setMode('off');
      await drawnIs([], '"off": none');
      // Old booleans: true = "all", false = "off".
      await setMode(true);
      await drawnIs(lines, 'true = "all"');
      await setMode(false);
      await drawnIs([], 'false = "off"');
      console.log(`CURSORLINE ${format}: value lines ${lines.join(',')}; cursorLine / selection / all / off / true / false ok`);
    } finally {
      await setMode(undefined);
    }
  },
});
