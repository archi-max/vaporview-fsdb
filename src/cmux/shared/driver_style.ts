// vscode-port: the one look of a "driver" line in the editor, shared by Trace's driver highlight
// and the debugger's stopped-line driver bar . Every line that assigns the signal: a 3 px green bar at 55%;
// the line driving it now: the full bar, a faint green line background and a dim green note. The colours are theme
// colours contributed in package.json (vaporview.driverBar, driverBarDim, driverLineBackground, driverNote).
//
// Both owners draw through driverHighlights: it keeps each owner's lines per document and paints their union on its
// own decoration types, a line active for either owner drawn active only (never a dim bar under an active one), so a
// debug stop on a traced line shows one bar.
import * as vscode from 'vscode';

export const driverBarDimOptions: vscode.DecorationRenderOptions = {
  isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('vaporview.driverBarDim'),
};
export const driverBarActiveOptions: vscode.DecorationRenderOptions = {
  isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('vaporview.driverBar'),
  backgroundColor: new vscode.ThemeColor('vaporview.driverLineBackground'),
  overviewRulerColor: new vscode.ThemeColor('vaporview.driverBar'), overviewRulerLane: vscode.OverviewRulerLane.Left,
};
export const driverNoteOptions: vscode.DecorationRenderOptions = {
  after: { color: new vscode.ThemeColor('vaporview.driverNote'), margin: '0 0 0 2em' },
};

export type DriverOwner = 'trace' | 'debug';
export interface DriverLines { dim: vscode.DecorationOptions[]; active: vscode.DecorationOptions[]; notes?: vscode.DecorationOptions[] }

class DriverHighlights {
  private types: { dim: vscode.TextEditorDecorationType; active: vscode.TextEditorDecorationType; note: vscode.TextEditorDecorationType } | null = null;
  private byOwner = new Map<DriverOwner, Map<string, DriverLines>>();
  private sub: vscode.Disposable | null = null;
  private ensure() {
    if (!this.types) {
      this.types = {
        dim: vscode.window.createTextEditorDecorationType(driverBarDimOptions),
        active: vscode.window.createTextEditorDecorationType(driverBarActiveOptions),
        note: vscode.window.createTextEditorDecorationType(driverNoteOptions),
      };
      this.sub = vscode.window.onDidChangeVisibleTextEditors(() => this.paintAll());
    }
    return this.types;
  }
  /** Sets `owner`'s lines in `editor`'s document (empty lists: none). */
  set(owner: DriverOwner, editor: vscode.TextEditor, lines: DriverLines) {
    const key = editor.document.uri.toString();
    let m = this.byOwner.get(owner);
    if (!m) { m = new Map(); this.byOwner.set(owner, m); }
    if (!lines.dim.length && !lines.active.length && !(lines.notes && lines.notes.length)) { m.delete(key); } else { m.set(key, lines); }
    this.paint(key);
  }
  /** Removes all of `owner`'s lines. */
  clear(owner: DriverOwner) {
    const m = this.byOwner.get(owner);
    if (!m || !m.size) { return; }
    const keys = [...m.keys()];
    m.clear();
    keys.forEach((k) => this.paint(k));
  }
  /** (tests) The union painted for a document: 1-based line numbers. */
  painted(uri: vscode.Uri | string) {
    const u = this.union(String(uri));
    const ln = (o: vscode.DecorationOptions) => o.range.start.line + 1;
    return { dim: u.dim.map(ln), active: u.active.map(ln), notes: u.notes.map((o) => ({ line: ln(o), text: o.renderOptions && o.renderOptions.after ? String(o.renderOptions.after.contentText || '') : '' })) };
  }
  private union(key: string) {
    const all: DriverLines[] = [];
    for (const m of this.byOwner.values()) { const l = m.get(key); if (l) { all.push(l); } }
    const activeLines = new Set<number>();
    const active: vscode.DecorationOptions[] = [];
    for (const l of all) { for (const o of l.active) { if (!activeLines.has(o.range.start.line)) { activeLines.add(o.range.start.line); active.push(o); } } }
    const dimLines = new Set<number>();
    const dim: vscode.DecorationOptions[] = [];
    for (const l of all) { for (const o of l.dim) { const n = o.range.start.line; if (!activeLines.has(n) && !dimLines.has(n)) { dimLines.add(n); dim.push(o); } } }
    const notes = all.flatMap((l) => l.notes || []);
    return { dim, active, notes };
  }
  private paint(key: string) {
    const t = this.ensure();
    const u = this.union(key);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() !== key) { continue; }
      ed.setDecorations(t.dim, u.dim);
      ed.setDecorations(t.active, u.active);
      ed.setDecorations(t.note, u.notes);
    }
  }
  private paintAll() {
    const keys = new Set<string>();
    for (const m of this.byOwner.values()) { for (const k of m.keys()) { keys.add(k); } }
    for (const ed of vscode.window.visibleTextEditors) { keys.add(ed.document.uri.toString()); }
    keys.forEach((k) => this.paint(k));
  }
  dispose() { if (this.sub) { this.sub.dispose(); } if (this.types) { Object.values(this.types).forEach((x) => x.dispose()); } this.types = null; this.byOwner.clear(); }
}

export const driverHighlights = new DriverHighlights();
