// vscode-port: one slang connection per design root, for multi-root workspaces (cmux
// LanguageServerPool.swift + SlangWorkspaceRoot.swift).
// A file's root: see rootOfFile (profiles.ts workspaceRoot is port of SlangWorkspaceRoot.swift).
// The slang extension (vscode-slang) runs one language server for the window, and its own commands resolve paths
// against the first workspace folder: only the first folder's root uses it; every other root gets our own
// slang-server, started in that root.
// Routing: SourceLink keeps calling one `Slang` (the router below). Each entry point that knows its SV document or
// waveform runs inside `within(root, ...)`; every slang call made from there (enums, profiles too) goes to that
// root's connection. Outside any `within`, calls go to the first folder's root, as before multi-root.
// SPDX-License-Identifier: GPL-3.0-or-later
import { AsyncLocalStorage } from 'async_hooks';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Slang, SLANG_EXTENSION_ID } from './slang';
import { workspaceRoot, localMarkers } from './profiles';

/** The nearest ancestor of `file` (its folder first) with .slang/server.json; the home folder never counts. */
function configRoot(file: string): string | undefined {
  const m = localMarkers(file, os.homedir());
  return workspaceRoot(file, { config: m.config, git: new Set(), home: m.home });
}
/** The root of the `within(root, …)` call in progress, if any (set by the pool). */
let scopeRoot: () => string | undefined = () => undefined;

/** The design root of a file (absolute path):
 *  - the nearest .slang/server.json above it, else the workspace folder that holds it;
 *  - a file outside every folder (a source a build file names from ../, a dump elsewhere):
 *    - one folder open: that folder's root (as rootOfWave);
 *    - several: the root of the call in progress (the waveform or editor it came from), else the first folder's root;
 *      (later: the one root whose compilation lists the file, once each root's source set is cached)
 *    - while folders are open, never a root outside all of them (the nearest .git there would start another
 *      slang-server on a whole repository);
 *  - no folder open: the nearest .slang/server.json or .git.
 *  (cmux has no workspace folders and goes from .slang/server.json to .git; here a folder without its own config stays
 *  its own root, so a folder inside a larger repository does not index the whole repository.) */
export function rootOfFile(fsPath: string): string | undefined {
  const roots = workspaceRoots();
  const c = configRoot(fsPath);
  if (c && (!roots.length || roots.includes(c))) { return c; }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
  if (folder) { return folderRoot(folder.uri.fsPath); }
  if (roots.length === 1) { return roots[0]; }
  if (roots.length > 1) {
    const s = scopeRoot();
    return s && roots.includes(s) ? s : roots[0];
  }
  return c ?? workspaceRoot(fsPath, localMarkers(fsPath, os.homedir()));
}
/** A workspace folder's root: the nearest .slang/server.json at or above it, else the folder. */
function folderRoot(folder: string): string { return configRoot(path.join(folder, '.vaporview-root-probe')) ?? folder; }

/** The roots of the open workspace folders, in folder order, without repeats. */
export function workspaceRoots(): string[] {
  const out: string[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) { const r = folderRoot(f.uri.fsPath); if (!out.includes(r)) { out.push(r); } }
  return out;
}

export class SlangPool {
  private readonly byRoot = new Map<string, Slang>();
  private readonly scope = new AsyncLocalStorage<string>();
  /** The `Slang` SourceLink, EnumTypes and the profile chooser hold: each call goes to the current root's connection. */
  readonly router: Slang;
  constructor(private log: (s: string) => void) {
    const pool = this;
    scopeRoot = () => pool.scope.getStore();
    this.router = new Proxy({} as Slang, {
      get(_t, key) {
        if (key === 'counts') { return pool.counts(); }
        if (key === 'resetConnection' && !pool.inScope()) { return () => pool.resetConnection(); } // (a settings change: every root)
        const s = pool.current();
        const v = (s as any)[key];
        if (typeof v !== 'function') {
          // (per-root state read outside a root, e.g. the profile chooser's compilation: show the gap)
          if (key === 'compilation' && !pool.inScope() && workspaceRoots().length > 1) { pool.warnOutside('get compilation', undefined); }
          return v;
        }
        return (...args: any[]) => {
          // A call with a file (uri or path) outside any within(): it goes to that file's root, with a warning once
          // per caller, so a gap in the routing shows in the log instead of silently using the first folder's root.
          if (!pool.inScope() && workspaceRoots().length > 1) {
            const a0 = args[0];
            const file = a0 instanceof vscode.Uri ? (a0.scheme === 'file' ? a0.fsPath : undefined) : typeof a0 === 'string' && path.isAbsolute(a0) ? a0 : undefined;
            const root = file ? rootOfFile(file) : undefined;
            pool.warnOutside(String(key), root);
            if (root) { const r = pool.forRoot(root); return (r as any)[key](...args); }
          }
          return v.apply(s, args);
        };
      },
      set(_t, key, value) {
        if (!pool.inScope() && workspaceRoots().length > 1) { pool.warnOutside('set ' + String(key), undefined); }
        (pool.current() as any)[key] = value;
        return true;
      },
    });
  }
  /** Each open root's compilation (diagnostics: the multi-root e2e checks one folder's switch leaves the other's). */
  compilations(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const [k, s] of this.byRoot) { o[k] = JSON.parse(JSON.stringify((s as any).compilation ?? null)); }
    return o;
  }
  /** The first workspace folder's root: the default, and the only root that may use the slang extension. */
  defaultRoot(): string | undefined { return workspaceRoots()[0]; }
  /** The connection of `root` (made on first use). */
  forRoot(root: string | undefined): Slang {
    const def = this.defaultRoot();
    const key = root ?? def ?? '';
    let s = this.byRoot.get(key);
    if (!s) {
      s = new Slang((m) => this.log(m), key || undefined, !def || key === def);
      this.byRoot.set(key, s);
      if (this.byRoot.size > 1) { this.log(`source link: slang root ${key} (${this.byRoot.size} roots)`); }
    }
    return s;
  }
  current(): Slang { return this.forRoot(this.scope.getStore()); }
  /** Runs `fn` with `root`'s connection as the router's target (undefined root: the default). */
  within<T>(root: string | undefined, fn: () => T): T { return root ? this.scope.run(root, fn) : fn(); }
  private warned = new Set<string>();
  /** Calls made outside any within() while several roots are open (diagnostics: the e2e reads them). */
  readonly outside: string[] = [];
  /** Logs once per caller a slang call that no entry point routed (several roots open). */
  warnOutside(method: string, fileRoot: string | undefined) {
    const frame = (new Error().stack ?? '').split('\n').slice(1).map((l) => l.trim())
      // (the bundle is one file: skip the pool's and Slang's own frames by name; the first other frame is the caller)
      .find((l) => /^at /.test(l) && !/\bSlang(Pool)?\.|Proxy\.|Object\.(get|set)|warnOutside|node:internal/.test(l)) ?? '(unknown caller)';
    const key = method + ' ' + frame;
    if (this.warned.has(key)) { return; }
    this.warned.add(key);
    const where = fileRoot ? `its file's root ${fileRoot}` : `the first folder's root ${this.defaultRoot()}`;
    const line = `slang ${method} outside a design root (${frame}): using ${where}`;
    this.outside.push(line);
    this.log('source link: warning: ' + line);
  }
  /** The root chosen by an enclosing `within`, if any. */
  inScope(): string | undefined { return this.scope.getStore(); }
  /** The root a call is running for now. */
  get root(): string | undefined { return this.scope.getStore() ?? this.defaultRoot(); }
  roots(): string[] { return [...this.byRoot.keys()]; }
  counts() {
    const c = { connects: 0, serverStarts: 0 };
    for (const s of this.byRoot.values()) { c.connects += s.counts.connects; c.serverStarts += s.counts.serverStarts; }
    return c;
  }
  resetConnection() { for (const s of this.byRoot.values()) { s.resetConnection(); } }
  /** Workspace folders changed: drop the connections of roots no longer open. */
  prune() {
    const open = new Set(workspaceRoots());
    for (const [root, s] of this.byRoot) {
      const stillUsed = open.has(root) || (vscode.workspace.workspaceFolders ?? []).some((f) => root.startsWith(f.uri.fsPath + path.sep) || f.uri.fsPath.startsWith(root + path.sep));
      if (!stillUsed) { s.dispose(); this.byRoot.delete(root); }
    }
  }
  dispose() { for (const s of this.byRoot.values()) { s.dispose(); } this.byRoot.clear(); }
}

const RECOMMEND_KEY = 'vaporview.sourceLink.slangExtensionOffer';
let offered = false;
/** Offers the slang extension once per session (until "Don't Ask Again") when a SystemVerilog file opens without
 *  it: it adds the editor's language features; the link works without it through our own slang-server. */
export async function offerSlangExtension(context: vscode.ExtensionContext): Promise<void> {
  if (offered || process.env.VAPORVIEW_E2E === '1') { return; }
  if (vscode.extensions.getExtension(SLANG_EXTENSION_ID) || context.globalState.get<boolean>(RECOMMEND_KEY)) { return; }
  offered = true;
  const install = 'Install', never = "Don't Ask Again";
  const pick = await vscode.window.showInformationMessage(
    'The slang extension adds SystemVerilog syntax, completion, Go to Definition and references. The waveform link '
    + 'works without it through its own slang-server, but the editor then has no SystemVerilog language features.',
    install, 'Not Now', never);
  if (pick === install) { await vscode.commands.executeCommand('workbench.extensions.installExtension', SLANG_EXTENSION_ID); }
  if (pick === never) { await context.globalState.update(RECOMMEND_KEY, true); }
}
