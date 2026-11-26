// vscode-port: shared resolver for signals that are missing from the dump. A port copy or a continuous
// assign's net that the simulator did not dump (VCS dumps no port copies) is read through its connection: the
// driver's value at that time, which can itself be resolved, up to MAX_PORT_DEPTH levels. Trace (TraceCore) and inline
// values use the same resolver; each supplies `connectionOf`, the one-level step through the design.
// SPDX-License-Identifier: GPL-3.0-or-later

/** One level through the design: the value the signal's single driver (a port connection or continuous assign) gives at
 *  `time`, with the dump read through the same resolver, and what that value came via (e.g. "dbg_top.en1").
 *  `inputsNoValue`: the driver read an input that has no value (the value is then not computable). `multiDriven`: more
 *  than one driver. */
export interface ConnectionStep { value?: string; kind: string; via: string; inputsNoValue?: boolean; multiDriven?: boolean }
export type ConnectionOf = (path: string, time: number) => Promise<ConnectionStep | undefined>;
/** State 2 : resolved through the design. The value may be the simulator's x/z when its inputs really are. */
export interface ResolvedPort { value: string; via: string; dumped: false }
/** Why a NO VALUE (state 3) signal could not be computed. */
export type NotComputable = 'noSingleDriver' | 'notAConnection' | 'cycle' | 'depth' | 'dependsOnNoValue' | 'failed';
/** State 3 : no value. Never shown or evaluated as x. */
export interface NoValue { noValue: true; reason: 'notDumped' | 'notComputable'; why?: NotComputable; path: string }
export type PortValue = ResolvedPort | NoValue;
export const isNoValue = (v: unknown): v is NoValue => !!v && (v as NoValue).noValue === true;

export const MAX_PORT_DEPTH = 6;
export const RESOLVABLE_KINDS = ['portIn', 'portOut', 'assign'];

const WHY: Record<NotComputable, string> = {
  noSingleDriver: 'no single driver', notAConnection: 'not a port connection or continuous assign', cycle: 'a connection cycle',
  depth: `more than ${MAX_PORT_DEPTH} connections deep`, dependsOnNoValue: 'it depends on a signal with no value', failed: 'the design model could not evaluate it',
};
/** "no value (not in the dump)" / "no value (not computable: no single driver)". */
export function noValueText(v: NoValue | { reason: string; why?: string }): string {
  return v.reason === 'notDumped' ? 'no value (not in the dump)' : `no value (not computable: ${WHY[v.why as NotComputable] || v.why || 'unknown'})`;
}

/** "dbg_top.en1 (port connection)" / "... (continuous assign)". */
export function viaText(kind: string, via: string): string {
  return `${via} (${kind === 'assign' ? 'continuous assign' : 'port connection'})`;
}

export class PortResolver {
  private active = new Set<string>();
  private cache = new Map<string, PortValue>();
  /** Every signal resolved so far (path -> via text), for annotating steps and fan-in. */
  readonly resolved = new Map<string, string>();
  /** Every signal found to have no value (path -> why), likewise. */
  readonly noValues = new Map<string, NoValue>();
  constructor(private readonly connectionOf: ConnectionOf, readonly maxDepth = MAX_PORT_DEPTH) {}

  /** The value of `path` (not in the dump) at `time` through its connection, or why it has none. Never a guess. */
  async resolvePortValue(path: string, time: number): Promise<PortValue> {
    const key = `${path}@${time}`;
    const hit = this.cache.get(key);
    if (hit) { return hit; }
    const none = (why: NotComputable): NoValue => { const v: NoValue = { noValue: true, reason: 'notComputable', why, path }; this.noValues.set(path, v); return v; };
    // (not cached: a cycle or the depth limit is about this resolution, not the signal)
    if (this.active.has(path)) { return none('cycle'); }
    if (this.active.size >= this.maxDepth) { return none('depth'); }
    this.active.add(path);
    let out: PortValue;
    try {
      const st = await this.connectionOf(path, time);
      if (!st) { out = none('failed'); }
      else if (st.multiDriven) { out = none('noSingleDriver'); }
      else if (!RESOLVABLE_KINDS.includes(st.kind)) { out = none('notAConnection'); }
      else if (st.inputsNoValue || typeof st.value !== 'string' || !st.value) { out = none('dependsOnNoValue'); }
      else {
        out = { value: st.value, via: viaText(st.kind, st.via), dumped: false };
        this.resolved.set(path, out.via); this.noValues.delete(path);
      }
    } catch { out = none('failed'); } finally { this.active.delete(path); }
    this.cache.set(key, out);
    return out;
  }
  /** Depth of the resolution in progress (the dump reader skips resolving at the limit). */
  get depth() { return this.active.size; }
  clear() { this.cache.clear(); this.resolved.clear(); this.noValues.clear(); }
}
