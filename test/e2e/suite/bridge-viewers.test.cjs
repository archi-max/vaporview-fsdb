// vscode-port: two viewers open side by side. A format command (row menu, keybinding: it carries the
// row's netlistId, not the file) changes the row of the viewer the user acted on (the focused one), never the other
// viewer's rows; and it applies while that viewer's search bar has focus (the old guard
// dropped it). Fixtures: search.vcd (top.bus, 8 bits) and counter.vcd (top.cnt, 8 bits), or their E2E_FORMAT twins.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, closeAll, fixture } = require('./helpers.cjs');
const { page, pageReady } = require('./bridge-helpers.cjs');

async function rowFormat(uri, name) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  const all = [];
  const walk = (xs) => (xs || []).forEach((x) => { all.push(x); walk(x.children); });
  walk(s && s.displayedSignals);
  const row = all.find((x) => x.name === name); // saved rows: name = the full instance path
  return row && row.numberFormat;
}
async function focusViewer(uri, column) {
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(uri), 'vaporview.waveformViewer', { viewColumn: column, preserveFocus: false });
  await until(async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tab.input && String(tab.input.uri) === String(vscode.Uri.parse(uri));
  }, 'viewer focused ' + uri);
  await pageReady();
}

module.exports = {
  'two viewers: a format command changes the focused viewer\'s row only, also with its search bar focused': async () => {
    await closeAll();
    const a = String(await open('search.vcd'));
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: a, instancePath: 'top.bus' });
    const fA = await until(() => rowFormat(a, 'top.bus'), 'top.bus shown');
    // B opens beside A (column 2), so both are visible.
    const b = String(fixture('counter.vcd'));
    await focusViewer(b, vscode.ViewColumn.Two);
    // sent at once after openWith: the command waits for B's page (it was lost before)
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: b, instancePath: 'top.cnt' });
    const fB = await until(() => rowFormat(b, 'top.cnt'), 'top.cnt shown').catch(async (e) => {
      const st = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri: b });
      const docs = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
      throw new Error(`${e.message}; B=${b} docs=${JSON.stringify(docs)} B rows=${JSON.stringify(((st && st.displayedSignals) || []).map((x) => x.name))} B file=${st && st.fileName}`);
    });
    assert.ok(fA !== 'binary' && fA !== 'decimal' && fB !== 'binary', `start formats ${fA} / ${fB}`);
    // Both viewers visible (columns 1 and 2); B has focus: the command reaches B's row.
    await focusViewer(b, vscode.ViewColumn.Two);
    const cntId = await page((c) => (c.host.viewerContext.webview.displayedSignals || [])[0].netlistId);
    await vscode.commands.executeCommand('vaporview.displayAsBinary', { netlistId: cntId });
    await until(async () => (await rowFormat(b, 'top.cnt')) === 'binary', 'B top.cnt binary');
    assert.strictEqual(await rowFormat(a, 'top.bus'), fA, 'A untouched');
    // Focus A, put the focus in its search bar, then a format command: A's row changes, B's stays.
    await focusViewer(a, vscode.ViewColumn.One);
    const busId = await page((c) => (c.host.viewerContext.webview.displayedSignals || [])[0].netlistId);
    assert.strictEqual(typeof busId, 'number', 'top.bus row');
    // the viewer's own "search bar in focus" state, independent of OS window focus (see bridge-search.test.cjs)
    assert.ok(await page(() => {
      const bar = document.getElementById('search-bar');
      const box = document.getElementById('search-container');
      if (!box.classList.contains('is-focused')) { bar.focus(); }
      if (!box.classList.contains('is-focused')) { bar.dispatchEvent(new FocusEvent('focus')); }
      return box.classList.contains('is-focused');
    }), 'search bar in focus (viewer state)');
    try {
      await vscode.commands.executeCommand('vaporview.displayAsDecimal', { netlistId: busId });
      await until(async () => (await rowFormat(a, 'top.bus')) === 'decimal', 'A top.bus decimal with its search bar focused');
      assert.strictEqual(await rowFormat(b, 'top.cnt'), 'binary', 'B untouched');
    } finally {
      await page(() => {
        const bar = document.getElementById('search-bar');
        bar.blur();
        if (document.getElementById('search-container').classList.contains('is-focused')) { bar.dispatchEvent(new FocusEvent('blur')); }
        return true;
      });
    }
    await closeAll();
  },
};
