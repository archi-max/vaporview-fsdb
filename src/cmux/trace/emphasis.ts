// vscode-port: the editor's emphasis for a trace step. The block that affects the signal keeps its
// highlight (the procedure, or the assign / port connection); inside it the statement that drove the value is marked
// strongly, the other writes of the signal (in the block, and the other blocks or assigns driving it) lightly, a branch
// only inferred or possible with a dashed border; each if / case line shows its condition's value at the sample.
import * as vscode from 'vscode';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Loc { file: string; line: number; col?: number; endLine?: number; endCol?: number }
export interface Emphasis {
  file: string;
  block: number[][]; driver: number[][]; possible: number[][]; others: number[][];
  conditions: { line: number; text: string }[];
}

const accent = new vscode.ThemeColor('editorInfo.foreground');
const TYPES = {
  block: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground') }),
  driver: vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: accent, overviewRulerColor: accent, overviewRulerLane: vscode.OverviewRulerLane.Left,
    fontWeight: 'bold',
  }),
  possible: vscode.window.createTextEditorDecorationType({
    isWholeLine: true, borderWidth: '1px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
  }),
  others: vscode.window.createTextEditorDecorationType({
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'dotted', borderColor: new vscode.ThemeColor('editorCodeLens.foreground'),
  }),
  condition: vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 1.5em' },
  }),
};

/** A cmux bits string as a SystemVerilog literal (binary up to 8 bits, else hex when no x/z). */
export function literal(bits: string): string {
  const b = String(bits || '');
  if (!b) { return '?'; }
  if (b.length <= 8 || /[xz]/i.test(b)) { return `${b.length}'b${b}`; }
  let hex = '';
  for (let i = b.length; i > 0; i -= 4) { hex = parseInt(b.slice(Math.max(0, i - 4), i), 2).toString(16) + hex; }
  return `${b.length}'h${hex}`;
}

const lines = (l: Loc | null | undefined): number[] | null => (l && l.file ? [Number(l.line), Number(l.endLine || l.line)] : null);
const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];

/** What a step marks, file by file (the step's statement's file first). */
export function emphasisOf(st: Json): Emphasis | null {
  if (!st || st.error || !st.stmt || !st.stmt.loc || !st.stmt.loc.file) { return null; }
  const file = String(st.stmt.loc.file);
  const inFile = (l: Loc | null | undefined) => !!l && String(l.file) === file;
  const e: Emphasis = { file, block: [], driver: [], possible: [], others: [], conditions: [] };
  const blockLoc = st.driver && st.driver.kind === 'proc' && inFile(st.driver.loc) ? st.driver.loc : st.stmt.loc;
  e.block.push(lines(blockLoc)!);
  const stmt = lines(st.stmt.loc)!;
  const wroteIt = st.wrote !== false && !same(stmt, e.block[0]);
  if (wroteIt) { (st.inferred ? e.possible : e.driver).push(stmt); }
  for (const c of st.candidates || []) { const r = lines(c.loc); if (r && inFile(c.loc)) { e.possible.push(r); } }
  const marked = [...e.driver, ...e.possible];
  for (const w of st.writes || []) {
    const r = lines(w.loc);
    if (r && inFile(w.loc) && !marked.some((x) => same(x, r))) { e.others.push(r); }
  }
  for (const d of st.drivers || []) {
    const r = lines(d.loc);
    if (r && inFile(d.loc) && !same(r, e.block[0]) && !e.others.some((x) => same(x, r))) { e.others.push(r); }
  }
  for (const d of st.decisions || []) {
    if (!d.loc || !inFile(d.loc)) { continue; }
    // "en: no value (not in the dump)" vs "en = 1'bx": never x for a signal with no value.
    const single = d.noValue && d.noValue.length === 1 && String(d.noValue[0]).split('.').pop() === d.src;
    const text = d.noValue ? (single ? d.noValueText : `${d.src}: ${d.noValueText || 'no value'}`) : `${d.src} = ${literal(d.value)}`;
    e.conditions.push({ line: Number(d.loc.line), text: text + (d.inferred ? ' (branch inferred)' : '') });
  }
  return e;
}

/** Marks the step in every visible editor of its file (and clears the marks of the step before). */
export class StepEmphasis implements vscode.Disposable {
  last: Emphasis | null = null;
  private subs: vscode.Disposable[] = [];
  constructor() {
    this.subs.push(vscode.window.onDidChangeVisibleTextEditors(() => this.apply()));
  }
  show(st: Json) { this.last = emphasisOf(st); this.apply(); }
  clear() { this.last = null; this.apply(); }
  private apply() {
    const e = this.last;
    for (const ed of vscode.window.visibleTextEditors) {
      const mine = !!e && ed.document.uri.scheme === 'file' && ed.document.uri.fsPath === e.file;
      const ranges = (list: number[][]) => (mine ? list.map(([a, b]) => new vscode.Range(a - 1, 0, b - 1, 0)) : []);
      ed.setDecorations(TYPES.block, ranges(e ? e.block : []));
      ed.setDecorations(TYPES.driver, ranges(e ? e.driver : []));
      ed.setDecorations(TYPES.possible, ranges(e ? e.possible : []));
      ed.setDecorations(TYPES.others, ranges(e ? e.others : []));
      ed.setDecorations(TYPES.condition, mine && e ? e.conditions.map((c) => {
        const ln = Math.min(Math.max(0, c.line - 1), ed.document.lineCount - 1);
        const end = ed.document.lineAt(ln).range.end;
        return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: c.text } } };
      }) : []);
    }
  }
  dispose() { this.subs.forEach((d) => d.dispose()); this.clear(); }
}
