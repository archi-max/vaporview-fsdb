// vscode-port: the extension side of the cmux page-module bridge (media/cmux/bridge.js). GPL-3.0.
// Answers the page's RPCs from src/cmux/data.ts, handles its native messages ({type} from host.toNative), and
// lets other extension code call functions the modules put on window.cmuxWaveform.
//
// For other modules:
//   cmuxBridge.onNative('fsmRequest', (msg, ctx) => {...})   handle a page message type (ctx: { document, panel })
//   cmuxBridge.callPage(panel, 'fsm.show', { path, model })  -> Promise of the page function's result
//   cmuxBridge.panelFor(document) / documentFor(panel) / activePanel()
import * as vscode from 'vscode';
import * as path from 'path';
import type { VaporviewDocument } from '../extension_core/document';
import { waveformData, segmentsOf, type SignalRef } from './data';
import { sessionHooks } from './session_hooks';

// The file reloaded (document.reload: unload + load): results read before it are stale.
sessionHooks.onReload = (document: VaporviewDocument) => { waveformData(document).reloaded(); };
/** 'ready' messages per document (e2e: bridge-ready checks reads that straddle the first one). */
const readyCount = new WeakMap<VaporviewDocument, number>();

export interface BridgeContext { document: VaporviewDocument; panel: vscode.WebviewPanel; }
type NativeHandler = (msg: Record<string, unknown>, ctx: BridgeContext) => unknown;

const nativeHandlers = new Map<string, NativeHandler[]>();
const panels = new Map<vscode.WebviewPanel, VaporviewDocument>();
let lastActive: vscode.WebviewPanel | undefined;
let pageCallId = 1;
const pageCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let log: (line: string) => void = () => {};

export function setBridgeLog(fn: (line: string) => void) { log = fn; }

function track(panel: vscode.WebviewPanel, document: VaporviewDocument) {
  if (panels.has(panel)) { return; }
  panels.set(panel, document);
  if (panel.active || !lastActive) { lastActive = panel; }
  panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) { lastActive = e.webviewPanel; } });
  panel.onDidDispose(() => { panels.delete(panel); if (lastActive === panel) { lastActive = undefined; } });
}

// Big change lists go as typed arrays (VS Code passes ArrayBuffers to the webview without JSON); the transfer
// is most of the page hop's cost (about 9 ms per MB on a 1M-change list), so they go compact:
//  - times: as Uint32 deltas ({dt}) when every gap is a whole number below 2^32, else the Float64Array ({times});
//  - values: with at most 65,536 distinct values, a table of them and one code per change ({table, codes}: Uint8Array
//    up to 256 entries, else Uint16Array), so the page shares one string per distinct value; else, when all have the
//    same length and are ASCII, valueWidth bytes each ({packed}); else the string array. media/cmux/bridge.js pairs()
//    rebuilds exactly the same strings.
function toWire(v: unknown): unknown {
  const c = v as { times?: unknown; values?: unknown };
  if (!c || typeof c !== 'object' || !(c.times instanceof Float64Array) || !Array.isArray(c.values)) { return v; }
  const times = c.times;
  const values = c.values as string[];
  const n = values.length;
  const w = n ? values[0].length : 0;
  if (n < 256 || w === 0 || times.length !== n) { return v; }
  const out: Record<string, unknown> = { n, valueWidth: w };
  const dt = new Uint32Array(n);
  let prev = 0, deltas = true;
  for (let i = 0; i < n; i++) {
    const d = times[i] - prev;
    if (!(d >= 0 && d < 4294967296 && Number.isInteger(d))) { deltas = false; break; }
    dt[i] = d;
    prev = times[i];
  }
  if (deltas) { out.dt = dt; } else { out.times = times; }
  // a value table when few distinct values (any characters, 4-state too): one Uint8/Uint16 code per change
  const table = new Map<string, number>();
  const codes16 = new Uint16Array(n);
  let fits = true;
  for (let i = 0; i < n; i++) {
    const s = values[i];
    let code = table.get(s);
    if (code === undefined) {
      if (table.size >= 65536) { fits = false; break; }
      code = table.size;
      table.set(s, code);
    }
    codes16[i] = code;
  }
  if (fits) {
    out.table = [...table.keys()];
    out.codes = table.size <= 256 ? Uint8Array.from(codes16) : codes16;
    return out;
  }
  const bytes = new Uint8Array(n * w);
  for (let i = 0, at = 0; i < n; i++, at += w) {
    const s = values[i];
    if (s.length !== w) { return v; }
    for (let k = 0; k < w; k++) {
      const code = s.charCodeAt(k);
      if (code > 127) { return v; }
      bytes[at + k] = code;
    }
  }
  out.packed = bytes;
  return out;
}

// The page's RPC methods. args are untrusted page data: only paths and numbers.
const RPC_METHODS: Record<string, (document: VaporviewDocument, args: any, panel: vscode.WebviewPanel) => Promise<unknown>> = {
  async opened(document) {
    const data = waveformData(document);
    return {
      uri: document.uri.toString(), generation: data.generation, kind: document.fileType,
      metadata: { ...document.metadata }, top: await data.children(),
    };
  },
  children: (document, a) => waveformData(document).children(segmentsOf(a.path || [])),
  findItem: (document, a) => waveformData(document).findItem(segmentsOf(a.path || []), !!a.varOnly),
  async items(document, a) {
    const data = waveformData(document);
    return (Array.isArray(a.ids) ? a.ids : []).slice(0, 5000).map((id: unknown) => data.item(Number(id))).filter(Boolean);
  },
  signalChanges: (document, a) => waveformData(document).signalChanges(ref(a.ref), max(a.max)),
  posedges: (document, a) => waveformData(document).posedges(ref(a.ref), max(a.max)),
  valuesAt: (document, a) => waveformData(document).valuesAt((Array.isArray(a.refs) ? a.refs : []).slice(0, 5000).map(ref), Number(a.time)),
  async addSignal(document, a) {
    const item = await waveformData(document).node(segmentsOf(a.path || []), true);
    if (!item) { return false; }
    await document.renderSignals([item.netlistId], undefined, undefined);
    return true;
  },
};

function ref(r: unknown): SignalRef {
  if (r && typeof r === 'object' && !Array.isArray(r) && Number.isInteger((r as { netlistId?: unknown }).netlistId)) {
    return { netlistId: (r as { netlistId: number }).netlistId };
  }
  return segmentsOf(Array.isArray(r) ? r.map(String) : String(r ?? ''));
}
const max = (m: unknown) => (typeof m === 'number' && m > 0 ? m : Infinity);

/** Called from viewer_provider's webview message handler; true when the message was the bridge's. */
export function handleBridgeMessage(document: VaporviewDocument, panel: vscode.WebviewPanel, e: any): boolean {
  track(panel, document);
  if (!e || typeof e !== 'object') { return false; }
  // A webview (re)load doesn't change the dump (retainContextWhenHidden; the document keeps its handler), so 'ready'
  // never bumps the data generation: the first one lands a few hundred ms after an open and turned Trace, debugger
  // and value reads started in that gap into "reloaded". A real file reload bumps it (sessionHooks.onReload, below).
  if (e.command === 'ready') { readyCount.set(document, (readyCount.get(document) || 0) + 1); return false; }
  if (e.command === 'cmux-rpc') { answerRpc(document, panel, e); return true; }
  if (e.command === 'cmux-native') { onNativeMessage(document, panel, e.msg || {}); return true; }
  if (e.command === 'cmux-page-reply') {
    const p = pageCalls.get(e.id);
    pageCalls.delete(e.id);
    if (p) { if (e.error !== undefined && e.error !== null) { p.reject(new Error(e.error)); } else { p.resolve(e.result); } }
    return true;
  }
  return false;
}

async function answerRpc(document: VaporviewDocument, panel: vscode.WebviewPanel, e: any) {
  const method = RPC_METHODS[String(e.method)];
  let reply: Record<string, unknown>;
  try {
    if (!method) { throw new Error('unknown bridge method ' + e.method); }
    reply = { result: toWire(await method(document, e.args || {}, panel)) };
  } catch (err: any) {
    reply = { error: String(err && err.message ? err.message : err), code: err && err.code };
  }
  panel.webview.postMessage({ cmuxBridge: true, kind: 'rpc-reply', id: e.id, ...reply });
}

function onNativeMessage(document: VaporviewDocument, panel: vscode.WebviewPanel, msg: Record<string, unknown>) {
  const type = String(msg.type || '');
  const list = nativeHandlers.get(type);
  if (list && list.length) {
    list.forEach((h) => { try { h(msg, { document, panel }); } catch (err) { log('cmux bridge: ' + type + ' handler failed: ' + err); } });
    return;
  }
  log('cmux bridge: unhandled page message ' + type);
}

export const cmuxBridge = {
  onNative(type: string, handler: NativeHandler): vscode.Disposable {
    const list = nativeHandlers.get(type) || [];
    list.push(handler);
    nativeHandlers.set(type, list);
    return new vscode.Disposable(() => { const l = nativeHandlers.get(type) || []; l.splice(l.indexOf(handler), 1); });
  },
  callPage(panel: vscode.WebviewPanel, fnPath: string, args?: unknown, timeoutMs = 60000): Promise<unknown> {
    return postPage(panel, { kind: 'call', path: fnPath, args }, timeoutMs);
  },
  evalInPage(panel: vscode.WebviewPanel, source: string, args?: unknown, timeoutMs = 60000): Promise<unknown> {
    return postPage(panel, { kind: 'e2e-eval', source, args }, timeoutMs);
  },
  panelFor(document: VaporviewDocument): vscode.WebviewPanel | undefined {
    for (const [p, d] of panels) { if (d === document) { return p; } }
    return undefined;
  },
  documentFor(panel: vscode.WebviewPanel) { return panels.get(panel); },
  activePanel(): vscode.WebviewPanel | undefined { return lastActive; },
  activeDocument(): VaporviewDocument | undefined { return lastActive ? panels.get(lastActive) : undefined; },
  readyCount(document: VaporviewDocument): number { return readyCount.get(document) || 0; },
};

function postPage(panel: vscode.WebviewPanel, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const id = pageCallId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pageCalls.delete(id); reject(new Error('page call timed out')); }, timeoutMs);
    pageCalls.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (er) => { clearTimeout(timer); reject(er); } });
    panel.webview.postMessage({ cmuxBridge: true, id, ...body });
  });
}

/** The <script> tags for the bridge and the modules, put around VaporView's webview.js tag. */
export const CMUX_MODULES = ['cmux-ui', 'cmux-expr', 'cmux-enum', 'cmux-formats', 'cmux-textmatch', 'cmux-debugger-text',
  'cmux-debugger-commits', 'cmux-debugger', 'cmux-riscv-disasm', 'cmux-machine-core', 'cmux-sequence', 'cmux-machine', 'cmux-fsm',
  'cmux-trace', 'cmux-trace-ui'];

export function injectCmuxScripts(html: string, webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const src = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'cmux', f)).toString();
  const before = `<link rel="stylesheet" href="${src('cmux.css')}">\n  <link rel="stylesheet" href="${src('bridge.css')}">\n`
    + `  <script src="${src('strings.js')}"></script>\n  <script src="${src('bridge.js')}"></script>\n  `;
  const after = '\n' + CMUX_MODULES.concat(['bridge-after']).map((m) => `  <script src="${src(m + '.js')}"></script>`).join('\n');
  const tag = /<script src="[^"]*webview\.js"><\/script>/;
  if (!tag.test(html)) { log('cmux bridge: webview.js tag not found; modules not loaded'); return html; }
  return html.replace(tag, (t) => before + t + after);
}

// ---- native messages the bridge handles itself (host.js's header list) ----
export function registerDefaultNativeHandlers(context: vscode.ExtensionContext) {
  const sub = (d: vscode.Disposable) => context.subscriptions.push(d);
  sub(cmuxBridge.onNative('log', (m) => log('page: ' + String(m.message))));
  sub(cmuxBridge.onNative('error', (m) => { vscode.window.showErrorMessage(String(m.message || 'Waveform viewer error')); }));
  sub(cmuxBridge.onNative('toast', (m) => {
    const text = String(m.message || '');
    if (!text) { return; }
    if (m.kind === 'error') { vscode.window.showErrorMessage(text); }
    else if (m.kind === 'warning') { vscode.window.showWarningMessage(text); }
    else { vscode.window.showInformationMessage(text); }
  }));
  sub(cmuxBridge.onNative('copy', (m) => { vscode.env.clipboard.writeText(String(m.text || '')); }));
  sub(cmuxBridge.onNative('modulesLoaded', (m) => log('cmux modules loaded: ' + JSON.stringify(m.modules))));
  sub(cmuxBridge.onNative('reload', (_m, ctx) => { vscode.commands.executeCommand('vaporview.reloadFile', ctx.document.uri); }));
  sub(cmuxBridge.onNative('loadSession', () => { vscode.commands.executeCommand('vaporview.loadViewerSession'); }));
  sub(cmuxBridge.onNative('saveSession', () => { vscode.commands.executeCommand('vaporview.saveViewerSession'); }));
  sub(cmuxBridge.onNative('loadValueAliases', () => { vscode.commands.executeCommand('vaporview.loadValueAliases'); }));
  sub(cmuxBridge.onNative('openReadme', () => {
    vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(context.extensionPath, 'README.md')));
  }));
  // VS Code forwards VaporView's events itself (emitEvent); these cmux-host messages have no VS Code meaning.
  for (const t of ['event', 'settings', 'sessionState', 'keyState', 'opened', 'ready']) { sub(cmuxBridge.onNative(t, () => {})); }
}
