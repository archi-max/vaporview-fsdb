// SPDX-License-Identifier: MIT
// idle.mjs <wisp-helper> <wcz-from-vcd> [fsdb]: idle release checks (node 18+, no packages).
//   I1 WCZ: after a whole-range window over 48 rows (blocks in the decoded-block LRU), WISP_IDLE_RELEASE_MS=800 and
//      2.5 s without a request: stats idleReleases >= 1, blockLru.bytes 0, and RSS down by at least half the LRU bytes
//      it held; the same window afterwards gives the same answer (blocks decode again)
//   I2 WISP_IDLE_RELEASE_MS=0: no release (idleReleases 0, LRU kept)
//   I3 (optional FSDB): an FSDB read in place gives back its reader's block cache too (idleReleases >= 1, RSS down)
// 15.7 has no idle release: I1 and I3 FAIL (idleReleases missing, LRU kept).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const [H, V2W, FSDB] = process.argv.slice(2);
if (!H || !V2W) { console.error('usage: idle.mjs <wisp-helper> <wcz-from-vcd> [fsdb]'); process.exit(2); }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-idle-'));
const N = 48, STEP = 10, END = 400000;
const vcd = path.join(T, 'i.vcd'), wcz = path.join(T, 'i.wcz');
const code = (k) => String.fromCharCode(33 + k);
{
  const fd = fs.openSync(vcd, 'w');
  let out = ['$timescale 1ns $end', '$scope module top $end'];
  for (let k = 0; k < N; k++) out.push(`$var wire 16 ${code(k)} s${k} [15:0] $end`);
  out.push('$upscope $end', '$enddefinitions $end');
  for (let i = 0; i * STEP < END; i++) {
    out.push('#' + i * STEP);
    for (let k = 0; k < N; k++) { let x = (i * 2654435761 + k * 40503) >>> 0; x ^= x >>> 13; out.push('b' + ((x * 1274126177 >>> 0) & 0xffff).toString(2) + ' ' + code(k)); }
    if (out.length > 100000) { fs.writeSync(fd, out.join('\n') + '\n'); out = []; }
  }
  out.push('#' + END);
  fs.writeSync(fd, out.join('\n') + '\n'); fs.closeSync(fd);
  execFileSync(V2W, [vcd, wcz], { stdio: 'pipe' });
  fs.rmSync(vcd);
}
function helper(env) {
  const p = spawn(H, [], { stdio: ['pipe', 'ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
  const replies = new Map(); let waiters = []; let buf = Buffer.alloc(0), want = null, next = 1;
  p.stdio[3].on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (want) { if (buf.length < want.n) break; want.line.bin = buf.subarray(0, want.n).toString('base64'); buf = buf.subarray(want.n); replies.set(want.line.id, want.line); want = null; continue; }
      const i = buf.indexOf(10); if (i < 0) break;
      const line = JSON.parse(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1);
      if (line.binLength > 0) { want = { line, n: line.binLength }; continue; }
      replies.set(line.id, line);
    }
    waiters = waiters.filter((w) => !w());
  });
  const ask = (o) => { const id = next++; p.stdin.write(JSON.stringify({ ...o, id }) + '\n'); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 120000); const w = () => { if (replies.has(id)) { clearTimeout(t); res(replies.get(id)); return true; } return false; }; if (!w()) waiters.push(w); }); };
  return { ask, close: () => p.stdin.end() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sigs = Array.from({ length: N }, (_, k) => ({ signalId: k + 1, width: 16 }));
let fails = 0;
const ok = (m) => console.log('PASS ' + m), bad = (m) => { console.log('FAIL ' + m); fails++; };

async function run(file, env, label, check) {
  const h = helper(env);
  const o = await h.ask({ cmd: 'open', file });
  if (o.error) { bad(`${label}: open: ${o.error}`); h.close(); return; }
  const te = o.result.metadata.timeEnd;
  const win = { cmd: 'window', signals: file === wcz ? sigs : Array.from({ length: 48 }, (_, k) => ({ signalId: k + 1 })), t0: 0, t1: te, buckets: 4096 };
  const w1 = await h.ask(win);
  const s1 = await h.ask({ cmd: 'stats' });
  await sleep(2500);
  const s2 = await h.ask({ cmd: 'stats' });
  const w2 = await h.ask({ ...win });
  check(s1.result, s2.result, JSON.stringify(w1.result) + w1.bin === JSON.stringify(w2.result).replace(/"tile":true,?/g, '') + w2.bin || sameRows(w1, w2));
  h.close();
}
function sameRows(a, b) {  // (the second answer may come from the answer cache: tile:true, walkMs differ)
  const strip = (r) => JSON.stringify((r.result.signals || []).map(({ walkMs, tile, cached, ...x }) => x));
  return strip(a) === strip(b) && a.bin === b.bin;
}
await run(wcz, { WISP_IDLE_RELEASE_MS: '800' }, 'I1', (a, b, same) => {
  const lru = a.blockLru ? a.blockLru.bytes : 0;
  if (b.idleReleases >= 1 && lru > 0 && b.blockLru.bytes === 0 && a.rssKB - b.rssKB >= lru / 2048 && same)
    ok(`I1 WCZ idle release: LRU ${(lru / 1e6).toFixed(1)} MB -> 0, RSS ${a.rssKB} -> ${b.rssKB} kB, same answer after`);
  else bad(`I1 WCZ idle release: idleReleases ${b.idleReleases}, LRU ${lru} -> ${b.blockLru && b.blockLru.bytes}, RSS ${a.rssKB} -> ${b.rssKB} kB, same ${same}`);
});
await run(wcz, { WISP_IDLE_RELEASE_MS: '0' }, 'I2', (a, b) => {
  b.idleReleases === 0 && b.blockLru.bytes === a.blockLru.bytes && a.blockLru.bytes > 0 ? ok('I2 WISP_IDLE_RELEASE_MS=0: no release') : bad(`I2: idleReleases ${b.idleReleases}, LRU ${a.blockLru && a.blockLru.bytes} -> ${b.blockLru && b.blockLru.bytes}`);
});
if (FSDB && fs.existsSync(FSDB)) {
  await run(FSDB, { WISP_IDLE_RELEASE_MS: '800' }, 'I3', (a, b, same) => {
    b.idleReleases >= 1 && b.rssKB < a.rssKB && same ? ok(`I3 FSDB idle release: RSS ${a.rssKB} -> ${b.rssKB} kB, same answer after`) : bad(`I3 FSDB: idleReleases ${b.idleReleases}, RSS ${a.rssKB} -> ${b.rssKB} kB, same ${same}`);
  });
} else console.log('SKIP I3: no FSDB given');
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `idle: ${fails} FAIL` : 'idle: all PASS');
process.exit(fails ? 1 : 0);
