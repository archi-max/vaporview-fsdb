// vscode-port: the driver highlight. While a signal is selected (its waveform row, or the editor
// cursor on its name), every source line that assigns it gets a subtle gutter mark and a faint line tint; the statement
// that actually drives it at the marker time (Trace Driver's step) gets a solid accent bar and a dim note
// "drives <sig> at <t>". Cleared when the selection clears. vaporview.trace.driverHighlight (default on); with no
// design chosen it shows nothing.
import * as vscode from 'vscode';
import * as path from 'path';
import { driverHighlights } from '../shared/driver_style';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
import { Highlight, highlightOf } from './highlight_of';
export { Highlight, highlightOf };

export class DriverHighlight implements vscode.Disposable {
  last: Highlight | null = null;
  private subs: vscode.Disposable[] = [];
  constructor() {
    this.subs.push(vscode.window.onDidChangeVisibleTextEditors(() => this.apply()));
  }
  show(h: Highlight | null) { this.last = h; this.apply(); }
  clear() { this.last = null; driverHighlights.clear('trace'); }
  /** The note on the active line: "drives <sig> at <t>". */
  static noteText(h: Highlight) { return `drives ${h.signal.split('.').pop()} at ${h.time}${h.unit ? ' ' + h.unit : ''}`; }
  /** The note when no line drives it at the marker: "driver unknown: <why>". */
  static unknownText(h: Highlight) { return `driver unknown at ${h.time}${h.unit ? ' ' + h.unit : ''}: ${h.unknown}`; }
  private apply() {
    const h = this.last;
    if (!h) { driverHighlights.clear('trace'); return; }
    for (const ed of vscode.window.visibleTextEditors) {
      const fsPath = ed.document.uri.scheme === 'file' ? ed.document.uri.fsPath : '';
      const mine = (r: { file: string }) => !!fsPath && path.resolve(r.file) === fsPath;
      const range = (r: { line: number; endLine: number }) => new vscode.Range(r.line - 1, 0, Math.max(r.line, r.endLine) - 1, 0);
      const act = h.active && mine(h.active) ? h.active : null;
      const dim = h.all.filter((r) => mine(r) && !(act && r.line === act.line && r.endLine === act.endLine)).map((r) => ({ range: range(r) }));
      const notes: vscode.DecorationOptions[] = [];
      // (no active line but the marker asked: the note goes on the first marked line here, saying why)
      const noteAt = act || (h.unknown ? h.all.filter(mine).sort((a, b) => a.line - b.line)[0] : null);
      if (noteAt) {
        const ln = Math.min(Math.max(0, noteAt.line - 1), ed.document.lineCount - 1);
        const end = ed.document.lineAt(ln).range.end;
        notes.push({ range: new vscode.Range(end, end), renderOptions: { after: { contentText: act ? DriverHighlight.noteText(h) : DriverHighlight.unknownText(h) } } });
      }
      driverHighlights.set('trace', ed, { dim, active: act ? [{ range: range(act) }] : [], notes });
    }
  }
  dispose() { this.subs.forEach((d) => d.dispose()); this.clear(); }
}
