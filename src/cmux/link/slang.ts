// vscode-port: how the SystemVerilog editor <-> waveform link reaches slang-server.
// (a) preferred: the slang VS Code extension (hudson-river-trading.vscode-slang). Its activate() returns its
//     SlangExtension object, which holds the running LanguageClient (`client`). We send raw LSP requests on that
//     client (workspace/executeCommand for slang.getScope / getInstances / ..., textDocument/hover, definition,
//     references, documentSymbol): no second server, no patch to that extension. If a later version stops exposing
//     `client`, the server's slang.* commands are still VS Code commands (vscode-languageclient registers them), so
//     we fall back to vscode.commands.executeCommand plus vscode.execute*Provider.
// (b) fallback: our own slang-server process (setting vaporview.sourceLink.slangServerPath, default `slang-server` on
//     PATH), spoken to over a minimal stdio JSON-RPC client. Started only when the slang extension is not installed
//     or enabled (or the user forces it). It registers no VS Code commands or language features and publishes no
//     diagnostics, so it cannot fight with a user's running slang extension.
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/** slang-server names files by their real path (symlinks resolved): a symlinked source opened in VS Code must be sent
 *  as its target, or the server knows no such document (getInstances etc. answer nothing). */
export function realFsPath(fsPath: string): string { try { return fs.realpathSync(fsPath); } catch { return fsPath; } }
export function serverUri(uri: vscode.Uri): string { return uri.scheme === 'file' ? vscode.Uri.file(realFsPath(uri.fsPath)).toString() : uri.toString(); }
export function sameFile(a: vscode.Uri, b: vscode.Uri): boolean { return a.fsPath === b.fsPath || (a.scheme === 'file' && b.scheme === 'file' && realFsPath(a.fsPath) === realFsPath(b.fsPath)); }

export const SLANG_EXTENSION_ID = 'hudson-river-trading.vscode-slang';

/** One child of a scope in slang-server's elaborated design (`slang.getScope`). */
export interface SlangItem {
  name: string;
  /** slang's kind name (Instance, Scope, Port, Logic, Param, Package, ...). */
  kind: string;
  type?: string;
  declName?: string;
  location?: vscode.Location;
  isScope: boolean;
}

const SCOPE_KINDS = new Set(['Instance', 'Scope', 'ScopeArray', 'InterfacePort', 'InterfacePortArray', 'InstanceArray', 'Package']);

/** LSP-shaped answers (the raw protocol, whatever the transport). */
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspSymbol { name: string; kind: number; range: LspRange; selectionRange?: LspRange; children?: LspSymbol[] }

interface Transport {
  readonly mode: 'extension' | 'extension-commands' | 'own';
  request(method: string, params: unknown): Promise<any>;
  /** The server's advertised workspace/executeCommand list; undefined when unknown. */
  commands?(): string[] | undefined;
  dispose?(): void;
}

// #region (a) the slang extension's client
class ExtensionClientTransport implements Transport {
  readonly mode = 'extension';
  constructor(private client: { sendRequest(method: string, params: unknown): Promise<any>; initializeResult?: any }) {}
  request(method: string, params: unknown) { return this.client.sendRequest(method, params); }
  commands(): string[] | undefined { return this.client.initializeResult?.capabilities?.executeCommandProvider?.commands; }
}

/** No client object: slang.* commands through VS Code, LSP features through the execute*Provider commands. */
class ExtensionCommandTransport implements Transport {
  readonly mode = 'extension-commands';
  async request(method: string, params: any): Promise<any> {
    if (method === 'workspace/executeCommand') {
      return vscode.commands.executeCommand(params.command, ...(params.arguments ?? []));
    }
    const uri = vscode.Uri.parse(params.textDocument?.uri);
    const pos = params.position ? new vscode.Position(params.position.line, params.position.character) : undefined;
    switch (method) {
      case 'textDocument/hover': {
        hoverGuard.depth++;
        try {
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos);
          const text = (hovers ?? []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n\n');
          return text ? { contents: { kind: 'markdown', value: text } } : null;
        } finally { hoverGuard.depth--; }
      }
      case 'textDocument/definition': {
        const locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos);
        return (locs ?? []).map(toLspLocation);
      }
      case 'textDocument/references': {
        const locs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, pos);
        return (locs ?? []).map(toLspLocation);
      }
      case 'textDocument/documentSymbol': {
        const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
        const conv = (s: vscode.DocumentSymbol): LspSymbol => ({ name: s.name, kind: s.kind + 1, range: toLspRange(s.range),
          selectionRange: toLspRange(s.selectionRange), children: (s.children ?? []).map(conv) });
        return (syms ?? []).map(conv);
      }
    }
    throw new Error(`unsupported request ${method}`);
  }
}

/** Our own hover provider must not answer a hover the link asks for itself. */
export const hoverGuard = { depth: 0 };

// #region (b) our own slang-server
class OwnServerTransport implements Transport {
  readonly mode = 'own';
  private proc: cp.ChildProcess | undefined;
  private buf = Buffer.alloc(0);
  private nextId = 0;
  private waits = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ready: Promise<void>;
  private advertised: string[] | undefined;
  commands() { return this.advertised; }
  constructor(command: string, root: string, private log: (s: string) => void) {
    this.ready = this.start(command, root);
  }
  private start(command: string, root: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(command, [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.on('error', (e) => { reject(e); this.failAll(e); });
      proc.on('exit', (code) => { this.failAll(new Error(`slang-server exited (${code})`)); this.proc = undefined; });
      proc.stderr?.on('data', (d) => this.log(String(d).trimEnd()));
      proc.stdout?.on('data', (d: Buffer) => this.onData(d));
      const rootUri = vscode.Uri.file(root).toString();
      this.send({ jsonrpc: '2.0', id: ++this.nextId, method: 'initialize', params: {
        processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
        capabilities: { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      } });
      this.waits.set(this.nextId, { resolve: (r: any) => { this.advertised = r?.capabilities?.executeCommandProvider?.commands; this.send({ jsonrpc: '2.0', method: 'initialized', params: {} }); resolve(); }, reject });
    });
  }
  private failAll(e: Error) { for (const w of this.waits.values()) { w.reject(e); } this.waits.clear(); }
  private send(msg: unknown) {
    const s = JSON.stringify(msg);
    this.proc?.stdin?.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }
  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n');
      if (h < 0) { return; }
      const m = /Content-Length: *(\d+)/i.exec(this.buf.subarray(0, h).toString());
      if (!m) { this.buf = this.buf.subarray(h + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < h + 4 + len) { return; }
      let msg: any;
      try { msg = JSON.parse(this.buf.subarray(h + 4, h + 4 + len).toString()); } catch { msg = undefined; }
      this.buf = this.buf.subarray(h + 4 + len);
      if (!msg) { continue; }
      if (msg.id !== undefined && msg.method) {
        // A request from the server (workDoneProgress/create, showDocument, ...): acknowledge, do nothing.
        this.send({ jsonrpc: '2.0', id: msg.id, result: null });
      } else if (msg.id !== undefined && this.waits.has(msg.id)) {
        const w = this.waits.get(msg.id)!;
        this.waits.delete(msg.id);
        if (msg.error) { w.reject(new Error(msg.error.message ?? 'slang-server error')); } else { w.resolve(msg.result); }
      }
    }
  }
  async request(method: string, params: unknown): Promise<any> {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waits.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  dispose() {
    try { this.send({ jsonrpc: '2.0', id: ++this.nextId, method: 'shutdown' }); this.send({ jsonrpc: '2.0', method: 'exit' }); } catch { /* gone */ }
    setTimeout(() => this.proc?.kill(), 500);
  }
}

function toLspRange(r: vscode.Range): LspRange {
  return { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } };
}
function toLspLocation(l: vscode.Location | vscode.LocationLink): LspLocation {
  if ('targetUri' in l) { return { uri: l.targetUri.toString(), range: toLspRange(l.targetSelectionRange ?? l.targetRange) }; }
  return { uri: l.uri.toString(), range: toLspRange(l.range) };
}
export function toLocation(l: LspLocation): vscode.Location {
  return new vscode.Location(vscode.Uri.parse(l.uri), new vscode.Range(l.range.start.line, l.range.start.character, l.range.end.line, l.range.end.character));
}

// #region Slang
export class Slang {
  private transport: Transport | undefined;
  private connecting: Promise<Transport | undefined> | undefined;
  /** `root`: the folder our own slang-server starts in (default: the first workspace folder). `extension`: whether
   *  this connection may use the slang extension's client (one per window, so only the pool's first root may). */
  constructor(private log: (s: string) => void, readonly root?: string, private extension = true) {}

  get mode(): string | undefined { return this.transport?.mode; }
  /** Connection attempts and own slang-server starts since activation (status / perf checks). */
  readonly counts = { connects: 0, serverStarts: 0 };

  /** The connection, made on first use. Undefined when neither route is available. */
  async connect(): Promise<Transport | undefined> {
    if (this.transport) { return this.transport; }
    // A failed connection is not retried on every request (each attempt starts and stops a slang-server: 22-61 ms
    // per row add on a big FSDB): only after RETRY_MS, or at once after resetConnection() (settings, sources changed).
    if (this.failedAt !== undefined && Date.now() - this.failedAt < Slang.RETRY_MS) { return undefined; }
    if (!this.connecting) { this.connecting = this.makeTransport().finally(() => { this.connecting = undefined; }); }
    this.transport = await this.connecting;
    this.failedAt = this.transport ? undefined : Date.now();
    return this.transport;
  }
  private failedAt: number | undefined;
  private static readonly RETRY_MS = 60000;
  /** Forget a failed connection (the settings or the workspace's sources changed): the next request tries again. */
  resetConnection() { this.failedAt = undefined; }

  private async makeTransport(): Promise<Transport | undefined> {
    this.counts.connects++;
    const cfg = vscode.workspace.getConfiguration('vaporview.sourceLink');
    const pref = cfg.get<string>('slangConnection', 'auto');
    const ext = vscode.extensions.getExtension(SLANG_EXTENSION_ID);
    if (ext && pref !== 'own' && this.extension) {
      try {
        const api: any = ext.isActive ? ext.exports : await ext.activate();
        const client = api?.client;
        // The client starts asynchronously after activation.
        for (let i = 0; i < 100 && client && typeof client.isRunning === 'function' && !client.isRunning(); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (client && typeof client.sendRequest === 'function') {
          this.log(`source link: using the slang extension's language client (${SLANG_EXTENSION_ID} ${ext.packageJSON?.version})`);
          return new ExtensionClientTransport(client);
        }
        this.log('source link: the slang extension exports no client; using its commands');
        return new ExtensionCommandTransport();
      } catch (e) {
        this.log(`source link: slang extension failed to activate: ${e}`);
        if (pref === 'extension') { return undefined; }
      }
    }
    if (pref === 'extension') { return undefined; } // (multi-root: only the extension's root has a link then)
    const root = this.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return undefined; }
    const command = cfg.get<string>('slangServerPath') || 'slang-server';
    this.log(`source link: starting our own slang-server (${command}) in ${root}`);
    this.counts.serverStarts++;
    const own = new OwnServerTransport(command, root, (s) => this.log('slang-server: ' + s));
    try { await own.request('workspace/executeCommand', { command: 'slang.getScope', arguments: [''] }); }
    catch (e) { this.log(`source link: slang-server did not start: ${e}`); own.dispose(); return undefined; }
    return own;
  }

  dispose() { this.transport?.dispose?.(); this.transport = undefined; }

  async command(name: string, arg?: unknown): Promise<any> {
    const t = await this.connect();
    if (!t) { throw new SlangUnavailable(); }
    return t.request('workspace/executeCommand', { command: name, arguments: arg === undefined ? [] : [arg] });
  }

  async getScope(hierPath: string): Promise<SlangItem[]> {
    const result = await this.command('slang.getScope', hierPath);
    if (!Array.isArray(result)) { return []; }
    return result.filter((i: any) => typeof i?.instName === 'string').map((i: any) => ({
      name: i.instName,
      kind: String(i.kind ?? ''),
      type: typeof i.type === 'string' ? i.type : undefined,
      declName: typeof i.declName === 'string' ? i.declName : undefined,
      location: i.instLoc?.uri ? toLocation(i.instLoc) : undefined,
      isScope: SCOPE_KINDS.has(String(i.kind)),
    }));
  }

  /** Paths of the symbol at a position, one per instance of the enclosing module. */
  async getInstances(uri: vscode.Uri, pos: vscode.Position): Promise<string[]> {
    const result = await this.command('slang.getInstances', { textDocument: { uri: serverUri(uri) }, position: { line: pos.line, character: pos.character } });
    const seen = new Set<string>();
    return (Array.isArray(result) ? result : []).filter((p: unknown): p is string => typeof p === 'string' && !p.startsWith('.') && !seen.has(p) && !!seen.add(p));
  }

  /** What the link last set the server to compile (a top-level file or a .f build file), explore mode (`explore`:
   *  set with an empty top level), or neither (the server's config decides). Sent again after a restart. */
  compilation: { target?: { kind: 'topLevel' | 'buildFile'; path: string }; explore: boolean } = { explore: false };
  async setTopLevel(fsPath: string): Promise<void> {
    await this.command('slang.setTopLevel', fsPath);
    this.compilation = fsPath ? { target: { kind: 'topLevel', path: fsPath }, explore: false } : { explore: false };
  }
  /** Elaborates the design a .f build file describes (slang.setBuildFile): no restart, no file written. */
  async setBuildFile(fsPath: string): Promise<void> {
    await this.command('slang.setBuildFile', fsPath);
    // An empty path drops the build file (back to the config's build, if any).
    this.compilation = fsPath ? { target: { kind: 'buildFile', path: fsPath }, explore: false } : { explore: false };
  }
  /** Explore mode: no top level and no build file, until another is chosen. */
  async explore(): Promise<void> {
    await this.command('slang.setTopLevel', '');
    this.compilation = { explore: true };
  }
  /** Puts back a state read from `compilation` before a switch. */
  async restore(state: Slang['compilation']): Promise<void> {
    if (state.target?.kind === 'buildFile') { await this.setBuildFile(state.target.path); }
    else if (state.target) { await this.setTopLevel(state.target.path); }
    else if (state.explore) { await this.explore(); }
    else { await this.command('slang.setTopLevel', ''); this.compilation = { explore: false }; }
  }
  /** Whether the server advertised `name`; undefined when it advertised no list (or is not connected). */
  async supportsCommand(name: string): Promise<boolean | undefined> {
    const t = await this.connect();
    const list = t?.commands?.();
    return list ? list.includes(name) : undefined;
  }
  /** Restarts the server (ours: a new process; the slang extension's: its restart command), then sends what the link
   *  set it to compile again. */
  async restart(keepCompilation = true): Promise<void> {
    const t = await this.connect();
    if (t && t.mode !== 'own') {
      await vscode.commands.executeCommand('slang.restartLanguageServer');
      this.transport = undefined; // its client may be a new object after the restart
    } else {
      this.dispose();
    }
    this.resetConnection();
    const state = this.compilation;
    if (!keepCompilation) { this.compilation = { explore: false }; }
    // The extension's client starts asynchronously: retry the first request for a while.
    for (let i = 0; i < 50; i++) {
      try { await this.command('slang.getScope', ''); break; } catch { this.transport = undefined; this.resetConnection(); await new Promise((r) => setTimeout(r, 200)); }
    }
    if (keepCompilation && (state.target || state.explore)) { await this.restore(state); }
  }

  async filesContainingModule(name: string): Promise<string[]> {
    const r = await this.command('slang.getFilesContainingModule', name);
    return Array.isArray(r) ? r.filter((x: unknown) => typeof x === 'string') : [];
  }

  async scopesByModule(): Promise<{ declName: string; declLoc?: vscode.Location; instCount: number; instPath?: string }[]> {
    const r = await this.command('slang.getScopesByModule');
    return (Array.isArray(r) ? r : []).map((m: any) => ({ declName: m.declName, declLoc: m.declLoc?.uri ? toLocation(m.declLoc) : undefined,
      instCount: Number(m.instCount ?? 0), instPath: m.inst?.instPath }));
  }

  async instancesOfModule(name: string): Promise<string[]> {
    const r = await this.command('slang.getInstancesOfModule', name);
    return (Array.isArray(r) ? r : []).map((x: any) => x?.instPath).filter((x: unknown): x is string => typeof x === 'string');
  }

  async driversWithLocation(hierPath: string): Promise<{ path: string; location?: vscode.Location }[]> {
    const r = await this.command('slang.getDriversWithLocation', hierPath);
    return (Array.isArray(r) ? r : []).map((d: any) => ({ path: String(d.path), location: d.location?.uri ? toLocation(d.location) : undefined }));
  }

  private async lsp(method: string, params: unknown): Promise<any> {
    const t = await this.connect();
    if (!t) { throw new SlangUnavailable(); }
    return t.request(method, params);
  }

  async hover(uri: vscode.Uri, pos: LspPosition): Promise<string | undefined> {
    try {
      const h = await this.lsp('textDocument/hover', { textDocument: { uri: serverUri(uri) }, position: pos });
      const c = h?.contents;
      if (!c) { return undefined; }
      if (typeof c === 'string') { return c; }
      if (Array.isArray(c)) { return c.map((x) => (typeof x === 'string' ? x : x.value)).join('\n'); }
      return c.value;
    } catch (e) { if (e instanceof SlangUnavailable) { throw e; } return undefined; }
  }

  async references(uri: vscode.Uri, pos: LspPosition): Promise<LspLocation[]> {
    try {
      const r = await this.lsp('textDocument/references', { textDocument: { uri: serverUri(uri) }, position: pos, context: { includeDeclaration: false } });
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }

  async documentSymbols(uri: vscode.Uri): Promise<LspSymbol[]> {
    try {
      const r = await this.lsp('textDocument/documentSymbol', { textDocument: { uri: serverUri(uri) } });
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }
}

export class SlangUnavailable extends Error {
  constructor() { super('slang-server is not available: install the slang extension, or set vaporview.sourceLink.slangServerPath'); }
}
