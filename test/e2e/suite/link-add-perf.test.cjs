// vscode-port perf check, DIAGNOSTIC: adding 100 rows to a big FSDB with the source link active.
// Each row add runs the link's enum lookup (slang). It must not start slang-server per add (profiled:
// 22-61 ms of spawn + dispose per add when slang-server could not start).
// Arms: (A) slang-server unavailable (slangServerPath = a missing file), (B) slang-server available (fixture sources).
// add-100 = first addVariable -> 100 rows displayed and no enum lookup pending. Also prints the slang-server starts.
// Needs E2E_BIG_FSDB (an FSDB file) and E2E_BIG_PATHS (100 signal paths in it, one per line); without them it prints
// SKIP (the file is internal and lives on the test host). SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, activate, closeAll } = require('./helpers.cjs');
const fs = require('fs');

const BIG = process.env.E2E_BIG_FSDB || '';
const PATHS = process.env.E2E_BIG_PATHS || '';

async function displayed(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  let n = 0;
  const walk = (xs) => (xs || []).forEach((x) => { n++; walk(x.children); });
  walk(s && s.displayedSignals);
  return n;
}
const status = () => vscode.commands.executeCommand('vaporview.sourceLink.status');

async function arm(name, paths) {
  await closeAll();
  const uri = String(await open(vscode.Uri.file(BIG)));
  await until(async () => (await displayed(uri)) === 0, `${name}: fresh viewer`, 30000, 200);
  const s0 = await status();
  const t0 = performance.now();
  for (const p of paths) { await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p }); }
  const tSent = performance.now();
  let n = 0;
  try { await until(async () => (n = await displayed(uri)) >= paths.length, `${name}: ${paths.length} rows`, 120000, 50); } catch (e) {
    const st = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
    const names = []; const walk = (xs) => (xs || []).forEach((x) => { names.push(x.instancePath || x.name); walk(x.children); }); walk(st && st.displayedSignals);
    const missing = paths.filter((p) => !names.includes(p));
    throw new Error(`${name}: ${n} of ${paths.length} rows shown after 120 s; first missing ${JSON.stringify(missing.slice(0, 5))}; shown ${JSON.stringify(names.slice(0, 5))}; state keys ${JSON.stringify(Object.keys(st || {}))}`);
  }
  const tRows = performance.now();
  await until(async () => (await status()).enumsPending === 0, `${name}: enum lookups done`, 300000, 50);
  const tDone = performance.now();
  const s1 = await status();
  const starts = s1.slangCounts.serverStarts - s0.slangCounts.serverStarts;
  const connects = s1.slangCounts.connects - s0.slangCounts.connects;
  console.log(`PERF link.add100 arm=${name} rows=${paths.length} sent=${(tSent - t0).toFixed(0)}ms rows=${(tRows - t0).toFixed(0)}ms done=${(tDone - t0).toFixed(0)}ms slangConnects=${connects} slangServerStarts=${starts} route=${s1.slang} (DIAGNOSTIC)`);
  return { starts, connects, done: tDone - t0 };
}

module.exports = {
  'perf: add 100 rows to a big FSDB, slang-server unavailable then available (DIAGNOSTIC)': async () => {
    if (!BIG || !PATHS || !fs.existsSync(BIG) || !fs.existsSync(PATHS)) { console.log('SKIP link.add100: E2E_BIG_FSDB / E2E_BIG_PATHS not set (internal file on the test host)'); return; }
    const paths = fs.readFileSync(PATHS, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    assert.strictEqual(paths.length, 100, 'E2E_BIG_PATHS lists 100 paths');
    await activate();
    const cfg = vscode.workspace.getConfiguration('vaporview.sourceLink');
    const before = { path: cfg.get('slangServerPath'), conn: cfg.get('slangConnection') };
    try {
      await cfg.update('slangConnection', 'own', vscode.ConfigurationTarget.Global);
      await cfg.update('slangServerPath', '/nonexistent/slang-server', vscode.ConfigurationTarget.Global);
      const a = await arm('A-no-slang', paths);
      await cfg.update('slangServerPath', before.path || undefined, vscode.ConfigurationTarget.Global);
      const b = await arm('B-slang', paths);
      assert.ok(a.starts <= 1, `slang-server started ${a.starts} times for 100 adds without a usable slang-server (want at most 1)`);
      assert.ok(b.starts <= 1, `slang-server started ${b.starts} times for 100 adds (want at most 1: one connection kept)`);
    } finally {
      await cfg.update('slangServerPath', before.path || undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('slangConnection', before.conn || undefined, vscode.ConfigurationTarget.Global);
    }
  },
};
