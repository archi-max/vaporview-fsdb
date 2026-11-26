// vscode-port P4: the waveform debugger's read access to a dump, behind a small interface (the seam). At run time it is
// the shared data API (src/cmux/data.ts: waveformData(document)), so every format the viewer opens works (VCD, FST, GHW,
// and FSDB/WCZ through wisp-helper when that backend implements it). cmux's debugger read the same things through
// host.signalChanges/getChildren (Resources/vaporview/cmux-debugger.js).
//
// Paths are dump paths as segment arrays (['top', 'cpu', 'pc']); values are bit strings, most significant bit first,
// one character per bit ('0' '1' 'x' 'z'), possibly shorter than the width (VCD drops leading zeros; see valueBits).
import type { WaveformData, DataItem } from '../data';
import { documentHelper, helperQueries, history, type WindowedQueries, type QueryVar } from './wisp-query';

export type SignalMeta = { path: string[]; name: string; width: number; msb?: number; lsb?: number; kind: 'var' };
export type ScopeMeta = { path: string[]; name: string; kind: 'scope' };
/** A signal's changes, ascending by time (the first is its initial value). */
export type Series = { times: ArrayLike<number>; values: string[] };

export interface WaveData {
  /** Bumps when the dump reloads; cached series from an older generation are stale. */
  readonly generation: number;
  /** e.g. 1 and 'ns' for `$timescale 1ns`. */
  readonly timeScale: number;
  readonly timeUnit: string;
  topScopes(): Promise<ScopeMeta[]>;
  /** Direct children of a scope (vars and scopes). */
  children(scope: string[]): Promise<Array<SignalMeta | ScopeMeta>>;
  /** A var by its full path; undefined when the dump has none. */
  find(path: string[]): Promise<SignalMeta | undefined>;
  changes(path: string[]): Promise<Series | undefined>;
  /** Every scope path (for module/instance matching), walked once. */
  allScopes(): Promise<string[][]>;
  /** FSDB/WCZ (wisp-helper): the windowed queries for a var, so the debugger never reads its whole history; absent or
   *  null for other dumps (then `changes`). */
  windowed?(path: string[]): Promise<{ q: WindowedQueries; v: QueryVar } | null>;
  /** False when `windowed` can never answer (not a wisp document): callers skip it. */
  readonly hasWindowed?: boolean;
}

export const pathKey = (p: string[]) => p.join('.');

// A value as one character per bit, `width` bits: extended by its top bit when that is x or z, else by 0 (cmux valueBits).
export function valueBits(value: string, width: number): string {
  const s = String(value).toLowerCase();
  if (s.length === width) { return s; }
  if (s.length > width) { return s.slice(s.length - width); }
  const pad = s[0] === 'x' || s[0] === 'z' ? s[0] : '0';
  return pad.repeat(width - s.length) + s;
}

/** Index of the last change at or before `time`; -1 before the first. */
export function indexIn(times: ArrayLike<number>, time: number): number {
  let lo = 0, hi = times.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return at;
}

// The value of `s` at `time` (the last change at or before it); undefined before the first.
export function valueIn(s: Series, time: number): string | undefined {
  const at = indexIn(s.times, time);
  return at >= 0 ? s.values[at] : undefined;
}

const toVar = (d: DataItem): SignalMeta => ({ kind: 'var', name: d.name, path: d.scopePath.concat(d.name), width: d.width > 0 ? d.width : 1, msb: d.msb, lsb: d.lsb });
const toMeta = (d: DataItem): SignalMeta | ScopeMeta => (d.kind === 'scope' ? { kind: 'scope', name: d.name, path: d.scopePath.concat(d.name) } : toVar(d));

/** The shared data API (src/cmux/data.ts) as the debugger's WaveData. */
export class DocumentWaveData implements WaveData {
  private scopes: Promise<string[][]> | null = null;
  private scopesGen = -1;
  private queries: WindowedQueries | null = null;
  private queriesGen = -1;
  /** What the debugger read (the e2e checks: FSDB/WCZ read only the clock whole). */
  readonly stats = { wholeReads: [] as string[], windowedRequests: () => (this.queries ? this.queries.stats.requests : 0) };
  constructor(private readonly data: WaveformData) {}

  get hasWindowed(): boolean { return !!documentHelper((this.data as any).document?.handler); }

  private noteWhole(path: string[]) {
    this.stats.wholeReads.push(pathKey(path));
    if (this.stats.wholeReads.length > 200) { this.stats.wholeReads.shift(); }
  }

  async windowed(path: string[]): Promise<{ q: WindowedQueries; v: QueryVar } | null> {
    // The open document's wisp-helper (src/cmux/wisp/wisp_handler.ts keeps it as `helper`), when it has one.
    const request = documentHelper((this.data as any).document?.handler);
    if (!request) { return null; }
    if (!this.queries || this.queriesGen !== this.generation) {
      this.queries = helperQueries(request, Number(this.data.metadata.timeEnd) || 0);
      this.queriesGen = this.generation;
    }
    const d = await this.data.findItem(path, true);
    if (!d || d.kind !== 'var' || !(Number(d.signalId) >= 0) || d.encoding === 'Real' || d.encoding === 'String') { return null; }
    return { q: this.queries, v: { signalId: Number(d.signalId), width: d.width > 0 ? d.width : 1 } };
  }
  get generation() { return this.data.generation; }
  get timeScale() { return Number(this.data.metadata.timeScale) || 1; }
  get timeUnit() { return String(this.data.metadata.timeUnit || 's'); }

  async topScopes(): Promise<ScopeMeta[]> {
    return (await this.data.children()).filter((d) => d.kind === 'scope').map((d) => toMeta(d) as ScopeMeta);
  }

  async children(scope: string[]): Promise<Array<SignalMeta | ScopeMeta>> {
    return (await this.data.children(scope)).map(toMeta);
  }

  async find(path: string[]): Promise<SignalMeta | undefined> {
    const d = await this.data.findItem(path, true);
    return d ? toVar(d) : undefined;
  }

  async changes(path: string[]): Promise<Series | undefined> {
    // FSDB/WCZ: through the helper's exact windows (the document's data API would capture it through the viewer).
    const w = await this.windowed(path);
    if (w) { this.noteWhole(path); return history(w.q, w.v); }
    // A var the helper declares without values (signalId null: e.g. a port copy not linked yet): it has no changes.
    // Never the viewer capture for a wisp document (a whole read, and it cannot decode wisp's chunks).
    if (documentHelper((this.data as any).document?.handler)) { return undefined; }
    this.noteWhole(path);
    try {
      const c = await this.data.signalChanges(path);
      return c || undefined;
    } catch (e: any) {
      if (e && e.code === 'notFound') { return undefined; }
      throw e;
    }
  }

  allScopes(): Promise<string[][]> {
    if (!this.scopes || this.scopesGen !== this.generation) {
      this.scopesGen = this.generation;
      this.scopes = (async () => {
        // Depth-first, in dump order, with an explicit stack (no recursion: hierarchy depth is unbounded).
        const out: string[][] = [];
        const stack: ScopeMeta[] = (await this.topScopes()).slice().reverse();
        while (stack.length) {
          const s = stack.pop()!;
          out.push(s.path);
          const kids = (await this.children(s.path)).filter((c): c is ScopeMeta => c.kind === 'scope');
          for (let i = kids.length - 1; i >= 0; i--) { stack.push(kids[i]); }
        }
        return out;
      })();
    }
    return this.scopes;
  }
}
