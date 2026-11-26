// vscode-port: checks that a converted fixture (FSDB or WCZ twin) holds the same values as its source VCD.
// For every VCD variable: the full change history from the VCD vs the whole-dump window from wisp-helper on the twin,
// times compared in femtoseconds (each file's own timescale). Lists every difference; never hides one.
// Usage: node content-check.cjs <wisp-helper> <vcdRoot> <twinRoot> <ext: fsdb|wcz> <list.txt> [out.jsonl]
// Exit 0 = every file and every signal equal; 1 = a difference somewhere (see the report).
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [helperBin, vcdRoot, twinRoot, ext, listFile, outFile] = process.argv.slice(2);
const UNIT = { s: 1e15, ms: 1e12, us: 1e9, ns: 1e6, ps: 1e3, fs: 1 };

function parseVcd(text) {
  const vars = new Map(); const byCode = new Map(); const scope = []; let t = 0; let ts = 1e6;
  const toks = text.split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (!w) { continue; }
    if (w === '$timescale') {
      let s = ''; i++; while (toks[i] !== '$end') { s += toks[i++]; }
      const m = /^(\d+)\s*([a-z]+)$/.exec(s); if (m) { ts = Number(m[1]) * UNIT[m[2]]; }
      continue;
    }
    if (w === '$scope') { scope.push(toks[i + 2]); i += 3; continue; }
    if (w === '$upscope') { scope.pop(); i += 1; continue; }
    if (w === '$var') {
      const type = toks[i + 1], width = Number(toks[i + 2]), code = toks[i + 3], name = toks[i + 4].replace(/^\\/, '');
      let j = i + 5; let range = '';
      while (toks[j] !== '$end') { range += toks[j++]; }
      const p = [...scope, name].join('.');
      const kind = type === 'real' || type === 'realtime' ? 'real' : type === 'string' ? 'string' : 'bits';
      const v = vars.get(p) || { width, kind, range, changes: [] };
      vars.set(p, v);
      if (!byCode.has(code)) { byCode.set(code, []); }
      if (!byCode.get(code).includes(v)) { byCode.get(code).push(v); }
      i = j; continue;
    }
    if (w[0] === '$') { if (w !== '$dumpvars' && w !== '$end' && w !== '$dumpall' && w !== '$dumpon' && w !== '$dumpoff') { while (i < toks.length && toks[i] !== '$end') { i++; } } continue; }
    if (w[0] === '#') { t = Number(w.slice(1)); continue; }
    let val, code;
    const c0 = w[0];
    if (c0 === 'b' || c0 === 'B') { val = w.slice(1).toLowerCase(); code = toks[++i]; }
    else if (c0 === 'r' || c0 === 'R') { val = w.slice(1); code = toks[++i]; }
    else if (c0 === 's' || c0 === 'S') { val = w.slice(1); code = toks[++i]; }
    else { val = c0.toLowerCase(); code = w.slice(1); }
    for (const v of byCode.get(code) || []) {
      let x = val;
      if (v.kind === 'bits') {
        if (x.length < v.width) { x = (x[0] === 'x' || x[0] === 'z' ? x[0] : '0').repeat(v.width - x.length) + x; }
        if (x.length > v.width) { x = x.slice(x.length - v.width); }
      } else if (v.kind === 'real') { x = String(Number(x)); }
      const last = v.changes[v.changes.length - 1];
      if (last && last[0] === t) { last[1] = x; if (v.changes.length > 1 && v.changes[v.changes.length - 2][1] === x) { v.changes.pop(); } }
      else if (!last || last[1] !== x) { v.changes.push([t, x]); }
    }
  }
  return { vars, tsFs: ts };
}

function helper() {
  const p = cp.spawn(helperBin, ['--workers', '2'], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  let buf = Buffer.alloc(0), want = null, next = 1; const pending = new Map();
  p.stdio[3].on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (want) { if (buf.length < want.n) { return; } want.line.bin = Buffer.from(buf.subarray(0, want.n)); buf = buf.subarray(want.n); const l = want.line; want = null; done(l); continue; }
      const i = buf.indexOf(10); if (i < 0) { return; }
      const line = JSON.parse(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1);
      if (Number(line.binLength) > 0) { want = { line, n: Number(line.binLength) }; } else { done(line); }
    }
  });
  function done(l) { const r = pending.get(l.id); if (r) { pending.delete(l.id); r(l); } }
  const request = (q) => new Promise((res) => { const id = next++; pending.set(id, res); p.stdin.write(JSON.stringify({ ...q, id }) + '\n'); });
  return { request, close: () => { p.stdin.end(); }, err: () => err };
}

function decode(raw, width, text) {
  const out = []; let t = 0, o = 0;
  if (text) {
    while (o + 12 <= raw.length) { t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296; const n = raw.readUInt32LE(o + 8); out.push([t, raw.subarray(o + 12, o + 12 + n).toString('utf8')]); o += 12 + n; }
    return out;
  }
  const rec = 8 + width;
  for (; o + rec <= raw.length; o += rec) { t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296; out.push([t, raw.subarray(o + 8, o + rec).toString('latin1').toLowerCase()]); }
  return out;
}

async function twinVars(h, top) {
  const vars = new Map();
  const add = (p, v) => { vars.set(p + '.' + String(v.name).replace(/^\\/, ''), v); };
  const walk = async (scopeOffsetIdx, p) => {
    const r = (await h.request({ cmd: 'children', scopeOffsetIdx, scopePath: p })).result || {};
    for (const v of r.vars || []) { add(p, v); }
    for (const s of r.scopes || []) {
      const q = p + '.' + s.name;
      if (s.inline) {
        const st = [[s, q]];
        while (st.length) { const [x, xp] = st.pop(); for (const v of x.inline.vars || []) { add(xp, v); } for (const y of x.inline.scopes || []) { if (y.inline) { st.push([y, xp + '.' + y.name]); } else { await walk(y.scopeOffsetIdx, xp + '.' + y.name); } } }
      } else { await walk(s.scopeOffsetIdx, q); }
    }
  };
  for (const t of top) { await walk(t.scopeOffsetIdx, t.name); }
  return vars;
}

async function checkOne(rel) {
  const vcdPath = path.join(vcdRoot, rel);
  const twin = path.join(twinRoot, rel.replace(/\.vcd$/, '.' + ext));
  const res = { file: rel, twin: path.relative(twinRoot, twin), ok: false, signals: 0, equal: 0, changes: 0, diffs: [] };
  if (!fs.existsSync(twin)) { res.diffs.push({ kind: 'twin-missing' }); return res; }
  const vcd = parseVcd(fs.readFileSync(vcdPath, 'utf8'));
  const h = helper();
  try {
    const o = await h.request({ cmd: 'open', file: twin });
    if (o.error) { res.diffs.push({ kind: 'open-error', error: o.error }); return res; }
    const m = o.result.metadata;
    const twinTs = Number(m.timeScale || 1) * (UNIT[m.timeUnit] || 1e6);
    const tv = await twinVars(h, o.result.top || []);
    for (const [p, v] of vcd.vars) {
      res.signals++;
      const x = tv.get(p);
      if (!x) { res.diffs.push({ kind: 'missing-in-twin', signal: p }); continue; }
      if (x.signalId === null || x.signalId === undefined) { res.diffs.push({ kind: 'no-values-in-twin', signal: p, unavailable: x.unavailable }); continue; }
      if (v.kind === 'bits' && Number(x.width) !== v.width) { res.diffs.push({ kind: 'width', signal: p, vcd: v.width, twin: x.width }); continue; }
      const w = await h.request({ cmd: 'window', signals: [{ signalId: x.signalId, width: x.width }], t0: 0, t1: Number(m.timeEnd) + 1, buckets: 4194304 });
      const hd = w.result && w.result.signals && w.result.signals[0];
      if (!hd || hd.error) { res.diffs.push({ kind: 'read-error', signal: p, error: (hd && hd.error) || w.error }); continue; }
      if (!hd.exact) { res.diffs.push({ kind: 'not-exact', signal: p, count: hd.count }); continue; }
      let got = decode(zlib.inflateRawSync(w.bin.subarray(0, Number(hd.bytes) || 0)), Number(x.width), !!hd.text);
      if (hd.text && hd.kind === 'real') { got = got.map(([t, s]) => [t, String(Number(s))]); }
      // drop repeats (a twin may store a same-value write) and scale times to fs
      const norm = (list, tsFs) => { const out = []; for (const [t, s] of list) { if (!out.length || out[out.length - 1][1] !== s) { out.push([t * tsFs, s]); } } return out; };
      const a = norm(v.changes, vcd.tsFs), b = norm(got, twinTs);
      let k = 0; while (k < a.length && k < b.length && a[k][0] === b[k][0] && a[k][1] === b[k][1]) { k++; }
      if (k === a.length && k === b.length) { res.equal++; res.changes += a.length; continue; }
      res.diffs.push({ kind: 'values', signal: p, vcdChanges: a.length, twinChanges: b.length, firstDiffIndex: k, vcd: a[k] || null, twin: b[k] || null });
    }
    for (const p of tv.keys()) { if (!vcd.vars.has(p)) { res.diffs.push({ kind: 'extra-in-twin', signal: p }); } }
    res.ok = res.diffs.length === 0;
    return res;
  } finally { h.close(); }
}

(async () => {
  const list = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
  const out = outFile ? fs.createWriteStream(outFile) : null;
  let okFiles = 0, sig = 0, eq = 0, ch = 0;
  for (const rel of list) {
    let r;
    try { r = await checkOne(rel); } catch (e) { r = { file: rel, ok: false, diffs: [{ kind: 'exception', error: String(e && e.stack || e) }] }; }
    if (r.ok) { okFiles++; }
    sig += r.signals || 0; eq += r.equal || 0; ch += r.changes || 0;
    if (out) { out.write(JSON.stringify(r) + '\n'); }
    const kinds = {}; for (const d of r.diffs) { kinds[d.kind] = (kinds[d.kind] || 0) + 1; }
    console.log(`${r.ok ? 'EQUAL' : 'DIFF '} ${ext} ${rel}: ${r.equal || 0}/${r.signals || 0} signals equal, ${r.changes || 0} changes compared${r.diffs.length ? ' ' + JSON.stringify(kinds) : ''}`);
  }
  console.log(`SUMMARY ${ext}: ${okFiles}/${list.length} files equal, ${eq}/${sig} signals equal, ${ch} changes compared`);
  if (out) { out.end(); }
  process.exit(okFiles === list.length ? 0 : 1);
})();
