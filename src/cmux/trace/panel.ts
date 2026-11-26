// vscode-port: the Trace Driver panel, a webview beside the waveform (cmux showed it over its page).
// It renders what the controller sends (media/cmux/trace/trace-panel.js, a port of cmux-trace-ui.js's render and
// renderChain) and posts the user's clicks back.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Json } from './sidecar';

export class TracePanel {
  private panel: vscode.WebviewPanel | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  lastState: Json = null;
  private pending = new Map<number, (v: Json) => void>();
  private nextId = 1;

  /** Called when the user closes the panel. */
  onClose: (() => void) | null = null;
  constructor(private readonly context: vscode.ExtensionContext, private readonly onMessage: (m: Json) => void) {}

  private ensure(): vscode.WebviewPanel {
    if (this.panel) { return this.panel; }
    const media = vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'cmux', 'trace'));
    const panel = vscode.window.createWebviewPanel('vaporview.trace', 'Trace Driver', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'trace-panel.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'trace-panel.css'));
    const strings = fs.readFileSync(path.join(media.fsPath, 'strings.json'), 'utf8');
    const nonce = Math.random().toString(36).slice(2);
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"></head><body><div id="trace"></div>
<script nonce="${nonce}">window.traceStrings = ${strings.replace(/</g, '\\u003c')};</script>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.ready = new Promise((r) => { this.readyResolve = r; });
    panel.webview.onDidReceiveMessage((m: Json) => {
      if (m && m.type === 'ready') { if (this.readyResolve) { this.readyResolve(); } return; }
      if (m && m.type === 'e2e') { const f = this.pending.get(m.id); if (f) { this.pending.delete(m.id); f(m.result); } return; }
      this.onMessage(m);
    });
    panel.onDidDispose(() => { this.panel = null; this.ready = null; if (this.onClose) { this.onClose(); } });
    this.panel = panel;
    return panel;
  }

  /** The editor column the panel is in (undefined: not open). */
  get viewColumn(): vscode.ViewColumn | undefined { return this.panel ? this.panel.viewColumn : undefined; }
  get visible(): boolean { return !!this.panel && this.panel.visible; }

  /** A note shown under each step / chain about the design Trace loaded (null: none). */
  designNote: string | null = null;
  show(state: Json) {
    if (state && (state.kind === 'step' || state.kind === 'chain') && this.designNote) { state = Object.assign({}, state, { designNote: this.designNote }); }
    this.lastState = state;
    const panel = this.ensure();
    if (!panel.visible) { panel.reveal(undefined, true); }
    void this.ready!.then(() => panel.webview.postMessage({ type: 'render', state }));
  }

  /** Test-only (registered when VAPORVIEW_E2E=1): the panel's DOM, or a click on one of its elements. */
  async e2e(q: Json): Promise<Json> {
    if (!this.panel || !this.ready) { return { error: 'no trace panel' }; }
    await this.ready;
    const id = this.nextId++;
    const reply = new Promise<Json>((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => { if (this.pending.delete(id)) { resolve({ error: 'timeout' }); } }, 10000);
    });
    await this.panel.webview.postMessage({ type: 'e2e', id, query: q });
    return reply;
  }

  dispose() { if (this.panel) { this.panel.dispose(); } }
}
