// vscode-port perf regression check : the page-module bridge's data path.
// In cmux the page modules read changes from the wellen worker in the same page. In the port they go
// page -> extension (src/cmux/data.ts) -> page. Baseline (direct backend): data.ts's own read in the extension
// host, no page hop, best of N, same run and box. Port number: host.signalChanges / host.signalPosedges from the
// page, best of N, cache cleared before each. FAIL when port > baseline * factor + slackMs
// (test/perf/BASELINE.json "bridge.*"; never loosen a tolerance to pass).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscode, assert, until, open, root, format, twin, closeAll } = require('./helpers.cjs');
const { cmuxData, page, pageReady } = require('./bridge-helpers.cjs');

const BASE = JSON.parse(fs.readFileSync(path.join(root, 'test/perf/BASELINE.json'), 'utf8'));
const N = 5;
const MAX_LOAD = 16; // 1-min load above which the gate prints SKIP instead of asserting

function bigVcd(edges) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vv-perf-')), 'clk.vcd');
  const out = ['$timescale 1ns $end\n$scope module top $end\n$var wire 1 ! clk $end\n$var wire 32 " cnt [31:0] $end\n$upscope $end\n$enddefinitions $end\n'];
  for (let i = 0; i < edges; i++) { out.push(`#${i * 10}\n1!\nb${i.toString(2)} "\n#${i * 10 + 5}\n0!\n`); }
  fs.writeFileSync(file, out.join(''));
  return file;
}

async function best(fn) { let b = Infinity; for (let i = 0; i < N; i++) { b = Math.min(b, await fn()); } return b; }

module.exports = {
  'perf: bridge signalChanges/posedges vs the direct extension read': async () => {
    // VCD: a generated 200K-cycle dump (wellen data path; the recorded bridge.* baseline). FSDB/WCZ: the repo's 1M-cycle
    // xr1m twin (test/trace/dumps/xr1m.icarus.<fmt>, read through wisp-helper), gated against the same-run direct read
    // under bridge.*.wisp. Each arm is the port's own path; nothing here compares formats.
    const wisp = format !== 'vcd';
    const edges = wisp ? 1000000 : 200000;
    const file = wisp ? twin(vscode.Uri.file(path.join(root, 'test/trace/dumps/xr1m.icarus.vcd'))).fsPath : bigVcd(edges);
    await open(vscode.Uri.file(file));
    await pageReady();
    const report = {};
    for (const [key, method, sig, pageFn] of wisp ? [
      ['bridge.signalChanges.wisp', 'signalChanges', 'tb_xr.r', 'signalChanges'],
      ['bridge.posedges.wisp', 'posedges', 'tb_xr.clk', 'signalPosedges'],
    ] : [
      ['bridge.signalChanges', 'signalChanges', 'top.cnt', 'signalChanges'],
      ['bridge.posedges', 'posedges', 'top.clk', 'signalPosedges'],
    ]) {
      const tol = BASE[key];
      assert.ok(tol && tol.factor && tol.slackMs !== undefined, 'BASELINE.json has ' + key);
      // warm the parser once (the first load parses the body); timing starts after
      await until(() => cmuxData(method, sig), 'warm ' + sig, 120000);
      const direct = await best(async () => {
        await cmuxData('reloaded');
        const r = await vscode.commands.executeCommand('vaporview.e2e.cmuxDataTimed', method, sig);
        if (!r || r.error) { throw new Error(String(r && r.error)); }
        return r.ms;
      });
      const viaPage = await best(async () => {
        await cmuxData('reloaded');
        return page(async (cmux, a) => {
          const v = await cmux.host.findLinkItem(a.sig, true);
          const t0 = performance.now();
          const r = await cmux.host[a.fn](v);
          if (!r || !r.length) { throw new Error('no data'); }
          return performance.now() - t0;
        }, { sig, fn: pageFn });
      });
      const limit = direct * tol.factor + tol.slackMs;
      report[key] = { direct: Math.round(direct), port: Math.round(viaPage), limit: Math.round(limit) };
      console.log(`PERF ${key} edges=${edges} direct=${direct.toFixed(1)}ms port=${viaPage.toFixed(1)}ms limit=${limit.toFixed(1)}ms load=${os.loadavg()[0].toFixed(1)} (DIAGNOSTIC)`);
      // Enforced at 1-min load <= MAX_LOAD (as bridge-adds): above it the page process is starved and the
      // two arms stop measuring the same thing (profile 11-25). The numbers are still printed; the tolerance is unchanged.
      const load = os.loadavg()[0];
      if (load > MAX_LOAD) { console.log(`SKIP perf: load ${load.toFixed(1)} > ${MAX_LOAD} (${key} port ${viaPage.toFixed(1)} ms, limit ${limit.toFixed(1)} ms)`); continue; }
      assert.ok(viaPage <= limit, `${key}: port ${viaPage.toFixed(1)} ms > ${limit.toFixed(1)} ms (direct ${direct.toFixed(1)} ms)`);
    }
    await closeAll(); // the 1M-cycle viewer keeps loading in the background: the next suite must not share the host with it
  },
};
