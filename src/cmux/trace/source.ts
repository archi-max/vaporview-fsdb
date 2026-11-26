// vscode-port: the dump driver tracing reads for an open waveform document.
// - Default: src/cmux/data.ts (waveform data API: VaporView's own reader, wellen for VCD/FST/GHW, or a
//   parser's getSignalChanges), whole histories per signal, as cmux's local path reads them.
// - A backend that serves tracing its own way (FSDB/WCZ through wisp-helper: the windowed queries of helper_v2.ts)
//   registers a TraceDumpSource with setTraceDumpSource(document, source); it is used as it is.
import type { VaporviewDocument } from '../../extension_core/document';
import { waveformData, DataError } from '../data';
import type { TraceDumpSource, TraceVar, Change } from './dump';

const own = new WeakMap<VaporviewDocument, TraceDumpSource>();
/** A backend's own dump source for `document` (wisp-helper's windowed queries), or null to clear it. */
export function setTraceDumpSource(document: VaporviewDocument, source: TraceDumpSource | null) {
  if (source) { own.set(document, source); } else { own.delete(document); }
}

export class DocumentDumpSource implements TraceDumpSource {
  readonly kind: string;
  constructor(private readonly document: VaporviewDocument) {
    this.kind = document.uri.path.split('.').pop() || 'dump';
  }
  start() { return 0; }
  async findVar(dumpPath: string): Promise<TraceVar | null> {
    const data = waveformData(this.document);
    let item = await data.findItem(dumpPath, true).catch(() => null);
    // A row keeps a range as wide as its signal on some dumps (x[7:0]): the name without it.
    if (!item) {
      const m = /^(.*)\[(\d+):(\d+)\]$/.exec(dumpPath);
      if (m) { item = await data.findItem(m[1], true).catch(() => null); }
    }
    if (!item || item.kind !== 'var') { return null; }
    return { key: String(item.netlistId), width: Number(item.width) || 1 };
  }
  async changes(v: TraceVar, max: number): Promise<Change[] | null> {
    let c;
    try { c = await waveformData(this.document).signalChanges({ netlistId: Number(v.key) }, max); } catch (e) { if (e instanceof DataError) { return null; } throw e; }
    if (!c) { return null; }
    const w = v.width, out: Change[] = new Array(c.times.length);
    // wellen gives each value as wide as the signal; a shorter one extends as Verilog does.
    for (let i = 0; i < c.times.length; i++) {
      const b = String(c.values[i]).toLowerCase();
      out[i] = [c.times[i], b.length >= w ? b : (b[0] === 'x' || b[0] === 'z' ? b[0] : '0').repeat(w - b.length) + b];
    }
    return out;
  }
}

export function dumpSourceFor(document: VaporviewDocument): TraceDumpSource {
  return own.get(document) || new DocumentDumpSource(document);
}
