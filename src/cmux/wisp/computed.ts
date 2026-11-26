// vscode-port: computed signals (wisp-helper 15.10+, an FSDB open with "outsideWrites": "none").
// Port copies the converter cannot link get signal ids after the stored ones (stats -> computed.firstId/.signals); the
// helper answers them in `window` requests only (valueAt / count / edge / search refuse them). This module answers
// valueAt, edge and count for those ids through window requests, so every caller (the viewer, trace, the API) sees
// computed rows as it sees stored ones. Requests without computed ids go to the helper unchanged.
// Semantics (the stored rows' answers, wisp-helper 15.11):
//   valueAt {signalIds, t, prev?} -> {values[], errors?[], prev?[{t, value} | null]}: the value in effect at t; prev =
//     the last change at or before t (null when none).
//   edge {signalId, t, dir, kind} -> {t | null}: the first change strictly after (dir 1) / before (dir -1) t; for a
//     1-bit signal SV rules: rise/posedge = 0->1|x|z or x|z->1, fall/negedge = 1->0|x|z or x|z->0, edge = either;
//     wider signals: any change.
//   count {signalIds, ...} -> {counts[{signalId, count, bits}]}: changes over the whole history.
import * as zlib from 'zlib';
import type { HelperReply } from './helper_process';

export interface ComputedRange { first: number; n: number; }
type Ask = (req: Record<string, unknown>, onId?: (id: number) => void) => Promise<HelperReply>;
type Rec = [number, string];

const MAX_BUCKETS = 4194304;
// at most this many window requests in flight per answer, so a long Locals / Watch list cannot flood the helper
export const MAX_IN_FLIGHT = 8;

function limiter(n: number): <T>(f: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => { if (active < n && queue.length) {active++; queue.shift()!();} };
  return <T>(f: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    queue.push(() => { f().then(resolve, reject).finally(() => { active--; next(); }); });
    next();
  });
}

export function isComputed(r: ComputedRange | null, id: unknown): boolean {
  return !!r && typeof id === 'number' && id >= r.first && id < r.first + r.n;
}

// vscode-port: what the helper refuses in valueAt / edge / count for a signal it computes (FSDB, outsideWrites
// none): port copies (the stats range) and also signals outside it, e.g. a 2-driver wire VCS does not store (design H
// `bus`). The extension learns those ids from this refusal and answers them through windows like the range.
export const WINDOW_ONLY = /computed signal answers window requests only/i;

function decode(raw: Buffer, width: number): Rec[] {
  const rec = 8 + width, n = Math.floor(raw.length / rec), out: Rec[] = new Array(n), s = raw.toString('latin1');
  let t = 0;
  for (let i = 0, o = 0; i < n; i++, o += rec) {
    t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296;
    out[i] = [t, s.substring(o + 8, o + rec)];
  }
  return out;
}

// One exact window of a computed signal: its records over [t0, t1] (the first is the value in effect before t0).
async function windowRecs(ask: Ask, id: number, width: number, t0: number, t1: number, onId?: (id: number) => void): Promise<{recs?: Rec[]; count?: number; error?: string}> {
  let rep: HelperReply;
  try { rep = await ask({cmd: 'window', signals: [{signalId: id, width}], t0, t1, buckets: MAX_BUCKETS}, onId); }
  catch (e) { return {error: e instanceof Error ? e.message : String(e)}; }  // (never a rejection left unhandled in a limiter)
  const {line, bin} = rep;
  const h = line.result && line.result.signals && line.result.signals[0];
  if (line.error || !h || h.error) {return {error: String(line.error || (h && h.error) || 'no answer')};}
  if (!h.exact) {return {error: 'too many changes in one window to answer exactly', count: Number(h.count) || 0};}
  return {recs: decode(zlib.inflateRawSync((bin || Buffer.alloc(0)).subarray(0, Number(h.bytes) || 0)), width), count: Number(h.count) || 0};
}

// The changes among records (a record whose value equals the one before is not a change).
// The changes among records (a record whose value equals the one before is not a change). `t0` is the window's start:
// from 0 the first record is the signal's first, a change from all-x (helper 15.12, measured); otherwise its value
// before is unknown here (from = null: never an edge; the next window back covers it).
function changes(recs: Rec[], t0 = -1, width = 1): {t: number; from: string | null; to: string; initial?: boolean}[] {
  const out: {t: number; from: string | null; to: string; initial?: boolean}[] = [];
  for (let i = 0; i < recs.length; i++) {
    const initial = !i && t0 === 0;
    const from = i ? recs[i - 1][1] : (initial ? 'x'.repeat(width) : null);
    if (from !== recs[i][1]) {out.push({t: recs[i][0], from, to: recs[i][1], ...(initial ? {initial} : {})});}
  }
  return out;
}

// The helper's edge rules (15.12, measured on design H): 'any' = any change; 1-bit posedge / negedge / edge = SV rules
// (IEEE 1800 9.4.2: posedge 0->1, 0->x/z, x/z->1; negedge 1->0, 1->x/z, x/z->0; x<->z neither), the first record not
// counted; 1-bit rise / fall = the same rules, the first record (a change from x) counted; wider signals: any / rise /
// fall = any change (the first record counted), posedge / negedge / edge are refused.
function edgeMatches(kind: string, width: number, from: string | null, to: string, initial = false): boolean {
  if (from === null) {return false;}  // the value before the window is not known here
  if (kind === 'any' || width !== 1) {return true;}
  if (initial && (kind === 'posedge' || kind === 'negedge' || kind === 'edge')) {return false;}
  const f = from.toLowerCase(), v = to.toLowerCase();
  const pos = (f === '0' && v !== '0') || (f !== '1' && f !== '0' && v === '1');
  const neg = (f === '1' && v !== '1') || (f !== '1' && f !== '0' && v === '0');
  if (kind === 'rise' || kind === 'posedge') {return pos;}
  if (kind === 'fall' || kind === 'negedge') {return neg;}
  if (kind === 'edge') {return pos || neg;}
  return true;
}

export async function answerComputed(ask: Ask, req: Record<string, any>, range: ComputedRange | ((id: unknown) => boolean), widthOf: (id: number) => number,
  timeEnd: number, onId?: (id: number) => void): Promise<HelperReply | null> {
  const cmd = req.cmd;
  const end = Math.max(1, timeEnd + 1);
  const isC: (id: unknown) => boolean = typeof range === 'function' ? range : (id: unknown) => isComputed(range, id);
  if (cmd === 'valueAt') {
    const ids: any[] = Array.isArray(req.signalIds) ? req.signalIds : [];
    if (!ids.some((id) => isC(id))) {return null;}
    const t = Number(req.t) || 0;
    const stored = ids.filter((id) => !isC(id));
    const base = stored.length ? await ask({...req, signalIds: stored}, onId) : {line: {result: {values: []}}, bin: null};
    if (base.line.error) {return base;}
    const sv: any[] = base.line.result?.values || [], se: any[] = base.line.result?.errors || [], sp: any[] = base.line.result?.prev || [];
    const values: any[] = [], errors: any[] = [], prev: any[] = [];
    let k = 0, anyErr = false;
    // the computed ids' windows [t, t+1] in parallel (one request each; the helper runs them on its workers)
    const wins = new Map<number, Promise<{recs?: Rec[]; count?: number; error?: string}>>();
    const run = limiter(MAX_IN_FLIGHT);
    for (const id of ids) {if (isC(id) && !wins.has(id)) {wins.set(id, run(() => windowRecs(ask, id, widthOf(id), req.prev ? 0 : t, t + 1, onId)));}}
    for (const id of ids) {
      if (!isC(id)) {
        values.push(sv[k] ?? null); errors.push(se[k] ?? null); prev.push(sp[k] ?? null); if (se[k]) {anyErr = true;} k++; continue;
      }
      const r = await wins.get(id)!;
      if (!r.recs) {values.push(null); errors.push(r.error); prev.push(null); anyErr = true; continue;}
      const upTo = r.recs.filter((x) => x[0] <= t);
      const cur = upTo.length ? upTo[upTo.length - 1] : null;
      values.push(cur ? cur[1] : null); errors.push(cur ? null : 'no value at this time'); if (!cur) {anyErr = true;}
      if (req.prev) {
        const ch = changes(upTo).filter((c) => c.from !== null);
        prev.push(ch.length ? {t: ch[ch.length - 1].t, value: ch[ch.length - 1].to} : null);
      }
    }
    const result: any = {values};
    if (anyErr) {result.errors = errors;}
    if (req.prev) {result.prev = prev;}
    return {line: {...base.line, result: {...base.line.result, ...result}}, bin: null};
  }
  if (cmd === 'edge') {
    const id = req.signalId;
    if (!isC(id)) {return null;}
    const w = widthOf(id), t = Number(req.t) || 0, dir = Number(req.dir) < 0 ? -1 : 1, kind = String(req.kind || 'any');
    if (w !== 1 && (kind === 'posedge' || kind === 'negedge' || kind === 'edge')) {return {line: {error: 'edge: posedge, negedge and edge need a 1-bit signal'}, bin: null};}
    // growing spans away from t until a matching change or the dump's end
    let span = Math.max(64, Math.ceil(end / 256));
    let a = t, guard = 0;
    while (guard++ < 64) {
      const t0 = dir > 0 ? a : Math.max(0, a - span), t1 = dir > 0 ? Math.min(end, a + span) : a;
      const r = await windowRecs(ask, id, w, t0, t1, onId);
      if (!r.recs) {return {line: {error: r.error}, bin: null};}
      const ch = changes(r.recs, t0, w).filter((c) => (dir > 0 ? c.t > t : c.t < t) && edgeMatches(kind, w, c.from, c.to, !!c.initial));
      if (ch.length) {return {line: {result: {t: dir > 0 ? ch[0].t : ch[ch.length - 1].t, computed: true}}, bin: null};}
      if (dir > 0 ? t1 >= end : t0 <= 0) {return {line: {result: {t: null, computed: true}}, bin: null};}
      a = dir > 0 ? t1 : t0;
      span *= 2;
    }
    return {line: {result: {t: null, computed: true}}, bin: null};
  }
  if (cmd === 'search') {
    // vscode-port: the helper's search on a stored row (15.12, measured on design H q/clk/sel): the first RECORD
    // strictly after t (dir 1) / strictly before t (dir -1) whose value matches `value` bit by bit: a pattern 'x' (and the
    // request's wildcard, '?') matches 0 or 1, '0' / '1' only themselves; a value holding x or z never matches (q = xxxx
    // at 0 is no hit for "xxxx" or "????"). The record at time 0 counts.
    // Growing windows, as edge.
    const id = req.signalId;
    if (!isC(id)) {return null;}
    const w = widthOf(id), t = Number(req.t) || 0, dir = Number(req.dir) < 0 ? -1 : 1;
    const want = String(req.value ?? '').toLowerCase(), wild = typeof req.wildcard === 'string' && req.wildcard ? req.wildcard.toLowerCase() : null;
    const matches = (v: string): boolean => {
      const x = v.toLowerCase(), p = want.length < x.length ? want.padStart(x.length, '0') : want;
      if (p.length !== x.length || /[^01]/.test(x)) {return false;} // a value with an x or z bit never matches (the helper's rule)
      for (let i = 0; i < x.length; i++) { const c = p[i]; if (c === 'x' || (wild !== null && c === wild)) {continue;} if (c !== x[i]) {return false;} }
      return true;
    };
    let span = Math.max(64, Math.ceil(end / 256));
    let a = t, guard = 0;
    while (guard++ < 64) {
      const t0 = dir > 0 ? a : Math.max(0, a - span), t1 = dir > 0 ? Math.min(end, a + span) : a;
      const r = await windowRecs(ask, id, w, t0, t1, onId);
      if (!r.recs) {return {line: {error: r.error}, bin: null};}
      const hit = r.recs.filter((x) => (dir > 0 ? x[0] > t : x[0] < t) && matches(x[1]));
      if (hit.length) {return {line: {result: {t: dir > 0 ? hit[0][0] : hit[hit.length - 1][0], computed: true}}, bin: null};}
      if (dir > 0 ? t1 >= end : t0 <= 0) {return {line: {result: {t: null, computed: true}}, bin: null};}
      a = dir > 0 ? t1 : t0;
      span *= 2;
    }
    return {line: {result: {t: null, computed: true}}, bin: null};
  }
  if (cmd === 'count') {
    const ids: any[] = Array.isArray(req.signalIds) ? req.signalIds : [];
    if (!ids.some((id) => isC(id))) {return null;}
    const stored = ids.filter((id) => !isC(id));
    const base = stored.length ? await ask({...req, signalIds: stored}, onId) : {line: {result: {counts: []}}, bin: null};
    if (base.line.error) {return base;}
    const byId = new Map<number, any>();
    for (const c of base.line.result?.counts || []) {byId.set(Number(c.signalId), c);}
    const counts: any[] = [];
    for (const id of ids) {
      if (!isC(id)) {counts.push(byId.get(Number(id)) || {signalId: id, unknown: true, error: 'no answer'}); continue;}
      const w = widthOf(id);
      // buckets 1: the helper counts the window's changes without sending them
      const {line} = await ask({cmd: 'window', signals: [{signalId: id, width: w}], t0: 0, t1: end, buckets: 1}, onId);
      const h = line.result && line.result.signals && line.result.signals[0];
      if (line.error || !h || h.error) {counts.push({signalId: id, unknown: true, error: String(line.error || (h && h.error) || 'no answer')}); continue;}
      counts.push({signalId: id, count: Number(h.count) || 0, bits: w, computed: true});
    }
    return {line: {...base.line, result: {...base.line.result, counts}}, bin: null};
  }
  return null;
}
