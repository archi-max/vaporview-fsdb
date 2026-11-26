// vscode-port P4: registers the waveform debugger: the inline Debug Adapter (debug type `vaporview-waveform`), its palette
// commands (cmux View > Waveform Debugger), the row menu's Break When… items, the status bar item and the editor side.
import { driverHighlights } from '../shared/driver_style';
import { INLINE_NO_VALUE_STYLE, INLINE_VALUE_STYLE } from '../shared/inline_style';
import * as vscode from 'vscode';
import { WaveformDebugSession, DEBUG_TYPE, anyInstanceLines, type ViewerLink } from './session';
import { TextInstanceResolver } from './instances';
import { DebugEngine } from './engine'; // vscode-port
import { DebuggerEditor, describeDrawn, isSvDocument } from './editor';
import { readingNotes } from './reading-note'; // vscode-port #13
import { setFormatsPath, disposeTextJudge } from './text-judge';
import { moduleAt, scanModules } from './sv-lines';
import { DocumentWaveData } from './wave-data';
import { waveformData } from '../data';
import type { SourceLinkApi } from '../link';
import type { WaveformViewerProvider } from '../../extension_core/viewer_provider';
import type { VaporviewDocument } from '../../extension_core/document';

type MarkerEvent = { uri: string; time: number };

function flattenRows(items: any[], out: any[] = []): any[] {
  for (const it of items || []) {
    if (it && it.dataType === 'netlist-variable') { out.push(it); }
    if (it && Array.isArray(it.children)) { flattenRows(it.children, out); }
  }
  return out;
}

const waveDatas = new WeakMap<VaporviewDocument, DocumentWaveData>();

export function viewerLink(provider: WaveformViewerProvider, markerEvent: vscode.Event<MarkerEvent>): ViewerLink {
  const doc = (uri: string): VaporviewDocument | undefined => provider.getDocumentFromUri(uri);
  return {
    documents() {
      const all = provider.getAllDocumentUris();
      const active = (provider.getActiveDocument || provider.getLastActiveDocument)?.uri.toString();
      return active ? [active, ...all.filter((u) => u !== active)] : all;
    },
    fsPath: (uri) => doc(uri)?.uri.fsPath,
    waveData(uri) {
      const d = doc(uri);
      if (!d) { return undefined; }
      let w = waveDatas.get(d);
      if (!w) { w = new DocumentWaveData(waveformData(d)); waveDatas.set(d, w); }
      return w;
    },
    markerTime: (uri) => doc(uri)?.webviewContext.markerTime ?? null,
    setMarker(uri, time) {
      const d = doc(uri);
      const panel = d?.webviewPanel;
      if (!panel) { return; }
      void panel.webview.postMessage({ command: 'setMarker', time, markerType: 0, notUser: true }); // vscode-port: no dirty dot
      void panel.webview.postMessage({ command: 'setViewportTo', time });
    },
    selectedSignal(uri) {
      const d = doc(uri);
      if (!d) { return null; }
      const name = d.getNameFromNetlistId(d.webviewContext.selectedSignal)?.name;
      return name ? String(name).split('.') : null;
    },
    rowFormat(uri, path) {
      const d = doc(uri);
      if (!d) { return undefined; }
      const want = path.join('.');
      for (const row of flattenRows(d.webviewContext.displayedSignals as any[])) {
        const item = d.netlistIdTable[row.netlistId];
        if (item && item.instancePath() === want) { return row.numberFormat; }
      }
      return undefined;
    },
    onMarkerSet: (listener) => markerEvent((e) => listener(e.uri, e.time)),
  };
}

/** Row context (webview/context) → dump path. */
function rowPath(arg: any, link: ViewerLink, uri: string | undefined): string[] | null {
  if (arg && typeof arg.signalName === 'string') {
    return (arg.scopePath ? String(arg.scopePath).split('.') : []).concat(String(arg.signalName));
  }
  if (arg && typeof arg.path === 'string') { return arg.path.split('.'); }
  return uri ? link.selectedSignal(uri) : null;
}

export function registerWaveformDebugger(context: vscode.ExtensionContext, provider: WaveformViewerProvider, markerEvent: vscode.Event<MarkerEvent>,
  sourceLink?: Pick<SourceLinkApi, 'signalsAssignedOnLine'>) {
  setFormatsPath(context.extensionPath);
  const link = viewerLink(provider, markerEvent);
  if (sourceLink) {
    link.lineSignals = async (file, line) => (await sourceLink.signalsAssignedOnLine(vscode.Uri.file(file), line)).filter((s) => s.dumpPath);
  }
  const resolver = new TextInstanceResolver();
  const editor = new DebuggerEditor(resolver);
  const sub = (d: vscode.Disposable) => context.subscriptions.push(d);
  sub(editor);
  sub({ dispose: disposeTextJudge });

  sub(vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
    createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new WaveformDebugSession(link, resolver)),
  }));
  sub(vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
    resolveDebugConfiguration(_folder, config) {
      // F5 with no launch.json while a waveform is open: debug that waveform.
      if (!config.type && !config.request && !config.name) {
        const uri = link.documents()[0];
        if (!uri) { void vscode.window.showInformationMessage('Open a waveform in VaporView FSDB to debug it.'); return undefined; }
        return { type: DEBUG_TYPE, request: 'attach', name: 'Debug Waveform', waveform: uri };
      }
      if (!config.waveform) { config.waveform = link.documents()[0]; }
      return config;
    },
    provideDebugConfigurations: () => [{ type: DEBUG_TYPE, request: 'attach', name: 'Debug Waveform' }],
  }));

  // ---- status bar: cycle, rate, play ----
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'vaporview.debugger.togglePlay';
  sub(status);
  const showStatus = (s: WaveformDebugSession | null) => {
    if (!s || !s.engine) { status.hide(); return; }
    const st = s.state();
    status.text = `$(debug-alt) cycle ${st.cycle ?? 0}/${st.count} ${st.playing ? '$(debug-pause)' : '$(play)'} ${st.rate}/s`;
    status.tooltip = `Waveform debugger: clock ${st.clock}, Locals ${st.scope ?? '-'}${st.lastHit ? `, last hit ${st.lastHit}` : ''}`;
    status.show();
  };
  sub(WaveformDebugSession.onState.event((s) => showStatus(s)));
  sub(WaveformDebugSession.onEnd.event(() => { showStatus(null); void vscode.commands.executeCommand('setContext', 'vaporview.debugging', false); }));
  sub(vscode.debug.onDidStartDebugSession((s) => { if (s.type === DEBUG_TYPE) { void vscode.commands.executeCommand('setContext', 'vaporview.debugging', true); } }));

  // ---- commands ----
  const activeUri = () => link.documents()[0];
  async function ensureSession(): Promise<WaveformDebugSession | null> {
    let s = WaveformDebugSession.current;
    if (s && s.lastStop) { return s; }
    const uri = activeUri();
    if (!uri) { void vscode.window.showInformationMessage('Open a waveform in VaporView FSDB to debug it.'); return null; }
    if (!s) {
      // A waveform viewer counts as dirty once rows change; debug.saveBeforeStart would ask where to save its session.
      const ok = await vscode.debug.startDebugging(undefined, { type: DEBUG_TYPE, request: 'attach', name: 'Debug Waveform', waveform: uri }, { suppressSaveBeforeStart: true });
      if (!ok) { return null; }
    }
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      s = WaveformDebugSession.current;
      if (s && s.lastStop) { return s; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return WaveformDebugSession.current;
  }
  const request = (cmd: string, args?: any) => async () => {
    const s = await ensureSession();
    if (!s) { return undefined; }
    try { return await s.customRequestLocal(cmd, args); } catch (e) { void vscode.window.showWarningMessage(String(e instanceof Error ? e.message : e)); return undefined; }
  };
  const cmd = (id: string, fn: (...a: any[]) => any) => sub(vscode.commands.registerCommand('vaporview.debugger.' + id, fn));

  cmd('start', () => ensureSession());
  cmd('stepForward', request('step', { by: 1 }));
  cmd('stepBack', request('step', { by: -1 }));
  cmd('first', request('first'));
  cmd('last', request('last'));
  cmd('togglePlay', request('togglePlay'));
  cmd('faster', request('faster'));
  cmd('slower', request('slower'));
  cmd('continue', async () => { const s = await ensureSession(); if (s) { await s.continueTo(1); } });
  cmd('reverseContinue', async () => { const s = await ensureSession(); if (s) { await s.continueTo(-1); } });
  cmd('useSelectedAsClock', async (arg?: any) => {
    const s = await ensureSession();
    if (!s) { return undefined; }
    const path = arg && (arg.signalName || arg.path) ? rowPath(arg, link, s.uri) : null;
    try { return await s.customRequestLocal(path ? 'setClock' : 'useSelectedAsClock', path ? { path: path.join('.') } : {}); }
    catch (e) { void vscode.window.showWarningMessage(String(e instanceof Error ? e.message : e)); return undefined; }
  });
  cmd('defaultClock', request('setClock', { path: null }));
  cmd('stop', () => { if (vscode.debug.activeDebugSession?.type === DEBUG_TYPE) { return vscode.debug.stopDebugging(vscode.debug.activeDebugSession); } return vscode.debug.stopDebugging(); });
  cmd('evaluate', async (arg?: { expr?: string }) => {
    const s = await ensureSession();
    if (!s) { return undefined; }
    const expr = arg?.expr ?? await vscode.window.showInputBox({ title: 'Evaluate Expression', prompt: 'SystemVerilog expression at the marker (names in the Locals instance first)', placeHolder: 'state == 3 && cnt[3:0]' });
    if (!expr) { return undefined; }
    const r = await s.customRequestLocal('evaluateAt', { expr });
    const shown = r.error ? `${expr}: ${r.message}` : `${expr} = ${r.value} (${r.decimal})`;
    vscode.debug.activeDebugConsole.appendLine(shown);
    if (!arg?.expr) { void vscode.window.showInformationMessage(shown); }
    return r;
  });
  cmd('evaluateAtCycle', async (arg?: { expr?: string; cycle?: number }) => {
    const s = await ensureSession();
    if (!s) { return undefined; }
    const ed = vscode.window.activeTextEditor;
    const selected = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : (ed ? ed.document.getText(ed.document.getWordRangeAtPosition(ed.selection.active)) : '');
    const expr = arg?.expr ?? await vscode.window.showInputBox({ title: 'Evaluate at Cycle', prompt: 'Expression', value: selected });
    if (!expr) { return undefined; }
    const cycleText = arg?.cycle !== undefined ? String(arg.cycle) : await vscode.window.showInputBox({ title: 'Evaluate at Cycle', prompt: 'Cycle number', value: String(s.state().cycle ?? 1) });
    if (!cycleText) { return undefined; }
    const r = await s.customRequestLocal('evaluateAt', { expr, cycle: Number(cycleText) });
    const shown = r.error ? `${expr} @ cycle ${cycleText}: ${r.message}` : `${expr} @ cycle ${cycleText} = ${r.value} (${r.decimal})`;
    vscode.debug.activeDebugConsole.appendLine(shown);
    if (arg?.expr === undefined) { void vscode.window.showInformationMessage(shown); }
    return r;
  });
  cmd('addWatch', () => vscode.commands.executeCommand('workbench.debug.viewlet.action.addWatchExpression'));

  // Break When… on a row: function breakpoints (they show in the Breakpoints view, take conditions, toggle).
  const addSignalBreakpoint = (name: string, condition?: string) => {
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(name, true, condition || undefined)]);
    return name;
  };
  cmd('breakWhenChanges', (arg?: any) => {
    const path = rowPath(arg, link, activeUri());
    if (!path) { return undefined; }
    return addSignalBreakpoint(`${path.join('.')} changes`, arg?.condition);
  });
  cmd('breakWhenEquals', async (arg?: any) => {
    const path = rowPath(arg, link, activeUri());
    if (!path) { return undefined; }
    const value = arg?.value ?? await vscode.window.showInputBox({ title: `Break When ${path.join('.')} Equals`, prompt: "A value: 5, 8'h3c, 4'b1?0x", placeHolder: "8'h3c" });
    if (!value) { return undefined; }
    return addSignalBreakpoint(`${path.join('.')} == ${value}`, arg?.condition);
  });
  cmd('breakWhenTextMatches', async (arg?: any) => {
    const uri = activeUri();
    const path = rowPath(arg, link, uri);
    if (!path) { return undefined; }
    const pattern = arg?.pattern ?? await vscode.window.showInputBox({ title: `Break When ${path.join('.')} Text Matches`, prompt: 'A regular expression over the row\'s shown text, such as ^csrw', placeHolder: '^jal ra' });
    if (!pattern) { return undefined; }
    const format = arg?.format ?? (uri ? link.rowFormat(uri, path) : undefined) ?? 'hexadecimal';
    return addSignalBreakpoint(`${path.join('.')} ~ /${pattern}/${arg?.caseSensitive ? '' : 'i'} ${format}`, arg?.condition);
  });

  // F9 in any instance of the module (a native line breakpoint marked "any instance").
  cmd('toggleLineBreakpointAnyInstance', async (arg?: { uri?: string; line?: number }) => {
    const ed = vscode.window.activeTextEditor;
    const uri = arg?.uri ? vscode.Uri.parse(arg.uri) : ed?.document.uri;
    const line = arg?.line ?? ed?.selection.active.line;
    if (!uri || line === undefined) { return undefined; }
    const key = `${uri.toString()}#${line}`;
    const existing = vscode.debug.breakpoints.filter((b) => b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === uri.toString() && b.location.range.start.line === line);
    if (anyInstanceLines.has(key)) {
      anyInstanceLines.delete(key);
      vscode.debug.removeBreakpoints(existing);
      return false;
    }
    anyInstanceLines.add(key);
    // Re-add so the adapter sees the line again with its new marking.
    if (existing.length) { vscode.debug.removeBreakpoints(existing); }
    const old = existing[0] as vscode.SourceBreakpoint | undefined;
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)), true, old?.condition)]);
    return true;
  });
  cmd('chooseInstance', async (arg?: { uri?: string; line?: number; instance?: string }) => {
    const s = WaveformDebugSession.current;
    const ed = vscode.window.activeTextEditor;
    const doc = arg?.uri ? await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri)) : ed?.document;
    if (!s || !doc || !isSvDocument(doc)) { void vscode.window.showInformationMessage('Start the waveform debugger and put the cursor in a module.'); return undefined; }
    const mod = moduleAt(scanModules(doc.getText()), arg?.line ?? ed?.selection.active.line ?? 0);
    if (!mod) { return undefined; }
    const all = (await resolver.instancesOf(mod, s.data)).map((p) => p.join('.'));
    const pick = arg?.instance ?? await vscode.window.showQuickPick(all, { title: `Instance of ${mod.name} the editor follows` });
    if (!pick) { return undefined; }
    resolver.chosen.set(mod.name, pick.split('.'));
    await s.customRequestLocal('setLocalsScope', { path: pick });
    await s.customRequestLocal('refreshLineBreakpoints');
    await editor.refresh(s);
    return pick;
  });

  // Test-only reads of the editor side (inert unless the e2e suite runs).
  if (process.env.VAPORVIEW_E2E === '1') {
    cmd('e2e', async (q: { kind: string; uri?: string; first?: number; last?: number; path?: string }) => {
      const s = WaveformDebugSession.current;
      if (q.kind === 'editor') { return Object.fromEntries([...editor.drawn].map(([u, list]) => [u, list.map((d) => describeDrawn(d, editor.frameLineIn(u)))])); }
      if (q.kind === 'inline' && s && q.uri) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(q.uri));
        const vals = await editor.inlineValues(s, doc.getText(), q.first ?? 0, q.last ?? doc.lineCount);
        return vals.map((v) => ({ line: v.range.start.line, text: v.text }));
      }
      if (q.kind === 'select' && q.uri) {
        // Select a row in the viewer the way a click does (the webview echoes the selection back).
        const d = provider.getDocumentFromUri(q.uri);
        const want = (q as any).path as string;
        const id = d ? d.netlistIdTable.findIndex((it: any) => it && it.instancePath && it.instancePath() === want) : -1;
        if (!d || id < 0 || !d.webviewPanel) { return false; }
        await d.webviewPanel.webview.postMessage({ command: 'setSelectedSignal', netlistId: id });
        return true;
      }
      if (q.kind === 'inlineCalls') { return editor.provided; }
      // vscode-port the values painted after lines, and their style (no background / border: not VS Code's chips)
      if (q.kind === 'inlinePainted') {
        // (the options objects themselves, so a test can compare them with source link's: one shared constant)
        const plain = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(o, (_k, v) => (v instanceof vscode.ThemeColor ? { themeColor: (v as unknown as { id: string }).id } : v)));
        return { mode: DebuggerEditor.mode(), rows: Object.fromEntries(editor.painted), style: plain(INLINE_VALUE_STYLE as Record<string, unknown>), noValueStyle: plain(INLINE_NO_VALUE_STYLE as Record<string, unknown>) };
      }
      if (q.kind === 'readingNotes') { return { ...readingNotes }; }
      if (q.kind === 'driverPainted' && q.uri) { return driverHighlights.painted(q.uri); }
      if (q.kind === 'readsReset' && s) { s.engine.requested = new Set(); s.engine.readLog.length = 0; return true; }
      if (q.kind === 'readLog' && s) { return s.engine.readLog.slice(0, 200); }
      if (q.kind === 'bpDelay') { WaveformDebugSession.bpDelayMs = Number((q as any).ms) || 0; if (typeof (q as any).wait === 'number') { WaveformDebugSession.pendingWaitMs = (q as any).wait; } return true; } // vscode-port
      if (q.kind === 'searchDelay') { DebugEngine.searchDelayMs = Number((q as any).ms) || 0; return true; } // vscode-port
      if (q.kind === 'searchNote') { if (typeof (q as any).ms === 'number') { WaveformDebugSession.searchNoteMs = (q as any).ms; } return WaveformDebugSession.searchNote; } // vscode-port
      if (q.kind === 'stopLocation' && s) { return { ...s.stopLocation(), scope: s.scope()?.join('.') ?? null }; } // vscode-port
      if (q.kind === 'reads' && s) { return s.engine.requested ? [...s.engine.requested] : null; }
      if (q.kind === 'dataStats' && s) {
        const d = s.data as any;
        return d.stats ? { wholeReads: d.stats.wholeReads.slice(), windowedRequests: d.stats.windowedRequests(), designReads: s.engine.designReads, clock: s.engine.clock ? s.engine.clock.path.join('.') : null } : null;
      }
      if (q.kind === 'dumpHas' && s && q.path) { const m = await s.data.find(String(q.path).split('.')); return m ? await s.engine.hasDumpValues(m) : false; } // e2e
      if (q.kind === 'session') { return s ? { ...s.state(), editorScope: s.editorScope?.join('.') ?? null } : null; }
      return null;
    });
  }
}
