// vscode-port: a computed signal the helper refuses for the whole open (its first build is over the memory bound,
// vaporview.wisp.planBudgetMB) shows "no value (...)" across its row, as a warning, and is not asked again.
// Needs a large FSDB (default: the CVA6 demo under ~/vaporview-demo; E2E_CVA6_FSDB overrides); SKIPs without it.
const fs = require('fs'), os = require('os'), path = require('path');
const { vscode, assert, until, open, sleep, closeAll } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');
const FSDB = process.env.E2E_CVA6_FSDB || path.join(os.homedir(), 'vaporview-demo/cva6-cm5/cva6-cm5.fsdb');
const ROW = 'ariane_tb.dut.i_ariane.i_cva6.controller_i.flush_ex_o';
const TEXT = 'no value (computed signals need more memory than vaporview.wisp.planBudgetMB allows)';
module.exports = {
  'computed row over the memory bound: no value across the row, no retries, warning': async () => {
    if (!(await w.useHelper('computed room'))) return;
    if (!fs.existsSync(FSDB)) { console.log(`SKIP computed room: no ${FSDB}`); return; }
    await w.setSetting('wisp.outsideWrites', 'none');
    await w.setSetting('wisp.planBudgetMB', '1024');
    try {
      const uri = await open(vscode.Uri.file(FSDB));
      const ws = await w.wispState(uri);
      assert.ok(ws.envKeys.includes('WISP_WORKER_RSS_MB=1024'), JSON.stringify(ws.envKeys));
      // a stored row in the same view: a whole-batch refusal must not mark it (it loads when asked alone)
      const net = await vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 8, 400000);
      const c = ws.computed;
      const P = ROW.slice(0, ROW.lastIndexOf('.') + 1);
      const stored = ((net && net.vars) || []).find((v) => v.path.startsWith(P) && v.signalId != null && !(v.signalId >= c.first && v.signalId < c.first + c.n) && v.width === 1);
      assert.ok(stored, 'a stored 1-bit signal in ' + P);
      await w.add(uri, [ROW, stored.path]);
      const rows = (await w.state()).rows;
      const sid = rows.find((r) => r.name === 'flush_ex_o').signalId;
      const sidStored = rows.find((r) => r.name === stored.path.split('.').pop()).signalId;
      const sig = async () => (await w.state()).windowing.signals.find((x) => x.signalId === sid);
      const s1 = await until(async () => { const s = await sig(); return s && s.noValue ? s : null; }, 'no value on the computed row', 60000);
      assert.strictEqual(s1.noValue, TEXT);
      assert.ok(/memory room/.test(s1.failMsg), s1.failMsg);
      await sleep(6000);  // the old backoff would have asked again 3+ times by now
      const s2 = await sig();
      assert.strictEqual(s2.fails, s1.fails, `asked again: fails ${s1.fails} -> ${s2.fails}`);
      assert.strictEqual(s2.inflight, 0);
      const st = await until(async () => { const x = (await w.state()).windowing.signals.find((y) => y.signalId === sidStored); return x && x.windows > 0 ? x : null; }, 'the stored row loads', 60000);
      assert.strictEqual(st.noValue, '', 'stored row marked: ' + st.noValue);
      const after = await w.wispState(uri);
      assert.strictEqual(after.statusLevel, 'warning', `status ${after.statusLevel}`);
      console.log(`  computed room: ${s2.noValue}; fails ${s2.fails}; status ${after.statusLevel}`);
    } finally {
      await w.setSetting('wisp.outsideWrites', undefined);
      await w.setSetting('wisp.planBudgetMB', undefined);
      await closeAll();
    }
  },
  // under auto the worker bound is at most 8 GiB, so a computed build over the room is refused at once (the
  // 10 GB FSDB: 32.7 s and the dump evicted from the page cache with a 25 GB bound, 2 ms refused before). A forced low
  // budget stands in for the big dump here: the first computed read answers fast with the labelled no value.
  'auto bound at most 8 GiB; an over-room computed read answers fast with the labelled no value ': async () => {
    if (!(await w.useHelper('computed cap'))) return;
    if (!fs.existsSync(FSDB)) { console.log(`SKIP computed cap: no ${FSDB}`); return; }
    await closeAll();
    await w.setSetting('wisp.outsideWrites', 'none');
    try {
      let uri = await open(vscode.Uri.file(FSDB));
      let ws = await w.wispState(uri);
      const ram40 = Math.floor(os.totalmem() * 0.4 / 1048576), plan = Math.min(32768, Math.max(4096, ram40));
      const want = Math.min(8192, Math.max(1024, Math.min(plan, ram40)));
      assert.ok(ws.envKeys.includes('WISP_WORKER_RSS_MB=' + want), `auto bound ${want}: ` + JSON.stringify(ws.envKeys));
      await closeAll();
      await w.setSetting('wisp.planBudgetMB', '1024');
      uri = await open(vscode.Uri.file(FSDB));
      ws = await w.wispState(uri);
      const t0 = Date.now();
      const api = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time: 6000, instancePaths: [ROW] });
      const ms = Date.now() - t0;
      const nv = api && api[0] && api[0].noValue;
      console.log(`  computed cap: auto bound ${want} MB (RAM ${Math.round(os.totalmem() / 1073741824)} GiB); over-room read ${ms} ms -> ${JSON.stringify(nv)}`);
      assert.ok(nv && nv.text === TEXT, 'labelled no value: ' + JSON.stringify(api));
      assert.ok(ms < 3000, `over-room computed read took ${ms} ms`);
    } finally {
      await w.setSetting('wisp.outsideWrites', undefined);
      await w.setSetting('wisp.planBudgetMB', undefined);
      await closeAll();
    }
  },
  'closing the document mid computed search: no unhandled rejection, the asks end as reloaded': async () => {
    if (!(await w.useHelper('computed close'))) return;
    if (!fs.existsSync(FSDB)) { console.log(`SKIP computed close: no ${FSDB}`); return; }
    const bad = [];
    const onRej = (e) => bad.push(String((e && e.stack) || e).slice(0, 300));
    process.on('unhandledRejection', onRej);
    await closeAll();  // (a fresh helper, with the default bound)
    await w.setSetting('wisp.outsideWrites', 'none');
    try {
      const uri = await open(vscode.Uri.file(FSDB));
      const ws = await w.wispState(uri);
      const c = ws.computed;
      const net = await vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 8, 400000);
      const comp = ((net && net.vars) || []).filter((v) => v.signalId != null && v.signalId >= c.first && v.signalId < c.first + c.n);
      const f = comp.find((v) => v.path === ROW);
      assert.ok(f && comp.length >= 20, `computed vars ${comp.length}`);
      const q = (req) => vscode.commands.executeCommand('vaporview.e2e.wispQuery', String(uri), req);
      const t0 = Date.now();
      // the first computed request builds the computed tables (seconds on this file): close while it and a queue of
      // computed point reads (more than the in-flight limit) are pending
      const asks = [q({ cmd: 'search', signalId: f.signalId, t: 0, dir: 1, value: '1' }), q({ cmd: 'valueAt', signalIds: comp.slice(0, 20).map((v) => v.signalId), t: 6000 })];
      await sleep(800);
      await closeAll();
      const done = await Promise.race([Promise.allSettled(asks), sleep(30000).then(() => null)]);
      assert.ok(done, 'the pending asks never settled after close');
      await sleep(3000);
      const res = done.map((d) => d.status === 'fulfilled' ? (d.value.error ? `${d.value.code || ''}:${d.value.error}` : 'answered') : 'rejected: ' + d.reason);
      console.log(`  computed close: ${Date.now() - t0} ms; asks ${JSON.stringify(res)}; unhandled ${bad.length}`);
      assert.deepStrictEqual(bad, [], 'unhandled rejections after close');
      for (const r of res) assert.ok(r === 'answered' || /^reloaded:/.test(r), r);
    } finally {
      process.removeListener('unhandledRejection', onRej);
      await w.setSetting('wisp.outsideWrites', undefined);
    }
  },
  'CVA6 computed reads with room: per-name refusals are a warning with "not computable" reasons; the first read says it is preparing': async () => {
    if (!(await w.useHelper('computed limits'))) return;
    if (!fs.existsSync(FSDB)) { console.log(`SKIP computed limits: no ${FSDB}`); return; }
    await closeAll();
    await w.setSetting('wisp.outsideWrites', 'none');
    try {
      const uri = await open(vscode.Uri.file(FSDB));
      const ws = await w.wispState(uri);
      const c = ws.computed;
      const net = await vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 8, 400000);
      const P = 'ariane_tb.dut.i_ariane.i_cva6.';
      const comp = ((net && net.vars) || []).filter((v) => v.signalId != null && v.signalId >= c.first && v.signalId < c.first + c.n && /\.(controller_i|issue_stage_i)\./.test(v.path));
      assert.ok(comp.length >= 20, 'computed vars ' + comp.length);
      const t0 = Date.now();
      const api = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time: 6000, instancePaths: comp.map((v) => v.path) });
      const ms = Date.now() - t0;
      const after = await w.wispState(uri);
      const nv = (api || []).filter((r) => r.noValue);
      const kinds = {};
      for (const r of nv) kinds[r.noValue.reason] = (kinds[r.noValue.reason] || 0) + 1;
      console.log(`  computed limits: ${comp.length} computed, ${api.length} answers in ${ms} ms, no value ${JSON.stringify(kinds)}, e.g. ${JSON.stringify(nv.slice(0, 2).map((r) => r.noValue.text))}; status ${after.statusLevel || 'none'} "${after.status}"; preparing notes ${after.preparingNotes || 0}`);
      assert.strictEqual(api.length, comp.length, 'an answer for every path');
      assert.notStrictEqual(after.statusLevel, 'error', 'red status: ' + after.status);
      for (const r of nv) assert.ok(r.noValue.reason !== 'unreadable', 'unreadable computed: ' + r.noValue.text);
      assert.ok((after.preparingNotes || 0) >= 1, 'no "Preparing computed signals" note on the first computed read');
      // and the 5 reader wordings, fed as computed errors: a warning
      const five = ['constant used as a value', 'not proven: u81', 'arg ref beyond the record (operand numbering not established)', 'a part without a value at a merge time (fill not established)', 'code block writes only part of its value'];
      const st = await vscode.commands.executeCommand('vaporview.e2e.wispNoteErrors', String(uri), five, true);
      assert.strictEqual(st.level, 'warning', JSON.stringify(st));
    } finally {
      await w.setSetting('wisp.outsideWrites', undefined);
      await closeAll();
    }
  },
};
