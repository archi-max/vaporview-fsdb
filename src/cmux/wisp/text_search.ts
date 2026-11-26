// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: searchText in the extension host, for wisp-helper (15.7 answers "not supported by this helper").
// The same request and reply as cmux helper-v2's searchText (worker.js + text.js):
//   {signalId, width, t, dir, inclusive?, format, pattern, caseSensitive?, alias?, budgetMs?}
//   -> {t, value, text, distinct, formatted, chunks, ms} | {t: null, ...}
//    | {t: null, incomplete: {timedOut | cancelled, at, resume: {t, inclusive}}}
// dir 1: the first change with time > t (>= t if inclusive); dir -1: the last < t (<= t). As the page's scan, with no
// marker (t = 0, inclusive) the value at time 0 counts too.
// How: exact windows from the helper (the same chunks as the page's scanChunks, but straight off the pipe), each
// distinct value formatted with the viewer's own formatters (formats.ts) and judged once per (format, pattern); the
// verdicts are kept for the next press (LRU). Matching is the page's: riscv* and alias use extra_formats.ts
// matchFormatted (a regex, case-insensitive; a pattern that isn't a valid regex is a plain substring); ascii is
// value_format.ts formatAscii (parseSearchValue, then regexMatchBinary on the bits). Numeric formats are value
// searches (`search`), refused here as in cmux. Each chunk is judged inside vm with the remaining budget as its
// timeout, so a pattern that backtracks without end stops at the budget instead of hanging the extension host.
// No vscode import: test/perf bundles it.
import * as vm from 'node:vm';

// The viewer's formatters (src/webview/host_formats.ts, bundled as dist/host_formats.js), given by the caller.
export interface HostFormats {
  riscvOptions: Record<string, unknown>;
  formatRiscvBinaryString(v: string, is2State: boolean, opts: unknown): string;
  parseAliasFile(text: string, fileName: string, opts: unknown): {tables: {name: string}[]};
  formatWithTable(tables: Map<string, unknown>, name: string, v: string): string;
  formatAscii: {parseSearchValue(s: string): string; checkSearchValue(p: string, v: string, f: string): boolean; formatString(v: string, w: number, is2: boolean): string};
  valueIs9State(v: string): boolean;
}
let F: HostFormats | null = null;
export function useFormats(f: HostFormats) { F = f; }

export const TEXT_FORMATS = new Set(['riscv', 'riscv_numeric', 'riscv_noalias', 'riscv_numeric_noalias', 'alias', 'ascii']);
const NUMERIC = new Set(['hex', 'bin', 'dec', 'sdec', 'hexadecimal', 'binary', 'decimal', 'signed', 'octal']);
const MAX_PATTERN = 4096;
const MAX_ALIAS_TEXT = 4 << 20;
const DEFAULT_BUDGET = 5000, MAX_BUDGET = 60000;
export const SCAN_BUCKETS = 32768;   // exact chunks of up to 65536 changes, as the page's scan
const VERDICT_SETS = 16;             // (signal, format, pattern) verdict maps kept between presses
const VERDICT_VALUES = 1 << 20;      // distinct values remembered per map (later ones are judged again)

export interface ScanWindow { exact: boolean; count: number; recs: [number, string][] }
export interface TextSearchDeps {
  // An exact (or not, then shrunk and asked again) window of one signal: record 0 is the value at t0.
  window(signalId: number, width: number, t0: number, t1: number, buckets: number): Promise<ScanWindow>;
  timeEnd: number;          // last time of the dump
  cancelled(): boolean;
  fileKey: string;          // verdict cache key: changes when the file reopens
}

const is2 = (v: string) => !F!.valueIs9State(v);

// The page's matchFormatted (extra_formats.ts), per search instead of a module-level memo.
function formattedMatcher(search: string): (text: string) => boolean {
  let re: RegExp | null = null;
  try { re = new RegExp(search, 'i'); } catch { re = null; }
  const lower = search.toLowerCase();
  return re ? (s) => re!.test(s) : (s) => s.toLowerCase().includes(lower);
}

const aliasCache = new Map<string, Map<string, any>>();
function aliasTables(alias: any): Map<string, any> {
  if (!alias || typeof alias !== 'object' || typeof alias.text !== 'string' || typeof alias.table !== 'string') {
    throw new Error('alias format needs alias: {text, table, fileName?, bareRadix?}');
  }
  if (alias.text.length > MAX_ALIAS_TEXT) {throw new Error('alias text too long');}
  const key = `${alias.fileName || ''}\0${alias.bareRadix || ''}\0${alias.text}`;
  let t = aliasCache.get(key);
  if (!t) {
    const parsed = F!.parseAliasFile(alias.text, String(alias.fileName || 'alias'), alias.bareRadix ? {bareRadix: alias.bareRadix} : {});
    t = new Map(parsed.tables.map((x: any) => [x.name, x]));
    aliasCache.set(key, t);
    if (aliasCache.size > 8) {aliasCache.delete(aliasCache.keys().next().value!);}
  }
  return t;
}

// -> {key, judge(value) -> hit, text(value) -> the row's text}
function judge(p: any): {key: string; hit: (v: string) => boolean; text: (v: string) => string} {
  const f = String(p.format);
  if (f === 'ascii') {
    const bits = F!.formatAscii.parseSearchValue(p.pattern);
    return {
      key: `ascii\0${p.pattern}`,
      hit: (v) => { try {return F!.formatAscii.checkSearchValue(bits, v, '');} catch {return false;} },
      text: (v) => F!.formatAscii.formatString(v, v.length, is2(v)),
    };
  }
  const m = formattedMatcher(p.pattern);
  let fmt: (v: string) => string;
  let key: string;
  if (f.startsWith('riscv')) {
    const opts = F!.riscvOptions[f];
    fmt = (v) => F!.formatRiscvBinaryString(v, is2(v), opts);
    key = f;
  } else {
    const tables = aliasTables(p.alias);
    const name = p.alias.table;
    fmt = (v) => F!.formatWithTable(tables, name, v);
    key = `alias\0${name}\0${p.alias.fileName || ''}\0${p.alias.bareRadix || ''}\0${p.alias.text}`;
  }
  return {key: `${key}\0${p.pattern}`, hit: (v) => { try {return m(fmt(v));} catch {return false;} }, text: fmt};
}

export function checkTextSearch(p: any) {
  if (NUMERIC.has(p.format)) {throw new Error(`searchText format ${p.format}: numeric formats are value searches, use search (the page's exact value search)`);}
  if (!TEXT_FORMATS.has(p.format)) {throw new Error(`bad searchText format ${p.format}`);}
  if (typeof p.pattern !== 'string' || !p.pattern.length || p.pattern.length > MAX_PATTERN) {throw new Error('searchText pattern must be a non-empty string (at most 4096 characters)');}
  if (!Number.isInteger(p.signalId) || !(Number(p.width) > 0)) {throw new Error('searchText needs signalId and width');}
}

const verdictSets = new Map<string, Map<string, boolean>>();
function verdicts(key: string): Map<string, boolean> {
  let v = verdictSets.get(key);
  if (v) {verdictSets.delete(key);} else {v = new Map();}
  verdictSets.set(key, v);
  while (verdictSets.size > VERDICT_SETS) {verdictSets.delete(verdictSets.keys().next().value!);}
  return v;
}
export const textSearchStats = () => ({sets: verdictSets.size, values: [...verdictSets.values()].reduce((a, m) => a + m.size, 0)});

const ctx = vm.createContext({});
const runJob = new vm.Script('job()');

export async function hostSearchText(p: any, deps: TextSearchDeps): Promise<any> {
  checkTextSearch(p);
  if (!F) {throw new Error('searchText: the viewer formatters (host_formats.js) are not loaded');}
  const t0ms = Date.now();
  const budget = Number(p.budgetMs) > 0 ? Math.min(MAX_BUDGET, Number(p.budgetMs)) : DEFAULT_BUDGET;
  const deadline = t0ms + budget;
  const dir = p.dir < 0 ? -1 : 1;
  const inclusive = p.inclusive === true;
  const width = Number(p.width);
  const t = Math.max(0, Math.floor(Number(p.t) || 0));
  const end = deps.timeEnd + 1;
  const J = judge(p);
  const memo = verdicts(`${deps.fileKey}\0${p.signalId}\0${J.key}`);
  let formatted = 0, chunks = 0;
  const done = (o: any) => Object.assign(o, {distinct: memo.size, formatted, chunks, ms: Date.now() - t0ms});
  const stop = (why: string, at: number, inc: boolean) => done({t: null, incomplete: {[why]: true, at, resume: {t: at, inclusive: inc}}});
  // Judges recs[i] for i in the order given; -> the first hit's index, -1, or 'timedOut'.
  const scan = (recs: [number, string][], order: Iterable<number>, take: (i: number) => boolean): number | 'timedOut' => {
    let found = -1;
    (ctx as any).job = () => {
      for (const i of order) {
        if (!take(i)) {continue;}
        const v = recs[i][1];
        let h = memo.get(v);
        if (h === undefined) {
          h = J.hit(v); formatted++;
          if (memo.size < VERDICT_VALUES) {memo.set(v, h);}
        }
        if (h) {found = i; return;}
      }
    };
    try {runJob.runInContext(ctx, {timeout: Math.max(1, deadline - Date.now())});} catch (e: any) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {return 'timedOut';}
      throw e;
    } finally {(ctx as any).job = null;}
    return found;
  };
  const hitAt = (recs: [number, string][], i: number) => done({t: recs[i][0], value: recs[i][1], text: (() => { try {return J.text(recs[i][1]);} catch {return null;} })()});
  let span = 1 << 20;
  const grow = (dt: number, n: number) => Math.max(1, Math.floor(dt * Math.min(8, Math.max(1, SCAN_BUCKETS / Math.max(1, n)))));
  if (dir > 0) {
    // `at`: the first time not judged yet. Window [a, t1) with a = at - 1: record 0 is the value at a, records 1..
    // the changes in [at, t1). At at = 0 the window starts at 0 and record 0 (time 0) counts, as the page's scan.
    let at = inclusive ? t : t + 1;
    for (;;) {
      if (deps.cancelled()) {return stop('cancelled', at, true);}
      if (Date.now() > deadline) {return stop('timedOut', at, true);}
      if (at >= end) {return done({t: null});}
      const a = Math.max(0, at - 1);
      const t1 = Math.min(end, a + span);
      const w = await deps.window(p.signalId, width, a, t1, SCAN_BUCKETS);
      if (!w.exact) {span = Math.max(1, Math.floor((t1 - a) * (SCAN_BUCKETS * 1.6) / Math.max(1, w.count))); continue;}
      chunks++;
      const recs = w.recs;
      const first = at === 0 ? 0 : 1;
      const order = {*[Symbol.iterator]() { for (let i = first; i < recs.length; i++) {yield i;} }};
      const r = scan(recs, order, (i) => recs[i][0] >= at);
      if (r === 'timedOut') {return stop('timedOut', at, true);}
      if (r >= 0) {return hitAt(recs, r);}
      if (t1 >= end) {return done({t: null});}
      at = t1;
      span = grow(t1 - a, recs.length);
    }
  }
  // dir -1: window [lo - 1, b): records 1.. the changes in [lo, b); at lo - 1 = 0 record 0 (time 0) counts too
  let b = Math.min(end, inclusive ? t + 1 : t);
  for (;;) {
    if (deps.cancelled()) {return stop('cancelled', b, false);}
    if (Date.now() > deadline) {return stop('timedOut', b, false);}
    if (b <= 0) {return done({t: null});}
    const t0 = Math.max(0, b - span - 1);
    const w = await deps.window(p.signalId, width, t0, b, SCAN_BUCKETS);
    if (!w.exact) {span = Math.max(1, Math.floor((b - t0) * (SCAN_BUCKETS * 1.6) / Math.max(1, w.count))); continue;}
    chunks++;
    const recs = w.recs;
    const last = t0 === 0 ? 0 : 1;
    const order = {*[Symbol.iterator]() { for (let i = recs.length - 1; i >= last; i--) {yield i;} }};
    const r = scan(recs, order, (i) => recs[i][0] < b);
    if (r === 'timedOut') {return stop('timedOut', b, false);}
    if (r >= 0) {return hitAt(recs, r);}
    if (t0 === 0) {return done({t: null});}
    span = grow(b - t0, recs.length);
    b = t0 + 1;
  }
}
