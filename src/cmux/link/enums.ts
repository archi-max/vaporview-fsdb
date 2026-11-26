// vscode-port: SystemVerilog enum member names for waveform values, from the design's source. Ported from cmux
// (sv-editor 45a845a1ab4) SlangEnumTypes.swift + WaveformEnumLink.swift. slang-server knows each signal's declared
// type, the dump (VCD) usually doesn't:
//  - getScope gives the type text (`Enum state_t (logic[2:0])`, or an anonymous `Enum enum{A=..,B=..}e$1 (...)`);
//  - the declaration's hover links to the typedef; documentSymbol lists its members; each member's hover gives its
//    value (`Value: 3'b100`), one section per elaborated instance. A member whose instances disagree leaves the
//    type out rather than guessing.
// The viewer gets each type as a value-alias table (extra_formats.ts `loadValueAliases`, JSON form) bound to the rows'
// paths, so enum rows show member names by default.
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { Slang, SlangItem, LspSymbol, LspPosition } from './slang';

export interface EnumMember { name: string; bits: string }
export interface EnumType { name: string; width: number; members: EnumMember[] }
export interface EnumSignal { type: EnumType; isArray: boolean }

const MAX_MEMBERS = 4096;
const MAX_WIDTH = 4096;
const MAX_MEMBER_HOVERS = 512;

// #region Pure helpers (exported for tests)

export function baseWidth(base: string): number | undefined {
  const text = base.replace(/ signed/g, '');
  const open = text.indexOf('[');
  if (open < 0) { return ['logic', 'bit', 'reg'].includes(text) ? 1 : undefined; }
  const m = /^\w+\[(-?\d+):(-?\d+)\]$/.exec(text);
  if (!m) { return undefined; }
  const w = Math.abs(Number(m[1]) - Number(m[2])) + 1;
  return w <= MAX_WIDTH ? w : undefined;
}

export type ScopeType =
  | { kind: 'named'; name: string; width: number }
  | { kind: 'anonymous'; type: EnumType }
  | { kind: 'array'; element: string };

export function scopeType(text: string): ScopeType | undefined {
  const type = text.trim();
  if (!type.startsWith('Enum ')) {
    const d = type.indexOf('$[');
    if (d < 0) { return undefined; }
    const element = type.slice(0, d);
    return element === '' || element.includes(' ') ? undefined : { kind: 'array', element };
  }
  const open = type.lastIndexOf(' (');
  if (!type.endsWith(')') || open < 0) { return undefined; }
  const name = type.slice(5, open);
  const width = baseWidth(type.slice(open + 2, -1));
  if (!name || width === undefined) { return undefined; }
  if (name.startsWith('enum{')) {
    const close = name.lastIndexOf('}');
    if (close < 0) { return undefined; }
    const members: EnumMember[] = [];
    for (const item of name.slice(5, close).split(',')) {
      const parts = item.split('=').map((s) => s.trim());
      const bits = parts.length === 2 ? literalBits(parts[1], width) : undefined;
      if (!bits) { return undefined; }
      members.push({ name: parts[0], bits });
    }
    if (members.length === 0 || members.length > MAX_MEMBERS) { return undefined; }
    return { kind: 'anonymous', type: { name: 'enum{' + members.map((m) => m.name).join(',') + '}', width, members } };
  }
  return { kind: 'named', name, width };
}

/** A Verilog number literal as exactly `width` bits; undefined for names, expressions or x/z digits. */
export function literalBits(literal: string, width: number): string | undefined {
  if (width <= 0 || width > MAX_WIDTH) { return undefined; }
  const text = literal.replace(/[_ ]/g, '').toLowerCase();
  let digits = text;
  let base = 10;
  const tick = text.indexOf("'");
  if (tick >= 0) {
    let rest = text.slice(tick + 1);
    if (rest.startsWith('s')) { rest = rest.slice(1); }
    const radix = rest[0];
    base = radix === 'b' ? 2 : radix === 'o' ? 8 : radix === 'd' ? 10 : radix === 'h' ? 16 : -1;
    if (base < 0) { return undefined; }
    digits = rest.slice(1);
  }
  if (digits === '' || digits.length > MAX_WIDTH) { return undefined; }
  let bits: string;
  if (base === 10) {
    if (!/^\d+$/.test(digits)) { return undefined; }
    bits = BigInt(digits).toString(2);
  } else {
    const per = base === 2 ? 1 : base === 8 ? 3 : 4;
    bits = '';
    for (const d of digits) {
      const v = parseInt(d, 16);
      if (isNaN(v) || v >= base) { return undefined; }
      bits += v.toString(2).padStart(per, '0');
    }
  }
  return fitted(bits, width);
}

/** `bits` as `width` bits: extended with x/z when the top is x/z, else 0; a longer value keeps its low bits. */
export function fitted(bits: string, width: number): string {
  if (bits.length === width) { return bits; }
  if (bits.length > width) { return bits.slice(bits.length - width); }
  const top = bits[0] ?? '0';
  return (top === 'x' || top === 'z' ? top : '0').repeat(width - bits.length) + bits;
}

export { hexLiteral } from './literals'; // (x / z per hex digit, as the waveform row)

/** The member name for a value (bits), or undefined. */
export function memberName(type: EnumType, value: string): string | undefined {
  const bits = fitted(value.toLowerCase(), type.width);
  return type.members.find((m) => m.bits === bits)?.name;
}

/** The link a hover's `Type:` field gives to an enum type's declaration (file URI, 0-based position). */
export function enumTypeLink(hover: string): { uri: string; position: LspPosition } | undefined {
  for (const raw of hover.split('\n')) {
    if (raw.startsWith('```')) { return undefined; }
    const text = raw.trim();
    const field = text.startsWith('Type: ') ? text.slice(6) : text.startsWith('Resolved Type: ') ? text.slice(15) : undefined;
    if (field === undefined) { continue; }
    const m = /^\[`Enum [^`]*`\]\(<(file:[^>#]+)#L(\d+),(\d+)>\)$/.exec(field);
    if (!m) { return undefined; }
    return { uri: m[1], position: { line: Number(m[2]) - 1, character: Number(m[3]) - 1 } };
  }
  return undefined;
}

export interface HoverMemberValue { name: string; scope: string; literal: string }

export function hoverMemberValues(hover: string): HoverMemberValue[] {
  const out: HoverMemberValue[] = [];
  let pending: { name: string; scope: string } | undefined;
  for (const raw of hover.split('\n')) {
    const text = raw.trim();
    if (text.startsWith('**EnumValue** `')) {
      const parts = text.split('`');
      pending = parts.length >= 4 ? { name: parts[1], scope: parts[3] } : undefined;
    } else if (text.startsWith('Value: `') && text.endsWith('`') && pending) {
      out.push({ ...pending, literal: text.slice(8, -1) });
      pending = undefined;
    }
  }
  return out;
}

function literalWidth(literal: string): number | undefined {
  const t = literal.indexOf("'");
  return t > 0 ? Number(literal.slice(0, t)) : undefined;
}

/** The one value of `width` bits the sections give (instances that disagree leave it out). */
export function memberValue(sections: HoverMemberValue[], width: number): { bits: string; scope: string } | undefined {
  let sized = sections.filter((s) => literalWidth(s.literal) === width);
  if (sized.length === 0 && sections.length > 0 && sections.every((s) => literalWidth(s.literal) === undefined)) { sized = sections; }
  const values = sized.map((s) => literalBits(s.literal, width));
  if (values.some((v) => v === undefined)) { return undefined; }
  const set = new Set(values);
  if (set.size !== 1 || sized.length === 0) { return undefined; }
  return { bits: values[0]!, scope: sized[0].scope };
}

function contains(r: { start: LspPosition; end: LspPosition }, p: LspPosition): boolean {
  const after = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const before = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return after && before;
}

type SymbolMember = { name: string; position: LspPosition };

function visitEnums(symbols: LspSymbol[], visit: (s: LspSymbol, members: SymbolMember[]) => void) {
  for (const s of symbols ?? []) {
    if (s.kind === 10) {
      const members = (s.children ?? []).filter((c) => c.kind === 22).map((c) => ({ name: c.name, position: (c.selectionRange ?? c.range).start }));
      if (members.length) { visit(s, members); }
    }
    if (s.children) { visitEnums(s.children, visit); }
  }
}

export function enumMembersAt(symbols: LspSymbol[], position: LspPosition): SymbolMember[] | undefined {
  let found: SymbolMember[] | undefined;
  visitEnums(symbols, (s, m) => { if (!found && contains(s.range, position)) { found = m; } });
  return found;
}

export function enumMembersNamed(symbols: LspSymbol[], name: string): SymbolMember[] | undefined {
  let found: SymbolMember[] | undefined;
  visitEnums(symbols, (s, m) => { if (!found && s.name === name) { found = m; } });
  return found;
}

/** A table's label in the viewer's formats (`alias:<label>`): a function of the type alone. */
export function tableLabel(type: EnumType): string {
  const label = `${type.name} [${type.width}]`;
  return type.name.startsWith('enum{') ? `${label} ${stableHash(type.members).slice(0, 6)}` : label;
}

/** 64-bit FNV-1a of the members, as 16 hex digits. */
export function stableHash(members: EnumMember[]): string {
  let h = 0xcbf29ce484222325n;
  const add = (t: string) => { for (const b of Buffer.from(t, 'utf8')) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } };
  for (const m of members) { add(m.name); add('='); add(m.bits); add(';'); }
  return h.toString(16).padStart(16, '0');
}

// #region Reading from slang

/** Enum-typed signals per design scope, read from slang and kept until the design changes. */
export class EnumTypes {
  private scopes = new Map<string, Promise<Map<string, EnumSignal>>>();
  private typeCache = new Map<string, Promise<EnumType | undefined>>();
  private symbolCache = new Map<string, Promise<LspSymbol[]>>();
  private hoverBudget = MAX_MEMBER_HOVERS;
  constructor(private slang: Slang) {}

  /** Forget everything (a save, a new top level, a waveform reload). */
  /** Bumped by reset(): caches keyed on what slang said (e.g. scopes with no enum signals) are valid for one epoch. */
  epoch = 0;
  reset() { this.scopes.clear(); this.typeCache.clear(); this.symbolCache.clear(); this.epoch++; }

  /** The enum signals of design scope `designScope`, by name ({} when slang can't say). */
  signals(designScope: string): Promise<Map<string, EnumSignal>> {
    let p = this.scopes.get(designScope);
    if (!p) {
      this.hoverBudget = MAX_MEMBER_HOVERS;
      p = this.read(designScope).catch(() => new Map<string, EnumSignal>());
      this.scopes.set(designScope, p);
      // An empty answer may be a server not ready yet: read again next time.
      p.then((m) => { if (m.size === 0) { this.scopes.delete(designScope); } });
    }
    return p;
  }

  private async read(designScope: string): Promise<Map<string, EnumSignal>> {
    const items: SlangItem[] = await this.slang.getScope(designScope);
    const out = new Map<string, EnumSignal>();
    const byTypeName = new Map<string, EnumType>();
    const arrays: { name: string; element: string; uri: vscode.Uri }[] = [];
    for (const item of items) {
      if ((item.kind !== 'Logic' && item.kind !== 'Port') || !item.type) { continue; }
      const st = scopeType(item.type.replace(/^(input|output|inout|ref)\s+/, ''));
      if (!st) { continue; }
      if (st.kind === 'anonymous') { out.set(item.name, { type: st.type, isArray: false }); continue; }
      if (!item.location) { continue; }
      if (st.kind === 'array') { arrays.push({ name: item.name, element: st.element, uri: item.location.uri }); continue; }
      const type = await this.namedType(item.location, st.width);
      if (type) { out.set(item.name, { type, isArray: false }); byTypeName.set(st.name, type); }
    }
    for (const a of arrays) {
      const short = a.element.split('::').pop() ?? a.element;
      const type = byTypeName.get(a.element) ?? byTypeName.get(short);
      if (type) { out.set(a.name, { type, isArray: true }); }
    }
    return out;
  }

  private symbols(uri: vscode.Uri): Promise<LspSymbol[]> {
    const key = uri.toString();
    let p = this.symbolCache.get(key);
    if (!p) { p = this.slang.documentSymbols(uri); this.symbolCache.set(key, p); }
    return p;
  }

  private async namedType(decl: vscode.Location, width: number): Promise<EnumType | undefined> {
    const hover = await this.slang.hover(decl.uri, { line: decl.range.start.line, character: decl.range.start.character });
    const link = hover ? enumTypeLink(hover) : undefined;
    if (!link) { return undefined; }
    const key = `${link.uri}#${link.position.line},${link.position.character}/${width}`;
    let p = this.typeCache.get(key);
    if (!p) {
      p = (async () => {
        const uri = vscode.Uri.parse(link.uri);
        const members = enumMembersAt(await this.symbols(uri), link.position);
        if (!members || members.length > MAX_MEMBERS || members.length > this.hoverBudget) { return undefined; }
        this.hoverBudget -= members.length;
        const out: EnumMember[] = [];
        let scope: string | undefined;
        for (const m of members) {
          const h = await this.slang.hover(uri, m.position);
          const v = h ? memberValue(hoverMemberValues(h).filter((s) => s.name === m.name), width) : undefined;
          if (!v) { return undefined; }
          scope = scope ?? v.scope;
          out.push({ name: m.name, bits: v.bits });
        }
        return scope ? { name: scope, width, members: out } : undefined;
      })().catch(() => undefined);
      this.typeCache.set(key, p);
    }
    return p;
  }
}

/** The JSON alias file (value_alias.ts format) for `tables` (label -> type) and `signals` (dump path -> label). */
export function aliasJson(tables: Map<string, EnumType>, signals: Map<string, string>): string {
  const t: Record<string, Record<string, string>> = {};
  for (const [label, type] of tables) {
    t[label] = {};
    for (const m of type.members) { t[label][`${type.width}'b${m.bits}`] = m.name; }
  }
  return JSON.stringify({ tables: t, signals: Object.fromEntries(signals) });
}
