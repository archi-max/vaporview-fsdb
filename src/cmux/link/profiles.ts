// vscode-port: slang profiles (.f build files) for the SystemVerilog editor's profile chooser.
// Ported from cmux's SlangProfiles.swift, SlangServerConfigFile.swift, SlangWorkspaceRoot.swift and
// SystemVerilogModuleLocator.swift. Pure: no vscode import, so the unit tests run under plain node.
// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'node:fs';
import * as path from 'node:path';

// #region Build files
/** What a slang `.f` build file (command file) says, as far as the link needs: its top modules (`--top`), source
 *  files and nested command files. Options the link does not use are skipped with their values. */
export interface BuildFile { tops: string[]; sources: string[]; commandFiles: string[] }

/** Options whose value is the next word (slang's driver options the parser skips). */
const OPTIONS_WITH_VALUE = new Set([
  '--top', '-top', '-f', '-F', '-C', '-I', '--include-directory', '--isystem', '-D', '--define-macro',
  '-U', '--undefine-macro', '-y', '--libdir', '-Y', '--libext', '-v', '--libfile', '-G', '-T',
  '--timing', '--timescale', '--std', '--compat', '-W', '--max-errors', '--error-limit', '-j', '--threads',
  '--suppress-warnings', '--suppress-macro-warnings', '--translate-off-format', '-L', '--defaultLibName',
  '--map-keyword-version', '--max-include-depth', '--max-parse-depth', '--max-lexer-errors',
]);

export function parseBuildFile(text: string): BuildFile {
  const result: BuildFile = { tops: [], sources: [], commandFiles: [] };
  const ws = buildFileWords(text);
  let i = 0;
  while (i < ws.length) {
    const word = ws[i++];
    if (word.startsWith('+')) { continue; } // +define+, +incdir+, +libext+
    const eq = word.indexOf('=');
    if (eq > 0 && word.startsWith('-')) {
      const option = word.slice(0, eq), value = word.slice(eq + 1);
      if (option === '--top' || option === '-top') { result.tops.push(value); }
      if (option === '-f' || option === '-F') { result.commandFiles.push(value); }
      continue;
    }
    if (word.startsWith('-')) {
      if (!OPTIONS_WITH_VALUE.has(word) || i >= ws.length) { continue; }
      const value = ws[i++];
      if (word === '--top' || word === '-top') { result.tops.push(value); }
      if (word === '-f' || word === '-F') { result.commandFiles.push(value); }
      continue;
    }
    result.sources.push(word);
  }
  return result;
}

/** Words of a command file: `//`, `#` and `/* *\/` comments dropped, quotes grouping words, a backslash escaping the
 *  next character (so `\"` stays a quote inside a define), and a backslash at a line end continuing the line. */
export function buildFileWords(text: string): string[] {
  const words: string[] = [];
  let current = '', hasWord = false;
  let quote: string | undefined;
  const chars = text + '\n';
  let i = 0;
  const finish = () => { if (hasWord) { words.push(current); } current = ''; hasWord = false; };
  const isNewline = (c: string) => c === '\n' || c === '\r';
  while (i < chars.length) {
    const c = chars[i];
    const next: string | undefined = chars[i + 1];
    if (quote !== undefined) {
      if (c === '\\' && next !== undefined) { current += next; i += 2; continue; }
      if (c === quote) { quote = undefined; } else { current += c; }
      i++;
      continue;
    }
    if ((c === '/' && next === '/') || (c === '#' && !hasWord)) {
      while (i < chars.length && !isNewline(chars[i])) { i++; }
      finish();
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i + 1 < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) { i++; }
      i += 2;
      finish();
      continue;
    }
    if (/\s/.test(c)) { finish(); i++; continue; }
    if (c === '\\' && next !== undefined) {
      if (next === '\n') { finish(); i += 2; continue; }
      if (next === '\r') { finish(); i += chars[i + 2] === '\n' ? 3 : 2; continue; }
      current += next; hasWord = true; i += 2;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; hasWord = true; i++; continue; }
    current += c; hasWord = true; i++;
  }
  return words;
}

/** Source files (absolute, resolved against `baseDirectory`) that are not under `root`: a build file of another
 *  checkout or worktree. */
export function sourcesOutside(file: BuildFile, root: string, baseDirectory: string): string[] {
  const prefix = root.endsWith('/') ? root : root + '/';
  const out: string[] = [];
  for (const s of file.sources) {
    const p = path.posix.normalize(s.startsWith('/') ? s : path.posix.join(baseDirectory, s));
    if (!(p.startsWith(prefix) || p === root)) { out.push(p); }
  }
  return out;
}

/** A path as one word of a slang command file: quoted when it has white space, quotes or backslashes. */
export function quotedBuildFileWord(p: string): string {
  if (!/[\s"'\\]/.test(p)) { return p; }
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** The text of a new profile: `--top <module>` and the file it is declared in. */
export function newProfileText(module: string, sourcePath: string): string {
  return `// slang profile: a slang command file (see slang --help).\n--top ${module}\n${quotedBuildFileWord(sourcePath)}\n`;
}

// #region Profiles
/** A `.f` build file offered as a slang-server profile. */
export interface Profile { path: string; buildFile: BuildFile }

export function profileName(p: Profile | string): string {
  const file = typeof p === 'string' ? p : p.path;
  return path.basename(file).replace(/\.f$/, '');
}

/** Workspace `.f` files are looked for this deep, and at most this many are listed. */
export const WORKSPACE_SEARCH_DEPTH = 4;
export const WORKSPACE_SEARCH_LIMIT = 40;
/** Bytes read of each `.f` / config file. */
export const READ_LIMIT = 65536;

export function projectName(root: string): string { return path.basename(root); }
/** The user's profile folder for the project: `~/.config/cmux-slang/<project>` (shared with cmux). */
export function userProfileDirectory(root: string, home: string): string {
  return path.join(home, '.config/cmux-slang', projectName(root));
}
export function repoProfileDirectory(root: string): string { return path.join(root, '.slang'); }
/** True for a profile kept in `.slang/` or the user's profile folder (preferred over stray workspace `.f` files). */
export function isKeptProfile(p: Profile): boolean {
  return p.path.includes('/.slang/') || p.path.includes('/.config/cmux-slang/');
}

export interface ConfigFound { path: string; health: ConfigHealth }
export interface Listing { profiles: Profile[]; configs: ConfigFound[] }

function readHead(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(READ_LIMIT);
    const n = fs.readSync(fd, buf, 0, READ_LIMIT, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return undefined; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Profiles and config files of `root`, the same listing cmux makes: `<root>/.slang/*.f`,
 *  `~/.config/cmux-slang/<project>/*.f`, `~/.config/cmux-slang/<project>.f`, then `.f` files in the workspace up to
 *  WORKSPACE_SEARCH_DEPTH deep (hidden folders and node_modules skipped, at most WORKSPACE_SEARCH_LIMIT); configs are
 *  `<root>/.slang/server.json` and `<root>/.slang/local/server.json`. */
export function listProfiles(root: string, home: string): Listing {
  const paths: string[] = [];
  const add = (p: string) => { const n = path.normalize(p); if (!paths.includes(n)) { paths.push(n); } };
  for (const dir of [repoProfileDirectory(root), userProfileDirectory(root, home)]) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).sort(); } catch { /* none */ }
    for (const n of names) { if (n.endsWith('.f') && isFile(path.join(dir, n))) { add(path.join(dir, n)); } }
  }
  const single = userProfileDirectory(root, home) + '.f';
  if (isFile(single)) { add(single); }
  let found = 0;
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (found >= WORKSPACE_SEARCH_LIMIT) { return; }
      if (e.name.startsWith('.') || e.name === 'node_modules') { continue; }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (level < WORKSPACE_SEARCH_DEPTH) { walk(p, level + 1); } continue; }
      if (e.name.endsWith('.f') && (e.isFile() || isFile(p))) { found++; add(p); }
    }
  };
  walk(root, 1);
  const profiles: Profile[] = [];
  for (const p of paths) {
    const text = readHead(p);
    if (text !== undefined) { profiles.push({ path: p, buildFile: parseBuildFile(text) }); }
  }
  const configs: ConfigFound[] = [];
  for (const rel of ['.slang/server.json', CONFIG_RELATIVE_PATH]) {
    const p = path.join(root, rel);
    if (isFile(p)) { configs.push({ path: p, health: configHealth(readHead(p)) }); }
  }
  return { profiles, configs };
}

/** The profile whose `--top` names one of the waveform's top scopes, or a scope just below one (a simulator wrapper
 *  such as `TOP`). Undefined when none, or several equally, match (kept profiles win over stray workspace `.f`). */
export function profileMatchingDumpTops(tops: string[], children: Record<string, string[]>, profiles: Profile[]): Profile | undefined {
  for (const names of [tops, tops.flatMap((t) => children[t] ?? [])]) {
    const set = new Set(names);
    const matches = profiles.filter((p) => p.buildFile.tops.some((t) => set.has(t)));
    if (matches.length === 1) { return matches[0]; }
    if (matches.length > 1) {
      const preferred = matches.filter(isKeptProfile);
      return preferred.length === 1 ? preferred[0] : undefined;
    }
  }
  return undefined;
}

// #region server.json
/** Where a build file is written when the server has no `slang.setBuildFile`: the workspace's local overrides. */
export const CONFIG_RELATIVE_PATH = '.slang/local/server.json';
export type ConfigHealth = 'missing' | 'empty' | 'invalid' | 'valid';

const isBlank = (s: string) => /^[ \n\r\t]*$/.test(s);

/** slang-server reads its configs with comments and trailing commas allowed (JSON5-like). */
export function parseLooseJson(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') { j += text[j] === '\\' ? 2 : 1; }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { i++; } continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function configHealth(text: string | undefined): ConfigHealth {
  if (text === undefined) { return 'missing'; }
  if (isBlank(text)) { return 'empty'; }
  try {
    const v = parseLooseJson(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? 'valid' : 'invalid';
  } catch { return 'invalid'; }
}

export class NotAJsonObject extends Error { constructor() { super('the config file is not a JSON object; left unchanged'); } }

/** `existing` (undefined or blank: no file yet) with "build" set to `buildPath`, or removed when undefined. Every other
 *  key is kept; a file that is not a JSON object throws NotAJsonObject (never overwritten). */
export function settingBuild(buildPath: string | undefined, existing: string | undefined): string {
  let object: Record<string, unknown> = {};
  if (existing !== undefined && !isBlank(existing)) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { throw new NotAJsonObject(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new NotAJsonObject(); }
    object = parsed as Record<string, unknown>;
  }
  if (buildPath !== undefined) { object.build = buildPath; } else { delete object.build; }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(object).sort()) { sorted[k] = object[k]; }
  return JSON.stringify(sorted, null, 2) + '\n';
}

/** The "build" value of a config file, if it names one. */
export function buildIn(text: string | undefined): string | undefined {
  if (text === undefined) { return undefined; }
  try { const o = JSON.parse(text); return typeof o?.build === 'string' ? o.build : undefined; } catch { return undefined; }
}

/** `text` with `line` added as its own line; undefined when it has the line already (for .git/info/exclude). */
export function addingLine(line: string, text: string): string | undefined {
  if (text.split(/\r?\n/).includes(line)) { return undefined; }
  return text + (text === '' || text.endsWith('\n') ? '' : '\n') + line + '\n';
}

// #region Workspace root
/** Picks the folder slang-server treats as a file's workspace root: the nearest ancestor with `.slang/server.json`,
 *  else the nearest with `.git` (a folder, or a file in a worktree). The home folder and top-level folders (`/tmp`,
 *  `/home`) never count. */
export interface Markers { config: Set<string>; git: Set<string>; home?: string }

const stdPath = (p: string) => { const n = path.posix.normalize(p); return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n; };

/** The file's folder, then each parent up to (not including) `/`. */
export function ancestors(file: string): string[] {
  const out: string[] = [];
  let dir = path.posix.dirname(stdPath(file));
  while (dir && dir !== '/' && dir !== '.') {
    out.push(dir);
    const parent = path.posix.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return out;
}

export function workspaceRoot(file: string, markers: Markers): string | undefined {
  const home = markers.home !== undefined ? stdPath(markers.home) : undefined;
  const candidates = ancestors(file).filter((d) => d !== home && d.split('/').filter(Boolean).length >= 2);
  return candidates.find((d) => markers.config.has(d)) ?? candidates.find((d) => markers.git.has(d));
}

export function localMarkers(file: string, home: string): Markers {
  const m: Markers = { config: new Set(), git: new Set(), home };
  for (const d of ancestors(file)) {
    if (fs.existsSync(d + '/.slang/server.json')) { m.config.add(d); }
    if (fs.existsSync(d + '/.git')) { m.git.add(d); }
  }
  return m;
}

// #region Module at the caret
/** A SystemVerilog `module` declaration: name, offset of its `module` keyword, offset just past `endmodule` (or the
 *  text's end when unclosed). */
export interface ModuleDeclaration { name: string; keywordOffset: number; endOffset: number }

const isIdStart = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const isIdPart = (c: number) => isIdStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x24;
const isSpaceCode = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;

/** Every module declaration of `text`, in source order of their headers. Comments, strings, `define bodies, `extern
 *  module` prototypes and the second header of a module split by `ifdef are skipped; interfaces, programs and
 *  packages are not modules. */
export function moduleDeclarations(text: string): ModuleDeclaration[] {
  const open: ModuleDeclaration[] = [], done: ModuleDeclaration[] = [];
  let pendingKeyword: number | undefined;
  let inPrototype = false;
  const count = text.length;
  const at = (k: number) => (k < count ? text.charCodeAt(k) : 0);
  const idEnd = (from: number) => { let e = from; while (e < count && isIdPart(at(e))) { e++; } return e; };
  const openModule = (name: string, keyword: number) => {
    if (!name || open[open.length - 1]?.name === name) { return; }
    open.push({ name, keywordOffset: keyword, endOffset: keyword });
  };
  let i = 0;
  while (i < count) {
    const u = at(i), n = at(i + 1);
    if (u === 0x2f && n === 0x2f) { while (i < count && at(i) !== 0x0a) { i++; } continue; }
    if (u === 0x2f && n === 0x2a) {
      i += 2; while (i < count && !(at(i) === 0x2a && at(i + 1) === 0x2f)) { i++; } i = Math.min(count, i + 2); continue;
    }
    if (u === 0x28 && n === 0x2a && i + 2 < count && at(i + 2) !== 0x29) { // (* attribute *), not @(*)
      i += 2; while (i < count && !(at(i) === 0x2a && at(i + 1) === 0x29)) { i++; } i = Math.min(count, i + 2); continue;
    }
    if (u === 0x22) { i++; while (i < count && at(i) !== 0x22 && at(i) !== 0x0a) { i += at(i) === 0x5c ? 2 : 1; } i++; continue; }
    if (u === 0x60) { // `directive
      const we = idEnd(i + 1);
      if (text.slice(i + 1, we) === 'define') {
        let le = we;
        while (le < count) {
          if (at(le) === 0x0a) {
            let b = le - 1;
            while (b > we && (at(b) === 0x0d || at(b) === 0x20 || at(b) === 0x09)) { b--; }
            if (at(b) !== 0x5c) { break; }
          }
          le++;
        }
        i = le;
      } else { i = we; }
      continue;
    }
    if (u === 0x5c) { // \escaped identifier
      const start = i;
      while (i < count && !isSpaceCode(at(i))) { i++; }
      if (pendingKeyword !== undefined) { const k = pendingKeyword; pendingKeyword = undefined; openModule(text.slice(start + 1, i), k); }
      continue;
    }
    if (isIdStart(u)) {
      const we = idEnd(i);
      const prev = i > 0 ? at(i - 1) : 0x20;
      if (isIdPart(prev) || prev === 0x27 || prev === 0x2e) { i = we; continue; } // 8'hff, a.b
      const word = text.slice(i, we);
      if (pendingKeyword !== undefined) {
        if (word === 'automatic' || word === 'static') { i = we; continue; }
        const k = pendingKeyword; pendingKeyword = undefined; openModule(word, k);
      } else if (word === 'module' || word === 'macromodule') {
        if (inPrototype) { inPrototype = false; } else { pendingKeyword = i; }
      } else if (word === 'extern') {
        inPrototype = true;
      } else if (word === 'endmodule') {
        const closed = open.pop();
        if (closed) { closed.endOffset = we; done.push(closed); }
      }
      i = we;
      continue;
    }
    if (u === 0x3b) { inPrototype = false; }
    i++;
  }
  for (const o of open) { done.push({ ...o, endOffset: count }); }
  return done.sort((a, b) => a.keywordOffset - b.keywordOffset);
}

/** The innermost module declaration containing `offset` (UTF-16, like a JS string index). A caret in the indentation
 *  before the `module` keyword counts as on it. */
export function moduleAt(offset: number, text: string): ModuleDeclaration | undefined {
  const decls = moduleDeclarations(text);
  for (let k = decls.length - 1; k >= 0; k--) {
    const d = decls[k];
    let start = d.keywordOffset;
    while (start > 0 && (text.charCodeAt(start - 1) === 0x20 || text.charCodeAt(start - 1) === 0x09)) { start--; }
    if (start <= offset && offset <= d.endOffset) { return d; }
  }
  return undefined;
}
