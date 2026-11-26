// vscode-port: wisp settings from the demo folder's own .vscode/settings.json (nothing at user level):
// E2E_DEMO_SCOPE = the folder, also opened as the workspace (E2E_WORKSPACE=<same absolute path>), a copy of the demo's
// c-debugger folder ("vaporview.wisp.outsideWrites": "none"). Opening dbg.fsdb must take outsideWrites none from the
// folder (wispState.outsideWrites) and read dbg_top.u1.en = 1 at 34 (a computed port copy).
// Without E2E_DEMO_SCOPE: no tests.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), path = require('path');
const { vscode, assert, until, open, activate } = require('./helpers.cjs');
const { useHelper } = require('./wisp-common.cjs');

const DIR = process.env.E2E_DEMO_SCOPE || '';
const SIG = 'dbg_top.u1.en', T = 34;

async function onFile(name) {
  await activate();
  const f = path.join(DIR, name);
  assert.ok(fs.existsSync(f), 'no ' + f);
  assert.ok(await useHelper('demo scope ' + name), 'wisp-helper');
  const ow = vscode.workspace.getConfiguration('vaporview', vscode.Uri.file(f)).inspect('wisp.outsideWrites');
  assert.ok(ow.globalValue === undefined, 'outsideWrites must not be set at user level: ' + JSON.stringify(ow));
  assert.strictEqual(ow.workspaceValue ?? ow.workspaceFolderValue, 'none', 'the folder settings set outsideWrites none: ' + JSON.stringify(ow));
  const uri = String(await open(vscode.Uri.file(f)));
  const st = await until(async () => { const s = await vscode.commands.executeCommand('vaporview.e2e.wispState', uri); return s && s.source ? s : null; }, 'wisp state', 120000, 100);
  assert.strictEqual(st.outsideWrites, 'none', 'state.outsideWrites (from the folder settings): ' + JSON.stringify(st).slice(0, 400));
  await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: SIG });
  const v = await until(async () => { const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time: T, instancePaths: [SIG] }); return r && r.length && r[0].value !== undefined ? r : null; }, SIG + '@' + T, 60000, 200);
  const val = Array.isArray(v[0].value) ? v[0].value[v[0].value.length - 1] : v[0].value;
  console.log(`  demo scope ${name}: outsideWrites ${st.outsideWrites}${st.computed ? ', computed ' + st.computed.n : ''}; ${SIG}@${T}=${JSON.stringify(v[0].value)}`);
  assert.strictEqual(String(val), '1', `${SIG}@${T} = 1: ${JSON.stringify(v[0])}`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

module.exports = DIR && fs.existsSync(path.join(DIR, 'dbg.fsdb'))
  ? { 'demo folder settings: dbg.fsdb takes outsideWrites none from .vscode/settings.json; u1.en@34 = 1': () => onFile('dbg.fsdb') } : {};
