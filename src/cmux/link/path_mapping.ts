// vscode-port: ported from cmux (sv-editor 45a845a1ab4) HierarchyPathMapping.swift: the prefix rules that line the
// design's hierarchy (slang-server) up with a waveform dump's, the inference of those rules from the two trees, and
// the textual assignment-target check used to find a signal's driver lines. Pure functions: no vscode imports, so
// they can be unit-tested under node.
// SPDX-License-Identifier: GPL-3.0-or-later
import { maxOf } from '../../common/arrays'; // vscode-port

export interface MappingRule {
  designPrefix: string;
  dumpPrefix: string;
  /** Added from the two hierarchies rather than written by the user. Only these are ever dropped automatically. */
  isInferred: boolean;
}

/** A child in a hierarchy being searched: a scope (instance, generate block) or a signal. */
export interface HierarchyNode {
  name: string;
  isScope: boolean;
  /** A dumped signal's width in bits, when the dump gives it. */
  width?: number;
}

/** Children of the scope at a path ([] = the root, listing the tops), or undefined if it is not a scope. */
export type ChildrenFn = (path: string[]) => Promise<HierarchyNode[] | undefined>;

const INFERRED_MARKER = '# inferred';
export const MAX_INFERRED_RULES_PER_PREFIX = 8;

/** Splits a hierarchical path at dots outside brackets and escaped identifiers. */
export function segments(path: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let escaped = false;
  for (const ch of path) {
    if (escaped) {
      current += ch;
      if (ch === ' ') { escaped = false; }
      continue;
    }
    if (ch === '\\' && current === '') { escaped = true; current += ch; continue; }
    if (ch === '[') { depth++; current += ch; continue; }
    if (ch === ']') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (ch === '.' && depth === 0) { result.push(current); current = ''; continue; }
    current += ch;
  }
  if (current !== '' || result.length > 0) { result.push(current); }
  return result;
}

export function join(segs: readonly string[]): string { return segs.join('.'); }

function startsWith(path: string[], prefix: string[]): boolean {
  if (prefix.length > path.length) { return false; }
  for (let i = 0; i < prefix.length; i++) { if (path[i] !== prefix[i]) { return false; } }
  return true;
}

/**
 * Maps hierarchical paths between the elaborated design and a waveform dump. Each rule replaces a whole-segment
 * prefix; the longest matching rule wins, in either direction. A path no rule matches maps to itself.
 */
export class HierarchyPathMapping {
  constructor(public rules: MappingRule[] = []) {}

  clone(): HierarchyPathMapping { return new HierarchyPathMapping(this.rules.map((r) => ({ ...r }))); }

  /** Every dump path `path` maps to: one per rule with the longest matching design prefix, user rules first. */
  dumpPaths(designPath: string): string[] {
    const path = segments(designPath);
    let best = -1;
    let matches: MappingRule[] = [];
    for (const rule of this.rules) {
      const from = segments(rule.designPrefix);
      if (!startsWith(path, from)) { continue; }
      if (from.length > best) { best = from.length; matches = [rule]; }
      else if (from.length === best) { matches.push(rule); }
    }
    if (matches.length === 0) { return [designPath]; }
    const out: string[] = [];
    for (const rule of [...matches.filter((r) => !r.isInferred), ...matches.filter((r) => r.isInferred)]) {
      const mapped = join([...segments(rule.dumpPrefix), ...path.slice(best)]);
      if (!out.includes(mapped)) { out.push(mapped); }
    }
    return out;
  }

  dumpPath(designPath: string): string { return this.dumpPaths(designPath)[0]; }

  designPath(dumpPath: string): string {
    const path = segments(dumpPath);
    let best: { length: number; to: string[] } | undefined;
    for (const rule of this.rules) {
      const from = segments(rule.dumpPrefix);
      if (!startsWith(path, from) || from.length <= (best?.length ?? -1)) { continue; }
      best = { length: from.length, to: segments(rule.designPrefix) };
    }
    if (!best) { return dumpPath; }
    return join([...best.to, ...path.slice(best.length)]);
  }

  /** Adds an inferred rule unless the same mapping is present. A user rule is never replaced; the oldest inferred
   *  rules for the prefix go first once there are MAX_INFERRED_RULES_PER_PREFIX. */
  addInferredRule(designPrefix: string, dumpPrefix: string): boolean {
    if (this.rules.some((r) => r.designPrefix === designPrefix && r.dumpPrefix === dumpPrefix)) { return false; }
    this.rules.push({ designPrefix, dumpPrefix, isInferred: true });
    const inferred = this.rules.map((r, i) => (r.isInferred && r.designPrefix === designPrefix ? i : -1)).filter((i) => i >= 0);
    if (inferred.length > MAX_INFERRED_RULES_PER_PREFIX) {
      const drop = new Set(inferred.slice(0, inferred.length - MAX_INFERRED_RULES_PER_PREFIX));
      this.rules = this.rules.filter((_, i) => !drop.has(i));
    }
    return true;
  }

  /** One `design = dump` rule per line; inferred rules end in `# inferred`. */
  get text(): string {
    return this.rules.map((r) => `${r.designPrefix} = ${r.dumpPrefix}` + (r.isInferred ? `  ${INFERRED_MARKER}` : '')).join('\n');
  }

  /** Parses the text format (lines, or `;`-separated in a one-line box). Blank and `#` lines are skipped. A line
   *  splits at its first `=`. Undefined when a line is not `design = dump`. */
  static parse(text: string, allowSemicolons = false): HierarchyPathMapping | undefined {
    const rules: MappingRule[] = [];
    const lines = allowSemicolons ? text.split(/[\n;]/) : text.split(/\r?\n/);
    for (const raw of lines) {
      let line = raw.trim();
      if (line === '' || line.startsWith('#')) { continue; }
      let isInferred = false;
      if (line.endsWith(INFERRED_MARKER)) { isInferred = true; line = line.slice(0, -INFERRED_MARKER.length); }
      const eq = line.indexOf('=');
      if (eq < 0) { return undefined; }
      const design = trimmedPrefix(line.slice(0, eq));
      const dump = trimmedPrefix(line.slice(eq + 1));
      if (design === '' && dump === '') { return undefined; }
      if (rules.some((r) => r.designPrefix === design && r.dumpPrefix === dump)) { continue; }
      rules.push({ designPrefix: design, dumpPrefix: dump, isInferred });
    }
    return new HierarchyPathMapping(rules);
  }
}

/** Trims whitespace, keeping the space that ends an escaped identifier (`\a.b `). */
function trimmedPrefix(text: string): string {
  const trimmed = text.trim();
  const last = segments(trimmed).pop();
  if (last === undefined || !last.startsWith('\\') || last.endsWith(' ')) { return trimmed; }
  return trimmed + ' ';
}

// #region Inference

/** Names a candidate scope must share with a root of `count` children: at least half, and at least two. */
export function requiredOverlap(count: number): number { return Math.max(Math.min(2, count), Math.floor((count + 1) / 2)); }

/** `name` without a trailing `[msb:lsb]` that spans `width` bits. */
export function signalNameOf(name: string, width: number): string {
  const m = /^(.+)\[(\d{1,9}):(\d{1,9})\]$/.exec(name);
  if (!m) { return name; }
  return Math.abs(Number(m[2]) - Number(m[3])) + 1 === width ? m[1] : name;
}

export function signalName(node: HierarchyNode): string {
  if (node.isScope || node.width === undefined) { return node.name; }
  return signalNameOf(node.name, node.width);
}

/** The signal names exactly one of `kids` strips to, other than a kid's exact name. */
export function uniqueSignalNames(kids: HierarchyNode[]): Set<string> {
  const counts = new Map<string, number>();
  for (const kid of kids) {
    const name = signalName(kid);
    if (name !== kid.name) { counts.set(name, (counts.get(name) ?? 0) + 1); }
  }
  const exact = new Set(kids.map((k) => k.name));
  return new Set([...counts].filter(([n, c]) => c === 1 && !exact.has(n)).map(([n]) => n));
}

/** Instance names are more telling than clk or rst, so a shared scope child counts twice. */
export function score(kids: HierarchyNode[], rootChildren: HierarchyNode[]): { overlap: number; score: number } {
  const rootScopes = new Set(rootChildren.filter((c) => c.isScope).map((c) => c.name));
  const names = new Set([...kids.map((k) => k.name), ...uniqueSignalNames(kids)]);
  let overlap = 0;
  let s = 0;
  for (const name of new Set(rootChildren.map((c) => c.name))) {
    if (names.has(name)) { overlap++; s += rootScopes.has(name) ? 2 : 1; }
  }
  return { overlap, score: s };
}

export async function exists(path: string[], children: ChildrenFn): Promise<boolean> {
  const last = path[path.length - 1];
  if (last === undefined) { return false; }
  const kids = await children(path.slice(0, -1));
  if (!kids) { return false; }
  return kids.some((k) => k.name === last) || uniqueSignalNames(kids).has(last);
}

export type DumpRuleResult =
  | { kind: 'found'; rules: MappingRule[] }
  | { kind: 'notDumped'; rule: MappingRule }
  | { kind: 'notFound' };

/**
 * Editor -> waveform. `designPath` is not in the dump as is; looks breadth first for dump scopes whose children
 * overlap `designRootChildren` (children of the path's first segment in the design) enough.
 */
export async function inferDumpRules(designPath: string, designRootChildren: HierarchyNode[], children: ChildrenFn,
  maxDepth = 4, maxScopes = 400): Promise<DumpRuleResult> {
  const path = segments(designPath);
  if (path.length < 2 || designRootChildren.length === 0) { return { kind: 'notFound' }; }
  const rest = path.slice(1);
  const required = requiredOverlap(new Set(designRootChildren.map((c) => c.name)).size);
  const found: { score: number; scope: string[] }[] = [];
  let bestMissing: { score: number; scope: string[] } | undefined;
  const queue: string[][] = [[]];
  let visited = 0;
  while (queue.length > 0 && visited < maxScopes) {
    const scope = queue.shift()!;
    visited++;
    const kids = await children(scope);
    if (!kids) { continue; }
    if (scope.length > 0) {
      const match = score(kids, designRootChildren);
      if (match.overlap >= required) {
        if ((kids.some((k) => k.name === rest[0]) || uniqueSignalNames(kids).has(rest[0])) && await exists([...scope, ...rest], children)) {
          found.push({ score: match.score, scope });
          continue;
        }
        if (!bestMissing || match.score > bestMissing.score) { bestMissing = { score: match.score, scope }; }
      }
    }
    if (scope.length < maxDepth) { for (const k of kids) { if (k.isScope) { queue.push(scope.concat(k.name)); } } } // vscode-port: no spread (wide scopes)
  }
  const rule = (scope: string[]): MappingRule => ({ designPrefix: path[0], dumpPrefix: join(scope), isInferred: true });
  const bestFound = found.length ? maxOf(found.map((f) => f.score)) : undefined; // vscode-port: no spread
  if (bestMissing && bestMissing.score > (bestFound ?? -1)) { return { kind: 'notDumped', rule: rule(bestMissing.scope) }; }
  if (bestFound === undefined) { return { kind: 'notFound' }; }
  return { kind: 'found', rules: found.filter((f) => f.score === bestFound).map((f) => rule(f.scope)) };
}

/**
 * Waveform -> editor. Returns the rule mapping a design top (`designRoots`: name -> its children) to the prefix of
 * `dumpPath` whose dump children overlap that top's enough.
 */
export async function inferDesignRule(dumpPath: string, designRoots: Map<string, HierarchyNode[]>, children: ChildrenFn): Promise<MappingRule | undefined> {
  const path = segments(dumpPath);
  if (path.length < 2) { return undefined; }
  let best: { score: number; rule: MappingRule } | undefined;
  for (let length = 1; length < path.length; length++) {
    const prefix = path.slice(0, length);
    const kids = await children(prefix);
    if (!kids) { break; }
    const name = path[length];
    let designName = name;
    if (length === path.length - 1) {
      const kid = kids.find((k) => k.name === name);
      if (kid && uniqueSignalNames(kids).has(signalName(kid))) { designName = signalName(kid); }
    }
    for (const [root, rootChildren] of [...designRoots].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!rootChildren.some((c) => c.name === name || c.name === designName)) { continue; }
      const match = score(kids, rootChildren);
      if (match.overlap < requiredOverlap(new Set(rootChildren.map((c) => c.name)).size)) { continue; }
      if (!best || match.score > best.score) { best = { score: match.score, rule: { designPrefix: root, dumpPrefix: join(prefix), isInferred: true } }; }
    }
  }
  return best?.rule;
}

// #region Assignment targets

const isIdent = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** True when the identifier at `column` (length `length`) of `line` is the target of an assignment
 *  (`x = `, `x <= `, `x += `, `x++`, `x[3:0] <= `, `{x, y} = `) at a statement start. */
export function isAssignmentTarget(line: string, column: number, length: number): boolean {
  if (column < 0 || length <= 0 || column + length > line.length) { return false; }
  if (isTarget(line, column, column + length)) { return true; }
  const open = unmatchedOpenBrace(line, column);
  const close = matchingCloseBrace(line, column + length);
  if (open === undefined || close === undefined) { return false; }
  return isTarget(line, open, close + 1);
}

function isTarget(line: string, start: number, end: number): boolean {
  let i = end;
  const skip = () => { while (i < line.length && (line[i] === ' ' || line[i] === '\t')) { i++; } };
  for (;;) {
    skip();
    if (i >= line.length) { return false; }
    if (line[i] === '[') {
      let depth = 0;
      while (i < line.length) {
        if (line[i] === '[') { depth++; }
        if (line[i] === ']') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      continue;
    }
    if (line[i] === '.') { i++; while (i < line.length && isIdent(line[i])) { i++; } continue; }
    break;
  }
  if (i >= line.length || !isAssignmentOperator(line, i)) { return false; }
  return isStatementStart(line.slice(0, start));
}

function isAssignmentOperator(s: string, i: number): boolean {
  const u = (o: number) => s[i + o] ?? '';
  switch (u(0)) {
    case '=': return u(1) !== '=';
    case '<':
      if (u(1) === '=') { return u(2) !== '='; }
      if (u(1) === '<') { return u(2) === '=' || (u(2) === '<' && u(3) === '='); }
      return false;
    case '>': return u(1) === '>' && (u(2) === '=' || (u(2) === '>' && u(3) === '='));
    case '+': case '-': return u(1) === '=' || u(1) === u(0);
    case '*': case '/': case '%': case '&': case '|': case '^': return u(1) === '=';
    default: return false;
  }
}

const STATEMENT_WORDS = ['assign', 'begin', 'else', 'always_comb', 'always_latch', 'always', 'always_ff', 'initial', 'final'];

function isStatementStart(text: string): boolean {
  const prefix = text.trim();
  if (prefix === '') { return true; }
  const last = prefix[prefix.length - 1];
  if (';):'.includes(last)) { return !prefix.endsWith('::'); }
  const words = prefix.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  const word = words[words.length - 1] ?? '';
  return STATEMENT_WORDS.includes(word) && prefix.endsWith(word);
}

function unmatchedOpenBrace(s: string, before: number): number | undefined {
  let depth = 0;
  for (let i = before - 1; i >= 0; i--) {
    if (s[i] === '}') { depth++; }
    else if (s[i] === '{') { if (depth === 0) { return i; } depth--; }
    else if (s[i] === ';') { return undefined; }
  }
  return undefined;
}

function matchingCloseBrace(s: string, after: number): number | undefined {
  let depth = 0;
  for (let i = after; i < s.length; i++) {
    if (s[i] === '{') { depth++; }
    else if (s[i] === '}') { if (depth === 0) { return i; } depth--; }
    else if (s[i] === ';') { return undefined; }
  }
  return undefined;
}

// #region Port connections

/** Blanks comments and strings (keeps offsets). */
export function blankCommentsAndStrings(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') { out[i++] = ' '; } continue; }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) { if (text[i] !== '\n') { out[i] = ' '; } }
      continue;
    }
    if (text[i] === '"') {
      out[i++] = ' ';
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') { if (text[i] === '\\') { out[i++] = ' '; } if (i < text.length) { out[i++] = ' '; } }
      if (i < text.length && text[i] === '"') { out[i++] = ' '; }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** The named port connections of one instantiation's text (`.port (signal)`, `.port`, `.*` is skipped).
 *  `signal` is undefined for an expression (not a plain identifier). */
export function portConnections(instanceText: string): { port: string; signal: string | undefined }[] {
  const text = blankCommentsAndStrings(instanceText);
  // The port list is the last top-level parenthesized group (after any #(...) parameters).
  let depth = 0; let start = -1; let lastOpen = -1; let lastClose = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') { if (depth === 0) { start = i; } depth++; }
    else if (text[i] === ')') { depth--; if (depth === 0 && start >= 0) { lastOpen = start; lastClose = i; } }
  }
  if (lastOpen < 0) { return []; }
  const body = text.slice(lastOpen + 1, lastClose);
  const out: { port: string; signal: string | undefined }[] = [];
  // Split the body at top-level commas.
  const parts: string[] = []; depth = 0; let cur = '';
  for (const ch of body) {
    if (ch === '(' || ch === '[' || ch === '{') { depth++; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const m = /^\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(part);
    if (!m) { continue; }
    if (m[2] === undefined) { out.push({ port: m[1], signal: m[1] }); continue; } // `.clk` implicit
    const sig = m[2].trim();
    out.push({ port: m[1], signal: /^[A-Za-z_][A-Za-z0-9_$]*$/.test(sig) ? sig : undefined });
  }
  return out;
}

/** The packed width of getScope's type text (`input logic[3:0]` -> 4, `logic` -> 1); undefined when unknown. */
export function typeWidth(type: string | undefined): number | undefined {
  if (!type) { return undefined; }
  const t = type.replace(/^(input|output|inout|ref)\s+/, '').replace(/\s+signed\b/, '').trim();
  if (/^(logic|bit|reg|wire)$/.test(t)) { return 1; }
  const enumBase = /^Enum .* \((.*)\)$/.exec(t);
  const base = enumBase ? enumBase[1] : t;
  const m = /^(?:logic|bit|reg|wire)(?:\s+signed)?\s*\[(-?\d+):(-?\d+)\]$/.exec(base.replace(/\s+signed/, ''));
  if (!m) { return /^(logic|bit|reg|wire)$/.test(base) ? 1 : undefined; }
  return Math.abs(Number(m[1]) - Number(m[2])) + 1;
}
