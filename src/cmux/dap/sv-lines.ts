// vscode-port P4: the textual parts of the debugger's line breakpoints and editor highlights, ported from cmux
// (WaveformLineBreakpoint.watchedSignals, SystemVerilogAssignmentScanner in HierarchyPathMapping.swift) plus a small
// module scanner. cmux takes a line's module and identifiers from its SystemVerilog inline scan; slang integration
// lives in the source link, so this is the fallback: modules, ports and declarations parsed from the file's text.

const KEYWORDS = new Set(`accept_on alias always always_comb always_ff always_latch and assert assign assume automatic before begin bind
bins binsof bit break buf bufif0 bufif1 byte case casex casez cell chandle checker class clocking cmos config const constraint
context continue cover covergroup coverpoint cross deassign default defparam design disable dist do edge else end endcase
endchecker endclass endclocking endconfig endfunction endgenerate endgroup endinterface endmodule endpackage endprimitive
endprogram endproperty endspecify endsequence endtable endtask enum event eventually expect export extends extern final
first_match for force foreach forever fork forkjoin function generate genvar global highz0 highz1 if iff ifnone ignore_bins
illegal_bins implements implies import incdir include initial inout input inside instance int integer interconnect interface
intersect join join_any join_none large let liblist library local localparam logic longint macromodule matches medium modport
module nand negedge nettype new nexttime nmos nor noshowcancelled not notif0 notif1 null or output package packed parameter
pmos posedge primitive priority program property protected pull0 pull1 pulldown pullup pulsestyle_ondetect pulsestyle_onevent
pure rand randc randcase randsequence rcmos real realtime ref reg reject_on release repeat restrict return rnmos rpmos rtran
rtranif0 rtranif1 s_always s_eventually s_nexttime s_until s_until_with scalared sequence shortint shortreal showcancelled
signed small soft solve specify specparam static string strong strong0 strong1 struct super supply0 supply1 sync_accept_on
sync_reject_on table tagged task this throughout time timeprecision timeunit tran tranif0 tranif1 tri tri0 tri1 triand trior
trireg type typedef union unique unique0 unsigned until until_with untyped use uwire var vectored virtual void wait wait_order
wand weak weak0 weak1 while wildcard wire with within wor xnor xor`.split(/\s+/));

export type Identifier = { name: string; column: number };

/** Strips // and /* *\/ comments (keeping columns: replaced by spaces) and string literals. `inBlock`: a block comment open at the line start. */
export function codeOf(line: string, inBlock = false): { code: string; inBlock: boolean } {
  let out = '';
  let i = 0;
  let block = inBlock;
  while (i < line.length) {
    if (block) {
      const end = line.indexOf('*/', i);
      if (end < 0) { out += ' '.repeat(line.length - i); i = line.length; break; }
      out += ' '.repeat(end + 2 - i); i = end + 2; block = false; continue;
    }
    const c = line[i];
    if (c === '/' && line[i + 1] === '/') { out += ' '.repeat(line.length - i); break; }
    if (c === '/' && line[i + 1] === '*') { block = true; out += '  '; i += 2; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') { j += line[j] === '\\' ? 2 : 1; }
      out += ' '.repeat(Math.min(line.length, j + 1) - i); i = j + 1; continue;
    }
    out += c; i++;
  }
  return { code: out, inBlock: block };
}

/** The identifiers a line's code names, in order (not keywords, system names, numbers' digits or based literals). */
export function identifiers(code: string): Identifier[] {
  const out: Identifier[] = [];
  const re = /\\\S+|[A-Za-z_][A-Za-z0-9_$]*|'[sS]?[bBoOdDhH]\s*[0-9a-fA-FxXzZ?_]+|\d[\d_]*|`[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const t = m[0];
    if (!/^[A-Za-z_]/.test(t) || KEYWORDS.has(t)) { continue; }
    // A member access after '.' or a scope after '::' is not a signal of its own.
    const before = code.slice(0, m.index).trimEnd();
    if (before.endsWith('.') || before.endsWith('::')) { continue; }
    out.push({ name: t, column: m.index });
  }
  return out;
}

// ---- SystemVerilogAssignmentScanner (cmux HierarchyPathMapping.swift), ported ----
const isIdent = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);

function isAssignmentOperator(s: string, index: number): boolean {
  const u = (o: number) => s[index + o] || '';
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

function isStatementStart(text: string): boolean {
  const prefix = text.trim();
  if (!prefix) { return true; }
  const last = prefix[prefix.length - 1];
  if (';):'.includes(last)) { return !prefix.endsWith('::'); }
  const words = prefix.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  const lastWord = words[words.length - 1] || '';
  return ['assign', 'begin', 'else', 'always_comb', 'always_latch', 'always', 'always_ff', 'initial', 'final'].includes(lastWord)
    && prefix.endsWith(lastWord);
}

function isTarget(s: string, start: number, end: number): boolean {
  let i = end;
  const skip = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) { i++; } };
  for (;;) {
    skip();
    if (i >= s.length) { return false; }
    if (s[i] === '[') {
      let depth = 0;
      while (i < s.length) {
        if (s[i] === '[') { depth++; }
        if (s[i] === ']') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      continue;
    }
    if (s[i] === '.') { i++; while (i < s.length && isIdent(s[i])) { i++; } continue; }
    break;
  }
  if (i >= s.length || !isAssignmentOperator(s, i)) { return false; }
  return isStatementStart(s.slice(0, start));
}

function unmatchedOpenBrace(s: string, before: number): number | null {
  let depth = 0;
  for (let i = before - 1; i >= 0; i--) {
    if (s[i] === '}') { depth++; } else if (s[i] === '{') { if (depth === 0) { return i; } depth--; }
  }
  return null;
}
function matchingCloseBrace(s: string, after: number): number | null {
  let depth = 0;
  for (let i = after; i < s.length; i++) {
    if (s[i] === '{') { depth++; } else if (s[i] === '}') { if (depth === 0) { return i; } depth--; }
  }
  return null;
}

/** True for `x = ...`, `x <= ...`, `x += ...`, `x++`, `x[3:0] <= ...`, `{x, y} = ...` at a statement start. */
export function isAssignmentTarget(line: string, column: number, length: number): boolean {
  if (column < 0 || length <= 0 || column + length > line.length) { return false; }
  if (isTarget(line, column, column + length)) { return true; }
  const open = unmatchedOpenBrace(line, column);
  const close = matchingCloseBrace(line, column + length);
  return open !== null && close !== null && isTarget(line, open, close + 1);
}

/** A declaration's initializer follows the name: a single `=` (not `==`, `<=`, `=>`). */
function isInitialized(s: string, end: number): boolean {
  let i = end;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) { i++; }
  if (s[i] !== '=') { return false; }
  return s[i + 1] !== '=' && s[i + 1] !== '>';
}

/** Targets of the line's assignments, else every identifier it reads, in order, each once (cmux watchedSignals). */
export function watchedSignals(code: string): string[] {
  const targets: string[] = [];
  const read: string[] = [];
  for (const id of identifiers(code)) {
    if (!read.includes(id.name)) { read.push(id.name); }
    const assigned = isAssignmentTarget(code, id.column, id.name.length) || isInitialized(code, id.column + id.name.length);
    if (assigned && !targets.includes(id.name)) { targets.push(id.name); }
  }
  return targets.length ? targets : read;
}

// ---- modules in a file ----
export type ModuleInfo = {
  name: string;
  /** 0-based lines of `module` and `endmodule`. */
  start: number;
  end: number;
  /** Port and declared signal names (for matching dump scopes). */
  ports: string[];
  declared: string[];
  /** vscode-port: the module instances it makes (`counter #(...) u1 (...)` on one line: type counter, name u1), so a
   *  dump path's modules can be told from the source (TextInstanceResolver.modulesAlong). */
  instances?: Array<{ type: string; name: string }>;
};

const NOT_TYPE = new Set(['if', 'else', 'case', 'casez', 'casex', 'for', 'foreach', 'while', 'repeat', 'forever', 'assign', 'always', 'always_ff',
  'always_comb', 'always_latch', 'initial', 'final', 'return', 'begin', 'end', 'function', 'task', 'module', 'endmodule', 'assert', 'assume',
  'cover', 'property', 'wait', 'disable', 'fork', 'join', 'generate', 'endgenerate', 'genvar', 'localparam', 'parameter', 'typedef', 'import',
  'export', 'default', 'unique', 'priority', 'automatic', 'static', 'new', 'void', 'posedge', 'negedge', 'or', 'and', 'not']);
const INSTANCE = /^\s*([A-Za-z_][A-Za-z0-9_$]*)(?:\s*#\s*\((?:[^()]|\([^()]*\))*\)\s*|\s+)([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\[[^\]]*\]\s*)?\(/;

const DECL = /^\s*(?:input|output|inout|wire|reg|logic|bit|integer|int|var|tri)\b/;

export function scanModules(text: string): ModuleInfo[] {
  const lines = text.split(/\r?\n/);
  const out: ModuleInfo[] = [];
  let cur: ModuleInfo | null = null;
  let inBlock = false;
  // The header (`module m import p::*; #(parameters) (ports);`), scanned character by character across lines:
  // package imports and the parameter list are skipped (a parameter, or a `parameter type` name, is not a port); the
  // header ends at the first ';' outside parentheses that does not end an import.
  let hdr: { depth: number; param: number; hash: boolean; imp: boolean; ports: string } | null = null;
  for (let n = 0; n < lines.length; n++) {
    const r = codeOf(lines[n], inBlock);
    inBlock = r.inBlock;
    const code = r.code;
    const m = /^\s*(?:macromodule|module)\s+(?:automatic\s+|static\s+)?([A-Za-z_][A-Za-z0-9_$]*)/.exec(code);
    let from = 0;
    if (m && !cur) {
      cur = { name: m[1], start: n, end: lines.length - 1, ports: [], declared: [], instances: [] };
      hdr = { depth: 0, param: 0, hash: false, imp: false, ports: '' };
      from = m.index + m[0].length;
    }
    if (!cur) { continue; }
    if (hdr) {
      for (let i = from; i < code.length && hdr; i++) {
        const c = code[i];
        if (hdr.imp) { if (c === ';') { hdr.imp = false; } continue; }
        if (hdr.param) { if (c === '(') { hdr.param++; } else if (c === ')') { hdr.param--; } continue; }
        if (hdr.depth === 0) {
          const w = /^import\b/.exec(code.slice(i));
          if (w && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]))) { hdr.imp = true; i += 5; continue; }
          if (c === '#') { hdr.hash = true; continue; }
          if (c === '(' && hdr.hash) { hdr.hash = false; hdr.param = 1; continue; }
          if (c === '(') { hdr.depth = 1; continue; }
          if (c === ';') { for (const p of portNames(hdr.ports)) { cur.ports.push(p); } hdr = null; break; }
          continue;
        }
        if (c === '(') { hdr.depth++; } else if (c === ')') { hdr.depth--; if (hdr.depth === 0) { continue; } }
        hdr.ports += c;
      }
      if (hdr) { hdr.ports += ' '; }
    } else if (DECL.test(code)) {
      const isPortLine = /^\s*(?:input|output|inout)\b/.test(code);
      for (const name of portNames(code.replace(/;.*$/, ''))) { (isPortLine ? cur.ports : cur.declared).push(name); }
    }
    if (!hdr && !DECL.test(code)) {
      const i = INSTANCE.exec(code);
      if (i && !NOT_TYPE.has(i[1]) && !NOT_TYPE.has(i[2])) { cur.instances!.push({ type: i[1], name: i[2] }); }
    }
    if (/\bendmodule\b/.test(code)) { cur.end = n; out.push(cur); cur = null; hdr = null; }
  }
  if (cur) { out.push(cur); }
  return out;
}

const PLAIN = /^(?:\\\S+|[A-Za-z_][A-Za-z0-9_$]*)$/;
// The names a port list or declaration declares: in each comma-separated item, the last plain identifier once ranges,
// initializers and parameter overrides are blanked (`input logic [7:0] a`, `output pkg::t_s b`, `my_t c = 0` give a, b,
// c: a type name is never taken for a port).
export function portNames(code: string): string[] {
  let s = code.replace(/\[[^\]]*\]/g, (x) => ' '.repeat(x.length));
  s = s.replace(/#\s*\([^)]*\)/g, (x) => ' '.repeat(x.length));
  s = s.replace(/=[^,;)]*/g, (x) => ' '.repeat(x.length));
  const out: string[] = [];
  for (const item of s.split(',')) {
    const ids = identifiers(item).map((i) => i.name).filter((x) => PLAIN.test(x) && !DECL_WORDS.has(x) && !KEYWORDS.has(x));
    if (ids.length) { out.push(ids[ids.length - 1]); }
  }
  return out;
}
const DECL_WORDS = new Set(['input', 'output', 'inout', 'ref', 'wire', 'reg', 'logic', 'bit', 'byte', 'integer', 'int', 'shortint', 'longint',
  'var', 'tri', 'signed', 'unsigned', 'const', 'interface', 'modport', 'type', 'parameter', 'localparam', 'real', 'string', 'time', 'struct', 'packed', 'enum', 'union']);


export function moduleAt(modules: ModuleInfo[], line: number): ModuleInfo | undefined {
  return modules.find((m) => line >= m.start && line <= m.end);
}

/** The code of every line, comments removed (block comments followed across lines). */
export function codeLines(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) { const r = codeOf(line, inBlock); inBlock = r.inBlock; out.push(r.code); }
  return out;
}

/** Lines of `mod` (0-based) that assign `name`, and the columns where `name` appears on each line of the module. */
export function signalLines(lines: string[], mod: ModuleInfo, names: Set<string>) {
  const drivers = new Map<string, number[]>();
  const uses: Array<{ line: number; column: number; name: string }> = [];
  for (let n = mod.start; n <= mod.end && n < lines.length; n++) {
    const code = lines[n];
    for (const id of identifiers(code)) {
      if (!names.has(id.name)) { continue; }
      uses.push({ line: n, column: id.column, name: id.name });
      if (isAssignmentTarget(code, id.column, id.name.length)) {
        const list = drivers.get(id.name) || [];
        if (!list.includes(n)) { list.push(n); }
        drivers.set(id.name, list);
      }
    }
  }
  return { drivers, uses };
}
