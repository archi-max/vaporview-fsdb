// vscode-port P4: the waveform debugger as an inline Debug Adapter. A recorded run is stepped like gdb: one thread
// ("cycle"), one frame ("cycle N @ t"), Locals = the signals of the current instance; next/stepBack move the viewer's
// marker one clock cycle, continue/reverseContinue go to the nearest breakpoint hit (no breakpoint enabled: continue
// plays at N cycles/s). Behaviour ported from cmux (Resources/vaporview/cmux-debugger.js, Sources/Panels/WaveformDebugger*.swift).
import * as vscode from 'vscode';
import * as fs from 'fs';
import { InlineAdapter, type Request } from './protocol';
import { DebugEngine, RATES, type Breakpoint, type CycleInfo, type DebugValue, X, noValueShown, SearchStopped } from './engine';
import { type PortValue, isNoValue, noValueText } from '../shared/port_resolve'; // vscode-port 
import { withReadingNote } from './reading-note'; // vscode-port #13
import { type WaveData, type SignalMeta, valueIn, valueBits, pathKey } from './wave-data';
import { codeLines, moduleAt, scanModules, signalLines, watchedSignals, type ModuleInfo } from './sv-lines';
import type { InstanceResolver } from './instances';

export const DEBUG_TYPE = 'vaporview-waveform';
// One formatter (Number#toLocaleString builds one per call: MEASURED the top host cost of a step's stack trace).
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });

/** What the adapter needs from the viewer (implemented over upstream's viewer provider in index.ts). */
export interface ViewerLink {
  /** The open waveform documents' URIs (strings); the active one first. */
  documents(): string[];
  fsPath(uri: string): string | undefined;
  /** The dump's data (the shared data API) for an open waveform; undefined when it is not open. */
  waveData(uri: string): WaveData | undefined;
  markerTime(uri: string): number | null;
  setMarker(uri: string, time: number): void;
  /** The selected row's dump path. */
  selectedSignal(uri: string): string[] | null;
  /** A row's display format id ('hexadecimal', 'riscv', ...) for the signal at `path`, if shown. */
  rowFormat(uri: string, path: string[]): string | undefined;
  onMarkerSet(listener: (uri: string, time: number) => void): vscode.Disposable;
  /** Signals a source line assigns, with their dump paths (slang through the source link); [] without slang. */
  lineSignals?(file: string, line: number): Promise<Array<{ name: string; dumpPath: string }>>;
}

export type AttachArgs = {
  /** The waveform document (URI string or file path); default: the active viewer. */
  waveform?: string;
  /** The clock's dump path ('top.clk'); default: chosen from cmux's name list. */
  clock?: string;
  /** Locals' instance at start ('top.u0'). */
  instance?: string;
  /** Line breakpoints watch the line in 'this' instance (default) or in 'any' instance of its module. */
  lineBreakpointInstances?: 'this' | 'any';
  /** Cycles per second for play (default 10). */
  rate?: number;
  /** Data source override (tests / the shared data API). */
  data?: WaveData;
};

/** Shared by the session and the editor: line breakpoints marked "any instance" (uri#line, 0-based). */
export const anyInstanceLines = new Set<string>();

const VARS_LOCALS = 1;

type StopInfo = { time: number; previousTime: number | null; reason: string; bp?: Breakpoint };

/** How long a marker move we sent may take to come back from the viewer as an echo. */
const SENT_ECHO_MS = 3000;
/** slang's name for an unnamed generate / begin block. */
const UNNAMED = /^unnamed\$\$_\d+$/;

export class WaveformDebugSession extends InlineAdapter {
  engine!: DebugEngine;
  uri = '';
  time: number | null = null;
  playing = false;
  rate = 10;
  localsScope: string[] | null = null;
  /** Locals scope set by the editor (cursor's module instance), wins over the default. */
  editorScope: string[] | null = null;
  lastStop: StopInfo | null = null;
  lastHit: Breakpoint | null = null;
  /** vscode-port: after a value / change / text breakpoint's stop, Locals show the stopped signal's scope (an
   *  editor scope set later wins; a line breakpoint's stop clears it). */
  stopScope: string[] | null = null;
  /** The time a signal breakpoint hit (its frame opens at the driver only there), and where that frame opens:
   *  undefined while Trace is asked, null when it has no answer (no design, or not in it). */
  private hitAt: number | null = null;
  private stopLoc: { key: string; loc?: { file: string; line: number; col: number; kind: string } | null } | null = null;
  private args: AttachArgs = {};
  private ready: Promise<void> | null = null;
  private readyResolve!: () => void;
  private disposables: vscode.Disposable[] = [];
  private playTimer: NodeJS.Timeout | null = null;
  private playOrigin: { index: number; at: number } | null = null;
  private playIndex = 0;
  private playStop: { bp: Breakpoint; time: number; index: number } | null = null;
  /** Marker moves we sent whose echo from the viewer has not come back yet (time, when sent). An echo is consumed
   *  once, and expires: a time we visited earlier (e.g. the first edge at start) must still follow when the user sets
   *  the marker there later (vscode-port: was every time sent, so the marker to t=5 never moved the session). */
  private sentTimes: Array<{ time: number; at: number }> = [];
  private refs = new Map<number, string[]>();
  private nextRef = 100;
  private dapIds = new Map<Breakpoint, number>();
  private lineBps = new Map<string, Breakpoint[]>();
  /** The last setBreakpoints arguments per source, to re-resolve lines when the chosen instance changes. */
  private lineArgs = new Map<string, any>();
  private functionBps: Breakpoint[] = [];
  private dataBps: Breakpoint[] = [];
  private supportsInvalidated = false;
  static readonly onStop = new vscode.EventEmitter<{ session: WaveformDebugSession; stop: StopInfo }>();
  static readonly onEnd = new vscode.EventEmitter<WaveformDebugSession>();
  static readonly onState = new vscode.EventEmitter<WaveformDebugSession>();
  /** Design reads started for inline values have landed : inline values are asked again. */
  static readonly onDesignRead = new vscode.EventEmitter<WaveformDebugSession>();
  /** vscode-port the source line VS Code shows as paused (the editor keeps driver bars off it). */
  static readonly onFrame = new vscode.EventEmitter<{ path: string; line: number } | null>();
  static current: WaveformDebugSession | null = null;

  constructor(private readonly viewer: ViewerLink, private readonly resolver: InstanceResolver) {
    super();
    this.ready = new Promise((r) => { this.readyResolve = r; });
  }

  get data(): WaveData { return this.engine.data; }

  /** A custom request from inside the extension (the commands and the editor), without a round trip through VS Code. */
  customRequestLocal(command: string, args: any = {}): Promise<any> {
    return this.dispatch(command, args, { seq: 0, type: 'request', command, arguments: args });
  }

  // ---- DAP ----
  protected async dispatch(command: string, args: any, request: Request): Promise<any> {
    if (command === 'initialize') {
      this.supportsInvalidated = !!args.supportsInvalidatedEvent;
      return {
        supportsConfigurationDoneRequest: true, supportsStepBack: true, supportsConditionalBreakpoints: true,
        supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsEvaluateForHovers: true,
        supportsTerminateRequest: true, supportsSetVariable: false, supportsValueFormattingOptions: false,
      };
    }
    if (command === 'attach' || command === 'launch') { await this.attach(args); return {}; }
    if (command === 'disconnect' || command === 'terminate') { this.end(); if (command === 'terminate') { this.sendEvent('terminated'); } return {}; }
    await this.ready;
    switch (command) {
      case 'configurationDone': {
        if (this.time === null) {
          const first = this.engine.stepTarget(null, 1);
          if (first !== null) { this.moveMarker(first); }
        }
        this.stopped('entry');
        return {};
      }
      case 'threads': return { threads: [{ id: 1, name: 'cycle' }] };
      case 'stackTrace': return this.stackTrace();
      case 'scopes': return { scopes: [{ name: 'Locals', presentationHint: 'locals', variablesReference: VARS_LOCALS, expensive: false }] };
      case 'variables': return { variables: await this.variables(args.variablesReference) };
      case 'evaluate': return this.evaluateRequest(args);
      // The stopped event follows the response.
      case 'next': case 'stepIn': case 'stepOut': setImmediate(() => this.step(1)); return {};
      case 'stepBack': setImmediate(() => this.step(-1)); return {};
      case 'continue': void this.continueTo(1).catch((e) => this.searchFailed(e)); return { allThreadsContinued: true };
      case 'reverseContinue': void this.continueTo(-1).catch((e) => this.searchFailed(e)); return {};
      case 'pause': setImmediate(() => this.pause()); return {};
      // vscode-port: a run waits for breakpoint requests still being resolved (slang can take seconds on a big design)
      case 'setBreakpoints': return this.pendingBp(this.setBreakpoints(args), `${args?.source?.name || 'line'}:${(args?.breakpoints || []).map((b: any) => b.line).join(',')}`);
      case 'setFunctionBreakpoints': return this.pendingBp(this.setFunctionBreakpoints(args), (args?.breakpoints || []).map((b: any) => b.name).join(', '));
      case 'setDataBreakpoints': return this.pendingBp(this.setDataBreakpoints(args), 'data breakpoints');
      case 'dataBreakpointInfo': return this.dataBreakpointInfo(args);
      case 'setExceptionBreakpoints': return {};
      // ---- custom requests (the palette commands use these) ----
      case 'state': return this.state();
      case 'first': case 'last': this.jump(command); return this.state();
      case 'step': this.step(Number(args.by) || 1); return this.state();
      case 'play': this.play(args.rate); return this.state();
      case 'togglePlay': if (this.playing) { this.pause(); } else { this.play(); } return this.state();
      case 'faster': this.changeRate(1); return this.state();
      case 'slower': this.changeRate(-1); return this.state();
      case 'setRate': this.setRate(Number(args.rate)); return this.state();
      case 'setClock': {
        const path = args.path ? String(args.path).split('.') : null;
        const r = await this.engine.setClock(path);
        if (path && !r) { throw new Error(`${args.path} is not a 1-bit signal in the dump`); }
        this.changedState();
        return this.state();
      }
      case 'useSelectedAsClock': {
        const sel = this.viewer.selectedSignal(this.uri);
        if (!sel) { throw new Error('No signal is selected in the viewer'); }
        const r = await this.engine.setClock(sel);
        if (!r) { throw new Error(`${sel.join('.')} is not a 1-bit signal: it cannot be the clock`); }
        this.changedState();
        return this.state();
      }
      case 'refreshLineBreakpoints': {
        // The instance a module's lines follow changed (Choose Instance for Module…): re-resolve and tell VS Code.
        for (const a of [...this.lineArgs.values()]) {
          const r = await this.setBreakpoints(a);
          for (const b of r.breakpoints) { this.sendEvent('breakpoint', { reason: 'changed', breakpoint: b }); }
        }
        return {};
      }
      case 'setLocalsScope': this.editorScope = args.path ? String(args.path).split('.') : null; this.invalidate(); return {};
      case 'evaluateAt': {
        const time = args.cycle !== undefined ? this.engine.stepTarget(null, Number(args.cycle)) : (args.time ?? this.time);
        const r = await this.engine.evaluate(String(args.expr || ''), this.scope(), Number(time ?? 0));
        const { raw, ...out } = r;
        return { ...out, time };
      }
      case 'breakpoints': return { items: this.engine.breakpoints.map((b) => ({ id: this.dapIds.get(b), kind: b.kind, label: b.label, enabled: b.enabled, condition: b.condition, problem: b.problem, conditionError: b.conditionError })) };
      default: throw new Error(`unsupported request ${command}`);
    }
  }

  private async attach(args: AttachArgs) {
    this.args = args;
    const docs = this.viewer.documents();
    let uri = args.waveform ? String(args.waveform) : docs[0];
    if (!uri) { throw new Error('Open a waveform in VaporView FSDB first, then start the waveform debugger.'); }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(uri)) { uri = vscode.Uri.file(uri).toString(); }
    this.uri = uri;
    const data = args.data ?? this.viewer.waveData(uri);
    if (!data) { throw new Error(`${uri} is not open in VaporView FSDB: open it first, then start the waveform debugger.`); }
    this.engine = new DebugEngine(data);
    this.engine.onWarning = (t) => this.output(t, 'important');
    this.engine.resolveMissing = (path, time) => this.resolvePort(path, time);
    this.engine.resolveMissingQuick = (path, time) => this.resolvePortQuick(path, time);
    if (args.clock) {
      if (!await this.engine.setClock(args.clock.split('.'))) { throw new Error(`clock ${args.clock} is not a 1-bit signal in the dump`); }
    }
    const edges = await this.engine.ensureEdges();
    if (!edges) { throw new Error('No clock found: none of clk, clock, clk_i, ... under the top scopes. Select a 1-bit signal and run Use Selected Signal as Clock, or set "clock" in the launch configuration.'); }
    if (!edges.length) { throw new Error(`The clock ${pathKey(this.engine.clock!.path)} has no rising edge in the dump.`); }
    if (args.rate) { this.setRate(Number(args.rate)); }
    if (args.instance) {
      // vscode-port: one instance for Locals, inline values and line breakpoints. The launch option is the newest explicit
      // choice: an earlier session's Choose Instance for Module (kept per module) must not move inline values to another
      // instance (u0 shown for u1, no via). A Choose Instance during this session still overrides it.
      this.localsScope = args.instance.split('.'); this.resolver.preferred = this.localsScope;
      (this.resolver as { chosen?: Map<string, string[]> }).chosen?.clear();
    }
    this.time = this.viewer.markerTime(uri);
    this.disposables.push(this.viewer.onMarkerSet((u, t) => this.markerSetByViewer(u, t)));
    WaveformDebugSession.current = this;
    this.readyResolve();
    this.sendEvent('initialized');
  }

  private end() {
    this.pause(true);
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (WaveformDebugSession.current === this) { WaveformDebugSession.current = null; this.resolver.preferred = null; }
    WaveformDebugSession.onEnd.fire(this);
  }

  /** Locals' (and expressions') scope: the editor's instance, else the stopped signal's scope, else the attach
   *  instance, else the clock's scope. */
  scope(): string[] | null {
    return this.editorScope || this.stopScope || this.localsScope || (this.engine?.clock ? this.engine.clock.path.slice(0, -1) : null);
  }

  state() {
    const info: CycleInfo = this.engine.cycleInfo(this.time);
    return { ...info, playing: this.playing, rate: this.rate, uri: this.uri, scope: this.scope()?.join('.') ?? null,
      lastHit: this.lastHit ? this.lastHit.label : null };
  }

  // ---- the marker ----
  private moveMarker(time: number) {
    this.time = time;
    this.sentTimes.push({ time, at: Date.now() });
    if (this.sentTimes.length > 32) { this.sentTimes.shift(); }
    this.viewer.setMarker(this.uri, time);
  }

  private markerSetByViewer(uri: string, time: number) {
    if (uri !== this.uri) { return; }
    // One of ours, reported late (play): not the user's. Consumed even when it equals the current time (the entry
    // stop's echo at t=5 was left pending, then swallowed the user's own move back to 5 within the echo window).
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((x) => now - x.at < SENT_ECHO_MS);
    const echo = this.sentTimes.findIndex((x) => x.time === time);
    if (echo >= 0) { this.sentTimes.splice(0, echo + 1); return; }
    if (time === this.time) { return; }
    // The user's move: echoes still pending are older than it, so none of them may hide a later user move.
    this.sentTimes = [];
    this.time = time;
    if (this.playing) { this.pause(); return; }
    this.invalidate();
  }

  private invalidate() {
    if (!this.ready) { return; }
    if (this.supportsInvalidated) { this.sendEvent('invalidated', { areas: ['variables', 'stacks'], threadId: 1 }); } else { this.stopped('goto'); }
    if (this.lastStop && this.time !== null) {
      this.lastStop = { ...this.lastStop, time: this.time, previousTime: this.engine.cycleInfo(this.time).previousTime };
      WaveformDebugSession.onStop.fire({ session: this, stop: this.lastStop });
    }
    WaveformDebugSession.onState.fire(this);
  }

  private changedState() { WaveformDebugSession.onState.fire(this); this.invalidate(); }

  private stopped(reason: string, bp?: Breakpoint, description?: string) {
    const info = this.engine.cycleInfo(this.time);
    this.lastStop = { time: this.time ?? 0, previousTime: info.previousTime, reason, bp };
    // vscode-port: a signal breakpoint's stop: Locals = the stopped signal's scope (the editor's scope from an
    // earlier cursor would show some other instance), and the frame opens at what drove it (stackTrace)
    const sig = bp ? WaveformDebugSession.signalOf(bp) : null;
    if (sig) { this.stopScope = sig.slice(0, -1); this.editorScope = null; this.hitAt = this.time; } else if (bp) { this.stopScope = null; this.hitAt = null; }
    const body: any = { reason, threadId: 1, allThreadsStopped: true };
    if (bp) { body.hitBreakpointIds = [this.dapIds.get(bp)].filter((x) => x !== undefined); body.description = `Hit ${bp.label}`; }
    if (description) { body.description = description; body.text = description; }
    this.sendEvent('stopped', body);
    WaveformDebugSession.onStop.fire({ session: this, stop: this.lastStop });
    WaveformDebugSession.onState.fire(this);
  }

  timeText(time: number | null) {
    if (time === null) { return '-'; }
    return `${NUMBER.format(time * this.data.timeScale)} ${this.data.timeUnit}`;
  }

  /** Why no enabled breakpoint hits from `from` in direction `dir`: one line per breakpoint. */
  private async whyNoHit(from: number | null, dir: number): Promise<string[]> {
    const edges = this.engine.edges!;
    const span = `${this.timeText(edges[0])}–${this.timeText(edges[edges.length - 1])}`;
    const out: string[] = [];
    for (const bp of this.engine.breakpoints.filter((b) => b.enabled)) {
      if (bp.conditionError) { out.push(`${bp.label}: ${bp.conditionError}`); continue; }
      if (bp.problem) { out.push(`${bp.label}: ${bp.problem}`); continue; }
      const cond = bp.condition ? ` with ${bp.condition}` : '';
      const any = await this.engine.findHitOf(bp, null, 1).catch(() => null);
      if (!any) { out.push(`${bp.label}${cond}: never hits in ${span}${bp.condition ? ' (the condition is never true where it would)' : ''}`); continue; }
      const other = await this.engine.findHitOf(bp, from, -dir).catch(() => null);
      if (other) { out.push(`${bp.label}${cond}: its ${dir > 0 ? 'last hit is before' : 'first hit is after'} the marker, at ${this.timeText(other.time)}`); continue; }
      out.push(`${bp.label}${cond}: its only hit is at the marker (${this.timeText(this.time)})`);
    }
    return out;
  }

  // ---- stepping ----
  step(by: number) {
    this.pause(true);
    const t = this.engine.stepTarget(this.time, by);
    if (t !== null) { this.moveMarker(t); }
    this.stopped('step');
  }

  jump(to: 'first' | 'last') {
    this.pause(true);
    const edges = this.engine.edges!;
    this.moveMarker(to === 'last' ? edges[edges.length - 1] : edges[0]);
    this.stopped('step');
  }

  /** vscode-port: a breakpoint search that failed stops the run with the reason (never a run that goes on forever). */
  private searchFailed(e: unknown) {
    const msg = String(e && (e as Error).message || e);
    // vscode-port: the document closed or reloaded under the search (code 'reloaded'): nothing
    // to report; the session ends or restarts with the document
    if (/\(reloaded\)$/.test(msg)) { this.pause(true); return; }
    this.pause(true);
    this.output(`Breakpoint search failed: ${msg}`, 'important');
    this.stopped('exception', undefined, `Breakpoint search failed: ${msg}`);
  }

  /** vscode-port: breakpoint requests not answered yet (what they set, since when). */
  private pending = new Map<Promise<unknown>, { what: string; since: number }>();
  /** e2e: setBreakpoints waits this long first (a slow source link), and how long a run waits for pending ones. */
  static bpDelayMs = 0;
  static pendingWaitMs = 10000;
  private pendingBp<T>(p: Promise<T>, what: string): Promise<T> {
    const entry = { what, since: Date.now() };
    const tracked = p.finally(() => { this.pending.delete(tracked); });
    this.pending.set(tracked, entry);
    // a run already going (play) re-plans its stop with the new breakpoints
    void tracked.then(() => { if (this.playing) { this.replanPlay(); } }, () => undefined);
    return tracked;
  }

  /** Waits for pending breakpoint requests ("Resolving breakpoints…" in the status bar); the ones still pending after
   *  pendingWaitMs, else []. */
  private async resolvePending(): Promise<Array<{ what: string; since: number }>> {
    if (!this.pending.size) { return []; }
    const note = vscode.window.setStatusBarMessage('$(sync~spin) Resolving breakpoints…');
    WaveformDebugSession.searchNote = 'Resolving breakpoints…';
    try {
      const all = Promise.allSettled([...this.pending.keys()]);
      await Promise.race([all, new Promise((r) => setTimeout(r, WaveformDebugSession.pendingWaitMs))]);
      return [...this.pending.values()];
    } finally { note.dispose(); }
  }

  /** Play's stop, again from where play is (breakpoints changed while playing). */
  private replanPlay() {
    const edges = this.engine.edges;
    if (!edges || !this.engine.breakpoints.some((b) => b.enabled)) { this.playStop = null; return; }
    const from = this.time;
    void this.engine.findHit(from, 1).then((h) => { if (this.playing && h) { this.playStop = h; } }, (e) => this.searchFailed(e));
  }

  async continueTo(dir: number) {
    this.pause(true);
    // vscode-port: breakpoints added just before the run (VS Code sends them as it continues) count: wait for them;
    // one not resolved in time says so instead of a silent run without it (CVA6 line bp played to the end)
    const late = await this.resolvePending();
    if (late.length) {
      const why = 'the source link (slang-server) is still loading the design';
      const msg = `Breakpoint at ${late[0].what} isn't resolved yet: ${why} (${Math.round((Date.now() - late[0].since) / 1000)} s). Continue again once it shows as verified.`;
      this.output(msg, 'important');
      this.stopped('step', undefined, `Breakpoint at ${late[0].what} isn't resolved yet`);
      return;
    }
    if (!this.engine.breakpoints.some((b) => b.enabled)) {
      if (dir > 0) { this.play(); return; }
      this.stopped('step', undefined, 'No breakpoint is enabled');
      return;
    }
    const edges = this.engine.edges!;
    const from = this.time === null || this.time < edges[0] ? null : this.time;
    // vscode-port: a search longer than 2 s says where it is in the status bar; Pause stops it
    const search = this.engine.search = { bp: null as Breakpoint | null, reached: from, cancelled: false };
    const end = edges[edges.length - 1];
    let shown: vscode.StatusBarItem | null = null;
    const show = () => {
      if (!shown) { shown = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000); shown.show(); }
      const what = search.bp ? search.bp.label : 'breakpoints';
      shown.text = `$(sync~spin) Searching for ${what}… at ${this.timeText(search.reached ?? 0)} of ${this.timeText(end)}`;
      shown.tooltip = 'Pause (F6) stops the search';
      WaveformDebugSession.searchNote = shown.text;
    };
    let ticker: NodeJS.Timeout | null = null;
    const starter = setTimeout(() => { show(); ticker = setInterval(show, 500); }, WaveformDebugSession.searchNoteMs);
    let hit: Awaited<ReturnType<DebugEngine['findHit']>>;
    try {
      hit = await this.engine.findHit(from, dir);
    } catch (e) {
      if (e instanceof SearchStopped) {
        const at = this.timeText(e.reached);
        this.output(`Breakpoint search stopped at ${at} (no hit ${dir > 0 ? 'between the marker and there' : 'between there and the marker'}).`, 'important');
        this.stopped('pause', undefined, `Search stopped at ${at}`);
        return;
      }
      throw e;
    } finally {
      clearTimeout(starter); if (ticker) { clearInterval(ticker); }
      (shown as vscode.StatusBarItem | null)?.dispose();
      if (this.engine.search === search) { this.engine.search = null; }
    }
    if (!hit) {
      // vscode-port say why, per enabled breakpoint (its last hit on the other side, never hits, cannot evaluate)
      const why = await this.whyNoHit(from, dir);
      this.output((dir > 0 ? 'No breakpoint hit after the marker' : 'No breakpoint hit before the marker') + (why.length ? ':\n  ' + why.join('\n  ') : '.'), 'important');
      this.stopped('step', undefined, (dir > 0 ? 'No breakpoint hit ahead' : 'No breakpoint hit behind') + (why.length ? ': ' + why[0] + (why.length > 1 ? ` (+${why.length - 1} more in the Debug Console)` : '') : ''));
      return;
    }
    if (hit.index >= edges.length) {
      this.output(`${hit.bp.label} hits at ${this.timeText(hit.time)}, after the last clock edge.`, 'important');
      this.moveMarker(edges[edges.length - 1]);
      this.stopped('step', undefined, 'Hit after the last clock edge');
      return;
    }
    this.lastHit = hit.bp;
    this.moveMarker(edges[hit.index]);
    this.output(`Hit ${hit.bp.label} at ${this.timeText(hit.time)} (cycle ${hit.index + 1})`);
    this.stopped('breakpoint', hit.bp);
  }

  // ---- play (cmux: each tick puts the marker on the cycle wall-clock time says it should be at) ----
  play(rate?: number) {
    if (rate) { this.setRate(Number(rate)); }
    const edges = this.engine.edges!;
    let index = this.time === null ? 0 : Math.max(0, this.engineEdgeIndex(this.time));
    if (index >= edges.length - 1) { index = 0; }
    this.playOrigin = { index, at: Date.now() };
    this.playIndex = index;
    this.playStop = null;
    const enabled = this.engine.breakpoints.some((b) => b.enabled);
    const from = this.time === null || this.time < edges[0] ? null : edges[index];
    if (enabled) {
      void this.engine.findHit(from, 1).then((h) => { if (this.playing && h) { this.playStop = h; } }, (e) => this.searchFailed(e));
    }
    if (!this.playing) { this.playing = true; this.sendEvent('continued', { threadId: 1, allThreadsContinued: true }); }
    if (this.time === null || edges[index] !== this.time) { this.moveMarker(edges[index]); }
    WaveformDebugSession.onState.fire(this);
    this.scheduleTick();
  }

  private engineEdgeIndex(time: number) {
    const edges = this.engine.edges!;
    let lo = 0, hi = edges.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (edges[mid] <= time) { at = mid; lo = mid + 1; } else { hi = mid - 1; } }
    return at;
  }

  private scheduleTick() {
    if (this.playTimer) { clearTimeout(this.playTimer); }
    this.playTimer = setTimeout(() => this.tick(), Math.max(16, Math.min(250, 1000 / this.rate)));
  }

  private tick() {
    if (!this.playing || !this.playOrigin) { return; }
    const edges = this.engine.edges!;
    let target = Math.min(edges.length - 1, this.playOrigin.index + Math.floor((Date.now() - this.playOrigin.at) * this.rate / 1000));
    const stop = this.playStop && this.playStop.index > this.playIndex && target >= this.playStop.index ? this.playStop : null;
    if (stop) { target = stop.index; }
    this.playIndex = target;
    if (edges[target] !== this.time) { this.moveMarker(edges[target]); WaveformDebugSession.onState.fire(this); }
    if (stop) {
      this.pause(true);
      this.lastHit = stop.bp;
      this.output(`Hit ${stop.bp.label} at ${this.timeText(stop.time)} (cycle ${stop.index + 1})`);
      this.stopped('breakpoint', stop.bp);
      return;
    }
    if (target >= edges.length - 1) { this.pause(); return; }
    this.scheduleTick();
  }

  /** quiet: no stopped event (the caller sends its own). */
  pause(quiet = false) {
    // vscode-port: Pause during a breakpoint search stops the search (continueTo then reports where it got to)
    if (!quiet && this.engine?.search && !this.engine.search.cancelled) { this.engine.search.cancelled = true; return; }
    if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
    this.playStop = null;
    if (!this.playing) { return; }
    this.playing = false;
    if (!quiet) { this.stopped('pause'); } else { WaveformDebugSession.onState.fire(this); }
  }

  setRate(rate: number) {
    if (!(rate > 0)) { return; }
    const now = Date.now();
    if (this.playing && this.playOrigin && this.engine.edges) {
      const reached = Math.min(this.engine.edges.length - 1, this.playOrigin.index + Math.floor((now - this.playOrigin.at) * this.rate / 1000));
      this.playOrigin = { index: reached, at: now };
    }
    this.rate = Math.min(RATES[RATES.length - 1], Math.max(RATES[0], rate));
    WaveformDebugSession.onState.fire(this);
    if (this.playing) { this.scheduleTick(); }
  }

  changeRate(by: number) {
    const dir = Math.sign(by);
    let i = RATES.findIndex((r) => r >= this.rate);
    if (i < 0) { i = RATES.length; }
    const next = RATES[i] === this.rate ? i + dir : (dir > 0 ? i : i - 1);
    this.setRate(RATES[Math.max(0, Math.min(RATES.length - 1, next))]);
  }

  // ---- frames, Locals, evaluate ----
  // The frame's source decides which tab VS Code shows on every stop (it opens the focused frame's source), and the
  // only editor it draws inline values in (DebugEditorContribution.updateInlineValueDecorations). So it is SystemVerilog
  // whenever an SV editor follows the session: the hit line of a line breakpoint; else, in the followed SV editor (the
  // active one first, else the first visible), the line driving a signal of its cursor's instance that changed this
  // cycle (nearest the cursor), else the cursor line. Only with no SV editor visible is it the waveform. Either way the
  // marker moves in the waveform (setMarker posts to its webview, shown or not), so stepping from an SV editor that
  // shares a tab group with the waveform keeps the SV tab in front.
  private async stackTrace() {
    const r = await this.stackFrames();
    const src = r.stackFrames[0]?.source?.path;
    if (src && src !== vscode.Uri.parse(this.uri).fsPath) { await this.revealBesideWave(src); }
    return r;
  }

  /** vscode-port: VS Code opens a stop's source in the active group, which is the
   *  waveform's, hiding the waveform. Open it first in another group (preserveFocus); VS Code then reveals it there. */
  private async revealBesideWave(file: string) {
    try {
      const groups = vscode.window.tabGroups.all;
      const isWave = (t: vscode.Tab) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === vscode.Uri.parse(this.uri).toString();
      const wave = groups.find((g) => g.activeTab && isWave(g.activeTab));
      if (!wave) { return; } // the waveform isn't showing: VS Code's placement is fine
      const target = vscode.Uri.file(file);
      const isSrc = (t: vscode.Tab | undefined) => !!t && t.input instanceof vscode.TabInputText && t.input.uri.fsPath === target.fsPath;
      const others = groups.filter((g) => g !== wave);
      if (others.some((g) => isSrc(g.activeTab))) { return; }
      const col = (others.find((g) => g.tabs.some((t) => isSrc(t))) || others[0])?.viewColumn ?? vscode.ViewColumn.Beside;
      await vscode.window.showTextDocument(target, { viewColumn: col, preserveFocus: true, preview: false });
    } catch { /* VS Code places it */ }
  }

  private async stackFrames(): Promise<{ stackFrames: any[]; totalFrames: number }> {
    const info = this.engine.cycleInfo(this.time);
    const frame: any = { id: 1, name: `cycle ${info.cycle ?? 0} @ ${this.timeText(this.time)}`, line: 0, column: 0, presentationHint: 'normal' };
    const origin = this.lastStop?.bp?.kind === 'line' ? this.lastStop.bp.origin : null;
    if (origin && this.lastStop?.time === this.time) {
      frame.source = { name: origin.name, path: origin.path };
      frame.line = origin.line + 1;
      frame.column = 1;
      WaveformDebugSession.onFrame.fire({ path: frame.source.path, line: frame.line - 1 }); // vscode-port 
      return { stackFrames: [frame], totalFrames: 1 };
    }
    const sig = this.lastStop?.bp && this.hitAt !== null && this.hitAt === this.time ? WaveformDebugSession.signalOf(this.lastStop.bp) : null;
    if (sig) {
      // vscode-port: a value / change / text breakpoint's stop opens the statement that drove the value (Trace
      // Driver's step), else the signal's declaration; never the cursor's line (line 1 of a file just opened). Asked
      // without holding the stop: the frame has no source until Trace answers, then moves (invalidated).
      const key = `${this.lastStop!.bp!.id}@${this.time}`;
      if (!this.stopLoc || this.stopLoc.key !== key) {
        this.stopLoc = { key };
        const asked = this.locateStop(sig, key);
        if (!this.supportsInvalidated) { await Promise.race([asked, new Promise((r) => setTimeout(r, 5000))]); }
      }
      const loc = this.stopLoc.loc;
      if (loc) {
        frame.source = { name: loc.file.split(/[\\/]/).pop(), path: loc.file };
        frame.line = loc.line;
        frame.column = Math.max(1, loc.col || 1);
        WaveformDebugSession.onFrame.fire({ path: loc.file, line: loc.line - 1 });
      } else {
        frame.name += ` (${pathKey(sig)})`;
      }
      return { stackFrames: [frame], totalFrames: 1 };
    }
    const ed = WaveformDebugSession.followedEditor();
    if (ed) {
      frame.source = { name: ed.document.uri.path.split('/').pop(), path: ed.document.uri.fsPath };
      const cursor = ed.selection.active.line;
      let line = cursor;
      try {
        const driver = await this.driverLineNear(ed.document.getText(), cursor);
        if (driver !== null) { line = driver; }
      } catch { /* the cursor line */ }
      frame.line = line + 1;
    } else {
      const wave = vscode.Uri.parse(this.uri);
      frame.source = { name: wave.path.split('/').pop(), path: wave.fsPath };
      frame.line = 1;
    }
    frame.column = 1;
    WaveformDebugSession.onFrame.fire({ path: frame.source.path, line: frame.line - 1 }); // vscode-port 
    return { stackFrames: [frame], totalFrames: 1 };
  }

  /** The signal a value / change / text breakpoint watches (its dump path); null for a line breakpoint. */
  static signalOf(bp: Breakpoint): string[] | null {
    if (bp.kind === 'line') { return null; }
    const p = bp.win?.[0]?.path ?? bp.paths[0];
    return p && p.length > 1 ? p : null;
  }

  /** e2e : where the last signal breakpoint's frame opens (undefined: still asking). */
  stopLocation() { return this.stopLoc ? { key: this.stopLoc.key, loc: this.stopLoc.loc } : null; }

  /** Where a signal breakpoint's stop opens: Trace's quiet stopLocation (the driving statement, else the
   *  declaration); null without a design. Moves the frame (invalidated stacks) when it answers. */
  private async locateStop(sig: string[], key: string) {
    let loc: { file: string; line: number; col: number; kind: string } | null = null;
    try {
      const r: any = await vscode.commands.executeCommand('vaporview.trace.stopLocation', { uri: this.uri, path: pathKey(sig), time: this.time });
      if (r && typeof r.file === 'string' && Number(r.line) > 0) { loc = { file: r.file, line: Number(r.line), col: Number(r.col) || 1, kind: String(r.kind || 'driver') }; }
    } catch { /* no Trace (command missing) or no design: the frame keeps no source */ }
    if (!this.stopLoc || this.stopLoc.key !== key) { return; }
    this.stopLoc.loc = loc;
    if (loc && this.supportsInvalidated) { this.sendEvent('invalidated', { areas: ['stacks'], threadId: 1 }); }
  }

  /** The SV editor the session follows: the active text editor when it is SV, else the first visible SV editor. */
  static followedEditor(): vscode.TextEditor | undefined {
    const sv = (e: vscode.TextEditor) => e.document.uri.scheme === 'file'
      && (['verilog', 'systemverilog'].includes(e.document.languageId) || /\.(sv|svh|v|vh)$/i.test(e.document.fileName));
    const active = vscode.window.activeTextEditor;
    return active && sv(active) ? active : vscode.window.visibleTextEditors.find(sv);
  }

  /** In `text`, the line (0-based) nearest `cursor` that drives a signal of the cursor module's instance that changed
   *  in the cycle ending at the marker; null when none did (or the module has no instance in the dump). */
  private async driverLineNear(text: string, cursor: number): Promise<number | null> {
    if (this.time === null) { return null; }
    const mods = scanModules(text);
    const mod = moduleAt(mods, cursor);
    if (!mod) { return null; }
    const inst = await this.resolver.thisInstance(mod, this.data, mods);
    if (!inst) { return null; }
    const previous = this.engine.cycleInfo(this.time).previousTime;
    if (previous === null) { return null; }
    const changed = new Set<string>();
    // vscode-port only the signals driven within NEAR lines of the cursor (was every var of the instance at two
    // times, before anything was painted: on a big FSDB the reader's first touch of hundreds of signals, ~36 s on CVA6)
    const NEAR = 30;
    const code = codeLines(text);
    const all = (await this.data.children(inst)).filter((c): c is SignalMeta => c.kind === 'var');
    const drivers = signalLines(code, mod, new Set(all.map((v) => v.name))).drivers;
    const near = new Set([...drivers].filter(([, ls]) => ls.some((n) => Math.abs(n - cursor) <= NEAR)).map(([name]) => name));
    const vars = all.filter((v) => near.has(v.name));
    if (!vars.length) { return null; }
    const before = await this.engine.valuesAt(vars, previous), now = await this.engine.valuesAt(vars, this.time);
    vars.forEach((v, i) => {
      const a = before[i], b = now[i];
      if (a === undefined || b === undefined) { return; } // no dump value at an end is not a change (never x)
      if (valueBits(a, v.width) !== valueBits(b, v.width)) { changed.add(v.name); }
    });
    if (!changed.size) { return null; }
    const lines = [...new Set([...signalLines(code, mod, changed).drivers.values()].flat())].filter((n) => Math.abs(n - cursor) <= NEAR);
    if (!lines.length) { return null; }
    return lines.reduce((best, n) => (Math.abs(n - cursor) < Math.abs(best - cursor) ? n : best), lines[0]);
  }

  /** vscode-port the stopped line's values are read and painted first (their own request); Locals (every var
   *  of the instance: on a big FSDB the reader's first touch of hundreds of signals) wait for that, at most 15 s. */
  static valuesFirst: Promise<unknown> | null = null;
  /** vscode-port: the last "Searching for …" status text (e2e), and after how long a search shows it. */
  static searchNote = '';
  static searchNoteMs = 2000;

  private async variables(ref: number) {
    const scope = ref === VARS_LOCALS ? this.scope() : this.refs.get(ref);
    if (!scope) { return []; }
    const gate = WaveformDebugSession.valuesFirst;
    if (ref === VARS_LOCALS && gate) { await Promise.race([gate.catch(() => undefined), new Promise((r) => setTimeout(r, 15000))]); }
    const time = this.time ?? 0;
    const out: any[] = [];
    const children = await this.data.children(scope);
    const vars = children.filter((c): c is SignalMeta => c.kind === 'var').slice(0, 2002);
    const values = new Map((await withReadingNote(vars.length, this.engine.readAt(vars, time))).map((b, i) => [vars[i], b] as const));
    for (const c of children) {
      if (c.kind === 'scope') {
        const r = this.nextRef++;
        this.refs.set(r, c.path);
        // vscode-port: slang's internal name of an unnamed block (unnamed$$_0) is not shown
        out.push({ name: UNNAMED.test(c.name) ? '(unnamed block)' : c.name, value: 'scope', variablesReference: r, presentationHint: { kind: 'class' } });
        continue;
      }
      const v = c as SignalMeta;
      const d = values.get(v)!;
      const type = v.width > 1 ? `logic [${v.msb ?? v.width - 1}:${v.lsb ?? 0}]` : 'logic';
      out.push({ name: v.name, value: this.show(v, d), variablesReference: 0, evaluateName: pathKey(v.path),
        type: !isNoValue(d) && d.via ? `${type} via ${d.via}` : type, ...(isNoValue(d) ? { presentationHint: { attributes: ['readOnly'] } } : {}) });
      if (out.length > 2000) { break; }
    }
    return out;
  }

  /** a signal the dump has no values for, through the design (Trace's shared resolver; the same command the
   *  source link's inline values use): its value via its connection, or why it has none. Cached per path and time. */
  private portCache = new Map<string, PortValue>();
  private portGen = -1;
  private async resolvePort(path: string[], time: number): Promise<PortValue> {
    if (this.portGen !== this.data.generation) { this.portCache.clear(); this.portGen = this.data.generation; }
    const key = `${pathKey(path)}@${time}`;
    const hit = this.portCache.get(key);
    if (hit) { return hit; }
    if (this.portCache.size > 4096) { this.portCache.clear(); }
    let r: PortValue;
    try {
      const x: any = await vscode.commands.executeCommand('vaporview.trace.resolvePortValue', { uri: this.uri, designPath: pathKey(path), time });
      r = x && typeof x.value === 'string' && typeof x.via === 'string' ? { value: x.value, via: x.via, dumped: false }
        : isNoValue(x) ? x : { noValue: true, reason: 'notDumped', path: pathKey(path) };
    } catch { r = { noValue: true, reason: 'notDumped', path: pathKey(path) }; }
    this.portCache.set(key, r);
    return r;
  }

  /** The cached design read, or null after starting it in the background (onDesignRead fires when it lands). */
  private pendingPorts = new Set<string>();
  private resolvePortQuick(path: string[], time: number): PortValue | null {
    if (this.portGen !== this.data.generation) { this.portCache.clear(); this.portGen = this.data.generation; }
    const key = `${pathKey(path)}@${time}`;
    const hit = this.portCache.get(key);
    if (hit) { return hit; }
    if (!this.pendingPorts.has(key)) {
      this.pendingPorts.add(key);
      void this.resolvePort(path, time).finally(() => {
        this.pendingPorts.delete(key);
        if (!this.pendingPorts.size) { WaveformDebugSession.onDesignRead.fire(this); }
      });
    }
    return null;
  }

  /** A read as the debugger shows it: hex bits, or "no value (why)" (never x for a value the dump lacks). */
  show(v: SignalMeta, d: DebugValue): string {
    return isNoValue(d) ? noValueShown(d) : this.format(v, d.bits);
  }

  async formatAt(v: SignalMeta, time: number): Promise<string> {
    const [d] = await this.engine.readAt([v], time);
    return this.show(v, d);
  }

  /** vscode-port the waveform row's number format for `path` (undefined when it has no row). */
  rowFormat(path: string[]): string | undefined { return this.viewer.rowFormat(this.uri, path); }

  /** A value as the debugger shows it (hex; x when there is none). */
  format(v: SignalMeta, bits: string): string {
    return X.format(X.fromBits(bits, v.width), 'hex');
  }

  private async evaluateRequest(args: any) {
    const text = String(args.expression || '').trim();
    const r = await this.engine.evaluate(text, this.scope(), this.time ?? 0);
    if (r.error) {
      if (args.context === 'hover') { throw new Error(''); }
      throw new Error(r.message || r.error);
    }
    return { result: args.context === 'hover' || args.context === 'watch' ? r.value : `${r.value}  (${r.decimal})`, variablesReference: 0, type: `${r.width} bits` };
  }

  // ---- breakpoints ----
  private dapId(bp: Breakpoint) {
    let id = this.dapIds.get(bp);
    if (id === undefined) { id = bp.id; this.dapIds.set(bp, id); }
    return id;
  }

  private replace(old: Breakpoint[], next: Breakpoint[]) {
    const gone = new Set(old);
    this.engine.remove((b) => gone.has(b));
    for (const b of next) { this.engine.breakpoints.push(b); this.dapId(b); }
  }

  private describe(bp: Breakpoint, verifiedNote?: string) {
    const problem = bp.conditionError ? `condition: ${bp.conditionError}` : bp.problem;
    const base = bp.designNote ? `${verifiedNote || bp.label}; ${bp.designNote}` : verifiedNote;
    const note = bp.conditionNote ? `${base || bp.label}; condition: ${bp.conditionNote}` : base; // 
    return { id: this.dapId(bp), verified: !problem, message: problem || note || bp.label };
  }

  private async setBreakpoints(args: any) {
    if (WaveformDebugSession.bpDelayMs) { await new Promise((r) => setTimeout(r, WaveformDebugSession.bpDelayMs)); } // (e2e: a slow source link)
    const source = args.source || {};
    const file: string | undefined = source.path;
    const key = file || source.name || '';
    this.lineArgs.set(key, args);
    const items: any[] = args.breakpoints || [];
    let text = '';
    if (file) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
      text = open ? open.getText() : await fs.promises.readFile(file, 'utf8').catch(() => '');
    }
    const lines = codeLines(text);
    const modules = scanModules(text);
    const next: Breakpoint[] = [];
    const out: any[] = [];
    // A line keeps its breakpoint id across re-resolution (VS Code matches 'changed' events by id).
    const previous = this.lineBps.get(key) || [];
    const idFor = (line: number) => previous.find((p) => p.origin?.line === line)?.id ?? this.engine.newId();
    for (const item of items) {
      const line = Number(item.line) - 1;
      const anyInstance = this.args.lineBreakpointInstances === 'any' || anyInstanceLines.has(`${vscode.Uri.file(file || '').toString()}#${line}`);
      const mod: ModuleInfo | undefined = moduleAt(modules, line);
      // slang (the source link) names what the line assigns and where it is in the dump; without a
      // slang-server the line's text is scanned (cmux watchedSignals) and dump instances matched by port names.
      const slang = file && this.viewer.lineSignals ? await this.viewer.lineSignals(file, line) : [];
      // (no slang answer: not connected yet, still loading, or no assignment it knows on this line; it cannot tell which)
      const how = slang.length ? 'slang' : 'text scan: no slang answer for this line';
      const signals = slang.length ? [...new Set(slang.map((s) => s.name))] : (mod ? watchedSignals(lines[line] || '') : []);
      const label = `${source.name || 'line'}:${line + 1}`;
      let bp: Breakpoint;
      const origin = { path: file, name: source.name, line, anyInstance };
      if (slang.length && !anyInstance) {
        // This instance: slang's own dump paths.
        const paths: string[][] = [];
        // vscode-port: in the instance the session shows the module in (launch option instance / Choose Instance), as
        // Locals and inline values do; slang's dump paths name the source link's own instance
        const inst = mod ? await this.resolver.thisInstance(mod, this.data, modules) : null;
        for (const s of slang) {
          const own = inst ? inst.concat(s.name) : null;
          const p = own && await this.data.find(own) ? own : s.dumpPath.split('.');
          if (await this.data.find(p)) { paths.push(p); }
        }
        const groups = paths.length ? [{ scope: paths[0].slice(0, -1), paths }] : [];
        bp = { id: idFor(line), ...this.engine.lineBreakpoint(groups, label, item.condition ?? null, origin) } as Breakpoint;
        this.engine.checkCondition(bp); await this.engine.checkConditionValues(bp, this.time ?? 0);
        if (!groups.length) { bp.times = null; bp.problem = `None of ${slang.map((s) => s.dumpPath).join(', ')} is in the dump`; } else { await this.engine.hitTimes(bp); }
      } else if (!mod || !signals.length) {
        bp = { id: idFor(line), kind: 'line', paths: [], enabled: true, label, condition: item.condition, origin, times: null,
          problem: mod ? 'This line names no signal' : 'This line is not inside a module' };
        this.engine.checkCondition(bp); await this.engine.checkConditionValues(bp, this.time ?? 0);
      } else {
        const instances = anyInstance ? await this.resolver.instancesOf(mod, this.data) : [await this.resolver.thisInstance(mod, this.data, modules)].filter((x): x is string[] => !!x);
        const groups: Array<{ scope: string[]; paths: string[][] }> = [];
        for (const scope of instances) {
          const paths: string[][] = [];
          for (const sig of signals) { if (await this.data.find(scope.concat(sig))) { paths.push(scope.concat(sig)); } }
          if (paths.length) { groups.push({ scope, paths }); }
        }
        bp = { id: idFor(line), ...this.engine.lineBreakpoint(groups, label, item.condition ?? null, origin) } as Breakpoint;
        this.engine.checkCondition(bp); await this.engine.checkConditionValues(bp, this.time ?? 0);
        if (!groups.length) {
          bp.times = null;
          bp.problem = instances.length ? `None of ${signals.join(', ')} is in the dump under ${instances.map((s) => s.join('.')).join(', ')}`
            : `No dump instance of module ${mod.name} found (fallback matching by port names; slang mapping not connected)`;
        } else {
          await this.engine.hitTimes(bp);
        }
      }
      next.push(bp);
      const where = bp.paths.length ? `watches ${[...new Set(bp.paths.map((p) => p[p.length - 1]))].join(', ')} in ${[...new Set(bp.paths.map((p) => p.slice(0, -1).join('.')))].join(', ')} (${how})` : undefined;
      out.push({ ...this.describe(bp, where), line: line + 1 });
    }
    this.replace(this.lineBps.get(key) || [], next);
    this.lineBps.set(key, next);
    return { breakpoints: out };
  }

  /**
   * Signal breakpoints as function breakpoints, so they show (and toggle, and take conditions) in the Breakpoints view:
   *   `top.cnt`  or `top.cnt changes`      Break When Changes
   *   `top.cnt == 8'h05`                    Break When Equals
   *   `top.instr ~ /^li a0/ riscv`          Break When Text Matches (regex over the row's text in that format; `/i` too)
   */
  static parseFunctionBreakpoint(name: string): { kind: string; path: string[]; value?: string; text?: { format: string; pattern: string; caseSensitive: boolean } } | null {
    const s = name.trim();
    let m = /^([^\s=~]+)\s*~\s*\/(.*)\/(i?)\s*([A-Za-z_:][\w:.-]*)?$/.exec(s);
    if (m) { return { kind: 'text', path: m[1].split('.'), text: { pattern: m[2], caseSensitive: m[3] !== 'i', format: m[4] || 'hexadecimal' } }; }
    m = /^([^\s=~]+)\s*==?\s*(.+)$/.exec(s);
    if (m) { return { kind: 'equals', path: m[1].split('.'), value: m[2].trim() }; }
    m = /^([^\s=~]+)(?:\s+changes)?$/.exec(s);
    if (m) { return { kind: 'change', path: m[1].split('.') }; }
    return null;
  }

  private async signalBreakpoint(name: string, condition: string | undefined): Promise<Breakpoint> {
    const parsed = WaveformDebugSession.parseFunctionBreakpoint(name);
    const bp: Breakpoint = { id: this.engine.newId(), kind: parsed?.kind || 'change', paths: parsed ? [parsed.path] : [], enabled: true,
      label: name, value: parsed?.value, condition: condition ?? null,
      text: parsed?.text ? { ...parsed.text, anyRegisterNames: true } : undefined };
    this.engine.checkCondition(bp); await this.engine.checkConditionValues(bp, this.time ?? 0);
    if (!parsed) { bp.times = null; bp.problem = 'Not a signal breakpoint: write `top.sig`, `top.sig == value` or `top.sig ~ /regex/ format`'; return bp; }
    await this.engine.hitTimes(bp);
    return bp;
  }

  private async setFunctionBreakpoints(args: any) {
    const next: Breakpoint[] = [];
    for (const item of args.breakpoints || []) { next.push(await this.signalBreakpoint(String(item.name || ''), item.condition)); }
    this.replace(this.functionBps, next);
    this.functionBps = next;
    return { breakpoints: next.map((b) => this.describe(b)) };
  }

  private async dataBreakpointInfo(args: any) {
    const scope = args.variablesReference === VARS_LOCALS ? this.scope() : this.refs.get(args.variablesReference);
    const path = scope ? scope.concat(String(args.name)) : String(args.name).split('.');
    const v = await this.data.find(path);
    if (!v) { return { dataId: null, description: 'not a dumped signal' }; }
    return { dataId: pathKey(v.path), description: `${pathKey(v.path)} changes`, accessTypes: ['write'], canPersist: true };
  }

  private async setDataBreakpoints(args: any) {
    const next: Breakpoint[] = [];
    for (const item of args.breakpoints || []) { next.push(await this.signalBreakpoint(String(item.dataId), item.condition)); }
    this.replace(this.dataBps, next);
    this.dataBps = next;
    return { breakpoints: next.map((b) => this.describe(b)) };
  }
}
