// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: the Search Netlist index for wisp-helper files (FSDB / WCZ), without NetlistItems.
// One entry per scope or variable as the Netlist view names it, in flat arrays (about 70 B per entry with its name;
// a NetlistItem was 500-800 B). Entries are added one children reply at a time (addChildren), so the index can be
// filled from the helper's children replies now and from a binary name list later. A scope's children are contiguous
// (kidStart / kidCount). Search answers in the order and with the rules of the earlier NetlistItem walk (wellen's
// searchnetlist: see WispFormatHandler.searchNetlist).

export interface IndexScope { name: string; type?: string; netlistId?: number; scopeOffsetIdx?: number; inline?: {scopes?: IndexScope[]; vars?: IndexVar[]}; }
export interface IndexVar { name: string; type?: string; netlistId?: number; width?: number; msb?: number; lsb?: number; }
export interface IndexHit { instancePath: string; type: string; isVar: boolean; paramValue: string; msb: number; lsb: number; }

const FIELD = /\[(\d+:)?(\d+)\]$/;

// The names the Netlist view gives (tree_view.ts createScope / createVar with isFsdb): a vhdlarray scope drops its
// [..] suffix; a variable drops a suffix that is its own range ("cnt[7:0]", "a[3]"), never a memory word's index.
export function scopeName(name: string, type: string): string {
  return type.toLowerCase() === 'vhdlarray' ? name.replace(FIELD, '') : name;
}
export function varName(name: string, msb: number, lsb: number): string {
  const m = name.match(FIELD);
  if (!m) {return name;}
  // (as createVar: a single index right after another index, "vld_mirror[83][0]", is the element's index, kept)
  const own = m[1] !== undefined ? Number(m[1].slice(0, -1)) === msb && Number(m[2]) === lsb
    : msb === lsb && Number(m[2]) === msb && !/\]$/.test(name.slice(0, m.index));
  return own ? name.replace(FIELD, '') : name;
}

class GrowI32 {
  a = new Int32Array(1024); n = 0;
  push(v: number) { if (this.n === this.a.length) {const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b;} this.a[this.n++] = v; }
}

export class NameIndex {
  readonly names: string[] = [];
  readonly lnames: string[] = [];     // lower-case name (the same string when the name has no upper case)
  private parent = new GrowI32();      // entry index of the parent scope, -1 at the top
  private kidStart = new GrowI32();    // scopes: first child entry (-1 until its children are added)
  private kidCount = new GrowI32();
  private netlistId = new GrowI32();
  private msb = new GrowI32();
  private lsb = new GrowI32();
  private typeId = new GrowI32();      // scopes: >= 0; variables: -(id + 1)
  private types: string[] = []; private typeIds = new Map<string, number>();
  top = {start: 0, count: 0};
  scopes = 0; vars = 0;

  get size() { return this.names.length; }
  isScope(k: number) { return this.typeId.a[k] >= 0; }
  private type(k: number) { const t = this.typeId.a[k]; return this.types[t >= 0 ? t : -t - 1]; }
  private tid(t: string) { let i = this.typeIds.get(t); if (i === undefined) {i = this.types.length; this.types.push(t); this.typeIds.set(t, i);} return i; }

  private add(name: string, parent: number, tid: number, netlistId: number, msb: number, lsb: number) {
    const l = name.toLowerCase();
    this.names.push(name); this.lnames.push(l === name ? name : l);
    this.parent.push(parent); this.kidStart.push(-1); this.kidCount.push(0);
    this.netlistId.push(netlistId); this.msb.push(msb); this.lsb.push(lsb); this.typeId.push(tid);
  }

  // The children of `parent` (-1: the top level), as one children reply gives them. Returns the new scope entries
  // that still need their own children (inline scopes come with theirs), with their scopeOffsetIdx.
  addChildren(parent: number, scopes: IndexScope[], vars: IndexVar[]): {entry: number; scopeOffsetIdx: number}[] {
    const todo: {entry: number; scopeOffsetIdx: number}[] = [];
    const inline: {entry: number; s: IndexScope}[] = [];
    const start = this.size;
    for (const s of scopes) {
      const type = String(s.type || (s.inline ? 'vhdlarray' : 'module')).toLowerCase();
      const k = this.size;
      this.add(scopeName(String(s.name), type), parent, this.tid(type), Number(s.netlistId ?? -1), 0, 0);
      this.scopes++;
      if (s.inline) {inline.push({entry: k, s});} else if (Number(s.scopeOffsetIdx) >= 0) {todo.push({entry: k, scopeOffsetIdx: Number(s.scopeOffsetIdx)});}
    }
    for (const v of vars) {
      const msb = Number(v.msb ?? (Number(v.width) - 1)), lsb = Number(v.lsb ?? 0);
      this.add(varName(String(v.name), msb, lsb), parent, -this.tid(String(v.type || 'wire')) - 1, Number(v.netlistId ?? -1), msb, lsb);
      this.vars++;
    }
    if (parent < 0) {this.top = {start, count: this.size - start};} else {this.kidStart.a[parent] = start; this.kidCount.a[parent] = this.size - start;}
    for (const {entry, s} of inline) {todo.push(...this.addChildren(entry, s.inline!.scopes || [], s.inline!.vars || []));}
    return todo;
  }

  private kids(k: number): [number, number] { return k < 0 ? [this.top.start, this.top.count] : [Math.max(0, this.kidStart.a[k]), this.kidCount.a[k]]; }

  path(k: number): string {
    const parts: string[] = [];
    for (let p = k; p >= 0; p = this.parent.a[p]) {parts.push(this.names[p]);}
    return parts.reverse().join('.');
  }

  hit(k: number): IndexHit {
    return this.isScope(k)
      ? {instancePath: this.path(k), type: this.type(k) || 'module', isVar: false, paramValue: '', msb: -1, lsb: -1}
      : {instancePath: this.path(k), type: this.type(k) || 'wire', isVar: true, paramValue: '', msb: this.msb.a[k], lsb: this.lsb.a[k]};
  }

  // Same rules and order as the earlier walk: the query is lower-cased and split on '.'; the first part matches
  // (substring) every scope under the search scope at any depth (depth-first order) and, for a one-part query, every
  // variable; each further part matches the direct children of a match. scopeId: a scope's netlistId, or none.
  search(query: string, scopeId: number | undefined, limit = 100): {total: number; hits: IndexHit[]} {
    let root = -1;
    if (scopeId !== undefined && scopeId !== 0xFFFFFFFF) {
      for (let k = 0; k < this.size; k++) {if (this.isScope(k) && this.netlistId.a[k] === scopeId) {root = k; break;}}
    }
    const allScopes: number[] = [], allVars: number[] = [];
    // depth-first, in child order (the walk's order)
    const stack: number[] = [];
    const pushKids = (k: number) => { const [s, c] = this.kids(k); for (let i = s + c - 1; i >= s; i--) {stack.push(i);} };
    pushKids(root);
    while (stack.length) {
      const k = stack.pop()!;
      if (this.isScope(k)) {allScopes.push(k); pushKids(k);} else {allVars.push(k);}
    }
    const parts = query.toLowerCase().split('.');
    const found: number[] = [];
    const go = (p: string[], scopes: number[], vars: number[] | null) => {
      if (!p.length) {return;}
      const want = p[0], rest = p.slice(1);
      for (const sc of scopes) {
        if (!this.lnames[sc].includes(want)) {continue;}
        if (!rest.length) {found.push(sc); continue;}
        const [s, c] = this.kids(sc), ks: number[] = [], kv: number[] = [];
        for (let i = s; i < s + c; i++) {(this.isScope(i) ? ks : kv).push(i);}
        go(rest, ks, rest.length === 1 ? kv : null);
      }
      if (rest.length) {return;}
      if (vars) {for (const v of vars) {if (this.lnames[v].includes(want)) {found.push(v);}}}
    };
    go(parts, allScopes, parts.length === 1 ? allVars : null);
    return {total: found.length, hits: found.slice(0, limit).map((k) => this.hit(k))};
  }
}

// Indexes by file identity (path, size, mtime and the open options), so a reopen of the same file reuses its index.
// At most two are kept.
const cache = new Map<string, NameIndex>();
export function cachedIndex(key: string): NameIndex | undefined {
  const x = cache.get(key);
  if (x) {cache.delete(key); cache.set(key, x);}
  return x;
}
export function keepIndex(key: string, index: NameIndex) {
  cache.delete(key); cache.set(key, index);
  while (cache.size > 2) {cache.delete(cache.keys().next().value as string);}
}
