// vscode-port: driver tracing in the extension host, without VS Code: the engine (media/cmux/trace/
// cmux-trace.js + cmux-expr.js, cmux branch tracex-wcz 44516d52d6a, compiled in the host's own context), the design model
// (sidecar.ts), the dump provider (dump.ts) and the mapping of a dump path onto the design. Port of the tracing
// half of cmux's cmux-trace-ui.js (driverOfDesign, xRoot) and SVModelResolve.swift, GPL-3.0 with VaporView.
//
// Why the extension host and not the waveform webview (cmux ran it in its page): here the dump lives in the
// extension host (the wellen reader, or wisp-helper for FSDB/WCZ), and so does the sidecar. The engine reads
// whole-signal histories and many signals per step; in the webview every read would be a round trip through
// the host. The panel (panel.ts) only shows the steps.
import { PortResolver, isNoValue, noValueText, type ConnectionStep, type NoValue } from '../shared/port_resolve';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { DesignSession, SidecarError, type Json } from './sidecar';
import { makeDump, newDumpSession, toDump, toDesign, type DumpSession, type TraceDumpSource } from './dump';

export interface TraceLib { createEngine(config: Json): Json; xChain(start: Json, config: Json): Promise<Json>; MODEL_VERSION: number }

/** Loads the engine in the extension host's own context. Each file is an IIFE over `window`: it is compiled as a
 *  function whose `window` parameter is a private object, so the engine's globals go there, not on globalThis.
 *  (Not a node:vm context: there every global lookup goes through the contextified global, which cost the same
 *  code several times its self time.) */
export function loadEngine(mediaDir: string): TraceLib {
  const win: Json = {};
  for (const f of ['cmux-expr.js', 'cmux-trace.js']) {
    const p = path.join(mediaDir, f);
    vm.compileFunction(fs.readFileSync(p, 'utf8'), ['window'], { filename: p })(win);
  }
  const lib = win.cmuxTrace;
  if (!lib || typeof lib.createEngine !== 'function') { throw new Error('trace engine did not load'); }
  return lib;
}

/** Whether `name` (a lookup's rest) is a signal of the instance model, or a word of one of its arrays in range. */
export function signalWidth(name: string, model: Json): number | null {
  if (!name || name.startsWith('$') || !model || !model.signals) { return null; }
  const s = model.signals[name];
  if (s) { return Number(s.width) || 0; }
  const m = /^(.*)\[(-?\d{1,10})\]$/.exec(name);
  if (!m) { return null; }
  const a = model.signals[m[1]] && model.signals[m[1]].array;
  if (!a) { return null; }
  const i = Number(m[2]);
  return Math.min(a.lo, a.hi) <= i && i <= Math.max(a.lo, a.hi) ? Number(a.elemWidth) || 0 : null;
}

/** The prefixes mapping design paths onto the dump: what is left once common trailing segments go. */
export function prefixes(dumpPath: string[], designPath: string[]) {
  let common = 0;
  while (common < Math.min(dumpPath.length, designPath.length) && dumpPath[dumpPath.length - 1 - common] === designPath[designPath.length - 1 - common]) { common++; }
  return { designPrefix: designPath.slice(0, designPath.length - common).join('.'), dumpPrefix: dumpPath.slice(0, dumpPath.length - common).join('.') };
}

export type Resolved =
  | { kind: 'signal'; designPath: string; designPrefix: string; dumpPrefix: string; dumpPath: string }
  | { kind: 'notElaborated'; instance: string }
  | { kind: 'notInDesign' };

/** A user's path rule: a dump path as the design names it, or null to infer. */
export type PathMapping = (dumpPath: string) => string | null;

export interface Bound {
  design: DesignSession;
  generation: number;
}

/** A trace session: a design generation and a dump, with the engine over them. */
/** A value the waveform shows from the helper's computed port copy (outsideWrites none), not a stored signal. */
export const COMPUTED_TEXT = 'computed by the helper (port copy)';

export class TraceCore {
  readonly dump: DumpSession;
  readonly engine: Json;
  constructor(readonly lib: TraceLib, readonly bound: Bound, source: TraceDumpSource, designPrefix: string, dumpPrefix: string, options: Json = {}) {
    this.dump = newDumpSession(source, designPrefix, dumpPrefix);
    const { design, generation } = bound;
    const models = {
      instance: (p: string) => design.model(p, generation),
      lookup: (p: string) => design.lookup(p, generation).then((r) => r || { instance: '', name: p }),
      writers: (p: string) => design.writers(p, generation),
    };
    this.dumpApi = this.resolvingDump(makeDump(this.dump));
    this.engine = lib.createEngine({ models, dump: this.dumpApi, options: Object.assign({ xprop: 'auto' }, options) });
  }
  /** The dump as the engine reads it (signals the dump lacks resolved through their connections). */
  readonly dumpApi: Json;

  /**
   * (e2e gate, every suite) What a step says that the dump contradicts:
   * - "keeps its value" while the dump shows the signal changing at that edge;
   * - a written value computed without x that differs from the dump (consistent false) with no reason that explains it;
   * - an x condition whose signal (or its port connection) has a value at that time.
   */
  async invariants(st: Json): Promise<string[]> {
    const out: string[] = [];
    if (!st || st.error) { return out; }
    const where = `${st.signal}@${st.time}`;
    const codes = new Set((st.reasons || []).map((r: Json) => r.code));
    if (codes.has('noWrite') && !codes.has('multiDriven') && st.activation && st.activation.time !== undefined) {
      const lc = await this.dumpApi.lastChange(st.signal, Number(st.time)).catch(() => null);
      if (lc !== null && lc !== undefined && Number(lc) === Number(st.activation.time)) {
        out.push(`${where}: "keeps its value" but the dump changes it at the ${st.activation.time} edge`);
      }
    }
    const EXPLAINED = ['multiDriven', 'delay', 'race', 'opaque', 'statement', 'limits', 'evaluator', 'lvalue', 'notRecorded', 'noActivation', 'staticLocal'];
    if (st.wrote !== false && st.consistent === false && typeof st.predicted === 'string' && !/[xz]/i.test(st.predicted)
      && !(st.reasons || []).some((r: Json) => EXPLAINED.includes(r.code))) {
      out.push(`${where}: the step's statement writes ${st.predicted} but the dump has ${st.value}`);
    }
    // NO VALUE is never x: a fan-in entry not in the dump and not resolved must say no value; a condition reading
    // one must not show x or a taken branch it didn't infer.
    for (const f of st.fanin || []) {
      if (f.dumped === false && !f.local && !f.resolvedVia && f.path && (!f.noValue || (typeof f.value === 'string' && /[xz]/i.test(f.value)))) {
        out.push(`${where}: ${f.path} has no value but shows ${JSON.stringify(f.value)}`);
      }
    }
    const nvPaths = new Set((st.fanin || []).filter((f: Json) => f.noValue).map((f: Json) => f.path));
    for (const d of st.decisions || []) {
      if (d.noValue && (d.value !== null || (!d.inferred && d.taken !== 'unknown'))) { out.push(`${where}: condition (${d.src}) has no value but shows ${d.value} → ${d.taken}`); }
      if (!d.noValue && d.xCond && !d.inferred && (st.fanin || []).some((f: Json) => f.role === 'control' && nvPaths.has(f.path) && new RegExp(`\\b${String(f.path).split('.').pop()}\\b`).test(String(d.src)))) { out.push(`${where}: condition (${d.src}) reads a signal with no value and shows x`); }
    }
    for (const d of st.decisions || []) {
      if (!d.xCond) { continue; }
      for (const f of (st.fanin || []).filter((x: Json) => x.role === 'control' && x.path && /[xz]/i.test(String(x.value)))) {
        const v = (await this.dumpApi.values([f.path], Number(f.time)).catch(() => new Map())).get(f.path);
        if (typeof v === 'string' && !/[xz]/i.test(v)) { out.push(`${where}: condition (${d.src}) read ${f.path} as x, but it is ${v} at ${f.time}`); }
      }
    }
    return out;
  }

  // ---- signals the dump lacks : a port or a continuous assign's net that the simulator did not dump (VCS
  // dumps no port copies) is read through its connection: its driver's value, from the dump, recursively, bounded. ----
  /** Off: the engine reads such a signal as x, "not in the dump" (e2e: the inferred-branch case). */
  static resolveMissing = true;
  /** Signals the dump lacks, read through their connection (shared with inline values: src/cmux/shared/port_resolve.ts). */
  readonly ports = new PortResolver((p, t) => this.connectionOf(p, t));
  private resolvingDump(base: Json): Json {
    const values = async (paths: string[], time: number) => {
      const m: Map<string, string | undefined> = await base.values(paths, time);
      if (!TraceCore.resolveMissing) { return m; }
      for (const p of paths) {
        if (m.get(p) !== undefined) { continue; }
        const r = await this.ports.resolvePortValue(p, Number(time));
        if (!isNoValue(r)) { m.set(p, r.value); }
      }
      return m;
    };
    return Object.assign(Object.create(base), base, { values });
  }
  /** One level through the design: the trace engine's step for the signal (its driver, evaluated on the dump). */
  async connectionOf(p: string, time: number): Promise<ConnectionStep | undefined> {
    const st = await this.engine.active(p, time);
    if (!st || st.error || !st.driver) { return undefined; }
    const leaves = (st.fanin || []).filter((f: Json) => f.role === 'data' && f.path).map((f: Json) => f.path);
    const codes = (st.reasons || []).map((r: Json) => r.code);
    return { value: typeof st.predicted === 'string' ? st.predicted : undefined, kind: st.driver.kind, via: leaves.length ? leaves.join(', ') : (st.stmt && st.stmt.src) || p,
      inputsNoValue: codes.includes('notDumped') || codes.includes('noValueCondition'), multiDriven: codes.includes('multiDriven') };
  }
  /** (shared entry) The value of a signal the dump lacks, through its connection. */
  resolvePortValue(p: string, time: number) { return this.ports.resolvePortValue(p, time); }
  /** Marks a step's target and fan-in entries that were read through a connection, not from the dump. */
  /** Why a signal the dump lacks has no value: what the resolver found, else not in the dump. */
  noValueOf(p: string): NoValue { return this.ports.noValues.get(p) || { noValue: true, reason: 'notDumped', path: p }; }
  /** Marks a step's target, fan-in and conditions: read through a connection ("via …"), or NO VALUE (never x). */
  private annotate(st: Json): Json {
    if (!st || st.error) { return st; }
    // (computed port copies: read like stored rows, as the waveform does; labelled honestly)
    const computed = (p: string) => { const cp = (this.dump.source as Json).computedPaths; return !!cp && cp.has(this.toDump(p)); };
    if (computed(st.signal)) { st.computed = true; st.computedText = COMPUTED_TEXT; }
    for (const f of st.fanin || []) { if (f.path && computed(f.path)) { f.computed = true; f.computedText = COMPUTED_TEXT; } }
    const r = this.ports.resolved.get(st.signal);
    if (r) { st.dumped = false; st.resolvedVia = r; }
    else if (st.value === undefined || st.value === null) { const nv = this.noValueOf(st.signal); st.noValue = nv; st.noValueText = noValueText(nv); }
    for (const f of st.fanin || []) {
      const fr = f.path && this.ports.resolved.get(f.path);
      if (fr) { f.dumped = false; f.resolvedVia = fr; }
      else if (f.dumped === false && !f.local && f.path) { const nv = this.noValueOf(f.path); f.noValue = nv; f.noValueText = noValueText(nv); f.value = null; }
    }
    for (const d of st.decisions || []) {
      if (!d.noValue) { continue; }
      d.noValueText = d.noValue.map((p: string) => `${p.split('.').pop()}: ${noValueText(this.noValueOf(p))}`).join('; ');
    }
    return st;
  }
  toDump(designPath: string) { return toDump(this.dump, designPath); }
  toDesign(dumpPath: string) { return toDesign(this.dump, dumpPath); }

  /** The active driver of a design signal at a time (cmux traceStep). */
  async step(designPath: string, time: number): Promise<Json> {
    const st = this.annotate(await this.engine.active(designPath, time));
    st.dumpPath = this.toDump(designPath);
    st.engine = { name: 'cmux' };
    return st;
  }

  /**
   * Trace to Root (cmux xRoot): the chain the x (or value) came along, with the engine's held-x jumps, cause walks
   * and bounds (labels never depend on wall time: causeSteps 160; the hang guard is the engine's own). Each step's
   * candidates (the inputs with x the engine probed) are kept, ranked by when their own x arrived.
   */
  async chain(designPath: string, time: number, onStep: (e: Json, all: Json[]) => void, cancelled: () => boolean, maxSteps?: number): Promise<Json> {
    const e = this.engine;
    const probes: Json[] = [];
    const steps: Json[] = [];
    const probe = async (p: string, at: number) => {
      const st = await e.active(p, at);
      probes.push({ path: p, time: at, since: st && !st.error ? st.since : null, trust: st && st.trust, value: st && st.value, dumpPath: this.toDump(p) });
      return st;
    };
    const step = async (p: string, at: number) => { const st = this.annotate(await e.active(p, at)); st.dumpPath = this.toDump(p); st.engine = { name: 'cmux' }; return st; };
    const sinceOf = (c: Json) => (c.since === null || c.since === undefined ? Infinity : Number(c.since));
    const rank = (list: Json[]) => list.slice().sort((a, b) => sinceOf(a) - sinceOf(b));
    const t0 = Date.now();
    let prev = t0;
    const out = await this.lib.xChain({ path: designPath, time }, {
      step, probe, cancelled, maxSteps,
      xStart: (p: string, at: number) => e.xStart(p, at),
      maskStart: (p: string, at: number, floor: number) => e.xMaskStart(p, at, floor),
      xCause: (p: string, at: number, care: Json) => e.xCause(p, at, care),
      xInputEdges: (p: string, at: number, from: number) => e.xInputEdges(p, at, from),
      xLink: (p: string, at: number, input: Json, care: Json) => e.xLink(p, at, input, care),
      changeCount: (p: string, from: number, to: number) => e.xChangeCount(p, from, to),
      maskChangeCount: (p: string, from: number, to: number) => e.xMaskChangeCount(p, from, to),
      onStep: (entry: Json) => {
        const now = Date.now();
        // The inputs the previous step chose this one among (the probes since it), earliest x first: its ranked causes.
        if (steps.length) { steps[steps.length - 1].causes = rank(probes.splice(0)); } else { probes.splice(0); }
        Object.assign(entry, { dumpPath: entry.step.dumpPath || this.toDump(entry.signal), at: now - t0, ms: now - prev, causes: [] });
        prev = now;
        steps.push(entry);
        onStep(entry, steps);
      },
    });
    if (steps.length && probes.length) { steps[steps.length - 1].causes = rank(probes.splice(0)); }
    return { steps, end: out.end, root: out.root, approximate: out.approximate, mode: out.mode, designPath, time };
  }
}

/**
 * The design path of a dump row (SVModelResolve.resolve): as the mapping gives it; else with leading dump scopes
 * dropped and the rest placed under a design top or under an instance named like the scope dropped last (a
 * simulator's wrapper scope, a design whose top is the DUT); else without a trailing [msb:lsb] as wide as the
 * signal. A row below a scope the design left out (slang's UnknownModule) is notElaborated.
 */
export async function resolveDumpPath(bound: Bound, dumpPath: string[], mapping?: PathMapping): Promise<Resolved> {
  const { design, generation } = bound;
  if (!dumpPath.length) { return { kind: 'notInDesign' }; }
  const isSig = async (designPath: string): Promise<number | null> => {
    const found = await design.lookup(designPath, generation);
    if (!found) { return null; }
    const m = await design.model(found.instance, generation);
    return signalWidth(found.name, m);
  };
  const result = (designPath: string, row: string[]): Resolved => {
    const pre = prefixes(row, designPath.split('.'));
    return { kind: 'signal', designPath, designPrefix: pre.designPrefix, dumpPrefix: pre.dumpPrefix, dumpPath: row.join('.') };
  };
  const rows: string[][] = [dumpPath];
  const r = /^(.*)\[(\d{1,9}):(\d{1,9})\]$/.exec(dumpPath[dumpPath.length - 1]);
  if (r && !dumpPath[dumpPath.length - 1].startsWith('\\')) { rows.push(dumpPath.slice(0, -1).concat([r[1]])); }
  const rowWidth = r ? Math.abs(Number(r[2]) - Number(r[3])) + 1 : null;
  const { tops, instances } = await design.hierarchy(generation);
  for (const [k, row] of rows.entries()) {
    const ok = async (dp: string) => { const w = await isSig(dp); return w !== null && (k === 0 || w === rowWidth); };
    const mapped = mapping ? mapping(row.join('.')) : null;
    if (mapped && await ok(mapped)) { return result(mapped, row); }
    if (await ok(row.join('.'))) { return result(row.join('.'), row); }
    for (let i = 1; i < row.length; i++) {
      const rest = row.slice(i).join('.');
      const roots = [...tops, ...instances.filter((p) => p.split('.').pop() === row[i - 1])];
      const seen = new Set<string>();
      for (const root of ['', ...roots]) {
        const dp = root ? root + '.' + rest : rest;
        if (seen.has(dp)) { continue; }
        seen.add(dp);
        if (await ok(dp)) { return result(dp, row); }
      }
    }
  }
  if (design.loadMessages.length) {
    const found = await design.lookup(dumpPath.join('.'), generation);
    if (found) {
      const m = await design.model(found.instance, generation);
      const rest = found.name.split('.');
      if (rest.length >= 2 && rest[0] && !rest[0].startsWith('$') && signalWidth(rest[0], m) === null) {
        return { kind: 'notElaborated', instance: found.instance + '.' + rest[0] };
      }
    }
  }
  return { kind: 'notInDesign' };
}

/** The design instances whose module (the file of their signals' declarations) is in `file` and that declare `name`. */
export async function instancesDeclaring(bound: Bound, file: string, name: string): Promise<string[]> {
  const { design, generation } = bound;
  const { instances } = await design.hierarchy(generation);
  const want = path.resolve(file);
  const out: string[] = [];
  for (const inst of instances.slice(0, 4096)) {
    const m = await design.model(inst, generation);
    const s = m && m.signals && m.signals[name];
    if (s && Array.isArray(s.loc) && m.files && path.resolve(String(m.files[s.loc[0]])) === want) { out.push(inst); }
  }
  return out;
}

export { SidecarError };
export { SvModelSidecar, DesignSession } from './sidecar';
