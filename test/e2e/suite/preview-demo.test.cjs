// vscode-port: preview check: E2E_DEMO_FILES (space-separated .wcz/.fsdb paths) open in the waveform
// editor through the wisp-helper PACKAGED in the installed VSIX (wispHelperPath unset), netlist loads, a value reads.
const { vscode, assert, until } = require('./helpers.cjs');
const files = (process.env.E2E_DEMO_FILES || '').split(' ').filter(Boolean);
module.exports = files.length ? {
  'preview: demo WCZ / FSDB open in the editor through the bundled wisp-helper': async () => {
    const c = vscode.workspace.getConfiguration('vaporview');
    assert.ok(!String(c.get('wispHelperPath') || '').trim(), 'wispHelperPath is set; must use the bundled helper');
    for (const f of files) {
      const uri = vscode.Uri.file(f);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'vaporview.waveformViewer');
      const ws = await until(async () => { const s = await vscode.commands.executeCommand('vaporview.e2e.wispState', String(uri)); return s && s.source ? s : null; }, 'wisp state ' + f, 120000);
      assert.strictEqual(ws.refused, null, JSON.stringify(ws).slice(0, 400));
      const nl = await until(async () => { const n = await vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 6, 200); return n && n.vars && n.vars.length ? n : null; }, 'netlist ' + f, 120000);
      const v = nl.vars.find((x) => !x.unavailable) || nl.vars[0];
      await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: String(uri), instancePath: v.path });
      const val = await until(async () => { const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time: 0, instancePaths: [v.path] }); return r && r.length ? r : null; }, 'value ' + v.path, 60000);
      console.log(`  PREVIEW opened ${f.split('/').pop()} source=${ws.source} netlist vars>=${nl.vars.length} ${v.path}@0=${JSON.stringify(val[0].value).slice(0, 60)}`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  },
} : {};
