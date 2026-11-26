// vscode-port perf check, DIAGNOSTIC: inline-value refresh latency in the SystemVerilog editor.
// Latency = waveformViewer.setMarker called -> the link's onDidRefreshInlineValues fires for dut.sv with the value
// for the new marker time on the `state` line (decorations are set in the same step, just before the event).
// n = LINK_PERF_N (default 21) marker moves, alternating between two times where `state` differs; 2 warm-up moves.
// Gate (test/perf/BASELINE.json "link.inlineValues"): p95 <= baseline p95 x factor + slackMs, per platform and dump format
// (byPlatform["linux-fsdb"], ["darwin-wcz"], ...; E2E_FORMAT, default fsdb: the FSDB number is the gated one, ; VCD keys
// are plain "linux" / "darwin"). There is no cmux
// baseline yet (cmux's overlay was never timed), so the baseline is the port's own first recorded run.
// Without recorded numbers the test passes and prints a RECORD line to copy into BASELINE.json.
// Needs slang-server (as link-p5). SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, activate, root, format } = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

const linkDir = path.join(root, 'test/e2e/fixtures/link');
const dut = vscode.Uri.file(path.join(linkDir, 'dut.sv'));
const tb = vscode.Uri.file(path.join(linkDir, 'tb.sv'));
const ENUM = { '000': 'IDLE', '001': 'FETCH', '100': 'DECODE', '101': 'EXEC', '111': 'DONE' };
const N = Number(process.env.LINK_PERF_N || 21);
const WARM = 2;
const MAX_LOAD = 16; // 1-min load above which the gate prints SKIP instead of asserting (as bridge-perf)

async function valueAt(uri, p, time) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: [p] });
  let v = r && r[0] && r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return String(Array.isArray(v) ? v[v.length - 1] : v).padStart(3, '0');
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

module.exports = {
  'perf: inline values refresh after a marker move (p50/p95, DIAGNOSTIC)': async () => {
    const api = (await activate()).exports.sourceLink;
    await until(async () => {
      const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: tb.toString() });
      return Array.isArray(r) && r.includes('tb');
    }, 'slang top level tb', 60000, 1000);
    const uri = String(await open('link/fsm.vcd'));
    const doc = await vscode.workspace.openTextDocument(dut);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    let stateLine = -1;
    for (let i = 0; i < doc.lineCount; i++) { if (/state_t state/.test(doc.lineAt(i).text)) { stateLine = i; break; } }
    let t1 = 0, t2 = 0, v1, v2;
    for (let t = 15; t < 600 && !t2; t += 10) {
      const v = await valueAt(uri, 'tb.dut.u_ctl.state', t);
      if (!ENUM[v]) { continue; }
      if (!t1) { t1 = t; v1 = v; } else if (v !== v1) { t2 = t; v2 = v; }
    }
    assert.ok(t1 && t2, 'two marker times with different state');
    const moves = [];
    for (let i = 0; i < N + WARM; i++) { moves.push(i % 2 ? [t2, ENUM[v2]] : [t1, ENUM[v1]]); }
    // Start from the other time so the first move changes the value.
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t2 });
    await until(() => (api.inlineValues(dut).find((x) => x.line === stateLine && x.name === 'state') || {}).value === ENUM[v2], 'initial inline value', 30000, 100);
    const ms = [];
    const starts = []; // performance.now() at each measured setMarker (same clock as the link's, both in the extension host)
    for (const [i, [time, want]] of moves.entries()) {
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { sub.dispose(); reject(new Error(`no refresh to ${want} at ${time}`)); }, 10000);
        const sub = api.onDidRefreshInlineValues((u) => {
          if (u !== dut.toString()) { return; }
          const s = api.inlineValues(dut).find((x) => x.line === stateLine && x.name === 'state');
          if (s && s.value === want) { clearTimeout(timer); sub.dispose(); resolve(); }
        });
      });
      const t0 = performance.now();
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time });
      await done;
      if (i >= WARM) { ms.push(performance.now() - t0); starts.push(t0); }
    }
    const p50 = pct(ms, 0.5), p95 = pct(ms, 0.95);
    const st = await vscode.commands.executeCommand('vaporview.sourceLink.status');
    // Where the time goes (DIAGNOSTIC): the link's own split of its last refreshes, slowest 3 and the median.
    const tms = (st.inlineTimings || []).slice(-(ms.length + 8)).filter((x) => !x.cancelled);
    const fmt = (x) => x ? `total=${x.total.toFixed(1)} wait=${x.wait.toFixed(1)} instances=${x.instances.toFixed(1)} scope=${x.scope.toFixed(1)} values=${x.values.toFixed(1)}` : '-';
    const byTotal = [...tms].sort((a, b) => b.total - a.total);
    // Per slow sample: setMarker -> the link's marker event (the viewer's round trip), -> refresh start, refresh length.
    const evs = st.markerEvents || [], all = st.inlineTimings || [];
    const slow = ms.map((m, i) => ({ m, t0: starts[i] })).sort((a, b) => b.m - a.m).slice(0, 3).map(({ m, t0 }) => {
      const ev = evs.find((e) => e >= t0), r = all.find((x) => x.at >= t0 && !x.cancelled);
      return `${m.toFixed(1)}ms: event+${ev !== undefined ? (ev - t0).toFixed(1) : '?'} refreshStart+${r ? (r.at - t0).toFixed(1) : '?'} refresh=${r ? r.total.toFixed(1) : '?'}`;
    });
    console.log(`SLOW link.inlineValues format=${format} ${slow.join(' | ')}`);
    console.log(`SPLIT link.inlineValues format=${format} refreshes=${tms.length} cancelled=${(st.inlineTimings || []).filter((x) => x.cancelled).length} median{${fmt(byTotal[Math.floor(byTotal.length / 2)])}} slowest{${byTotal.slice(0, 3).map(fmt).join(' | ')}} test-ms-sorted-top3=${[...ms].sort((a, b) => b - a).slice(0, 3).map((x) => x.toFixed(1)).join(',')}`);
    console.log(`PERF link.inlineValues format=${format} route=${st.slang} n=${ms.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${Math.max(...ms).toFixed(1)}ms (DIAGNOSTIC)`);
    // Baselines per platform (the Mac runs a real window, Linux runs under xvfb on a shared box).
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'test/perf/BASELINE.json'), 'utf8'))['link.inlineValues'];
    const key = format === 'vcd' ? process.platform : `${process.platform}-${format}`;
    const base = entry && entry.byPlatform && entry.byPlatform[key];
    if (!base || typeof base.p95Ms !== 'number') {
      console.log(`RECORD link.inlineValues ${key} p50Ms=${p50.toFixed(1)} p95Ms=${p95.toFixed(1)}`);
      return;
    }
    // factor and slackMs live on the entry (shared by both platforms); a per-platform value overrides it.
    const factor = base.factor ?? entry.factor, slackMs = base.slackMs ?? entry.slackMs;
    assert.ok(typeof factor === 'number' && typeof slackMs === 'number', 'link.inlineValues in BASELINE.json needs numeric factor and slackMs');
    const limit = base.p95Ms * factor + slackMs;
    // Enforced at 1-min load <= MAX_LOAD (bridge-perf 82a3375): above it the host is starved and p95 measures the
    // queue, not the refresh. The numbers are printed; the tolerance is unchanged.
    const load = os.loadavg()[0];
    if (load > MAX_LOAD) { console.log(`SKIP perf: load ${load.toFixed(1)} > ${MAX_LOAD} (link.inlineValues p95 ${p95.toFixed(1)} ms, limit ${limit.toFixed(1)} ms)`); return; }
    assert.ok(p95 <= limit, `inline-value refresh p95 ${p95.toFixed(1)} ms > ${limit.toFixed(1)} ms (baseline p95 ${base.p95Ms} x ${factor} + ${slackMs})`);
  },
};
