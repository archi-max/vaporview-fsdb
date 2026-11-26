// SPDX-License-Identifier: MIT
// checkmem.mjs <wisp-helper> <fsdb>: memory of an FSDB read in place (node 18+, no packages; Linux /proc).
//   M1 the lazy whole-file check (it reads every block once) leaves RSS within 4 x the file size + 16 MB of the RSS
//      right after open: one-pass walks go around the shared decoded-block cache instead of filling it with the file
//   M2 a 48-row whole-range window afterwards gives the same answer as one asked before the check finished
// M1 fails when the whole-file check leaves every decoded block in the shared cache.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [H, F] = process.argv.slice(2);
if (!H || !F) { console.error('usage: checkmem.mjs <wisp-helper> <fsdb>'); process.exit(2); }
const p = spawn(H, [], { stdio: ['pipe', 'ignore', 'ignore', 'pipe'], env: { ...process.env, WISP_IDLE_RELEASE_MS: '0' } });
const replies = new Map(); let waiters = []; let buf = Buffer.alloc(0), want = null, next = 1;
p.stdio[3].on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (want) { if (buf.length < want.n) break; want.line.bin = buf.subarray(0, want.n).toString('base64'); buf = buf.subarray(want.n); replies.set(want.line.id, want.line); want = null; continue; }
    const i = buf.indexOf(10); if (i < 0) break;
    const line = JSON.parse(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1);
    if (line.binLength > 0) { want = { line, n: line.binLength }; continue; }
    if (!line.event) replies.set(line.id, line);
  }
  waiters = waiters.filter((w) => !w());
});
const ask = (o) => { const id = next++; p.stdin.write(JSON.stringify({ ...o, id }) + '\n'); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 120000); const w = () => { if (replies.has(id)) { clearTimeout(t); res(replies.get(id)); return true; } return false; }; if (!w()) waiters.push(w); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rss = () => +fs.readFileSync(`/proc/${p.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1];
let fails = 0; const ok = (m) => console.log('PASS ' + m), bad = (m) => { console.log('FAIL ' + m); fails++; };
const o = await ask({ cmd: 'open', file: F });
if (o.error) { console.log('FAIL open: ' + o.error); process.exit(1); }
const r0 = rss();
const strip = (r) => JSON.stringify((r.result.signals || []).map(({ walkMs, tile, cached, ...x }) => x)) + r.bin;
const win = { cmd: 'window', signals: Array.from({ length: 48 }, (_, k) => ({ signalId: k + 1 })), t0: 0, t1: o.result.metadata.timeEnd, buckets: 4096 };
let st;
for (let k = 0; k < 600; k++) { st = (await ask({ cmd: 'stats' })).result; if (st.check && st.check !== 'running') break; await sleep(100); }
const r1 = rss();
const limit = 4 * fs.statSync(F).size / 1024 + 16384;
r1 - r0 <= limit ? ok(`M1 whole-file check: RSS ${r0} -> ${r1} kB (+${r1 - r0}, limit ${Math.round(limit)}), check ${st.check} in ${Math.round(st.checkMs)} ms`)
  : bad(`M1 whole-file check: RSS ${r0} -> ${r1} kB (+${r1 - r0} > limit ${Math.round(limit)}), check ${st.check} in ${Math.round(st.checkMs)} ms`);
const a = await ask(win), b = await ask({ ...win });
strip(a) === strip(b) && !a.error ? ok(`M2 48-row window after the check: same answer twice, RSS ${rss()} kB`) : bad('M2 window answers differ');
p.stdin.end();
console.log(fails ? `checkmem: ${fails} FAIL` : 'checkmem: all PASS');
process.exit(fails ? 1 : 0);
