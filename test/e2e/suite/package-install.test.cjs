// vscode-port: checks of an INSTALLED VSIX (test/e2e/run-installed.mjs sets E2E_EXT_ID). Not exported in
// dev-folder runs, so they never pass vacuously there.
//  - the extension is the installed copy (from the extensions dir, not the repo) and activates;
//  - its packaged native programs (Linux VSIX) are executable after install, and wisp-helper opens a WCZ
//    (E2E_WCZ: one made with wcz-from-vcd on the test host; none ships);
const { vscode, assert, root, query } = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const id = process.env.E2E_EXT_ID;
function ask(helper, lines, ms = 20000) { // JSON lines in on stdin, replies on fd 3 (wisp-helper's protocol)
  return new Promise((resolve, reject) => {
    const p = cp.spawn(helper, [], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('wisp-helper timed out; stderr ' + err)); }, ms);
    p.stdio[3].on('data', (d) => { out += d.toString().replace(/\0/g, ''); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', () => { clearTimeout(timer); resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))); });
    p.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}

// The viewer webview of the just-opened file is ready (viewport initialised) before rows are added; an add sent before
// the webview initialises is not shown (seen on Mac: rows [] after 60 s).
async function webviewReady(until) {
  return until(async () => { const r = await vscode.commands.executeCommand('vaporview.e2e.query', { kind: 'state' }); return r && !r.error && r.result && r.result.timeStop > 0 && Array.isArray(r.result.rows) ? r.result : null; }, 'viewer webview ready', 120000);
}
async function addAndShow(uri, p, leaf, until, pred, what) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: String(uri), instancePath: p });
    try {
      return await until(async () => { const x = await query({ kind: 'state' }); last = x && x.rows; const row = x && x.rows && x.rows.find((q) => q.name === leaf); return row && pred(row) ? x : null; }, what, 30000);
    } catch (e) { if (attempt === 2) throw new Error(e.message + '; webview rows ' + JSON.stringify(last).slice(0, 400)); }
  }
}
const tests = {
  'installed VSIX: the extension under test is the installed copy and activates': async () => {
    const ext = vscode.extensions.getExtension(id);
    assert.ok(ext, `extension ${id} not installed`);
    assert.ok(!ext.extensionPath.startsWith(root), `loaded from the repo (${ext.extensionPath}), not from the install`);
    if (!ext.isActive) { await ext.activate(); }
    assert.ok(ext.isActive, 'not active');
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['vaporview.openFile', 'vaporview.traceDriver', 'vaporview.traceXRoot']) assert.ok(cmds.includes(c), `command ${c} missing`);
    console.log(`  installed at ${path.basename(ext.extensionPath)}, version ${ext.packageJSON.version}`);
  },
  'installed VSIX: packaged native programs run, not quarantined; bundled wisp-helper opens a WCZ (and an FSDB when given)': async () => {
    const ext = vscode.extensions.getExtension(id);
    const bin = path.join(ext.extensionPath, 'bin', `${process.platform}-${process.arch}`);
    const target = ext.packageJSON.__metadata && ext.packageJSON.__metadata.targetPlatform;
    if (!fs.existsSync(bin)) {
      // only a universal / non-Linux VSIX may come without native programs
      assert.ok(process.platform !== 'linux' || !target || target === 'universal' || target === 'undefined', `no ${bin} in a ${target} VSIX`);
      console.log(`  no bin/ for ${process.platform}-${process.arch} (VSIX target ${target || 'universal'})`);
      return;
    }
    const helper = path.join(bin, 'wisp-helper');
    // wisp-helper ships for linux-x64/arm64 and darwin-arm64/x64
    if (process.platform === 'linux' || process.platform === 'darwin') {
      fs.accessSync(helper, fs.constants.X_OK);
      const stats = await ask(helper, [{ id: 1, cmd: 'stats' }]);
      assert.ok(stats.some((r) => r.ready === true), 'no ready line: ' + JSON.stringify(stats).slice(0, 300));
      if (process.platform === 'darwin') {
        const q = cp.spawnSync('xattr', ['-l', helper], { encoding: 'utf8' }).stdout;
        assert.ok(!/com\.apple\.quarantine/.test(q), 'installed wisp-helper is quarantined: ' + q);
        console.log(`  wisp-helper xattrs: ${q.trim() ? q.trim().split('\n').map((l) => l.split(':')[0]).join(', ') : 'none'}`);
      }
    }
    const svm = path.join(bin, 'sv-model');
    if (fs.existsSync(svm)) {
      const d = fs.readdirSync(svm)[0];
      fs.accessSync(path.join(svm, d, 'cmux-sv-model'), fs.constants.X_OK);
      if (process.platform === 'darwin') {
        const q = cp.spawnSync('xattr', ['-l', path.join(svm, d, 'cmux-sv-model')], { encoding: 'utf8' }).stdout;
        console.log(`  sv-model xattrs: ${q.trim() ? q.trim().split('\n').map((l) => l.split(':')[0]).join(', ') : 'none'}`);
        assert.ok(!/com\.apple\.quarantine/.test(q), 'installed sv-model is quarantined: ' + q);
      }
      const r = cp.spawnSync(path.join(svm, d, 'cmux-sv-model'), [], { input: '{"id":1,"cmd":"version"}\n', timeout: 20000, encoding: 'utf8' });
      assert.ok(/"ok":true/.test(r.stdout), 'sv-model version: ' + r.stdout + r.stderr);
      console.log(`  sv-model ${d}: ${r.stdout.trim().split('\n').slice(-1)[0].slice(0, 160)}`);
    }
    if (!fs.existsSync(helper)) { return; }
    // E2E_WCZ (required) and E2E_FSDB (optional; internal fixture by path, never committed) open through the bundled helper
    const wcz = process.env.E2E_WCZ;
    assert.ok(wcz && fs.existsSync(wcz), 'E2E_WCZ (a WCZ, e.g. made with wcz-from-vcd) is required when the VSIX ships wisp-helper');
    for (const f of [wcz, process.env.E2E_FSDB].filter(Boolean)) {
      assert.ok(fs.existsSync(f), 'no such fixture ' + f);
      const r = await ask(helper, [{ id: 1, cmd: 'open', file: f }, { id: 2, cmd: 'stats' }], 120000);
      const open = r.find((x) => x.id === 1);
      assert.ok(open && open.result && !open.error, 'open failed: ' + JSON.stringify(r).slice(0, 400));
      const m = open.result.metadata || {};
      assert.ok(m.netlistIdCount > 0 && Array.isArray(open.result.top) && open.result.top.length, 'empty hierarchy: ' + JSON.stringify(open).slice(0, 300));
      console.log(`  wisp-helper opened ${path.basename(f)} (${open.result.source}): ${m.scopeCount} scopes, ${m.netlistIdCount} netlist ids, t ${m.timeStart}..${m.timeEnd} ${m.timeUnit}`);
    }
  },
  // Gate: the extension's VIEWER opens E2E_WCZ and E2E_FSDB through the bundled wisp-helper (not only the
  // helper binary on its own): *.wcz/*.fsdb in the customEditors selector, openWith the waveform editor, netlist loads,
  // a signal is added and a value read; the file's source is wisp (helper = the packaged binary), not the FSDB addon.
  'installed VSIX: the viewer opens E2E_WCZ and E2E_FSDB through the bundled wisp-helper': async () => {
    const ext = vscode.extensions.getExtension(id);
    const helper = path.join(ext.extensionPath, 'bin', `${process.platform}-${process.arch}`, 'wisp-helper');
    if (!fs.existsSync(helper)) { console.log(`  SKIP viewer FSDB/WCZ: no bundled wisp-helper for ${process.platform}-${process.arch}`); return; }
    const sel = (ext.packageJSON.contributes.customEditors || []).filter((e) => e.viewType === 'vaporview.waveformViewer')
      .flatMap((e) => e.selector || []).map((x) => x.filenamePattern);
    assert.ok(sel.includes('*.wcz'), 'customEditors selector lacks *.wcz: ' + JSON.stringify(sel));
    assert.ok(sel.includes('*.fsdb'), 'customEditors selector lacks *.fsdb: ' + JSON.stringify(sel));
    // earlier suites (wisp-common) point wispHelperPath at a helper; clear it so this gate proves the installed extension finds
    // its bundled helper on its own (the source check below compares realpaths with bin/<plat>-<arch>/wisp-helper)
    for (const t of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]) {
      await vscode.workspace.getConfiguration('vaporview').update('wispHelperPath', undefined, t).catch(() => {});
    }
    assert.ok(!String(vscode.workspace.getConfiguration('vaporview').get('wispHelperPath') || '').trim(), 'wispHelperPath is set; the bundled helper must be used');
    const files = [process.env.E2E_WCZ, process.env.E2E_FSDB].filter(Boolean);
    assert.ok(process.env.E2E_WCZ && process.env.E2E_FSDB, 'E2E_WCZ and E2E_FSDB are required when the VSIX ships wisp-helper');
    const until = async (fn, what, ms) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 250)); } };
    for (const f of files) {
      const uri = vscode.Uri.file(f);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'vaporview.waveformViewer');
      const ws = await until(async () => vscode.commands.executeCommand('vaporview.e2e.wispState', String(uri)), 'wisp state for ' + f, 120000);
      assert.strictEqual(ws.source, f.endsWith('.wcz') ? 'wcz' : 'fsdb', JSON.stringify(ws).slice(0, 300));
      assert.strictEqual(fs.realpathSync(ws.helper), fs.realpathSync(helper), 'not the bundled helper: ' + ws.helper);
      assert.strictEqual(ws.refused, null, 'refused: ' + ws.refused);
      const nl = await until(async () => { const n = await vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 6, 300); return n && n.vars && n.vars.length ? n : null; }, 'netlist ' + f, 120000);
      const v = nl.vars.find((x) => !x.unavailable && x.width >= 1 && /^[A-Za-z_][\w.]*$/.test(x.path)) || nl.vars[0]; // a plain path (no generate-block escapes)
      await webviewReady(until);
      const r = await until(async () => { const x = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time: 0, instancePaths: [v.path] }); return x && x.length && x[0].value !== undefined ? x : null; }, 'value of ' + v.path, 60000);
      // the webview shows the added row (its data comes from the helper: whole loads, or windows through the relay)
      const leaf = v.path.split('.').pop();
      const st = await addAndShow(uri, v.path, leaf, until, () => true, 'row ' + leaf + ' (' + v.path + ') in the webview');
      const ws2 = await vscode.commands.executeCommand('vaporview.e2e.wispState', String(uri));
      assert.strictEqual(ws2.refused, null, 'refused after load: ' + ws2.refused);
      console.log(`  viewer opened ${path.basename(f)}: source=${ws.source} helper=bundled, ${nl.vars.length}+ vars, ${v.path}@0=${JSON.stringify(r[0].value).slice(0, 60)}, webview rows ${st.rows.length}, relayed ${ws2.relayed}`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  },
  // Gate: the WINDOWED path big files use. E2E_FSDB_WINDOWED / E2E_WCZ_WINDOWED: a file with a signal over the
  // viewer's whole-load limit (350000 changes). The test finds that signal with the bundled helper's count, adds it, and
  // REQUIRES: the row is windowed in the webview, viewer requests went through the helper relay, a value reads.
  'installed VSIX: the viewer windows a big FSDB / WCZ signal through the bundled wisp-helper (relay)': async () => {
    const ext = vscode.extensions.getExtension(id);
    const helper = path.join(ext.extensionPath, 'bin', `${process.platform}-${process.arch}`, 'wisp-helper');
    if (!fs.existsSync(helper)) { console.log(`  SKIP windowed: no bundled wisp-helper for ${process.platform}-${process.arch}`); return; }
    const files = [process.env.E2E_FSDB_WINDOWED, process.env.E2E_WCZ_WINDOWED].join(' ').split(' ').filter(Boolean); // each may list several (space-separated)
    assert.ok(process.env.E2E_FSDB_WINDOWED && process.env.E2E_WCZ_WINDOWED, 'E2E_FSDB_WINDOWED and E2E_WCZ_WINDOWED are required when the VSIX ships wisp-helper');
    const until = async (fn, what, ms) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 250)); } };
    for (const f of files) {
      const uri = vscode.Uri.file(f);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'vaporview.waveformViewer');
      const ws = await until(async () => vscode.commands.executeCommand('vaporview.e2e.wispState', String(uri)), 'wisp state for ' + f, 180000);
      assert.strictEqual(ws.source, f.endsWith('.wcz') ? 'wcz' : 'fsdb');
      assert.strictEqual(fs.realpathSync(ws.helper), fs.realpathSync(helper), 'not the bundled helper: ' + ws.helper);
      const nl = await until(async () => { const n = await vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 8, 4000); return n && n.vars && n.vars.length ? n : null; }, 'netlist ' + f, 180000);
      const vars = nl.vars.filter((x) => !x.unavailable && x.signalId !== undefined && x.width >= 1);
      const ids = [...new Set(vars.map((x) => x.signalId))];
      const r = await ask(helper, [{ id: 1, cmd: 'open', file: f }, { id: 2, cmd: 'count', signalIds: ids, exact: false }], 180000);
      const c = r.find((x) => x.id === 2);
      const items = c && c.result ? (Array.isArray(c.result) ? c.result : Object.values(c.result).find(Array.isArray)) : [];
      const best = (items || []).filter((x) => typeof x.count === 'number').sort((a, b) => b.count - a.count)[0];
      assert.ok(best && best.count > 350000, `${path.basename(f)} has no signal over the 350000-change whole-load limit (max ${best && best.count}); it would not window`);
      const v = vars.find((x) => x.signalId === best.signalId);
      await webviewReady(until);
      const before = (await vscode.commands.executeCommand('vaporview.e2e.wispState', String(uri))).relayed;
      const leaf = v.path.split('.').pop();
      const st = await addAndShow(uri, v.path, leaf, until, (row) => row.windowed, `windowed row ${leaf} (${best.count} changes)`);
      const ws2 = await until(async () => { const w = await vscode.commands.executeCommand('vaporview.e2e.wispState', String(uri)); return w && w.relayed > before ? w : null; }, 'viewer requests through the helper relay', 60000);
      assert.strictEqual(ws2.refused, null, 'refused: ' + ws2.refused);
      const val = await until(async () => { const x = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time: 0, instancePaths: [v.path] }); return x && x.length && x[0].value !== undefined ? x : null; }, 'value of ' + v.path, 60000);
      // The page stays responsive while the big file opens and windows: no main-thread task over 200 ms (the
      // webview's longTasks e2e state, PerformanceObserver 'longtask', buffered from page start). Required for FSDB;
      // reported for WCZ. A missing longTasks state FAILS the FSDB case; only E2E_LONGTASKS_OPTIONAL=1 (rehearsals of builds
      // before the fix) turns that into a printed "not measured".
      const lst = await query({ kind: 'state' });
      const lt = lst && lst.longTasks;
      const ltText = lt ? `long tasks max ${Math.round(lt.max)} ms, recent ${JSON.stringify(lt.recent)}` : 'long tasks not measured (no longTasks state in this build)';
      if (f.endsWith('.fsdb')) {
        if (!lt) assert.ok(process.env.E2E_LONGTASKS_OPTIONAL === '1', `${path.basename(f)}: long tasks not measured (no longTasks state in this build; required)`);
        else assert.ok(lt.max <= 200, `${path.basename(f)}: page long task ${Math.round(lt.max)} ms > 200 ms during open (recent ${JSON.stringify(lt.recent)})`);
      }
      console.log(`  viewer windowed ${path.basename(f)}: ${v.path} (${best.count} changes) windowed=true, relayed ${ws2.relayed - before}, windows ${ws2.windows}, @0=${JSON.stringify(val[0].value).slice(0, 40)}, rows ${st.rows.length}; ${ltText}`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  },
};
module.exports = id ? tests : {};
