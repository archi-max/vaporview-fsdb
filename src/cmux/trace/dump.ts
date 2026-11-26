// vscode-port: the trace engine's dump provider, in the extension host. Port of the dump provider of
// cmux's Resources/vaporview/cmux-trace-ui.js (branch tracex-wcz 44516d52d6a; its whole-history path, the one a
// file the viewer reads itself takes), GPL-3.0 with VaporView.
//
// Pluggable: the provider reads a TraceDumpSource, which says how to find a dump variable and read its value
// changes. VCD/FST/GHW come from VaporView's own wellen reader (wellen_source.ts); FSDB/WCZ plug in a source over
// wisp-helper (backend) with the same interface. Paths given to the provider are design paths; the
// session's prefixes map them onto the dump (whole segments; either may be empty).

import { newV2State, refused, v2XStart, v2MaskChangeCount, v2PagedEdge, v2DeriveXStart, v2DeriveMaskCount, v2ChangeCount, v2LastChange, v2NextChange, v2PointRead, v2PrevEdge, type V2, type V2State, type V2Var } from './helper_v2';

export type Change = [number, string];
export interface TraceVar { key: string; width: number }
export interface CaptureGap { from: number; to?: number; toEnd?: boolean }

export interface TraceDumpSource {
  /** A short name for the kind of dump ('vcd', 'fst', 'wcz', ...). */
  readonly kind: string;
  /** The variable a dump path names (dot-separated, a generate index stays on its segment), or null. */
  findVar(dumpPath: string): Promise<TraceVar | null>;
  /** Every change of the variable as [time, bits], oldest first; null when it can't be read. */
  changes(v: TraceVar, maxChanges: number): Promise<Change[] | null>;
  /** When the dump starts (default 0). */
  start?(): number;
  /** Capture gaps (a WCZ file's): nothing recorded in (from, to] (toEnd: to the dump's end). */
  captureGaps?(): CaptureGap[];
  /** A windowed helper's query (wisp-helper protocol; vars then carry `signalId`): values, edges and counts come
   *  from it and whole histories (`changes`) only when it can't answer. */
  v2?: V2;
  /** Stop the reads in flight (a new trace, Cancel, the panel closed); later reads go on as usual. */
  cancel?(): void;
  /** Answers read so far that the file's check had not confirmed yet (helper "verified": false). */
  readonly unverified?: number;
  /** Replies dropped because the file was reloaded or closed meanwhile. */
  readonly reloads?: number;
}

// Changes read per signal for edges and "since" (cmux: MAX_CHANGES).
const MAX_CHANGES = 2_000_000;
// Changes kept per session, all signals together, bounded by their bits (cmux: CACHED_BITS).
const CACHED_BITS = 256e6;

export interface DumpSession {
  source: TraceDumpSource;
  designPrefix: string;
  dumpPrefix: string;
  vars: Map<string, Promise<TraceVar | null>>;
  changes: Map<string, Change[] | null>;
  reading: Map<string, Promise<Change[] | null>>;
  bitsOf: Map<string, number>;
  cached: number;
  helper: V2State | null;
}

export function newDumpSession(source: TraceDumpSource, designPrefix: string, dumpPrefix: string): DumpSession {
  const s: DumpSession = { source, designPrefix: designPrefix || '', dumpPrefix: dumpPrefix || '', vars: new Map(), changes: new Map(), reading: new Map(), bitsOf: new Map(), cached: 0, helper: null };
  if (typeof source.v2 === 'function') { s.helper = newV2State(source.v2.bind(source), () => dumpStart(s), (a, b) => gapIn(s, a, b)); }
  return s;
}

/** A design path as the dump names it. */
export function toDump(s: { designPrefix: string; dumpPrefix: string }, designPath: string): string {
  const p = s.designPrefix;
  if (!p || designPath === p || designPath.startsWith(p + '.')) {
    const rest = p ? designPath.slice(p.length).replace(/^\./, '') : designPath;
    return [s.dumpPrefix, rest].filter(Boolean).join('.');
  }
  return designPath;
}
/** A dump path as the design names it (the inverse of toDump). */
export function toDesign(s: { designPrefix: string; dumpPrefix: string }, dumpPath: string): string {
  const p = s.dumpPrefix;
  if (!p || dumpPath === p || dumpPath.startsWith(p + '.')) {
    const rest = p ? dumpPath.slice(p.length).replace(/^\./, '') : dumpPath;
    return [s.designPrefix, rest].filter(Boolean).join('.');
  }
  return dumpPath;
}

const bitsOf = (value: string, width: number) => {
  const t = String(value);
  return t.length >= width ? t : (t[0] === 'x' || t[0] === 'z' ? t[0] : '0').repeat(width - t.length) + t;
};
function indexAt(changes: Change[], time: number) {
  let lo = 0, hi = changes.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Number(changes[mid][0]) <= time) { at = mid; lo = mid + 1; } else { hi = mid - 1; } }
  return at;
}
const isEdge = (prev: string, now: string, edge: string) => {
  const pos = (prev === '0' && now !== '0') || ((prev === 'x' || prev === 'z') && now === '1');
  const neg = (prev === '1' && now !== '1') || ((prev === 'x' || prev === 'z') && now === '0');
  return edge === 'PosEdge' ? pos : edge === 'NegEdge' ? neg : pos || neg;
};

function varOf(s: DumpSession, designPath: string): Promise<TraceVar | null> {
  let v = s.vars.get(designPath);
  if (!v) { v = s.source.findVar(toDump(s, designPath)).catch(() => null); s.vars.set(designPath, v); }
  return v;
}

function changesOf(s: DumpSession, v: TraceVar): Promise<Change[] | null> {
  if (s.changes.has(v.key)) { return Promise.resolve(s.changes.get(v.key) || null); }
  const under = s.reading.get(v.key);
  if (under) { return under; }
  const p = (async () => {
    let out: Change[] | null = null;
    try { out = await s.source.changes(v, MAX_CHANGES); } catch { out = null; }
    if (out && out.length > MAX_CHANGES) { out = null; }
    s.changes.set(v.key, out);
    const bits = out ? out.length * ((Number(v.width) || 1) + 32) : 0;
    s.bitsOf.set(v.key, bits);
    s.cached += bits;
    for (const id of [...s.changes.keys()]) {
      if (s.cached <= CACHED_BITS) { break; }
      if (id !== v.key) { s.changes.delete(id); s.cached -= s.bitsOf.get(id) || 0; s.bitsOf.delete(id); }
    }
    return out;
  })().finally(() => { s.reading.delete(v.key); });
  s.reading.set(v.key, p);
  return p;
}

function gaps(s: DumpSession): CaptureGap[] {
  try { const g = s.source.captureGaps ? s.source.captureGaps() : null; return Array.isArray(g) ? g : []; } catch { return []; }
}
const gapEnd = (g: CaptureGap) => (g.toEnd ? Infinity : Number(g.to));
function gapIn(s: DumpSession, a: number, b: number): CaptureGap | null {
  let hit: CaptureGap | null = null;
  for (const g of gaps(s)) { if (Number(g.from) < b && gapEnd(g) > a) { hit = g; } }
  return hit;
}
const dumpStart = (s: DumpSession) => (s.source.start ? Number(s.source.start()) || 0 : 0);

/** The engine's `dump` (cmux-trace.js createEngine): values, lastChange, prevEdge, xStart, counts, nextChange. */
export function makeDump(s: DumpSession) {
  return {
    async values(paths: string[], time: number) {
      const unique = [...new Set(paths)];
      const h = s.helper;
      // (each path's var once; the gaps once; a signal's cached changes read in place, no await per path)
      const vars = await Promise.all(unique.map((p) => varOf(s, p)));
      let point: Map<string, string> | null = null;
      if (h) {
        const found = vars.filter((v): v is TraceVar => !!v) as V2Var[];
        point = await v2PointRead(h, [...new Map(found.map((v) => [v.key, v])).values()], time);
      }
      // Inside a capture gap the value is not recorded.
      const inGap = gaps(s).some((g) => Number(g.from) < time && time < gapEnd(g));
      const valueOf = (v: TraceVar, changes: Change[] | null) => {
        const width = Number(v.width) || 1;
        const i = changes ? indexAt(changes, time) : -1;
        const bits = i >= 0 ? changes![i][1] : (changes ? 'x'.repeat(width) : undefined);
        return bits === undefined ? undefined : bitsOf(bits, width).toLowerCase();
      };
      const m = new Map<string, string | undefined>();
      const later: Promise<void>[] = [];
      unique.forEach((p, k) => {
        const v = vars[k];
        if (!v || inGap) { m.set(p, undefined); return; }
        const known = point && point.get(v.key);
        if (typeof known === 'string') { m.set(p, bitsOf(known, Number(v.width) || 1).toLowerCase()); return; }
        if (h && refused(h, v as V2Var)) { m.set(p, undefined); return; }
        if (s.changes.has(v.key)) { m.set(p, valueOf(v, s.changes.get(v.key) || null)); return; }
        m.set(p, undefined);
        later.push(changesOf(s, v).then((changes) => { m.set(p, valueOf(v, changes)); }));
      });
      if (later.length) { await Promise.all(later); }
      return new Map(paths.map((p) => [p, m.get(p)]));
    },
    async lastChange(p: string, time: number) {
      const v = await varOf(s, p);
      if (!v) { return null; }
      if (s.helper) { const at = await v2LastChange(s.helper, v as V2Var, time); if (at !== undefined) { return at; } }
      const changes = await changesOf(s, v);
      if (!changes) { return null; }
      const i = indexAt(changes, time);
      const last = i < 0 ? 0 : Number(changes[i][0]);
      return gapIn(s, last, time) ? null : last;
    },
    async prevEdge(p: string, time: number, edge: string) {
      const v = await varOf(s, p);
      if (!v) { return null; }
      if (s.helper) {
        let at = await v2PrevEdge(s.helper, v as V2Var, time, edge);
        // (a vector: the helper's edges are 1-bit only; bounded pages over its least significant bit)
        if (at === undefined) { at = await v2PagedEdge(s.helper, v as V2Var, time, edge, isEdge); }
        if (at !== undefined) { return at === null || !gapIn(s, at, time) ? at : null; }
      }
      const width = Number(v.width) > 0 ? Number(v.width) : 1;
      const changes = await changesOf(s, v);
      if (!changes) { return null; }
      const last = indexAt(changes, time);
      for (let i = last; i > 0; i--) {
        const prev = bitsOf(changes[i - 1][1], width).slice(-1).toLowerCase();
        const now = bitsOf(changes[i][1], width).slice(-1).toLowerCase();
        if (isEdge(prev, now, edge)) { const at = Number(changes[i][0]); return gapIn(s, at, time) ? null : at; }
      }
      return null;
    },
    start() { return dumpStart(s); },
    unrecorded(from: number, to: number) { return gapIn(s, Number(from), Number(to)); },
    async xStart(p: string, time: number) {
      const v = await varOf(s, p);
      if (!v) { return null; }
      if (s.helper) {
        // (bounded exact pages; undefined: not known, the engine walks itself, with its cap, and says so)
        let at = await v2DeriveXStart(s.helper, v as V2Var, time);
        if (at === undefined) { at = await v2XStart(s.helper, v as V2Var, time); }
        if (at === undefined || at === null) { return at; }
        const g = gapIn(s, at, time);
        return g ? (Number.isFinite(gapEnd(g)) ? { time: gapEnd(g), complete: false } : undefined) : { time: at, complete: true };
      }
      const changes = await changesOf(s, v);
      if (!changes) { return null; }
      const width = Number(v.width) || 1;
      const hasX = (i: number) => /[xz]/.test(bitsOf(changes[i][1], width).toLowerCase());
      let i = indexAt(changes, time);
      if (i < 0) { return { time: 0, complete: true }; }
      if (!hasX(i)) { return null; }
      while (i > 0 && hasX(i - 1)) { i--; }
      const at = i === 0 ? 0 : Number(changes[i][0]);
      const g = gapIn(s, at, time);
      return g ? (Number.isFinite(gapEnd(g)) ? { time: gapEnd(g), complete: false } : undefined) : { time: at, complete: true };
    },
    async changeCount(p: string, from: number, to: number) {
      const v = await varOf(s, p);
      if (!v || !(to > from)) { return v ? 0 : undefined; }
      if (gapIn(s, from, to)) { return undefined; }
      if (s.helper) { return v2ChangeCount(s.helper, v as V2Var, from, to); }
      const changes = await changesOf(s, v);
      if (!changes) { return undefined; }
      let n = 0;
      for (const c of changes) { const t = Number(c[0]); if (t > from && t <= to) { n++; } }
      return n;
    },
    async maskChangeCount(p: string, from: number, to: number) {
      const v = await varOf(s, p);
      if (!v || !(to > from)) { return v ? 0 : undefined; }
      if (gapIn(s, from, to)) { return undefined; }
      if (s.helper) {
        const n = await v2DeriveMaskCount(s.helper, v as V2Var, from, to);
        return n !== undefined ? n : v2MaskChangeCount(s.helper, v as V2Var, from, to);
      }
      const width = Number(v.width) || 1;
      const changes = await changesOf(s, v);
      if (!changes) { return undefined; }
      const mask = (bits: string) => bitsOf(bits, width).toLowerCase().replace(/[01]/g, '.');
      let n = 0;
      for (let i = 1; i < changes.length; i++) {
        const at = Number(changes[i][0]);
        if (at > from && at <= to && mask(changes[i][1]) !== mask(changes[i - 1][1])) { n++; }
      }
      return n;
    },
    async nextChange(p: string, time: number) {
      const v = await varOf(s, p);
      if (!v) { return null; }
      if (s.helper) { const at = await v2NextChange(s.helper, v as V2Var, time); if (at !== undefined) { return at; } }
      const changes = await changesOf(s, v);
      if (!changes) { return null; }
      const c = changes.find((x) => Number(x[0]) >= time);
      return c ? Number(c[0]) : null;
    },
  };
}
export { setPageChanges, pageStats } from './helper_v2';
