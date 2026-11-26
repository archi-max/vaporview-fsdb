// vscode-port P4: the SystemVerilog editor while the waveform debugger steps (cmux WaveformDebuggerEditorHighlights.swift,
// FilePreviewInlineValueOverlay.swift): the signals that changed this cycle are tinted, so are the lines that drive
// them, the module's other lines are dimmed; inline values come from an InlineValuesProvider during the session;
// Locals follow the cursor's module instance. Stop Debugging removes all of it.
import { formatInlineValue } from '../shared/value_format';
import { driverHighlights } from '../shared/driver_style';
import { INLINE_NO_VALUE_STYLE, INLINE_SEPARATOR, INLINE_VALUE_STYLE, NO_VALUE_ENTRY, noValueInline } from '../shared/inline_style';
import * as vscode from 'vscode';
import { WaveformDebugSession } from './session';
import { codeLines, identifiers, moduleAt, scanModules, signalLines, type ModuleInfo } from './sv-lines';
import type { InstanceResolver } from './instances';
import { valueBits, valueIn, pathKey, type SignalMeta } from './wave-data';
import { type DebugValue, noValueShown } from './engine';
import { isNoValue } from '../shared/port_resolve'; // vscode-port 
import { withReadingNote } from './reading-note'; // vscode-port #13

export const SV_LANGUAGES = ['verilog', 'systemverilog'];
export const isSvDocument = (d: vscode.TextDocument) => SV_LANGUAGES.includes(d.languageId) || /\.(sv|svh|v|vh)$/i.test(d.fileName);

// vscode-port drivers are a thin left bar (with "drives <signal>" hovers) on lines that drove a signal that changed
// this cycle, never on VS Code's paused line, which alone keeps the stack-frame highlight; no boxes on changed names and
// no dimming (the change shows in the inline value: cnt = 0c → 0d; mock v2 format).
type Drawn = { drivers: vscode.DecorationOptions[]; module: string; instance: string; changedNames: string[] };

export class DebuggerEditor implements vscode.InlineValuesProvider {
  // vscode-port the driver bars are the product's one driver look (src/cmux/shared/driver_style.ts, owned by
  // Trace): drawn through driverHighlights as owner 'debug', so a line Trace also marks gets one bar, never two. The
  // drivers of this cycle's changes are its dim bars (a 3 px green bar); the paused line keeps VS Code's own highlight.
  /** vscode-port the values themselves, as quiet text after the line (theme CodeLens colour; no background,
   *  border or box: VS Code's own inline values are drawn as yellow chips). Same style as the source link's values. */
  static readonly VALUE_STYLE = INLINE_VALUE_STYLE;
  private readonly valueDeco = vscode.window.createTextEditorDecorationType({
    after: DebuggerEditor.VALUE_STYLE, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  /** Per editor document URI: the values painted (the e2e hook reads them). */
  readonly painted = new Map<string, Array<{ line: number; text: string }>>();
  private paintSeq = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | undefined;
  /** "stoppedLine" (default): values on the paused line only; "all": every visible line; "off". */
  static mode(): 'stoppedLine' | 'all' | 'off' {
    const m = vscode.workspace.getConfiguration('vaporview.debug').get<string>('inlineValues', 'stoppedLine');
    return m === 'all' || m === 'off' ? m : 'stoppedLine';
  }
  /** VS Code's paused line (the stack frame the session last reported): never a driver bar. */
  private frameLine: { path: string; line: number } | null = null;
  /** Per editor document URI: what was drawn (the e2e hook reads it). */
  readonly drawn = new Map<string, Drawn[]>();
  private disposables: vscode.Disposable[] = [];
  private readonly inlineChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeInlineValues = this.inlineChanged.event;

  constructor(private readonly resolver: InstanceResolver) {
    this.disposables.push(
      WaveformDebugSession.onStop.event(({ session }) => { void this.refresh(session); }),
      WaveformDebugSession.onDesignRead.event(() => this.repaintValues()), // vscode-port 
      WaveformDebugSession.onEnd.event(() => this.clear()),
      WaveformDebugSession.onFrame.event((f) => { this.frameLine = f; this.paint(); const s = WaveformDebugSession.current; if (s) { WaveformDebugSession.valuesFirst = this.paintValues(s); } }), // vscode-port / (Locals wait for it)
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (DebuggerEditor.mode() !== 'all' || !isSvDocument(e.textEditor.document)) { return; }
        clearTimeout(this.scrollTimer); this.scrollTimer = setTimeout(() => this.repaintValues(), 150);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('vaporview.debug.inlineValues')) { this.repaintValues(); } }),
      vscode.window.onDidChangeVisibleTextEditors(() => { if (WaveformDebugSession.current) { void this.refresh(WaveformDebugSession.current); } }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.followCursor(e.textEditor)),
      vscode.languages.registerInlineValuesProvider([{ language: 'verilog' }, { language: 'systemverilog' }, { pattern: '**/*.{sv,svh,v,vh}' }], this),
    );
  }

  dispose() { this.clear(); this.disposables.forEach((d) => d.dispose()); this.valueDeco.dispose(); }

  clear() {
    for (const e of vscode.window.visibleTextEditors) { e.setDecorations(this.valueDeco, []); }
    driverHighlights.clear('debug');
    this.paintSeq++;
    this.painted.clear();
    this.drawn.clear();
    this.frameLine = null;
  }

  /** The driver bars of what was drawn, minus VS Code's paused line. */
  private paint() {
    for (const editor of vscode.window.visibleTextEditors) {
      const list = this.drawn.get(editor.document.uri.toString());
      if (!list) { continue; }
      const f = this.frameLine && this.frameLine.path === editor.document.uri.fsPath ? this.frameLine.line : -1;
      const opts: vscode.DecorationOptions[] = [];
      for (const d of list) { for (const o of d.drivers) { if (o.range.start.line !== f) { opts.push(o); } } }
      driverHighlights.set('debug', editor, { dim: opts, active: [] });
    }
  }

  /** The paused line in `uri` (0-based), -1 when it is elsewhere (the e2e hook reads it). */
  frameLineIn(uri: string) { return this.frameLine && vscode.Uri.file(this.frameLine.path).toString() === uri ? this.frameLine.line : -1; }

  /** Locals follow the cursor: the instance of the module the cursor is in. */
  private async followCursor(editor: vscode.TextEditor) {
    const s = WaveformDebugSession.current;
    if (!s || !isSvDocument(editor.document)) { return; }
    const mods = scanModules(editor.document.getText());
    const mod = moduleAt(mods, editor.selection.active.line);
    let inst = mod ? await this.resolver.thisInstance(mod, s.data, mods) : null;
    // vscode-port: after a signal breakpoint's stop the editor opens the driver's module; when the stopped signal's
    // instance is one of that module's, Locals stay there (not the module's first instance)
    if (mod && s.stopScope) {
      const at = s.stopScope.join('.');
      if ((await this.resolver.instancesOf(mod, s.data)).some((p) => p.join('.') === at)) { inst = s.stopScope; }
    }
    const next = inst ? inst.join('.') : null;
    if (next && next !== (s.editorScope || []).join('.')) { void s.customRequestLocal('setLocalsScope', { path: next }); }
  }

  private async changedIn(session: WaveformDebugSession, scope: string[], time: number, previous: number | null): Promise<{ vars: SignalMeta[]; changed: Set<string> }> {
    const vars = (await session.data.children(scope)).filter((c) => c.kind === 'var') as SignalMeta[];
    const changed = new Set<string>();
    if (previous === null) { return { vars, changed }; }
    const before = await session.engine.valuesAt(vars, previous), now = await session.engine.valuesAt(vars, time);
    // signals without dump values are read through the design, all of them in one batch per time (was one
    // read per signal, in series: a big FSDB without port copies spent most of a stop here)
    const missing = vars.map((_v, i) => i).filter((i) => before[i] === undefined || now[i] === undefined);
    // (quick reads: a design read still in flight counts as unchanged for these bars; Locals and values show it)
    const ra = missing.length ? await session.engine.readAtQuick(missing.map((i) => vars[i]), previous) : [];
    const rb = missing.length ? await session.engine.readAtQuick(missing.map((i) => vars[i]), time) : [];
    const viaDesign = new Map(missing.map((i, k) => [i, [ra[k], rb[k]] as const]));
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      let a: string | undefined = before[i], b: string | undefined = now[i];
      const d = viaDesign.get(i);
      if (d) {
        // with no value at either end it never "changed"
        const [x, y] = d;
        if (!x || !y || isNoValue(x) || isNoValue(y)) { continue; }
        a = x.bits; b = y.bits;
      }
      if (a === undefined || b === undefined) { continue; }
      // Changed during the cycle that ends at the marker: (previous, time].
      if (valueBits(a, v.width) !== valueBits(b, v.width)) { changed.add(v.name); }
    }
    return { vars, changed };
  }

  async refresh(session: WaveformDebugSession) {
    const stop = session.lastStop;
    if (!stop) { return; }
    // vscode-port the stopped line's values first (a few signals), then the driver bars (every var of the instance)
    await this.paintValues(session);
    // (and the paused line's own paint, which the stack frame starts: bars never delay values)
    await new Promise((r) => setTimeout(r, 0));
    const first = WaveformDebugSession.valuesFirst;
    if (first) { await Promise.race([first.catch(() => undefined), new Promise((r) => setTimeout(r, 15000))]); }
    if (session.lastStop !== stop) { return; } // (a newer stop draws)
    this.drawn.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      if (!isSvDocument(editor.document)) { continue; }
      const text = editor.document.getText();
      const lines = codeLines(text);
      const list: Drawn[] = [];
      const mods = scanModules(text);
      // vscode-port driver bars need every var of an instance at two times (a big file's first touch: CVA6 FSDB
      // ~30 s for all modules); by default only the module of the Locals instance (the stopped one) gets them, every
      // module with "all"
      const only = DebuggerEditor.mode() === 'all' ? null : pathKey(session.scope() || []);
      for (const mod of mods) {
        const inst = await this.resolver.thisInstance(mod, session.data, mods);
        if (!inst || (only !== null && pathKey(inst) !== only)) { continue; }
        if (session.lastStop !== stop) { return; } // (a step came: its own refresh draws; these reads stop here)
        const { changed } = await this.changedIn(session, inst, stop.time, stop.previousTime);
        const { drivers } = signalLines(lines, mod, changed);
        const byLine = new Map<number, string[]>();
        for (const [name, ns] of drivers) { for (const n of ns) { const l = byLine.get(n) || []; if (!l.includes(name)) { l.push(name); } byLine.set(n, l); } }
        const d: Drawn = { drivers: [], module: mod.name, instance: inst.join('.'), changedNames: [...changed] };
        for (const [n, names] of byLine) {
          const hover = new vscode.MarkdownString(`drives ${names.map((x) => '`' + x + '`').join(', ')} (changed this cycle)`);
          d.drivers.push({ range: new vscode.Range(n, 0, n, 0), hoverMessage: hover });
        }
        list.push(d);
      }
      this.drawn.set(editor.document.uri.toString(), list);
    }
    this.paint();
  }

  private repaintValues() { const s = WaveformDebugSession.current; if (s) { void this.paintValues(s); } }

  /** vscode-port the values after the paused line (or every visible line, or none: vaporview.debug.inlineValues),
   *  as quiet text. Locals and the waveform already show every value, so by default only the stopped line has them. */
  async paintValues(s: WaveformDebugSession) {
    const seq = ++this.paintSeq;
    const mode = DebuggerEditor.mode();
    const next = new Map<string, Array<{ line: number; text: string; reasons?: string[] }>>();
    for (const editor of vscode.window.visibleTextEditors) {
      if (!isSvDocument(editor.document) || mode === 'off' || s.time === null) { continue; }
      const uri = editor.document.uri.toString();
      const f = this.frameLineIn(uri);
      const ranges: Array<[number, number]> = mode === 'all' ? editor.visibleRanges.map((r) => [r.start.line, r.end.line]) : f >= 0 ? [[f, f]] : [];
      const rows: Array<{ line: number; text: string; reasons?: string[] }> = [];
      for (const [a, b] of ranges) {
        const reasons: Array<{ line: number; text: string }> = [];
        for (const v of await this.inlineValues(s, editor.document.getText(), a, b, reasons).catch(() => [] as vscode.InlineValueText[])) {
          const line = v.range.start.line;
          if (!rows.some((r) => r.line === line)) { rows.push({ line, text: v.text, reasons: reasons.filter((x) => x.line === line).map((x) => x.text) }); }
        }
      }
      next.set(uri, rows);
    }
    if (seq !== this.paintSeq) { return; } // (a newer stop or scroll repainted)
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      const rows = next.get(uri) || [];
      const doc = editor.document;
      editor.setDecorations(this.valueDeco, rows.map((r) => {
        const end = doc.lineAt(Math.min(r.line, doc.lineCount - 1)).range.end;
        // (a line whose every value is "no value" is drawn at half opacity; mixed lines stay at full)
        const none = r.text.split(INLINE_SEPARATOR).every((part) => NO_VALUE_ENTRY.test(part));
        const why = r.reasons && r.reasons.length ? new vscode.MarkdownString(r.reasons.map((x) => '`' + x.split(': ')[0] + '`: ' + x.slice(x.indexOf(': ') + 2)).join('  \n')) : undefined;
        return { range: new vscode.Range(end, end), ...(why ? { hoverMessage: why } : {}), renderOptions: { after: { ...(none ? INLINE_NO_VALUE_STYLE : {}), contentText: r.text } } };
      }));
    }
    this.painted.clear();
    for (const [u, rows] of next) { if (rows.length) { this.painted.set(u, rows); } }
  }

  /** Inline values: each line's signals with their value at the marker, in the module's instance. */
  /** VS Code's calls of the provider (the e2e hook reads them): it asks only when it will draw the values. */
  readonly provided: Array<{ uri: string; count: number }> = [];

  async provideInlineValues(document: vscode.TextDocument, viewPort: vscode.Range): Promise<vscode.InlineValue[]> {
    // vscode-port the values are drawn by paintValues (quiet text, stopped line by default); VS Code's own inline
    // values (yellow chips) get none. The provider stays registered so VS Code draws no fallback values of its own.
    if (document && viewPort) { this.provided.push({ uri: document.uri.toString(), count: 0 }); if (this.provided.length > 50) { this.provided.shift(); } }
    return [];
  }

  async inlineValues(s: WaveformDebugSession, text: string, first: number, last: number, reasons?: Array<{ line: number; text: string }>): Promise<vscode.InlineValueText[]> {
    const lines = codeLines(text);
    const modules = scanModules(text);
    const instOf = new Map<ModuleInfo, string[] | null>();
    // vscode-port: find each line's signals first, then read all their values in one batched query (was one query per
    // name, in series: ~1,000 round trips on a big module).
    const rows: Array<{ n: number; names: string[]; metas: SignalMeta[] }> = [];
    const metas: SignalMeta[] = [];
    const missing = new Map<string, DebugValue | null>(); // module-declared names the dump lacks (shown as no value)
    const missingMetas: SignalMeta[] = [];
    const inBatch = new Set<string>();
    for (let n = Math.max(0, first); n <= Math.min(last, lines.length - 1); n++) {
      const mod = moduleAt(modules, n);
      if (!mod) { continue; }
      if (!instOf.has(mod)) { instOf.set(mod, await this.resolver.thisInstance(mod, s.data, modules)); }
      const inst = instOf.get(mod);
      if (!inst) { continue; }
      const row = { n, names: [] as string[], metas: [] as SignalMeta[] };
      const seen = new Set<string>();
      for (const id of identifiers(lines[n])) {
        if (seen.has(id.name)) { continue; }
        seen.add(id.name);
        const v = await s.data.find(inst.concat(id.name));
        if (!v) {
          if (!mod.ports.includes(id.name) && !mod.declared.includes(id.name)) { continue; }
          // a port / net of the module that the dump does not have at all: through the design, else no value
          const path = inst.concat(id.name);
          const meta: SignalMeta = { kind: 'var', name: id.name, path, width: 1 };
          if (!missing.has(pathKey(path))) { missing.set(pathKey(path), null); missingMetas.push(meta); }
          row.names.push(id.name); row.metas.push(meta);
          continue;
        }
        row.names.push(id.name); row.metas.push(v);
        if (!inBatch.has(pathKey(v.path))) { inBatch.add(pathKey(v.path)); metas.push(v); } // (each signal read once, however many lines use it)
      }
      if (row.metas.length) { rows.push(row); }
    }
    // The dump's values first, then the design reads: a first design read starts Trace's model build, which shares the
    // helper; started first, the dump read queued behind it (CVA6 FSDB inline 15 s -> 105 s).
    const values = metas.length ? await withReadingNote(metas.length, s.engine.readAtQuick(metas, s.time ?? 0)) : [];
    // vscode-port a signal that changed this cycle shows previous→now (the cycle that ends at the marker)
    const prevTime = s.lastStop && s.lastStop.time === s.time ? s.lastStop.previousTime : null;
    const before = metas.length && prevTime !== null ? await withReadingNote(metas.length, s.engine.valuesAt(metas, prevTime)) : []; // (a cold read says so too)
    const radix = await viewerRadix(s);
    if (missingMetas.length) {
      const got = await s.engine.readAtQuick(missingMetas, s.time ?? 0);
      missingMetas.forEach((m, i) => missing.set(pathKey(m.path), got[i]));
    }
    const byMeta = new Map<string, DebugValue | null>(metas.map((m, i) => [pathKey(m.path), values[i]]));
    const prevOf = new Map<string, string | undefined>(metas.map((m, i) => [pathKey(m.path), before[i]]));
    const out: vscode.InlineValueText[] = [];
    for (const row of rows) {
      // "name = no value (tag)" (the full reason in the hover), a design-read value says where it came from
      const parts: string[] = [];
      row.metas.forEach((v, i) => {
        const k = pathKey(v.path), inDump = byMeta.has(k);
        const d = inDump ? byMeta.get(k)! : missing.get(k)!;
        if (d === null) { return; } // (being read through the design: VS Code asks again when it lands)
        // never a bare "no value": a short reason tag; the full reason in the hover
        if (isNoValue(d)) { const full = noValueShown(d); parts.push(noValueInline(row.names[i], full)); reasons?.push({ line: row.n, text: `${row.names[i]}: ${full}` }); return; }
        const w = inDump ? v.width : Math.max(1, d.bits.length); // (a name the dump lacks: its width from the read)
        const fmt = radix(k);
        const now = chipValue(d.bits, w, fmt);
        const p = prevOf.get(k);
        const was = p !== undefined && valueBits(p, w) !== valueBits(d.bits, w) ? chipValue(p, w, fmt) : null;
        parts.push(`${row.names[i]} = ${was !== null && was !== now ? `${was} → ${now}` : now}${d.via ? ` (via ${d.via})` : ''}`);
      });
      if (!parts.length) { continue; }
      out.push(new vscode.InlineValueText(new vscode.Range(row.n, lines[row.n].length, row.n, lines[row.n].length), parts.join(INLINE_SEPARATOR)));
    }
    return out;
  }
}

/** What is drawn for one module (the e2e hook): has no change boxes and no dimming (both always empty), and the
 *  driver bars minus the paused line (`frameLine`, 0-based, -1 for none). */
export function describeDrawn(d: Drawn, frameLine = -1) {
  const all = d.drivers.map((o) => o.range.start.line);
  return { module: d.module, instance: d.instance, changedNames: d.changedNames, changedLines: [] as number[], dimmedLines: [] as number[],
    driverLines: all.filter((n) => n !== frameLine), driverHovers: d.drivers.map((o) => ({ line: o.range.start.line, text: String((o.hoverMessage as vscode.MarkdownString)?.value ?? '') })),
    frameLine };
}
export { pathKey };

/** vscode-port an inline value in the waveform's radix for that signal (hex unless its row says otherwise), as
 *  width'radix (8'h12; one bit 0/1/x/z; SystemVerilog's x / X digit rule): the shared formatter, as the source link's. */
export function chipValue(bitsIn: string, width: number, format: string): string {
  return formatInlineValue(valueBits(bitsIn, width) ?? bitsIn, width, format);
}

/** The waveform rows' number formats by signal path (hex when the signal has no row). */
async function viewerRadix(s: WaveformDebugSession): Promise<(path: string) => string> {
  return (path) => { try { return s.rowFormat(path.split('.')) || 'hexadecimal'; } catch { return 'hexadecimal'; } };
}

