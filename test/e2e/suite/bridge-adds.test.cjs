// vscode-port: single adds that arrive together are coalesced. 100 waveformViewer.addVariable calls (the
// API, terminal links and Add Variable by Path take this path) must paint within 2x of one renderSignals of the same
// 100 ids. File: E2E_ADDS_<FORMAT> (e.g. E2E_ADDS_FSDB = bigsoc-big.fsdb), else bigsoc25k.<format> from
// E2E_FSDB_DIR; SKIP without either or under E2E_FORMAT=vcd. n=5 per arm, interleaved, best of each (as bridge-perf);
// gate on paint (rows shown, their data and visible window tiles answered; see painted()).
// Coalescing: adds that overlap (a caller that does not await each one) always go as one batch. A caller that awaits
// each addVariable gives the extension no sign that another add follows (an await that crosses a macrotask leaves the
// microtask queue empty between calls), so those are batched by a quiet window (2x the widest gap seen, 8-50 ms,
// first add held at most 250 ms; viewer_provider.ts beginAdd): the page must get at most 10 add messages for 100.
// DIAGNOSTIC numbers; the gate is the ratio, same run, same file.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), os = require('os'), path = require('path');
const { vscode, assert, until, open, closeAll, query, sleep, format } = require('./helpers.cjs');
const { cmuxData, page, pageReady } = require('./bridge-helpers.cjs');

const now = () => Number(process.hrtime.bigint()) / 1e6;
const GATE = 2, TOTAL_MS = 1500, MAX_LOAD = 16;

function bigFile() {
  const env = process.env['E2E_ADDS_' + format.toUpperCase()];
  if (env && fs.existsSync(env)) return env;
  const dir = process.env.E2E_FSDB_DIR || '';
  const f = dir && path.join(dir, 'bigsoc25k.' + format);
  return f && fs.existsSync(f) ? f : null;
}
async function rowCount(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  let n = 0;
  const walk = (xs) => (xs || []).forEach((x) => { if (x.dataType === 'netlist-variable') n++; walk(x.children); });
  walk(s && s.displayedSignals);
  return n;
}
// Painted = the rows' data and their visible window tiles answered (no data request, no window request in flight,
// two polls running). Background hybrid whole loads (window_cache.ts hybridStep: one signal per query, HYBRID_LOADS in
// flight) are left out: on 11-25 they made "fully idle" bimodal in BOTH arms (~0.1-0.2 s or ~1.5-2.5 s; visible tiles
// were done at 66-82 ms in every rep, then +6 to +15 whole loads ran one after another).
async function painted() {
  let ok = 0;
  await until(async () => {
    const r = await query({ kind: 'idle' });
    const w = (await query({ kind: 'state' })).windowing;
    const done = r && !r.requestActive && !r.queued && !r.navBusy && w && w.stats && w.stats.inflight === 0;
    ok = done ? ok + 1 : 0;
    return ok >= 2;
  }, 'painted', 600000, 20);
}
// 100 variables (ids) breadth first from the top
async function hundredVars() {
  const out = [];
  const queue = (await until(async () => { const t = await cmuxData('children'); return t && t.length ? t : null; }, 'top scopes'))
    .filter((k) => k.kind === 'scope').map((k) => k.name);
  while (queue.length && out.length < 100) {
    const scope = queue.shift();
    for (const k of (await cmuxData('children', scope)) || []) {
      if (k.kind === 'var' && k.signalId >= 0 && !out.includes(k.netlistId) && out.length < 100) out.push(k.netlistId); // declared-without-values items never become rows
      else if (k.kind === 'scope') queue.push(scope + '.' + k.name);
    }
  }
  return out;
}

module.exports = {
  'single adds coalesce: 100 API adds paint within 2x of one batch add (FSDB, then WCZ)': async () => {
    if (format === 'vcd') { console.log('SKIP single-add gate: FSDB/WCZ only (E2E_FORMAT=vcd)'); return; }
    const file = bigFile();
    if (!file) { console.log(`SKIP single-add gate: no E2E_ADDS_${format.toUpperCase()} and no bigsoc25k.${format} in E2E_FSDB_DIR`); return; }
    const t = { single: [], batch: [] }, batches = [], cmd = { single: [], batch: [] };
    for (let rep = 1; rep <= 5; rep++) {
      for (const arm of rep % 2 ? ['batch', 'single'] : ['single', 'batch']) {
        await closeAll(); await sleep(1000);
        const uri = String(await open(vscode.Uri.file(file)));
        await pageReady();
        const ids = await hundredVars();
        assert.strictEqual(ids.length, 100, '100 variables in ' + path.basename(file));
        await painted();
        // count the add messages the page gets: coalesced, 100 adds are a few batches, not 100
        await page(() => { window.__e2eAdds = 0; if (!window.__e2eAddsTap) { window.__e2eAddsTap = true; window.addEventListener('message', (e) => { if (e.data && e.data.command === 'add-variable') window.__e2eAdds++; }); } return true; });
        const t0 = now();
        if (arm === 'single') { for (const id of ids) await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, netlistId: id }); }
        else await vscode.commands.executeCommand('vaporview.e2e.renderBatch', uri, ids, true); // same selection as the single arm (last row): a selected row's edge prefetch is not batching cost
        cmd[arm].push(now() - t0); // the caller's own command calls (100 awaited executeCommand for single)
        await until(async () => (await rowCount(uri)) >= 100, '100 rows (' + arm + ')', 600000, 20);
        await painted();
        t[arm].push(now() - t0);
        const msgs = await page(() => window.__e2eAdds);
        if (arm === 'single') { batches.push(msgs); assert.ok(msgs <= 10, `100 single adds reached the page as ${msgs} add messages (coalesced: a few)`); }
        assert.strictEqual(await rowCount(uri), 100, arm + ': exactly 100 rows');
      }
    }
    // Coalescing gate: paint measured from the last command's return (the caller's own command calls are reported, not
    // gated here), single <= GATE x batch. User-visible guard: 100 single adds end to end <= TOTAL_MS (skipped, with
    // the reason, when the host's 1-min load is above MAX_LOAD).
    const after = (arm) => t[arm].map((x, i) => x - cmd[arm][i]);
    const s = Math.min(...after('single')), b = Math.min(...after('batch'));
    const total = Math.min(...t.single), load = os.loadavg()[0];
    console.log(`PERF adds ${path.basename(file)} paint after last command: single=${after('single').map(Math.round)} batch=${after('batch').map(Math.round)} best ${Math.round(s)} / ${Math.round(b)} ms = ${(s / b).toFixed(2)}x (gate ${GATE}x); command time single=${cmd.single.map(Math.round)} batch=${cmd.batch.map(Math.round)}; end to end single best ${Math.round(total)} ms (bound ${TOTAL_MS} ms at load <= ${MAX_LOAD}; load ${load.toFixed(1)}); add messages per 100 single adds: ${batches} (DIAGNOSTIC)`);
    // vscode-port: the paint ratio is load-gated too; above MAX_LOAD the page is starved by
    // other builds and one fast batch sample (96 ms among 440-594) decides it. SKIP prints the numbers, never a silent pass.
    if (load <= MAX_LOAD) { assert.ok(s <= GATE * b, `100 single adds paint ${Math.round(s)} ms after the last command > ${GATE}x one batch ${Math.round(b)} ms`); }
    else { console.log(`SKIP coalescing gate: host load ${load.toFixed(1)} > ${MAX_LOAD} (single ${Math.round(s)} ms, batch ${Math.round(b)} ms, ${(s / b).toFixed(2)}x, gate ${GATE}x)`); }
    if (load <= MAX_LOAD) { assert.ok(total <= TOTAL_MS, `100 single adds end to end ${Math.round(total)} ms > ${TOTAL_MS} ms (load ${load.toFixed(1)})`); }
    else { console.log(`SKIP end-to-end bound: host load ${load.toFixed(1)} > ${MAX_LOAD}`); }
    await closeAll();
  },
};
