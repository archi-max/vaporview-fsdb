// vscode-port: the installed VSIX's first Trace uses the trace sidecar shipped prebuilt in the VSIX
// (bin/<platform>-<arch>/sv-model/<hash>-<arch>/), never a first-use slang C++ build (minutes). Run by
// test/e2e/run-installed.mjs, which gives the extension a fresh, empty VAPORVIEW_CMUX_CACHE. Checks:
//  - the VSIX ships a prebuilt for this platform;
//  - the first Trace Driver (cmux case A dout@60, the FSDB / WCZ twin under E2E_FORMAT) answers within
//    E2E_FIRST_TRACE_MS (default 60 s; a build takes ~5 min) and the sidecar never reported a build;
//  - the running sidecar runs from the packaged dir, and nothing was built into the fresh cache.
// Outside an installed run (no E2E_EXT_ID) or on Windows (no prebuilt): no tests.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { vscode, assert, open, root } = require('./helpers.cjs');
const { sameTwin, FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');

const ID = process.env.E2E_EXT_ID || '';
const BOUND = Number(process.env.E2E_FIRST_TRACE_MS || 60000);
const dir = path.join(root, 'test/e2e/fixtures/trace');
const state = () => vscode.commands.executeCommand('vaporview.e2e.traceState');

function scriptOf(pid) {
  if (process.platform === 'linux') { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); }
  return cp.execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
}

module.exports = !ID || process.platform === 'win32' ? {} : {
  'installed VSIX: first Trace uses the prebuilt trace sidecar (no build, fresh cache, time-bounded)': async () => {
    const ext = vscode.extensions.getExtension(ID);
    assert.ok(ext, 'extension ' + ID);
    const plat = `${process.platform}-${process.arch}`;
    const pre = path.join(ext.extensionPath, 'bin', plat, 'sv-model');
    const shipped = fs.existsSync(pre) ? fs.readdirSync(pre).filter((d) => fs.existsSync(path.join(pre, d, 'cmux-sv-model'))) : [];
    assert.ok(shipped.length === 1, `VSIX ships one prebuilt sidecar for ${plat}: ${JSON.stringify(shipped)}`);
    const cache = process.env.VAPORVIEW_CMUX_CACHE || '';
    assert.ok(cache, 'run-installed gives a fresh VAPORVIEW_CMUX_CACHE');
    const cached = () => (fs.existsSync(path.join(cache, 'sv-model')) ? fs.readdirSync(path.join(cache, 'sv-model')) : []);
    assert.deepStrictEqual(cached(), [], 'cache empty before the first Trace');
    if (FORMAT) { assert.ok(await useHelper('trace prebuilt ' + FORMAT), 'wisp-helper for E2E_FORMAT=' + FORMAT); }
    const cfg = vscode.workspace.getConfiguration('vaporview');
    await cfg.update('trace.designArgs', ['-f', 'a.f'], vscode.ConfigurationTarget.Global);
    await cfg.update('trace.designRoot', dir, vscode.ConfigurationTarget.Global);
    let sawBuild = null;
    const poll = setInterval(async () => { try { const s = await state(); if (s && s.building && !sawBuild) { sawBuild = s.building; } } catch { /* next tick */ } }, 250);
    try {
      const uri = String(await open(vscode.Uri.file(sameTwin(path.join(dir, 'a.vcd')))));
      const t0 = Date.now();
      const st = await Promise.race([vscode.commands.executeCommand('vaporview.traceDriver', { uri, designPath: 'tb_a.dut.dout', time: 60 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`first Trace took over ${BOUND} ms (a sidecar build?)`)), BOUND))]);
      const ms = Date.now() - t0;
      assert.ok(st && !st.error && st.stmt && st.stmt.src === 'dout <= stage;', 'first trace: ' + JSON.stringify(st).slice(0, 300));
      const s = await state();
      assert.ok(!sawBuild && !s.building, 'sidecar build reported: ' + JSON.stringify(sawBuild || s.building));
      assert.ok(s.sidecarPid, 'sidecar running');
      const cmd = scriptOf(s.sidecarPid);
      // (sv-model.sh execs the binary: the pid shows either, both inside the packaged dir)
      assert.ok(cmd.includes(path.join(pre, shipped[0]) + path.sep), `sidecar runs from the packaged dir: ${cmd}`);
      assert.deepStrictEqual(cached(), [], 'nothing built into the fresh cache');
      console.log(`  trace prebuilt ${plat} ${FORMAT || 'vcd'}: first Trace ${ms} ms (bound ${BOUND}), sidecar ${shipped[0]}, timings ${JSON.stringify(s.timings)}`);
    } finally {
      clearInterval(poll);
      await cfg.update('trace.designArgs', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('trace.designRoot', undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  },
};
