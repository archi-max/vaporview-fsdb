// vscode-port: a row's window refusals that retrying cannot fix. "history over this request's memory room" (the
// view is too wide for the helper's memory): the row says "too dense at this zoom (zoom in to read)" and is asked
// again only once the user zooms in. The computed signals' memory-bound refusal: "no value (...)" for the whole open.
// The errors are fed to the viewer as the helper words them (both depend on the machine's memory to happen for real).
const { vscode, assert, until, open, query, sleep } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');
module.exports = {
  'window refusals: too dense at this zoom (retried after zooming in), computed memory bound (never retried)': async () => {
    if (!(await w.useHelper('window limits'))) return;
    const uri = String(await open('trace/h.vcd'));
    assert.deepStrictEqual(await query({ kind: 'hybrid', on: false }), { hybrid: false });
    try {
      await w.add(uri, ['tb_h.dut.q', 'tb_h.dut.a']);
      const st0 = await w.state();
      const end = Number(st0.timeStop) || 100;
      const sid = (n) => st0.rows.find((r) => r.name === n).signalId;
      const sig = async (n) => (await w.state()).windowing.signals.find((x) => x.signalId === sid(n));
      await until(async () => { const s = await sig('q'); return s && s.windows > 0 ? s : null; }, 'q windowed');
      const d = await query({ kind: 'windowFail', name: 'q', msg: "history over this request's memory room (0 MiB; the helper's memory bound)" });
      assert.ok(d.denseZoom > 0 && !d.noValue, JSON.stringify(d));
      await query({ kind: 'zoomRange', t0: 0, t1: end });  // a move that does not zoom in: still not asked
      await sleep(3000);
      const s1 = await sig('q');
      assert.ok(s1.denseZoom > 0 && s1.fails === d.fails && s1.inflight === 0, 'asked again without zooming in: ' + JSON.stringify(s1));
      await query({ kind: 'zoomRange', t0: 0, t1: Math.max(4, Math.floor(end / 8)) });
      const s2 = await until(async () => { const s = await sig('q'); return s && s.denseZoom === 0 && s.fails === 0 && s.windows > 0 ? s : null; }, 'q read again after zooming in');
      console.log(`  window limits: dense at zoom ${d.denseZoom} -> read again after zooming in (windows ${s2.windows})`);
      const m = await query({ kind: 'windowFail', name: 'a', msg: "computed names need about 3197 MiB for this file's derivation records and planner tables (an estimate), over this request's memory room (462 MiB; the helper's memory bound)" });
      assert.strictEqual(m.noValue, 'no value (computed signals need more memory than vaporview.wisp.planBudgetMB allows)');
      await query({ kind: 'zoomRange', t0: 0, t1: Math.max(2, Math.floor(end / 32)) });
      await sleep(3000);
      const a = await sig('a');
      assert.ok(a.noValue && a.fails === m.fails && a.inflight === 0, 'memory-bound row asked again: ' + JSON.stringify(a));
    } finally {
      await query({ kind: 'hybrid', on: true });
    }
  },
};
