// vscode-port: the extension-side waveform data API for the cmux features (bridge, debugger, FSM, trace).
// GPL-3.0 (VaporView and cmux). The LZ4 frame reader and record decoder are ported from cmux's
// Resources/vaporview/wellen-worker.js (written for cmux from the LZ4 format docs).
//
// STABLE API (other modules build on it; add, don't change):
//
//   import { waveformData } from '../cmux/data';
//   const data = waveformData(document);            // one per VaporviewDocument, cached
//
//   data.generation                       bumps on every reload; results from an older one are stale
//   data.metadata                         { timeEnd, timeScale, timeUnit, ... } (WaveformDumpMetadata)
//   data.children(scope?)                 Promise<DataItem[]>   scope: path | DataItem; none = top level
//   data.findItem(path, varOnly = true)   Promise<DataItem | null>
//   data.item(netlistId)                  DataItem | null       (only items some call has loaded)
//   data.signalChanges(ref, maxChanges?)  Promise<SignalChanges | null>   null: more than maxChanges
//   data.posedges(ref, maxEdges?)         Promise<Float64Array | null>     rising-edge times of a 1-bit signal
//                                                                          (to '1' from anything else; not the first value)
//   data.valueAt(ref, time)               Promise<string | null>  the bits in effect at `time` ('' before the first change: null)
//   data.valuesAt(refs, time)             Promise<(string | null)[]>
//
//   path:   string[] of dump segments (['top', 'cpu', 'pc']) or a dotted string ('top.cpu.pc').
//   ref:    a path, a DataItem, or { netlistId }.
//   times:  Float64Array in the dump's time units (as VaporView's netlist uses), ascending.
//   values: string per change, as the dump has it: 4-state bits MSB first ('01xz'), a real as its text, a string.
//   A ref that names no variable rejects with DataError (code 'notFound').
//
// Backends: a parser (WaveformFileParser) may implement the optional
//   getSignalChanges(signalId: number, maxChanges: number): Promise<SignalChanges | null>
// FSDB / WCZ (the wisp-helper handler) are read with its windowed query() (an exact window over the dump's span).
// Otherwise changes are read through the parser's getSignalData, whose value-change chunks are captured here
// instead of reaching the webview (wellen: VCD, FST, GHW).
import * as zlib from 'zlib';
import { decodeBitRecords, decodeTextRecords } from './wisp/wisp_handler';
import type { VaporviewDocument, WaveformFileParser } from '../extension_core/document';
import type { NetlistItem } from '../extension_core/tree_view';
import type { WaveformDumpMetadata } from '../common/types';

export type DataPath = string[] | string;

export interface DataItem {
  kind: 'scope' | 'var';
  name: string;
  scopePath: string[];
  netlistId: number;
  signalId: number;
  width: number;
  type: string;
  encoding: string;
  msb: number;
  lsb: number;
  enumType: string;
}

export interface SignalChanges {
  times: Float64Array;
  values: string[];
}

export type SignalRef = DataPath | DataItem | { netlistId: number };

export class DataError extends Error {
  constructor(public readonly code: 'notFound' | 'closed' | 'tooMany', message: string) { super(message); }
}

/** Optional parser extension (see the header). */
export interface ChangesParser {
  getSignalChanges?(signalId: number, maxChanges: number): Promise<SignalChanges | null>;
}

// 20 s under the e2e suite (VAPORVIEW_E2E=1) so a stall fails its test quickly.
const CAPTURE_TIMEOUT_MS = process.env.VAPORVIEW_E2E === '1' ? 20_000 : 120_000;
const MAX_CACHE_CHANGES = 4_000_000; // values kept in the per-document change cache (sum over signals)

export function segmentsOf(path: DataPath): string[] {
  if (Array.isArray(path)) { return path.map(String); }
  return path ? String(path).split('.') : [];
}

// An escaped identifier as dumps spell it ("\a.b ") compares equal to its plain name.
const plainName = (name: string) => (name.startsWith('\\') ? name.slice(1).trimEnd() : name);

export function toDataItem(n: NetlistItem): DataItem {
  return {
    kind: n.contextValue === 'netlistScope' ? 'scope' : 'var',
    name: n.name, scopePath: n.scopePath.slice(), netlistId: n.netlistId, signalId: n.signalId, width: n.width,
    type: n.type, encoding: String(n.encoding), msb: n.msb, lsb: n.lsb, enumType: n.enumType || '',
  };
}

const registry = new WeakMap<VaporviewDocument, WaveformData>();

export function waveformData(document: VaporviewDocument): WaveformData {
  let d = registry.get(document);
  if (!d) { d = new WaveformData(document); registry.set(document, d); }
  return d;
}

export class WaveformData {
  private _generation = 0;
  private cache = new Map<number, { gen: number; max: number; changes: SignalChanges | null }>();
  private cachedValues = 0;
  private capture: ChunkCapture | null = null;

  constructor(public readonly document: VaporviewDocument) {}

  /** Bumped by the bridge (or anyone) when the document reloads; clears caches. */
  public reloaded() { this._generation++; this.cache.clear(); this.cachedValues = 0; }
  public get generation() { return this._generation; }
  public get metadata(): WaveformDumpMetadata { return this.document.metadata; }
  private get parser(): WaveformFileParser { return this.document.handler; }

  // ---- hierarchy ----

  public async children(scope?: DataPath | DataItem): Promise<DataItem[]> {
    if (scope === undefined || (Array.isArray(scope) && scope.length === 0) || scope === '') {
      return this.document.treeData.map(toDataItem);
    }
    const node = await this.node(isItem(scope) ? scope.scopePath.concat([scope.name]) : segmentsOf(scope as DataPath), false);
    if (!node) { return []; }
    const kids = node.children.length ? node.children : await this.document.getScopeChildren(node);
    return kids.map(toDataItem);
  }

  public async findItem(path: DataPath, varOnly = true): Promise<DataItem | null> {
    const n = await this.node(segmentsOf(path), varOnly);
    return n ? toDataItem(n) : null;
  }

  public item(netlistId: number): DataItem | null {
    const n = this.document.netlistIdTable[netlistId];
    return n ? toDataItem(n) : null;
  }

  /** The NetlistItem at `parts`; an exact name beats an escaped spelling of it. */
  public async node(parts: string[], varOnly: boolean): Promise<NetlistItem | null> {
    if (!parts.length) { return null; }
    let items: NetlistItem[] = this.document.treeData;
    let found: NetlistItem | null = null;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const want = parts[i];
      let named = items.filter((x) => x.name === want);
      if (!named.length) { named = items.filter((x) => plainName(x.name) === plainName(want)); }
      if (!last) { named = named.filter((x) => x.contextValue === 'netlistScope'); }
      else if (varOnly) { named = named.filter((x) => x.contextValue !== 'netlistScope'); }
      found = named[0] || null;
      if (!found) { return null; }
      if (!last) { items = found.children.length ? found.children : await this.document.getScopeChildren(found); }
    }
    return found;
  }

  private async resolve(ref: SignalRef): Promise<NetlistItem> {
    let n: NetlistItem | null | undefined = null;
    if (typeof ref === 'object' && !Array.isArray(ref) && 'netlistId' in ref && !('kind' in ref)) {
      n = this.document.netlistIdTable[ref.netlistId];
    } else if (isItem(ref)) {
      n = this.document.netlistIdTable[ref.netlistId] || await this.node(ref.scopePath.concat([ref.name]), true);
    } else {
      n = await this.node(segmentsOf(ref as DataPath), true);
    }
    if (!n || n.contextValue === 'netlistScope') { throw new DataError('notFound', 'no variable ' + JSON.stringify(ref)); }
    return n;
  }

  // ---- values ----

  public async signalChanges(ref: SignalRef, maxChanges = Infinity): Promise<SignalChanges | null> {
    const n = await this.resolve(ref);
    const gen = this._generation;
    const hit = this.cache.get(n.signalId);
    if (hit && hit.gen === gen && (hit.changes ? true : maxChanges >= hit.max)) {
      if (!hit.changes) { return null; }
      return hit.changes.times.length > maxChanges ? null : hit.changes;
    }
    const custom = (this.parser as unknown as ChangesParser).getSignalChanges;
    const query = (this.parser as unknown as WindowQueryParser).query;
    let result: SignalChanges | null;
    if (typeof custom === 'function') {
      result = await custom.call(this.parser, n.signalId, maxChanges);
    } else if (typeof query === 'function') {
      result = await this.windowChanges(query.bind(this.parser), n.signalId, n.width, maxChanges);
    } else {
      result = await this.captureChanges(n.signalId, n.width);
      if (result && result.times.length > maxChanges) { result = null; }
    }
    if (gen !== this._generation) { throw new DataError('closed', 'the document reloaded'); }
    if (result && result.times.length <= MAX_CACHE_CHANGES) {
      if (this.cachedValues + result.times.length > MAX_CACHE_CHANGES) { this.cache.clear(); this.cachedValues = 0; }
      this.cachedValues += result.times.length;
      this.cache.set(n.signalId, { gen, max: maxChanges, changes: result });
    } else if (!result) {
      this.cache.set(n.signalId, { gen, max: maxChanges, changes: null });
    }
    return result;
  }

  public async posedges(ref: SignalRef, maxEdges = Infinity): Promise<Float64Array | null> {
    const c = await this.signalChanges(ref);
    if (!c) { return null; }
    let out = new Float64Array(Math.min(c.times.length, 1024));
    let n = 0;
    let previous: string | null = null;
    for (let i = 0; i < c.times.length; i++) {
      const v = c.values[i];
      if (v === '1' && previous !== null && previous !== '1') {
        if (n >= maxEdges) { return null; }
        if (n === out.length) { const g = new Float64Array(out.length * 2); g.set(out); out = g; }
        out[n++] = c.times[i];
      }
      previous = v;
    }
    return out.slice(0, n);
  }

  public async valueAt(ref: SignalRef, time: number): Promise<string | null> {
    const c = await this.signalChanges(ref);
    if (!c) { return null; }
    const i = indexAt(c.times, time);
    return i < 0 ? null : c.values[i];
  }

  public async valuesAt(refs: SignalRef[], time: number): Promise<(string | null)[]> {
    const out: (string | null)[] = [];
    for (const r of refs) {
      try { out.push(await this.valueAt(r, time)); } catch (e) { if (e instanceof DataError && e.code === 'notFound') { out.push(null); } else { throw e; } }
    }
    return out;
  }

  // ---- capture of the parser's value-change chunks (wellen) ----

  private installTap() {
    const parser = this.parser as unknown as Record<string, unknown>;
    if ((parser as { __cmuxTapped?: boolean }).__cmuxTapped) { return; }
    let inner = parser.postMessageToWebview as (m: Record<string, unknown>) => void;
    const self = this;
    const wrapper = (m: Record<string, unknown>) => {
      if (self.capture && self.capture.take(m)) { return; }
      inner(m);
    };
    // document.onWebviewReady assigns the panel's postMessage to the parser: keep our wrapper in front of it.
    Object.defineProperty(parser, 'postMessageToWebview', {
      configurable: true, get: () => wrapper, set: (f) => { inner = f; },
    });
    Object.defineProperty(parser, '__cmuxTapped', { value: true });
  }

  // FSDB / WCZ (wisp-helper): one exact window query over the dump's span through the handler's query() (the
  // product reads FSDB/WCZ through windowed queries; no whole-history side channel). The helper answers exactly up to
  // 2 x buckets changes; more is null when the caller set a limit, and DataError 'tooMany' otherwise: never a summary.
  private async windowChanges(query: WindowQueryParser['query'], signalId: number, width: number, maxChanges: number): Promise<SignalChanges | null> {
    const buckets = Number.isFinite(maxChanges) ? Math.min(WINDOW_BUCKETS, Math.max(1, Math.ceil(maxChanges / 2) + 1)) : WINDOW_BUCKETS;
    const t1 = Math.max(1, Number(this.document.metadata.timeEnd) + 1);
    const r = await query({ cmd: 'window', signals: [{ signalId, width }], t0: 0, t1, buckets });
    if (r.code === 'reloaded') { throw new DataError('closed', 'the document reloaded'); }
    const h = r.result && r.result.signals && r.result.signals[0];
    if (r.error || !h || h.error) { throw new Error('signal data: ' + (r.error || (h && h.error) || 'no reply')); }
    if (!h.exact) {
      if (Number.isFinite(maxChanges)) { return null; }
      throw new DataError('tooMany', `more changes than one exact window holds (${2 * WINDOW_BUCKETS})`);
    }
    if (Number(h.total) > maxChanges) { return null; }
    const raw = r.bin ? zlib.inflateRawSync(r.bin.subarray(0, Number(h.bytes) || 0)) : Buffer.alloc(0);
    const recs = h.text ? decodeTextRecords(raw) : decodeBitRecords(raw, width);
    if (recs.length > maxChanges) { return null; }
    const times = new Float64Array(recs.length), values: string[] = new Array(recs.length);
    recs.forEach(([t, v], i) => { times[i] = t; values[i] = v; });
    return { times, values };
  }

  // One capture at a time (wellen answers getsignaldata calls in order). A complete chunk set for the signal
  // while a capture waits is the capture's, even if the viewer asked for it: then the capture's own set, which
  // follows, reaches the viewer instead, so the viewer still gets exactly one.
  private captureQueue: Promise<unknown> = Promise.resolve();
  private captureChanges(signalId: number, width: number): Promise<SignalChanges> {
    this.installTap();
    const run = async () => {
      const cap = new ChunkCapture(signalId, width);
      this.capture = cap;
      try {
        await this.parser.getSignalData([signalId]);
        return await withTimeout(cap.done, CAPTURE_TIMEOUT_MS, 'signal data');
      } finally { this.capture = null; }
    };
    const p = this.captureQueue.then(run, run);
    this.captureQueue = p.catch(() => undefined);
    return p;
  }
}

/** The wisp-helper handler's checked query (src/cmux/wisp/wisp_handler.ts query(), never throws). */
interface WindowQueryParser {
  query(req: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{ result?: any; bin?: Buffer | null; error?: string; code?: string }>;
}
const WINDOW_BUCKETS = 4194304; // the helper's bucket cap (wisp_handler WHOLE_BUCKETS): exact up to 2x this many changes

function isItem(x: unknown): x is DataItem {
  return !!x && typeof x === 'object' && !Array.isArray(x) && 'kind' in (x as object) && 'scopePath' in (x as object);
}

/** Index of the last change at or before `time`, or -1. */
export function indexAt(times: Float64Array, time: number): number {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout reading ' + what)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

class ChunkCapture {
  private json: string[] = [];
  private lz4: Uint8Array[] = [];
  private got = 0;
  private total = -1;
  private size = 0;
  private resolve!: (c: SignalChanges) => void;
  private reject!: (e: unknown) => void;
  public done: Promise<SignalChanges>;
  constructor(private signalId: number, private width: number) {
    this.done = new Promise((res, rej) => { this.resolve = res; this.reject = rej; });
  }
  take(m: Record<string, unknown>): boolean {
    if (m.signalId !== this.signalId) { return false; }
    if (m.command === 'update-waveform-chunk') {
      this.total = Number(m.totalChunks);
      this.json[Number(m.chunkNum)] = String(m.transitionDataChunk);
    } else if (m.command === 'update-waveform-chunk-compressed') {
      this.total = Number(m.totalChunks);
      this.size = Number(m.originalSize);
      if (m.signalWidth) { this.width = Number(m.signalWidth); }
      const raw = m.compressedDataChunk as ArrayLike<number>;
      this.lz4[Number(m.chunkNum)] = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
    } else { return false; }
    this.got++;
    if (this.got >= this.total) {
      try { this.resolve(this.decode()); } catch (e) { this.reject(e); }
    }
    return true;
  }
  private decode(): SignalChanges {
    if (this.lz4.length) {
      return decodeRecords(lz4Frame(concat(this.lz4), this.size), this.width);
    }
    const pairs = JSON.parse(this.json.join('')) as [number, unknown][];
    const times = new Float64Array(pairs.length);
    const values = new Array<string>(pairs.length);
    pairs.forEach(([t, v], i) => { times[i] = Number(t); values[i] = String(v); });
    return { times, values };
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// The LZ4 frame wellen packs big signals in (lz4_flex FrameEncoder); checksums are not verified.
export function lz4Frame(src: Uint8Array, sizeHint: number): Uint8Array {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (src.length < 7 || view.getUint32(0, true) !== 0x184D2204) { throw new Error('not an LZ4 frame'); }
  const flags = src[4];
  let at = 6 + ((flags & 0x08) ? 8 : 0) + ((flags & 0x01) ? 4 : 0) + 1;
  const blockChecksum = (flags & 0x10) !== 0;
  let out = new Uint8Array(Math.max(sizeHint || 0, 1024));
  let n = 0;
  const room = (extra: number) => {
    if (n + extra <= out.length) { return; }
    const grown = new Uint8Array(Math.max(out.length * 2, n + extra));
    grown.set(out.subarray(0, n));
    out = grown;
  };
  for (;;) {
    if (at + 4 > src.length) { throw new Error('truncated LZ4 frame'); }
    const word = view.getUint32(at, true);
    at += 4;
    if (word === 0) { break; }
    const size = word & 0x7fffffff;
    const end = at + size;
    if (end > src.length) { throw new Error('truncated LZ4 block'); }
    if (word & 0x80000000) {
      room(size); out.set(src.subarray(at, end), n); n += size;
    } else {
      let i = at;
      while (i < end) {
        const token = src[i++];
        let literals = token >> 4;
        if (literals === 15) { let b; do { b = src[i++]; literals += b; } while (b === 255); }
        room(literals); out.set(src.subarray(i, i + literals), n); n += literals; i += literals;
        if (i >= end) { break; }
        const offset = src[i] | (src[i + 1] << 8);
        i += 2;
        let length = token & 15;
        if (length === 15) { let b; do { b = src[i++]; length += b; } while (b === 255); }
        length += 4;
        if (offset === 0 || offset > n) { throw new Error('bad LZ4 match offset'); }
        room(length);
        for (let k = 0, from = n - offset; k < length; k++) { out[n++] = out[from + k]; }
      }
    }
    at = end + (blockChecksum ? 4 : 0);
  }
  return out.subarray(0, n);
}

// [u64 LE delta time][width value chars] records.
export function decodeRecords(raw: Uint8Array, width: number): SignalChanges {
  const rec = 8 + width;
  const count = Math.floor(raw.length / rec);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const td = new TextDecoder();
  const times = new Float64Array(count);
  const values = new Array<string>(count);
  let time = 0;
  for (let k = 0, i = 0; k < count; k++, i += rec) {
    time += view.getUint32(i, true) + view.getUint32(i + 4, true) * 4294967296;
    times[k] = time;
    values[k] = td.decode(raw.subarray(i + 8, i + rec));
  }
  return { times, values };
}
