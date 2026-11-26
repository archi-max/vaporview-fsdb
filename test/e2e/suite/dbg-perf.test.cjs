// vscode-port perf check, DIAGNOSTIC: a step's latency end to end in VS Code.
// Latency = workbench.action.debug.stepOver (F10) called -> the adapter's `stopped` event (as VS Code receives it), and
// -> the viewer reports the marker at the new cycle (waveformViewer.getViewerState polled every 5 ms). n = DBG_PERF_N
// (default 21) steps after 2 warm-up, alternating forward and back on fixtures/dbg.
// Gate (test/perf/BASELINE.json "dbg.stepLatency"): stop p95 <= baseline p95 x factor + slackMs, per platform. There is
// no cmux baseline: cmux's step goes Swift -> callAsyncJavaScript -> the page and was never timed end to end, so the
// baseline is the port's own first recorded run (the engine-level step is gated against cmux in test/perf/dbg-perf.cjs).
// Without recorded numbers the test passes and prints a RECORD line to copy into BASELINE.json.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, sleep, root } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');
const fs = require('fs');
const path = require('path');

const N = Number(process.env.DBG_PERF_N || 21);
const WARM = 2;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

let waiter = null;
let tracker = null;

module.exports = D.suite({
  'perf: a step (F10) -> stopped event and viewer marker (p50/p95, DIAGNOSTIC)': async () => {
    tracker = tracker || vscode.debug.registerDebugAdapterTrackerFactory(D.DT, {
      createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => { if (m.type === 'event' && m.event === 'stopped' && waiter) { const w = waiter; waiter = null; w(performance.now()); } } }),
    });
    const { uri } = await D.start();
    // From the middle of the run so both directions move.
    await D.stopAfter(() => D.custom('step', { by: 20 }));
    const stopMs = [], markerMs = [];
    for (let i = 0; i < N + WARM; i++) {
      const cmd = i % 2 ? 'workbench.action.debug.stepBack' : 'workbench.action.debug.stepOver';
      const stopped = new Promise((resolve, reject) => { waiter = resolve; setTimeout(() => reject(new Error('no stopped event')), 10000); });
      const t0 = performance.now();
      await vscode.commands.executeCommand(cmd);
      const tStop = await stopped;
      const want = (await D.session()).time;
      let tMarker = null;
      for (const end = performance.now() + 10000; performance.now() < end;) {
        const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
        if (v && v.markerTime === want) { tMarker = performance.now(); break; }
        await sleep(5);
      }
      assert.ok(tMarker !== null, `viewer marker at ${want}`);
      if (i >= WARM) { stopMs.push(tStop - t0); markerMs.push(tMarker - t0); }
      await sleep(30);
    }
    const s50 = pct(stopMs, 0.5), s95 = pct(stopMs, 0.95), m50 = pct(markerMs, 0.5), m95 = pct(markerMs, 0.95);
    console.log(`PERF dbg.stepLatency n=${stopMs.length} stop p50=${s50.toFixed(1)}ms p95=${s95.toFixed(1)}ms; marker p50=${m50.toFixed(1)}ms p95=${m95.toFixed(1)}ms (DIAGNOSTIC)`);
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'test/perf/BASELINE.json'), 'utf8'))['dbg.stepLatency'];
    const base = entry && entry.byPlatform && entry.byPlatform[process.platform];
    if (!base || typeof base.p95Ms !== 'number') {
      console.log(`RECORD dbg.stepLatency ${process.platform} p50Ms=${s50.toFixed(1)} p95Ms=${s95.toFixed(1)} markerP50Ms=${m50.toFixed(1)} markerP95Ms=${m95.toFixed(1)}`);
      return;
    }
    const factor = base.factor ?? entry.factor, slackMs = base.slackMs ?? entry.slackMs;
    assert.ok(typeof factor === 'number' && typeof slackMs === 'number', 'dbg.stepLatency in BASELINE.json needs numeric factor and slackMs');
    const limit = base.p95Ms * factor + slackMs;
    assert.ok(s95 <= limit, `step -> stopped p95 ${s95.toFixed(1)} ms > ${limit.toFixed(1)} ms (baseline p95 ${base.p95Ms} x ${factor} + ${slackMs})`);
  },
});
