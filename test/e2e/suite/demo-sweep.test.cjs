// vscode-port: demo sweep for wrong answers. For each demo folder with an FSDB (then its WCZ twin), N random
// (signal, time) points where the signal changes, each checked through the product against the dump itself:
//   - valueAt (waveformViewer.getValuesAtTime) equals the dump's value;
//   - Trace Driver: no error / exception, answers within 10 s, its value equals the dump's, "keeps its value"
//     (reason noWrite / held) only where the dump did not change, each dumped fan-in value equals the dump's at its
//     time, and no x where the dump has a value;
//   - inline values (waveform debugger at the marker) in the driver statement's module: each equals the dump's.
// The truth is a separate wisp-helper process reading the same file (DEMO_TRUTH_HELPER), opened with the folder's
// own vaporview.wisp.outsideWrites, so a port copy the extension shows as x while its connection has a value counts.
// DIAGNOSTIC: run it on the demo (E2E_WORKSPACE=<demo>/demo.code-workspace) as the user does; it is meant to become a
// gated suite. Env: DEMO_DIR (default ~/vaporview-wisp-demo), DEMO_FOLDERS (comma list of names below; default all),
// DEMO_FORMATS (default fsdb,wcz), DEMO_N (points per folder and format, default 50), DEMO_SEED (default 1),
// DEMO_OUT (a .jsonl of every point and violation), DEMO_TRUTH_HELPER (default the demo's bin/wisp-helper).
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), os = require('os'), path = require('path');
const { vscode, sleep, until } = require('./helpers.cjs');

const DEMO = process.env.DEMO_DIR || path.join(os.homedir(), 'vaporview-wisp-demo');
const N = Number(process.env.DEMO_N || 50);
const SEED = Number(process.env.DEMO_SEED || 1);
const OUT = process.env.DEMO_OUT || '';
const FORMATS = (process.env.DEMO_FORMATS || 'fsdb,wcz').split(',').filter(Boolean);
// (not the demo's bin/wisp-helper: that is a stale pre-15.11 build; the user's installed build bundles 15.11)
const TRUTH_BIN = process.env.DEMO_TRUTH_HELPER || process.env.E2E_WISP_HELPER || '';
const PANEL_MS = 10000; // slower than this is a violation (the user waits on the panel)
const LONG = 15 * 60 * 1000; // a first trace builds the design model
const FOLDERS = [
  // (fixed: points users reported by hand, checked first; 11-25: Trace Driver on u1.cnt at 37 said en = x, "keeps its value")
  { name: 'c-debugger', dir: '3-features/c-debugger', base: 'dbg', fixed: [{ p: 'dbg_top.u1.cnt', t: 37 }] },
  { name: 'a-trace/a', dir: '3-features/a-trace/a', base: 'a' },
  { name: 'a-trace/p', dir: '3-features/a-trace/p', base: 'p' },
  { name: 'a-trace/xr', dir: '3-features/a-trace/xr', base: 'xr' },
  { name: 'b-link', dir: '3-features/b-link', base: 'fsm' },
  { name: 'cva6', dir: '4-big-design', base: 'cva6-coremark' },
];
const REQUIRE_RADIX = process.env.DEMO_REQUIRE_RADIX !== '0';
const want = (process.env.DEMO_FOLDERS || '').split(',').filter(Boolean);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const withTimeout = (p, ms, what) => { let h; return Promise.race([p.finally(() => clearTimeout(h)), new Promise((_, rej) => { h = setTimeout(() => rej(new Error('timeout: ' + what)), ms); })]); };
function readJsonc(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return {}; } }
const log = (rec) => { if (OUT) { fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); } };

// ---- the truth: wisp-helper on the same file (test/trace/wisp-client.cjs) ----
async function truthOf(file, outsideWrites) {
  const { helper, netlist } = require(path.join(process.env.E2E_ROOT, 'test/trace/wisp-client.cjs'));
  let h = helper(file, TRUTH_BIN);
  const openReq = Object.assign({ cmd: 'open', file }, outsideWrites === 'none' ? { outsideWrites: 'none' } : {});
  const o = await h.request(openReq);
  if (o.error) { throw new Error('truth open: ' + JSON.stringify(o.error)); }
  // (the truth reads every history it checks through one helper, whose worker cache grows: on CVA6 it reaches the
  // worker memory limit (2 GB) and refuses every later read. Then: a fresh helper on the same file (same ids), retried once.)
  let restarts = 0;
  const req = async (r) => {
    let w = await h.request(r);
    const msg = JSON.stringify(w.error || (w.result && w.result.errors) || (w.result && w.result.signals && w.result.signals.map((x) => x.error)) || '');
    if (/worker memory limit/.test(msg) && restarts < 200) {
      restarts++; try { h.proc.kill(); } catch {}
      h = helper(file, TRUTH_BIN); const o2 = await h.request(openReq); if (o2.error) { throw new Error('truth reopen: ' + JSON.stringify(o2.error)); }
      w = await h.request(r);
    }
    return w;
  };
  const meta = o.result.metadata;
  const vars = await netlist(h, o.result.top);
  // Values and edges from each signal's whole history (one window, cached), read in JS: no valueAt / edge requests (on
  // wisp-helper 15.11 a valueAt or edge on a computed signal before any window makes every later window on it fail,
  // "a computed signal answers window requests only"; fixed in 15.12). A history the helper can only summarise: windows of [t, t+1].
  const zlib = require('zlib');
  const end = Number(meta.timeEnd) || 0;
  const hist = new Map();
  const win = async (v, t0, t1, buckets) => {
    const w = await req({ cmd: 'window', signals: [{ signalId: v.signalId, width: v.width }], t0, t1, buckets });
    const s = w.result && w.result.signals && w.result.signals[0];
    if (w.error || !s || s.error) { throw new Error('truth window: ' + JSON.stringify(w.error || (s && s.error))); }
    if (!s.exact) { return null; }
    const raw = zlib.inflateRawSync((w.bin || Buffer.alloc(0)).subarray(0, Number(s.bytes) || 0));
    const out = [];
    if (s.text) { let t = 0, o = 0; while (o + 12 <= raw.length) { t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296; const len = raw.readUInt32LE(o + 8); out.push([t, raw.toString('utf8', o + 12, o + 12 + len)]); o += 12 + len; } return out; }
    const rec = 8 + v.width; let t = 0;
    for (let o = 0; o + rec <= raw.length; o += rec) { t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296; out.push([t, raw.toString('latin1', o + 8, o + rec)]); }
    return out;
  };
  // (a signal the helper refuses to window, e.g. "code block writes only part of its value" or over its store limit:
  // its truth is UNKNOWN, and checks against it are skipped and counted, never judged)
  const history = async (p) => {
    if (!hist.has(p)) { const v = vars.get(p); let r = null; try { r = v ? await win(v, 0, end + 1, 200000) : null; } catch (e) { r = 'ERR'; } hist.set(p, r); }
    return hist.get(p);
  };
  const lastAt = (recs, t) => { let lo = 0, hi = recs.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (recs[m][0] <= t) { k = m; lo = m + 1; } else { hi = m - 1; } } return k; };
  const valueAt = async (p, t) => {
    const v = vars.get(p); if (!v) { return undefined; }
    const recs = await history(p);
    if (recs && recs !== 'ERR') { const k = lastAt(recs, t); return k >= 0 ? recs[k][1] : undefined; }
    // (no exact whole history: a summarised long history or a refused one) the value at t from: valueAt (dumped signals;
    // a computed one refuses it on 15.12 without harm), else exact windows ending at t, widening, with enough buckets
    // that the reply is exact; the last change at or before t inside the window is the value.
    const why = [];
    try { const q = await req({ cmd: 'valueAt', signalIds: [v.signalId], t }); const r = q.result && (Array.isArray(q.result) ? q.result[0] : (q.result.values || [])[0]);
      const val = r && typeof r === 'object' ? (r.value ?? r.v) : r; if (!q.error && typeof val === 'string' && val.length) { return toBits(val, v.width); } why.push('valueAt:' + JSON.stringify(q.error || r).slice(0, 80)); } catch (e) { why.push('valueAt:' + e.message); }
    for (const back of [0, 1000, 100000, 10000000, t]) {
      try { const w = await win(v, Math.max(0, t - back), t + 1, 100000); if (w && w.length) { const k = lastAt(w, t); if (k >= 0) { return w[k][1]; } } else { why.push('win' + back + ':' + (w ? 'empty' : 'summary')); } } catch (e) { why.push('win' + back + ':' + e.message.slice(0, 80)); break; }
    }
    unknownWhy(p, why);
    return UNKNOWN;
  };
  // the next change after t (dir 1) or the last change at or before t (dir -1); null when none (summarised histories: none)
  const edge = async (p, t, dir) => {
    const recs = await history(p); if (!recs || recs === 'ERR' || recs.length < 2) { return null; }
    const ch = []; for (let k = 1; k < recs.length; k++) { if (recs[k][1] !== recs[k - 1][1]) { ch.push(recs[k][0]); } }
    if (dir > 0) { const x = ch.find((c) => c > t); return x === undefined ? null : x; }
    let r = null; for (const c of ch) { if (c <= t) { r = c; } else { break; } } return r;
  };
  return { h, meta, vars, valueAt, edge, close: () => h.proc.kill(), restarts: () => restarts };
}

const UNKNOWN = Symbol('truth unknown');
// (why a truth read stayed unknown: the first reason per signal, logged once, for the summary)
const unknownSeen = new Map();
function unknownWhy(p, why) { if (!unknownSeen.has(p)) { unknownSeen.set(p, why); log({ truthUnknown: p, why }); } }
// a helper valueAt answer as binary digits (it may come as binary already, or hex with a radix prefix)
function toBits(val, width) { const s = String(val).trim(); if (/^[01xzXZ]+$/.test(s)) { return s; } const m = /^(?:\d*')?[hH]?([0-9a-fA-F]+)$/.exec(s.replace(/^0x/i, '')); if (m && width) { return BigInt('0x' + m[1]).toString(2).padStart(width, '0'); } return s; }
let truthUnknown = 0;
// ---- values: binary strings of the dump vs what the product shows ----
const isBits = (s) => typeof s === 'string' && /^[01xzXZ]+$/.test(s);
const hasXZ = (s) => /[xzXZ]/.test(s);
function bitsBig(s) { return BigInt('0b' + (s || '0')); }
// A shown value ("8'h1f", "1'b1", "'d12", "12", "8'bxxxx0001", binary) as {x: bool, n: BigInt|null}; null when it isn't a number.
function shownValue(s) {
  s = String(s).trim().replace(/_/g, '');
  let m = /^(\d*)'s?([hbdo])([0-9a-fA-FxXzZ?]+)$/.exec(s);
  if (m) {
    const radix = { h: 16, b: 2, d: 10, o: 8 }[m[2].toLowerCase()];
    if (/[xXzZ?]/.test(m[3])) { return { x: true, n: null, raw: s }; }
    return { x: false, n: radix === 10 ? BigInt(m[3]) : BigInt((radix === 16 ? '0x' : radix === 8 ? '0o' : '0b') + m[3]), raw: s };
  }
  if (/^-?\d+$/.test(s)) { return { x: false, n: BigInt(s), raw: s }; }
  if (/^[01]+$/.test(s)) { return { x: false, n: bitsBig(s), raw: s }; }
  if (/^[01xzXZ]+$/.test(s)) { return { x: true, n: null, raw: s }; }
  return null;
}
// Compares a dump value (binary string) with a product value; returns null when equal, else a short reason.
function differs(truth, got) {
  if (truth === UNKNOWN) { truthUnknown++; return null; }
  if (truth === undefined) { return null; }
  if (got === undefined || got === null) { return 'missing'; }
  if (isBits(got) && isBits(truth)) {
    const a = truth.toLowerCase(), b = got.toLowerCase();
    if (a === b) { return null; }
    if (!hasXZ(a) && !hasXZ(b)) { return bitsBig(a) === bitsBig(b) ? null : 'value'; }
    if (hasXZ(b) && !hasXZ(a)) { return 'x-where-dump-has-value'; }
    // (a shorter / padded x string: compare the low bits)
    const n = Math.min(a.length, b.length);
    return a.slice(-n) === b.slice(-n) && /^[0xz]*$/.test(a.slice(0, -n) + b.slice(0, -n)) ? null : (hasXZ(a) && !hasXZ(b) ? 'value-where-dump-has-x' : 'xbits');
  }
  if (!isBits(truth)) { return String(truth) === String(got) ? null : 'value'; }
  const v = shownValue(got);
  if (!v) { return null; } // an enum name, a string: not checked here
  // vscode-port: a prefixed hex value with x / z digits ("8'hX1") is checked digit by digit (%h rule)
  const hx = /^(\d*)'s?[hH]([0-9a-fA-FxXzZ]+)$/.exec(String(got).trim().replace(/_/g, ''));
  if (v.x && hx) { return differs(truth, bareToBits(hx[2], { width: truth.length }, truth)); }
  if (v.x) { return hasXZ(truth) ? null : 'x-where-dump-has-value'; }
  if (hasXZ(truth)) { return 'value-where-dump-has-x'; }
  return bitsBig(truth) === v.n ? null : 'value';
}

// a signal with no dump value and no computable one shows "no value" with a reason, never x.
// `dv`: the dump's answer ({value} directly or through the port connection), or null when it has none.
const isNoValue = (v) => v === undefined || v === null || v === '' || /no value|not in the dump|not computable/i.test(String(v));
function judge(dv, shown) {
  if (dv && dv.value === UNKNOWN) { truthUnknown++; return null; }
  if (!dv) { return isNoValue(shown) ? null : (hasXZ(String(shown)) && (isBits(shown) || (shownValue(shown) || {}).x) ? 'x-for-signal-without-value' : null); }
  // (tag rule: a port copy's "no value (port copy: …)" / "(not computable: …)" under outsideWrites unknown
  // is the known class; no value with no reason, or any other reason, is not)
  if (isNoValue(shown)) { return /no value \((port copy|not computable)\b/i.test(String(shown)) ? 'novalue-portcopy' : 'novalue-where-dump-has-value'; }
  return differs(dv.value, shown);
}


// Inline chips: "name = 8'h0c, other = 1'b1" (before ) or "name: 0c→0d, other: no value, x: 1 (via …)" (
// row radix without the SV prefix; after an arrow the current value). -> [{name, value, bare}]
function inlineParts(text) {
  const out = [];
  const t = String(text);
  // vscode-port: quiet text: "name = value  other = a → b  x = no value", parts two spaces apart,
  // no commas; a value is bare (row radix, no SV prefix) unless it carries one ("8'h12")
  const NAME = /[A-Za-z_][\w$]*(?:\[[^\]]*\])*/.source;
  // (a line with ONE value has no two-space gap: "boot_addr_i = 0000000000010000" is too, not the old comma form;
  // the old form's values always carried an SV prefix, so the bare rule below reads both)
  if (/\S {2,}\S/.test(t) || (new RegExp('^\\s*' + NAME + ' = ').test(t) && !new RegExp(',\\s+' + NAME + ' = ').test(t))) {
    const parts = t.split(new RegExp(' {2,}(?=' + NAME + ' = )')).map((x) => new RegExp('^(' + NAME + ') = (.*)$').exec(x.trim())).filter(Boolean);
    if (parts.length) {
      return parts.map((m) => {
        let v = m[2].replace(/\s*\(via [^)]*\)\s*$/, '').trim();
        if (v.includes('→')) { v = v.slice(v.lastIndexOf('→') + 1).trim(); }
        return { name: m[1], value: v, bare: !/no value|not in the dump|not computable/i.test(v) && !/'/.test(v) };
      });
    }
  }
  const old = t.split(/,\s+(?=[A-Za-z_][\w$]*(?:\[[^\]]*\])* = )/).map((x) => /^([A-Za-z_][\w$]*(?:\[[^\]]*\])*) = (.*)$/.exec(x.trim())).filter(Boolean);
  if (old.length) { return old.map((m) => ({ name: m[1], value: m[2], bare: false })); }
  for (const x of t.split(/,\s+(?=[A-Za-z_][\w$]*(?:\[[^\]]*\])*: )/)) {
    const m = /^([A-Za-z_][\w$]*(?:\[[^\]]*\])*): (.*)$/.exec(x.trim());
    if (!m) { continue; }
    let v = m[2].replace(/\s*\(via [^)]*\)\s*$/, '').trim();
    if (v.includes('→')) { v = v.slice(v.lastIndexOf('→') + 1).trim(); }
    out.push({ name: m[1], value: v, bare: !/no value/i.test(v) });
  }
  return out;
}
// A bare chip value ("0c", "1", "xx") as a binary string of the signal's width when the digits say which radix
// (hex digit count = ceil(width/4), or width binary digits); else as given (decimal, enum: compared by shownValue).
// (hex chips show a nibble with any x bit as x, "1100x101" is "cx". With the dump's value given, an x nibble
// matches the dump's nibble when that nibble has an x/z bit, so a partly-x nibble is not counted as wrong.)
function bareToBits(v, info, dump) {
  const w = info && info.width;
  const s = String(v).replace(/_/g, '');
  if (!w || !/^[0-9a-fA-FxXzZ]+$/.test(s)) { return v; }
  if (s.length === w && /^[01xXzZ]+$/.test(s)) { return s.toLowerCase(); }
  if (s.length === Math.ceil(w / 4)) {
    const pad = s.length * 4 - w;
    const dn = typeof dump === 'string' && dump.length === w ? ('0'.repeat(pad) + dump.toLowerCase()) : null;
    const bits = s.split('').map((c, i) => {
      // vscode-port: SystemVerilog %h: lower-case x / z = all bits of the nibble x / z;
      // upper-case X / Z = partly x / z, consistent with any mix of known and unknown bits that has one unknown.
      // (pad bits above the width do not count)
      if (/[xXzZ]/.test(c)) {
        const d = dn && dn.slice(i * 4, i * 4 + 4);
        const real = d ? d.slice(i === 0 ? pad : 0) : '';
        const ok = d && (c === 'x' ? /^x+$/.test(real) : c === 'z' ? /^z+$/.test(real) : /[xz]/.test(real));
        return ok ? d : (/[xX]/.test(c) ? 'xxxx' : 'zzzz');
      }
      return parseInt(c, 16).toString(2).padStart(4, '0');
    }).join('');
    return bits.slice(bits.length - w);
  }
  return v;
}

// ---- the product ----
async function activate() {
  const id = process.env.E2E_EXT_ID;
  const ext = id ? vscode.extensions.getExtension(id) : vscode.extensions.all.find((e) => e.packageJSON && e.packageJSON.name === 'vaporview-fsdb');
  if (!ext) { throw new Error('wisp (this extension) not found'); }
  // a dev checkout has no bundled helper: point it at E2E_WISP_HELPER (an installed build, E2E_EXT_ID, finds its own)
  const h = process.env.E2E_WISP_HELPER || '';
  const c = vscode.workspace.getConfiguration('vaporview');
  if (!id && h && c.get('wispHelperPath') !== h) { await c.update('wispHelperPath', h, vscode.ConfigurationTarget.Global); }
  if (!ext.isActive) { await ext.activate(); }
  return ext;
}
async function openDump(file) {
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand('vaporview.openFile', { uri });
  await until(async () => {
    const d = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
    const list = Array.isArray(d) ? d : (d && d.documents) || [];
    return list.some((u) => String(u) === String(uri));
  }, 'document open ' + file, 120000, 250);
  return String(uri);
}
async function apiValue(uri, time, p) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: [p] });
  if (!r || !r.length) { return undefined; }
  // vscode-port: no value comes as {value: [], noValue: {reason, text}}: the text is what's shown
  const nv = r[0].noValue;
  if (nv && (r[0].value === undefined || r[0].value === null || (Array.isArray(r[0].value) && !r[0].value.length) || r[0].value === '')) { return nv.text || ('no value (' + (nv.reason || '') + ')'); }
  let v = r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return Array.isArray(v) ? v[v.length - 1] : v;
}
const dbg = (q) => vscode.commands.executeCommand('vaporview.debugger.e2e', q);
async function startDebugger(uri) {
  const ok = await vscode.debug.startDebugging(undefined, { type: 'vaporview-waveform', request: 'attach', name: 'demo sweep', waveform: uri }, { suppressSaveBeforeStart: true });
  if (!ok) { throw new Error('startDebugging failed'); }
  await until(async () => { const s = await dbg({ kind: 'session' }); return s && s.cycle ? s : null; }, 'debug session', 120000);
}
async function stopDebugger() {
  for (let i = 0; i < 25 && vscode.debug.activeDebugSession; i++) {
    const ended = new Promise((r) => { const d = vscode.debug.onDidTerminateDebugSession(() => { d.dispose(); r(); }); setTimeout(() => { d.dispose(); r(); }, 2000); });
    await vscode.debug.stopDebugging(); await ended;
  }
}
async function setMarker(uri, t) {
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t });
  await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === t; }, 'marker at ' + t, 10000, 100);
}
function moduleAt(text, line) {
  const lines = text.split('\n'); let mod = null;
  for (let i = 0; i <= line && i < lines.length; i++) {
    const m = /^\s*(?:module|interface)\s+(?:automatic\s+|static\s+)?(\w+)/.exec(lines[i]); if (m) { mod = { name: m[1], line: i }; }
    if (/^\s*end(?:module|interface)\b/.test(lines[i]) && i < line) { mod = null; }
  }
  if (!mod) { return null; }
  let end = lines.length - 1;
  for (let i = line; i < lines.length; i++) { if (/^\s*end(?:module|interface)\b/.test(lines[i])) { end = i; break; } }
  return Object.assign(mod, { end });
}

// One folder in one format.
function sweep(folder, format) {
  return async () => {
    const file = path.join(DEMO, folder.dir, folder.base + '.' + format);
    if (!fs.existsSync(file)) { console.log(`SKIP demo-sweep ${folder.name} ${format}: no ${file}`); return; }
    await activate();
    const settings = readJsonc(path.join(DEMO, folder.dir, '.vscode/settings.json'));
    // The truth reads the dump as the plain simulation it is (outsideWrites none: the helper's computed port copies), whatever
    // the extension runs with: a value the product computes from the design (resolvedVia / computed) is judged against
    // the helper's computed copy, not against "the dump has no row". DEMO_TRUTH_OUTSIDE_WRITES=folder: as the folder.
    const truth = await truthOf(file, process.env.DEMO_TRUTH_OUTSIDE_WRITES === 'folder' ? settings['vaporview.wisp.outsideWrites'] : 'none');
    const violations = [];
    const bad = (pt, kind, detail) => { const v = Object.assign({ folder: folder.name, format, signal: pt.p, time: pt.t, kind }, detail || {}); violations.push(v); log(Object.assign({ violation: true }, v)); };
    const stats = { points: 0, traced: 0, traceErr: 0, inlineChecked: 0, inlineValues: 0, faninChecked: 0, faninUnresolved: 0, decisionChecked: 0, decisionUnresolved: 0, slow: 0, firstTraceMs: null, maxTraceMs: 0 };
    try {
      // the points: random signals, a random time, the next change from there (else the last one before it)
      const r = rng(SEED * 1000 + FOLDERS.indexOf(folder) * 10 + FORMATS.indexOf(format));
      const all = [...truth.vars.keys()];
      const t0 = Number(truth.meta.timeStart) || 0, t1 = Number(truth.meta.timeEnd) || 0;
      const points = [], seen = new Set();
      for (let tries = 0; seen.size < N && tries < N * 40; tries++) {
        const p = all[Math.floor(r() * all.length)];
        const from = Math.floor(t0 + r() * (t1 - t0));
        let t = await truth.edge(p, from, 1);
        if (t === null || t === undefined || t <= t0) { t = await truth.edge(p, from + 1, -1); }
        if (t === null || t === undefined || t <= t0 || seen.has(p + '@' + t)) { continue; }
        seen.add(p + '@' + t);
        // the change itself, and a time inside the run it starts (the marker is rarely on the change)
        const next = await truth.edge(p, t, 1);
        const mid = next !== null && next !== undefined && next > t + 1 ? t + 1 + Math.floor(r() * (next - t - 1)) : null;
        points.push({ p, t, last: t });
        if (mid !== null) { points.push({ p, t: mid, last: t }); }
      }
      for (const f of folder.fixed || []) {
        if (!truth.vars.has(f.p)) { continue; }
        const last = (await truth.valueAt(f.p, f.t)) !== (await truth.valueAt(f.p, f.t - 1)) ? f.t : await truth.edge(f.p, f.t, -1);
        points.unshift({ p: f.p, t: f.t, last, fixed: true });
      }
      if (seen.size < N) { console.log(`  NOTE ${folder.name} ${format}: only ${seen.size} change points found`); }
      // DEMO_OUTSIDE_WRITES: 'none' sets vaporview.wisp.outsideWrites Global before the open, 'unset' clears it; else as the workspace has it
      const ow = process.env.DEMO_OUTSIDE_WRITES || '';
      if (ow) { await vscode.workspace.getConfiguration('vaporview').update('wisp.outsideWrites', ow === 'unset' ? undefined : ow, vscode.ConfigurationTarget.Global); }
      const openedAt = Date.now();
      const uri = await openDump(file);
      const traceState = async () => { try { return await vscode.commands.executeCommand('vaporview.e2e.traceState'); } catch { return null; } };
      // what the extension's helper runs with (outsideWrites as the helper got it)
      try { const ws = await vscode.commands.executeCommand('vaporview.e2e.wispState', uri); log({ wispState: ws, folder: folder.name, format, settingOutsideWrites: settings['vaporview.wisp.outsideWrites'] }); console.log(`  wispState ${folder.name} ${format}: ${JSON.stringify(ws).slice(0, 400)}`); } catch (e) { log({ wispStateError: String(e) }); }
      // A signal the dump doesn't have (a port copy): the dump's value of what its port is connected to, when that is a
      // plain signal (the design model's answer for the port: Trace Driver's portIn step). null: not resolvable.
      const conns = new Map();
      const dumpValue = async (p, t) => {
        if (truth.vars.has(p)) { return { path: p, value: await truth.valueAt(p, t) }; }
        if (!conns.has(p)) {
          let c = null;
          try {
            const d = await withTimeout(Promise.resolve(vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: p, time: t })), 60000, 'trace port ' + p);
            const dr = d && d.driver;
            if (dr && dr.kind === 'portIn' && dr.from && /^[A-Za-z_][\w$]*$/.test(String(dr.src || '').trim())) { c = dr.from + '.' + String(dr.src).trim(); }
            log({ conn: p, at: t, driver: dr || null, error: d && d.error, message: d && d.message, resolved: c, inDump: !!(c && truth.vars.has(c)) });
          } catch (e) { log({ conn: p, at: t, exception: String(e && e.message || e) }); }
          conns.set(p, c && truth.vars.has(c) ? c : null);
        }
        const c = conns.get(p);
        return c ? { path: c, value: await truth.valueAt(c, t), via: 'port connection' } : null;
      };
      await startDebugger(uri);
      // (memory: the extension host's own usage per probe (this suite runs in it), for growth per Trace; with
      // DEMO_HEAP_SNAPSHOT=<dir>, V8 heap snapshots after probe 10 and after the last probe, for the top retainers)
      const memRow = (k) => { const m = process.memoryUsage(); return { k, rssMB: Math.round(m.rss / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576), heapTotalMB: Math.round(m.heapTotal / 1048576), externalMB: Math.round(m.external / 1048576), arrayBuffersMB: Math.round(m.arrayBuffers / 1048576) }; };
      const snapDir = process.env.DEMO_HEAP_SNAPSHOT || '';
      const snap = (tag) => { if (!snapDir) { return; } try { if (global.gc) { global.gc(); } const t0 = Date.now(); const fp = require('v8').writeHeapSnapshot(path.join(snapDir, `${folder.name.replace(/\W/g, '_')}-${format}-${tag}.heapsnapshot`)); log({ heapSnapshot: fp, tag, ms: Date.now() - t0, mem: memRow(tag) }); } catch (e) { log({ heapSnapshot: null, tag, error: String(e.message || e) }); } };
      // (DEMO_HEAP_SAMPLING=1: V8's sampling heap profiler over the probes (in-process inspector; far cheaper than a
      // snapshot, which on CVA6 needed ~15 GB and killed the extension host): live allocations by the code that made
      // them, top 25 by self size, after probe 10 and at the end)
      let insp = null;
      const post = (m, p) => new Promise((res, rej) => insp.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
      if (process.env.DEMO_HEAP_SAMPLING) { try { insp = new (require('inspector').Session)(); insp.connect(); await post('HeapProfiler.enable'); await post('HeapProfiler.startSampling', { samplingInterval: 65536 }); } catch (e) { log({ heapSampling: 'start failed', error: String(e.message || e) }); insp = null; } }
      const sampled = async (tag) => {
        if (!insp) { return; }
        try {
          const { profile } = await post('HeapProfiler.getSamplingProfile');
          const by = new Map(); let total = 0;
          const walk = (n, stack) => { const f = n.callFrame; const here = `${f.functionName || '(anon)'} ${(f.url || '').split('/').slice(-2).join('/')}:${f.lineNumber + 1}`; const st = stack.concat(here);
            if (n.selfSize) { total += n.selfSize; const k = st.slice(-4).reverse().join(' < '); by.set(k, (by.get(k) || 0) + n.selfSize); } for (const c of n.children || []) { walk(c, st); } };
          walk(profile.head, []);
          const top = [...by].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => ({ MB: Math.round(v / 104857.6) / 10, at: k }));
          log({ heapSampling: tag, totalMB: Math.round(total / 1048576), mem: memRow(tag), top });
          console.log(`  DIAGNOSTIC heap sampling ${tag}: live ${Math.round(total / 1048576)} MB; top: ${JSON.stringify(top.slice(0, 8))}`);
        } catch (e) { log({ heapSampling: tag, error: String(e.message || e) }); }
      };
      log({ mem: memRow('before-probes') });
      for (const pt of points) {
        stats.points++;
        if (stats.points === 11) { snap('after10'); await sampled('after10'); }
        if (stats.points === 31) { await sampled('after30'); }
        if (stats.points % 5 === 1) { log({ mem: memRow('probe' + stats.points) }); }
        const rec = { folder: folder.name, format, signal: pt.p, time: pt.t, lastChange: pt.last, fixed: !!pt.fixed };
        const dumpV = await truth.valueAt(pt.p, pt.t);
        rec.dump = dumpV === UNKNOWN ? 'UNKNOWN' : dumpV;
        // marker (the debugger follows it)
        try { await setMarker(uri, pt.t); } catch (e) { bad(pt, 'marker', { error: String(e.message || e) }); }
        // the debugger follows the marker: inline values are its values at its time
        let sess = null;
        try { sess = await until(async () => { const x = await dbg({ kind: 'session' }); return x && x.time === pt.t ? x : null; }, 'debugger at ' + pt.t, 5000, 100); }
        catch { sess = await dbg({ kind: 'session' }); bad(pt, 'debugger:time-not-marker', { sessionTime: sess && sess.time, marker: pt.t }); }
        rec.sessionTime = sess && sess.time;
        // valueAt
        try { const v = await apiValue(uri, pt.t, pt.p); rec.api = v; const d = judge({ value: dumpV }, v); if (d) { bad(pt, 'valueAt:' + d, { dump: dumpV, shown: v }); } }
        catch (e) { bad(pt, 'valueAt:exception', { error: String(e.message || e) }); }
        // Trace Driver
        let st = null;
        const ts = Date.now();
        // (the first Trace: where its time goes. prep = vaporview.trace.prepare's background load at open (state then and
        // after), timings = the Trace's own split (designLoad / designReuse / sidecarBuild / queries ...), sinceOpen = how
        // long after the open the Trace started)
        const firstSplit = stats.firstTraceMs === null ? { sinceOpenMs: ts - openedAt, prepBefore: ((await traceState()) || {}).prep || null } : null;
        try {
          st = await withTimeout(Promise.resolve(vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: pt.p, time: pt.t })), stats.firstTraceMs === null ? LONG : 120000, 'trace driver');
        } catch (e) { bad(pt, 'trace:exception', { error: String(e.message || e) }); try { await vscode.commands.executeCommand('vaporview.traceCancel'); } catch {} }
        const ms = Date.now() - ts;
        rec.traceMs = ms;
        if (firstSplit) { const x = (await traceState()) || {}; Object.assign(firstSplit, { ms, sidecarBuildMs: x.timings && x.timings.sidecarBuild !== undefined ? x.timings.sidecarBuild : 0, sidecarCache: process.env.VAPORVIEW_CMUX_CACHE || '(default ~/.cache/vaporview-cmux)', cacheLabel: process.env.DEMO_CACHE_LABEL || null, prepAfter: x.prep || null, timings: x.timings || null, sidecarPid: x.sidecarPid ?? null }); stats.firstTrace = firstSplit; console.log(`  DIAGNOSTIC demo-sweep ${folder.name} ${format} first Trace: ${JSON.stringify(firstSplit)}`); }
        if (stats.firstTraceMs === null) { stats.firstTraceMs = ms; } else { stats.maxTraceMs = Math.max(stats.maxTraceMs, ms); if (ms > PANEL_MS) { stats.slow++; bad(pt, 'trace:slow', { ms }); } }
        if (st && st.error) {
          stats.traceErr++; rec.traceError = st.error;
          // (a signal the design doesn't have, or a testbench one, is an answer, not a wrong one: listed, not counted)
          // (noDesign: the folder names no design for tracing: listed in the summary, not a wrong answer)
          if (/noDesign/.test(JSON.stringify(st.error))) { stats.noDesign = (stats.noDesign || 0) + 1; }
          else if (!/notInDesign|notElaborated|testbench|noSignal/.test(JSON.stringify(st.error))) { bad(pt, 'trace:error', { error: st.error, message: st.message }); }
        } else if (st) {
          stats.traced++;
          const codes = (st.reasons || []).map((x) => x.code);
          rec.trace = { value: st.value, since: st.since, sample: st.sample, activation: st.activation && st.activation.time, driver: st.driver && st.driver.kind, trust: st.trust, codes, stmt: st.stmt && st.stmt.src };
          // (no value: Trace gives st.noValueText; judged like the other surfaces, so a port copy's reason is the known class)
          if ((st.value === undefined || st.value === null) && st.noValueText) {
            const jv = dumpV === undefined ? null : judge({ value: dumpV }, st.noValueText);
            if (jv) { bad(pt, 'trace:value:' + jv, { dump: dumpV, shown: st.noValueText, reason: st.noValue && st.noValue.reason }); }
          } else {
            const dv = differs(dumpV, st.value); if (st.value !== undefined && dv) { bad(pt, 'trace:value:' + dv, { dump: dumpV, shown: st.value }); }
          }
          if (st.since !== undefined && st.since !== null && Number(st.since) !== pt.last && !st.unconfirmed) { bad(pt, 'trace:since', { since: st.since, dumpChange: pt.last }); }
          // "keeps its value": the dump changed at this time
          if (codes.includes('noWrite') || codes.includes('held')) {
            // (at the activation the trace explains: the dump changed there)
            const at = Number(st.activation && st.activation.time !== undefined ? st.activation.time : pt.last);
            const before = await truth.valueAt(pt.p, at - 1), after = await truth.valueAt(pt.p, at);
            const lastChanged = pt.last > t0 && (await truth.valueAt(pt.p, pt.last - 1)) !== (await truth.valueAt(pt.p, pt.last));
            if (before === UNKNOWN || after === UNKNOWN) { truthUnknown++; } else if (before !== after || (codes.includes('noWrite') && lastChanged && Number(st.since) === pt.last)) { bad(pt, 'trace:keepsValue-but-changed', { at, before, after, codes, stmt: st.stmt && st.stmt.src, decisions: (st.decisions || []).map((d) => [d.src, d.taken, d.value]) }); }
          }
          // fan-in values at their time
          for (const f of st.fanin || []) {
            if (!f.path || f.local || f.blocking) { continue; }
            const dvv = await dumpValue(f.path, Number(f.time));
            if (!dvv) { stats.faninUnresolved++; } else { stats.faninChecked++; }
            const fshown = (f.value === undefined || f.value === null) && f.noValueText ? f.noValueText : f.value;
            const d = judge(dvv, fshown);
            if (d) { bad(pt, 'trace:fanin:' + d, { resolvedVia: f.resolvedVia, computed: f.computed, fanin: f.path, dumpPath: dvv && dvv.path, via: dvv && dvv.via, dumped: f.dumped, at: f.time, dump: dvv && dvv.value, shown: fshown, role: f.role }); }
          }
          // branch decisions on a plain signal: its value at the sample (an x there while the dump has a value is wrong)
          const inst0 = pt.p.split('.').slice(0, -1).join('.');
          for (const dc of st.decisions || []) {
            const name = String(dc.src || '').trim();
            if (!/^[A-Za-z_][\w$]*$/.test(name) || dc.value === undefined) { continue; }
            const at = Number(st.sample !== undefined && st.sample !== null ? st.sample : pt.t);
            const dvv = await dumpValue(inst0 + '.' + name, at);
            if (!dvv) { stats.decisionUnresolved++; } else { stats.decisionChecked++; }
            const d = judge(dvv, dc.value);
            if (d) { bad(pt, 'trace:decision:' + d, { decision: name, dumpPath: dvv && dvv.path, via: dvv && dvv.via, at, dump: dvv && dvv.value, shown: dc.value, taken: dc.taken }); }
          }
          // inline values in the driver statement's module, for this signal's instance
          const loc = st.stmt && st.stmt.loc && Object.assign({}, st.stmt.loc);
          if (loc && loc.file && !path.isAbsolute(loc.file)) { loc.file = path.join(DEMO, folder.dir, loc.file); }
          if (loc && loc.file && fs.existsSync(loc.file)) {
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.file));
              const mod = moduleAt(doc.getText(), Number(loc.line) - 1);
              // the instance whose module holds the statement: a port connection is in the parent's module
              const dr = st.driver || {};
              const parentOf = (x) => String(x).split('.').slice(0, -1).join('.');
              const inst = dr.kind === 'portIn' && dr.from ? dr.from : dr.kind === 'portOut' && dr.instance ? parentOf(dr.instance) : parentOf(pt.p);
              if (mod) {
                const pick = await vscode.commands.executeCommand('vaporview.debugger.chooseInstance', { uri: String(doc.uri), line: mod.line, instance: inst });
                const vals = await withTimeout(Promise.resolve(dbg({ kind: 'inline', uri: String(doc.uri), first: mod.line, last: mod.end })), 60000, 'inline values');
                rec.inline = { file: path.basename(loc.file), module: mod.name, instance: pick, lines: (vals || []).length };
                // (a chip format the parser doesn't know must fail loudly, not pass with nothing checked)
                if ((vals || []).length && !(vals || []).some((l) => inlineParts(l.text).length)) { bad(pt, 'inline:unparsed', { sample: String(vals[0].text).slice(0, 200) }); }
                stats.inlineChecked++;
                for (const l of vals || []) {
                  for (const pr of inlineParts(l.text)) {
                    const m = [null, pr.name, pr.value];
                    if (m[1].includes('[')) { continue; }
                    const vp = inst + '.' + m[1];
                    stats.inlineValues++;
                    const at = sess && Number.isFinite(sess.time) ? sess.time : pt.t;
                    const dvv = await dumpValue(vp, at);
                    // vscode-port: with the shared formatter, a multi-bit value shows
                    // width'radix ("64'h0000000000010000"); only a 1-bit value is bare. A bare multi-bit digit string fails, so a
                    // formatter regression can't pass as a correct bare value. DEMO_REQUIRE_RADIX=0 judges older builds.
                    const rw = Number((truth.vars.get(dvv && dvv.path) || truth.vars.get(vp) || {}).width) || (dvv && typeof dvv.value === 'string' && dvv.value !== UNKNOWN ? dvv.value.length : 0);
                    if (REQUIRE_RADIX && pr.bare && rw > 1 && /^[0-9a-fA-FxXzZ_]+$/.test(String(m[2]))) {
                      bad(pt, 'inline:radix-missing', { name: vp, at, line: l.line + 1, file: path.basename(loc.file), width: rw, shown: m[2], text: String(l.text).slice(0, 300), source: 'debugger inline (vaporview.debugger.e2e kind inline)' });
                      continue;
                    }
                    const d = judge(dvv, pr.bare ? bareToBits(m[2], truth.vars.get(dvv && dvv.path) || truth.vars.get(vp), dvv && typeof dvv.value === 'string' ? dvv.value : undefined) : m[2]);
                    if (d) { bad(pt, 'inline:' + d, { name: vp, dumpPath: dvv && dvv.path, via: dvv && dvv.via, at, line: l.line + 1, file: path.basename(loc.file), dump: dvv && dvv.value, shown: m[2], text: String(l.text).slice(0, 300), source: 'debugger inline (vaporview.debugger.e2e kind inline)' }); }
                  }
                }
              }
            } catch (e) { bad(pt, 'inline:exception', { error: String(e && e.stack || e).slice(0, 600) }); }
          }
        }
        log(rec);
      }
      // vscode-port: after every read, the reader's status is at most a warning (computed
      // refusals and limits are warnings; red only for byte damage). A red status is a violation.
      try {
        const wsEnd = await vscode.commands.executeCommand('vaporview.e2e.wispState', uri);
        log({ wispStateEnd: wsEnd && { status: wsEnd.status, statusLevel: wsEnd.statusLevel, signalErrors: wsEnd.signalErrors }, folder: folder.name, format });
        console.log(`  wispState end ${folder.name} ${format}: ${JSON.stringify(wsEnd && { status: wsEnd.status, level: wsEnd.statusLevel })}`);
        if (wsEnd && wsEnd.statusLevel === 'error') { violations.push({ kind: 'status:red', status: wsEnd.status }); log({ violation: true, folder: folder.name, format, kind: 'status:red', status: wsEnd.status, signalErrors: JSON.stringify(wsEnd.signalErrors || '').slice(0, 600) }); }
      } catch (e) { log({ wispStateEndError: String(e) }); }
      log({ mem: memRow('after-probes') }); snap('end'); await sampled('end'); if (insp) { try { await post('HeapProfiler.stopSampling'); insp.disconnect(); } catch {} }
    } finally {
      try { await stopDebugger(); } catch {}
      truth.close();
    }
    stats.truthUnknown = truthUnknown; truthUnknown = 0; stats.truthUnknownSignals = unknownSeen.size; unknownSeen.clear(); stats.truthRestarts = truth.restarts ? truth.restarts() : 0;
    const summary = Object.assign({ folder: folder.name, format, violations: violations.length }, stats);
    log({ summary });
    console.log(`  DIAGNOSTIC demo-sweep ${folder.name} ${format}: ${JSON.stringify(summary)}`);
    const kinds = {}; for (const v of violations) { kinds[v.kind] = (kinds[v.kind] || 0) + 1; }
    if (violations.length) { throw new Error(`${violations.length} violations ${JSON.stringify(kinds)}; first: ${JSON.stringify(violations.slice(0, 3))}`); }
  };
}

const tests = {};
for (const f of FOLDERS) {
  if (want.length && !want.includes(f.name)) { continue; }
  for (const fmt of FORMATS) { tests[`demo sweep: ${f.name} ${fmt}: valueAt, Trace Driver, inline values vs the dump`] = sweep(f, fmt); }
}
module.exports = tests;
void sleep;
