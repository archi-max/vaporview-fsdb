// vscode-port P4: which dump scopes are instances of a SystemVerilog module. cmux asks slang-server
// (getInstancesOfModule + the path mapping); slang integration lives in the source link, so this is behind an interface
// with a text fallback: a dump scope is an instance of the module when it has every port of the module (or, for a module
// without ports, most of its declared signals, or the module's own name).
import type { ModuleInfo } from './sv-lines';
import type { WaveData } from './wave-data';

export interface InstanceResolver {
  /** Every dump instance of `mod`, in dump order. */
  instancesOf(mod: ModuleInfo, data: WaveData): Promise<string[][]>;
  /** The instance the editor shows the module in (a user choice, else the first instance); null when none. */
  thisInstance(mod: ModuleInfo, data: WaveData, modules?: ModuleInfo[]): Promise<string[] | null>;
  /** vscode-port: the session's instance (launch option "instance"): a module it is an instance of is shown in it, so
   *  Locals, inline values and line breakpoints all follow one instance (they split u1 / u0). */
  preferred?: string[] | null;
}

export class TextInstanceResolver implements InstanceResolver {
  /** Module name -> chosen dump instance (Choose Instance for Module…). */
  readonly chosen = new Map<string, string[]>();
  preferred: string[] | null = null;
  /** The instance per module (by name + ports), per dump (data object) and generation. */
  private first = new WeakMap<WaveData, { gen: number; byKey: Map<string, string[] | null> }>();

  /** Does the dump scope with these children hold an instance of `mod`? */
  /** `chosen`: a scope the user named (the session's instance): one port or declared name is enough, since a dump
   *  without the helper's computed port copies lacks the undumped ports (u1.en, clk, rst on FSDB). */
  private static matches(mod: ModuleInfo, scope: string[], kids: Array<{ kind: string; name: string }>, chosen = false): boolean {
    const names = new Set<string>();
    for (const c of kids) { if (c.kind === 'var') { names.add(c.name); } }
    if (!names.size) { return false; }
    const ports = [...new Set(mod.ports)];
    const declared = [...new Set(mod.declared)];
    // (a scope the user named: one of its ports or declared names is enough; without the computed port copies an FSDB's
    // u1 holds only cnt and next)
    if (chosen) { return ports.some((p) => names.has(p)) || declared.some((d) => names.has(d)); }
    if (ports.length) { return ports.every((p) => names.has(p)); }
    if (declared.length) { return declared.filter((d) => names.has(d)).length >= Math.max(1, Math.ceil(declared.length / 2)); }
    return scope[scope.length - 1] === mod.name;
  }

  async instancesOf(mod: ModuleInfo, data: WaveData): Promise<string[][]> {
    const out: string[][] = [];
    for (const scope of await data.allScopes()) {
      if (TextInstanceResolver.matches(mod, scope, await data.children(scope))) { out.push(scope); }
    }
    // vscode-port: a scope with a matching child scope only connects the instance (see thisInstance)
    const keep: string[][] = [];
    for (const p of out) { if (!(await this.matchingChild(mod, p, data))) { keep.push(p); } }
    return keep;
  }

  /** A child scope of `scope` that is an instance of `mod` (the first in dump order) and holds at least as many of its
   *  declared names (a wrapper with the same ports keeps its own internals: it stays), else null. */
  private async matchingChild(mod: ModuleInfo, scope: string[], data: WaveData): Promise<string[] | null> {
    const own = TextInstanceResolver.declaredHits(mod, await data.children(scope));
    for (const k of await data.children(scope)) {
      if (k.kind !== 'scope') { continue; }
      const kids = await data.children(k.path);
      if (TextInstanceResolver.matches(mod, k.path, kids) && TextInstanceResolver.declaredHits(mod, kids) >= own) { return k.path; }
    }
    return null;
  }

  private static declaredHits(mod: ModuleInfo, kids: Array<{ kind: string; name: string }>): number {
    const names = new Set(kids.filter((c) => c.kind === 'var').map((c) => c.name));
    return [...new Set(mod.declared)].filter((d) => names.has(d)).length;
  }

  /** vscode-port: the module of each prefix of a dump path, from the source's instantiations (`modules`: the file's
   *  modules): ['dbg_top', 'u1'] gives dbg_top for dbg_top and counter for dbg_top.u1. Null when any step is not in the
   *  source (another file, a generate block, a multi-line instantiation): then the modules are unknown. */
  static modulesAlong(path: string[], modules: ModuleInfo[] | undefined): string[] | null {
    if (!modules || !path.length) { return null; }
    let cur: ModuleInfo | undefined = modules.find((m) => m.name === path[0]);
    if (!cur) { return null; }
    const out = [cur.name];
    for (const seg of path.slice(1)) {
      const base = seg.replace(/\[\d+\]$/, ''); // (an instance array element u[3])
      const i: { type: string; name: string } | undefined = (cur.instances || []).find((x) => x.name === base);
      const next: ModuleInfo | undefined = i ? modules.find((m) => m.name === i.type) : undefined;
      if (!next) { return null; }
      out.push(next.name); cur = next;
    }
    return out;
  }

  /** Modules the session's instance is not an instance of (and not inside): the only instance in the dump, else null
   *  (several: ambiguous, the user picks one with Choose Instance). Per dump generation. */
  private only = new WeakMap<WaveData, { gen: number; byKey: Map<string, string[] | null> }>();
  private async onlyInstance(mod: ModuleInfo, data: WaveData): Promise<string[] | null> {
    let memo = this.only.get(data);
    if (!memo || memo.gen !== data.generation) { memo = { gen: data.generation, byKey: new Map() }; this.only.set(data, memo); }
    const key = mod.name + '\u0000' + mod.ports.join(',') + '\u0000' + mod.declared.join(',');
    if (!memo.byKey.has(key)) { const all = await this.instancesOf(mod, data); memo.byKey.set(key, all.length === 1 ? all[0] : null); }
    return memo.byKey.get(key)!;
  }

  async thisInstance(mod: ModuleInfo, data: WaveData, modules?: ModuleInfo[]): Promise<string[] | null> {
    const chosen = this.chosen.get(mod.name);
    if (chosen && TextInstanceResolver.matches(mod, chosen, await data.children(chosen))) { return chosen; }
    const pref = this.preferred;
    if (pref && pref.length) {
      // vscode-port: the session's instance applies only to the module it IS an instance of (from the source's
      // instantiations); a module along its path reads in that prefix (dbg_top for dbg_top.u1); any other module in its
      // only instance, or nowhere when it has several (no chip, never "no value"). Only when the source does not say
      // what dbg_top.u1 is does the name match decide (one port or declared name: an FSDB without the helper's
      // computed port copies lacks the undumped ports).
      const along = TextInstanceResolver.modulesAlong(pref, modules);
      if (along) {
        const at = along.lastIndexOf(mod.name);
        if (at >= 0) { return pref.slice(0, at + 1); }
        return this.onlyInstance(mod, data);
      }
      if (TextInstanceResolver.matches(mod, pref, await data.children(pref), true)) { return pref; }
    }
    let memo = this.first.get(data);
    if (!memo || memo.gen !== data.generation) { memo = { gen: data.generation, byKey: new Map() }; this.first.set(data, memo); }
    const key = mod.name + '\u0000' + mod.ports.join(',') + '\u0000' + mod.declared.join(',');
    if (memo.byKey.has(key)) { return memo.byKey.get(key)!; }
    // vscode-port: the shallowest instance (same depth: dump order), breadth first, stopping at the first match. A full
    // scan of a big design (CVA6: 1,936 scopes, 841K names) cost 6-17 s per call; depth first still read 914 scopes
    // (796K names) before CVA6's core; breadth first reads 67 (2.5K names).
    let found: string[] | null = null;
    let level: string[][] = (await data.topScopes()).map((t) => t.path);
    while (level.length && !found) {
      const next: string[][] = [];
      for (const scope of level) {
        const kids = await data.children(scope);
        if (TextInstanceResolver.matches(mod, scope, kids)) { found = scope; break; }
        for (const k of kids) { if (k.kind === 'scope') { next.push(k.path); } }
      }
      level = next;
    }
    // vscode-port: a scope whose nets share the module's port names (a testbench connecting `.*`: tb_i holds clk,
    // valid, pop ... as i_drivers' ports) matches too; a module cannot hold an instance of itself, so when a child scope
    // also matches, the instance is the child (tb_i.dut), never the scope that connects it
    for (let deeper = found ? await this.matchingChild(mod, found, data) : null; deeper; deeper = await this.matchingChild(mod, deeper, data)) { found = deeper; }
    memo.byKey.set(key, found);
    return found;
  }
}
