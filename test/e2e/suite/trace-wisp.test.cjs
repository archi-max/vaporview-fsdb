// vscode-port: Trace Driver and Trace to Root on FSDB and WCZ documents (wisp-helper) in a real VS Code.
// Each case runs on the VCD first (VaporView's own reader) and then on its twin in E2E_FORMAT:
//   fsdb / wcz: the twin of the VCD made once on the test host (format.cjs sameTwin: converted from the VCD, vcd2fsdb then wcz; the VCD arm opens the VCD itself);
//   unset: WCZ, made here from the VCD with wcz-from-vcd.
// The answers must be the same. The dump source must be the wisp-helper one (windowed helper queries): no
// whole-history read, no window over one bounded page.
// Env: E2E_WISP_HELPER, E2E_WCZ_TOOLS (wisp-common.cjs); E2E_TRACE_BIG_VCD = the xr design simulated for 1M cycles
// (test/perf/trace-perf.cjs TRACE_PERF_BIG) for the big case (Trace to Root at r's last change), else it prints SKIP.
// SPDX-License-Identifier: GPL-3.0-or-later
const PARITY_EXCEPTIONS = {};
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { vscode, assert, open, root } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const e2eDir = path.join(root, 'test/e2e/fixtures/trace');
const traceDir = path.join(root, 'test/trace');
const LONG = 30 * 60 * 1000;
const state = () => vscode.commands.executeCommand('vaporview.e2e.traceState');
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

const CASES = {
  a: { vcd: path.join(e2eDir, 'a.vcd'), designRoot: e2eDir, args: ['-f', 'a.f'] },
  p: { vcd: path.join(e2eDir, 'p.vcd'), designRoot: e2eDir, args: ['-f', 'p.f'] },
  xr: { vcd: path.join(traceDir, 'dumps/xr.icarus.vcd'), designRoot: path.join(traceDir, 'designs'), args: ['tb_xr.sv', 'xr_run.sv', '--top', 'tb_xr'] },
};
const BIG = process.env.E2E_TRACE_BIG_VCD || '';
const fmt = require('./format.cjs');
const FORMAT = fmt.FORMAT || 'wcz';
const twinPath = (f) => (fmt.FORMAT ? fmt.sameTwin(f) : (() => { throw new Error('no E2E_FORMAT'); })()); // (the twin converted from the VCD: same content)
if (BIG) { CASES.xr1m = { vcd: BIG, designRoot: path.join(traceDir, 'designs'), args: ['tb_xr.sv', 'xr_run.sv', '--top', 'tb_xr'] }; }

let work = null;
let xrSmall = null; // the xr chain (20K cycles), for the 1M-cycle run of the same design
const made = new Map();
function wczOf(name) {
  if (made.has(name)) { return made.get(name); }
  work = work || fs.mkdtempSync(path.join(os.tmpdir(), 'vv-trace-wisp-'));
  const out = path.join(work, name + '.wcz');
  const t0 = Date.now();
  execFileSync(path.join(w.TOOLS, 'wcz-from-vcd'), [CASES[name].vcd, out], { stdio: 'pipe', timeout: 600000 });
  console.log(`  DIAGNOSTIC ${name}: ${path.basename(CASES[name].vcd)} -> ${name}.wcz ${fs.statSync(out).size} B in ${Date.now() - t0} ms`);
  made.set(name, out);
  return out;
}
// The case's twin in E2E_FORMAT (format.cjs sameTwin; the 1M-cycle xr: test/trace/dumps/xr1m.icarus.<fmt>). A WCZ
// twin not made on the host yet is made here with wcz-from-vcd.
function twinOf(name) {
  const repoVcd = name === 'xr1m' ? path.join(root, 'test/trace/dumps/xr1m.icarus.vcd') : CASES[name].vcd;
  try { return twinPath(repoVcd); } catch (e) { if (FORMAT === 'wcz') { return wczOf(name); } throw e; }
}
async function ready(what) {
  what += ` (${FORMAT})`;
  if (!(await w.useHelper(what))) { return false; }
  if (FORMAT === 'fsdb') { return true; }
  if (!w.TOOLS || !fs.existsSync(path.join(w.TOOLS, 'wcz-from-vcd'))) { console.log(`SKIP ${what}: no wcz-from-vcd (E2E_WCZ_TOOLS=${w.TOOLS || 'unset'})`); return false; }
  return true;
}
async function design(name) {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  await cfg.update('trace.designArgs', CASES[name].args, vscode.ConfigurationTarget.Global);
  await cfg.update('trace.designRoot', CASES[name].designRoot, vscode.ConfigurationTarget.Global);
}

// What must not differ between the VCD and the WCZ.
const stepView = (st) => [st.signal, st.time, st.driver && st.driver.kind, st.procKind, st.stmt && st.stmt.src, st.activation && st.activation.time,
  st.sample, st.since, st.value, st.trust, (st.decisions || []).map((d) => [d.src, d.taken]), (st.fanin || st.inputs || []).length];
const chainView = (c) => [c.end && c.end.code, c.root, c.approximate, c.steps.map((e) => [e.signal, e.time, e.why && e.why.code, e.trust, e.step ? stepView(e.step) : null])];

async function onBoth(name, run, opt = {}) {
  await design(name);
  const vcdUri = String(await fmt.openAsIs(CASES[name].vcd)); // (the VCD itself: the reference arm)
  const vcd = await withTimeout(run(vcdUri), LONG, name + ' on the VCD');
  assert.ok(opt.vcdMayDegrade || (vcd && !vcd.error), 'VCD: ' + JSON.stringify(vcd));
  const sv = await state();
  assert.notStrictEqual(sv.source && sv.source.kind, 'wcz', 'the VCD is read by VaporView, not wisp-helper');
  const wczUri = String(await open(vscode.Uri.file(twinOf(name))));
  const t0 = Date.now();
  const wcz = await withTimeout(run(wczUri), LONG, name + ' on the WCZ');
  const ms = Date.now() - t0;
  assert.ok(wcz && !wcz.error, FORMAT + ': ' + JSON.stringify(wcz));
  const s = await state();
  assert.ok(s.source && s.source.kind === FORMAT && s.source.stats, `the ${FORMAT} is traced through wisp-helper: ` + JSON.stringify(s.source));
  const q = s.source.stats;
  assert.strictEqual(q.wholeReads, 0, 'no whole-history read: ' + JSON.stringify(q));
  assert.strictEqual(q.wholeWindows, 0, 'no window over one bounded page: ' + JSON.stringify(q));
  assert.ok(q.queries > 0, 'helper queries: ' + JSON.stringify(q));
  console.log(`  DIAGNOSTIC ${name} ${FORMAT}: ${ms} ms, helper queries ${JSON.stringify(q.byCmd)}`);
  // Per kind: count, ms sum, max; valueAt: signals per query, distinct times, sent while another was in flight.
  const kinds = {};
  for (const [cmd, , n, qms, busy] of q.log.slice(-q.queries)) { const k = kinds[cmd] || (kinds[cmd] = { n: 0, ms: 0, max: 0, sig: 0, busy: 0 }); k.n++; k.ms += qms; k.max = Math.max(k.max, qms); k.sig += n; if (busy) { k.busy++; } }
  const va = q.log.slice(-q.queries).filter((e) => e[0] === 'valueAt');
  console.log(`  DIAGNOSTIC ${name} ${FORMAT} per kind ${JSON.stringify(kinds)}; valueAt distinct times ${new Set(va.map((e) => e[1])).size}`);
  if (q.queries <= 20) { console.log(`  DIAGNOSTIC ${name} ${FORMAT} queries ${JSON.stringify(q.log.slice(-q.queries))}`); }
  const brief = (c) => (c.steps ? [c.end && c.end.code, c.root, c.steps.map((e) => [e.signal, e.time, e.why && e.why.code, e.trust])] : [c.signal, c.time, c.trust]);
  console.log(`  DIAGNOSTIC ${name} VCD ${JSON.stringify(brief(vcd))}`);
  console.log(`  DIAGNOSTIC ${name} ${FORMAT} ${JSON.stringify(brief(wcz))}`);
  return { vcd, wcz, stats: q, ms };
}


// A Trace to Root on case P's twin, slowed down (each helper query waits `ms`) so it can be stopped midway.
async function slowChain(ms) {
  await design('p');
  const uri = String(await open(vscode.Uri.file(twinOf('p'))));
  await vscode.commands.executeCommand('vaporview.e2e.traceQueryDelay', ms);
  await vscode.commands.executeCommand('vaporview.e2e.traceReset'); // (cold caches: the chain reads the dump again)
  const q0 = ((await state()).source || { stats: { queries: 0 } }).stats.queries;
  let base = q0;
  const run = vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_p.dut.sg2', time: 440 });
  // (the source of this document once the run started, then ten more reads)
  const { until } = require('./helpers.cjs');
  let done = null;
  run.then((r) => { done = r; }, (e) => { done = { error: String(e) }; });
  try {
    await until(async () => {
      if (done) { throw new Error('the chain ended before ten reads: ' + JSON.stringify(done).slice(0, 400) + ' source ' + JSON.stringify(((await state()).source || {}).stats || null).slice(0, 300)); }
      // (a reopened document gets a new source whose count starts at 0: then count from 0)
      const s = await state(); if (s.source && s.source.stats && s.source.stats.queries < base) { base = 0; }
      return s.source && s.source.kind === FORMAT && s.source.stats.queries >= base + 10 ? s : null;
    }, 'the chain reading', 60000, 50);
  } catch (e) {
    // (why the chain did not read: the state, the source's counters and its last reads)
    const s = await state(); const st = s.source && s.source.stats;
    throw new Error(e.message + ' | q0 ' + q0 + ' source ' + JSON.stringify(s.source && { kind: s.source.kind, queries: st && st.queries, cancelled: st && st.cancelled, reloaded: st && st.reloaded, log: st && st.log && st.log.slice(-5) })
      + ' state ' + JSON.stringify({ running: s.running, end: s.chain && s.chain.end, step: s.step && s.step.signal }).slice(0, 400));
  }
  return { uri, run };
}
const P_CHAIN = ['testbench', 5, [['tb_p.dut.sg2', 440, 'start', 'exact'], ['tb_p.dut.nx2', 434, 'only', 'exact'], ['tb_p.dut.sg2', 35, 'held', 'exact'], ['tb_p.dut.nx2', 32, 'xSince', 'exact'], ['tb_p.dut.flit', 32, 'only', 'exact'], ['tb_p.flit', 32, 'only', 'approximate']]];
const briefChain = (c) => [c.end && c.end.code, c.root, c.steps.map((e) => [e.signal, e.time, e.why && e.why.code, e.trust])];
async function traceAgainIsRight(uri) {
  await vscode.commands.executeCommand('vaporview.e2e.traceQueryDelay', 0);
  const again = await withTimeout(vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_p.dut.sg2', time: 440 }), LONG, 'trace again');
  assert.deepStrictEqual(briefChain(again), P_CHAIN, 'the next trace is unaffected');
}

// (the trace.* settings this suite sets are put back when it ends: trace-settings-guard.cjs)
module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  // vscode-port: vaporview.trace.prepare. onOpen (default): a waveform opening with its design chosen
  // loads that design in the background, so the first Trace reuses it; a Trace during the load waits for that load
  // (no second one); another design already loaded is not replaced. onFirstTrace: opening loads nothing.
  'Background prep (trace.prepare): onOpen loads the design when the waveform opens; onFirstTrace loads it at the first Trace': async () => {
    if (!(await ready('trace prepare'))) { return; }
    const { until } = require('./helpers.cjs');
    const cfg = () => vscode.workspace.getConfiguration('vaporview');
    work = work || fs.mkdtempSync(path.join(os.tmpdir(), 'vv-trace-wisp-'));
    const fresh = (name) => { const src = twinOf(name); const f = path.join(work, `prep-${name}-${Date.now()}${path.extname(src)}`); fs.copyFileSync(src, f); return f; };
    const trace = (uri) => withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout', time: 60 }), LONG, 'trace');
    const closeAll = async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await new Promise((r) => setTimeout(r, 300)); };
    try {
      await design('a');
      // onFirstTrace: nothing loads on open
      await cfg().update('trace.prepare', 'onFirstTrace', vscode.ConfigurationTarget.Global);
      await closeAll();
      await vscode.commands.executeCommand('vaporview.e2e.traceDropDesigns');
      let uri = String(await open(vscode.Uri.file(fresh('a'))));
      await new Promise((r) => setTimeout(r, 1500));
      assert.strictEqual((await state()).prep, null, 'onFirstTrace: no prep on open');
      let st = await trace(uri);
      assert.ok(st && !st.error, JSON.stringify(st));
      let s = await state();
      assert.ok(s.timings.designLoad !== undefined && s.timings.designReuse === undefined, 'onFirstTrace: the first Trace loads the design: ' + JSON.stringify(s.timings));
      const ref = stepView(st);

      // onOpen (the default): the design loads when the waveform opens; the first Trace reuses it
      await cfg().update('trace.prepare', undefined, vscode.ConfigurationTarget.Global);
      await closeAll();
      await vscode.commands.executeCommand('vaporview.e2e.traceDropDesigns');
      uri = String(await open(vscode.Uri.file(fresh('a'))));
      s = await until(async () => { const x = await state(); return x.prep && x.prep.uri === uri && x.prep.state !== 'loading' ? x : null; }, 'the prep on open', 120000, 100);
      assert.strictEqual(s.prep.state, 'ready', 'prep on open: ' + JSON.stringify(s.prep));
      console.log(`  DIAGNOSTIC prep on open (${FORMAT}): ${s.prep.ms} ms`);
      st = await trace(uri);
      s = await state();
      assert.deepStrictEqual(stepView(st), ref, 'the same step');
      assert.ok(s.timings.designReuse !== undefined && s.timings.designLoad === undefined, 'onOpen: the first Trace reuses the design loaded on open: ' + JSON.stringify(s.timings));

      // a Trace while the prep loads: waits for that load, no second load
      await closeAll();
      await vscode.commands.executeCommand('vaporview.e2e.traceDropDesigns');
      uri = String(await open(vscode.Uri.file(fresh('a'))));
      await until(async () => { const x = await state(); return x.prep && x.prep.uri === uri ? x : null; }, 'the prep started', 30000, 20);
      st = await trace(uri);
      s = await state();
      assert.deepStrictEqual(stepView(st), ref, 'the same step during the prep');
      assert.ok(s.timings.designLoad === undefined, 'no second load during the prep: ' + JSON.stringify(s.timings));

      // another design already loaded (a): opening p's waveform does not replace it
      await design('p');
      const puri = String(await open(vscode.Uri.file(fresh('p'))));
      s = await until(async () => { const x = await state(); return x.prep && x.prep.uri === puri ? x : null; }, 'the prep of p', 30000, 50);
      assert.deepStrictEqual([s.prep.state, s.prep.reason], ['skipped', 'otherDesignLoaded'], JSON.stringify(s.prep));
    } finally {
      await cfg().update('trace.prepare', undefined, vscode.ConfigurationTarget.Global);
      await closeAll();
    }
  },
  // vscode-port: an FSDB Trace right after open reads values before the reader's whole-file check
  // (wisp-helper 15.12: WISP_VERIFY_START idle:30). The badge says so ("file check pending") and goes once the check
  // passes (Trace asks the helper to run it after it goes quiet). WCZ answers are checked at open: no badge.
  'Trace on a just-opened FSDB: "file check pending", gone once the whole-file check passes (WCZ: no badge)': async () => {
    if (!(await ready('trace file check badge'))) { return; }
    const panel = (q) => vscode.commands.executeCommand('vaporview.e2e.tracePanel', q);
    const { until } = require('./helpers.cjs');
    await design('a');
    // (a fresh copy: its own helper, whose check has not run yet)
    work = work || fs.mkdtempSync(path.join(os.tmpdir(), 'vv-trace-wisp-'));
    const src = twinOf('a');
    const copy = path.join(work, 'fresh-' + Date.now() + path.extname(src));
    fs.copyFileSync(src, copy);
    await vscode.commands.executeCommand('vaporview.e2e.traceConfirmDelay', 1000);
    try {
      const uri = String(await open(vscode.Uri.file(copy)));
      const st = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout', time: 60 }), LONG, 'trace driver');
      assert.ok(st && !st.error, JSON.stringify(st));
      const badges = await panel({ kind: 'texts', selector: '.badge.unconfirmed' });
      if (FORMAT === 'wcz') {
        assert.ok(!st.unconfirmed, 'WCZ: checked at open, no badge: ' + st.unconfirmed);
        assert.deepStrictEqual(badges, [], 'WCZ: no badge in the panel');
        return;
      }
      assert.strictEqual(st.unconfirmed, 'pending', 'FSDB: read before the file check: ' + JSON.stringify(st.unconfirmed));
      assert.deepStrictEqual(badges, ['file check pending'], 'the panel says what is not confirmed');
      const s = await until(async () => { const x = await state(); return x.lastConfirm ? x : null; }, 'the file check asked', 30000, 100);
      assert.strictEqual(s.lastConfirm.ok, true, 'the whole-file check passed: ' + JSON.stringify(s.lastConfirm));
      await until(async () => ((await panel({ kind: 'texts', selector: '.badge.unconfirmed' })).length === 0 ? true : null), 'the badge gone after the check', 10000, 100);
      assert.ok(!((await state()).step || {}).unconfirmed, 'the shown step has no unconfirmed mark');
      // (a new Trace now reads checked answers: no badge)
      const again = await vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout', time: 60 });
      assert.ok(!again.unconfirmed, 'after the check: ' + again.unconfirmed);
      assert.deepStrictEqual(await panel({ kind: 'texts', selector: '.badge.unconfirmed' }), []);
    } finally {
      await vscode.commands.executeCommand('vaporview.e2e.traceConfirmDelay', 35000);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  },
  'Trace Driver on FSDB or WCZ (E2E_FORMAT): the same step as on the VCD, through wisp-helper (cmux case A dout@60)': async () => {
    if (!(await ready('trace driver on WCZ'))) { return; }
    const r = await onBoth('a', (uri) => vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout', time: 60 }));
    assert.deepStrictEqual(stepView(r.wcz), stepView(r.vcd));
    assert.deepStrictEqual([r.wcz.stmt.src, r.wcz.value, r.wcz.trust], ['dout <= stage;', 'xxxxxxxx', 'exact']);
  },
  'Trace to Root on FSDB or WCZ (E2E_FORMAT): the same chain and root as on the VCD (cmux case P sg2@440)': async () => {
    if (!(await ready('trace to root on WCZ'))) { return; }
    const r = await onBoth('p', (uri) => vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_p.dut.sg2', time: 440 }));
    assert.deepStrictEqual(chainView(r.wcz), chainView(r.vcd));
    assert.deepStrictEqual([r.wcz.end.code, r.wcz.root, r.wcz.steps.length], ['testbench', 5, 6]);
  },
  'Trace to Root on FSDB or WCZ (E2E_FORMAT): an x run of 1,899 changes (xr r@19995), the same chain as on the VCD': async () => {
    if (!(await ready('trace to root on WCZ (xr)'))) { return; }
    const r = await onBoth('xr', (uri) => vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_xr.dut.r', time: 19995 }));
    assert.deepStrictEqual(chainView(r.wcz), chainView(r.vcd));
    xrSmall = r.wcz;
  },
  'Trace to Root on FSDB or WCZ (E2E_FORMAT): Cancel mid-trace stops the chain and its helper reads; the next trace is right': async () => {
    if (!(await ready('cancel mid-trace'))) { return; }
    const { uri, run } = await slowChain(40);
    const t0 = Date.now();
    await vscode.commands.executeCommand('vaporview.traceCancel');
    const out = await withTimeout(run, 10000, 'the cancelled chain returns');
    const ms = Date.now() - t0;
    assert.strictEqual(out.end && out.end.code, 'cancelled', JSON.stringify(out.end));
    assert.ok(ms < 3000, `cancelled in ${ms} ms`);
    const s1 = (await state()).source.stats;
    assert.ok(s1.cancelled >= 1, 'a read was cancelled: ' + JSON.stringify(s1));
    await new Promise((r) => setTimeout(r, 1000));
    const s2 = (await state()).source.stats;
    assert.strictEqual(s2.queries, s1.queries, 'no reads after the cancel');
    console.log(`  DIAGNOSTIC cancel (${FORMAT}): returned in ${ms} ms after ${s1.queries} reads, ${s1.cancelled} cancelled`);
    await traceAgainIsRight(uri);
  },
  'Trace to Root on FSDB or WCZ (E2E_FORMAT): a reload mid-trace stops the chain; no stale reply reaches the reloaded file': async () => {
    if (!(await ready('reload mid-trace'))) { return; }
    const { uri, run } = await slowChain(40);
    await vscode.commands.executeCommand('vaporview.reloadFile', vscode.Uri.parse(uri));
    const out = await withTimeout(run, 60000, 'the chain returns after the reload');
    assert.strictEqual(out.end && out.end.code, 'reloaded', JSON.stringify(out.end));
    const s1 = (await state()).source.stats;
    assert.ok(s1.reloaded >= 1, 'replies dropped: ' + JSON.stringify(s1));
    const ws = await w.wispState(uri);
    assert.ok(ws && ws.refused === null, 'the reloaded file is not refused: ' + JSON.stringify(ws && ws.refused));
    console.log(`  DIAGNOSTIC reload (${FORMAT}): ${s1.reloaded} replies dropped after ${s1.queries} reads`);
    await traceAgainIsRight(uri);
  },
  'Trace Driver on FSDB or WCZ (E2E_FORMAT): the dump reloading under the step (as right after an open) traces once more on the reloaded file, not "reloaded"': async () => {
    if (!(await ready('reload under a step'))) { return; }
    await design('p');
    const uri = String(await open(vscode.Uri.file(twinOf('p'))));
    const want = stepView(await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_p.dut.sg2', time: 440 }), LONG, 'the reference step'));
    await vscode.commands.executeCommand('vaporview.e2e.traceQueryDelay', 1500);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset'); // (cold caches: the step reads the dump)
    const s0 = await state();
    const r0 = s0.retriedReloaded || 0;
    let base = ((s0.source || { stats: { queries: 0 } }).stats || { queries: 0 }).queries;
    const run = vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_p.dut.sg2', time: 440 });
    let done = null;
    run.then((r) => { done = r || {}; }, (e) => { done = { error: String(e) }; });
    const { until } = require('./helpers.cjs');
    // (a read sent and still delayed: the reload lands under it)
    await until(async () => {
      if (done) { throw new Error('the step ended before the reload: ' + JSON.stringify(done).slice(0, 300)); }
      const s = await state(); if (s.source && s.source.stats && s.source.stats.queries < base) { base = 0; }
      return s.source && s.source.kind === FORMAT && s.source.stats.queries >= base + 1 ? s : null;
    }, 'a read in flight', 30000, 20);
    await vscode.commands.executeCommand('vaporview.reloadFile', vscode.Uri.parse(uri));
    let out;
    try { out = await withTimeout(run, LONG, 'the step after the reload'); } finally { await vscode.commands.executeCommand('vaporview.e2e.traceQueryDelay', 0); }
    const s1 = await state();
    assert.ok(s1.retriedReloaded === r0 + 1, 'traced once more after the reload: ' + JSON.stringify({ r0, r1: s1.retriedReloaded, stats: s1.source && s1.source.stats && { queries: s1.source.stats.queries, reloaded: s1.source.stats.reloaded } }));
    assert.ok(out && !out.error, 'no error: ' + JSON.stringify(out).slice(0, 300));
    assert.deepStrictEqual(stepView(out), want, 'the step on the reloaded file is the same step');
    console.log(`  DIAGNOSTIC reload under a step (${FORMAT}): retried once, ${s1.source.stats.reloaded} replies dropped`);
  },
  // VCS-vs-Icarus parity is gated; a known simulator difference goes here by run name with its reason,
  // e.g. 'a trace to root dout@60': 'VCS settles … one delta earlier'. Empty: all 4 runs matched on FSDB and WCZ.
  'Trace on the simulator-written FSDB or WCZ (VCS run of a and p; default and outsideWrites none): windowed reads give the same answers as whole histories of the same file': async () => {
    // trace proven on a real simulator dump. No Icarus expectations: on the same .vcs.<fmt> file, the chain
    // through the windowed helper queries (WispTraceSource) must equal the chain from whole signal histories read
    // through the same helper (WispWholeHistorySource, as tracing reads a VCD). Engine vs engine on the real dump.
    if (!(await ready('trace on the VCS-run twin'))) { return; }
    const h = require('./helpers.cjs');
    const sameTwinOf = (name) => fmt.sameTwin(CASES[name].vcd);
    const runs = [
      ['a', 'trace driver dout@60', (uri) => vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout', time: 60 }), stepView],
      ['a', 'trace to root dout@60', (uri) => vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_a.dut.dout', time: 60 }), chainView],
      ['a', 'trace to root stage@54', (uri) => vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_a.dut.stage', time: 54 }), chainView],
      ['p', 'trace to root sg2@440', (uri) => vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_p.dut.sg2', time: 440 }), chainView],
    ];
    const icarus = {}; // (outsideWrites none) the chains on the twin converted from the Icarus VCD, by run
    const closeAll = async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await new Promise((r) => setTimeout(r, 300)); };
    try {
     for (const ow of [undefined, 'none']) {
      await closeAll();
      await w.setSetting('wisp.outsideWrites', ow);
      for (const [name, what, run, view] of runs) {
        const file = h.twinPath(CASES[name].vcd);
        assert.ok(file.endsWith('.vcs.' + FORMAT), `a VCS-run twin of ${name}: ${file}`);
        await design(name);
        const uri = String(await open(vscode.Uri.file(file)));
        if (ow) { const ws = await w.wispState(uri); assert.ok(ws && ws.outsideWrites === 'none', 'opened with outsideWrites none: ' + JSON.stringify(ws && { ow: ws.outsideWrites, computed: ws.computed })); }
        await vscode.commands.executeCommand('vaporview.e2e.traceWholeHistory', true);
        const whole = await withTimeout(run(uri), LONG, what + ' (whole histories)');
        const sw = (await state()).source;
        assert.ok(sw && sw.kind === FORMAT + '-whole' && sw.stats.wholeReads > 0, 'the reference reads whole histories: ' + JSON.stringify(sw));
        await vscode.commands.executeCommand('vaporview.e2e.traceWholeHistory', false);
        const s0 = (await state()).source;
        const w0 = s0 && s0.kind === FORMAT ? s0.stats.wholeReads : null;
        const win = await withTimeout(run(uri), LONG, what + ' (windowed)');
        const sv = (await state()).source;
        assert.ok(sv && sv.kind === FORMAT, 'the windowed run reads through WispTraceSource: ' + JSON.stringify(sv && sv.kind));
        if (w0 !== null) { assert.strictEqual(sv.stats.wholeReads, w0, 'no whole-history read in the windowed run'); }
        assert.strictEqual(sv.stats.wholeWindows, 0, 'no window over one bounded page');
        assert.ok(whole && !whole.error && win && !win.error, JSON.stringify({ whole: whole && whole.error, win: win && win.error }));
        assert.deepStrictEqual(view(win), view(whole), `${name} ${what}: windowed = whole histories on ${path.basename(file)}`);
        const brief = (c) => (c.steps ? [c.end && c.end.code, c.root, c.steps.map((e) => [e.signal.replace(/^tb_[ap]\./, ''), e.time, e.why && e.why.code, e.trust])] : [c.signal, c.time, c.trust, c.stmt && c.stmt.src]);
        const tag = ow ? 'outsideWrites=none' : 'default';
        console.log(`  DIAGNOSTIC vcs ${FORMAT} ${tag} ${name} ${what}: ${JSON.stringify(brief(win))} (whole reads ${sw.stats.wholeReads})`);
        if (ow) {
          // Parity (GATED): the same trace on the twin converted from the Icarus VCD, which the
          // exact-chain tests check, must give the same chain. A difference the two simulators really make is listed
          // by name in PARITY_EXCEPTIONS with its reason; anything else fails.
          const ws = await w.wispState(uri);
          const iuri = String(await open(vscode.Uri.file(sameTwinOf(name))));
          const ic = await withTimeout(run(iuri), LONG, what + ' (Icarus twin)');
          const same = JSON.stringify(view(win)) === JSON.stringify(view(ic));
          const key = name + ' ' + what;
          icarus[key] = same;
          console.log(`  vcs ${FORMAT} outsideWrites=none vs Icarus ${key}: ${same ? 'MATCH' : 'DIFFER'}${same ? '' : ' icarus ' + JSON.stringify(brief(ic))} (computed ${JSON.stringify(ws && ws.computed)})`);
          if (PARITY_EXCEPTIONS[key]) { console.log(`  parity exception ${key}: ${PARITY_EXCEPTIONS[key]}`); }
          else { assert.deepStrictEqual(view(win), view(ic), `${key}: the VCS-run ${FORMAT} and the Icarus twin give the same trace`); }
        }
      }
     }
     console.log(`  vcs ${FORMAT} outsideWrites=none chains matching the Icarus twin (gated): ${Object.values(icarus).filter(Boolean).length}/${Object.keys(icarus).length}`);
    } finally {
      await vscode.commands.executeCommand('vaporview.e2e.traceWholeHistory', false);
      await w.setSetting('wisp.outsideWrites', undefined);
    }
  },
  'Trace to Root on a big FSDB or WCZ: xr for 1M cycles (r at its last change), the same chain as at 20K cycles, no whole-history read': async () => {
    if (!BIG) { console.log('SKIP trace on a big FSDB or WCZ: E2E_TRACE_BIG_VCD unset'); return; }
    if (!(await ready('trace on a big WCZ'))) { return; }
    // r's last change, from the VCD (test/trace/vcd.js, the perf check's parser).
    const vm = require('vm');
    const { traceVcd } = vm.compileFunction(fs.readFileSync(path.join(traceDir, 'vcd.js'), 'utf8') + '\nreturn { traceVcd };', [])();
    const rc = traceVcd(fs.readFileSync(BIG, 'utf8')).sig.get('tb_xr.dut.r').changes;
    const t = Number(rc[rc.length - 1][0]);
    console.log(`  DIAGNOSTIC xr1m: r has ${rc.length} changes, the last at ${t}`);
    const r = await onBoth('xr1m', (uri) => vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_xr.dut.r', time: t }), { vcdMayDegrade: true });
    // The reference is the same design's chain at 20K cycles (the x comes from the same place; only the start time
    // moves), checked equal to the VCD above. On the 1M-cycle VCD, VaporView's reader hands r's 1M changes to tracing
    // through the webview's chunk capture, which may run out of time (20 s under the e2e): that run then answers
    // "approximate", which is printed, not compared. (test/perf/trace-perf.cjs compares the WCZ chain with cmux's.)
    assert.ok(xrSmall, 'the xr case ran first');
    const shape = (c) => [c.end && c.end.code, c.root, c.steps.map((e, i) => [e.signal, i === 0 ? 'start' : e.time, e.why && e.why.code, e.trust])];
    assert.deepStrictEqual(shape(r.wcz), shape(xrSmall));
    assert.strictEqual(r.wcz.steps[0].time, t);
    console.log(`  DIAGNOSTIC xr1m chain: ${r.wcz.steps.length} steps in ${r.ms} ms on the ${FORMAT} (${(r.ms / Math.max(1, r.wcz.steps.length)).toFixed(1)} ms/step)`);
  },
});
