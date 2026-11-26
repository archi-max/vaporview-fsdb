// vscode-port: scale matrix in a real VS Code. SKIPs unless SCALE_FILES is set (internal files on the
// test machine; nothing large is committed). SCALE_FILES = JSON list of {file, label, deepest?, needle?, reps?}.
// Per file and rep (fresh open each rep): open -> netlist shown; expand the deepest scope; netlist search for one name;
// add 1 / 100 signals; first paint; zoom-all; pan; value search one step; peak RSS of the extension host and the
// wisp-helper (sampled from /proc every 100 ms). Results: one JSON line per rep to SCALE_OUT (and stdout). DIAGNOSTIC.
const fs = require('fs'), path = require('path');
const { vscode, until, open, query, sleep, closeAll } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const BIG = 15 * 60 * 1000;
const now = () => Number(process.hrtime.bigint()) / 1e6;
const out = process.env.SCALE_OUT || '';
const emit = (o) => { const s = JSON.stringify(o); console.log('  SCALE ' + s); if (out) fs.appendFileSync(out, s + '\n'); };

function procStatus(pid) {
  try { const t = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); const g = (k) => { const m = t.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? +m[1] : 0; }; return { rss: g('VmRSS'), hwm: g('VmHWM'), anon: g('RssAnon'), file: g('RssFile') }; } catch { return null; }
}
function helperPids() {
  const pids = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const comm = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')); if (comm.startsWith('wisp-helper')) pids.push(+d); } catch {}
  }
  return pids.filter((p) => { try { const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' '); return +st[1] === process.pid; } catch { return false; } });
}
function sampler() {
  const s = { ext: 0, helper: 0, helperHwm: 0, helperPid: null, helperAnon: 0, helperFileAtAnonPeak: 0 };
  const minAvail = +(process.env.SCALE_MIN_AVAIL_MB || 3000);
  const tick = () => {
    // memory watchdog (shared hosts): below SCALE_MIN_AVAIL_MB available, kill this run's own wisp-helper(s)
    try { const ma = +fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1] / 1024; s.minAvailMB = Math.min(s.minAvailMB ?? 1e9, ma);
      if (ma < minAvail) { for (const p of helperPids()) { try { process.kill(p, 'SIGKILL'); } catch {} } s.watchdog = `MemAvailable ${Math.round(ma)} MB < ${minAvail}: helper killed`; } } catch {}
    const e = procStatus(process.pid); if (e) s.ext = Math.max(s.ext, e.rss);
    for (const p of helperPids()) { const h = procStatus(p); if (h) { s.helper = Math.max(s.helper, h.rss); if (h.anon > s.helperAnon) { s.helperAnon = h.anon; s.helperFileAtAnonPeak = h.file; } s.helperHwm = Math.max(s.helperHwm, h.hwm); s.helperPid = p; } }
  };
  // ext-host event-loop lag (timer drift) and webview round trip (a 'view' query every 500 ms): UI responsiveness
  s.lagMax = 0; s.rttMax = 0; s.rttN = 0; s.timeline = []; s.t0 = Date.now();
  let last = now();
  const iv = setInterval(() => { const t = now(); s.lagMax = Math.max(s.lagMax, t - last - 100); last = t; tick(); }, 100); tick();
  let busy = false;
  const iv2 = setInterval(async () => {
    const e = procStatus(process.pid); let h = 0, ha = 0; for (const p of helperPids()) { const x = procStatus(p); if (x) { h += x.rss; ha += x.anon; } }
    s.timeline.push([Math.round((Date.now() - s.t0) / 1000), Math.round(h / 1024), Math.round(ha / 1024), e ? Math.round(e.rss / 1024) : 0]);
    if (busy) return; busy = true;
    const t = now(); try { await vscode.commands.executeCommand('vaporview.e2e.query', { kind: 'view' }); s.rttMax = Math.max(s.rttMax, now() - t); s.rttN++; } catch {} busy = false;
  }, 1000);
  return { stop: () => { clearInterval(iv); clearInterval(iv2); tick(); return { extPeakMB: +(s.ext / 1024).toFixed(1), helperPeakMB: +(s.helper / 1024).toFixed(1), helperHwmMB: +(s.helperHwm / 1024).toFixed(1), helperAnonPeakMB: +(s.helperAnon / 1024).toFixed(1), helperFileAtAnonPeakMB: +(s.helperFileAtAnonPeak / 1024).toFixed(1), helperPid: s.helperPid, minAvailMB: Math.round(s.minAvailMB), watchdog: s.watchdog || null, extLagMaxMs: Math.round(s.lagMax), webviewRttMaxMs: Math.round(s.rttMax), timeline: s.timeline }; } };
}
async function idle(what, ms = BIG) {
  let ok = 0;
  return until(async () => { const r = await query({ kind: 'idle' }); ok = r.idle ? ok + 1 : 0; return ok >= 2 ? r : null; }, 'idle: ' + what, ms, 50);
}
const loadAvg = () => { try { return fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '); } catch { return ''; } };
async function timed(fn) { const t0 = now(); const r = await fn(); return [now() - t0, r]; }

// items: {path, netlistId}. Adds by instance path (what Add Variable by Path / terminal links / the API use); if
// that shows no row within 30 s, records the failure and adds by netlistId (the Netlist view's route).
async function addPaths(uri, items, rec) {
  const before = (await w.state()).rows.length;
  const want = before + items.length;
  let t0 = now();
  if (!rec.addByPathFailed) {
    for (const it of items) await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: String(uri), instancePath: it.path });
    try { await until(async () => { const s = await w.state(); return s.rows.length >= want ? s : null; }, `${items.length} rows by path`, 30000); return now() - t0; }
    catch (e) { rec.addByPathFailed = { path: items[0].path, name: items[0].name, label: items[0].label, rowsShown: (await w.state()).rows.length - before }; }
  }
  t0 = now();
  for (const it of items) await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: String(uri), netlistId: it.netlistId });
  await until(async () => { const s = await w.state(); return s.rows.length >= want ? s : null; }, `${items.length} rows by netlistId`, BIG);
  return now() - t0;
}

function heapMark(rec, tag) {
  const h = require('v8').getHeapStatistics(), m = process.memoryUsage();
  (rec.extMem = rec.extMem || {})[tag] = { heapMB: Math.round(h.used_heap_size / 1048576), rssMB: Math.round(m.rss / 1048576), extMB: Math.round(m.external / 1048576) };
}
async function oneRep(f, rep, found) {
  const rec = { label: f.label, file: path.basename(f.file), rep, load: loadAvg(), host: require('os').hostname() };
  heapMark(rec, 'start');
  const smp = sampler();
  const uri = vscode.Uri.file(f.file);
  let hp = null;
  if (process.env.SCALE_HEAPPROF && rep === 1) {
    const insp = require('inspector'); hp = new insp.Session(); hp.connect();
    const post = (m, p) => new Promise((res, rej) => hp.post(m, p || {}, (e, r) => e ? rej(e) : res(r)));
    hp.postP = post; await post('HeapProfiler.enable'); await post('HeapProfiler.startSampling', { samplingInterval: 32768 });
  }
  try {
    let [ms] = await timed(async () => {
      await require('./helpers.cjs').activate();
      await vscode.commands.executeCommand('vaporview.openFile', { uri });
      await until(async () => {
        const ws = await w.wispState(String(uri));
        if (ws && ws.refused) throw new Error('refused: ' + ws.refused);
        const d = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
        const list = Array.isArray(d) ? d : (d && d.documents) || [];
        return list.some((u) => String(u) === String(uri));
      }, 'document open', BIG);
    });
    rec.openMs = ms;
    let top;
    [ms, top] = await timed(() => vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 0, 50));
    rec.netlistTopMs = ms; rec.netlistTopItems = top && top.vars ? top.vars.length : null;
    rec.openToNetlistMs = rec.openMs + rec.netlistTopMs;
    heapMark(rec, 'netlist');
    // deepest scope (given, or found once by a breadth-first walk; that walk is not a metric)
    if (!found.deepest && !f.deepest) {
      const bfs = await vscode.commands.executeCommand('vaporview.e2e.scopeWalk', String(uri), null, 50000, 100);
      found.deepest = f.deepest || bfs.deepest.path; found.widest = bfs.widest.path; found.bfs = { scopes: bfs.scopesVisited, complete: bfs.complete, ms: Math.round(bfs.ms), depth: bfs.deepest.depth };
    }
    const walk = await vscode.commands.executeCommand('vaporview.e2e.scopeWalk', String(uri), f.deepest || found.deepest, 0, 100);
    if (hp) {
      const { profile } = await hp.postP('HeapProfiler.stopSampling');
      const dir = process.env.SCALE_PROF_DIR || '/tmp'; fs.mkdirSync(dir, { recursive: true });
      const fn = path.join(dir, `${f.label}-deepest.heapprofile`); fs.writeFileSync(fn, JSON.stringify(profile)); rec.heapProfile = fn; hp.disconnect();
    }
    if (walk.error) throw new Error('expand deepest: ' + JSON.stringify(walk));
    rec.deepest = walk.path; rec.depth = walk.depth; rec.expandDeepestMs = walk.totalMs; rec.expandLevelsMs = walk.levels.map((x) => +x.toFixed(1)); rec.deepestKids = walk.nKids;
    heapMark(rec, 'deepest');
    if (Number(process.env.SCALE_SEARCH_N || 0) > 0 && rep === 1) { const insp = require('inspector'); const ss = new insp.Session(); ss.connect(); await new Promise((r) => ss.post('HeapProfiler.collectGarbage', () => r())); ss.disconnect(); rec.searchHeapBeforeMB = Math.round(require('v8').getHeapStatistics().used_heap_size / 1048576); }
    // netlist search
    const needle = f.needle || (walk.vars[walk.vars.length - 1] || {}).name;
    const sr = await vscode.commands.executeCommand('vaporview.e2e.searchNetlistTimed', String(uri), needle);
    rec.search = { query: needle, ms: sr.ms, total: sr.total, first: sr.first, error: sr.error };
    // SCALE_SEARCH_N: more searches after the first (other names; the index is built once per file), with the GC'd heap
    // before the first search and after the last (gate: each later search < 2 s, heap growth < 150 MB)
    if (Number(process.env.SCALE_SEARCH_N || 0) > 0 && rep === 1) {
      const gcHeapMB = async () => { const insp = require('inspector'); const ss = new insp.Session(); ss.connect(); await new Promise((r) => ss.post('HeapProfiler.collectGarbage', () => r())); ss.disconnect(); return Math.round(require('v8').getHeapStatistics().used_heap_size / 1048576); };
      const names = walk.vars.map((v) => v.name).filter(Boolean);
      const qs = [names[0], names[Math.floor(names.length / 2)], 'clk', 'data', 'q', 'zz_no_such_name'].filter(Boolean).slice(0, Number(process.env.SCALE_SEARCH_N));
      const more = [];
      for (const q of qs) { const r2 = await vscode.commands.executeCommand('vaporview.e2e.searchNetlistTimed', String(uri), q); more.push({ query: q, ms: Math.round(r2.ms), total: r2.total, error: r2.error }); }
      rec.searchMore = more;
      rec.searchHeapAfterMB = await gcHeapMB();
    }
    // add 1, first paint
    const one = walk.vars[0];
    rec.add1RowsMs = await addPaths(uri, [one], rec);
    [ms] = await timed(() => idle('add 1'));
    rec.add1PaintMs = rec.add1RowsMs + ms;
    // add 100 more (from the deepest scope, topped up from the widest)
    let more = walk.vars.slice(1);
    if (more.length < 100 && found.widest) {
      const wide = await vscode.commands.executeCommand('vaporview.e2e.scopeWalk', String(uri), found.widest, 0, 200);
      if (!wide.error) more = more.concat(wide.vars.filter((p) => !more.some((m) => m.path === p.path) && p.path !== one.path));
    }
    more = more.slice(0, 99);
    rec.add100N = more.length + 1;
    rec.add100RowsMs = await addPaths(uri, more, rec);
    [ms] = await timed(() => idle('add 100'));
    rec.add100PaintMs = rec.add100RowsMs + ms;
    heapMark(rec, 'add100');
    let st = await w.state();
    rec.timeStop = st.timeStop;
    // zoom-all
    [ms] = await timed(async () => { await vscode.commands.executeCommand('vaporview.zoomToFit'); await sleep(20); await idle('zoom all'); });
    rec.zoomAllMs = ms;
    // pan: zoom to 2% around the middle, then 5 steps of half a screen
    const T = st.timeStop, span = Math.max(10, Math.floor(T / 50));
    let a = Math.floor(T / 2);
    [ms] = await timed(async () => { await query({ kind: 'zoomRange', t0: a, t1: a + span }); await sleep(20); await idle('zoom in'); });
    rec.zoomInMs = ms;
    rec.panMs = [];
    for (let i = 0; i < 5; i++) {
      a += Math.floor(span / 2);
      [ms] = await timed(async () => { await query({ kind: 'zoomRange', t0: a, t1: a + span }); await sleep(20); await idle('pan'); });
      rec.panMs.push(+ms.toFixed(1));
    }
    // value search: a multi-bit row, the value it has at 60% of the dump, searched forward from t = 0
    const tq = Math.floor(T * 0.6);
    await query({ kind: 'zoomRange', t0: 0, t1: T }); await idle('zoom out for search');
    let bus = null, fullPath = null, want = null;
    for (const p of [one, ...more].map((x) => x.path)) {
      const v = await w.apiValue(uri, tq, p), v0 = await w.apiValue(uri, 0, p);
      if (typeof v === 'string' && /^[01]{2,}$/.test(v) && v !== v0) { fullPath = p; want = v; break; }
    }
    if (!fullPath) throw new Error('no multi-bit row whose value at 60% differs from t=0');
    st = await w.state();
    bus = st.rows.find((r) => r.name === fullPath.split('.').pop());
    await query({ kind: 'select', name: bus.name });
    await query({ kind: 'marker', time: 0 });
    await until(async () => { const x = await w.state(); return x.markerTime === 0 ? x : null; }, 'marker 0');
    const hexWant = toHex(want);
    const done0 = (await w.state()).windowing.stats.navDone;
    [ms, st] = await timed(async () => {
      await query({ kind: 'searchValue', value: hexWant, direction: 1 });
      return until(async () => { const x = await w.state(); return x.markerTime !== 0 && (x.windowing.stats.navDone > done0 || !x.rows.find((r) => r.name === bus.name).windowed) ? x : null; }, 'value search', BIG, 50);
    });
    const got = await w.apiValue(uri, st.markerTime, fullPath);
    rec.valueSearch = { row: fullPath, value: hexWant, foundAt: st.markerTime, ms, valueOk: toHex(got) === hexWant, firstBy: tq };
    rec.trace = 'SKIP: no design model for this file';
    // hold: the user stops working; does the helper give memory back (WISP_IDLE_RELEASE_MS, default 30 s)?
    const hold = +(process.env.SCALE_HOLD_S || 45);
    const before = helperPids().reduce((a, p) => a + ((procStatus(p) || {}).rss || 0), 0);
    await sleep(hold * 1000);
    const after = helperPids().reduce((a, p) => a + ((procStatus(p) || {}).rss || 0), 0);
    rec.hold = { s: hold, helperRssBeforeMB: Math.round(before / 1024), helperRssAfterMB: Math.round(after / 1024) };
    const ws = await w.wispState(String(uri));
    rec.wisp = ws ? { refused: ws.refused, unverified: ws.unverified, signalErrors: (ws.signalErrors || []).length, windows: ws.windows } : null;
  } catch (e) {
    rec.error = String(e && e.message ? e.message : e);
    try { const ws = await w.wispState(String(uri)); if (ws) rec.wispOnError = { refused: ws.refused, messages: ws.messages, status: ws.status }; } catch {}
    try { rec.tabsOnError = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, viewType: t.input && t.input.viewType, uri: t.input && t.input.uri && String(t.input.uri), active: t.isActive }))); } catch (e2) { rec.tabsOnError = String(e2); }
  } finally {
    Object.assign(rec, smp.stop());
    emit(rec);
    await closeAll();
    await sleep(1500);
    if (global.gc) global.gc();
    await sleep(5000);
    heapMark(rec, 'closed');
    if (process.env.SCALE_HEAPSNAP && rep === 1) {
      try { const dir = process.env.SCALE_PROF_DIR || '/tmp'; fs.mkdirSync(dir, { recursive: true });
        rec.heapSnap = require('v8').writeHeapSnapshot(path.join(dir, `${f.label}-closed.heapsnapshot`));
        emit({ label: rec.label, rep, heapSnap: rec.heapSnap }); } catch (e) { emit({ label: rec.label, heapSnapError: String(e) }); }
    }
    emit({ label: rec.label, rep, extMemClosed: rec.extMem.closed });
  }
  if (rec.error) throw new Error(`${f.label} rep ${rep}: ${rec.error}`);
}
function toHex(v) {
  if (v === undefined || v === null) return String(v);
  const s = String(v);
  if (!/^[01]+$/.test(s)) return s;
  return BigInt('0b' + s).toString(16);
}

const files = (() => { try { return JSON.parse(process.env.SCALE_FILES || '[]'); } catch { return []; } })();
module.exports = {};
if (!files.length) module.exports['scale: SKIP (no SCALE_FILES)'] = async () => console.log('SKIP scale: SCALE_FILES unset');
for (const f of files) {
  module.exports[`scale: ${f.label}`] = async () => {
    if (!(await w.useHelper('scale ' + f.label))) throw new Error('no helper');
    const found = {};
    const errs = [];
    for (let rep = 1; rep <= (f.reps || 3); rep++) { try { await oneRep(f, rep, found); } catch (e) { errs.push(e.message); if (/timeout/.test(e.message)) break; } }
    emit({ label: f.label, found });
    if (errs.length) throw new Error(errs.join(' | '));
  };
}
