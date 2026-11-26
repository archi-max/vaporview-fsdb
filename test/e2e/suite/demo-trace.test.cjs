// vscode-port: Trace Driver in a demo folder with NO vaporview.trace.designArgs: after the link elaborates
// the design (Add Signal from the editor), Trace uses that design. E2E_DEMO_TRACE = the folder, also opened as the
// workspace (E2E_WORKSPACE=<same absolute path>): a copy of the demo's c-debugger folder without trace.designArgs.
// Each dbg.fsdb / dbg.wcz in it: open in the viewer, then Trace Driver of dbg_top.c0 at 105. Without E2E_DEMO_TRACE: no tests.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), path = require('path');
const { vscode, assert, open, activate } = require('./helpers.cjs');
const { useHelper } = require('./wisp-common.cjs');

const DIR = process.env.E2E_DEMO_TRACE || '';
const LONG = 30 * 60 * 1000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

function onFile(name) {
  return async () => {
    await activate();
    const f = path.join(DIR, name);
    assert.ok(fs.existsSync(f), 'no ' + f);
    assert.ok(await useHelper('demo trace ' + name), 'wisp-helper');
    const cfg = vscode.workspace.getConfiguration('vaporview');
    const da = cfg.inspect('trace.designArgs');
    assert.ok(!da.globalValue && !da.workspaceValue && !da.workspaceFolderValue, 'trace.designArgs must be unset: ' + JSON.stringify(da));
    const link = vscode.workspace.getConfiguration('vaporview.sourceLink');
    const before = link.get('elaborate');
    try {
      const uri = String(await open(vscode.Uri.file(f)));
      await link.update('elaborate', 'always', vscode.ConfigurationTarget.Global);
      const sv = vscode.Uri.file(path.join(DIR, 'dbg_top.sv'));
      const doc = await vscode.workspace.openTextDocument(sv);
      let pos;
      for (let i = 0; i < doc.lineCount && !pos; i++) {
        const t = doc.lineAt(i).text, m = /logic \[7:0\]\s+c0, c1;/.test(t) && /\bc0\b/.exec(t);
        if (m) { pos = { line: i, character: m.index + 1 }; }
      }
      assert.ok(pos, 'c0 declaration in dbg_top.sv');
      const add = await vscode.commands.executeCommand('vaporview.sourceLink.addSignal', { uri: sv.toString(), line: pos.line, character: pos.character, waveformUri: uri });
      assert.ok(add && add.added && add.added.includes('dbg_top.c0'), 'Add Signal c0 (elaborates dbg_top): ' + JSON.stringify(add));
      const st = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, designPath: 'dbg_top.c0', time: 105 }), LONG, 'trace driver');
      const s = await vscode.commands.executeCommand('vaporview.e2e.traceState');
      assert.ok(st && !st.error && st.stmt && st.stmt.src, 'trace with no designArgs: ' + JSON.stringify(st).slice(0, 400));
      // Trace bug 2: u1's counter at 37 steps to its own `cnt <= next` (dbg_top.sv line 16), not a port copy
      const st2 = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, designPath: 'dbg_top.u1.cnt', time: 37 }), LONG, 'trace driver u1.cnt');
      assert.ok(st2 && !st2.error && st2.stmt && st2.stmt.loc, 'trace u1.cnt@37: ' + JSON.stringify(st2).slice(0, 400));
      assert.ok(st2.stmt.loc.line === 16 && /cnt\s*<=\s*next/.test(st2.stmt.src), 'u1.cnt@37 -> line 16 `cnt <= next`: ' + JSON.stringify(st2.stmt).slice(0, 300));
      console.log(`  demo trace ${name}: u1.cnt@37 -> ${path.basename(st2.stmt.loc.file)}:${st2.stmt.loc.line} "${st2.stmt.src}"`);
      console.log(`  demo trace ${name}: design ${s.design && s.design.source} ${JSON.stringify(s.design && s.design.args)}; step ${st.signal}@${st.time} "${st.stmt.src}" ${path.basename(st.stmt.loc.file)}:${st.stmt.loc.line}`);
    } finally {
      await link.update('elaborate', before === 'ask' ? undefined : before, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  };
}

const dumps = DIR && fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^dbg\.(fsdb|wcz)$/.test(f)).sort() : [];
module.exports = Object.fromEntries(dumps.map((f) => [`demo Trace Driver with no designArgs: ${f}`, onFile(f)]));
