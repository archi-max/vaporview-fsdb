// vscode-port: the dump provider's answers from a windowed helper (wisp-helper's protocol: valueAt with
// prev, edge, count/window), so FSDB/WCZ tracing reads no whole signal it doesn't have to. Port of the helper-v2
// half of cmux's cmux-trace-ui.js dump provider (v2Edge, v2PointRead, v2WindowCount, the edge and next-change
// queries; cmux branch tracex-wcz 44516d52d6a), GPL-3.0 with VaporView.
//
// wisp-helper 15.7 has SystemVerilog edges itself (kind posedge / negedge / edge: from both values of a change), so
// cmux's walk over rise/fall answers (v2NarrowEdge/v2WideEdge, written for a helper with rise/fall only) is one
// query here. It has no `derive` (cmux's helper made a 1-bit "any x or z" signal per signal for xStart and the
// x-mask count). A helper build with `derive` has it again and those two are cmux's queries
// (v2DeriveXStart, v2DeriveMaskCount); without it, v2XStart / v2MaskChangeCount walk bounded exact window pages
// (below), keeping only the running x-state: the same answers.
import * as zlib from 'zlib';
import type { Change, TraceVar } from './dump';

/** One helper query: its result (with the reply's binary body as `bin` when it has one), or {error}. */
export type V2 = (req: Record<string, unknown>) => Promise<any | undefined>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface V2Var extends TraceVar { signalId: number }

const POINT_VALUES = 8192;

export interface V2State {
  v2: V2;
  start: () => number;
  gapIn: (a: number, b: number) => { from: number; to?: number; toEnd?: boolean } | null;
  edges: Map<string, number | null>;
  pointValues: Map<string, string | null>;
  since: Map<string, Array<[number, number]>>;
  refused: Set<number>;
  prevReads: boolean | null;
  /** The helper's `derive` (a helper build with derive, as cmux.s): false once it said it has none. */
  derive: boolean | null;
  derived: Map<string, number | null>;
}

export function newV2State(v2: V2, start: () => number, gapIn: V2State['gapIn']): V2State {
  return { v2, start, gapIn, edges: new Map(), pointValues: new Map(), since: new Map(), refused: new Set(), prevReads: null, derive: null, derived: new Map() };
}

async function ask(s: V2State, req: Record<string, unknown>) {
  const r = await s.v2(req);
  if (r && r.error && /larger than|store limit/i.test(String(r.error)) && req.signalId !== undefined) { s.refused.add(Number(req.signalId)); }
  return r && !r.error ? r : undefined;
}
export const refused = (s: V2State, v: V2Var) => s.refused.has(v.signalId);

function keepSince(s: V2State, v: V2Var, at: number, time: number) {
  const spans = s.since.get(v.key) || [];
  spans.push([at, time]);
  if (spans.length > 8) { spans.shift(); }
  s.since.set(v.key, spans);
}
function knownSince(s: V2State, v: V2Var, time: number) {
  const spans = s.since.get(v.key);
  const span = spans && spans.find(([at, upTo]) => at <= time && time <= upTo);
  return span ? span[0] : undefined;
}

/** The last change of `v` before `t` (kind any), or the last SV edge (posedge/negedge/edge), cached. */
export async function v2Edge(s: V2State, v: V2Var, t: number, kind: string): Promise<number | null | undefined> {
  const key = v.key + ':' + kind + ':' + t;
  if (s.edges.has(key)) { return s.edges.get(key); }
  const r = await ask(s, { cmd: 'edge', signalId: v.signalId, t, dir: -1, kind });
  if (r === undefined) { return undefined; }
  const at = r.t === null || r.t === undefined ? null : Number(r.t);
  s.edges.set(key, at);
  return at;
}

/** Values at `time` with each one's last change (valueAt prev), batched; null when the helper can't. */
export async function v2PointRead(s: V2State, list: V2Var[], time: number): Promise<Map<string, string> | null> {
  if (s.prevReads === false || !list.length) { return null; }
  const key = (v: V2Var) => v.key + '@' + time;
  const want = list.filter((v) => !s.pointValues.has(key(v)) && !refused(s, v));
  if (want.length) {
    const r = await ask(s, { cmd: 'valueAt', signalIds: want.map((v) => v.signalId), t: time, prev: true });
    if (!r || !Array.isArray(r.values) || r.values.length !== want.length) { return null; }
    if (!Array.isArray(r.prev) || r.prev.length !== want.length) { s.prevReads = false; return null; }
    s.prevReads = true;
    if (s.pointValues.size + want.length > POINT_VALUES) { s.pointValues.clear(); }
    want.forEach((v, i) => {
      const p = r.prev[i], read = typeof r.values[i] === 'string';
      // null: no change at or before `time`; {t: null, notRecorded}: the last change is in a capture gap.
      const at = !read || (p && p.notRecorded) ? undefined : p === null ? 0 : p && p.t !== null && Number.isFinite(Number(p.t)) ? Number(p.t) : undefined;
      if (at !== undefined && at <= time) { keepSince(s, v, at, time); }
      s.pointValues.set(key(v), read ? r.values[i] : null);
    });
  }
  const out = new Map<string, string>();
  for (const v of list) { const value = s.pointValues.get(key(v)); if (typeof value === 'string') { out.set(v.key, value); } }
  return out;
}

export async function v2LastChange(s: V2State, v: V2Var, time: number): Promise<number | null | undefined> {
  if (refused(s, v)) { return null; }
  let known = knownSince(s, v, time);
  if (known === undefined && s.prevReads !== false && await v2PointRead(s, [v], time)) { known = knownSince(s, v, time); }
  if (known !== undefined) { return s.gapIn(known, time) ? null : known; }
  const at = await v2Edge(s, v, Math.floor(time) + 1, 'any');
  if (at === undefined) { return undefined; }
  const last = at === null ? 0 : at;
  return s.gapIn(last, time) ? null : last;
}

const EDGE_KIND: Record<string, string> = { PosEdge: 'posedge', NegEdge: 'negedge', BothEdges: 'edge' };
export async function v2PrevEdge(s: V2State, v: V2Var, time: number, edge: string): Promise<number | null | undefined> {
  if (refused(s, v)) { return null; }
  const at = await v2Edge(s, v, Math.floor(time) + 1, EDGE_KIND[edge] || 'edge');
  if (at === undefined) { return undefined; }
  // The dump's first value is no edge.
  if (at !== null && at <= s.start()) { return null; }
  return at !== null && s.gapIn(at, time) ? null : at;
}

/** Changes in (from, to]: a one-bucket window [from + 1, to + 1). */
export async function v2ChangeCount(s: V2State, v: V2Var, from: number, to: number): Promise<number | undefined> {
  if (refused(s, v) || s.gapIn(from, to)) { return undefined; }
  const r = await ask(s, { cmd: 'window', signals: [{ signalId: v.signalId, width: v.width }], t0: Math.max(0, Math.floor(from) + 1), t1: Math.floor(to) + 1, buckets: 1 });
  const sig = r && Array.isArray(r.signals) ? r.signals[0] : null;
  return sig && !sig.error && Number.isFinite(Number(sig.count)) ? Number(sig.count) : undefined;
}

export async function v2NextChange(s: V2State, v: V2Var, time: number): Promise<number | null | undefined> {
  if (refused(s, v)) { return null; }
  const from = Math.max(s.start(), Math.ceil(time) - 1);
  const r = await ask(s, { cmd: 'edge', signalId: v.signalId, t: from, dir: 1, kind: 'any' });
  if (r === undefined) { return undefined; }
  const at = r.t === null || r.t === undefined ? null : Number(r.t);
  // (from the dump's start, a change at the start itself is the start's value, not a change after it)
  return at;
}

// ---- x runs with the helper's `derive` (as cmux): one derived signal per signal and question ----
async function derivedId(s: V2State, expr: string): Promise<number | undefined> {
  if (s.derive === false) { return undefined; }
  if (s.derived.has(expr)) { const id = s.derived.get(expr); return id === null ? undefined : id; }
  const r = await s.v2({ cmd: 'derive', expr });
  if (r && r.error) {
    // (a cancelled read, or one dropped by a reload, says nothing about the expression: not remembered)
    if (/not supported|unknown command/i.test(String(r.error))) { s.derive = false; } else if (r.code !== 'cancelled' && r.code !== 'reloaded') { s.derived.set(expr, null); }
    return undefined;
  }
  if (!r || !Number.isFinite(Number(r.signalId))) { return undefined; }
  s.derive = true;
  s.derived.set(expr, Number(r.signalId));
  return Number(r.signalId);
}

/** xStart from a derived 1-bit signal, 1 while any bit of v is x or z: its last rise (cmux's v2XStart). */
export async function v2DeriveXStart(s: V2State, v: V2Var, time: number): Promise<number | null | undefined> {
  if (refused(s, v)) { return undefined; }
  const id = await derivedId(s, `(^#${v.signalId}) === 1'bx`);
  if (id === undefined) { return undefined; }
  const [now, rise] = await Promise.all([
    ask(s, { cmd: 'valueAt', signalIds: [id], t: time }),
    ask(s, { cmd: 'edge', signalId: id, t: Math.floor(time) + 1, dir: -1, kind: 'rise' }),
  ]);
  const value = now && Array.isArray(now.values) ? now.values[0] : undefined;
  if (value === '0') { return null; }
  if (value !== '1' || rise === undefined) { return undefined; }
  const at = rise.t === null || rise.t === undefined ? 0 : Number(rise.t);
  return at <= s.start() ? 0 : at;
}

/** The x-mask change count from a derived (#id ^ #id) (x where v has x or z, else 0): one window count. */
export async function v2DeriveMaskCount(s: V2State, v: V2Var, from: number, to: number): Promise<number | undefined> {
  if (refused(s, v)) { return undefined; }
  const id = await derivedId(s, `(#${v.signalId} ^ #${v.signalId})`);
  if (id === undefined) { return undefined; }
  const r = await ask(s, { cmd: 'window', signals: [{ signalId: id, width: v.width }], t0: Math.max(0, Math.floor(from) + 1), t1: Math.floor(to) + 1, buckets: 1 });
  const sig = r && Array.isArray(r.signals) ? r.signals[0] : null;
  return sig && !sig.error && Number.isFinite(Number(sig.count)) ? Number(sig.count) : undefined;
}

// ---- x runs without `derive`: bounded pages ----
// wisp-helper's exact window [t0, t1): its first record is the value in effect at t0 (time t0), then every change in
// (t0, t1), when the reply says `exact` (at most 2 x buckets changes). The x-run start and the x-mask count walk such
// pages, at most PAGE_CHANGES changes (and PAGE_BYTES of records) each, keeping only the running x-state: memory
// is bounded by one page whatever the signal's length. Answers are exact (the same as cmux's derived signals); a walk
// that passes the time guard answers undefined (the engine then walks itself, with its cap, and says so).
let PAGE_CHANGES = 65536;
const PAGE_BYTES = 8 << 20;
/** Tests: a smaller page (many pages, split windows) to check the walk across page edges. */
export function setPageChanges(n: number) { PAGE_CHANGES = Math.max(2, Math.floor(n)); }
export const PAGE_GUARD_MS = 30000;
export const pageStats = { pages: 0, maxRecords: 0 }; // (diagnostics for the tests)

// A page as the helper sent it: inflated records [u64 LE delta time][width value chars], read in place (no string or
// array per record: a walk over many pages leaves little for the collector).
interface Page { raw: Buffer; n: number; rec: number; width: number; times: Float64Array; exact: boolean; count: number }
async function page(s: V2State, v: V2Var, t0: number, t1: number, limit: number): Promise<Page | undefined> {
  const r = await ask(s, { cmd: 'window', signals: [{ signalId: v.signalId, width: v.width }], t0, t1, buckets: Math.max(1, Math.ceil(limit / 2)) });
  const h = r && Array.isArray(r.signals) ? r.signals[0] : null;
  const bin: Buffer | undefined = r && r.bin;
  if (!h || h.error || h.text) { return undefined; }
  const count = Number(h.count) || 0;
  const width = Number(v.width) || 1, rec = 8 + width;
  if (!h.exact) { return { raw: Buffer.alloc(0), n: 0, rec, width, times: new Float64Array(0), exact: false, count }; }
  if (!bin) { return undefined; }
  const raw = zlib.inflateRawSync(bin.subarray(0, Number(h.bytes) || 0));
  const n = Math.floor(raw.length / rec);
  const times = new Float64Array(n);
  let t = 0;
  for (let i = 0, o = 0; i < n; i++, o += rec) { t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296; times[i] = t; }
  pageStats.pages++;
  if (n > pageStats.maxRecords) { pageStats.maxRecords = n; }
  return { raw, n, rec, width, times, exact: true, count };
}
// (value chars: '0' 48, '1' 49, 'x' 120, 'z' 122, 'X' 88, 'Z' 90)
const isXZ = (c: number) => c === 120 || c === 122 || c === 88 || c === 90;
function hasXZ(p: Page, i: number) {
  for (let o = i * p.rec + 8, e = o + p.width; o < e; o++) { if (isXZ(p.raw[o])) { return true; } }
  return false;
}
/** Whether records i of p and j of q have x/z in the same bits (the same x mask). */
function sameMask(p: Page, i: number, q: Page, j: number) {
  for (let a = i * p.rec + 8, b = j * q.rec + 8, e = a + p.width; a < e; a++, b++) { if (isXZ(p.raw[a]) !== isXZ(q.raw[b])) { return false; } }
  return true;
}
const lsbOf = (p: Page, i: number) => String.fromCharCode(p.raw[i * p.rec + 8 + p.width - 1]).toLowerCase();
const pageLimit = (v: V2Var) => Math.max(1, Math.min(PAGE_CHANGES, Math.floor(PAGE_BYTES / (8 + (Number(v.width) || 1)))));

/** Where the x run in effect at `time` began: its first change with x or z (0: x since the dump's start); null with
 *  no x or z at `time`; undefined when not known (the helper failed, or the time guard). */
export async function v2XStart(s: V2State, v: V2Var, time: number, guardMs = PAGE_GUARD_MS): Promise<number | null | undefined> {
  if (refused(s, v)) { return undefined; }
  const limit = pageLimit(v), start = s.start(), until = Date.now() + guardMs;
  let hi = Math.floor(time) + 1;
  let span = Math.max(1, hi - start);
  let firstX: number | undefined;
  for (;;) {
    if (Date.now() > until) { return undefined; }
    const lo = Math.max(start, hi - span);
    const p = await page(s, v, lo, hi, limit);
    if (!p) { return undefined; }
    if (!p.exact) { if (span <= 1) { return undefined; } span = Math.max(1, Math.floor(span / Math.max(2, Math.ceil(p.count / limit) + 1))); continue; }
    const n = p.n;
    for (let i = n - 1; i >= 1; i--) {
      if (hasXZ(p, i)) { firstX = p.times[i]; } else { return firstX === undefined ? null : firstX; }
    }
    if (!n) { return firstX === undefined ? null : firstX; }
    if (!hasXZ(p, 0)) { return firstX === undefined ? null : firstX; }
    if (lo <= start) { return 0; }
    // (the record in effect at lo has x: the run began at or before lo; the next page ends just after it)
    hi = lo + 1;
    if (p.count < limit / 4) { span *= 4; }
  }
}

/** The last SystemVerilog edge (`isEdge` on the least significant bit) of a vector at or before `time`: the helper
 *  answers posedge/negedge/edge for 1-bit signals only, and cmux read a vector's whole history for this; here, bounded
 *  pages backward. The dump's first value is no edge. Undefined when not known. */
export async function v2PagedEdge(s: V2State, v: V2Var, time: number, edge: string, isEdge: (prev: string, now: string, edge: string) => boolean,
  guardMs = PAGE_GUARD_MS): Promise<number | null | undefined> {
  if (refused(s, v)) { return undefined; }
  const limit = pageLimit(v), start = s.start(), until = Date.now() + guardMs;
  let hi = Math.floor(time) + 1;
  let span = Math.max(1, hi - start);
  for (;;) {
    if (Date.now() > until) { return undefined; }
    const lo = Math.max(start, hi - span);
    const p = await page(s, v, lo, hi, limit);
    if (!p) { return undefined; }
    if (!p.exact) { if (span <= 1) { return undefined; } span = Math.max(1, Math.floor(span / Math.max(2, Math.ceil(p.count / limit) + 1))); continue; }
    // (pairs in this page: changes in (lo, hi), each against the value before it; record 0 is the value at lo)
    for (let i = p.n - 1; i >= 1; i--) {
      if (p.times[i] > time) { continue; }
      if (isEdge(lsbOf(p, i - 1), lsbOf(p, i), edge)) { return p.times[i]; }
    }
    if (lo <= start) { return null; }
    hi = lo + 1;
    if (p.count < limit / 4) { span *= 4; }
  }
}

/** Changes of the x/z bits alone in (from, to]; undefined when not known. */
export async function v2MaskChangeCount(s: V2State, v: V2Var, from: number, to: number, guardMs = PAGE_GUARD_MS): Promise<number | undefined> {
  if (refused(s, v)) { return undefined; }
  const limit = pageLimit(v), until = Date.now() + guardMs, end = Math.floor(to) + 1;
  let lo = Math.max(0, Math.floor(from));
  let span = Math.max(1, end - lo);
  // (the last record seen: its page and index, for the x mask)
  let last: Page | null = null, lastI = 0, n = 0;
  while (lo < end) {
    if (Date.now() > until) { return undefined; }
    const hi = Math.min(end, lo + span);
    const p = await page(s, v, lo, hi, limit);
    if (!p) { return undefined; }
    if (!p.exact) { if (span <= 1) { return undefined; } span = Math.max(1, Math.floor(span / Math.max(2, Math.ceil(p.count / limit) + 1))); continue; }
    for (let i = 0; i < p.n; i++) {
      // (record 0 is the value in effect at lo: a change only where its mask differs from the last one seen)
      if (last && p.times[i] > from && p.times[i] <= to && !sameMask(last, lastI, p, i)) { n++; }
      last = p; lastI = i;
    }
    lo = hi;
    if (p.count < limit / 4) { span *= 4; }
  }
  return n;
}

export type { Change };
