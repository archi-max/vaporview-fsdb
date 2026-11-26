// vscode-port: Trace Driver and Trace to Root in VS Code. Port of cmux's WaveformTrace.swift (design
// model, path mapping, opening statements) and the tracing half of cmux-trace-ui.js (history, chain), cmux branch
// tracex-wcz 44516d52d6a, GPL-3.0 with VaporView. The engine runs in the extension host (core.ts says why); the
// panel (panel.ts) shows the steps.
//
// Entry points: the waveform row's menu (webview/context), the SystemVerilog editor's menu (editor/context), the
// command palette (the selected row) and keys (Ctrl+Alt+T: Trace Driver, Ctrl+Alt+R: Trace to Root).
// The design: vaporview.trace.designArgs (slang arguments, e.g. ["-f", "files.f", "--top", "tb"]) relative to
// vaporview.trace.designRoot (default: the workspace folder holding the dump), else the "build" of the folder's
// .slang/local/server.json or .slang/server.json (the slang extension's config), as cmux reads it.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { WaveformViewerProvider } from '../../extension_core/viewer_provider';
import type { VaporviewDocument } from '../../extension_core/document';
import { DesignSession, SidecarError, SvModelSidecar, type BuildProgress, type Json } from './sidecar';
import { TraceCore, instancesDeclaring, loadEngine, resolveDumpPath, type Bound, type PathMapping, type TraceLib } from './core';
import { dumpSourceFor } from './source';
import type { TraceDumpSource } from './dump';
import { WispTraceSource } from './wisp_source';
import { waveformData } from '../data';
import { TracePanel } from './panel';
import { VerdiSession, VerdiError, compare, unitsMatch, findVerdi } from './verdi';
import type { SourceLinkApi } from '../link/index';
import { StepEmphasis } from './emphasis';
import { DriverHighlight, highlightOf } from './driver_highlight';
import { driverHighlights } from '../shared/driver_style';
import { WaveformViewerProvider as ViewerProviderClass } from '../../extension_core/viewer_provider';
import { noValueText } from '../shared/port_resolve';

interface Design { key: string; session: DesignSession; load: Promise<Bound> | null; root: string; args: string[] }

/** Paths of other features (Waveform Path Mapping…) may plug in here. */
export const tracePathMappings: PathMapping[] = [];

export class TraceController {
  /** (e2e only: vaporview.e2e.traceWholeHistory) FSDB/WCZ read as whole histories, the reference for the windowed reads */
  static wholeHistory = false;
  private lib: TraceLib;
  private sidecar: SvModelSidecar;
  private designs = new Map<string, Design>();
  private cores = new WeakMap<VaporviewDocument, TraceCore>(); // (not readonly: e2e traceReset)
  private lastSource: TraceDumpSource | null = null;
  private sourceOf = new WeakMap<TraceCore, TraceDumpSource>();
  private coreGen = new WeakMap<TraceCore, number>();
  readonly panel: TracePanel;
  private history: { steps: Json[]; at: number } = { steps: [], at: -1 };
  private chain: { c: Json; cancelled: boolean } | null = null;
  private running = 0;
  private document: VaporviewDocument | null = null;
  private building: BuildProgress | null = null;
  private verdi = new Map<string, VerdiSession>();
  private verdiAccepted = false;
  /** Test-only: the licence notice's answer (VAPORVIEW_E2E=1). */
  noticeAnswer: boolean | null = null;

  constructor(private readonly context: vscode.ExtensionContext, private readonly viewer: WaveformViewerProvider, private readonly link?: SourceLinkApi) {
    const media = path.join(context.extensionPath, 'media', 'cmux');
    this.lib = loadEngine(path.join(media, 'trace'));
    this.sidecar = new SvModelSidecar(path.join(media, 'sv-model'), (p) => this.onBuild(p));
    this.panel = new TracePanel(context, (m) => this.onPanel(m));
    this.emphasis = new StepEmphasis();
    this.highlight = new DriverHighlight();
    // Closing the panel stops the trace and its reads (FSDB/WCZ: the helper stops them too).
    this.panel.onClose = () => { this.stopChain(); this.running++; };
  }

  readonly emphasis: StepEmphasis;
  readonly highlight: DriverHighlight;
  // ---- the driver highlight : every line assigning the selected signal, the one driving it at the marker ----
  private hlRun = 0;
  private hlWho = '';
  private hlLines = new WeakMap<TraceCore, Map<string, Json[]>>();
  private hlSteps = new WeakMap<TraceCore, Map<string, Json>>();
  /** (e2e) what the highlight last computed, and why it showed nothing. */
  hlLast: Json = null;
  /** Highlights the drivers of a signal: { uri?, dumpPath } (a waveform row) or { uri?, file, word } (the editor
   *  cursor), at `time` or the marker. Shows nothing (and asks nothing) with the setting off or no design chosen. */
  /** (e2e: the highlight's step fails with this message, as a read that fails or times out on a large FSDB) */
  hlFailStep: string | null = null;
  async highlightFor(arg: Json): Promise<Json> {
    const run = ++this.hlRun;
    // (another signal: the old marks go at once, never left showing while the new one loads; a marker move keeps them)
    const who = arg ? String(arg.dumpPath || (arg.file ? arg.file + '#' + arg.word : '')) : '';
    if (who !== this.hlWho) { this.highlight.clear(); this.hlWho = who; }
    this.hlLast = { pending: 'start', arg: plain(arg) };
    const done = (h: Json, why?: string) => {
      if (run !== this.hlRun) { return null; }
      this.highlight.show(h);
      this.hlLast = h ? Object.assign(plain(h), { note: h.active ? DriverHighlight.noteText(h) : h.unknown ? DriverHighlight.unknownText(h) : null }) : { none: why || 'none' };
      return this.hlLast;
    };
    try {
      if (!arg || (!arg.dumpPath && !(arg.file && arg.word))) { return done(null, 'noSignal'); }
      const document = this.documentFor(arg.uri ? String(arg.uri) : undefined);
      if (!document) { return done(null, 'noWaveform'); }
      if (vscode.workspace.getConfiguration('vaporview', document.uri).get<boolean>('trace.driverHighlight') === false) { return done(null, 'off'); }
      if (this.traceRuns > 0) { return done(null, 'tracing'); }
      const d = await this.designArgs(document, true).catch(() => null);
      if (!d) { return done(null, 'noDesign'); }
      const { design } = this.ensureLoad(d);
      if (run === this.hlRun) { this.hlLast = { pending: 'design', arg: plain(arg) }; }
      let bound: Bound;
      try { bound = await design.load!; } catch { design.load = null; return done(null, 'designFailed'); }
      if (run !== this.hlRun) { return null; }
      let designPath: string;
      let pre: { designPrefix: string; dumpPrefix: string };
      if (arg.dumpPath) {
        const mapping: PathMapping = (p) => { for (const m of tracePathMappings) { const r = m(p); if (r) { return r; } } return null; };
        const r = await resolveDumpPath(bound, String(arg.dumpPath).split('.'), mapping);
        if (r.kind !== 'signal') { return done(null, 'notInDesign'); }
        designPath = r.designPath; pre = r;
      } else {
        const insts = await instancesDeclaring(bound, String(arg.file), String(arg.word));
        if (!insts.length) { return done(null, 'notASignal'); }
        designPath = insts[0] + '.' + String(arg.word);
        const known = this.cores.get(document);
        pre = known ? { designPrefix: known.dump.designPrefix, dumpPrefix: known.dump.dumpPrefix } : await this.prefixesFor(document, bound, designPath);
      }
      if (this.traceRuns > 0) { return done(null, 'tracing'); }
      let release: () => void = () => undefined;
      const busy = new Promise<void>((r) => { release = r; });
      this.hlBusy = busy;
      try {
      const core = await this.coreFor(document, pre, bound);
      let lines = this.hlLines.get(core); if (!lines) { lines = new Map(); this.hlLines.set(core, lines); }
      if (!lines.has(designPath)) { lines.set(designPath, await core.engine.assigningLines(designPath).catch(() => [])); }
      // (time: the event's, else the viewer's marker; null (no marker) stays null: dim bars only, no note)
      const t0 = arg.time !== undefined ? arg.time : document.webviewContext.markerTime;
      const time = t0 === null || t0 === undefined || !Number.isFinite(Number(t0)) ? null : Number(t0);
      let st: Json = null;
      if (time !== null) {
        let steps = this.hlSteps.get(core); if (!steps) { steps = new Map(); this.hlSteps.set(core, steps); }
        const key = designPath + '@' + time;
        if (this.hlFailStep !== null) { st = { error: 'failed', message: this.hlFailStep }; } else if (steps.has(key)) { st = steps.get(key); } else {
          st = run !== this.hlRun ? null : await core.step(designPath, time).catch((e) => ({ error: 'failed', message: String((e && e.message) || e) }));
          // (only a whole answer is kept: not a failed one, nor one a Trace run cut into)
          if (st && !st.error && run === this.hlRun) { if (steps.size > 200) { steps.clear(); } steps.set(key, st); }
        }
      }
      if (run !== this.hlRun) { return null; }
      const unit = String((document.metadata as Json).timeUnit || '');
      const h = highlightOf(designPath, lines.get(designPath) || [], st, time, unit);
      const out = done(h, 'noLines');
      // (e2e: why the step named no active line)
      if (out && process.env.VAPORVIEW_E2E === '1') { out.step = st ? { error: st.error, stmt: st.stmt && st.stmt.loc, wrote: st.wrote, inferred: st.inferred, driver: st.driver && { kind: st.driver.kind, loc: st.driver.loc } } : null; }
      return out;
      } finally { release(); if (this.hlBusy === busy) { this.hlBusy = null; } }
    } catch (e) {
      return done(null, 'failed: ' + String((e as Error).message || e));
    }
  }
  /** A Trace run (driver, follow, to root, from the editor) never overlaps a highlight's reads: it drops the pending
   *  highlight, waits for its reads in flight, and while it runs the highlight computes nothing. (They share the
   *  document's trace core and its helper reads, so a Trace cancel or reload would otherwise land on the highlight's
   *  reads, and the highlight's reads would count as the Trace's.) */
  private traceRuns = 0;
  private hlBusy: Promise<unknown> | null = null;
  private async tracing<T>(f: () => Promise<T>): Promise<T> {
    this.traceRuns++;
    this.hlRun++;
    if (this.hlLast && this.hlLast.pending) { this.hlLast = { none: 'tracing' }; }
    try {
      if (this.hlBusy) { await this.hlBusy.catch(() => undefined); }
      return await f();
    } finally { this.traceRuns--; }
  }
  /** (stop frame) Where a stop on `path` at `time` opens, quietly: { uri, path (dump path), time } ->
   *  { kind: 'driver', file, line (1-based), col } for the statement Trace Driver would show, else { kind:
   *  'declaration', ... } for the signal's declaration, else null (no design chosen, not in the design, failed). No
   *  panel, no history, no prompt, the Trace document unchanged. During a Trace run it reads nothing from the dump
   *  (the declaration only), as the driver highlight. */
  async stopLocation(arg: Json): Promise<Json> {
    try {
      if (!arg || !arg.path) { return null; }
      const document = this.documentFor(arg.uri ? String(arg.uri) : undefined);
      if (!document) { return null; }
      const d = await this.designArgs(document, true).catch(() => null);
      if (!d) { return null; }
      const { design } = this.ensureLoad(d);
      let bound: Bound;
      try { bound = await design.load!; } catch { design.load = null; return null; }
      const mapping: PathMapping = (p) => { for (const m of tracePathMappings) { const r = m(p); if (r) { return r; } } return null; };
      const r = await resolveDumpPath(bound, String(arg.path).split('.'), mapping);
      if (r.kind !== 'signal') { return null; }
      const core = await this.coreFor(document, r, bound);
      const at = (kind: string, l: Json) => l && l.file && Number(l.line) > 0 ? { kind, file: String(l.file), line: Number(l.line), col: Number(l.col) || 1 } : null;
      const t = arg.time !== undefined && arg.time !== null && Number.isFinite(Number(arg.time)) ? Number(arg.time) : null;
      if (t !== null && this.traceRuns === 0) {
        let steps = this.hlSteps.get(core); if (!steps) { steps = new Map(); this.hlSteps.set(core, steps); }
        const key = r.designPath + '@' + t;
        let st: Json = steps.get(key);
        if (!st) {
          st = await core.step(r.designPath, t).catch(() => null);
          if (st && !st.error && this.traceRuns === 0) { if (steps.size > 200) { steps.clear(); } steps.set(key, st); }
        }
        const drv = st && !st.error && st.stmt ? at('driver', st.stmt.loc) : null;
        if (drv) { return drv; }
        if (st && st.declLoc) { return at('declaration', st.declLoc); }
      }
      return at('declaration', await core.engine.declOf(r.designPath).catch(() => null));
    } catch { return null; }
  }
  clearHighlight() { this.hlRun++; this.hlWho = ''; this.highlight.clear(); this.hlLast = { none: 'cleared' }; }
  /** (e2e) Every step and chain step is checked against the dump; the suite runner fails a test that made any. */
  static checkInvariants = process.env.VAPORVIEW_E2E === '1';
  invariantViolations: string[] = [];
  dispose() { if (this.prepStatus) { this.prepStatus.dispose(); } if (this.confirmTimer) { clearTimeout(this.confirmTimer); } this.emphasis.dispose(); this.highlight.dispose(); this.sidecar.stop(); this.panel.dispose(); for (const v of this.verdi.values()) { v.stop(); } this.verdi.clear(); }

  // ---- the design ----
  /** The design Trace loads: vaporview.trace.designArgs when set (an explicit override); else the design slang has
   *  for the waveform's design root (the link's profile / build file / top level / elaboration, as cmux chooses the
   *  design once); else (no link) the folder's .slang server.json build. */
  private lastDesign: { args: string[]; root: string; source: string; rebuilt?: boolean } | null = null;
  /** `quiet`: a caller that must not wait (the driver highlight, stopLocation, the viewer's value API): the link gets
   *  only QUIET_WAIT_MS to finish a profile auto-pick or switch, else this answers from what it has. */
  private async designArgs(document: VaporviewDocument, quiet = false): Promise<{ args: string[]; root: string; source: string; rebuilt?: boolean } | null> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const set = scopedDesignSettings(vscode.workspace.getConfiguration('vaporview', document.uri), document.uri, folder);
    if (set.ambiguous) { throw new SidecarError('designAmbiguous', set.ambiguous); }
    const root = set.root;
    if (set.args) { return { args: set.args, root, source: `vaporview.trace.designArgs (${set.scope})` }; }
    if (this.link) { return (await this.link.designForTrace(document.uri.toString(), quiet ? { waitMs: QUIET_WAIT_MS } : undefined).catch(() => undefined)) ?? null; }
    for (const rel of ['.slang/local/server.json', '.slang/server.json']) {
      const file = path.join(root, rel);
      try {
        const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
        const o = JSON.parse(text);
        if (typeof o.build === 'string' && o.build.trim()) {
          const b = o.build.trim();
          return { args: [o.buildRelativePaths ? '-F' : '-f', path.isAbsolute(b) ? b : path.join(root, b)], root, source: rel + ' build' };
        }
      } catch { /* none */ }
    }
    return null;
  }

  /** Nothing chosen: the panel says so, and a notification offers the chooser and the dump's top module. Set top level
   *  goes on with that design; the chooser ends this trace (run it again after picking). */
  noDesignOffer: string[] | null = null; // (e2e: the buttons offered last)
  private async chooseDesign(document: VaporviewDocument): Promise<{ args: string[]; root: string; source: string; rebuilt?: boolean }> {
    const text = 'Choose the design first: pick a slang profile (a .f build file) or set the top level in the SystemVerilog editor; or set vaporview.trace.designArgs (slang arguments, e.g. ["-f", "files.f", "--top", "tb"]).';
    const cand = this.link ? await this.link.topLevelCandidate(document.uri.toString()) : undefined;
    const pick = 'Pick a slang profile…';
    const setTop = cand ? `Set top level to ${cand.module}` : undefined;
    const items = [pick, ...(setTop ? [setTop] : [])];
    this.noDesignOffer = items;
    if (this.link) {
      this.panel.show({ kind: 'error', text });
      const a = process.env.VAPORVIEW_E2E === '1' ? undefined : await vscode.window.showWarningMessage(text, ...items);
      if (a === pick) { void vscode.commands.executeCommand('vaporview.sourceLink.chooseProfile'); }
      if (a && a === setTop && cand) {
        await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', vscode.Uri.file(cand.file));
        const d = await this.designArgs(document);
        if (d) { return d; }
      }
    }
    throw new SidecarError('noDesign', text);
  }

  /** (DIAGNOSTIC) Where the last Trace's time went, in ms: design choice, sidecar build, design load, path lookup, engine. */
  timings: Record<string, number> = {};
  private t0 = 0;
  private mark(k: string) { const n = Date.now(); this.timings[k] = (this.timings[k] || 0) + (n - this.t0); this.t0 = n; }
  private async bound(document: VaporviewDocument): Promise<Bound> {
    let d = await this.designArgs(document);
    this.mark('designChoice');
    if (!d) { d = await this.chooseDesign(document); }
    this.lastDesign = d;
    this.panel.designNote = d.rebuilt ? 'Design rebuilt from slang\'s open modules (no +define, +incdir or library options); pick a slang profile for its exact arguments.' : null;
    const { design, loadedBefore } = this.ensureLoad(d);
    // (a load the background prep started: the panel says so while Trace waits for it)
    const fromPrep = loadedBefore && this.prep && this.prep.key === design.key && this.prep.state === 'loading';
    if (fromPrep) { this.panel.show({ kind: 'busy', text: 'Loading the design (started when the waveform opened)…' }); }
    this.waiting++;
    try {
      let b = await design.load!;
      this.mark(fromPrep ? 'designPrepWait' : loadedBefore ? 'designReuse' : 'designLoad');
      // A source edited since: loaded again (the same text keeps the design and its answers).
      if (loadedBefore && await design.session.refresh()) {
        design.load = Promise.resolve({ design: design.session, generation: design.session.generation });
        b = await design.load;
      }
      return b;
    } catch (e) {
      design.load = null;
      throw e;
    } finally {
      this.waiting--;
    }
  }

  /** The design entry for `d`, its load started (one design at a time in the sidecar: a new one replaces the last). */
  private ensureLoad(d: { args: string[]; root: string }) {
    const key = d.root + '|' + d.args.join('\u001f');
    let design = this.designs.get(key);
    if (!design) {
      this.designs.clear();
      design = { key, session: new DesignSession(this.sidecar, d.args, d.root), load: null, root: d.root, args: d.args };
      this.designs.set(key, design);
    }
    const loadedBefore = !!design.load;
    if (!design.load) {
      const s = design.session;
      design.load = s.load().then((l) => {
        if (!l.tops.length) { throw new SidecarError('loadFailed', 'slang could not load the design: ' + (l.messages.slice(0, 3).join('; ') || 'no top level')); }
        return { design: s, generation: l.generation };
      });
    }
    return { design, loadedBefore };
  }

  // ---- background prep (vaporview.trace.prepare onOpen): the design loads when a waveform opens ----
  /** Traces waiting for a design load (build progress goes to the panel only then). */
  private waiting = 0;
  /** (e2e: traceState.prep) the last background prep: what it did and why. */
  prep: { uri: string; key?: string; state: 'loading' | 'ready' | 'failed' | 'skipped'; reason?: string; ms?: number } | null = null;
  private prepStatus: vscode.StatusBarItem | null = null;
  private showPrep(text: string | null) {
    if (text === null) { if (this.prepStatus) { this.prepStatus.hide(); } return; }
    if (!this.prepStatus) {
      this.prepStatus = vscode.window.createStatusBarItem('vaporview.tracePrepare', vscode.StatusBarAlignment.Left, 10);
      this.prepStatus.name = 'Trace preparation';
      this.prepStatus.tooltip = 'Loading the design for Driver tracing in the background (vaporview.trace.prepare: onOpen), so the first Trace does not wait for it.';
    }
    this.prepStatus.text = text;
    this.prepStatus.show();
  }
  /** A waveform opened: with prepare onOpen and its design already chosen, load that design now. Never asks
   *  anything (no design chosen: the first Trace asks), and never replaces another design already loaded. */
  async prepareOnOpen(document: VaporviewDocument): Promise<void> {
    const uri = document.uri.toString();
    const mode = vscode.workspace.getConfiguration('vaporview', document.uri).get<string>('trace.prepare') || 'onOpen';
    if (mode !== 'onOpen') { this.prep = { uri, state: 'skipped', reason: 'onFirstTrace' }; return; }
    const d = await this.designArgs(document).catch(() => null);
    if (!d) { this.prep = { uri, state: 'skipped', reason: 'noDesign' }; return; }
    const key = d.root + '|' + d.args.join('\u001f');
    const other = [...this.designs.keys()].find((k) => k !== key);
    if (other) { this.prep = { uri, key, state: 'skipped', reason: 'otherDesignLoaded' }; return; }
    const { design, loadedBefore } = this.ensureLoad(d);
    if (loadedBefore && !(this.prep && this.prep.key === key && this.prep.state === 'loading')) { this.prep = { uri, key, state: 'ready', reason: 'alreadyLoaded', ms: 0 }; return; }
    const me = { uri, key, state: 'loading' as const };
    this.prep = me;
    const t0 = Date.now();
    this.showPrep('$(sync~spin) Preparing Trace…');
    try {
      await design.load;
      if (this.prep === me) { this.prep = { uri, key, state: 'ready', ms: Date.now() - t0 }; }
    } catch (e) {
      design.load = null;
      if (this.prep === me) { this.prep = { uri, key, state: 'failed', reason: String((e as Error).message || e), ms: Date.now() - t0 }; }
    } finally {
      if (!this.prep || this.prep.state !== 'loading') { this.showPrep(null); }
    }
  }

  private buildT0 = 0;
  private onBuild(p: BuildProgress) {
    if (p.stage !== 'load' && !this.buildT0) { this.buildT0 = Date.now(); }
    if (p.stage === 'load' && this.buildT0) { this.timings.sidecarBuild = Date.now() - this.buildT0; this.buildT0 = 0; }
    this.building = p.stage === 'load' ? null : p;
    if (this.prep && this.prep.state === 'loading') { this.showPrep(p.stage === 'load' ? '$(sync~spin) Preparing Trace: loading the design…' : `$(sync~spin) Preparing Trace: building the design model${p.percent !== undefined ? ` ${Math.round(Number(p.percent))}%` : ''}…`); }
    // (the background prep alone: no panel; a Trace waiting for the load sees the progress)
    if (!this.waiting) { return; }
    if (p.stage === 'load') { this.panel.show({ kind: 'busy', text: 'Loading the design…' }); return; }
    this.panel.show({ kind: 'build', stage: p.stage, percent: p.percent });
  }

  // ---- the session for a document ----
  private async coreFor(document: VaporviewDocument, resolved: { designPrefix: string; dumpPrefix: string }, bound: Bound): Promise<TraceCore> {
    const known = this.cores.get(document);
    // (a reloaded dump: a new data generation, so the dump session's caches start over)
    const dataGen = waveformData(document).generation;
    if (known && this.coreGen.get(known) === dataGen && known.bound.generation === bound.generation && known.bound.design === bound.design
        && known.dump.designPrefix === resolved.designPrefix && known.dump.dumpPrefix === resolved.dumpPrefix) { this.lastSource = this.sourceOf.get(known) || null; return known; }
    let source = dumpSourceFor(document);
    if (TraceController.wholeHistory && source instanceof WispTraceSource) { source = source.wholeHistory(); } // (e2e reference)
    if (source instanceof WispTraceSource) { source.bindGeneration(() => waveformData(document).generation); }
    this.lastSource = source;
    const xprop = vscode.workspace.getConfiguration('vaporview', document.uri).get<string>('trace.xprop') || 'auto';
    const core = new TraceCore(this.lib, bound, source, resolved.designPrefix, resolved.dumpPrefix, { xprop });
    this.cores.set(document, core);
    this.coreGen.set(core, dataGen);
    this.sourceOf.set(core, source);
    return core;
  }

  private documentFor(uri?: string): VaporviewDocument | undefined {
    return uri ? this.viewer.getDocumentFromUri(uri) : (this.viewer.getLastActiveDocument || this.viewer.getActiveDocument);
  }

  /** The dump path and time a command asks about (a row's menu, an argument, or the selected row and marker). */
  private target(document: VaporviewDocument, arg: Json): { dumpPath: string[]; time: number } {
    let p: string | null = null;
    if (arg && typeof arg.path === 'string') { p = arg.path; }
    else if (arg && Array.isArray(arg.path)) { p = arg.path.join('.'); }
    else if (arg && arg.netlistId !== undefined) { const item = document.netlistIdTable[arg.netlistId]; p = item ? item.instancePath() : null; }
    else if (document.webviewContext.selectedSignal !== null && document.webviewContext.selectedSignal !== undefined) {
      const item = document.netlistIdTable[document.webviewContext.selectedSignal];
      p = item ? item.instancePath() : null;
    }
    if (!p) { throw new SidecarError('noSignal', 'Select a signal in the waveform first.'); }
    const t = arg && arg.time !== undefined && arg.time !== null ? Number(arg.time) : document.webviewContext.markerTime;
    if (t === null || t === undefined || !Number.isFinite(Number(t))) { throw new SidecarError('noMarker', 'Place the marker first: tracing explains the value at the marker.'); }
    return { dumpPath: p.split('.'), time: Number(t) };
  }

  private async prepare(arg: Json): Promise<{ document: VaporviewDocument; core: TraceCore; designPath: string; time: number }> {
    const document = this.documentFor(arg && arg.uri ? String(arg.uri) : undefined);
    if (!document) { throw new SidecarError('noWaveform', 'Open a waveform first.'); }
    this.timings = {}; this.t0 = Date.now();
    this.document = document;
    const bound = await this.bound(document);
    if (arg && typeof arg.designPath === 'string') {
      const time = arg.time !== undefined && arg.time !== null ? Number(arg.time) : document.webviewContext.markerTime;
      if (time === null || time === undefined) { throw new SidecarError('noMarker', 'Place the marker first: tracing explains the value at the marker.'); }
      const known = this.cores.get(document);
      const pre = arg.designPrefix !== undefined ? { designPrefix: String(arg.designPrefix || ''), dumpPrefix: String(arg.dumpPrefix || '') }
        : known ? { designPrefix: known.dump.designPrefix, dumpPrefix: known.dump.dumpPrefix } : await this.prefixesFor(document, bound, arg.designPath);
      const core = await this.coreFor(document, pre, bound);
      this.mark('core');
      return { document, core, designPath: arg.designPath, time: Number(time) };
    }
    const { dumpPath, time } = this.target(document, arg);
    this.panel.show({ kind: 'busy', text: `Finding ${dumpPath.join('.')} in the design…` });
    const mapping: PathMapping = (p) => { for (const m of tracePathMappings) { const r = m(p); if (r) { return r; } } return null; };
    const r = await resolveDumpPath(bound, dumpPath, mapping);
    this.mark('pathLookup');
    if (r.kind === 'notElaborated') { throw new SidecarError('notElaborated', `The design model has no ${r.instance}: slang did not elaborate that module (${bound.design.loadMessages[0] || 'check the design arguments'}).`); }
    if (r.kind !== 'signal') { throw new SidecarError('notInDesign', `${dumpPath.join('.')} is not a signal of the design slang loaded (check vaporview.trace.designArgs and the path mapping).`); }
    const core = await this.coreFor(document, r, bound);
    this.mark('core');
    return { document, core, designPath: r.designPath, time };
  }

  // A design path from the editor: where the dump has it (as it is, or under a wrapper scope: TOP.tb...).
  private async prefixesFor(document: VaporviewDocument, _bound: Bound, designPath: string) {
    if (await document.findTreeItem(designPath, undefined, undefined)) { return { designPrefix: '', dumpPrefix: '' }; }
    for (const t of document.treeData) {
      if (await document.findTreeItem(t.label + '.' + designPath, undefined, undefined)) { return { designPrefix: '', dumpPrefix: String(t.label) }; }
    }
    return { designPrefix: '', dumpPrefix: '' };
  }

  // ---- shared: a signal the dump lacks, through its connection (inline values use it; src/cmux/shared/port_resolve.ts) ----
  /** { uri, designPath, time } -> { value, via, dumped: false } (resolved) | { noValue: true, reason, why?, path, text }
   *  (not in the dump / not computable, with why). Only for signals the dump lacks. */
  async resolvePort(arg: Json): Promise<Json> {
    const keep = this.document;
    const path0 = String(arg && arg.designPath || '');
    try {
      // vscode-port: `quiet` (the viewer's value API): with no design chosen, answer "not in the dump"
      // instead of asking the user to choose one.
      const doc = arg && arg.quiet ? this.documentFor(arg.uri ? String(arg.uri) : undefined) : undefined;
      if (doc && !(await this.designArgs(doc, true).catch(() => null))) {
        const r = { noValue: true, reason: 'notDumped', path: path0, noDesign: true };
        return Object.assign(r, { text: noValueText(r) });
      }
      const { core, designPath, time } = await this.prepare(arg);
      const r: Json = TraceCore.resolveMissing ? await core.resolvePortValue(designPath, time) : { noValue: true, reason: 'notDumped', path: designPath };
      return r.noValue ? Object.assign({}, r, { text: noValueText(r) }) : r;
    } catch (e) {
      const r = { noValue: true, reason: 'notComputable', why: 'failed', path: path0, message: String((e as Error).message || e) };
      return Object.assign(r, { text: noValueText(r) });
    } finally { this.document = keep; }
  }

  // ---- Trace Driver ----
  driver(arg: Json): Promise<Json> { return this.tracing(() => this.driver0(arg)); }
  private async driver0(arg: Json): Promise<Json> {
    this.stopChain();
    const run = ++this.running;
    try {
      const { core, designPath, time } = await this.prepare(arg);
      // (the dump reloaded under the step, as right after an open: traced once more on the reloaded file)
      return await this.traceStep(core, designPath, time, true, run, async () => (await this.prepare(arg)).core);
    } catch (e) {
      return this.fail(e, run);
    }
  }

  private async traceStep(core: TraceCore, designPath: string, time: number, push: boolean, run = ++this.running, again?: () => Promise<TraceCore>): Promise<Json> {
    this.panel.show({ kind: 'busy', text: `Tracing ${designPath} at ${time.toLocaleString()}…` });
    const marks = this.readMarks(core);
    const q0 = (core.dump.source as Json).stats ? Number((core.dump.source as Json).stats.queries) || 0 : 0;
    let step = await core.step(designPath, time);
    this.mark('engineStep');
    this.timings.queries = ((core.dump.source as Json).stats ? Number((core.dump.source as Json).stats.queries) || 0 : 0) - q0;
    if (run !== this.running) { return null; }
    const m = marks();
    if (m.reloaded && again) { this.retriedReloaded++; return this.traceStep(await again(), designPath, time, push, run); }
    // (read while the file was reloaded: the step is not shown; trace again on the reloaded file)
    if (m.reloaded) { step = { signal: designPath, time, error: 'reloaded' }; }
    else if (m.unconfirmed) { step = Object.assign({}, step, { unconfirmed: this.unconfirmedState(core) }); }
    if (m.unconfirmed) { this.confirmLater(core); }
    if (TraceController.checkInvariants) { for (const v of await core.invariants(step)) { this.invariantViolations.push(v); } }
    if (push) { this.history.steps = this.history.steps.slice(0, this.history.at + 1); this.history.steps.push(step); this.history.at = this.history.steps.length - 1; }
    this.render();
    return plain(step);
  }

  /** One more step: a fan-in of the step shown, at its sample time. */
  follow(index: number): Promise<Json> { return this.tracing(() => this.follow0(index)); }
  private async follow0(index: number): Promise<Json> {
    const st = this.history.steps[this.history.at];
    const f = st && st.fanin && st.fanin[index];
    const core = this.document && this.cores.get(this.document);
    if (!f || !core) { return null; }
    if (f.local) { if (f.via && f.via.loc) { await this.open(f.via.loc); } return null; }
    if (!f.path) { return null; }
    try { return await this.traceStep(core, f.path, Number(f.time), true); } catch (e) { return this.fail(e, this.running); }
  }

  back() { this.stopChain(); if (this.history.at > 0) { this.history.at--; this.render(); } return this.state(); }
  forward() { this.stopChain(); if (this.history.at < this.history.steps.length - 1) { this.history.at++; this.render(); } return this.state(); }

  // ---- Trace to Root ----
  xRoot(arg: Json): Promise<Json> { return this.tracing(() => this.xRoot0(arg)); }
  private async xRoot0(arg: Json): Promise<Json> {
    this.stopChain();
    const run = ++this.running;
    let prepared;
    try { prepared = await this.prepare(arg); } catch (e) { return this.fail(e, run); }
    const { core, designPath, time } = prepared;
    const c: Json = { designPath, time, steps: [], end: null, root: -1, approximate: false, running: true, mode: null };
    const me = { c, cancelled: false };
    this.chain = me;
    this.render();
    // The start signal's row in the waveform and the marker at the start time (a chain from the palette or the
    // editor otherwise leaves the waveform as it was, maybe empty).
    try { await this.showInWaveform(core.toDump(designPath), time); } catch { /* the chain still runs */ }
    const maxSteps = vscode.workspace.getConfiguration('vaporview').get<number>('trace.xChainSteps') || undefined;
    const marks = this.readMarks(core);
    try {
      const out = await core.chain(designPath, time, (e, all) => { c.steps = all.slice(); if (this.chain === me) { this.render(); } }, () => me.cancelled || this.chain !== me, maxSteps);
      Object.assign(c, { steps: out.steps, end: out.end, root: out.root, approximate: out.approximate, mode: out.mode, running: false });
      if (TraceController.checkInvariants) { for (const e of out.steps || []) { for (const v of await core.invariants(e.step)) { this.invariantViolations.push('chain ' + v); } } }
    } catch (e) {
      Object.assign(c, { end: { code: 'failed', error: String((e as Error).message || e) }, running: false });
    }
    const m = marks();
    // A reload during the chain: its later reads were dropped, so the chain stops there (no root).
    if (m.reloaded) { Object.assign(c, { end: { code: 'reloaded' }, root: -1 }); }
    else if (m.unconfirmed) { c.unconfirmed = this.unconfirmedState(core); this.confirmLater(core); }
    if (this.chain === me) { this.render(); }
    return plain({ steps: c.steps, end: c.end, root: c.root, approximate: c.approximate, mode: c.mode, unconfirmed: c.unconfirmed || false });
  }
  private stopChain() { if (this.chain) { this.chain.cancelled = true; this.chain = null; } this.abortReads(); }
  cancel() { if (this.chain) { this.chain.cancelled = true; } this.abortReads(); }
  /** (e2e) Forget the trace sessions, so the next trace reads the dump again. */
  resetCores() { this.cores = new WeakMap(); }
  /** (e2e) Forget the loaded design and the last prep: the next Trace or prep loads it again. */
  dropDesigns() { this.designs.clear(); this.prep = null; }
  /** Stops the dump reads in flight (FSDB/WCZ: wisp-helper cancels them). */
  private abortReads() { if (this.lastSource && this.lastSource.cancel) { this.lastSource.cancel(); } }
  /** What the dump said while `run` read: answers not yet confirmed by the file's check; a reload meanwhile. */
  // ---- answers read before the file's whole-file check (wisp-helper 15.12 starts it after 30 s without reads) ----
  /** (e2e: vaporview.e2e.traceConfirmDelay) How long Trace waits without reads before asking the helper to check. */
  static confirmDelayMs = 35000;
  private confirmTimer: NodeJS.Timeout | null = null;
  /** 'pending' (the check has not run yet) or 'off' (vaporview.wisp.verifyStart is off: it will not run). */
  private unconfirmedState(core: TraceCore): string {
    const doc = this.document;
    const v = String(vscode.workspace.getConfiguration('vaporview', doc ? doc.uri : undefined).get('wisp.verifyStart') ?? 'idle:30');
    void core;
    return v === 'off' ? 'off' : 'pending';
  }
  /** After Trace goes quiet, ask the helper to run its check; when it passes, the steps shown lose the badge. */
  private confirmLater(core: TraceCore) {
    const src = this.sourceOf.get(core) as Json;
    if (!src || typeof src.verifyFile !== 'function' || this.unconfirmedState(core) === 'off') { return; }
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); }
    const at = this.running;
    this.lastConfirm = null;
    this.confirmTimer = setTimeout(async () => {
      this.confirmTimer = null;
      if (this.running !== at || (this.chain && this.chain.c.running)) { this.confirmLater(core); return; }
      const ok = await src.verifyFile();
      this.lastConfirm = { ok, at: Date.now() };
      if (ok !== true) { return; }
      for (const st of this.history.steps) { if (st && st.unconfirmed) { delete st.unconfirmed; } }
      if (this.chain && this.chain.c.unconfirmed) { delete this.chain.c.unconfirmed; for (const e of this.chain.c.steps || []) { if (e && e.step) { delete e.step.unconfirmed; } } }
      this.render();
    }, TraceController.confirmDelayMs);
  }
  lastConfirm: { ok: boolean | null; at: number } | null = null;
  /** Steps traced once more because the dump reloaded under them (e2e). */
  retriedReloaded = 0;

  private readMarks(core: TraceCore) {
    const src = this.sourceOf.get(core);
    const u0 = (src && src.unverified) || 0, r0 = (src && src.reloads) || 0;
    return () => ({ unconfirmed: ((src && src.unverified) || 0) > u0, reloaded: ((src && src.reloads) || 0) > r0 });
  }

  // ---- from the editor ----
  fromEditor(arg: Json, xroot: boolean): Promise<Json> { return this.tracing(() => this.fromEditor0(arg, xroot)); }
  private async fromEditor0(arg: Json, xroot: boolean): Promise<Json> {
    const editor = vscode.window.activeTextEditor;
    const run = ++this.running;
    try {
      const file = arg && arg.file ? String(arg.file) : editor ? editor.document.uri.fsPath : '';
      let word = arg && arg.name ? String(arg.name) : '';
      if (!word && editor) {
        const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][A-Za-z0-9_$]*/);
        word = range ? editor.document.getText(range) : '';
      }
      if (!file || !word) { throw new SidecarError('noSignal', 'Put the cursor on a signal name in the SystemVerilog editor.'); }
      const document = this.documentFor(arg && arg.uri ? String(arg.uri) : undefined);
      if (!document) { throw new SidecarError('noWaveform', 'Open the waveform of this design first.'); }
      const bound = await this.bound(document);
      const insts = await instancesDeclaring(bound, file, word);
      if (!insts.length) { throw new SidecarError('notInDesign', `${word} is not a signal of a module in ${path.basename(file)} in the design slang loaded.`); }
      let inst = insts[0];
      if (insts.length > 1) {
        const pick = arg && arg.instance ? String(arg.instance) : await vscode.window.showQuickPick(insts, { placeHolder: `Which instance of ${word}?` });
        if (!pick) { return null; }
        inst = pick;
      }
      const q = Object.assign({}, arg || {}, { designPath: inst + '.' + word, uri: document.uri.toString() });
      return xroot ? this.xRoot(q) : this.driver(q);
    } catch (e) {
      return this.fail(e, run);
    }
  }


  // ---- the Verdi cross-check (on request only, after the licence notice) ----
  private async licenceNotice(): Promise<boolean> {
    if (this.verdiAccepted) { return true; }
    const start = 'Start Verdi';
    const ok = this.noticeAnswer !== null ? this.noticeAnswer
      : (await vscode.window.showWarningMessage('Verdi cross-check', { modal: true, detail:
        'This runs Verdi from your own installation (the vaporview.trace.verdiHome setting, else PATH or VERDI_HOME) with the '
        + 'KDB next to the FSDB (simv.daidir from vcs -kdb). Verdi takes a licence seat from your site\'s licence server while '
        + 'the session runs: until this window closes or 30 minutes pass without a cross-check. Use it only as your licence '
        + 'allows. Nothing of Verdi ships with this extension.' }, start)) === start;
    this.verdiAccepted = ok;
    return ok;
  }

  /** Checks the shown step's statement against Verdi's active driver at the same time. */
  async verdiCheck(arg: Json): Promise<Json> {
    const st = this.history.steps[this.history.at];
    const document = this.document;
    const core = document && this.cores.get(document);
    if (!st || !document || !core || st.error) { return { error: 'noStep', message: 'Trace a driver first; the cross-check checks the step shown.' }; }
    const fsdb = String(arg && arg.fsdb || (/\.fsdb$/i.test(document.uri.fsPath) ? document.uri.fsPath : ''));
    if (!fsdb) { return this.verdiShow(st, { verdict: 'unavailable', code: 'noFsdb', message: 'The Verdi cross-check needs an FSDB file with its KDB.' }); }
    if (!await this.licenceNotice()) { return { error: 'declined', message: 'The licence notice was declined; Verdi was not started.' }; }
    const cfg = vscode.workspace.getConfiguration('vaporview', document.uri);
    let session = this.verdi.get(fsdb);
    if (!session || !session.alive) {
      if (session) { session.stop(); }
      session = new VerdiSession({ scripts: path.join(this.context.extensionPath, 'media', 'cmux', 'verdi-trace'), fsdb,
        daidir: arg && arg.daidir ? String(arg.daidir) : undefined, verdiHome: cfg.get<string>('trace.verdiHome') || undefined });
      this.verdi.set(fsdb, session);
    }
    this.panel.show(Object.assign({}, this.panel.lastState || {}, { verdiBusy: true }));
    try {
      if (!session.info) {
        await session.ready;
        session.info = await session.request({ cmd: 'info' });
        if (!unitsMatch(session.info)) {
          throw new VerdiError('units', `Verdi's window unit (${session.info.windowUnit}) is not the file's (${session.info.fileUnit})`);
        }
      }
      const answer = await session.request({ cmd: 'active', signal: core.toDump(String(st.signal)), time: Math.round(Number(st.time)) });
      return this.verdiShow(st, compare(st, answer));
    } catch (e) {
      const code = e instanceof VerdiError ? e.code : 'failed';
      if (code !== 'timeout') { session.stop(); this.verdi.delete(fsdb); }
      return this.verdiShow(st, { verdict: 'unavailable', code, message: String((e as Error).message || e) });
    }
  }
  private verdiShow(st: Json, result: Json) {
    st.verdi = result;
    if (this.history.steps[this.history.at] === st && !this.chain) { this.render(); }
    return plain(result);
  }

  // ---- the panel ----
  private fail(e: unknown, run: number) {
    if (run === this.running) { this.panel.show({ kind: 'error', text: String((e as Error).message || e) }); }
    return { error: String((e as SidecarError).code || 'failed'), message: String((e as Error).message || e) };
  }

  private render() {
    if (this.chain) { this.panel.show({ kind: 'chain', chain: plain(this.chain.c) }); return; }
    const st = this.history.steps[this.history.at];
    if (!st) { return; }
    this.panel.show({ kind: 'step', step: plain(st), canBack: this.history.at > 0, canForward: this.history.at < this.history.steps.length - 1,
      verdiAvailable: verdiAvailable() });
    this.emphasis.show(st);
  }

  state() {
    return plain({ at: this.history.at, steps: this.history.steps.length, step: this.history.steps[this.history.at] || null,
      chain: this.chain ? this.chain.c : null, panel: this.panel.lastState, panelColumn: this.panel.viewColumn, panelVisible: this.panel.visible,
      // (the dump source of the last traced document, and the helper queries it sent: FSDB/WCZ)
      source: this.lastSource ? { kind: this.lastSource.kind, stats: (this.lastSource as Json).stats || null } : null,
      design: this.lastDesign, noDesignOffer: this.noDesignOffer, emphasis: this.emphasis.last, timings: this.timings, building: this.building, lastConfirm: this.lastConfirm, retriedReloaded: this.retriedReloaded, prep: this.prep, sidecarPid: this.sidecar.pid ?? null });
  }

  async open(loc: Json) {
    if (!loc || !loc.file) { return; }
    const uri = vscode.Uri.file(String(loc.file));
    const line = Math.max(0, Number(loc.line) - 1), col = Math.max(0, Number(loc.col || 1) - 1);
    const endLine = loc.endLine ? Math.max(0, Number(loc.endLine) - 1) : line, endCol = loc.endCol ? Math.max(0, Number(loc.endCol) - 1) : col;
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: this.sourceColumn(uri), preserveFocus: true, preview: false,
      selection: new vscode.Range(line, col, endLine, endCol) });
    editor.revealRange(new vscode.Range(line, col, endLine, endCol), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Where a source opens: never the trace panel's group (it would hide the panel) nor the waveform's (a step then shows
   * its signal there and would hide the source). The column already showing the file, else another group, else a new
   * one after the last.
   */
  private sourceColumn(uri: vscode.Uri): vscode.ViewColumn {
    const groups = vscode.window.tabGroups.all;
    const doc = this.document;
    const wave = doc && groups.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === doc.uri.toString()));
    const taken = new Set<vscode.ViewColumn | undefined>([this.panel.viewColumn, wave ? wave.viewColumn : undefined]);
    const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === uri.fsPath && !taken.has(e.viewColumn));
    if (shown && shown.viewColumn !== undefined) { return shown.viewColumn; }
    const other = groups.find((g) => !taken.has(g.viewColumn));
    if (other) { return other.viewColumn; }
    return (Math.max(0, ...groups.map((g) => g.viewColumn)) + 1) as vscode.ViewColumn;
  }

  private async addSignals(dumpPaths: string[]) {
    const document = this.document;
    if (!document) { return; }
    const uri = document.uri.toString();
    const shown = new Set((document.getDisplayedNetlistIds() || []).map(String));
    for (const p of [...new Set(dumpPaths)]) {
      const item = await document.findTreeItem(p, undefined, undefined);
      if (!item) { continue; }
      // (a row already shown is not added twice)
      if (item.netlistId !== undefined && shown.has(String(item.netlistId))) { continue; }
      await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p });
    }
  }
  private async showInWaveform(dumpPath: string, time: number) {
    const document = this.document;
    if (!document) { return; }
    await this.addSignals([dumpPath]);
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri: document.uri.toString(), time });
  }

  private async onPanel(m: Json) {
    const core = this.document && this.cores.get(this.document);
    switch (m.type) {
      case 'open': await this.open(m.loc); break;
      case 'follow': await this.follow(Number(m.index)); break;
      case 'back': this.back(); break;
      case 'forward': this.forward(); break;
      case 'cancel': this.cancel(); break;
      case 'addFanin': {
        const st = this.history.steps[this.history.at];
        if (st && core) { await this.addSignals((st.fanin || []).filter((f: Json) => f.path && !f.local && f.dumped !== false).map((f: Json) => core.toDump(f.path))); }
        break;
      }
      case 'chainStep': {
        const c = this.chain ? this.chain.c : null;
        const e = c && c.steps[Number(m.index)];
        if (e) { await this.open(e.step && e.step.stmt && e.step.stmt.loc); await this.showInWaveform(e.dumpPath, Number(e.time)); }
        break;
      }
      case 'chainAdd': {
        const c = this.chain ? this.chain.c : null;
        if (c) { await this.addSignals(c.steps.map((e: Json) => e.dumpPath)); }
        break;
      }
      case 'chainCause': {
        const c = this.chain ? this.chain.c : null;
        const e = c && c.steps[Number(m.step)];
        const cause = e && e.causes && e.causes[Number(m.index)];
        if (cause && core) { this.stopChain(); await this.traceStep(core, cause.path, Number(cause.time), true); }
        break;
      }
      case 'verdi': await this.verdiCheck({}); break;
      case 'traceDriverOf': {
        if (core && m.path) { this.stopChain(); await this.traceStep(core, String(m.path), Number(m.time), true); }
        break;
      }
    }
  }
}

/** A step or chain as JSON (no BigInt, no cycles). */
export function plain(x: unknown): Json {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(x, (_k, v) => {
    if (typeof v === 'bigint') { return v.toString(); }
    if (v && typeof v === 'object') { if (seen.has(v)) { return undefined; } seen.add(v); }
    return v;
  }) ?? 'null');
}

/** Whether a Verdi installation is there to cross-check with (findVerdi); sets the wisp.verdiAvailable context key. */
let verdiKnown: boolean | null = null;
function verdiAvailable(): boolean {
  const home = vscode.workspace.getConfiguration('vaporview').get<string>('trace.verdiHome') || undefined;
  const found = !!findVerdi(home);
  if (found !== verdiKnown) { verdiKnown = found; void vscode.commands.executeCommand('setContext', 'wisp.verdiAvailable', found); }
  return found;
}

export function registerTrace(context: vscode.ExtensionContext, viewer: WaveformViewerProvider, link?: SourceLinkApi) {
  verdiAvailable();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('vaporview.trace.verdiHome')) { verdiAvailable(); } }));
  let controller: TraceController | null = null;
  const c = () => (controller = controller || new TraceController(context, viewer, link));
  const reg = (name: string, fn: (...a: Json[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  reg('vaporview.traceDriver', (arg?: Json) => c().driver(arg || {}));
  // (shared with inline values: { uri, designPath, time } -> { value, via, dumped: false } | undefined)
  reg('vaporview.trace.resolvePortValue', (arg?: Json) => c().resolvePort(arg || {}));
  reg('vaporview.traceXRoot', (arg?: Json) => c().xRoot(arg || {}));
  reg('vaporview.traceDriverFromEditor', (arg?: Json) => c().fromEditor(arg && !(arg instanceof vscode.Uri) ? arg : {}, false));
  reg('vaporview.traceXRootFromEditor', (arg?: Json) => c().fromEditor(arg && !(arg instanceof vscode.Uri) ? arg : {}, true));
  reg('vaporview.traceBack', () => c().back());
  reg('vaporview.traceForward', () => c().forward());
  reg('vaporview.traceCancel', () => c().cancel());
  reg('vaporview.trace.stopLocation', (arg?: Json) => c().stopLocation(arg || {}));
  reg('vaporview.traceVerdiCheck', (arg?: Json) => c().verdiCheck(arg && !(arg instanceof vscode.Uri) ? arg : {}));
  context.subscriptions.push({ dispose: () => { if (controller) { controller.dispose(); } } });
  // The driver highlight : the waveform's selected row, the marker moving, the editor cursor on a signal name.
  let hlSel: Json = null;
  let hlTimer: NodeJS.Timeout | undefined;
  const hlSoon = (arg: Json | null, ms = 150) => {
    if (hlTimer) { clearTimeout(hlTimer); }
    hlTimer = setTimeout(() => { hlTimer = undefined; if (!arg) { if (controller) { controller.clearHighlight(); } return; } void c().highlightFor(arg); }, ms);
  };
  context.subscriptions.push(ViewerProviderClass.signalSelectEventEmitter.event((e) => {
    const p = e && Array.isArray(e.instancePath) && e.instancePath.length ? String(e.instancePath[e.instancePath.length - 1]) : '';
    hlSel = p ? { uri: e.uri, dumpPath: p } : null;
    hlSoon(hlSel, 0);
  }));
  context.subscriptions.push(ViewerProviderClass.markerSetEventEmitter.event((e) => {
    // (a marker event without a time, as a restored session or a save of the session sends: no time of its own, so the
    // viewer's marker counts (null when there is none: no active line); never Number(null) = 0, and never "no marker"
    // over a marker the viewer has (CVA6: a save between the marker and the cursor left the highlight with no time))
    if (hlSel && (!hlSel.uri || !e || e.uri === hlSel.uri)) {
      const has = e && e.time !== undefined && e.time !== null && Number.isFinite(Number(e.time));
      hlSoon(Object.assign({}, hlSel, has ? { time: Number(e.time) } : {}));
    }
  }));
  const svLang = /^(systemverilog|verilog)$/;
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
    const doc = e.textEditor.document;
    if (doc.uri.scheme !== 'file' || !(svLang.test(doc.languageId) || /\.(sv|svh|v|vh)$/i.test(doc.uri.fsPath))) { return; }
    const range = doc.getWordRangeAtPosition(e.selections[0].active, /[A-Za-z_][A-Za-z0-9_$]*/);
    const word = range ? doc.getText(range) : '';
    hlSel = word ? { file: doc.uri.fsPath, word } : null;
    hlSoon(hlSel);
  }));
  context.subscriptions.push({ dispose: () => { if (hlTimer) { clearTimeout(hlTimer); } } });
  // Background prep (vaporview.trace.prepare onOpen): a waveform tab opening loads its chosen design.
  const prepOf = (tab: vscode.Tab) => {
    const input = tab.input;
    if (!(input instanceof vscode.TabInputCustom) || input.viewType !== 'vaporview.waveformViewer') { return; }
    const uri = input.uri;
    if (vscode.workspace.getConfiguration('vaporview', uri).get<string>('trace.prepare') === 'onFirstTrace') { return; }
    void (async () => {
      // (the document is registered once the viewer has opened it)
      for (let i = 0; i < 600; i++) {
        const doc = viewer.getDocumentFromUri(uri.toString());
        if (doc) { await c().prepareOnOpen(doc); return; }
        await new Promise((r) => setTimeout(r, 100));
      }
    })().catch(() => undefined);
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((e) => { for (const t of e.opened) { prepOf(t); } }));
  for (const g of vscode.window.tabGroups.all) { for (const t of g.tabs) { prepOf(t); } }
  // Test-only: the trace state and the panel's DOM (inert unless VAPORVIEW_E2E=1).
  if (process.env.VAPORVIEW_E2E === '1') {
    reg('vaporview.e2e.traceState', () => c().state());
    reg('vaporview.e2e.traceConfirmDelay', (ms: number) => { TraceController.confirmDelayMs = Math.max(0, Number(ms) || 0); return true; });
    // (the runner reads and clears these after every test: a step the dump contradicts fails the test)
    reg('vaporview.e2e.traceInvariants', () => { if (!controller) { return []; } const v = controller.invariantViolations.splice(0); return v; });
    reg('vaporview.e2e.traceResolveMissing', (on: boolean) => { TraceCore.resolveMissing = !!on; c().resetCores(); return true; });
    reg('vaporview.e2e.tracePanel', (q: Json) => c().panel.e2e(q));
    reg('vaporview.e2e.traceReset', () => { c().resetCores(); return true; });
    reg('vaporview.e2e.traceDropDesigns', () => { c().resetCores(); c().dropDesigns(); return true; });
    reg('vaporview.e2e.traceWholeHistory', (on: boolean) => { TraceController.wholeHistory = !!on; c().resetCores(); return true; });
    reg('vaporview.e2e.traceQueryDelay', (ms: number) => { WispTraceSource.delayMs = Math.max(0, Number(ms) || 0); return true; });
    reg('vaporview.e2e.driverHighlight', async (arg?: Json) => { if (arg && arg.painted) { return driverHighlights.painted(String(arg.painted)); } if (arg && arg.fireMarker) { ViewerProviderClass.markerSetEventEmitter.fire({ uri: String(arg.uri || ''), time: arg.fireMarker.time, units: '' } as never); return true; } if (arg && arg.fire) { ViewerProviderClass.signalSelectEventEmitter.fire({ uri: String(arg.uri || ''), instancePath: arg.path ? [String(arg.path)] : [], netlistId: [], source: 'e2e' }); return true; } if (arg && arg.compute) { return c().highlightFor(arg); } if (arg && arg.failStep !== undefined) { c().hlFailStep = arg.failStep === null ? null : String(arg.failStep); return true; } if (arg && arg.quietMarker !== undefined) { const d = viewer.getDocumentFromUri(String(arg.uri)); if (!d || !d.webviewPanel) { return false; } void d.webviewPanel.webview.postMessage({ command: 'setMarker', time: Number(arg.quietMarker), markerType: 0, notUser: true }); return true; } return c().hlLast; });
    reg('vaporview.e2e.traceVerdiNotice', (answer: boolean | null) => { c().noticeAnswer = answer; return true; });
  }
}
/** How long a quiet caller waits for the link's profile auto-pick or switch (ms). */
export const QUIET_WAIT_MS = 300;
export { setTraceDumpSource } from './source';

/** vaporview.trace.designArgs and designRoot from ONE settings scope, so relative arguments always resolve against the
 *  folder they were written for: the most specific scope that sets designArgs (the dump's folder, then the workspace,
 *  then the user); designRoot from that same scope, else that scope's own base (README: "default: the workspace
 *  folder"); a relative designRoot resolves against that base too. (A folder's designArgs with the workspace's
 *  designRoot read `-f a.f` from the wrong folder: badArgs, as the demo sweep saw.)
 *  A dump outside every workspace folder (opened from /tmp, say): the base is the only folder of a single-folder window
 *  (whose .vscode settings are the workspace's), or in a multi-folder window the one folder whose settings set
 *  designArgs. Several such folders, or relative arguments with no folder to resolve them against: `ambiguous` says
 *  why (the caller shows it), never a guess. With no designArgs anywhere: args null, root = the most specific
 *  designRoot or the base. */
export function scopedDesignSettings(cfg: vscode.WorkspaceConfiguration, uri: vscode.Uri, folder: vscode.WorkspaceFolder | undefined,
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders || [], workspaceFile: vscode.Uri | undefined = vscode.workspace.workspaceFile,
  folderConfig: (f: vscode.WorkspaceFolder) => vscode.WorkspaceConfiguration = (f) => vscode.workspace.getConfiguration('vaporview', f.uri)):
  { args: string[] | null; root: string; scope: string; ambiguous?: string } {
  const dumpDir = uri.scheme === 'file' ? path.dirname(uri.fsPath) : '';
  const rooted = (v: string | undefined, base: string) => v ? (path.isAbsolute(v) ? v : path.resolve(base, v)) : base;
  const isArgs = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0;
  let home = folder;
  if (!home && folders.length === 1) { home = folders[0]; }
  // (multi-folder window, dump in none of them: the folder whose own settings choose a design)
  if (!home && folders.length > 1) {
    const setting = folders.filter((f) => isArgs(folderConfig(f).inspect<string[]>('trace.designArgs')?.workspaceFolderValue));
    if (setting.length === 1) {
      const fc = folderConfig(setting[0]);
      const base = setting[0].uri.fsPath;
      return { args: fc.inspect<string[]>('trace.designArgs')!.workspaceFolderValue!.map(String), root: rooted(fc.inspect<string>('trace.designRoot')?.workspaceFolderValue, base), scope: `folder ${setting[0].name}` };
    }
    if (setting.length > 1) {
      return { args: null, root: dumpDir, scope: 'ambiguous', ambiguous: `The waveform is outside every workspace folder and ${setting.length} folders set vaporview.trace.designArgs (${setting.map((f) => f.name).join(', ')}): open it from its design's folder, or set vaporview.trace.designArgs with an absolute vaporview.trace.designRoot for it.` };
    }
  }
  const homeDir = home ? home.uri.fsPath : '';
  const wsDir = workspaceFile && workspaceFile.scheme === 'file' ? path.dirname(workspaceFile.fsPath) : homeDir;
  const a = cfg.inspect<string[]>('trace.designArgs');
  const r = cfg.inspect<string>('trace.designRoot');
  const scopes: [string, string[] | undefined, string | undefined, string][] = [
    ['folder', a && a.workspaceFolderValue, r && r.workspaceFolderValue, homeDir],
    ['workspace', a && a.workspaceValue, r && r.workspaceValue, wsDir],
    ['user', a && a.globalValue, r && r.globalValue, homeDir],
  ];
  for (const [scope, args, root, base] of scopes) {
    if (!isArgs(args)) { continue; }
    if (!root && !base) {
      // (relative arguments with nothing to resolve them against: say so rather than read them from the dump's folder)
      const relative = args.some((x) => /\.(f|sv|svh|v|vh)$/i.test(String(x)) && !path.isAbsolute(String(x)));
      if (relative) { return { args: null, root: dumpDir, scope: 'ambiguous', ambiguous: 'vaporview.trace.designArgs are relative but the waveform is outside every workspace folder: set vaporview.trace.designRoot (an absolute folder), or open the waveform from its design\'s folder.' }; }
    }
    return { args: args.map(String), root: rooted(root, base || dumpDir), scope };
  }
  for (const [scope, , root, base] of scopes) { if (root) { return { args: null, root: rooted(root, base || dumpDir), scope }; } }
  return { args: null, root: homeDir || dumpDir, scope: 'default' };
}
