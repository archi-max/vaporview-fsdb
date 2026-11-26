// Value alias tables: map a signal value (or value range, or wildcard pattern) to a
// display name. Parses three inputs:
//   1. Verdi nWave alias files (".alias"): alias/endalias blocks, the older bare-name
//      block style, slice/endslice bit-slice tables and curAliasTable. Verdi resource
//      files (".rc", or any file using aliasmapname/slicemapname) are read for their
//      alias lines only: aliasmapname/nalias, slicemapname/nslice, aliasname + addSignal.
//      Conditional aliases (condAlias) need other signals' values and are skipped
//      with a warning.
//   2. JSON: {"tables": {"<table>": {"<value>": "<name>", ...}}, "signals": {"<path>": "<table>"}}
//      (a top-level object without "tables" is read as the tables map itself).
//   3. CSV: "value,name[,color]" rows (one table named after the file),
//      "table,value,name[,color]" rows, or a header row naming the columns
//      (table, signal, value, name|alias, color).
// Pure functions only (no webview imports) so it can be unit-tested under node.
// Parsing never throws; problems come back as warnings.

export type AliasMatcher =
  | { kind: "pattern"; bits: string }          // 0/1/x/z/? characters, MSB first
  | { kind: "range"; lo: bigint; hi: bigint }
  | { kind: "others" };

export interface AliasEntry { name: string; match: AliasMatcher; color?: string }
export interface AliasTable { kind: "alias"; name: string; entries: AliasEntry[] }
export interface SliceDef { msb: number; lsb: number; table?: string; radix?: string }
export interface SliceTable { kind: "slice"; name: string; slices: SliceDef[] }
export type ValueTable = AliasTable | SliceTable;

export interface AliasBinding { signal: string; table: string }

export interface ParsedAliasFile {
  tables: ValueTable[];
  bindings: AliasBinding[];
  defaultTable?: string;
  warnings: string[];
}

export type BareRadix = "hex" | "dec" | "bin" | "oct";
const BARE_RADIXES: BareRadix[] = ["hex", "dec", "bin", "oct"];

export interface AliasParseOptions {
  // Table name for entries that are not inside a named block (default "alias").
  name?: string;
  // How to read a number with no Verilog base ("3"). Verdi compares such values in
  // the signal's current radix, which is hex by default, so Verdi files default to
  // "hex". JSON and CSV default to "dec". "0x"/"0b"/"0o" prefixes always work.
  bareRadix?: BareRadix;
  // Read the text as a Verdi resource file (.rc): only its alias lines are used.
  resourceFile?: boolean;
}

// Alias files can come from anywhere; keep one literal from allocating huge strings.
export const MAX_VALUE_BITS = 4096;

// #region Value parsing
const RADIX_BITS: Record<string, number> = { b: 1, o: 3, h: 4 };

function digitsToBits(digits: string, base: string): string | null {
  if (base === "d") {
    if (/^[xz?]$/.test(digits)) {return digits;} // 'dx: width filled in later
    if (!/^[0-9]+$/.test(digits) || digits.length > MAX_VALUE_BITS / 3) {return null;}
    return BigInt(digits).toString(2);
  }
  const n = RADIX_BITS[base];
  if (digits.length * n > MAX_VALUE_BITS) {return null;}
  let out = "";
  for (const ch of digits) {
    if (ch === "x" || ch === "z" || ch === "?") {out += ch.repeat(n); continue;}
    const v = parseInt(ch, 1 << n);
    if (isNaN(v)) {return null;}
    out += v.toString(2).padStart(n, "0");
  }
  return out;
}

// Parses one value literal into a binary pattern. Accepts Verilog literals (8'h1f,
// 'b1?0, 4'd9, 8'sh80), 0x/0b/0o prefixes, and bare numbers in bareRadix.
// Values wider than MAX_VALUE_BITS are rejected.
export function parseValueLiteral(text: string, bareRadix: BareRadix, truncate = true): string | null {
  const s = text.trim().toLowerCase().replace(/_/g, "");
  if (s === "") {return null;}
  let width: number | undefined;
  let base: string;
  let digits: string;
  const verilog = /^(\d*)'s?([bodh])(.+)$/.exec(s);
  if (verilog) {
    width = verilog[1] ? parseInt(verilog[1]) : undefined;
    if (width !== undefined && width > MAX_VALUE_BITS) {return null;}
    base = verilog[2];
    digits = verilog[3];
  } else if (/^0[xbo]/.test(s)) {
    base = { x: "h", b: "b", o: "o" }[s[1]] as string;
    digits = s.slice(2);
  } else {
    base = { hex: "h", dec: "d", bin: "b", oct: "o" }[bareRadix];
    digits = s;
  }
  let bits = digitsToBits(digits, base);
  if (bits === null) {return null;}
  if (width !== undefined && width > 0) {
    if (truncate && bits.length > width) {bits = bits.slice(bits.length - width);}
    // Left-extend: x/z/? extend themselves, otherwise zero (Verilog rules).
    const fill = /[xz?]/.test(bits[0]) ? bits[0] : "0";
    bits = bits.padStart(width, fill);
  }
  return bits;
}

export function parseMatcher(text: string, bareRadix: BareRadix): AliasMatcher | null {
  const s = text.replace(/\s+/g, "");
  if (/^(others|default)$/i.test(s)) {return { kind: "others" };}
  const tilde = s.indexOf("~");
  if (tilde > 0) {
    // Range ends are not truncated to their size (4'h0~4'h10 means 0..16).
    const lo = parseValueLiteral(s.slice(0, tilde), bareRadix, false);
    const hi = parseValueLiteral(s.slice(tilde + 1), bareRadix, false);
    if (lo === null || hi === null || /[xz?]/.test(lo + hi)) {return null;}
    const a = BigInt("0b" + lo);
    const b = BigInt("0b" + hi);
    return { kind: "range", lo: a < b ? a : b, hi: a < b ? b : a };
  }
  const bits = parseValueLiteral(s, bareRadix);
  return bits === null ? null : { kind: "pattern", bits };
}

// #region Matching
// Values and patterns compare right-aligned; missing leading bits count as 0.
function stripLeadingZeros(s: string): string {
  let i = 0;
  while (i < s.length - 1 && s[i] === "0") {i++;}
  return s.slice(i);
}

function matchWildcard(pattern: string, value: string): boolean {
  const n = Math.max(pattern.length, value.length);
  for (let i = 1; i <= n; i++) {
    const p = i <= pattern.length ? pattern[pattern.length - i] : "0";
    const v = i <= value.length ? value[value.length - i] : "0";
    if (p !== "?" && p !== v) {return false;}
  }
  return true;
}

// Lookup structure built once per table: exact patterns in a Map, wildcard patterns
// and ranges scanned in file order, "others" as the fallback.
interface CompiledTable {
  exact: Map<string, number>;
  scan: { index: number; match: AliasMatcher }[];
  fallback: number;
}
const compiledTables = new WeakMap<AliasTable, CompiledTable>();

function compile(table: AliasTable): CompiledTable {
  let compiled = compiledTables.get(table);
  if (compiled) {return compiled;}
  compiled = { exact: new Map(), scan: [], fallback: -1 };
  table.entries.forEach((entry, index) => {
    const m = entry.match;
    if (m.kind === "others") {
      if (compiled!.fallback < 0) {compiled!.fallback = index;}
    } else if (m.kind === "pattern" && !m.bits.includes("?")) {
      const key = stripLeadingZeros(m.bits);
      if (!compiled!.exact.has(key)) {compiled!.exact.set(key, index);}
    } else {
      compiled!.scan.push({ index, match: m });
    }
  });
  compiledTables.set(table, compiled);
  return compiled;
}

// Returns the alias entry for a binary value string (MSB first), or undefined.
// The first matching entry in file order wins; "others" only covers 0/1 values.
export function lookupAlias(table: AliasTable, binaryValue: string): AliasEntry | undefined {
  const value = binaryValue.toLowerCase();
  const is2State = /^[01]+$/.test(value);
  const compiled = compile(table);
  let best = compiled.exact.get(stripLeadingZeros(value)) ?? Infinity;
  let numeric: bigint | undefined;
  for (const item of compiled.scan) {
    if (item.index > best) {break;}
    const m = item.match;
    let hit = false;
    if (m.kind === "range") {
      if (!is2State) {continue;}
      numeric = numeric ?? BigInt("0b" + value);
      hit = numeric >= m.lo && numeric <= m.hi;
    } else if (m.kind === "pattern") {
      hit = matchWildcard(m.bits, value);
    }
    if (hit) {best = item.index; break;}
  }
  if (best !== Infinity) {return table.entries[best];}
  return is2State && compiled.fallback >= 0 ? table.entries[compiled.fallback] : undefined;
}

// Hex with VaporView's 4-state convention: a nibble holding z shows z, any other
// non-0/1 shows x.
function hexDisplay(bits: string): string {
  if (/^[01]+$/.test(bits)) {return BigInt("0b" + bits).toString(16);}
  let out = "";
  for (let end = bits.length; end > 0; end -= 4) {
    const chunk = bits.slice(Math.max(0, end - 4), end);
    if (chunk.includes("z")) {out = "z" + out;}
    else if (/[^01]/.test(chunk)) {out = "x" + out;}
    else {out = parseInt(chunk, 2).toString(16) + out;}
  }
  return out;
}

function radixString(bits: string, radix: string | undefined): string {
  const r = (radix || "hex").toLowerCase();
  if (/[^01]/.test(bits)) {return r.startsWith("bin") ? bits : "*";}
  const n = BigInt("0b" + (bits || "0"));
  if (r.startsWith("bin")) {return bits;}
  if (r.startsWith("oct")) {return n.toString(8);}
  if (r.startsWith("dec") || r === "unsigned") {return n.toString(10);}
  return n.toString(16);
}

// Formats a value with a named table. Unknown table or unmatched value: hex (with x/z
// nibbles). Slice fields that hold x/z show "*", as in Verdi.
export function formatWithTable(tables: Map<string, ValueTable>, tableName: string, binaryValue: string): string {
  const value = binaryValue.toLowerCase();
  const table = tables.get(tableName);
  if (table === undefined) {return hexDisplay(value);}
  if (table.kind === "alias") {
    const entry = lookupAlias(table, value);
    return entry ? entry.name : hexDisplay(value);
  }
  const width = value.length;
  const parts: string[] = [];
  for (const slice of table.slices) {
    const hi = Math.max(slice.msb, slice.lsb);
    const lo = Math.min(slice.msb, slice.lsb);
    if (hi >= width) {parts.push("*"); continue;}
    let bits = value.slice(width - 1 - hi, width - lo);
    if (slice.msb < slice.lsb) {bits = bits.split("").reverse().join("");}
    const sub = slice.table !== undefined ? tables.get(slice.table) : undefined;
    if (sub && sub.kind === "alias") {
      const entry = lookupAlias(sub, bits);
      parts.push(entry ? entry.name : radixString(bits, slice.radix));
    } else {
      parts.push(radixString(bits, slice.radix));
    }
  }
  return parts.join(" ");
}

// #region Verdi alias file
interface Token { text: string; quoted: boolean }

// Splits a line into tokens, honoring double quotes. An unquoted token starting with
// "#" or "//" after the first token starts a trailing comment, except a final
// "#rgb"-style token, which is a color.
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const t = m[2];
    const isColor = t !== undefined && HEX_COLOR.test(t) && line.slice(re.lastIndex).trim() === "";
    if (t !== undefined && tokens.length > 0 && !isColor && (t.startsWith("#") || t.startsWith("//"))) {break;}
    tokens.push(m[1] !== undefined ? { text: m[1], quoted: true } : { text: m[2], quoted: false });
  }
  return tokens;
}

const RADIX_NAMES = /^(hex|hexadecimal|bin|binary|oct|octal|dec|decimal|unsigned|signed)$/i;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const VERDI_COLOR = /^(ID_\w+|NULL|#[0-9a-f]{3,8})$/i;

// Verdi signal paths look like /top/u_cpu/instr[31:0]; VaporView uses top.u_cpu.instr.
export function normalizeSignalPath(path: string): string {
  let p = path.trim();
  if (p.endsWith("]")) {
    const open = p.lastIndexOf("[");
    if (open >= 0) {p = p.slice(0, open);}
  }
  return p.replace(/^\/+/, "").replace(/\//g, ".");
}

function parseSliceLine(tokens: string[], warnings: string[], where: string): SliceDef | null {
  const range = (tokens[0] ?? "").replace(/\s+/g, "");
  const m = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(range);
  if (!m) {warnings.push(`${where}: bad slice range "${tokens[0] ?? ""}"`); return null;}
  const msb = parseInt(m[1]);
  const lsb = m[2] !== undefined ? parseInt(m[2]) : msb;
  const target = tokens[1];
  if (target === undefined) {return { msb, lsb };}
  if (RADIX_NAMES.test(target)) {return { msb, lsb, radix: target };}
  return { msb, lsb, table: target };
}

function parseEntry(tokens: string[], bareRadix: BareRadix, colorRe: RegExp, warnings: string[], where: string): AliasEntry | null {
  const name = tokens[0];
  const rest = tokens.slice(1);
  let color: string | undefined;
  if (rest.length > 1 && colorRe.test(rest[rest.length - 1])) {
    color = rest.pop();
    if (color?.toUpperCase() === "NULL") {color = undefined;}
  }
  if (rest.length === 0) {warnings.push(`${where}: "${name}" has no value`); return null;}
  const match = parseMatcher(rest.join(""), bareRadix);
  if (match === null) {
    warnings.push(`${where}: cannot parse value "${rest.join(" ")}" (Verilog literal, lo~hi or others; at most ${MAX_VALUE_BITS} bits)`);
    return null;
  }
  return color ? { name, match, color } : { name, match };
}

// Verdi resource (.rc) files hold many other commands; only alias lines are read.
function parseVerdiResourceFile(text: string, bareRadix: BareRadix): ParsedAliasFile {
  const tables = new Map<string, ValueTable>();
  const bindings: AliasBinding[] = [];
  const warnings: string[] = [];
  let current: ValueTable | undefined;
  let pendingBinding: string | undefined;
  text.split(/\r?\n/).forEach((raw, i) => {
    const where = `line ${i + 1}`;
    const tokens = tokenize(raw.trim()).map((t) => t.text);
    if (tokens.length === 0) {return;}
    switch (tokens[0].toLowerCase()) {
      case "aliasmapname":
        if (tokens.length === 2) {current = { kind: "alias", name: tokens[1], entries: [] }; tables.set(tokens[1], current);}
        return;
      case "slicemapname":
        if (tokens.length === 2) {current = { kind: "slice", name: tokens[1], slices: [] }; tables.set(tokens[1], current);}
        return;
      case "nalias": {
        if (current?.kind !== "alias") {warnings.push(`${where}: nalias outside aliasmapname`); return;}
        const entry = parseEntry(tokens.slice(1), bareRadix, VERDI_COLOR, warnings, where);
        if (entry) {current.entries.push(entry);}
        return;
      }
      case "nslice": {
        if (current?.kind !== "slice") {warnings.push(`${where}: nslice outside slicemapname`); return;}
        const def = parseSliceLine(tokens.slice(1), warnings, where);
        if (def) {current.slices.push(def);}
        return;
      }
      case "condaliasmapname":
        warnings.push(`${where}: conditional alias "${tokens[1] ?? ""}" is not supported, skipped`);
        return;
      case "aliasname":
        if (tokens.length === 2) {pendingBinding = tokens[1];}
        return;
      case "addsignal":
        // aliasname applies to the next signal only.
        if (pendingBinding !== undefined && tokens.length >= 2) {
          bindings.push({ signal: normalizeSignalPath(tokens[tokens.length - 1]), table: pendingBinding });
          pendingBinding = undefined;
        }
        return;
    }
  });
  return { tables: [...tables.values()], bindings, warnings };
}

export function parseVerdiAliasFile(text: string, opts: AliasParseOptions = {}): ParsedAliasFile {
  const bareRadix = opts.bareRadix ?? "hex";
  if (opts.resourceFile) {return parseVerdiResourceFile(text, bareRadix);}

  const tables = new Map<string, ValueTable>();
  const warnings: string[] = [];
  let defaultTable: string | undefined;
  let current: ValueTable | undefined;
  let currentIsBareBlock = false; // opened by a bare name line: no end keyword
  let currentIsRcBlock = false;   // opened by aliasmapname/slicemapname: rows are nalias/nslice
  let skipping = false;           // inside condAlias
  let pendingBinding: string | undefined;
  const bindings: AliasBinding[] = [];

  const begin = (kind: "alias" | "slice", name: string, bare: boolean) => {
    const table: ValueTable = kind === "alias" ? { kind, name, entries: [] } : { kind, name, slices: [] };
    tables.set(name, table);
    current = table;
    currentIsBareBlock = bare;
    currentIsRcBlock = false;
  };
  const implicitTable = () => {
    const name = opts.name ?? "alias";
    if (!tables.has(name)) {tables.set(name, { kind: "alias", name, entries: [] });}
    return tables.get(name) as AliasTable;
  };

  text.split(/\r?\n/).forEach((raw, i) => {
    const where = `line ${i + 1}`;
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) {return;}
    const tokenObjs = tokenize(line);
    const tokens = tokenObjs.map((t) => t.text);
    // Keywords only count when unquoted, with the right number of arguments, and
    // (for block starts) outside an explicit block. So inside "alias t ... endalias"
    // a line "alias 3" is an entry named alias, and "slice 7:0 x" is an entry too.
    const key = tokenObjs[0].quoted ? "" : tokens[0].toLowerCase();
    const n = tokens.length;

    if (skipping) {
      if (key === "endcondalias" && n === 1) {skipping = false;}
      return;
    }

    // Resource-file alias lines (aliasmapname/nalias, slicemapname/nslice, aliasname +
    // addSignal) may be mixed into an alias file. An rc block ends at the first line
    // that is not one of its rows.
    if (currentIsRcBlock) {
      if (key === "nalias" && n >= 3 && current?.kind === "alias") {
        const entry = parseEntry(tokens.slice(1), bareRadix, VERDI_COLOR, warnings, where);
        if (entry) {current.entries.push(entry);}
        return;
      }
      if (key === "nslice" && n >= 2 && current?.kind === "slice") {
        const def = parseSliceLine(tokens.slice(1), warnings, where);
        if (def) {current.slices.push(def);}
        return;
      }
      current = undefined;
      currentIsRcBlock = false;
    }
    if (current === undefined || currentIsBareBlock) {
      if (n === 2 && (key === "aliasmapname" || key === "slicemapname")) {
        begin(key === "aliasmapname" ? "alias" : "slice", tokens[1], false);
        currentIsRcBlock = true;
        return;
      }
      if (n === 2 && key === "aliasname") {pendingBinding = tokens[1]; return;}
      if (key === "addsignal" && n >= 2 && pendingBinding !== undefined) {
        bindings.push({ signal: normalizeSignalPath(tokens[n - 1]), table: pendingBinding });
        pendingBinding = undefined;
        return;
      }
      if (key === "condaliasmapname" || key === "ncondalias") {
        warnings.push(`${where}: conditional alias is not supported, skipped`);
        return;
      }
    }
    if (n === 1 && (key === "endalias" || key === "endslice")) {current = undefined; currentIsBareBlock = false; return;}
    if (n === 2 && (key === "alias" || key === "slice") && (current === undefined || currentIsBareBlock)) {
      begin(key, tokens[1], false);
      return;
    }
    if (n === 2 && key === "condalias" && (current === undefined || currentIsBareBlock)) {
      warnings.push(`${where}: conditional alias "${tokens[1]}" is not supported, skipped`);
      skipping = true;
      current = undefined;
      return;
    }
    if (n === 2 && key === "curaliastable" && (current === undefined || currentIsBareBlock)) {defaultTable = tokens[1]; return;}

    if (current?.kind === "slice") {
      const def = parseSliceLine(tokens, warnings, where);
      if (def) {current.slices.push(def);}
      return;
    }

    if (n === 1) {
      // Older block style: a name alone on a line starts a table. Inside an explicit
      // alias block it is an entry with its value missing.
      if (current === undefined || currentIsBareBlock) {begin("alias", tokens[0], true);}
      else {warnings.push(`${where}: "${tokens[0]}" has no value`);}
      return;
    }

    const entry = parseEntry(tokens, bareRadix, VERDI_COLOR, warnings, where);
    if (entry === null) {return;}
    const table = current?.kind === "alias" ? current : implicitTable();
    table.entries.push(entry);
  });
  if (current !== undefined && !currentIsBareBlock && !currentIsRcBlock) {warnings.push(`"${current.name}" has no end keyword`);}

  return { tables: [...tables.values()], bindings, defaultTable, warnings };
}

// #region JSON and CSV
function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function entriesFromJson(map: unknown, bareRadix: BareRadix, tableName: string, warnings: string[]): AliasEntry[] {
  const out: AliasEntry[] = [];
  const add = (value: unknown, name: unknown, color?: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") {warnings.push(`${tableName}: entry without a value`); return;}
    const match = parseMatcher(String(value), bareRadix);
    if (match === null) {warnings.push(`${tableName}: cannot parse value "${value}"`); return;}
    const entry: AliasEntry = { name: String(name ?? ""), match };
    if (typeof color === "string" && color !== "") {entry.color = color;}
    out.push(entry);
  };
  if (Array.isArray(map)) {
    for (const item of map) {
      if (isObject(item)) {add(item.value, item.name ?? item.alias, item.color);}
      else {warnings.push(`${tableName}: list items must be objects`);}
    }
  } else if (isObject(map)) {
    for (const [value, name] of Object.entries(map)) {add(value, name);}
  } else {
    warnings.push(`${tableName}: a table must be an object or a list`);
  }
  return out;
}

export function parseJsonAliasFile(text: string, opts: AliasParseOptions = {}): ParsedAliasFile {
  const bareRadix = opts.bareRadix ?? "dec";
  const warnings: string[] = [];
  const tables: ValueTable[] = [];
  const bindings: AliasBinding[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { tables, bindings, warnings: [`invalid JSON: ${(err as Error).message}`] };
  }
  if (!isObject(data)) {return { tables, bindings, warnings: ["JSON alias file must be an object"] };}

  const hasTables = data.tables !== undefined;
  const tablesObj = hasTables ? data.tables : data;
  if (isObject(tablesObj)) {
    for (const [name, map] of Object.entries(tablesObj)) {
      if (!hasTables && (name === "signals" || name === "slices")) {continue;}
      tables.push({ kind: "alias", name, entries: entriesFromJson(map, bareRadix, name, warnings) });
    }
  } else {
    warnings.push(`"tables" must be an object`);
  }
  if (data.slices !== undefined) {
    if (isObject(data.slices)) {
      for (const [name, list] of Object.entries(data.slices)) {
        const slices: SliceDef[] = [];
        if (!Array.isArray(list)) {warnings.push(`slice ${name}: must be a list`); continue;}
        for (const s of list) {
          if (!isObject(s)) {warnings.push(`slice ${name}: items must be objects`); continue;}
          const target = s.table ?? s.radix;
          const def = parseSliceLine([String(s.range ?? ""), ...(target !== undefined ? [String(target)] : [])], warnings, `slice ${name}`);
          if (def) {slices.push(def);}
        }
        tables.push({ kind: "slice", name, slices });
      }
    } else {
      warnings.push(`"slices" must be an object`);
    }
  }
  if (data.signals !== undefined) {
    if (isObject(data.signals)) {
      for (const [signal, table] of Object.entries(data.signals)) {
        bindings.push({ signal: normalizeSignalPath(signal), table: String(table) });
      }
    } else {
      warnings.push(`"signals" must be an object`);
    }
  }
  return { tables, bindings, warnings };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {cur += '"'; i++;}
      else if (ch === '"') {quoted = false;}
      else {cur += ch;}
    } else if (ch === '"') {quoted = true;}
    else if (ch === ",") {out.push(cur.trim()); cur = "";}
    else {cur += ch;}
  }
  out.push(cur.trim());
  return out;
}

export function parseCsvAliasFile(text: string, opts: AliasParseOptions = {}): ParsedAliasFile {
  const bareRadix = opts.bareRadix ?? "dec";
  const defaultName = opts.name ?? "alias";
  const warnings: string[] = [];
  const tables = new Map<string, AliasTable>();
  const bindings = new Map<string, string>();
  // Keep the original line numbers for warnings.
  const lines = text.split(/\r?\n/)
    .map((l, i) => ({ text: l.trim(), lineNo: i + 1 }))
    .filter((l) => l.text !== "" && !l.text.startsWith("#"));
  let cols: Record<string, number> | undefined;
  if (lines.length) {
    const head = splitCsvLine(lines[0].text).map((h) => h.toLowerCase());
    if (head.includes("value") && (head.includes("name") || head.includes("alias"))) {
      cols = {};
      head.forEach((h, i) => {cols![h === "alias" ? "name" : h] = i;});
      lines.shift();
    }
  }
  for (const { text: line, lineNo } of lines) {
    const where = `line ${lineNo}`;
    const f = splitCsvLine(line);
    let table = defaultName;
    let value: string | undefined, name: string | undefined, color: string | undefined;
    if (cols) {
      value = f[cols.value]; name = f[cols.name];
      color = cols.color !== undefined ? f[cols.color] : undefined;
      if (cols.signal !== undefined && f[cols.signal]) {
        const signal = normalizeSignalPath(f[cols.signal]);
        table = cols.table !== undefined && f[cols.table] ? f[cols.table] : signal;
        bindings.set(signal, table);
      } else if (cols.table !== undefined && f[cols.table]) {
        table = f[cols.table];
      }
    } else if (f.length === 3 && HEX_COLOR.test(f[2]) && parseMatcher(f[0], bareRadix) !== null) {
      [value, name, color] = f;          // value,name,#color
    } else if (f.length >= 4) {
      [table, value, name, color] = f;   // table,value,name,color
    } else if (f.length === 3) {
      [table, value, name] = f;
    } else {
      [value, name] = f;
    }
    if (!value || name === undefined) {warnings.push(`${where}: expected value and name`); continue;}
    const match = parseMatcher(value, bareRadix);
    if (match === null) {warnings.push(`${where}: cannot parse value "${value}"`); continue;}
    if (!tables.has(table)) {tables.set(table, { kind: "alias", name: table, entries: [] });}
    tables.get(table)!.entries.push(color ? { name, match, color } : { name, match });
  }
  return {
    tables: [...tables.values()],
    bindings: [...bindings.entries()].map(([signal, table]) => ({ signal, table })),
    warnings,
  };
}

// Picks the parser from the file name (.json, .csv; anything else is a Verdi alias
// or resource file). Never throws.
export function parseAliasFile(text: string, fileName: string, opts: AliasParseOptions = {}): ParsedAliasFile {
  const base = fileName.replace(/^.*[\\/]/, "");
  const name = opts.name ?? base.replace(/\.[^.]*$/, "");
  const lower = base.toLowerCase();
  const pre: string[] = [];
  let bareRadix = opts.bareRadix;
  if (bareRadix !== undefined && !BARE_RADIXES.includes(bareRadix)) {
    pre.push(`unknown bareRadix "${bareRadix}" (use hex, dec, bin or oct); using the default`);
    bareRadix = undefined;
  }
  const o = { name, bareRadix, resourceFile: lower.endsWith(".rc") };
  let parsed: ParsedAliasFile;
  try {
    if (lower.endsWith(".json")) {parsed = parseJsonAliasFile(text, o);}
    else if (lower.endsWith(".csv")) {parsed = parseCsvAliasFile(text, o);}
    else {parsed = parseVerdiAliasFile(text, o);}
  } catch (err) {
    parsed = { tables: [], bindings: [], warnings: [`could not parse ${base}: ${String(err)}`] };
  }
  parsed.warnings.unshift(...pre);
  return parsed;
}
