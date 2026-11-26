// vscode-port: the quiet callers (driver highlight, stopLocation) never wait out the link's profile auto-pick:
// they pass { waitMs: 300 } to designForTrace (Trace keeps the long wait). E2E_WORKSPACE=blink1.code-workspace (fixtures/
// link, no designArgs, elaborate "always"): right after the dump opens (its auto-pick running), a row select paints its
// past its design choice in < 1.5 s ("no design yet" is fine), then, with the design in, the highlight and stopLocation
// both answer in < 2 s. FSDB then WCZ.
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const fs = require('fs');
const { vscode, assert, until, root, format, activate, open } = require('./helpers.cjs');

const linkDir = path.join(root, 'test/e2e/fixtures/link');
const hl = (a) => vscode.commands.executeCommand('vaporview.e2e.driverHighlight', a);
const SIG = 'tb.dut.u_ctl.state';

module.exports = {
  'quiet callers right after open (auto-pick running): the highlight paints and stopLocation answers without the link\'s 30 s wait': async () => {
    const f = (vscode.workspace.workspaceFolders || []).map((x) => x.uri.fsPath);
    if (f.length !== 1 || f[0] !== linkDir || (format !== 'fsdb' && format !== 'wcz')) { console.log('NOT RUN trace-quiet-wait: E2E_WORKSPACE=blink1.code-workspace, FSDB / WCZ'); return; }
    await activate();
    const twin = vscode.Uri.parse(String(await open('link/fsm.vcd'))).fsPath;
    const inside = path.join(linkDir, `_quiet.${format}`);
    fs.copyFileSync(twin, inside);
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const uri = String(await open(vscode.Uri.file(inside)));
      // (no wait for the auto-pick or the design: straight to a row select.) The design choice (designArgs -> the link's
      // designForTrace, waitMs 300) is done once the highlight is past it: loading the design, or settled ("no design
      // yet" is fine). Bound 1.5 s: the link's long wait (30 s), or any wait well above 300 ms, fails it.
      let t0 = Date.now();
      await hl({ fire: true, uri, path: SIG });
      const past = await until(async () => { const x = await hl(); return x && (x.pending === 'design' || (!x.pending && (x.all || x.none))) ? x : null; }, 'the highlight past its design choice', 60000, 20);
      const hMs = Date.now() - t0;
      console.log(`  DIAGNOSTIC quiet ${format}: highlight past the design choice in ${hMs} ms (${JSON.stringify(past.pending || past.none || 'marked')})`);
      assert.ok(hMs < 1500, `the highlight's design choice took ${hMs} ms (< 1.5 s; waitMs 300)`);
      // Once the design is there: both mark / answer, fast.
      const h2 = await until(async () => { const x = await hl({ compute: true, uri, dumpPath: SIG, time: 105 }); return x && x.all && x.all.length ? x : null; }, 'highlight with the link design', 60000, 500);
      t0 = Date.now();
      const again = await hl({ compute: true, uri, dumpPath: SIG, time: 105 });
      const loc2 = await vscode.commands.executeCommand('vaporview.trace.stopLocation', { uri, path: SIG, time: 105 });
      const ms2 = Date.now() - t0;
      assert.ok(again && again.all && again.all.length === h2.all.length, JSON.stringify(again));
      assert.ok(loc2 && loc2.kind === 'driver' && loc2.line > 0, 'stopLocation: ' + JSON.stringify(loc2));
      assert.ok(ms2 < 2000, `again, both in ${ms2} ms (< 2 s)`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      try { fs.unlinkSync(inside); } catch { /* gone */ }
    }
  },
};
