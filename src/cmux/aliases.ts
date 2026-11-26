// vscode-port: value alias files for the VS Code extension. GPL-3.0. Ported from cmux's
// Resources/vaporview/cmux-commands.js (value aliases) and Sources/Panels/WaveformValueAliasFiles.swift.
//
// Load Value Alias File...: the extension picks and reads the file (Verdi .alias, .rc alias lines, JSON, CSV) and
// posts its text to the webview ({command: 'loadValueAliases'}, extra_formats.ts), which parses it, binds the
// file's signals and answers through the 'vaporview.valueAliasesLoaded' command.
//
// Sessions: getWebviewSession adds `cmuxValueAliases: [{key, path, fileName, sha256, text?}]`, with the text of
// files up to 256 KiB in total; the rest are named by key and SHA-256. Loading a session file posts the embedded
// texts before the rows (apply-state) and reads the others again, by key only, through the Registry: it knows
// only files this extension itself read (an alias file the user picked, or a session file the extension loaded,
// whose entries name the key and hash). A file is used only if its content still has the recorded hash.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { StateChangeType } from '../common/types';
import type { VaporviewDocument } from '../extension_core/document';
import { sessionHooks } from './session_hooks';
import { cmuxBridge } from './bridge_host';

const MAX_FILES = 16;
const MAX_TEXT = 8 * 1024 * 1024;
const EMBED_BYTES = 256 * 1024;
const REGISTRY_CAPACITY = 64;
const SHA256 = /^[0-9a-f]{64}$/;

export interface AliasFile { key: string; path: string; fileName: string; text: string; sha256: string | null; }
interface Load extends AliasFile { user: boolean; document: VaporviewDocument; }

export const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Files the extension read, by key (an absolute local path). Only extension code adds to it. */
class Registry {
  private records = new Map<string, string>(); // key -> sha256
  noteLoaded(key: string, text: string) { this.set(key, sha256(text)); }
  noteSession(session: any) {
    const list = session && Array.isArray(session.cmuxValueAliases) ? session.cmuxValueAliases.slice(-MAX_FILES) : [];
    for (const e of list) {
      if (e && typeof e.key === 'string' && path.isAbsolute(e.key) && typeof e.sha256 === 'string' && SHA256.test(e.sha256)) { this.set(e.key, e.sha256); }
    }
  }
  get(key: string) { return this.records.get(key); }
  private set(key: string, sha: string) {
    this.records.delete(key);
    this.records.set(key, sha);
    while (this.records.size > REGISTRY_CAPACITY) { this.records.delete(this.records.keys().next().value as string); }
  }
}
export const aliasRegistry = new Registry();

const filesByDoc = new WeakMap<VaporviewDocument, AliasFile[]>();
const tablesByDoc = new WeakMap<VaporviewDocument, Set<string>>();
let loads: Load[] = [];
let log: (s: string) => void = () => {};

export const aliasFilesOf = (d: VaporviewDocument) => (filesByDoc.get(d) || []).slice();
export const aliasFormatsOf = (d: VaporviewDocument) => Array.from(tablesByDoc.get(d) || []).sort();

/** A regular file's text (symlinks followed), at most MAX_TEXT bytes. */
export async function readAliasText(file: string): Promise<string> {
  const real = await fs.promises.realpath(file);
  const fh = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) { throw new Error('not a regular file'); }
    if (st.size > MAX_TEXT) { throw new Error('the file is larger than 8 MiB'); }
    const buf = Buffer.alloc(MAX_TEXT + 1);
    const { bytesRead } = await fh.read(buf, 0, MAX_TEXT + 1, 0);
    if (bytesRead > MAX_TEXT) { throw new Error('the file is larger than 8 MiB'); }
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead));
  } finally { await fh.close(); }
}

function post(load: Load) {
  loads.push(load);
  const panel = load.document.webviewPanel;
  if (!panel) { return; }
  // The viewer picks the syntax by the name's extension and names the file in warnings; the key ends with the path.
  panel.webview.postMessage({ command: 'loadValueAliases', fileName: load.key, text: load.text, apply: load.user });
}

function keep(document: VaporviewDocument, f: AliasFile) {
  const kept = { key: f.key, path: f.path, fileName: f.fileName, text: f.text, sha256: f.sha256 };
  filesByDoc.set(document, (filesByDoc.get(document) || []).filter((x) => x.key !== f.key).concat([kept]).slice(-MAX_FILES));
}

/** Load Value Alias File... (args.aliasFile: a path or Uri skips the picker; for scripts and tests). */
export async function loadValueAliasFile(document: VaporviewDocument | undefined, args?: any) {
  if (!document) { vscode.window.showErrorMessage('No waveform viewer is active.'); return; }
  let uri: vscode.Uri | undefined;
  const given = args && args.aliasFile;
  if (given) { uri = typeof given === 'string' ? vscode.Uri.file(given) : vscode.Uri.from(given); }
  else {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: 'Load Value Aliases',
      defaultUri: vscode.Uri.file(path.dirname(document.uri.fsPath)),
      filters: { 'Value alias files': ['alias', 'rc', 'json', 'csv', 'txt'], 'All files': ['*'] } });
    uri = picked && picked[0];
  }
  if (!uri) { return; }
  let text: string;
  try { text = uri.scheme === 'file' ? await readAliasText(uri.fsPath) : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); }
  catch (e: any) { vscode.window.showErrorMessage('The value alias file could not be loaded: ' + (e && e.message ? e.message : e)); return; }
  const key = uri.scheme === 'file' ? uri.fsPath : uri.toString();
  if (uri.scheme === 'file') { aliasRegistry.noteLoaded(key, text); }
  post({ key, path: uri.scheme === 'file' ? uri.fsPath : key, fileName: path.basename(uri.path), text, sha256: sha256(text), user: true, document });
}

/** The webview's answer ('vaporview.valueAliasesLoaded'): {fileName: key, tables, formatIds, warnings, applied} | {error}. */
export function valueAliasesLoaded(result: any) {
  const r = result && typeof result === 'object' ? result : {};
  const i = loads.findIndex((l) => l.key === r.fileName);
  const load = i >= 0 ? loads.splice(i, 1)[0] : null;
  if (!load) { return; }
  const tables: string[] = Array.isArray(r.tables) ? r.tables : [];
  if (r.error || !tables.length) {
    if (load.user) { vscode.window.showErrorMessage('The value alias file could not be loaded: ' + (r.error || 'it has no alias tables')); }
    return;
  }
  keep(load.document, load);
  const formats = tablesByDoc.get(load.document) || new Set<string>();
  (Array.isArray(r.formatIds) ? r.formatIds : tables.map((t: string) => 'alias:' + t)).forEach((f: string) => formats.add(String(f)));
  tablesByDoc.set(load.document, formats);
  const warnings: string[] = Array.isArray(r.warnings) ? r.warnings : [];
  if (warnings.length) { log('alias file ' + load.key + ': ' + warnings.join('; ')); }
  if (load.user && warnings.length) { vscode.window.showWarningMessage(`${load.fileName}: ${warnings[0]}`); }
}

// ---- sessions ----

function entries(document: VaporviewDocument) {
  let left = EMBED_BYTES;
  return aliasFilesOf(document).map((f) => {
    const e: Record<string, unknown> = { key: f.key, path: f.path, fileName: f.fileName, sha256: f.sha256 || undefined };
    const size = Buffer.byteLength(f.text, 'utf8');
    // A file without a hash can't be read back, so it is embedded whatever its size.
    if (size <= left || !f.sha256) { e.text = f.text; left -= size; }
    return e;
  });
}

function sessionFiles(session: any): (AliasFile & { text: string | null })[] {
  const list = session && Array.isArray(session.cmuxValueAliases) ? session.cmuxValueAliases : [];
  return list.map((f: any) => {
    if (!f || typeof f !== 'object') { return null; }
    const text = typeof f.text === 'string' && f.text.length <= MAX_TEXT ? f.text : null;
    const p = typeof f.path === 'string' ? f.path : '';
    const key = typeof f.key === 'string' && f.key ? f.key : (p || (typeof f.fileName === 'string' ? f.fileName : ''));
    const sha = typeof f.sha256 === 'string' && SHA256.test(f.sha256) ? f.sha256 : null;
    if (!key || (text === null && !sha)) { return null; }
    return { key, path: p, fileName: typeof f.fileName === 'string' && f.fileName ? f.fileName : path.basename(p || key), text, sha256: sha };
  }).filter(Boolean).slice(-MAX_FILES);
}

/** Re-read a file the registry knows, by key; the text only if it still has the recorded hash. */
export async function readRecorded(key: string): Promise<{ text?: string; error?: string }> {
  const sha = aliasRegistry.get(key);
  if (!sha) { return { error: 'This file was not read by the waveform viewer before; load it again with Load Value Alias File...' }; }
  try {
    const text = await readAliasText(key);
    return sha256(text) === sha ? { text } : { error: 'The file changed after the session was saved. Load it again with Load Value Alias File...' };
  } catch (e: any) { return { error: String(e && e.message ? e.message : e) }; }
}

function beforeApplySession(document: VaporviewDocument, session: any, stateChangeType: number) {
  // Undo/Redo and the webview's own restore keep the tables the viewer has.
  if (stateChangeType !== StateChangeType.File) { return; }
  aliasRegistry.noteSession(session);
  const files = sessionFiles(session);
  const toRead = [];
  for (const f of files) {
    if (f.text !== null) { post({ ...f, text: f.text, user: false, document }); } else { toRead.push(f); }
  }
  (async () => {
    for (const f of toRead) {
      const r = await readRecorded(f.key);
      if (r.text !== undefined) { post({ ...f, text: r.text, user: false, document }); }
      else { vscode.window.showWarningMessage(`Value alias file ${f.path || f.key} was not restored: ${r.error}`); }
    }
  })();
}

export function registerAliases(context: vscode.ExtensionContext, logLine: (s: string) => void) {
  log = logLine;
  sessionHooks.extendSession = (document: VaporviewDocument, session: any) => {
    const list = entries(document);
    if (list.length) { session.cmuxValueAliases = list; }
    return session;
  };
  sessionHooks.beforeApplySession = beforeApplySession;
  const reg = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('vaporview.loadValueAliases', (args?: any) => loadValueAliasFile(cmuxBridge.activeDocument(), args));
  reg('vaporview.valueAliasesLoaded', (result: any) => valueAliasesLoaded(result));
}
