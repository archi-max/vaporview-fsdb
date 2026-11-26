// vscode-port: cmux's terminal-link patterns for VaporView's terminal link providers
// (src/extension_core/terminal_links.ts). GPL-3.0. Ported from cmux
// Packages/macOS/CmuxTerminalCore/Sources/CmuxTerminalCore/LinkRouting/WaveformTerminalLink.swift, itself adapted
// from VaporView's terminal_links.ts@59107c6.
//
// Differences from upstream VaporView, as cmux has them:
//  - an instance path must start at one of the dump's top scopes (any number of them; upstream matched any dotted
//    word once a dump had more than 16 tops), contain no '/', and not be a prefix of a longer dotted word;
//    a two-part name ending in a source or dump extension (`tb.sv`, `top.v`) is a file, not a path;
//  - a time must not start inside a word (`sim_100ns`, `v1.5ns` are not times); `µ`/`μ` read as `u`;
//  - `@ 50000` is in the dump's own units.

export interface FoundLink {
  startIndex: number;
  length: number;
  kind: 'uvm-timestamp' | 'timestamp-with-units' | 'netlist-element';
  time?: number;
  units?: string;
  path?: string;
}

const FILE_EXTENSIONS = new Set(['sv', 'svh', 'v', 'vh', 'vhd', 'vhdl', 'vcd', 'fst', 'fsdb', 'ghw', 'json', 'f', 'log', 'txt',
  'py', 'c', 'h', 'cc', 'cpp', 'hpp', 'tcl', 'do', 'sh', 'yml', 'yaml', 'md', 'gz', 'xml', 'html']);

const UVM = /@\s+(\d+)(?!\d)/g;
const WITH_UNITS = /(?<![\w,./-])(\d[\d,]*(?:\.\d+)?)\s*([kmµμunpf]?s)\b/g;

export function findTimeLinks(line: string): FoundLink[] {
  const out: FoundLink[] = [];
  for (const m of line.matchAll(UVM)) {
    const time = Number(m[1]);
    if (Number.isFinite(time)) { out.push({ startIndex: m.index!, length: m[0].length, kind: 'uvm-timestamp', time }); }
  }
  for (const m of line.matchAll(WITH_UNITS)) {
    const time = Number(m[1].replace(/,/g, ''));
    const units = m[2].replace(/[µμ]/g, 'u');
    if (Number.isFinite(time)) { out.push({ startIndex: m.index!, length: m[0].length, kind: 'timestamp-with-units', time, units }); }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathRegexes = new Map<string, RegExp>();

export function findPathLinks(line: string, topScopes: string[]): FoundLink[] {
  if (!topScopes.length) { return []; }
  const key = topScopes.join('\u0000');
  let re = pathRegexes.get(key);
  if (!re) {
    // A top scope, then `.name`, `.name[3:0]` or `.mem[3][2]` parts; never next to a word, '/' or '~', and never
    // a prefix of a longer dotted word.
    re = new RegExp('(?<![\\w$./~-])(?:' + topScopes.map(escape).join('|') + ')(?:\\.[\\w$]+(?:\\[\\d+(?::\\d+)?\\])*)+(?![\\w$/\\[]|\\.[\\w$])', 'g');
    if (pathRegexes.size >= 16) { pathRegexes.clear(); }
    pathRegexes.set(key, re);
  }
  const out: FoundLink[] = [];
  for (const m of line.matchAll(re)) {
    const parts = m[0].split('.');
    if (parts.length === 2 && FILE_EXTENSIONS.has(parts[1].toLowerCase())) { continue; }
    out.push({ startIndex: m.index!, length: m[0].length, kind: 'netlist-element', path: m[0] });
  }
  return out;
}

/** The live provider objects, for the e2e test command (vaporview.e2e.terminalLink). */
export const terminalLinkProviders = { timestamp: undefined as unknown, netlist: new Set<unknown>() };
