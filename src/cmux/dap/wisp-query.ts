// vscode-port: the waveform debugger's windowed queries for FSDB and WCZ files, through the
// wisp-helper that serves the open document (src/cmux/wisp: wisp-helper's protocol). Breakpoint search, stepping
// values, Locals, watches and Evaluate ask the helper for what they need (the next change, the next matching value, a
// value at a time, exact windows of one signal) instead of reading a signal's whole history: no 1M-change cap.
//   change   edge {kind: any}          the first change after t (dir 1) / the last before t (dir -1)
//   equals   search {value, wildcard}  a change whose value matches; the debugger keeps the ones that enter the match
//   values   valueAt {signalIds, t}
//   text     exact windows (window {t0, t1, buckets}), judged with the debugger's own text rule (text-judge.ts)
// No vscode import: test/perf bundles it.
import * as zlib from 'zlib';

export type HelperReply = { line: any; bin?: Buffer | Uint8Array | null };
/** One request to the helper (the reply line, and its binary body when it has one). */
export type HelperRequest = (req: Record<string, unknown>) => Promise<HelperReply>;

export type QueryVar = { signalId: number; width: number };
export type Window = { exact: boolean; count: number; recs: Array<[number, string]> };

/** What the debugger asks a windowed backend. Times are dump times (integers). */
/** Values at a time; `noValue[i]`: the reader's own "no value (why)" text for a value it has not. */
export type ValuesAt = Array<string | undefined> & { noValue?: Array<string | undefined> };

export interface WindowedQueries {
  readonly timeEnd: number;
  /** dir 1: the first change with time > t; dir -1: the last change with time < t. null: none. */
  nextChange(v: QueryVar, t: number, dir: number): Promise<number | null>;
  /** As nextChange, for changes whose value matches `bits` (one character per bit, '?' any). */
  nextMatch(v: QueryVar, t: number, dir: number, bits: string): Promise<number | null>;
  /** The values at time t (the last change at or before t), full width; undefined when none / unreadable. */
  valuesAt(vars: QueryVar[], t: number): Promise<ValuesAt>;
  /** An exact window of one signal: record 0 is the value at t0, then every change in (t0, t1). Not exact when the
   *  window holds more changes than `buckets` can carry (then only `count`). */
  window(v: QueryVar, t0: number, t1: number, buckets: number): Promise<Window>;
  /** Queries asked (perf checks). */
  readonly stats: { requests: number };
}

export class QueryError extends Error {}

function decodeBits(raw: Buffer, width: number): Array<[number, string]> {
  const rec = 8 + width, n = Math.floor(raw.length / rec);
  const s = raw.toString('latin1');
  const out: Array<[number, string]> = new Array(n);
  let t = 0;
  for (let i = 0, o = 0; i < n; i++, o += rec) {
    t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296;
    out[i] = [t, s.substring(o + 8, o + rec)];
  }
  return out;
}

/** The queries over a helper request function. */
export function helperQueries(request: HelperRequest, timeEnd: number): WindowedQueries {
  const stats = { requests: 0 };
  const ask = async (req: Record<string, unknown>) => {
    stats.requests++;
    const r = await request(req);
    const line = r.line || {};
    if (line.error) { throw new QueryError(String(line.error)); }
    return { result: line.result ?? line, bin: r.bin };
  };
  const time = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    timeEnd,
    stats,
    async nextChange(v, t, dir) {
      if (dir > 0 && t >= timeEnd) { return null; }
      if (dir < 0 && t <= 0) { return null; }
      const { result } = await ask({ cmd: 'edge', signalId: v.signalId, t: Math.max(0, t), dir, kind: 'any' });
      return time(result.t);
    },
    async nextMatch(v, t, dir, bits) {
      if (dir > 0 && t >= timeEnd) { return null; }
      if (dir < 0 && t <= 0) { return null; }
      const req: Record<string, unknown> = { cmd: 'search', signalId: v.signalId, t: Math.max(0, t), dir, value: bits };
      if (bits.includes('?')) { req.wildcard = '?'; }
      const { result } = await ask(req);
      return time(result.t);
    },
    async valuesAt(vars, t) {
      if (!vars.length) { return []; }
      const { result } = await ask({ cmd: 'valueAt', signalIds: vars.map((v) => v.signalId), t: Math.max(0, t) });
      const values: unknown[] = result.values || [];
      const out = vars.map((_, i) => (typeof values[i] === 'string' ? String(values[i]) : undefined)) as ValuesAt;
      // vscode-port (query()): why a value is missing, e.g. no change recorded up to t (never x)
      const nv: any[] = Array.isArray(result.noValue) ? result.noValue : [];
      if (nv.some((x) => x && x.text)) { out.noValue = vars.map((_, i) => (nv[i] && nv[i].text ? String(nv[i].text) : undefined)); }
      return out;
    },
    async window(v, t0, t1, buckets) {
      const { result, bin } = await ask({ cmd: 'window', signals: [{ signalId: v.signalId, width: v.width }], t0: Math.max(0, t0), t1, buckets });
      const h = result.signals && result.signals[0];
      if (!h || h.error) { throw new QueryError(String(h ? h.error : 'no window reply')); }
      if (!h.exact) { return { exact: false, count: Number(h.count) || 0, recs: [] }; }
      if (h.text) { throw new QueryError('a text (string/real) signal has no bit values'); }
      const body = Buffer.from(bin || Buffer.alloc(0)).subarray(0, Number(h.bytes) || 0);
      const recs = decodeBits(zlib.inflateRawSync(body), v.width);
      return { exact: true, count: recs.length, recs };
    },
  };
}

/** The helper behind an open document's parser (src/cmux/wisp/wisp_handler.ts WispFormatHandler), if it has one:
 *  its query() API when present (replies after a reload dropped, refusals on the status bar, never
 *  throws), else its helper process directly. */
export function documentHelper(handler: unknown): HelperRequest | null {
  const h = handler as { query?: (req: Record<string, unknown>) => Promise<any>; helper?: { request?: (req: Record<string, unknown>) => Promise<HelperReply> } } | null;
  if (h && typeof h.query === 'function') {
    return async (req) => {
      const r = await h.query!(req);
      if (!r || r.error) { return { line: { error: String(r ? `${r.error}${r.code ? ` (${r.code})` : ''}` : 'no reply') } }; }
      return { line: { result: r.result }, bin: r.bin };
    };
  }
  const helper = h && h.helper;
  if (!helper || typeof helper.request !== 'function') { return null; }
  return (req) => helper.request!(req);
}

// ---- searches built on the queries (the whole-history engine's semantics, engine.ts timesOf) ----

export const SCAN_BUCKETS = 32768;  // exact windows of up to 65536 changes (as the viewer's text search)

function matches(bits: string, pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) { if (pattern[i] !== '?' && pattern[i] !== bits[i]) { return false; } }
  return true;
}

/** Equals: the next time `v` enters a value matching `pattern` (matches now, did not just before), after t (dir 1) or
 *  before t (dir -1). A change at time 0 counts when it matches (the whole-history engine's first value). */
export async function nextEntry(q: WindowedQueries, v: QueryVar, t: number, dir: number, pattern: string, fit: (raw: string) => string): Promise<number | null> {
  if (dir > 0 && t < 0) {
    const [v0] = await q.valuesAt([v], 0);
    if (v0 !== undefined && matches(fit(v0), pattern)) { return 0; }
    t = 0;
  }
  for (let guard = 0; guard < 1_000_000; guard++) {
    const m = await q.nextMatch(v, t, dir, pattern);
    if (m === null) {
      // dir -1 from after 0: the value at time 0 is the first one, and enters the match when it matches.
      if (dir < 0 && t > 0) { const [v0] = await q.valuesAt([v], 0); if (v0 !== undefined && matches(fit(v0), pattern)) { return 0; } }
      return null;
    }
    if (m === 0) { return 0; }
    const [before] = await q.valuesAt([v], m - 1);
    if (before === undefined || !matches(fit(before), pattern)) { return m; }
    t = m;
  }
  return null;
}

/** A signal's whole history through exact windows (the clock's posedges: read whole, as cmux reads its clock). */
export async function history(q: WindowedQueries, v: QueryVar): Promise<{ times: number[]; values: string[] }> {
  const times: number[] = [], values: string[] = [];
  const end = q.timeEnd + 1;
  let span = 1 << 24, at = 0;
  while (at < end) {
    const a = Math.max(0, at - 1), t1 = Math.min(end, a + span);
    const w = await q.window(v, a, t1, SCAN_BUCKETS);
    if (!w.exact) { span = Math.max(1, Math.floor((t1 - a) * (SCAN_BUCKETS * 1.6) / Math.max(1, w.count))); continue; }
    for (let i = at === 0 ? 0 : 1; i < w.recs.length; i++) {
      if (w.recs[i][0] < at && at > 0) { continue; }
      times.push(w.recs[i][0]); values.push(w.recs[i][1]);
    }
    at = t1;
    span = Math.max(1, Math.floor((t1 - a) * Math.min(8, Math.max(1, SCAN_BUCKETS / Math.max(1, w.recs.length)))));
  }
  return { times, values };
}

/** Text: the next change (a value different from the one before) whose value `judge` accepts, scanning exact windows;
 *  the value at time 0 counts. `judge` takes the distinct values of a window (bits, full width) and says which match. */
export async function nextTextHit(q: WindowedQueries, v: QueryVar, t: number, dir: number, fit: (raw: string) => string,
  judge: (values: string[]) => Promise<Map<string, boolean> | string>): Promise<number | null | { error: string }> {
  const end = q.timeEnd + 1;
  let span = 1 << 20;
  const grow = (dt: number, n: number) => Math.max(1, Math.floor(dt * Math.min(8, Math.max(1, SCAN_BUCKETS / Math.max(1, n)))));
  const judged = async (recs: Array<[number, string]>) => {
    const bits = recs.map((r) => fit(r[1]));
    const verdicts = await judge([...new Set(bits)]);
    return { bits, verdicts };
  };
  if (dir > 0) {
    let at = t < 0 ? 0 : t + 1;  // the first time not looked at yet
    for (;;) {
      if (at >= end) { return null; }
      const a = Math.max(0, at - 1);
      const t1 = Math.min(end, a + span);
      const w = await q.window(v, a, t1, SCAN_BUCKETS);
      if (!w.exact) { span = Math.max(1, Math.floor((t1 - a) * (SCAN_BUCKETS * 1.6) / Math.max(1, w.count))); continue; }
      const { bits, verdicts } = await judged(w.recs);
      if (typeof verdicts === 'string') { return { error: verdicts }; }
      for (let i = 0; i < w.recs.length; i++) {
        const time = w.recs[i][0];
        if (time < at && !(at === 0 && i === 0)) { continue; }
        if (i > 0 && bits[i] === bits[i - 1]) { continue; }
        if (verdicts.get(bits[i])) { return time; }
      }
      if (t1 >= end) { return null; }
      at = t1;
      span = grow(t1 - a, w.recs.length);
    }
  }
  let b = Math.min(end, t);  // changes before b
  for (;;) {
    if (b <= 0) { return null; }
    const t0 = Math.max(0, b - span - 1);
    const w = await q.window(v, t0, b, SCAN_BUCKETS);
    if (!w.exact) { span = Math.max(1, Math.floor((b - t0) * (SCAN_BUCKETS * 1.6) / Math.max(1, w.count))); continue; }
    const { bits, verdicts } = await judged(w.recs);
    if (typeof verdicts === 'string') { return { error: verdicts }; }
    // Record 0 is the value at t0 (a change at t0 or earlier): it counts only at the start of the dump.
    const last = t0 === 0 ? 0 : 1;
    for (let i = w.recs.length - 1; i >= last; i--) {
      const time = w.recs[i][0];
      if (time >= b) { continue; }
      if (i > 0 && bits[i] === bits[i - 1]) { continue; }
      if (i === 0 && t0 > 0) { continue; }
      if (verdicts.get(bits[i])) { return time; }
    }
    if (t0 === 0) { return null; }
    span = grow(b - t0, w.recs.length);
    b = t0 + 1;
  }
}
