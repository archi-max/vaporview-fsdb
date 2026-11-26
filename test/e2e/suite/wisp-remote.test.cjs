// vscode-port, Remote-SSH (measured): over a remote link round trips cost
// more than bytes. With a simulated link (vaporview.wisp.simulatedLink "100,3": 100 ms RTT, 3 MB/s down, as measured
// Mac <-> a Linux host), remote mode (vaporview.wisp.remoteMode on) must
//   - pan in about one round trip (prefetch goes out with the visible tiles), no slower than remote mode off;
//   - keep the hybrid whole loads off the link while the visible window loads, and small (<= 50k changes);
//   - show the same values.
// The WCZ is generated here (16 rows x 200k changes) and converted with wcz-from-vcd; nothing large is committed.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { vscode, assert, until, open, query, closeAll } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const ROWS = 16, END = 400000, RTT = 100;
const code = (k) => String.fromCharCode(33 + k);
const valAt = (k, t) => { const i = Math.floor(t / 2); let x = (i * 2654435761 + k * 40503) >>> 0; x ^= x >>> 13; return ((x * 1274126177) >>> 0) & 0xffff; };
const bin16 = (v) => v.toString(2).padStart(16, '0');
let made = null;
function make() {
  if (made) return made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-wisp-remote-'));
  const vcd = path.join(dir, 'r.vcd'), wcz = path.join(dir, 'r.wcz');
  const fd = fs.openSync(vcd, 'w');
  let out = ['$timescale 1ns $end', '$scope module top $end'];
  for (let k = 0; k < ROWS; k++) out.push(`$var wire 16 ${code(k)} s${k} [15:0] $end`);
  out.push('$upscope $end', '$enddefinitions $end');
  for (let t = 0; t < END; t += 2) {
    out.push('#' + t);
    for (let k = 0; k < ROWS; k++) out.push('b' + bin16(valAt(k, t)) + ' ' + code(k));
    if (out.length > 200000) { fs.writeSync(fd, out.join('\n') + '\n'); out = []; }
  }
  out.push('#' + END);
  fs.writeSync(fd, out.join('\n') + '\n'); fs.closeSync(fd);
  execFileSync(path.join(w.TOOLS, 'wcz-from-vcd'), [vcd, wcz], { stdio: 'pipe', timeout: 300000 });
  fs.rmSync(vcd);
  made = { dir, wcz };
  return made;
}

async function run(mode) {
  await w.setSetting('wisp.simulatedLink', `${RTT},3`);
  await w.setSetting('wisp.remoteMode', mode);
  const uri = String(await open(vscode.Uri.file(make().wcz)));
  await w.add(uri, Array.from({ length: ROWS }, (_, k) => 'top.s' + k));
  let st = await w.state();
  assert.strictEqual(st.windowing.stats.remote, mode === 'on', 'remote mode as set');
  const names = Array.from({ length: ROWS }, (_, k) => 's' + k);
  // Ready = every row shows its value at the marker (the view's centre).
  const ready = async (t, what) => {
    await query({ kind: 'marker', time: t });
    return until(async () => {
      const x = await w.state();
      if (x.markerTime !== t) return null;
      for (let k = 0; k < ROWS; k++) {
        const r = x.rows.find((q) => q.name === names[k]);
        const v = r && Array.isArray(r.value) && r.value.length ? r.value[r.value.length - 1] : null;
        if (v !== bin16(valAt(k, t))) return null;
      }
      return x;
    }, `${mode}: values at ${t}`, 60000);
  };
  const span = 4000;  // 1% of the dump: 2000 changes per row on screen
  let t0 = 100000;
  await query({ kind: 'zoomRange', t0, t1: t0 + span });
  const o0 = Date.now();
  await ready(t0 + span / 2 + 1, 'first view');
  const first = Date.now() - o0;
  const wholeBeforeFirst = (await w.state()).windowing.stats.wholeLoads;
  const pans = [];
  for (let i = 0; i < 10; i++) {
    t0 += span / 2;
    const p0 = Date.now();
    await query({ kind: 'zoomRange', t0, t1: t0 + span });
    await ready(t0 + span / 2 + 1, 'pan ' + i);
    pans.push(Date.now() - p0);
    await new Promise((r) => setTimeout(r, 250));  // a user's pace: what was prefetched lands
  }
  st = await w.state();
  const ws = await w.wispState(uri);
  await closeAll();
  return { first, pans, wholeBeforeFirst, wholeLoads: st.windowing.stats.wholeLoads, visibleMs: st.windowing.stats.visibleMs, windows: ws.windows };
}

module.exports = {
  'wisp remote: simulated 100 ms / 3 MB/s link, remote mode pans in about one round trip, no hybrid load ahead of the view': async () => {
    if (!(await w.useHelper('remote'))) return;
    if (!w.TOOLS || !fs.existsSync(path.join(w.TOOLS, 'wcz-from-vcd'))) { console.log('SKIP remote: no wcz-from-vcd'); return; }
    try {
      const off = await run('off'), on = await run('on');
      const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
      console.log(`  DIAGNOSTIC remote link ${RTT} ms / 3 MB/s, 16 rows x 200k changes, 1% view, 10 half-screen pans:`);
      console.log(`  DIAGNOSTIC   mode off: first ${off.first} ms, pans ${JSON.stringify(off.pans)} median ${med(off.pans)}, whole loads ${off.wholeLoads} (${off.wholeBeforeFirst} before the first view), windows ${off.windows}`);
      console.log(`  DIAGNOSTIC   mode on:  first ${on.first} ms, pans ${JSON.stringify(on.pans)} median ${med(on.pans)}, whole loads ${on.wholeLoads} (${on.wholeBeforeFirst} before the first view), windows ${on.windows}`);
      const B = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'perf', 'BASELINE.json'), 'utf8'))['remote.simulatedLink'];
      assert.ok(B, 'BASELINE.json remote.simulatedLink');
      assert.strictEqual(on.wholeBeforeFirst, 0, 'remote mode: no whole load before the first view');
      assert.strictEqual(on.wholeLoads, 0, 'remote mode: 200k-change rows are over the remote whole-load limit (50k)');
      assert.ok(med(on.pans) <= med(off.pans) * B.vsOffRatio + B.slackMs, `remote pans ${med(on.pans)} ms vs off ${med(off.pans)} ms`);
      assert.ok(med(on.pans) <= B.panRtts * RTT + B.slackMs, `remote pan median ${med(on.pans)} ms <= ${B.panRtts} RTT + ${B.slackMs} ms`);
    } finally {
      await w.setSetting('wisp.simulatedLink', '');
      await w.setSetting('wisp.remoteMode', 'auto');
    }
  },
  'wisp remote: cleanup': async () => { if (made) { fs.rmSync(made.dir, { recursive: true, force: true }); made = null; } },
};
