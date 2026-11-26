// vscode-port P4: the waveform debugger's stepping and breakpoint search, ported from cmux's page-side debugger
// (cmux sv-editor Resources/vaporview/cmux-debugger.js: clock choice, posedges, step/jump, nearestHit, conditions,
// value patterns) to the extension host, where the Debug Adapter (session.ts) drives it. No vscode imports here.
import { type WaveData, type Series, type SignalMeta, valueBits, valueIn, pathKey } from './wave-data';
import { verdicts, type TextSpec } from './text-judge';
import { nextTextHit, type WindowedQueries, type QueryVar } from './wisp-query';
import { type PortValue, type NoValue, isNoValue, noValueText } from '../shared/port_resolve'; // vscode-port 
/** A debugger read : bits from the dump, bits through the design (via), or no value (why). */
export type DebugValue = { bits: string; via?: string } | NoValue;
// cmux-expr.js is pure; it registers globalThis.cmuxExpr (it keeps slang's MIT notice).
require('./vendor/cmux-expr.js');
export const X: any = (globalThis as any).cmuxExpr;

// Clock names looked for under the top scopes (then one level down), case-insensitively, in this order (cmux).
export const CLOCK_NAMES = ['clk', 'clock', 'clk_i', 'clock_i', 'i_clk', 'clk_in', 'aclk', 'hclk', 'pclk'];
export const RATES = [1, 2, 5, 10, 20, 50, 100, 200, 500];
const MAX_EDGES = 10000000;
const MAX_LINE_PATHS = 64;

export type CycleInfo = { clock: string | null; cycle: number | null; count: number; time: number | null; edgeTime: number | null; previousTime: number | null };

/** Breakpoint kinds. P4b adds 'pc' | 'commit' | 'write' etc. through BreakpointKindHandler. */
export type BreakpointKind = 'change' | 'equals' | 'text' | 'line' | string;

export type Breakpoint = {
  id: number;
  kind: BreakpointKind;
  /** The dump paths it watches (one for signal kinds, several for a line). */
  paths: string[][];
  enabled: boolean;
  label: string;
  /** equals: the value as written; pattern: its bits ('?' any). */
  value?: string;
  pattern?: string | null;
  text?: TextSpec;
  condition?: string | null;
  conditionError?: string | null;
  /** how a condition's names without dump values are read (through the design), for the breakpoint's message. */
  conditionNote?: string | null;
  noValueWarned?: boolean;
  /** a breakpoint on a signal read through the design says so. */
  designNote?: string | null;
  /** Where a condition's names are looked up first. */
  scope?: string[] | null;
  /** A line in any instance with a condition: one unit per instance (its own scope). */
  units?: Breakpoint[];
  times?: Float64Array | null;
  /** FSDB/WCZ: the windowed queries of each watched signal (hits are searched for, never listed). */
  win?: WinSignal[] | null;
  /** Why it cannot hit (signal gone, bad value, ...); null when fine. */
  problem?: string | null;
  /** Free data of the creator (DAP source line etc.). */
  origin?: any;
};

export type WinSignal = { path: string[]; width: number; q: WindowedQueries; v: QueryVar; pattern?: string | null };

/** P4b hook: extra breakpoint kinds compute their own hit times. */
export interface BreakpointKindHandler {
  kind: string;
  times(bp: Breakpoint, engine: DebugEngine): Promise<Float64Array | null>;
}

export function edgeIndexAt(edges: Float64Array, time: number): number {
  let lo = 0, hi = edges.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= time) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return at;
}

export function landingIndex(edges: Float64Array, time: number): number {
  let lo = 0, hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (edges[mid] < time) { lo = mid + 1; } else { hi = mid; } }
  return lo;
}

/** Times where the clock goes to 1 from anything else (0, x, z). */
export function posedges(changes: Series): Float64Array {
  const out: number[] = [];
  let previous: string | null = null;
  for (let i = 0; i < changes.times.length; i++) {
    const v = String(changes.values[i]);
    const high = v === '1';
    if (high && previous !== null && previous !== '1') { out.push(Number(changes.times[i])); }
    previous = v;
    if (out.length > MAX_EDGES) { throw new Error('too many clock edges'); }
  }
  return Float64Array.from(out);
}

// ---- value patterns (cmux parseValue / fitBits / matches) ----
function fitBits(bits: string, width: number): string | null {
  if (bits.length <= width) {
    const pad = 'xz?'.includes(bits[0]) ? bits[0] : '0';
    return pad.repeat(width - bits.length) + bits;
  }
  const cut = bits.slice(0, bits.length - width);
  const kept = bits.slice(bits.length - width);
  if (/^0*$/.test(cut) || ('xz?'.includes(kept[0]) && cut.split('').every((c) => c === kept[0]))) { return kept; }
  return null;
}

/** The value of `v` at `time` through a window [time, time + 1] (the last record at or before `time`); undefined when
 *  the window has none. */
async function windowValueAt(q: WindowedQueries, v: QueryVar, time: number): Promise<string | undefined> {
  const w = await q.window(v, time, time + 1, 4);
  if (!w.exact) { return undefined; }
  let val: string | undefined;
  for (const r of w.recs) { if (r[0] <= time) { val = r[1]; } }
  return val;
}

/** An SV-style value as one character per bit ('0' '1' 'x' 'z' '?'), `width` bits; null when it is not a value or does not fit. */
export function parseValue(text: string, width: number): string | null {
  const s = String(text || '').trim().toLowerCase().replace(/_/g, '');
  let bits: string;
  const sized = /^(\d*)'(s?)([bodh])([0-9a-fxz?]+)$/.exec(s);
  if (/^[xz?]$/.test(s)) {
    bits = s;
  } else if (/^\d+$/.test(s)) {
    bits = BigInt(s).toString(2);
  } else if (/^0x[0-9a-f]+$/.test(s)) {
    bits = BigInt(s).toString(2);
  } else if (sized) {
    const [, size, , base, digits] = sized;
    if (base === 'd') {
      if (/^[xz?]$/.test(digits)) { bits = digits; } else if (!/^\d+$/.test(digits)) { return null; } else { bits = BigInt(digits).toString(2); }
    } else {
      const per = base === 'b' ? 1 : (base === 'o' ? 3 : 4);
      bits = '';
      for (const c of digits) {
        if ('xz?'.includes(c)) { bits += c.repeat(per); continue; }
        const n = parseInt(c, 16);
        if (!(n < (1 << per))) { return null; }
        bits += n.toString(2).padStart(per, '0');
      }
    }
    if (size) {
      const n = Number(size);
      if (!(n > 0)) { return null; }
      const fitted = fitBits(bits, n);
      if (fitted === null) { return null; }
      bits = n < width ? '0'.repeat(width - n) + fitted : fitted;
    }
  } else {
    return null;
  }
  return fitBits(bits, width);
}

function matches(bits: string, pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) { if (pattern[i] !== '?' && pattern[i] !== bits[i]) { return false; } }
  return true;
}

/** The times `changes` hits a change (or equals, with `pattern`) breakpoint at. */
export function timesOf(changes: Series, width: number, kind: string, pattern?: string | null): number[] {
  const out: number[] = [];
  let previous: string | null = null;
  let previousMatched = false;
  changes.values.forEach((value, i) => {
    const time = changes.times[i];
    const bits = valueBits(value, width);
    if (kind !== 'equals') {
      if (i > 0 && bits !== previous) { out.push(Number(time)); }
    } else {
      const now = matches(bits, pattern || '');
      if (now && (i === 0 || !previousMatched)) { out.push(Number(time)); }
      previousMatched = now;
    }
    previous = bits;
  });
  return out;
}

export type Evaluation = { value?: string; width?: number; bits?: string; decimal?: string; raw?: any; error?: string; message?: string };

const EXPR_MESSAGES: Record<string, string> = {
  syntax: 'syntax error', unknownName: 'unknown name %s', tooLong: 'expression too long', tooManySignals: 'too many signals',
  tooWide: 'value too wide', noValue: 'no value', unsupported: 'not supported', badLiteral: 'bad literal',
  badReplication: 'bad replication', empty: 'empty expression', notConstant: 'not a constant', unsizedInConcat: 'unsized value in a concatenation',
};
export function exprMessage(error: string, at?: number | null, detail?: string): string {
  const base = (EXPR_MESSAGES[error] || error).replace('%s', detail || '');
  return at === null || at === undefined ? base : `${base} at column ${at + 1}`;
}

export class DebugEngine {
  clock: SignalMeta | null = null;
  clockChosen = false;
  edges: Float64Array | null = null;
  breakpoints: Breakpoint[] = [];
  kindHandlers = new Map<string, BreakpointKindHandler>();
  private nextId = 1;
  private changeCache = new Map<string, Series | undefined>();
  private cacheGeneration = -1;
  /** Warnings to show once (the session shows them). */
  onWarning: (text: string) => void = () => {};
  /** a signal without dump values, read through the design (vaporview.trace.resolvePortValue): its value via its
   *  single port / assign driver, or why it has none. Unset: such a signal has no value (not in the dump). */
  /** Names whose last helper read failed (path -> error). */
  readonly readErrors = new Map<string, string>();
  /** vscode-port the reader's own "no value (why)" per path, from its last read (wisp query() noValue). */
  readonly readerNoValue = new Map<string, string>();
  resolveMissing: ((path: string[], time: number) => Promise<PortValue>) | null = null;

  constructor(public readonly data: WaveData) {}

  newId() { return this.nextId++; }

  async changesOf(path: string[]): Promise<Series | undefined> {
    if (this.cacheGeneration !== this.data.generation) { this.changeCache.clear(); this.cacheGeneration = this.data.generation; }
    const key = pathKey(path);
    if (this.changeCache.has(key)) { return this.changeCache.get(key); }
    const c = await this.data.changes(path);
    this.changeCache.set(key, c);
    return c;
  }

  // ---- clock ----
  async defaultClock(): Promise<SignalMeta | null> {
    const pick = (items: Array<{ kind: string; name: string }>) => {
      for (const name of CLOCK_NAMES) {
        const v = items.find((c) => c.kind === 'var' && String(c.name).toLowerCase() === name && Number((c as SignalMeta).width) === 1);
        if (v) { return v as SignalMeta; }
      }
      return null;
    };
    const tops = await this.data.topScopes();
    for (const top of tops) { const v = pick(await this.data.children(top.path)); if (v) { return v; } }
    for (const top of tops) {
      for (const child of (await this.data.children(top.path)).filter((c) => c.kind === 'scope').slice(0, 16)) {
        const v = pick(await this.data.children(child.path));
        if (v) { return v; }
      }
    }
    return null;
  }

  /** null: the default clock. Returns the clock's path, or null when `path` is not a 1-bit signal. */
  async setClock(path: string[] | null): Promise<string[] | null> {
    const v = path ? await this.data.find(path) : await this.defaultClock();
    if (path && (!v || v.width !== 1)) { return null; }
    this.clock = v || null;
    this.clockChosen = !!path;
    this.edges = null;
    await this.ensureEdges();
    return v ? v.path : null;
  }

  async ensureEdges(): Promise<Float64Array | null> {
    if (this.edges) { return this.edges; }
    if (!this.clock) { this.clock = await this.defaultClock(); }
    if (!this.clock) { return null; }
    const changes = await this.changesOf(this.clock.path);
    this.edges = changes ? posedges(changes) : new Float64Array(0);
    return this.edges;
  }

  cycleInfo(time: number | null): CycleInfo {
    const edges = this.edges;
    const base = { clock: this.clock ? pathKey(this.clock.path) : null, count: edges ? edges.length : 0, time };
    if (!edges || time === null) { return { ...base, cycle: null, edgeTime: null, previousTime: null }; }
    const index = edgeIndexAt(edges, time);
    const previousTime = index > 0 ? edges[index - 1] : (index === 0 && edges[0] > 0 ? 0 : null);
    return { ...base, cycle: index + 1, edgeTime: index >= 0 ? edges[index] : null, previousTime };
  }

  /** The posedge time `by` cycles from `time` (cmux step). */
  stepTarget(time: number | null, by: number): number | null {
    const edges = this.edges;
    if (!edges || !edges.length) { return null; }
    let index: number;
    if (time === null) {
      index = by > 0 ? by - 1 : (by < 0 ? edges.length + by : 0);
    } else {
      const at = edgeIndexAt(edges, time);
      index = by > 0 || (by === 0 && at >= 0) ? at + by : (edges[at] === time ? at + by : at + by + 1);
    }
    index = Math.max(0, Math.min(edges.length - 1, index));
    return edges[index];
  }

  // ---- breakpoints ----
  add(bp: Omit<Breakpoint, 'id'> & { id?: number }): Breakpoint {
    const b = { ...bp, id: bp.id ?? this.newId() } as Breakpoint;
    this.checkCondition(b);
    this.breakpoints.push(b);
    return b;
  }

  remove(pred: (b: Breakpoint) => boolean) { this.breakpoints = this.breakpoints.filter((b) => !pred(b)); }

  checkCondition(bp: Breakpoint) {
    const c = String(bp.condition ?? '').trim();
    bp.condition = c || null;
    bp.conditionError = null;
    if (!c) { return; }
    const parsed = X.parse(c);
    if (parsed.error) { bp.conditionError = exprMessage(parsed.error, parsed.at); }
  }

  /** The times a breakpoint hits at (ascending); null when it cannot hit (bp.problem says why). */
  async hitTimes(bp: Breakpoint): Promise<Float64Array | null> {
    if (bp.times !== undefined) { return bp.times; }
    if (bp.win !== undefined) { return null; }
    const handler = this.kindHandlers.get(bp.kind);
    if (handler) { bp.times = await handler.times(bp, this); return bp.times; }
    if (await this.designBreakpoint(bp)) { return bp.times ?? null; }
    if (await this.prepareWindowed(bp)) { return null; }
    let times: number[] = [];
    let found = 0;
    const problems: string[] = [];
    for (const path of bp.paths) {
      const meta = await this.data.find(path);
      const changes = meta ? await this.changesOf(path) : undefined;
      if (!meta || !changes) { problems.push(`${pathKey(path)} is not in the dump`); continue; }
      if (bp.kind === 'text' && bp.text) {
        const bits = changes.values.map((v) => valueBits(v, meta.width));
        const judged = await verdicts(pathKey(path) + '\u0000' + meta.width, bp.text, bits);
        if (typeof judged === 'string') { problems.push(`text breakpoint: ${judged}`); continue; }
        for (let i = 0; i < bits.length; i++) {
          if (i > 0 && bits[i] === bits[i - 1]) { continue; }
          if (judged.get(bits[i])) { times.push(changes.times[i]); }
        }
        found++;
        continue;
      }
      if (bp.kind === 'equals') {
        bp.pattern = parseValue(bp.value || '', meta.width);
        if (!bp.pattern) { problems.push(`${bp.value} is not a ${meta.width}-bit value`); continue; }
      }
      found++;
      times = times.concat(timesOf(changes, meta.width, bp.kind === 'equals' ? 'equals' : 'change', bp.pattern));
    }
    bp.problem = found ? null : (problems[0] || 'no signal to watch');
    if (!found) { bp.times = null; return null; }
    // One signal's hit times are already ascending (its changes are): only several signals' need sorting.
    if (bp.paths.length > 1) { times.sort((a, b) => a - b); }
    const out = new Float64Array(times.length);
    let n = 0;
    for (let i = 0; i < times.length; i++) { if (n === 0 || times[i] !== out[n - 1]) { out[n++] = times[i]; } }
    bp.times = out.slice(0, n);
    return bp.times;
  }

  /** Design reads made for breakpoints and conditions (the e2e checks they follow the leaves' changes, not every time). */
  designReads = 0;
  /** vscode-port: when set (the e2e hook), every signal path a value read asks for. */
  requested: Set<string> | null = null;

  /** a change / equals breakpoint on one signal the dump has no values for (an undumped port or assign net),
   *  read through the design. Its candidate times are the changes of the resolver chain's dumped leaf signals (u1.en ->
   *  en1 -> phase), never a scan of every time; at each, its value through the design. True when it handled `bp`
   *  (bp.times, or bp.problem "cannot evaluate: ... has no value (why)"). */
  private async designBreakpoint(bp: Breakpoint): Promise<boolean> {
    if (!this.resolveMissing || bp.paths.length !== 1 || (bp.kind !== 'change' && bp.kind !== 'equals')) { return false; }
    const path = bp.paths[0];
    const meta = await this.data.find(path);
    if (meta && await this.hasDumpValues(meta)) { return false; }
    const fail = (r: NoValue) => { bp.times = null; bp.problem = `cannot evaluate: ${pathKey(path)} has no value (${noValueShown(r).replace(/^no value \((.*)\)$/, "$1")})`; return true; };
    // the dumped leaves: follow each "via" (port connection / continuous assign) to signals with dump values, depth <= 6
    const leaves: string[][] = [];
    const seen = new Set<string>([pathKey(path)]);
    let level: string[][] = [path];
    for (let depth = 0; level.length && depth <= 6; depth++) {
      const next: string[][] = [];
      for (const p of level) {
        const m = depth === 0 ? meta : await this.data.find(p);
        if (depth > 0 && m && await this.hasDumpValues(m)) { leaves.push(p); continue; }
        this.designReads++;
        const r = await this.resolveMissing(p, 0);
        if (isNoValue(r)) { return fail(r); }
        for (const v of r.via.replace(/ \((port connection|continuous assign)\)$/, '').split(', ')) {
          const vp = v.trim().replace(/\[[^\]]*\]$/, '').split('.');
          if (vp.length && !seen.has(pathKey(vp))) { seen.add(pathKey(vp)); next.push(vp); }
        }
      }
      level = next;
    }
    if (level.length || !leaves.length) { return fail({ noValue: true, reason: 'notComputable', why: 'depth', path: pathKey(path) }); }
    const cand = new Set<number>([0]);
    for (const l of leaves) { const c = await this.changesOf(l); if (c) { for (let k = 0; k < c.times.length; k++) { cand.add(Number(c.times[k])); } } }
    const times = [...cand].sort((a, b) => a - b);
    const values: string[] = [], at: number[] = [];
    for (const t of times) {
      this.designReads++;
      const r = await this.resolveMissing(path, t);
      if (isNoValue(r)) { continue; }
      at.push(t); values.push(r.value);
    }
    const width = meta ? meta.width : Math.max(1, values[0]?.length ?? 1);
    if (bp.kind === 'equals') {
      bp.pattern = parseValue(bp.value || '', width);
      if (!bp.pattern) { bp.times = null; bp.problem = `${bp.value} is not a ${width}-bit value`; return true; }
    }
    bp.problem = null;
    bp.designNote = `read through the design (changes of ${leaves.map((l) => l.join('.')).join(', ')})`;
    bp.times = Float64Array.from(timesOf({ times: at, values } as unknown as Series, width, bp.kind, bp.pattern));
    return true;
  }

  /** FSDB/WCZ: when every watched signal has windowed queries, checks the breakpoint (bp.problem) and keeps them in
   *  bp.win; true then (hits are searched for by windowedHit). False: the dump has none (hitTimes lists the hits). */
  private async prepareWindowed(bp: Breakpoint): Promise<boolean> {
    if (!this.data.windowed || !bp.paths.length) { return false; }
    const win: WinSignal[] = [];
    const problems: string[] = [];
    for (const path of bp.paths) {
      const meta = await this.data.find(path);
      if (!meta) { problems.push(`${pathKey(path)} is not in the dump`); continue; }
      const w = await this.data.windowed(path);
      if (!w) { return false; }
      const s: WinSignal = { path, width: meta.width, q: w.q, v: w.v };
      if (bp.kind === 'equals') {
        s.pattern = parseValue(bp.value || '', meta.width);
        if (!s.pattern) { problems.push(`${bp.value} is not a ${meta.width}-bit value`); continue; }
        bp.pattern = s.pattern;
      }
      win.push(s);
    }
    bp.problem = win.length ? null : (problems[0] || 'no signal to watch');
    bp.win = win.length ? win : null;
    return true;
  }

  /** One signal's nearest hit: dir 1, the first with time > after (after -1: from the dump's start, time 0 counts);
   *  dir -1, the last with time <= upto. The whole-history rules (timesOf, text) on the helper's answers. */
  private async signalHit(bp: Breakpoint, s: WinSignal, after: number, upto: number, dir: number): Promise<number | null> {
    const { q, v } = s;
    const fit = (raw: string) => valueBits(raw, s.width);
    if (bp.kind === 'text' && bp.text) {
      const key = pathKey(s.path) + '\u0000' + s.width;
      const r = await nextTextHit(q, v, dir > 0 ? after : upto + 1, dir, fit, (values) => verdicts(key, bp.text!, values));
      if (r !== null && typeof r === 'object') { throw new Error(`text breakpoint: ${r.error}`); }
      return r;
    }
    const equals = bp.kind === 'equals';
    const pattern = s.pattern || '';
    // The change entries at `m` (and the value just before): does one of them hit? (several at one time: glitches)
    const hitsAt = async (m: number): Promise<boolean> => {
      if (m === 0) {
        if (!equals) { return false; }  // the first value is no change
        const [v0] = await q.valuesAt([v], 0);
        return v0 !== undefined && matches(fit(v0), pattern);
      }
      const w = await q.window(v, m - 1, m + 1, 64);
      if (!w.exact) { return true; }
      let previous = w.recs.length ? fit(w.recs[0][1]) : null;
      let previousMatched = previous !== null && matches(previous, pattern);
      for (let i = 1; i < w.recs.length; i++) {
        if (w.recs[i][0] !== m) { continue; }
        const bits = fit(w.recs[i][1]);
        if (equals) {
          const now = matches(bits, pattern);
          if (now && !previousMatched) { return true; }
          previousMatched = now;
        } else if (bits !== previous) { return true; }
        previous = bits;
      }
      return false;
    };
    // vscode-port: each step of the search says where it is (status bar) and stops when Pause asked
    const next = async (t: number, d: number) => {
      this.searchAt(bp, t);
      if (DebugEngine.searchDelayMs) { await new Promise((r) => setTimeout(r, DebugEngine.searchDelayMs)); } // (e2e: a slow search)
      const m = await (equals ? q.nextMatch(v, t, d, pattern) : q.nextChange(v, t, d));
      this.searchAt(bp, m ?? t);
      return m;
    };
    if (dir > 0) {
      let t = after;
      if (t < 0) { if (equals && await hitsAt(0)) { return 0; } t = 0; }
      for (;;) {
        const m = await next(t, 1);
        if (m === null) { return null; }
        if (await hitsAt(m)) { return m; }
        t = m;
      }
    }
    let t = upto + 1;
    for (;;) {
      if (t <= 0) { return null; }
      const m = await next(t, -1);
      if (m === null) { return equals && upto >= 0 && t > 0 && await hitsAt(0) ? 0 : null; }
      if (await hitsAt(m)) { return m; }
      if (m === 0) { return null; }
      t = m;
    }
  }

  /** The nearest hit (cmux nearestHit, then the condition at the landing edge) of a windowed breakpoint. */
  private async windowedHit(bp: Breakpoint, from: number | null, dir: number, test: ((t: number) => Promise<boolean>) | null): Promise<{ time: number; index: number } | null> {
    const edges = this.edges!;
    let after = -1, upto = -1;
    if (dir > 0) {
      const at = from === null ? -1 : edgeIndexAt(edges, from);
      after = at >= 0 ? edges[at] : -1;
    } else {
      if (from === null) { return null; }
      let before = edgeIndexAt(edges, from);
      if (before >= 0 && edges[before] === from) { before--; }
      if (before < 0) { return null; }
      upto = edges[before];
    }
    const tried = new Map<number, boolean>();
    for (;;) {
      let best: number | null = null;
      for (const s of bp.win || []) {
        const h = await this.signalHit(bp, s, after, upto, dir);
        if (h !== null && (best === null || (dir > 0 ? h < best : h > best))) { best = h; }
      }
      if (best === null) { return null; }
      this.searchAt(bp, best); // vscode-port
      const index = landingIndex(edges, best);
      if (index >= edges.length) {
        if (dir > 0) { return null; }
      } else {
        if (!test) { return { time: best, index }; }
        if (!tried.has(index)) { tried.set(index, await test(edges[index])); }
        if (tried.get(index)) { return { time: best, index }; }
      }
      if (dir > 0) { after = best; } else { upto = best - 1; if (upto < 0) { return null; } }
    }
  }

  /** The hit of `times` nearest `from` in direction `dir` (cmux nearestHit): { time, index } (index: the landing posedge). */
  nearestHit(times: Float64Array, from: number | null, dir: number): { time: number; index: number } | null {
    const edges = this.edges!;
    const firstAfter = (limit: number) => {
      let lo = 0, hi = times.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= limit) { lo = mid + 1; } else { hi = mid; } }
      return lo;
    };
    if (dir > 0) {
      const at = from === null ? -1 : edgeIndexAt(edges, from);
      const i = firstAfter(at >= 0 ? edges[at] : -Infinity);
      if (i >= times.length) { return null; }
      return { time: times[i], index: landingIndex(edges, times[i]) };
    }
    if (from === null) { return null; }
    let before = edgeIndexAt(edges, from);
    if (before >= 0 && edges[before] === from) { before--; }
    if (before < 0) { return null; }
    const i = firstAfter(edges[before]) - 1;
    return i >= 0 ? { time: times[i], index: landingIndex(edges, times[i]) } : null;
  }

  // ---- expressions ----
  /** Vars for `paths` (as written): in `scope` first, then from the top. JSON path -> meta. */
  async resolveNames(paths: string[][], scope: string[] | null | undefined): Promise<Map<string, SignalMeta>> {
    const out = new Map<string, SignalMeta>();
    for (const path of paths) {
      let v = scope && scope.length ? await this.data.find(scope.concat(path)) : undefined;
      if (!v) { v = await this.data.find(path); }
      if (v) { out.set(JSON.stringify(path), v); }
    }
    return out;
  }

  /** The values (bits, as the dump gives them) of `vars` at `time`: FSDB/WCZ ask the helper (one request for all),
   *  other dumps look them up in each signal's changes. */
  async valuesAt(vars: SignalMeta[], time: number): Promise<Array<string | undefined>> {
    if (this.requested) {
      for (const v of vars) { this.requested.add(pathKey(v.path)); }
      // (the e2e profile: each read, its size, who asked, and how long it took)
      const caller = (new Error().stack || '').split('\n').slice(2, 6).map((l) => (/at (?:async )?([\w.]+)/.exec(l) || [])[1]).filter((x) => x && !/valuesAt|read$|readAt/.test(x))[0] || '?';
      const t0 = Date.now(), entry = { n: vars.length, caller, at: t0, ms: -1 };
      this.readLog.push(entry);
      try { return await this.valuesAtInner(vars, time); } finally { entry.ms = Date.now() - t0; }
    }
    return this.valuesAtInner(vars, time);
  }

  readonly readLog: Array<{ n: number; caller: string; at: number; ms: number }> = [];

  private async valuesAtInner(vars: SignalMeta[], time: number): Promise<Array<string | undefined>> {
    const out: Array<string | undefined> = new Array(vars.length).fill(undefined);
    if (!this.data.windowed || this.data.hasWindowed === false) {
      const fresh = this.cacheGeneration === this.data.generation;
      for (let i = 0; i < vars.length; i++) {
        const key = pathKey(vars[i].path);
        // Cached series without a microtask per signal (a step reads every var of an instance twice).
        const c = fresh && this.changeCache.has(key) ? this.changeCache.get(key) : await this.changesOf(vars[i].path);
        out[i] = c ? valueIn(c, time) : undefined;
      }
      return out;
    }
    const groups = new Map<WindowedQueries, Array<{ i: number; v: QueryVar }>>();
    for (let i = 0; i < vars.length; i++) {
      const w = this.data.windowed ? await this.data.windowed(vars[i].path) : null;
      if (w) {
        let g = groups.get(w.q);
        if (!g) { g = []; groups.set(w.q, g); }
        g.push({ i, v: w.v });
        continue;
      }
      const c = await this.changesOf(vars[i].path);
      out[i] = c ? valueIn(c, time) : undefined;
    }
    for (const [q, g] of groups) {
      // A batch the helper refuses is split down to the names it fails on (a read error, recorded for readAt), so one
      // name never takes every other value with it.
      const todo: Array<typeof g> = [g];
      while (todo.length) {
        const part = todo.pop()!;
        try {
          const values = await q.valuesAt(part.map((x) => x.v), time);
          for (let k = 0; k < part.length; k++) {
            const x = part[k];
            let val = values[k];
            const said = values.noValue && values.noValue[k];
            if (val === undefined && said) { this.readerNoValue.set(pathKey(vars[x.i].path), said); out[x.i] = undefined; continue; } // (the reader says why)
            // A helper-computed port copy (wisp.outsideWrites none) answers window requests only: valueAt gives null.
            // Read it as the waveform and Trace do, through a window [t, t+1].
            if (val === undefined) { val = await windowValueAt(q, x.v, time); }
            out[x.i] = val; this.readErrors.delete(pathKey(vars[x.i].path));
          }
        } catch (e) {
          if (part.length === 1) { this.readErrors.set(pathKey(vars[part[0].i].path), String((e as Error).message || e)); continue; }
          const m = part.length >> 1; todo.push(part.slice(m), part.slice(0, m));
        }
      }
    }
    return out;
  }

  /** read order: the dump's value (stored, or the helper's computed port copy), else through the design
   *  (resolveMissing), else no value. Never x for a value the dump does not have. */
  /** Optional quick design read: the cached answer, or null after starting the read in the background (the caller is
   *  told when it lands). Inline values use it so a first design read (Trace's model build, ~90 s on CVA6 FSDB) never
   *  holds them up. */
  resolveMissingQuick: ((path: string[], time: number) => PortValue | null) | null = null;

  async readAt(vars: SignalMeta[], time: number): Promise<DebugValue[]> { return (await this.read(vars, time, false)) as DebugValue[]; }
  /** readAt with quick design reads: null for a name still being read through the design. */
  async readAtQuick(vars: SignalMeta[], time: number): Promise<Array<DebugValue | null>> { return this.read(vars, time, true); }

  private async read(vars: SignalMeta[], time: number, quick: boolean): Promise<Array<DebugValue | null>> {
    const bits = await this.valuesAt(vars, time);
    const out: Array<DebugValue | null> = new Array(vars.length);
    for (let i = 0; i < vars.length; i++) {
      const b = bits[i];
      if (b !== undefined) { out[i] = { bits: b }; continue; }
      const said = this.readerNoValue.get(pathKey(vars[i].path));
      if (said) { this.readerNoValue.delete(pathKey(vars[i].path)); out[i] = { noValue: true, reason: 'notDumped', why: said as any, path: pathKey(vars[i].path) }; continue; }
      const failed = this.readErrors.get(pathKey(vars[i].path));
      if (failed) { out[i] = { noValue: true, reason: 'notComputable', why: 'failed', path: pathKey(vars[i].path) }; continue; }
      if (quick && this.resolveMissingQuick) {
        const q = this.resolveMissingQuick(vars[i].path, time);
        if (q === null) { out[i] = null; continue; } // (being read through the design; shown when it lands)
        out[i] = isNoValue(q) ? q : { bits: q.value, via: q.via };
        continue;
      }
      if (this.resolveMissing) { this.designReads++; }
      const r = this.resolveMissing ? await this.resolveMissing(vars[i].path, time).catch((): NoValue => ({ noValue: true, reason: 'notComputable', why: 'failed', path: pathKey(vars[i].path) }))
        : { noValue: true as const, reason: 'notDumped' as const, path: pathKey(vars[i].path) };
      out[i] = isNoValue(r) ? r : { bits: r.value, via: r.via };
    }
    return out;
  }

  /** Whether the dump has values for `v` (stored, or a computed copy the helper answers). */
  async hasDumpValues(v: SignalMeta): Promise<boolean> {
    if (this.data.windowed && this.data.hasWindowed !== false) {
      if (await this.data.windowed(v.path)) { return true; }
    }
    return !!(await this.changesOf(v.path));
  }

  /** a condition naming a signal the dump has no values for. When the design reads it (its single port /
   *  continuous-assign chain to dumped signals, Trace's resolver) the condition is evaluated through that read at each
   *  landing time, and the breakpoint says so (bp.conditionNote); otherwise it is reported ("cannot evaluate: <name> has
   *  no value (why)") and never fires. Never evaluated with x. `time`: where to check (the marker). */
  async checkConditionValues(bp: Breakpoint, time: number) {
    bp.conditionNote = null;
    if (!bp.condition || bp.conditionError) { return; }
    const parsed = X.parse(bp.condition);
    if (parsed.error) { return; }
    const scope = bp.scope || (bp.paths[0] ? bp.paths[0].slice(0, -1) : null);
    const paths: string[][] = X.names(parsed.ast);
    const vars = await this.resolveNames(paths, scope);
    const notes: string[] = [];
    for (const p of paths) {
      const v = vars.get(JSON.stringify(p));
      if (!v || await this.hasDumpValues(v)) { continue; }
      const r: PortValue = this.resolveMissing ? await this.resolveMissing(v.path, time).catch((): NoValue => ({ noValue: true, reason: 'notComputable', why: 'failed', path: pathKey(v.path) }))
        : { noValue: true, reason: 'notDumped', path: pathKey(v.path) };
      if (isNoValue(r)) { bp.conditionError = `cannot evaluate: ${pathKey(v.path)} has no value (${noValueShown(r).replace(/^no value \((.*)\)$/, "$1")})`; return; }
      notes.push(`${p.join('.')} evaluated through the design via ${r.via}`);
    }
    bp.conditionNote = notes.length ? notes.join('; ') : null;
  }

  /** An evaluator of `text` at any time, or an error. Machine names ($a0 ...) come with P4b through `extraEnv`. */
  async compile(text: string, scope: string[] | null | undefined): Promise<{ at: (time: number) => Promise<Evaluation> } | { error: string; message: string }> {
    const parsed = X.parse(text);
    if (parsed.error) { return { error: parsed.error, message: exprMessage(parsed.error, parsed.at) }; }
    const paths: string[][] = X.names(parsed.ast);
    const vars = await this.resolveNames(paths, scope);
    for (const p of paths) {
      if (!vars.has(JSON.stringify(p))) {
        // vscode-port: a bare name resolves in the session's instance only (never silently elsewhere): say so, and name
        // the nearest enclosing scope that has it
        if (scope && scope.length) {
          let near: string[] | null = null;
          for (let k = scope.length - 1; k >= 1 && !near; k--) { if (await this.data.find(scope.slice(0, k).concat(p))) { near = scope.slice(0, k).concat(p); } }
          return { error: 'unknownName', message: exprMessage('unknownName', null, p.join('.')) + `: ${p.join('.')} is not in ${scope.join('.')} (the session's instance; bare names resolve there)` + (near ? `: use the full path ${near.join('.')}` : '') };
        }
        return { error: 'unknownName', message: exprMessage('unknownName', null, p.join('.')) };
      }
    }
    const metas = [...new Set(vars.values())];
    return {
      at: async (time: number) => {
        const values = await this.readAt(metas, time);
        // a name with no value is never evaluated as x
        const none = values.findIndex((x) => isNoValue(x));
        if (none >= 0) { return { error: 'noValue', message: `cannot evaluate: ${pathKey(metas[none].path)} has no value` }; }
        const byPath = new Map<string, string>(metas.map((m, i) => [pathKey(m.path), (values[i] as { bits: string }).bits]));
        const env = (path: string[]) => {
          const v = vars.get(JSON.stringify(path));
          if (!v) { return null; }
          return { width: v.width, msb: v.msb, lsb: v.lsb, value: X.fromBits(String(byPath.get(pathKey(v.path))), v.width) };
        };
        const r = X.evaluate(parsed.ast, env);
        if (r.error) { return { error: r.error, message: exprMessage(r.error, r.at) }; }
        const value = r.value;
        return { value: X.format(value, 'hex'), width: value.w, bits: X.toBits(value), decimal: X.format(value, 'decimal'), raw: value };
      },
    };
  }

  async evaluate(text: string, scope: string[] | null | undefined, time: number): Promise<Evaluation> {
    const c = await this.compile(text, scope);
    if ('error' in c) { return c; }
    return c.at(time);
  }

  /** A condition as a test of a landing time; null without one; false when it cannot be evaluated (said once). */
  async conditionTest(bp: Breakpoint): Promise<((time: number) => Promise<boolean>) | null | false> {
    if (!bp.condition) { return null; }
    if (bp.conditionError) { return false; }
    const scope = bp.scope || (bp.paths[0] ? bp.paths[0].slice(0, -1) : null);
    const c = await this.compile(bp.condition, scope);
    if ('error' in c) { bp.conditionError = c.message; this.onWarning(`${bp.label}: ${c.message}`); return false; }
    return async (time: number) => {
      const r = await c.at(time);
      // (a design read with no value at this landing time: the condition is not true there; said once)
      if (r.error === 'noValue' && !bp.noValueWarned) { bp.noValueWarned = true; this.onWarning(`${bp.label}: ${r.message}`); }
      if (r.error) { return false; }
      return X.truthy(r.raw);
    };
  }

  /** The nearest hit of the enabled breakpoints from `from` in direction `dir`: { bp, time, index } or null. */
  /** vscode-port: the running breakpoint search (continue / reverse continue): the breakpoint and time it has
   *  reached (the status bar shows them) and whether Pause stopped it. null when no search runs. */
  search: { bp: Breakpoint | null; reached: number | null; cancelled: boolean } | null = null;
  /** e2e: each search step waits this long (a slow dump). */
  static searchDelayMs = 0;
  private searchAt(bp: Breakpoint, t: number) {
    const s = this.search;
    if (!s) { return; }
    s.bp = bp; s.reached = t;
    if (s.cancelled) { throw new SearchStopped(t); }
  }

  async findHit(from: number | null, dir: number): Promise<{ bp: Breakpoint; time: number; index: number } | null> {
    const edges = this.edges;
    if (!edges) { return null; }
    let best: { bp: Breakpoint; time: number; index: number } | null = null;
    for (const bp of this.breakpoints.filter((b) => b.enabled && !b.conditionError)) {
      const hit = await this.findHitOf(bp, from, dir);
      if (!hit) { continue; }
      const nearer = !best || (dir > 0 ? hit.index < best.index || (hit.index === best.index && hit.time < best.time)
        : hit.index > best.index || (hit.index === best.index && hit.time > best.time));
      if (nearer) { best = { bp, ...hit }; }
    }
    return best;
  }

  /** The nearest hit of one breakpoint from `from` in direction `dir` (its units: the nearest of them). */
  async findHitOf(bp: Breakpoint, from: number | null, dir: number): Promise<{ time: number; index: number } | null> {
    let best: { time: number; index: number } | null = null;
    for (const unit of bp.condition && bp.units ? bp.units : [bp]) {
      if (unit !== bp) { unit.condition = bp.condition; }
      const times = await this.hitTimes(unit);
      if (!times && !unit.win) { continue; }
      const test = await this.conditionTest(unit);
      if (test === false) { continue; }
      const hit = unit.win ? await this.windowedHit(unit, from, dir, test)
        : test ? await this.nearestTrueHit(times!, from, dir, test) : this.nearestHit(times!, from, dir);
      if (!hit) { continue; }
      if (!best || (dir > 0 ? hit.index < best.index || (hit.index === best.index && hit.time < best.time)
        : hit.index > best.index || (hit.index === best.index && hit.time > best.time))) { best = hit; }
    }
    return best;
  }

  private async nearestTrueHit(times: Float64Array, from: number | null, dir: number, test: (t: number) => Promise<boolean>) {
    const edges = this.edges!;
    const first = this.nearestHit(times, from, dir);
    if (!first) { return null; }
    let i = times.indexOf(first.time);
    const tried = new Map<number, boolean>();
    for (; i >= 0 && i < times.length; i += dir) {
      const index = landingIndex(edges, times[i]);
      if (index >= edges.length) { if (dir > 0) { return null; } continue; }
      if (!tried.has(index)) { tried.set(index, await test(edges[index])); }
      if (tried.get(index)) { return { time: times[i], index }; }
    }
    return null;
  }

  /** A line breakpoint over `paths` (capped like cmux: at most 64, taken from each instance in turn). */
  lineBreakpoint(groups: Array<{ scope: string[]; paths: string[][] }>, label: string, condition: string | null, origin: any): Omit<Breakpoint, 'id'> {
    const lists = groups.map((g) => g.paths);
    const capped: string[][][] = lists.map(() => []);
    let left = MAX_LINE_PATHS;
    for (let k = 0; left > 0 && lists.some((l) => l.length > k); k++) {
      lists.forEach((l, i) => { if (left > 0 && k < l.length) { capped[i].push(l[k]); left--; } });
    }
    const units = groups.length > 1 ? groups.map((g, i) => ({ id: 0, kind: 'line', paths: capped[i], enabled: true, label, scope: g.scope } as Breakpoint)) : undefined;
    return { kind: 'line', paths: capped.flat(), enabled: true, label, condition, scope: groups[0]?.scope || null, units, origin };
  }
}

/** vscode-port: Pause stopped a breakpoint search at `reached`. */
export class SearchStopped extends Error {
  constructor(readonly reached: number) { super('search stopped'); }
}

/** vscode-port a NoValue as text: the reader's own words when it gave them (no change recorded up to t). */
export function noValueShown(d: NoValue): string {
  return typeof d.why === 'string' && (d.why as string).startsWith('no value') ? d.why as string : noValueText(d);
}
