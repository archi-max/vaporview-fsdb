// vscode-port: profile "add 100 rows" on a large file. SKIPs without SCALE_PROF (the file).
// Env: SCALE_PROF_SCOPE (scope with >= 100 vars), SCALE_PROF_DIR (where .cpuprofile files go), SCALE_CDP_PORT (VS Code
// started with --remote-debugging-port: the webview is profiled through CDP too). Arms, interleaved, n = SCALE_PROF_N:
//   single: 100 waveformViewer.addVariable({netlistId}) calls (the API / one-at-a-time path)
//   batch:  one renderSignals with 100 ids (what Add Selected / Add All in Scope do)
// Times: to 100 rows in the webview state, and to idle (painted, no data pending). DIAGNOSTIC.
const fs = require('fs'), path = require('path');
const inspector = require('inspector');
const { vscode, until, open, query, sleep, closeAll } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');
const now = () => Number(process.hrtime.bigint()) / 1e6;
const FILE = process.env.SCALE_PROF, DIR = process.env.SCALE_PROF_DIR || '/tmp', PORT = process.env.SCALE_CDP_PORT;

function extProfiler() {
  const s = new inspector.Session(); s.connect();
  const post = (m, p) => new Promise((res, rej) => s.post(m, p || {}, (e, r) => e ? rej(e) : res(r)));
  return { start: async () => { await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 200 }); await post('Profiler.start'); },
    stop: async (f) => { const r = await post('Profiler.stop'); fs.writeFileSync(f, JSON.stringify(r.profile)); s.disconnect(); } };
}
async function cdpTargets() {
  if (!PORT) return [];
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.filter((t) => /vscode-webview/.test(t.url) && t.webSocketDebuggerUrl);
}
function cdp(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = async (method, params) => { await ready; const i = ++id; return new Promise((r) => { pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); }); };
  return { start: async () => { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 200 }); await send('Profiler.start'); },
    stop: async (f) => { const r = await send('Profiler.stop'); fs.writeFileSync(f, JSON.stringify(r.result && r.result.profile)); ws.close(); }, url: t.url };
}
async function idle(ms = 600000) {
  let ok = 0;
  return until(async () => { const r = await query({ kind: 'idle' }); ok = r.idle ? ok + 1 : 0; return ok >= 2 ? r : null; }, 'idle', ms, 20);
}

module.exports = FILE ? {
  'scale prof: add 100 rows': async () => {
    await w.useHelper('prof');
    const N = +(process.env.SCALE_PROF_N || 3);
    const res = [];
    for (let rep = 1; rep <= N; rep++) {
      for (const arm of rep % 2 ? ['batch', 'single'] : ['single', 'batch']) {
        await closeAll(); await sleep(1500);
        const uri = vscode.Uri.file(FILE);
        await open(uri);
        const walk = await vscode.commands.executeCommand('vaporview.e2e.scopeWalk', String(uri), process.env.SCALE_PROF_SCOPE, 0, 100);
        const ids = walk.vars.slice(0, 100).map((v) => v.netlistId);
        await sleep(2000);
        const tg = await cdpTargets();
        const wv = tg.map(cdp), ext = extProfiler();
        await ext.start(); for (const c of wv) await c.start();
        const t0 = now();
        if (arm === 'single') { for (const id of ids) await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: String(uri), netlistId: id }); }
        else await vscode.commands.executeCommand('vaporview.e2e.addBatch', String(uri), ids);
        const tCmd = now() - t0;
        await until(async () => { const s = await w.state(); return s.rows.length >= ids.length ? s : null; }, '100 rows', 600000, 20);
        const tRows = now() - t0;
        await idle();
        const tPaint = now() - t0;
        const base = path.join(DIR, `${path.basename(FILE)}-${arm}-r${rep}`);
        await ext.stop(base + '-ext.cpuprofile');
        for (let i = 0; i < wv.length; i++) await wv[i].stop(`${base}-webview${i}.cpuprofile`);
        const st = await w.state();
        const r = { file: path.basename(FILE), arm, rep, n: ids.length, cmdMs: Math.round(tCmd), rowsMs: Math.round(tRows), paintMs: Math.round(tPaint), webviewTargets: tg.length, windowing: st.windowing.stats.requests, profiles: base };
        console.log('  PROF ' + JSON.stringify(r)); res.push(r);
      }
    }
    fs.writeFileSync(path.join(DIR, 'prof-results.json'), JSON.stringify(res, null, 1));
  },
} : {};
