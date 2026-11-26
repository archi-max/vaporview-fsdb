// vscode-port P2 acceptance: windowed loading of a large WCZ through wisp-helper. The VCD (1.8M changes) is
// generated here and converted with wcz-from-vcd on the test machine; nothing large is committed.
//   top.clk   toggles every time unit: 1 at even t, 0 at odd t          (1.2M changes)
//   top.cnt   16 bits, at even t = (t / 2) & 0xffff                     (600k changes: windowed, over the hybrid limit)
//   top.slow  8 bits, (t / 100000) & 0xff, changes every 100000         (13 changes: loaded whole)
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { vscode, assert, until, open, query } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const T_END = 1200000;
const bin = (v, n) => v.toString(2).padStart(n, '0');
const cntAt = (t) => bin((Math.floor(t / 2)) & 0xffff, 16);
const clkAt = (t) => (t % 2 === 0 ? '1' : '0');
let made = null;

function makeLarge() {
  if (made) return made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-wisp-large-'));
  const vcd = path.join(dir, 'large.vcd'), wcz = path.join(dir, 'large.wcz');
  const fd = fs.openSync(vcd, 'w');
  fs.writeSync(fd, '$timescale 1ns $end\n$scope module top $end\n$var wire 1 ! clk $end\n$var wire 16 " cnt [15:0] $end\n$var wire 8 # slow [7:0] $end\n$upscope $end\n$enddefinitions $end\n');
  let buf = [];
  for (let t = 0; t < T_END; t++) {
    let s = '#' + t + '\n' + clkAt(t) + '!\n';
    if (t % 2 === 0) s += 'b' + cntAt(t) + ' "\n';
    if (t % 100000 === 0) s += 'b' + bin((t / 100000) & 0xff, 8) + ' #\n';
    buf.push(s);
    if (buf.length >= 50000) { fs.writeSync(fd, buf.join('')); buf = []; }
  }
  buf.push('#' + T_END + '\n');
  fs.writeSync(fd, buf.join('')); fs.closeSync(fd);
  const t0 = Date.now();
  execFileSync(path.join(w.TOOLS, 'wcz-from-vcd'), [vcd, wcz], { stdio: 'pipe', timeout: 300000 });
  console.log(`  DIAGNOSTIC large.vcd ${fs.statSync(vcd).size} B -> large.wcz ${fs.statSync(wcz).size} B in ${Date.now() - t0} ms`);
  fs.rmSync(vcd);
  made = { dir, wcz };
  return made;
}

async function ready(what) {
  if (!(await w.useHelper(what))) return null;
  if (!w.TOOLS || !fs.existsSync(path.join(w.TOOLS, 'wcz-from-vcd'))) { console.log(`SKIP ${what}: no wcz-from-vcd (E2E_WCZ_TOOLS=${w.TOOLS || 'unset'})`); return null; }
  const { wcz } = makeLarge();
  const uri = String(await open(vscode.Uri.file(wcz)));
  await w.add(uri, ['top.cnt', 'top.clk', 'top.slow']);
  return uri;
}

module.exports = {
  'wisp large: windowed rows, zoom-to-fit, values at markers match the VCD': async () => {
    const uri = await ready('large windowed');
    if (!uri) return;
    await vscode.commands.executeCommand('vaporview.zoomToFit');
    const s = await until(async () => {
      const st = await w.state();
      const sig = (n) => st.windowing.signals.find((x) => x.signalId === st.rows.find((r) => r.name === n).signalId);
      const cnt = sig('cnt'), slow = sig('slow');
      return st.windowing.enabled && cnt && cnt.hybrid === 'windowed' && cnt.decimatedWindows > 0 && slow && slow.hybrid === 'local' ? st : null;
    }, 'cnt windowed with per-pixel summaries, slow loaded whole', 60000);
    // the view ends past the dump's last timestamp by timeEnd/1000 (at least 1), as wisp_handler.padTimeEnd pads it
    assert.strictEqual(s.timeStop, T_END + Math.max(Math.ceil(T_END / 1000), 1));
    assert.ok(s.rows.find((r) => r.name === 'cnt').windowed && !s.rows.find((r) => r.name === 'slow').windowed);
    console.log('  DIAGNOSTIC after zoom-to-fit', JSON.stringify(s.windowing.stats));
    // Every window the viewer asks for wants deflated bucket counts (-28% bytes on pan/zoom-1%); the
    // decimated windows above decoded with them.
    const wsz = await w.wispState(uri);
    assert.ok(wsz.windows > 0 && wsz.windowsDeflateCounts === wsz.windows, JSON.stringify({ windows: wsz.windows, deflateCounts: wsz.windowsDeflateCounts }));
    for (const t of [1, 2, 123457, 600001, 999998, 1199999]) {
      assert.strictEqual(await w.markerValue('cnt', t), cntAt(t), `cnt at ${t}`);
      assert.strictEqual(await w.apiValue(uri, t, 'top.cnt'), cntAt(t), `api cnt at ${t}`);
      assert.strictEqual(await w.apiValue(uri, t, 'top.clk'), clkAt(t), `api clk at ${t}`);
    }
    assert.strictEqual(await w.markerValue('slow', 777777), bin(7, 8));
    // Zoom into a narrow range: exact windows there, values still right.
    await query({ kind: 'zoomRange', t0: 500000, t1: 500400 });
    await until(async () => { const st = await w.state(); const c = st.windowing.signals.find((x) => x.signalId === st.rows.find((r) => r.name === 'cnt').signalId); return c.exactWindows > 0 ? st : null; }, 'exact windows after zoom in', 30000);
    assert.strictEqual(await w.markerValue('cnt', 500123), cntAt(500123));
    // Prefetch: the window cache asked for tiles beyond the visible ones (one screen each side, one level out).
    const st = await w.state();
    assert.ok(st.windowing.stats.requests > 2, JSON.stringify(st.windowing.stats));
  },

  'wisp large: next/previous edge and value search through the helper, cancel': async () => {
    const uri = await ready('large edges');
    if (!uri) return;
    await query({ kind: 'zoomRange', t0: 0, t1: T_END });
    await query({ kind: 'select', name: 'cnt' });
    const nav = async (q, want, what) => {
      await query(q);
      const st = await until(async () => { const x = await w.state(); return x.markerTime === want ? x : null; }, what + ' -> ' + want, 30000);
      return st;
    };
    await query({ kind: 'marker', time: 1000001 });
    await nav({ kind: 'edge', direction: 1 }, 1000002, 'next edge');
    await nav({ kind: 'edge', direction: 1 }, 1000004, 'next edge again');
    await nav({ kind: 'edge', direction: -1 }, 1000002, 'previous edge');
    // Value search (hex, the row's default format): cnt == 0xabcd first at t = 2 * 0xabcd, then one wrap later.
    await query({ kind: 'marker', time: 0 });
    await nav({ kind: 'searchValue', value: 'abcd', direction: 1 }, 2 * 0xabcd, 'search abcd');
    await nav({ kind: 'searchValue', value: 'abcd', direction: 1 }, 2 * (0xabcd + 65536), 'search abcd again');
    await nav({ kind: 'searchValue', value: 'abcd', direction: -1 }, 2 * 0xabcd, 'search abcd back');
    let st = await w.state();
    assert.ok(st.rows.find((r) => r.name === 'cnt').windowed, 'cnt stays windowed: answers came from the helper');
    // Cancel: a whole-dump window cancelled at once goes viewer -> extension -> helper; the view keeps working.
    const before = (await w.wispState(uri)).cancels;
    await query({ kind: 'cancelProbe', name: 'cnt' });
    await until(async () => { const ws = await w.wispState(uri); return ws.cancels > before ? ws : null; }, 'cancel relayed');
    assert.strictEqual(await w.markerValue('cnt', 4242), cntAt(4242));
    const ws = await w.wispState(uri);
    assert.strictEqual(ws.signalErrors.length, 0, JSON.stringify(ws.signalErrors));
    console.log('  DIAGNOSTIC relay', JSON.stringify({ relayed: ws.relayed, cancels: ws.cancels }));
  },

  // vscode-port: searchText on a RISC-V row. wisp-helper 15.7 has no searchText, so the extension host scans
  // exact windows with the viewer's formatters (text_search.ts). Same marker as the page's own scan; both timed.
  'wisp large: searchText (RISC-V) in the extension host vs the page scan': async () => {
    const uri = await ready('large searchText');
    if (!uri) return;
    const F = require(path.join(__dirname, '..', '..', '..', 'dist', 'host_formats.js'));
    const text = (v) => F.formatRiscvBinaryString(bin(v, 16), true, F.riscvOptions.riscv);
    // A value whose disassembly no other 16-bit value shares: the search is "cnt == v" in RISC-V text.
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let v = 0xc123, pattern = null;
    for (; v < 0x10000; v += 7) {
      const re = new RegExp('^' + esc(text(v)) + '$', 'i');
      let n = 0; for (let x = 0; x < 0x10000 && n < 2; x++) if (re.test(text(x))) n++;
      if (n === 1) { pattern = '^' + esc(text(v)) + '$'; break; }
    }
    assert.ok(pattern, 'a value with a unique disassembly');
    const nextHit = (t) => { let k = Math.floor((t + 1) / 2); for (;; k++) if ((k & 0xffff) === v && 2 * k > t) return 2 * k; };
    await query({ kind: 'zoomRange', t0: 0, t1: T_END });
    await query({ kind: 'select', name: 'cnt' });
    const times = { host: [], page: [] };
    let wrap = 0;
    for (let rep = 0; rep < 4; rep++) {
      for (const arm of rep % 2 ? ['page', 'host'] : ['host', 'page']) {
        // Each search in its own wrap (131072 time units, 65536 changes), so no arm reuses windows the other loaded.
        const start = wrap++ * 131072 + 2 * ((v + 1) & 0xffff) + 1;
        const want = nextHit(start);
        await query({ kind: 'format', name: 'cnt', format: 'riscv', textSearch: arm === 'host' });
        await query({ kind: 'marker', time: start });
        await until(async () => { const st = await w.state(); return st.markerTime === start ? st : null; }, 'marker ' + start);
        const before = (await w.wispState(uri)).textSearches;
        const done0 = (await w.state()).windowing.stats.navDone;
        await query({ kind: 'searchValue', value: pattern, direction: 1 });
        const fin = await until(async () => { const st = await w.state(); return st.markerTime === want && st.windowing.stats.navDone > done0 ? st : null; }, `${arm} search -> ${want}`, 60000);
        times[arm].push(Math.round(fin.windowing.stats.navMs[fin.windowing.stats.navMs.length - 1]));
        const ws = await w.wispState(uri);
        if (arm === 'host') {
          assert.strictEqual(ws.textSearches, before + 1, 'answered by the host searchText');
          assert.ok(ws.lastTextSearch && ws.lastTextSearch.found, JSON.stringify(ws.lastTextSearch));
        } else {
          assert.strictEqual(ws.textSearches, before, 'page scan: no searchText');
        }
      }
    }
    // Backward too, host only: the previous hit before start.
    await query({ kind: 'format', name: 'cnt', format: 'riscv', textSearch: true });
    const start = 1000001, prev = nextHit(start) - 131072;
    await query({ kind: 'marker', time: start });
    await query({ kind: 'searchValue', value: pattern, direction: -1 });
    await until(async () => { const st = await w.state(); return st.markerTime === prev ? st : null; }, 'host search back -> ' + prev, 60000);
    let st = await w.state();
    assert.strictEqual(st.rows.find((r) => r.name === 'cnt').format, 'riscv');
    // No match anywhere: the whole 600k-change row is scanned from t = 0 and the marker stays. Page scan vs host scan
    // (the host's first run judges each of the 65536 distinct values once; its repeats use the kept verdicts).
    const full = { host: [], page: [] };
    for (let rep = 0; rep < 3; rep++) {
      for (const arm of rep % 2 ? ['page', 'host'] : ['host', 'page']) {
        await query({ kind: 'format', name: 'cnt', format: 'riscv', textSearch: arm === 'host' });
        await query({ kind: 'marker', time: 0 });
        await until(async () => { const x = await w.state(); return x.markerTime === 0 ? x : null; }, 'marker 0');
        const done0 = (await w.state()).windowing.stats.navDone;
        const ts0 = (await w.wispState(uri)).textSearches;
        await query({ kind: 'searchValue', value: '^no such instruction$', direction: 1 });
        const fin = await until(async () => { const x = await w.state(); return x.windowing.stats.navDone > done0 ? x : null; }, arm + ' full scan', 120000);
        assert.strictEqual(fin.markerTime, 0, 'no match: the marker stays');
        full[arm].push(Math.round(fin.windowing.stats.navMs[fin.windowing.stats.navMs.length - 1]));
        const ws = await w.wispState(uri);
        if (arm === 'host') assert.ok(ws.textSearches > ts0 && ws.lastTextSearch && !ws.lastTextSearch.found && !ws.lastTextSearch.incomplete, JSON.stringify(ws.lastTextSearch));
        else assert.strictEqual(ws.textSearches, ts0);
      }
    }
    console.log(`  DIAGNOSTIC searchText full 600k-change scan (no match), ms host ${JSON.stringify(full.host)} | page ${JSON.stringify(full.page)}`);
    st = await w.state();
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const ws = await w.wispState(uri);
    console.log(`  DIAGNOSTIC searchText 65536-change scan, ms host ${JSON.stringify(times.host)} median ${med(times.host)} | page ${JSON.stringify(times.page)} median ${med(times.page)} | last host ${JSON.stringify(ws.lastTextSearch)}`);
    await query({ kind: 'format', name: 'cnt', format: 'hexadecimal', textSearch: true });
  },

  'wisp large: cleanup': async () => { if (made) { fs.rmSync(made.dir, { recursive: true, force: true }); made = null; } },
};
