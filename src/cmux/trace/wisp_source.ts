// vscode-port: the dump source tracing reads on an FSDB or WCZ document (wisp-helper). Values, edges,
// counts and x runs come from the helper's windowed queries (helper_v2.ts through dump.ts), so no whole signal
// history is read: `changes` answers null and the dump provider asks the helper instead.
// Registered for the document by the viewer provider when a wisp-helper document loads (setTraceDumpSource).
// Every query goes through the handler's query() (wisp_handler.ts): replies are checked like the viewer's, a reply
// that arrives after a reload or close is dropped ('reloaded'), and cancel() stops the reads in flight ('cancelled').
// SPDX-License-Identifier: GPL-3.0-or-later
import type { TraceDumpSource, TraceVar, Change } from './dump';
import type { V2Var } from './helper_v2';
import * as zlib from 'zlib';

/** What tracing needs from the wisp-helper document handler (src/cmux/wisp/wisp_handler.ts). */
export interface WispTraceHandler {
  readonly source: string;
  readonly dumpStart: number;
  /** The dump's last time (the whole-history reference reads [0, dumpEnd]). */
  readonly dumpEnd?: number;
  query(req: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{ result?: any; bin?: Buffer | null; verified?: boolean; error?: string; code?: string }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  findTreeItemFn(scopePath: string, msb: number | undefined, lsb: number | undefined): Promise<{ signalId: number; width: number; contextValue?: string } | null>;
  /** (outsideWrites none) a port copy the helper computes, not a stored signal: read the same way, labelled. */
  isComputedId?(signalId: number): boolean;
}

/** Helper queries tracing sent, per document (vaporview.e2e.traceState: no whole-history read).
 *  wholeWindows: windows asking more buckets than one bounded page (helper_v2.ts reads x runs and vector edges in
 *  pages of at most PAGE_CHANGES changes, PAGE_CHANGES / 2 buckets); pageWindows: the bounded ones. */
export interface WispTraceStats { queries: number; byCmd: Record<string, number>; pageWindows: number; maxBuckets: number; wholeWindows: number; wholeReads: number;
  cancelled: number; reloaded: number; unverified: number;
  /** The last queries (up to 512): [cmd, t, signals, ms, in flight when sent] (diagnostics: batching, slow kinds). */
  log: [string, number, number, number, number][] }
const PAGE_BUCKETS = 32768; // helper_v2.ts PAGE_CHANGES (65536) / 2

export class WispTraceSource implements TraceDumpSource {
  readonly stats: WispTraceStats = { queries: 0, byCmd: {}, pageWindows: 0, maxBuckets: 0, wholeWindows: 0, wholeReads: 0, cancelled: 0, reloaded: 0, unverified: 0, log: [] };
  private inFlight = 0;
  private abort = new AbortController();
  /** (e2e only: vaporview.e2e.traceQueryDelay, so a trace runs long enough to cancel or reload it midway) */
  static delayMs = 0;
  constructor(private readonly handler: WispTraceHandler) {}
  get unverified() { return this.stats.unverified; }
  /** Runs (or waits for) the helper's whole-file check: true when it passed, false when it failed, null when not
   *  answered (helper gone, file reloaded). Asked only after Trace has gone quiet (it competes with reads). */
  async verifyFile(): Promise<boolean | null> {
    const r = await this.handler.query({ cmd: 'verify' }).catch(() => ({ error: 'failed' } as { error: string; result?: undefined }));
    if (r.error !== undefined || !r.result) { return r.error !== undefined && /refused|damaged/i.test(String(r.error)) ? false : null; }
    return r.result.ok === true ? true : r.result.ok === false ? false : null;
  }
  get reloads() { return this.stats.reloaded; }
  cancel() { this.abort.abort(); this.abort = new AbortController(); }
  private dataGen: (() => number) | null = null;
  private gen0 = 0;
  /** The document's data generation for the trace session starting now: once the file is reloaded (the viewer's
   *  data generation moves), every later read answers 'reloaded', so a chain running over the reload stops. */
  bindGeneration(gen: () => number) { this.dataGen = gen; this.gen0 = gen(); }
  private whole: WispWholeHistorySource | null = null;
  /** (e2e only) The same file read as whole signal histories, for an engine-vs-engine check of the windowed reads. */
  wholeHistory() { return this.whole || (this.whole = new WispWholeHistorySource(this.handler)); }
  get kind() { return this.handler.source || 'wcz'; }
  start() { return this.handler.dumpStart; }
  async findVar(dumpPath: string): Promise<V2Var | null> {
    let item = await this.handler.findTreeItemFn(dumpPath, undefined, undefined).catch(() => null);
    // A row keeps a range as wide as its signal on some dumps (x[7:0]): the name without it.
    if (!item) {
      const m = /^(.*)\[(\d+):(\d+)\]$/.exec(dumpPath);
      if (m) { item = await this.handler.findTreeItemFn(m[1], undefined, undefined).catch(() => null); }
    }
    // (a declared variable without values has signalId -1: not readable)
    if (!item || item.contextValue !== 'netlistVar' || !(item.signalId >= 0)) { return null; }
    if (this.handler.isComputedId && this.handler.isComputedId(item.signalId)) { this.computedPaths.add(dumpPath); }
    return { key: String(item.signalId), signalId: item.signalId, width: Number(item.width) || 1 };
  }
  /** Dump paths read so far that are the helper's computed port copies (the step labels them). */
  readonly computedPaths = new Set<string>();
  async changes(_v: TraceVar, _max: number): Promise<Change[] | null> {
    this.stats.wholeReads++;
    return null;
  }
  async v2(req: Record<string, unknown>) {
    const cmd = String(req.cmd);
    this.stats.queries++;
    this.stats.byCmd[cmd] = (this.stats.byCmd[cmd] || 0) + 1;
    if (cmd === 'window') {
      const b = Number(req.buckets) || 0;
      this.stats.maxBuckets = Math.max(this.stats.maxBuckets, b);
      if (b > PAGE_BUCKETS) { this.stats.wholeWindows++; } else if (b > 1) { this.stats.pageWindows++; }
    }
    if (this.dataGen && this.dataGen() !== this.gen0) { this.stats.reloaded++; return { error: 'the file was reloaded', code: 'reloaded' }; }
    const signal = this.abort.signal;
    if (WispTraceSource.delayMs > 0) { await new Promise((r) => setTimeout(r, WispTraceSource.delayMs)); }
    const t0 = Date.now(), busy = this.inFlight++;
    const r = await this.handler.query(req, { signal }).finally(() => { this.inFlight--; });
    if (r.error === undefined && this.dataGen && this.dataGen() !== this.gen0) { this.stats.reloaded++; return { error: 'the file was reloaded', code: 'reloaded' }; }
    if (this.stats.log.length >= 512) { this.stats.log.shift(); }
    this.stats.log.push([cmd, Number(req.t ?? req.t0 ?? -1), Array.isArray(req.signalIds) ? req.signalIds.length : Array.isArray(req.signals) ? req.signals.length : 1, Date.now() - t0, busy]);
    if (r.error !== undefined) {
      if (r.code === 'cancelled') { this.stats.cancelled++; } else if (r.code === 'reloaded') { this.stats.reloaded++; }
      return { error: r.error, code: r.code };
    }
    if (r.verified === false) { this.stats.unverified++; }
    const result = r.result || {};
    return r.bin ? Object.assign(result, { bin: r.bin }) : result;
  }
}

/** (e2e reference only: vaporview.e2e.traceWholeHistory) The same FSDB / WCZ file through the same helper, but read as
 *  whole signal histories (`changes`, one window over the whole dump per signal) and no windowed queries (no v2), as
 *  tracing reads a VCD. A Trace on it and on WispTraceSource over the same file must give the same chain. */
export class WispWholeHistorySource implements TraceDumpSource {
  readonly stats = { queries: 0, wholeReads: 0 };
  constructor(private readonly handler: WispTraceHandler) {}
  get kind() { return (this.handler.source || 'wcz') + '-whole'; }
  start() { return this.handler.dumpStart; }
  // (the same lookup as the windowed source, computed port copies recorded the same way)
  readonly computedPaths = new Set<string>();
  findVar(dumpPath: string) { return WispTraceSource.prototype.findVar.call(this as unknown as WispTraceSource, dumpPath); }
  async changes(v: TraceVar, maxChanges: number): Promise<Change[] | null> {
    const sv = v as unknown as V2Var;
    if (!(sv.signalId >= 0)) { return null; }
    this.stats.queries++; this.stats.wholeReads++;
    const t1 = Math.max(1, Number(this.handler.dumpEnd) || 0) + 1;
    const r = await this.handler.query({ cmd: 'window', signals: [{ signalId: sv.signalId, width: sv.width }], t0: 0, t1, buckets: 4194304 });
    const h = r.result && r.result.signals && r.result.signals[0];
    if (r.error !== undefined || !h || h.error || !h.exact || !r.bin) { return null; }
    const raw = zlib.inflateRawSync(r.bin.subarray(0, Number(h.bytes) || 0));
    const out: Change[] = [];
    let t = 0;
    if (h.text) {
      for (let o = 0; o + 12 <= raw.length;) { t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296; const n = raw.readUInt32LE(o + 8); out.push([t, raw.toString('utf8', o + 12, o + 12 + n)]); o += 12 + n; }
    } else {
      const rec = 8 + sv.width;
      for (let o = 0; o + rec <= raw.length; o += rec) { t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296; out.push([t, raw.toString('latin1', o + 8, o + rec).toLowerCase()]); }
    }
    return out.length > maxChanges ? null : out;
  }
}
