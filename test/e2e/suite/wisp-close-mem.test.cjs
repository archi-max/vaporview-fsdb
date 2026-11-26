// vscode-port: a closed waveform document must not keep its netlist in the extension host.
// Until the fix, resolveCustomEditor registered its per-panel listeners in context.subscriptions (extension
// lifetime); their closures held the document, and the document's _netlistIdTable held every NetlistItem expanded
// (d5.fsdb, 200K signals: 215 MB of heap still live after close + GC).
// Per format (E2E_FORMAT, default fsdb):
//   fsdb: E2E_CLOSE_MEM_FSDB = an FSDB with a large netlist (your own, on the test
//         machine). Unset: SKIP.
//   wcz:  E2E_CLOSE_MEM_WCZ, else a WCZ generated here: NSCOPE x NVAR 8-bit vars (wcz-from-vcd, E2E_WCZ_TOOLS).
// Steps: GC baseline -> open -> expand the whole netlist -> close -> GC -> heap within MAX_MB of the baseline. Then the
// same file opens again and lists the same netlist (closing must not break a reopen).
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const v8 = require('v8');
const { vscode, assert, until, closeAll, sleep, format } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const MAX_MB = Number(process.env.E2E_CLOSE_MEM_MAX_MB || 30);
const NSCOPE = 200, NVAR = 500;  // 100,000 vars: ~60-70 MB of NetlistItems when expanded

async function gcHeapMB() {
  const insp = require('inspector'), s = new insp.Session(); s.connect();
  const post = (m) => new Promise((res, rej) => s.post(m, {}, (e, r) => (e ? rej(e) : res(r))));
  for (let i = 0; i < 3; i++) { await post('HeapProfiler.collectGarbage'); await sleep(200); }
  s.disconnect();
  return v8.getHeapStatistics().used_heap_size / 1048576;
}
function makeWcz() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-close-mem-'));
  const vcd = path.join(dir, 'close-mem.vcd'), wcz = path.join(dir, 'close-mem.wcz');
  const id = (n) => { let s = ''; n += 1; while (n > 0) { s += String.fromCharCode(33 + (n % 94)); n = Math.floor(n / 94); } return s; };
  const out = ['$timescale 1ns $end', '$scope module top $end'];
  for (let s = 0; s < NSCOPE; s++) {
    out.push(`$scope module u${s} $end`);
    for (let v = 0; v < NVAR; v++) out.push(`$var wire 8 ${id(s * NVAR + v)} v${v} [7:0] $end`);
    out.push('$upscope $end');
  }
  out.push('$upscope $end', '$enddefinitions $end', '#0');
  for (let n = 0; n < NSCOPE * NVAR; n++) out.push('b' + (n & 0xff).toString(2) + ' ' + id(n));
  out.push('#10');
  for (let n = 0; n < NSCOPE * NVAR; n += 7) out.push('b' + ((n + 1) & 0xff).toString(2) + ' ' + id(n));
  out.push('#20');
  fs.writeFileSync(vcd, out.join('\n') + '\n');
  execFileSync(path.join(w.TOOLS, 'wcz-from-vcd'), [vcd, wcz], { stdio: 'pipe', timeout: 300000 });
  fs.rmSync(vcd);
  return { dir, wcz };
}
function fileFor() {
  if (format === 'fsdb') return process.env.E2E_CLOSE_MEM_FSDB || null;
  if (format === 'wcz') return process.env.E2E_CLOSE_MEM_WCZ || (w.TOOLS ? makeWcz().wcz : null);
  return null;
}
async function openDoc(uri) {
  await vscode.commands.executeCommand('vaporview.openFile', { uri });
  await until(async () => {
    const d = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
    const list = Array.isArray(d) ? d : (d && d.documents) || [];
    return list.some((u) => String(u) === String(uri));
  }, 'document open', 300000);
}
async function expandAll(uri) {
  const r = await vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), 64, 10000000);
  assert.ok(r && Array.isArray(r.vars), 'netlist: ' + JSON.stringify(r && r.error));
  return r.vars.length;
}

module.exports = {
  // activation (e2e hook commands included) must not throw: a duplicate command id once broke it on main 6f16960
  'extension activates without error': async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON && e.packageJSON.name === 'vaporview-fsdb');
    assert.ok(ext, 'vaporview extension present');
    await ext.activate();
    assert.ok(ext.isActive, 'vaporview active');
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['vaporview.openFile', 'vaporview.e2e.netlist', 'vaporview.e2e.searchNetlist', 'vaporview.e2e.searchNetlistTimed', 'vaporview.e2e.post']) assert.ok(cmds.includes(c), 'command registered: ' + c);
  },
  [`closed document frees its netlist (${format})`]: async () => {
    if (!(await w.useHelper('wisp close memory'))) return;
    const file = fileFor();
    if (!file || !fs.existsSync(file)) { console.log(`SKIP wisp close memory (${format}): no file (E2E_CLOSE_MEM_${format.toUpperCase()})`); return; }
    const uri = vscode.Uri.file(file);
    await closeAll();
    const base = await gcHeapMB();
    await openDoc(uri);
    const n1 = await expandAll(uri);
    const open = await gcHeapMB();
    await closeAll();
    await sleep(2000);
    const after = await gcHeapMB();
    console.log(`  DIAGNOSTIC close-mem ${format} ${path.basename(file)}: ${n1} vars; ext heap after GC: baseline ${base.toFixed(0)} MB, ` +
      `expanded ${open.toFixed(0)} MB, after close ${after.toFixed(0)} MB (limit baseline + ${MAX_MB} MB)`);
    assert.ok(open - base > MAX_MB, `expanding ${n1} vars grew the heap only ${(open - base).toFixed(0)} MB: the file is too small to detect a leak`);
    assert.ok(after - base <= MAX_MB, `closed document still holds ${(after - base).toFixed(0)} MB of heap (baseline ${base.toFixed(0)}, after close ${after.toFixed(0)})`);
    // reopen: the same netlist again
    await openDoc(uri);
    const n2 = await expandAll(uri);
    assert.strictEqual(n2, n1, 'reopened netlist var count');
    await closeAll();
  },
};
