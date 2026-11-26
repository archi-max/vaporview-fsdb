// vscode-port P2 memory check: RSS and PSS of wisp-helper and of the extension host (this process)
// on a >= 1M-change WCZ (generated here) and on an FSDB fixture (E2E_FSDB_DIR, internal). Phases: open (64 rows added),
// zoom-all, 20 marker moves, idle (35 s: cmux's helper gave back its block cache after WCB_IDLE_RELEASE_MS = 30 s),
// reopen. Numbers are printed (DIAGNOSTIC) and written to E2E_MEM_OUT (JSON). When test/perf/BASELINE.json has a
// `memory` record for the same file and phase, a helper RSS or extension-host PSS above it x tolerances.memory FAILS.
// Linux only (/proc); prints SKIP elsewhere.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { vscode, assert, until, open, closeAll, root } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const IDLE_MS = Number(process.env.E2E_MEM_IDLE_MS || 35000);
const LONG_TASK_MAX_MS = 200;
const ROWS = 64, STEP = 10, END = 200000;  // 64 x 20,000 = 1,280,000 changes, pseudo-random 16-bit values
const valAt = (k, i) => { let x = (i * 2654435761 + k * 40503) >>> 0; x ^= x >>> 13; return (x * 1274126177 >>> 0) & 0xffff; };

function mem(pid) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = (k) => Number((new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(t) || [])[1] || 0);
    return { rssKB: kb('Rss'), pssKB: kb('Pss') };
  } catch { return null; }
}
function makeWcz(dir) {
  const vcd = path.join(dir, 'mem.vcd'), wcz = path.join(dir, 'mem.wcz');
  const code = (k) => String.fromCharCode(33 + k);
  const fd = fs.openSync(vcd, 'w');
  let out = ['$timescale 1ns $end', '$scope module top $end'];
  for (let k = 0; k < ROWS; k++) out.push(`$var wire 16 ${code(k)} m${k} [15:0] $end`);
  out.push('$upscope $end', '$enddefinitions $end');
  for (let i = 0; i * STEP < END; i++) {
    out.push('#' + i * STEP);
    for (let k = 0; k < ROWS; k++) out.push('b' + valAt(k, i).toString(2) + ' ' + code(k));
    if (out.length > 100000) { fs.writeSync(fd, out.join('\n') + '\n'); out = []; }
  }
  out.push('#' + END);
  fs.writeSync(fd, out.join('\n') + '\n'); fs.closeSync(fd);
  execFileSync(path.join(w.TOOLS, 'wcz-from-vcd'), [vcd, wcz], { stdio: 'pipe', timeout: 300000 });
  fs.rmSync(vcd);
  return wcz;
}

// w.add already waited for a row per path (paths that share a signal, e.g. FSDB port links, can share a row). Here:
// each signal of a row in view is answered (per distinct signalId). Windowed rows below the fold are not requested
// until scrolled to (by design), so only rows in view must be answered (at least one); a row loaded whole (not
// windowed) counts when its data is loaded.
function answered(s, paths, done) {
  const inView = s.rows.filter((r) => r.inView);
  if (!inView.length) return false;
  const byId = new Map(s.windowing.signals.map((x) => [x.signalId, x]));
  return [...new Set(inView.map((r) => r.signalId))].every((id) => { const x = byId.get(id); return x ? done(x) : s.rows.some((r) => r.signalId === id && r.loaded); });
}

// Scroll through every row, one screen at a time, waiting at each stop for the rows in view to be answered, so every
// row's window is requested; then every distinct signal of every row must hold its zoom-all data. The memory
// samples after this cover the full load (all rows), not only the first screen.
async function loadAllRows(label, paths, done) {
  let s = await w.state();
  for (let top = 0; ; top += Math.max(1, s.viewerHeight)) {
    // The send is retried: the page can be busy decoding replies for a while (its long tasks are logged below).
    await until(async () => (await w.state({ kind: 'scrollTop', top: Math.min(top, s.maxScrollTop) })) || null, `${label} scroll request ${top}`, 60000);
    s = await until(async () => { const x = await w.state(); return x.scrollTop === Math.min(top, s.maxScrollTop) ? x : null; }, `${label} scrolled to ${top}`, 60000);
    console.log(`  DIAGNOSTIC ${label} scroll to ${s.scrollTop}px: redraw ${Math.round(s.scrollMs)} ms; page long tasks max ${Math.round((s.longTasks || {}).max || 0)} ms, recent ${JSON.stringify((s.longTasks || {}).recent || [])}`);
    await until(async () => { const x = await w.state(); return answered(x, paths, done) ? x : null; }, `${label} rows in view at ${top}`, 120000);
    if (top >= s.maxScrollTop) break;
  }
  const all = await until(async () => { const x = await w.state(); const byId = new Map(x.windowing.signals.map((y) => [y.signalId, y]));
    return [...new Set(x.rows.map((r) => r.signalId))].every((id) => { const y = byId.get(id); return y ? done(y) : x.rows.some((r) => r.signalId === id && r.loaded); }) ? x : null; }, `${label} all rows answered`, 120000);
  await w.state({ kind: 'scrollTop', top: 0 });
  console.log(`  DIAGNOSTIC ${label} slow steps:`, JSON.stringify(all.windowing.stats.slowSteps), 'render max', all.windowing.stats.renderMsMax);
  console.log(`  DIAGNOSTIC ${label} full load: ${all.rows.length} rows, ${new Set(all.rows.map((r) => r.signalId)).size} signals, max scroll ${all.maxScrollTop}px, view ${all.viewerHeight}px`);
}

async function phases(label, file, pickPaths) {
  const out = {};
  const sample = async (phase, uri) => {
    const ws = await w.wispState(uri);
    out[phase] = { helper: mem(ws.helperPid), extHost: mem(process.pid) };
  };
  let uri = String(await open(vscode.Uri.file(file)));
  const paths = await pickPaths(uri);
  await w.add(uri, paths);
  await sample('open', uri);
  await vscode.commands.executeCommand('vaporview.zoomToFit');
  try {
    await until(async () => { const s = await w.state(); return answered(s, paths, (x) => x.inflight === 0 && (x.windows > 0 || x.hybrid === 'local' || x.fails)) ? s : null; }, 'zoom-all answered', 120000);
  } catch (e) {
    const s = await w.state();
    console.log(`  DIAGNOSTIC ${label} zoom-all not answered: paths ${paths.length}, rows ${s.rows.length} (in view ${s.rows.filter((r) => r.inView).length}), distinct ids ${new Set(s.rows.map((r) => r.signalId)).size}, windowed ${s.windowing.signals.length}, pending`,
      JSON.stringify(s.windowing.signals.filter((x) => !(x.inflight === 0 && (x.windows > 0 || x.hybrid === 'local' || x.fails))).slice(0, 5)));
    throw e;
  }
  await loadAllRows(label, paths, (x) => x.inflight === 0 && (x.windows > 0 || x.hybrid === 'local' || x.fails));
  await sample('zoomAll', uri);
  const s0 = await w.state();
  const name = s0.rows[0].name;
  for (let i = 1; i <= 20; i++) await w.markerValue(name, Math.floor((s0.timeStop * i * 7919) % s0.timeStop) || i);
  await sample('markers20', uri);
  await new Promise((r) => setTimeout(r, IDLE_MS));
  await sample('idle', uri);
  const lt1 = (await w.state()).longTasks || { max: 0, recent: [] }; // the first page's long tasks (open, zoom, markers, idle)
  await closeAll();
  uri = String(await open(vscode.Uri.file(file)));
  await w.add(uri, paths);
  await vscode.commands.executeCommand('vaporview.zoomToFit');
  await until(async () => { const s = await w.state(); return answered(s, paths, (x) => x.inflight === 0) ? s : null; }, 'reopen answered', 120000);
  await loadAllRows(label + ' reopen', paths, (x) => x.inflight === 0 && (x.windows > 0 || x.hybrid === 'local' || x.fails));
  await sample('reopen', uri);
  const lt2 = (await w.state()).longTasks || { max: 0, recent: [] }; // the reopened page's long tasks
  await closeAll();
  console.log(`  DIAGNOSTIC memory ${label} (kB):`, JSON.stringify(out));
  // The page stays responsive through the load and the reopen: no main-thread task over LONG_TASK_MAX_MS (
  // 11-25; a whole-signal format took 17 s in one task before the format cache was sliced).
  const lt = { max: Math.max(lt1.max, lt2.max), recent: lt1.recent.concat(lt2.recent) };
  console.log(`  DIAGNOSTIC ${label} page long tasks: max ${Math.round(lt.max)} ms, recent ${JSON.stringify(lt.recent)}`);
  out.longTaskMaxMs = Math.round(lt.max);
  return out;
}

function gate(label, res) {
  const B = JSON.parse(fs.readFileSync(path.join(root, 'test/perf/BASELINE.json'), 'utf8'));
  const rec = B.memory && B.memory.records && B.memory.records[label];
  const tol = B.tolerances.memory;
  if (!rec || !tol) { console.log(`NEW memory ${label}: no record in BASELINE.json yet`); return; }
  for (const [phase, v] of Object.entries(res)) {
    const r = rec[phase];
    if (!r || !v.helper) continue;
    assert.ok(v.helper.rssKB <= r.helper.rssKB * tol.ratio, `${label} ${phase} helper RSS ${v.helper.rssKB} kB > ${r.helper.rssKB} x ${tol.ratio}`);
    assert.ok(v.extHost.pssKB <= r.extHost.pssKB * tol.ratio + (tol.extHostAbsKB || 0), `${label} ${phase} ext host PSS ${v.extHost.pssKB} kB`);
  }
}

module.exports = {
  'wisp mem: helper and extension host RSS/PSS, 1.28M-change WCZ and an FSDB': async () => {
    if (process.platform !== 'linux') { console.log('SKIP mem: Linux only'); return; }
    if (!(await w.useHelper('mem'))) return;
    if (!w.TOOLS || !fs.existsSync(path.join(w.TOOLS, 'wcz-from-vcd'))) { console.log('SKIP mem: no wcz-from-vcd'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-wisp-mem-'));
    const results = {};
    try {
      const wcz = makeWcz(dir);
      results.wcz = await phases('wcz', wcz, async () => Array.from({ length: ROWS }, (_, k) => 'top.m' + k));
      const fsdb = w.FSDB_DIR && path.join(w.FSDB_DIR, 'bigsoc25k.fsdb');
      if (fsdb && fs.existsSync(fsdb)) {
        results.fsdb = await phases('fsdb', fsdb, async (uri) => {
          const nl = await vscode.commands.executeCommand('vaporview.e2e.netlist', uri, 12, 3000);
          return nl.vars.filter((v) => !v.unavailable && v.signalId >= 0 && v.encoding === 'BitVector').slice(0, 64).map((v) => v.path);
        });
      } else console.log('PART NOT RUN mem fsdb: no E2E_FSDB_DIR/bigsoc25k.fsdb (the WCZ part ran)');
      const outFile = process.env.E2E_MEM_OUT || path.join(os.tmpdir(), 'wisp-mem.json');
      fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), idleMs: IDLE_MS, results }, null, 2));
      for (const [k, v] of Object.entries(results)) gate(k, v);
      for (const [k, v] of Object.entries(results)) assert.ok(v.longTaskMaxMs <= LONG_TASK_MAX_MS, `${k}: the page was blocked ${v.longTaskMaxMs} ms in one task (limit ${LONG_TASK_MAX_MS} ms)`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
};
