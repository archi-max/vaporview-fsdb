// vscode-port: the SystemVerilog editor <-> waveform link. Ported from cmux (sv-editor 45a845a1ab4)
// WaveformSourceLink.swift (+ the parts of SlangDesignHierarchy.swift it uses, WaveformEnumLink.swift and
// FilePreviewInlineValueOverlay.swift):
//  - Add Signal to Waveform: the signal under the editor's cursor, placed in the design by slang-server, mapped to
//    the dump through the path mapping (user rules, plus inferred rules that never replace them). A signal the dump
//    lacks is shown through a net it is connected to by a plain port connection.
//  - Show Waveform Signal in Source: a row's declaration, then its driver (one assignment: selected; several: peek
//    list), with back / forward history.
//  - Inline values at the marker in SystemVerilog editors (decorations, outside any debug session), and a hover with
//    an enum member's name and raw value.
//  - Enum names: enum-typed rows get their slang type as a value alias table (their default format).
// SPDX-License-Identifier: GPL-3.0-or-later
import { INLINE_NO_VALUE_STYLE, INLINE_SEPARATOR, INLINE_VALUE_STYLE, noValueInline } from '../shared/inline_style';
import * as vscode from 'vscode';
import type { WaveformViewerProvider } from '../../extension_core/viewer_provider';
import type { VaporviewDocument } from '../../extension_core/document';
import { Slang, SlangItem, SlangUnavailable, LspLocation, toLocation, sameFile } from './slang';
import * as nodePath from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { listProfiles, profileMatchingDumpTops } from './profiles'; // (P5c: the auto-pick's design root)
import { SlangPool, rootOfFile, workspaceRoots, offerSlangExtension } from './slang_pool'; // one connection per design root
import { WaveformAccess, LinkCancelled } from './waveform';
import { missingValue } from './point_value';
import { ProfileChooser } from './profile_chooser';
import { PortValue, isNoValue, noValueText } from '../shared/port_resolve';
import {
  HierarchyPathMapping, MappingRule, HierarchyNode, segments, join, inferDumpRules, inferDesignRule,
  isAssignmentTarget, portConnections, typeWidth,
} from './path_mapping';
import { EnumTypes, EnumType, EnumSignal, aliasJson, tableLabel, memberName, hexLiteral, fitted } from './enums';
import { PackedRange, SlicePart, parsePackedDims, packedWidth, declaredParts, countParts, MAX_SLICES } from './packed_dims';
import { waveformData } from '../data';
import { pageStrings, formatString } from '../page_strings';
import { WaveformDebugSession } from '../dap/session'; // (the debugger's inline values replace ours during a session)

const SV_EXT = /\.(sv|svh|v|vh|svi|svp)$/i;
const SV_GLOB = '**/*.{sv,svh,v,vh,svi,svp}';
const IDENT = /[A-Za-z_][A-Za-z0-9_$]*/;
const ALIAS_LIMIT = 8;
const MAX_INLINE_VALUES = 300;
const MAX_VALUE_LENGTH = 64;
const INFERRED_STATE_KEY = 'vaporview.sourceLink.inferred';
/** user path-mapping rules per design root + dump (cmux WaveformSourceLink.swift:97-100). */
const USER_RULES_STATE_KEY = 'vaporview.sourceLink.userRules';
/** Split > By Declared Dimensions: a click with no answer by then says so; a later answer is ignored (cmux DECLARED_TIMEOUT_MS). */
const DECLARED_TIMEOUT_MS = 5000;
/** Add All Signals in Scope: ask before adding more than this many; add at most MAX_SCOPE_ADDS (cmux host.js). */
const SCOPE_CONFIRM_ABOVE = 48;
const MAX_SCOPE_ADDS = 128;

export function isSvDocument(doc: vscode.TextDocument | undefined): boolean {
  return !!doc && (doc.languageId === 'systemverilog' || doc.languageId === 'verilog' || SV_EXT.test(doc.uri.path));
}

export interface AddResult { added: string[]; messages: string[] }
/** value: the shown text; raw: the bits behind an enum name; reason: why the file has no value ('unreadable' / 'unavailable'). */
/** An inline value. `noValue`: the dump lacks the signal and it can't be resolved through its connection,
 *  or it could not be read: shown dim as "no value", the reason in `reason` (never an x). */
export interface InlineValue { line: number; name: string; value: string; raw?: string; reason?: string; dumpPath: string; noValue?: boolean }
/** A design instance (slang) and the dump scope it is shown as. */
export interface LinkedInstance { designInstance: string; dumpInstance: string; waveformUri: string; module?: string }

type Resolution =
  | { kind: 'found'; paths: string[] }
  | { kind: 'notDumped'; scope: string }
  | { kind: 'instance' }
  | { kind: 'notFound' };

export class SourceLink implements vscode.Disposable {
  readonly slang: Slang;
  /** the connections per design root; `slang` routes each call to the root of the call's document. */
  readonly slangPool: SlangPool;
  private readonly waveRoot = new WeakMap<VaporviewDocument, string>();
  readonly waveform: WaveformAccess;
  readonly profiles: ProfileChooser;
  readonly enums: EnumTypes;
  private disposables: vscode.Disposable[] = [];
  /** Module name -> the instance last added from (inline values follow it). */
  private linkedByModule = new Map<string, LinkedInstance>();
  private history: vscode.Location[] = [];
  private historyIndex = -1;
  private inlineByEditor = new Map<string, InlineValue[]>();
  // one quiet style with the debugger (src/cmux/shared/inline_style.ts).
  private decoration = vscode.window.createTextEditorDecorationType({ after: INLINE_VALUE_STYLE, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
  private noValueDecoration = vscode.window.createTextEditorDecorationType({ after: INLINE_NO_VALUE_STYLE, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshSerial = 0;
  private elaborationAsked = false;
  /** Dump path -> enum table label, per open viewer (a reopened file is a new viewer with no alias tables). */
  private enumRows = new WeakMap<VaporviewDocument, Map<string, string>>();
  private enumScopesSent = new WeakMap<VaporviewDocument, Set<string>>();
  // Dump scopes slang (with a design top) said have no enum signals, for one enums epoch: not asked again per row.
  private enumScopesNone = new WeakMap<VaporviewDocument, { epoch: number; scopes: Set<string> }>();
  private readonly onDidRefreshEmitter = new vscode.EventEmitter<string>();
  /** Fires with an editor's URI after its inline values were recomputed. */
  readonly onDidRefreshInlineValues = this.onDidRefreshEmitter.event;

  constructor(private context: vscode.ExtensionContext, provider: WaveformViewerProvider, private log: vscode.LogOutputChannel | vscode.OutputChannel,
    events: { onDidSetMarker: vscode.Event<any>; onDidAddVariable: vscode.Event<any> }) {
    if (process.env.VAPORVIEW_E2E === '1') { // e2e only: the link's log also goes to the test output
      const out = log; this.log = { appendLine: (s: string) => { out.appendLine(s); console.log('[link] ' + s); } } as vscode.OutputChannel;
    }
    this.slangPool = new SlangPool((s) => this.log.appendLine(s));
    this.slang = this.slangPool.router;
    this.routeByRoot();
    this.waveform = new WaveformAccess(provider);
    this.enums = new EnumTypes(this.slang);
    this.profiles = this.slangPool.within(this.editorRoot() ?? this.slangPool.defaultRoot(), () => new ProfileChooser({
      slang: this.slang, waveform: this.waveform, log: (s) => this.log.appendLine(s), hasSvSources: () => this.hasSvSources(),
      compilationChanged: () => { this.enums.reset(); this.portCache.clear(); this.linkedByModule.clear(); this.scheduleRefresh(0); },
      moduleInstances: (m) => this.moduleInstances(m),
      chosenInstance: (m) => this.linkedByModule.get(m)?.dumpInstance,
      chooseInstance: (m, designInstance, dumpInstance) => {
        const wave = this.waveform.document();
        if (wave) { this.linkedByModule.set(m, { designInstance, dumpInstance, waveformUri: wave.uri.toString(), module: m }); this.scheduleRefresh(0); }
      },
    }));
    this.routeProfiles();
    this.disposables.push(this.profiles);
    const reg = (id: string, fn: (...a: any[]) => any) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    reg('vaporview.sourceLink.addSignal', (a?: any) => this.addSignalCommand(a));
    reg('vaporview.sourceLink.showInSource', (a?: any) => this.showInSourceCommand(a));
    reg('vaporview.sourceLink.navigateBack', () => this.navigate(-1));
    reg('vaporview.sourceLink.navigateForward', () => this.navigate(1));
    reg('vaporview.sourceLink.editPathMapping', (a?: any) => this.editPathMappingCommand(a));
    reg('vaporview.sourceLink.getPathMapping', (a?: any) => this.getPathMappingCommand(a));
    reg('vaporview.sourceLink.setTopLevel', (a?: any) => this.setTopLevelCommand(a));
    reg('vaporview.sourceLink.showEnumNames', (a?: any) => this.showEnumNamesCommand(a));
    reg('vaporview.sourceLink.addScope', (a?: any) => this.addScopeCommand(a));
    reg('vaporview.splitDeclared', (a?: any) => this.splitDeclaredCommand(a));
    reg('vaporview.sourceLink.getInlineValues', (a?: any) => {
      const uri = String(a?.uri ?? vscode.window.activeTextEditor?.document.uri);
      return a?.drawn ? { lines: this.drawnByEditor.get(uri) ?? [], mode: inlineMode(), texts: this.drawnText.get(uri) ?? [] } : this.inlineByEditor.get(uri) ?? [];
    });
    reg('vaporview.sourceLink.status', () => ({ slang: this.slang.mode, slangCounts: { ...this.slang.counts }, slangRoots: this.slangPool.roots(), slangOutside: this.slangPool.outside.slice(), slangCompilations: this.slangPool.compilations(), enumsPending: this.enumsPending, debuggerShowsValues: this.debuggerShowsValues, inlineTimings: this.inlineTimings.slice(), markerEvents: this.markerEvents.slice(), history: this.history.map((l) => ({ uri: l.uri.toString(), line: l.range.start.line })), historyIndex: this.historyIndex }));
    this.disposables.push(
      this.decoration, this.noValueDecoration, this.onDidRefreshEmitter,
      // The marker event can arrive before the viewer's context (markerTime) is updated: refresh again shortly after
      // if the marker time we used differs from the one the context now holds.
      // The event carries the new time (ticks); the viewer's context (markerTime) may only update after it. Use the
      // event's time at once, then re-check against the context in case the marker moved some other way.
      events.onDidSetMarker((e: { uri?: string; time?: number }) => {
        if (e?.uri && typeof e.time === 'number') { this.markerFromEvent.set(e.uri, e.time); }
        this.markerEventAt = performance.now();
        this.markerEvents.push(this.markerEventAt); if (this.markerEvents.length > 128) { this.markerEvents.shift(); }
        this.scheduleRefresh(0);
        setTimeout(() => this.refreshIfMarkerMoved(), 300);
      }),
      events.onDidAddVariable((e) => { this.enumsPending++; void this.enumsForAdded(e).finally(() => { this.enumsPending--; }); }),
      // A waveform debug session shows its own inline values (dap/editor.ts, tied to the stopped cycle): ours hide on that
      // dump's SV editors while it runs and come back when it ends.
      WaveformDebugSession.onStop.event(() => this.scheduleRefresh(0)),
      WaveformDebugSession.onEnd.event(() => this.scheduleRefresh(0)),
      WaveformDebugSession.onState.event(() => { if (!this.debuggerShowsValues) { this.scheduleRefresh(0); } }), // (start: the session's first state)
      vscode.window.onDidChangeTextEditorSelection((e) => { if (isSvDocument(e.textEditor.document) && inlineMode() === 'cursorLine') { this.drawInline(e.textEditor); } }),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.scheduleRefresh(250)),
      vscode.workspace.onDidSaveTextDocument((d) => { if (isSvDocument(d)) { this.enums.reset(); this.portCache.clear(); this.scheduleRefresh(800); } }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('vaporview.sourceLink')) { this.slang.resetConnection(); this.scheduleRefresh(); } }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.slangPool.prune(); this.sourcesChanged(); }),
      vscode.extensions.onDidChange(() => this.slang.resetConnection()),
      vscode.workspace.onDidOpenTextDocument((d) => { if (isSvDocument(d)) { this.slang.resetConnection(); void offerSlangExtension(this.context); } }),
      ((w) => { w.onDidCreate(() => this.sourcesChanged()); return w; })(vscode.workspace.createFileSystemWatcher(SV_GLOB, false, true, true)),
      vscode.languages.registerHoverProvider([{ scheme: 'file', pattern: '**/*.{sv,svh,v,vh,svi,svp}' }, { language: 'systemverilog' }, { language: 'verilog' }],
        { provideHover: (doc, pos) => this.provideHover(doc, pos) }),
    );
  }

  dispose() { this.disposables.forEach((d) => d.dispose()); this.slangPool.dispose(); }

  // #region Design roots
  /** The design root of a waveform: the root of the SV document last linked with it; else the root that holds the
   *  dump file; else the root whose design has the dump's top instances; else the first folder's. */
  async rootOfWave(wave: VaporviewDocument): Promise<string | undefined> {
    const known = this.waveRoot.get(wave);
    if (known) { return known; }
    const roots = workspaceRoots();
    if (roots.length <= 1) { return roots[0]; }
    let root = wave.uri.scheme === 'file' ? roots.find((r) => wave.uri.fsPath.startsWith(r + nodePath.sep)) : undefined;
    if (!root) {
      const tops = new Set(((await this.waveform.scopeChildren(wave, [])) ?? []).map((t) => t.name));
      for (const r of roots) {
        const names = await this.slangPool.within(r, () => this.slang.getScope('')).catch(() => [] as SlangItem[]);
        if (names.some((i) => tops.has(i.name))) { root = r; break; }
      }
    }
    root = root ?? roots[0];
    if (root) { this.waveRoot.set(wave, root); this.log.appendLine(`source link: ${wave.uri.path.split('/').pop()} -> design root ${root}`); }
    return root;
  }
  /** Runs `fn` against `root`'s slang connection, unless a caller already chose a root (the outermost call decides:
   *  an SV editor's root holds for the waveform calls it makes). */
  private inRoot<T>(root: string | undefined, fn: () => Promise<T>): Promise<T> {
    return this.slangPool.inScope() ? fn() : this.slangPool.within(root, fn);
  }
  /** Each entry point runs against the root of its SV document or waveform. */
  private routeByRoot() {
    const self = this as any;
    const svRoot = (u: any) => { const s = typeof u === 'string' ? (SV_EXT.test(u) ? vscode.Uri.parse(u) : undefined) : u?.uri ?? u; return s instanceof vscode.Uri && s.scheme === 'file' ? rootOfFile(s.fsPath) : undefined; };
    const bySv = (name: string, pick: (a: any[]) => any) => { const f = self[name].bind(this); self[name] = (...a: any[]) => this.inRoot(svRoot(pick(a)), () => f(...a)); };
    const byWave = (name: string, pick: (a: any[]) => VaporviewDocument | undefined) => {
      const f = self[name].bind(this);
      self[name] = async (...a: any[]) => { if (this.slangPool.inScope()) { return f(...a); } const w = pick(a); return this.inRoot(w ? await this.rootOfWave(w) : undefined, () => f(...a)); };
    };
    // SV editor side
    bySv('inlineValues', (a) => a[0]);
    bySv('instancesFor', (a) => a[0]);
    bySv('signalsAssignedOnLine', (a) => a[0]);
    bySv('instanceAt', (a) => a[0]);
    bySv('drivers', (a) => a[0]);
    bySv('addSignalCommand', (a) => a[0]?.uri ?? vscode.window.activeTextEditor?.document.uri);
    bySv('addScopeCommand', (a) => a[0]?.uri ?? vscode.window.activeTextEditor?.document.uri);
    bySv('setTopLevelCommand', (a) => (a[0] instanceof vscode.Uri ? a[0] : a[0]?.uri ?? vscode.window.activeTextEditor?.document.uri));
    // waveform side
    byWave('declaration', (a) => a[1]);
    byWave('packedDims', (a) => a[1]);
    byWave('mapping', (a) => a[0]);
    byWave('showInSourceCommand', (a) => this.waveform.document(a[0]?.uri && !SV_EXT.test(String(a[0].uri)) ? String(a[0].uri) : undefined));
    byWave('showEnumNamesCommand', (a) => this.waveform.document(a[0]?.uri));
    byWave('splitDeclaredCommand', (a) => this.waveform.document(a[0]?.uri));
    byWave('enumsForAdded', (a) => this.waveform.document(a[0]?.uri));
    byWave('getPathMappingCommand', (a) => this.waveform.document(a[0]?.uri));
  }
  /** The design root of the active SV editor, else of the active waveform (undefined: the first folder's). */
  private editorRoot(): string | undefined {
    const u = vscode.window.activeTextEditor?.document.uri;
    if (u?.scheme === 'file') { return rootOfFile(u.fsPath); }
    const w = this.waveform?.document();
    return w ? this.waveRoot.get(w) : undefined;
  }
  /** The design root whose profiles match a waveform's top scopes (the auto-pick's root), when the dump does not sit
   *  in a root and no SV editor linked it yet; else rootOfWave. */
  private async autoPickRoot(wave: VaporviewDocument): Promise<string | undefined> {
    const roots = workspaceRoots();
    if (roots.length <= 1 || this.waveRoot.has(wave) || (wave.uri.scheme === 'file' && roots.some((r) => wave.uri.fsPath.startsWith(r + nodePath.sep)))) { return this.rootOfWave(wave); }
    const tops = ((await this.waveform.scopeChildren(wave, [])) ?? []).filter((n) => n.isScope).map((n) => n.name);
    const children: Record<string, string[]> = {};
    for (const t of tops) { children[t] = ((await this.waveform.scopeChildren(wave, [t])) ?? []).filter((n) => n.isScope).map((n) => n.name); }
    const hits = roots.filter((r) => profileMatchingDumpTops(tops, children, listProfiles(r, os.homedir()).profiles));
    if (hits.length === 1) { this.waveRoot.set(wave, hits[0]); return hits[0]; }
    return this.rootOfWave(wave);
  }
  /** (P5c) The profile chooser's entry points (status bar, QuickPick, its commands, auto-pick on waveform open) run
   *  against one design root: the file a command names, else the active editor's root; auto-pick uses the waveform's
   *  root; Undo uses the root it picked in. Its root() (profile listing) follows the routed root. */
  private routeProfiles() {
    const p = this.profiles as any;
    const fileRoot = (a: any) => {
      const f = a instanceof vscode.Uri ? (a.scheme === 'file' ? a.fsPath : undefined) : typeof a === 'string' ? (a.startsWith('file:') ? vscode.Uri.parse(a).fsPath : a) : undefined;
      return f && workspaceRoots().some((r) => f === r || f.startsWith(r + nodePath.sep)) ? rootOfFile(f) : undefined;
    };
    // A command that changes the design returns once the status bar shows it (the chooser redraws it in the background:
    // profileStatus read right after a switch showed the previous profile).
    const CHANGES = new Set(['switchTo', 'useFileAsTop', 'resetTopLevel', 'useAsBuildFile', 'useBuildFileThroughConfig', 'clearBuildFile', 'exploreMode', 'restart', 'undoAutoPick']);
    const wrap = (name: string, rootFor: (a: any[]) => string | undefined | Promise<string | undefined>) => {
      const f = p[name].bind(p);
      p[name] = async (...a: any[]) => {
        const outer = !this.slangPool.inScope();
        const r = outer ? await this.slangPool.within(await rootFor(a) ?? this.editorRoot(), () => f(...a)) : await f(...a);
        if (outer && CHANGES.has(name)) { await p.update(true); }
        return r;
      };
    };
    const rootOf = p.root.bind(p);
    p.root = (uri?: vscode.Uri) => uri ? rootOf(uri) : (this.slangPool.inScope() ?? rootOf());
    for (const n of ['choose', 'resetTopLevel', 'clearBuildFile', 'showValuesFor', 'exploreMode', 'editProfiles', 'restart']) { wrap(n, () => undefined); }
    wrap('switchTo', (a) => fileRoot(a[0]));
    wrap('useFileAsTop', (a) => fileRoot(a[0] ?? vscode.window.activeTextEditor?.document.uri));
    wrap('useAsBuildFile', (a) => fileRoot(a[0]));
    wrap('useBuildFileThroughConfig', (a) => fileRoot(a[0]));
    let picked: string | undefined;
    wrap('undoAutoPick', () => picked);
    const autoPickFor = p.autoPickFor.bind(p);
    p.autoPickFor = async (doc: VaporviewDocument) => {
      const root = await this.autoPickRoot(doc);
      const ok = await this.slangPool.within(root, () => autoPickFor(doc));
      if (ok) { picked = root; }
      return ok;
    };
    // The status bar shows the active editor's root (whatever root the caller ran in); its tops are read again when
    // that root changes.
    const update = p.update.bind(p);
    let shown: string | undefined;
    p.update = (readTops = false) => {
      const root = this.editorRoot() ?? this.slangPool.defaultRoot();
      const again = readTops || root !== shown || this.slangPool.inScope() !== undefined && this.slangPool.inScope() !== root;
      shown = root;
      return this.slangPool.within(root, () => update(again));
    };
    const setContextKey = p.setContextKey.bind(p);
    p.setContextKey = () => this.slangPool.within(this.editorRoot() ?? this.slangPool.defaultRoot(), () => setContextKey());
    const status = p.status.bind(p);
    p.status = () => this.slangPool.inScope() ? status() : this.slangPool.within(this.editorRoot(), () => status());
  }
  // #region The design for Trace : Trace uses the design slang already has, in the waveform's root.
  /** slang arguments for the design the waveform's root compiles, run from `root`; undefined when nothing is chosen.
   *  Order: the root's chosen build file (profile, Use as Build File, auto-pick); else its .slang server.json build
   *  (what slang-server compiles when nothing is chosen); else the design slang-server has (Set Top Level, the link's
   *  elaboration, the slang extension's choice): each module's and package's declaration file, with --top. */
  async designForTrace(wave: VaporviewDocument, opts?: { waitMs?: number }): Promise<{ args: string[]; root: string; source: string; rebuilt?: boolean } | undefined> {
    // (badArgs: a profile auto-pick or switch still running would hand Trace the design slang-server holds
    // mid-switch; the waveform's root is the auto-pick's (a dump outside every root finds its root by its tops).)
    await this.profiles.settled(opts?.waitMs ?? 30000); // (quiet callers pass a short wait: a QuickPick open keeps the chooser busy)
    const root = await this.autoPickRoot(wave);
    return this.slangPool.within(root, async () => {
      const base = root ?? (wave.uri.scheme === 'file' ? nodePath.dirname(wave.uri.fsPath) : '');
      let c = this.slang.compilation;
      if (c.target?.kind === 'buildFile') { return { args: ['-f', c.target.path], root: base, source: `profile ${c.target.path}` }; }
      if (c.target?.kind !== 'topLevel' && !c.explore && base) {
        for (const rel of ['.slang/local/server.json', '.slang/server.json']) {
          const file = nodePath.join(base, rel);
          try {
            const o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
            if (typeof o.build === 'string' && o.build.trim()) {
              const b = o.build.trim();
              return { args: [o.buildRelativePaths ? '-F' : '-f', nodePath.isAbsolute(b) ? b : nodePath.join(base, b)], root: base, source: `${rel} build` };
            }
          } catch { /* none */ }
        }
      }
      let items = await this.slang.getScope('').catch(() => [] as SlangItem[]);
      // Nothing elaborated yet and vaporview.sourceLink.elaborate "always": elaborate the dump's top as a link action
      // would (a Trace before any link action found no top: noDesign). "ask" keeps Trace's own offer; "never" none.
      if (!items.some((i) => i.kind !== 'Package') && vscode.workspace.getConfiguration('vaporview.sourceLink').get<string>('elaborate', 'ask') === 'always'
        && await this.elaborate(wave)) {
        c = this.slang.compilation;
        items = await this.slang.getScope('').catch(() => [] as SlangItem[]);
      }
      const tops = items.filter((i) => i.kind !== 'Package').map((i) => i.name);
      if (!tops.length) { return undefined; }
      const files: string[] = [];
      // (once per file: slang names a symlinked source by its real path, the link's top level may name the link)
      const real = (f: string) => { try { return fs.realpathSync(f); } catch { return f; } };
      const add = (u?: vscode.Uri) => { if (u?.scheme === 'file') { const f = real(u.fsPath); if (!files.includes(f)) { files.push(f); } } };
      for (const i of items) { if (i.kind === 'Package') { add(i.location?.uri); } } // (packages first: modules import them)
      for (const m of await this.slang.scopesByModule().catch(() => [])) { add(m.declLoc?.uri); }
      if (c.target?.kind === 'topLevel') { add(vscode.Uri.file(c.target.path)); }
      if (!files.length) { return undefined; }
      const dirs = [...new Set(files.map((f) => nodePath.dirname(f)))];
      return { args: [...dirs.flatMap((d) => ['-I', d]), ...files, ...tops.flatMap((t) => ['--top', t])], root: base, source: c.target?.kind === 'topLevel' ? `top level ${c.target.path}` : 'the design slang-server has', rebuilt: true };
    });
  }
  /** The module to offer as top level for a waveform with no design: the first dump top (or the scope just below it)
   *  that a file of its root declares. */
  async topLevelCandidate(wave: VaporviewDocument): Promise<{ module: string; file: string } | undefined> {
    const root = await this.rootOfWave(wave);
    return this.slangPool.within(root, async () => {
      for (const top of (await this.waveform.scopeChildren(wave, [])) ?? []) {
        if (!top.isScope) { continue; }
        const f = await this.slang.filesContainingModule(top.name).catch(() => []);
        if (f[0]) { return { module: top.name, file: f[0] }; }
        for (const child of (await this.waveform.scopeChildren(wave, [top.name])) ?? []) {
          if (!child.isScope) { continue; }
          const g = await this.slang.filesContainingModule(child.name).catch(() => []);
          if (g[0]) { return { module: child.name, file: g[0] }; }
        }
      }
      return undefined;
    });
  }
  /** (P5c) Remember the design root a waveform was linked from (an SV editor's root wins over the guess). */
  private noteWaveRoot(wave: VaporviewDocument) {
    const r = this.slangPool.inScope();
    if (r && this.waveRoot.get(wave) !== r) { this.waveRoot.set(wave, r); }
  }
  /** (P5c) The key user rules are kept under: design root | dump file | dump tops. */
  private async userRulesKey(wave: VaporviewDocument): Promise<string | undefined> {
    const key = await this.waveform.dumpKey(wave);
    return key ? (this.slangPool.inScope() ?? await this.rootOfWave(wave) ?? '') + '|' + key : undefined;
  }

  private say(message: string, warn = false) {
    this.log.appendLine('source link: ' + message);
    if (warn) { void vscode.window.showWarningMessage(message); } else { void vscode.window.showInformationMessage(message); }
  }

  // #region Mapping store
  /** User rules (setting vaporview.sourceLink.pathMapping, "design = dump" each) + inferred rules for this dump. */
  async mapping(doc: VaporviewDocument): Promise<HierarchyPathMapping> {
    this.noteWaveRoot(doc);
    const ukey = await this.userRulesKey(doc);
    const kept = ukey ? this.context.workspaceState.get<Record<string, string[]>>(USER_RULES_STATE_KEY, {})[ukey] : undefined;
    const lines = kept ?? vscode.workspace.getConfiguration('vaporview.sourceLink').get<string[]>('pathMapping', []) ?? [];
    const user = HierarchyPathMapping.parse(lines.join('\n'))?.rules.map((r) => ({ ...r, isInferred: false })) ?? [];
    const mapping = new HierarchyPathMapping(user);
    const key = await this.waveform.dumpKey(doc);
    const inferred = key ? (this.context.workspaceState.get<Record<string, MappingRule[]>>(INFERRED_STATE_KEY, {})[key] ?? []) : [];
    for (const r of inferred) { mapping.addInferredRule(r.designPrefix, r.dumpPrefix); }
    return mapping;
  }

  private async addInferredRules(doc: VaporviewDocument, rules: MappingRule[]) {
    const key = await this.waveform.dumpKey(doc);
    if (!key) { return; }
    const all = { ...this.context.workspaceState.get<Record<string, MappingRule[]>>(INFERRED_STATE_KEY, {}) };
    const m = new HierarchyPathMapping((all[key] ?? []).map((r) => ({ ...r })));
    for (const r of rules) { m.addInferredRule(r.designPrefix, r.dumpPrefix); }
    all[key] = m.rules;
    await this.context.workspaceState.update(INFERRED_STATE_KEY, all);
    for (const r of rules) { this.log.appendLine(`source link: inferred path mapping ${r.designPrefix} = ${r.dumpPrefix}`); }
  }

  private children(doc: VaporviewDocument) { return (p: string[]) => this.waveform.scopeChildren(doc, p); }

  // #region Design
  /** Non-package tops of the elaborated design (empty in explore mode). */
  private async designTops(): Promise<SlangItem[]> {
    return (await this.slang.getScope('').catch(() => [])).filter((i) => i.kind !== 'Package');
  }

  /** slang answers design queries only with a top level: offer the module the waveform's top scope (or a scope just
   *  below a simulator wrapper) is named after. True when it set one. */
  private async elaborate(doc: VaporviewDocument): Promise<boolean> {
    // A profile auto-pick for a just-opened waveform comes first (it may give the design a top).
    if (this.profiles.autoPickPending) { await this.profiles.autoPickPending; }
    if ((await this.designTops()).length) { return false; }
    const policy = vscode.workspace.getConfiguration('vaporview.sourceLink').get<string>('elaborate', 'ask');
    if (policy === 'never') { return false; }
    let candidate: { module: string; file: string } | undefined;
    search: for (const top of (await this.waveform.scopeChildren(doc, [])) ?? []) {
      if (!top.isScope) { continue; }
      const files = await this.slang.filesContainingModule(top.name).catch(() => []);
      if (files[0]) { candidate = { module: top.name, file: files[0] }; break; }
      for (const child of (await this.waveform.scopeChildren(doc, [top.name])) ?? []) {
        if (!child.isScope) { continue; }
        const f = await this.slang.filesContainingModule(child.name).catch(() => []);
        if (f[0]) { candidate = { module: child.name, file: f[0] }; break search; }
      }
    }
    if (!candidate) { return false; }
    if (policy === 'ask') {
      if (this.elaborationAsked) { return false; }
      this.elaborationAsked = true;
      const yes = 'Elaborate';
      const pick = await vscode.window.showInformationMessage(
        `slang-server has no top level for this folder, so it can't place signals in the design. Elaborate it with ${candidate.module} (the waveform's top) as the top level?`,
        { modal: true }, yes);
      if (pick !== yes) { return false; }
    }
    try { await this.slang.setTopLevel(candidate.file); } catch (e) { this.log.appendLine(`source link: setTopLevel failed: ${e}`); return false; }
    this.enums.reset();
    void this.profiles.update(true);
    this.log.appendLine(`source link: set slang top level to ${candidate.module} (${candidate.file})`);
    return (await this.designTops()).length > 0;
  }

  /** Design paths of the identifier at `pos` (one per instance of its module); port names of a named connection
   *  `.port (sig)` are the child instance's port. */
  private async designPaths(docText: string, uri: vscode.Uri, pos: vscode.Position, word: string): Promise<string[]> {
    const conn = portConnectionAt(docText, offsetAt(docText, pos));
    if (conn) {
      const instPaths = await this.slang.getInstances(uri, positionAt(docText, conn.instanceOffset));
      const out: string[] = [];
      for (const inst of instPaths.slice(0, 64)) {
        if ((await this.slang.getScope(inst).catch(() => [])).some((c) => c.name === conn.port)) { out.push(inst + '.' + conn.port); }
      }
      if (out.length) { return out; }
    }
    const paths = await this.slang.getInstances(uri, pos);
    return paths.filter((p) => segments(p).pop() === word || paths.length === 1);
  }

  private async resolveDumpPaths(designPath: string, doc: VaporviewDocument, progress?: (s: string) => void): Promise<Resolution> {
    const mapping = await this.mapping(doc);
    const mapped = mapping.dumpPaths(designPath);
    const present: string[] = [];
    for (const p of mapped) { if (await this.waveform.hasSignal(doc, segments(p))) { present.push(p); } }
    if (present.length) { return { kind: 'found', paths: present }; }
    const ds = segments(designPath);
    const root = ds[0]; const name = ds[ds.length - 1];
    if (!root || !name) { return { kind: 'notFound' }; }
    const parentItems = await this.slang.getScope(join(ds.slice(0, -1))).catch(() => []);
    if (parentItems.find((i) => i.name === name)?.isScope) { return { kind: 'instance' }; }
    for (const p of mapped) {
      const parent = segments(p).slice(0, -1);
      if (parent.length && await this.waveform.scopeChildren(doc, parent)) { return { kind: 'notDumped', scope: join(parent) }; }
    }
    const rootChildren: HierarchyNode[] = (await this.slang.getScope(root).catch(() => [])).map((i) => ({ name: i.name, isScope: i.isScope }));
    if (!rootChildren.length) { return { kind: 'notFound' }; }
    progress?.('Looking for the design in the waveform…');
    const isFsdb = doc.uri.path.toLowerCase().endsWith('.fsdb');
    const result = await inferDumpRules(designPath, rootChildren, this.children(doc), 4, isFsdb ? 100 : 400);
    const rest = ds.slice(1);
    if (result.kind === 'found') {
      await this.addInferredRules(doc, result.rules);
      return { kind: 'found', paths: result.rules.map((r) => join([...segments(r.dumpPrefix), ...rest])) };
    }
    if (result.kind === 'notDumped') { return { kind: 'notDumped', scope: join([...segments(result.rule.dumpPrefix), ...rest.slice(0, -1)]) }; }
    return { kind: 'notFound' };
  }

  // #region Port aliases (undumped signals)
  private async instanceText(item: SlangItem, cache: Map<string, string>): Promise<string | undefined> {
    const loc = item.location;
    if (!loc) { return undefined; }
    const key = loc.uri.toString();
    let text = cache.get(key);
    if (text === undefined) {
      try { text = (await vscode.workspace.openTextDocument(loc.uri)).getText(); } catch { return undefined; }
      cache.set(key, text);
    }
    const lines = text.split('\n');
    // The instantiation runs from the instance name to the `;` that ends it.
    const start = offsetAtLines(lines, loc.range.start.line, loc.range.start.character);
    const end = text.indexOf(';', offsetAtLines(lines, loc.range.end.line, loc.range.end.character) - 1);
    return text.slice(start, end < 0 ? text.length : end + 1);
  }

  /** Other names of the net at `path` a simulator may have dumped instead: child instance ports it connects to, and
   *  what its instance's instantiation connects it to when it is a port. Plain whole-net connections of the same
   *  declared width only. */
  async portAliases(path: string): Promise<string[]> {
    const segs = segments(path);
    const name = segs[segs.length - 1];
    const parent = join(segs.slice(0, -1));
    if (!parent || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) { return []; }
    const scope = await this.slang.getScope(parent).catch(() => []);
    const item = scope.find((i) => i.name === name && !i.isScope);
    const width = typeWidth(item?.type);
    if (!item || width === undefined) { return []; }
    const texts = new Map<string, string>();
    const aliases: string[] = [];
    for (const child of scope.filter((c) => c.kind === 'Instance')) {
      const text = await this.instanceText(child, texts);
      if (!text) { continue; }
      const childPath = parent + '.' + child.name;
      const childScope = await this.slang.getScope(childPath).catch(() => []);
      for (const c of portConnections(text).filter((c) => c.signal === name)) {
        const port = childScope.find((p) => p.name === c.port && p.kind === 'Port');
        if (port && typeWidth(port.type) === width) { aliases.push(childPath + '.' + c.port); }
      }
    }
    const gsegs = segs.slice(0, -2);
    const instanceName = segs[segs.length - 2];
    if (item.kind === 'Port' && gsegs.length) {
      const grandparent = join(gsegs);
      const siblings = await this.slang.getScope(grandparent).catch(() => []);
      const instance = siblings.find((s) => s.name === instanceName && s.kind === 'Instance');
      const text = instance ? await this.instanceText(instance, texts) : undefined;
      for (const c of text ? portConnections(text) : []) {
        if (c.port !== name || !c.signal) { continue; }
        const decl = siblings.find((s) => s.name === c.signal && !s.isScope);
        if (decl && typeWidth(decl.type) === width) { aliases.push(grandparent + '.' + c.signal); }
      }
    }
    return [...new Set(aliases)].filter((a) => a !== path);
  }

  // #region Editor -> waveform
  private async addSignalCommand(arg?: { uri?: string; line?: number; character?: number; waveformUri?: string }): Promise<AddResult> {
    const result: AddResult = { added: [], messages: [] };
    try {
      await this.addSignal(arg, result);
    } catch (e) {
      result.messages.push(e instanceof SlangUnavailable ? e.message : `The language server did not answer: ${e}`);
    }
    for (const m of result.messages) { this.say(m, result.added.length === 0); }
    return result;
  }

  private async editorTarget(arg?: { uri?: string; line?: number; character?: number }): Promise<{ doc: vscode.TextDocument; pos: vscode.Position } | undefined> {
    if (arg?.uri) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
      return { doc, pos: new vscode.Position(arg.line ?? 0, arg.character ?? 0) };
    }
    const ed = vscode.window.activeTextEditor;
    return ed ? { doc: ed.document, pos: ed.selection.active } : undefined;
  }

  private async addSignal(arg: { uri?: string; line?: number; character?: number; waveformUri?: string } | undefined, result: AddResult) {
    const target = await this.editorTarget(arg);
    if (!target || !isSvDocument(target.doc)) { result.messages.push('Place the cursor on a signal in a SystemVerilog file first.'); return; }
    const wave = this.waveform.document(arg?.waveformUri);
    if (!wave) { result.messages.push('Open a waveform (VCD, FST, GHW or FSDB) first.'); return; }
    const range = target.doc.getWordRangeAtPosition(target.pos, IDENT);
    if (!range) { result.messages.push('Place the cursor on a signal name.'); return; }
    const word = target.doc.getText(range);
    if (target.doc.isDirty) { await target.doc.save(); }
    const text = target.doc.getText();
    let paths = await this.designPaths(text, target.doc.uri, range.start, word);
    if (!paths.length && await this.elaborate(wave)) { paths = await this.designPaths(text, target.doc.uri, range.start, word); }
    if (!paths.length) {
      result.messages.push((await this.designTops()).length
        ? `slang-server found no ${word} in the elaborated design. Its module may not be instantiated under the current top level.`
        : 'slang-server could not place this signal in the design. Set a top level (Waveform: Set SystemVerilog Top Level) or a build file.');
      return;
    }
    let chosen = paths;
    if (paths.length > 1 && !arg?.uri) {
      const picks = await vscode.window.showQuickPick(paths, { canPickMany: true, placeHolder: `${word} is in several instances: choose which to add` });
      chosen = picks ?? [];
    }
    const missing: string[] = []; const notDumped: string[] = []; const instances: string[] = [];
    for (const designPath of chosen) {
      let linkedPath = designPath;
      let res = await this.resolveDumpPaths(designPath, wave);
      if (res.kind === 'notDumped') {
        const scope = res.scope;
        const alias = await this.dumpedAlias(designPath, wave);
        if (alias) {
          res = { kind: 'found', paths: alias.dumpPaths };
          linkedPath = alias.path;
          result.messages.push(`${designPath} isn't dumped; showing ${alias.path}, the same net through a port connection.`);
        } else {
          notDumped.push(`${designPath} (the waveform has ${scope} without it)`);
          continue;
        }
      }
      if (res.kind === 'instance') { instances.push(designPath); continue; }
      if (res.kind === 'notFound') { missing.push(designPath); continue; }
      let dumpPaths = res.paths;
      if (dumpPaths.length > 1 && chosen.length === 1 && !arg?.uri) {
        dumpPaths = (await vscode.window.showQuickPick(dumpPaths, { canPickMany: true, placeHolder: 'The design is dumped several times: choose which' })) ?? [];
      }
      for (const dumpPath of dumpPaths) {
        if (!await this.waveform.addSignal(wave, dumpPath)) { missing.push(designPath); continue; }
        result.added.push(dumpPath);
        this.recordLinkedInstance(join(segments(linkedPath).slice(0, -1)), join(segments(dumpPath).slice(0, -1)), wave);
      }
    }
    if (instances.length) { result.messages.push(`${instances.join(', ')} is an instance. Only signals can be added to the waveform.`); }
    if (notDumped.length) { result.messages.push(`Not dumped: ${notDumped.join(', ')}. Check the simulator's dump depth or whether it optimized the signal away.`); }
    if (missing.length) { result.messages.push(`${missing.join(', ')} is not in this waveform. If the dump names the design differently, edit Waveform Path Mapping…`); }
    this.scheduleRefresh(0);
  }

  // #region Add All Signals in Scope (editor)
  /** Adds the signals of the instance at the cursor (an instance name), or of the instance the signal at the cursor
   *  is in, that are not shown yet: at most MAX_SCOPE_ADDS, asking first above SCOPE_CONFIRM_ABOVE (cmux
   *  WaveformSourceLink.addScope). Child scopes are left out. With `uri` (a programmatic call) nothing is asked:
   *  `confirm: true` stands for the user's Add, anything else for Cancel, and `asked` lists what was asked. */
  private async addScopeCommand(arg?: { uri?: string; line?: number; character?: number; waveformUri?: string; confirm?: boolean }) {
    const result: AddResult & { scopes: { dumpScope: string; added: number; total: number }[]; asked: { dumpScope: string; count: number }[] } =
      { added: [], messages: [], scopes: [], asked: [] };
    try {
      await this.addScope(arg, result);
    } catch (e) {
      result.messages.push(e instanceof SlangUnavailable ? e.message : `The language server did not answer: ${e}`);
    }
    for (const m of result.messages) { this.say(m, result.added.length === 0); }
    return result;
  }

  private async addScope(arg: { uri?: string; line?: number; character?: number; waveformUri?: string; confirm?: boolean } | undefined,
    result: AddResult & { scopes: { dumpScope: string; added: number; total: number }[]; asked: { dumpScope: string; count: number }[] }) {
    const target = await this.editorTarget(arg);
    if (!target || !isSvDocument(target.doc)) { result.messages.push('Place the cursor on a signal or instance in a SystemVerilog file first.'); return; }
    const wave = this.waveform.document(arg?.waveformUri);
    if (!wave) { result.messages.push('Open a waveform (VCD, FST, GHW or FSDB) first.'); return; }
    const range = target.doc.getWordRangeAtPosition(target.pos, IDENT);
    if (!range) { result.messages.push('Place the cursor on a signal or instance name.'); return; }
    const word = target.doc.getText(range);
    if (target.doc.isDirty) { await target.doc.save(); }
    const text = target.doc.getText();
    let paths = await this.designPaths(text, target.doc.uri, range.start, word);
    if (!paths.length && await this.elaborate(wave)) { paths = await this.designPaths(text, target.doc.uri, range.start, word); }
    if (!paths.length) {
      result.messages.push((await this.designTops()).length
        ? `slang-server found no ${word} in the elaborated design. Its module may not be instantiated under the current top level.`
        : 'slang-server could not place this signal in the design. Set a top level (Waveform: Set SystemVerilog Top Level) or a build file.');
      return;
    }
    let chosen = paths;
    if (paths.length > 1 && !arg?.uri) {
      chosen = (await vscode.window.showQuickPick(paths, { canPickMany: true, placeHolder: `${word} is in several instances: choose which to add` })) ?? [];
    }
    const missing: string[] = []; const truncated: string[] = [];
    for (const designPath of chosen) {
      const segs = segments(designPath);
      const parent = join(segs.slice(0, -1));
      const parentItems = await this.slang.getScope(parent).catch(() => [] as SlangItem[]);
      const scope = parentItems.find((i) => i.name === segs[segs.length - 1])?.isScope ? designPath : parent;
      if (!scope) { missing.push(designPath); continue; }
      // The dump scope is found through one of its signals, like Add to Waveform.
      const probe = (await this.slang.getScope(scope).catch(() => [] as SlangItem[])).find((i) => !i.isScope);
      if (!probe) { missing.push(scope); continue; }
      const res = await this.resolveDumpPaths(scope + '.' + probe.name, wave);
      let dumpScopes: string[];
      if (res.kind === 'found') { dumpScopes = res.paths.map((p) => join(segments(p).slice(0, -1))); }
      else if (res.kind === 'notDumped') { dumpScopes = [res.scope]; }
      else { missing.push(scope); continue; }
      if (dumpScopes.length > 1 && chosen.length === 1 && !arg?.uri) {
        dumpScopes = (await vscode.window.showQuickPick(dumpScopes, { canPickMany: true, placeHolder: 'The design is dumped several times: choose which' })) ?? [];
      }
      for (const dumpScope of dumpScopes) {
        const ids = await this.waveform.scopeVariables(wave, segments(dumpScope));
        if (!ids) { missing.push(scope); continue; }
        const all = this.waveform.notShown(wave, ids);
        const vars = all.slice(0, MAX_SCOPE_ADDS);
        if (vars.length > SCOPE_CONFIRM_ABOVE) {
          let add: boolean;
          if (arg?.uri) {
            result.asked.push({ dumpScope, count: vars.length });
            add = arg.confirm === true;
          } else {
            add = (await vscode.window.showWarningMessage('Add All Signals in Scope?',
              { modal: true, detail: `This adds ${vars.length.toLocaleString()} signals of ${dumpScope} to the waveform.` }, 'Add')) === 'Add';
          }
          if (!add) { continue; }
        }
        if (vars.length) { await this.waveform.addNetlistIds(wave, vars); }
        result.scopes.push({ dumpScope, added: vars.length, total: all.length });
        vars.forEach((id) => { const p = this.waveform.pathOfNetlistId(wave, id); if (p) { result.added.push(p); } });
        if (vars.length < all.length) {
          truncated.push(`Added ${vars.length.toLocaleString()} of the ${all.length.toLocaleString()} signals in ${dumpScope} not shown yet. Choose Add All Signals in Scope again for the next ones.`);
        }
        this.recordLinkedInstance(scope, dumpScope, wave);
      }
    }
    result.messages.push(...truncated);
    if (missing.length) { result.messages.push(`${missing.join(', ')} is not in this waveform. If the dump names the design differently, edit Waveform Path Mapping…`); }
    this.scheduleRefresh(0);
  }

  // #region Split > By Declared Dimensions
  /** The packed dimensions slang-server declares for dump signal `dumpPath` (two or more), else undefined. */
  async packedDims(dumpPath: string, wave: VaporviewDocument): Promise<PackedRange[] | undefined> {
    const segs = segments(dumpPath);
    if (segs.length < 2) { return undefined; }
    const designScope = (await this.mapping(wave)).designPath(join(segs.slice(0, -1)));
    const items = await this.slang.getScope(designScope);
    const item = items.find((i) => i.name === segs[segs.length - 1] && (i.kind === 'Logic' || i.kind === 'Port' || i.kind === 'Net'));
    return parsePackedDims(item?.type);
  }

  /** Split > By Declared Dimensions on a row (its webview context): the row splits by its outer dimension, each
   *  element by the next, down to the last (its bits), in one step (cmux cmux-commands.js splitDeclared). An answer
   *  later than DECLARED_TIMEOUT_MS is ignored; a reload meanwhile drops the click quietly. Returns the parts sent. */
  private async splitDeclaredCommand(e?: { rowId?: number; netlistId?: number; width?: number; cmuxSliceName?: string; signalName?: string; uri?: string }) {
    const S = pageStrings(this.context.extensionPath);
    if (!e || e.rowId === undefined || !((e.width ?? 0) > 1) || typeof e.netlistId !== 'number') { return undefined; }
    const wave = this.waveform.document(e.uri);
    if (!wave) { return undefined; }
    const path = this.waveform.pathOfNetlistId(wave, e.netlistId);
    if (!path) { this.say(S.messageNoDeclaredDimensions, true); return undefined; }
    const data = waveformData(wave);
    const generation = data.generation;
    let timer: NodeJS.Timeout | undefined;
    let answer: { dims?: PackedRange[] } | 'timeout';
    try {
      answer = await Promise.race([
        this.packedDims(path, wave).then((dims) => ({ dims })),
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), DECLARED_TIMEOUT_MS); }),
      ]);
    } catch (err) {
      if (data.generation === generation) { this.say(err instanceof SlangUnavailable ? err.message : S.messageDeclaredNoAnswer, true); }
      return undefined;
    } finally {
      if (timer) { clearTimeout(timer); }
    }
    if (data.generation !== generation) { return undefined; }
    if (answer === 'timeout') { this.say(S.messageDeclaredNoAnswer, true); return undefined; }
    const dims = answer.dims;
    if (!dims) { this.say(S.messageNoDeclaredDimensions, true); return undefined; }
    const name = e.cmuxSliceName || e.signalName || '';
    if (packedWidth(dims) !== e.width) { this.say(formatString(S.messageDeclaredWidth, name), true); return undefined; }
    const parts: SlicePart[] = declaredParts(dims, name);
    if (countParts(parts) > MAX_SLICES) { this.say(S.messageTooManySlices, true); return undefined; }
    this.waveform.postMessage(wave, { command: 'cmux-add-slices', rowId: e.rowId, parts });
    return parts;
  }

  private async dumpedAlias(designPath: string, doc: VaporviewDocument): Promise<{ path: string; dumpPaths: string[] } | undefined> {
    const aliases = await this.portAliases(designPath).catch(() => []);
    for (const alias of aliases.slice(0, ALIAS_LIMIT)) {
      const r = await this.resolveDumpPaths(alias, doc);
      if (r.kind === 'found' && r.paths.length) { return { path: alias, dumpPaths: r.paths }; }
    }
    return undefined;
  }

  private recordLinkedInstance(designInstance: string, dumpInstance: string, wave: VaporviewDocument) {
    if (!designInstance || !dumpInstance) { return; }
    void this.slang.getScope(join(segments(designInstance).slice(0, -1))).then((items) => {
      const inst = items.find((i) => i.name === segments(designInstance).pop());
      const module = inst?.declName ?? designInstance;
      this.linkedByModule.set(module, { designInstance, dumpInstance, waveformUri: wave.uri.toString(), module });
      this.scheduleRefresh(0);
    }).catch(() => undefined);
  }

  // #region Waveform -> editor
  private async showInSourceCommand(arg?: any): Promise<{ uri: string; line: number; character: number; drivers: number } | undefined> {
    const wave = this.waveform.document(arg?.uri && !SV_EXT.test(String(arg.uri)) ? String(arg.uri) : undefined);
    if (!wave) { this.say('Open a waveform first.', true); return undefined; }
    let dumpPath: string | undefined = arg?.instancePath;
    if (!dumpPath && typeof arg?.netlistId === 'number') { dumpPath = this.waveform.pathOfNetlistId(wave, arg.netlistId); }
    if (!dumpPath && arg?.scopePath !== undefined && arg?.signalName) { dumpPath = (arg.scopePath ? arg.scopePath + '.' : '') + arg.signalName; }
    if (!dumpPath) { dumpPath = this.waveform.selectedSignalPath(wave); }
    if (!dumpPath) { this.say('Select a signal in the waveform first.', true); return undefined; }
    try {
      const decl = await this.declaration(dumpPath, wave);
      if (!decl) {
        this.say(`${dumpPath} was not found in the design slang-server compiled. If the dump names the design differently, edit Waveform Path Mapping…`, true);
        return undefined;
      }
      const drivers = await this.drivers(decl);
      const target = drivers.length === 1 ? drivers[0] : decl;
      await this.goTo(target, true);
      if (drivers.length > 1) {
        await vscode.commands.executeCommand('editor.action.peekLocations', decl.uri, decl.range.start, [decl, ...drivers], 'peek');
      } else if (drivers.length === 0) {
        vscode.window.setStatusBarMessage('No assignment to this signal in this file, so this is its declaration.', 5000);
      }
      return { uri: target.uri.toString(), line: target.range.start.line, character: target.range.start.character, drivers: drivers.length };
    } catch (e) {
      this.say(e instanceof SlangUnavailable ? e.message : `The language server did not answer: ${e}`, true);
      return undefined;
    }
  }

  /** Where dump signal `dumpPath` is declared (mapping, then elaborating, then a design rule inferred from the trees). */
  async declaration(dumpPath: string, wave: VaporviewDocument, mayElaborate = true): Promise<vscode.Location | undefined> {
    const mapping = await this.mapping(wave);
    const direct = await this.locationOf(mapping.designPath(dumpPath));
    if (direct) { return direct; }
    let roots = await this.designTops();
    if (!roots.length && mayElaborate && await this.elaborate(wave)) {
      roots = await this.designTops();
      const again = await this.locationOf(mapping.designPath(dumpPath));
      if (again) { return again; }
    }
    const designRoots = new Map<string, HierarchyNode[]>();
    for (const r of roots.filter((r) => r.isScope)) {
      designRoots.set(r.name, (await this.slang.getScope(r.name).catch(() => [])).map((i) => ({ name: i.name, isScope: i.isScope })));
    }
    const rule = await inferDesignRule(dumpPath, designRoots, this.children(wave));
    if (!rule) { return undefined; }
    const lookup = mapping.clone();
    lookup.addInferredRule(rule.designPrefix, rule.dumpPrefix);
    return this.locationOf(lookup.designPath(dumpPath));
  }

  /** The declaration of the item at `designPath`, from its parent scope's listing (`data[3]` falls back to `data`). */
  private async locationOf(designPath: string): Promise<vscode.Location | undefined> {
    const segs = segments(designPath);
    let name = segs[segs.length - 1];
    if (!name) { return undefined; }
    const items = await this.slang.getScope(join(segs.slice(0, -1))).catch(() => [] as SlangItem[]);
    let item = items.find((i) => i.name === name);
    if (!item && !name.startsWith('\\') && /\[[^\]]*\]$/.test(name)) { name = name.replace(/\[[^\]]*\]$/, ''); item = items.find((i) => i.name === name); }
    const loc = item?.location;
    if (!loc) { return undefined; }
    const r = loc.range;
    if (r.start.line === r.end.line) { return new vscode.Location(loc.uri, new vscode.Range(r.start, r.start.translate(0, Math.min(r.end.character - r.start.character, name.length)))); }
    return loc;
  }

  /** Assignments to the declared signal in its declaration's file (port connections and other files: not traced). */
  async drivers(decl: vscode.Location): Promise<vscode.Location[]> {
    const refs = await this.slang.references(decl.uri, { line: decl.range.start.line, character: decl.range.start.character });
    // One per place: a file reached by two paths (a symlink and its target) must not count its driver twice.
    const seen = new Set<string>();
    const same = refs.filter((r) => sameFile(vscode.Uri.parse(r.uri), decl.uri) && r.range.start.line === r.range.end.line
      && !seen.has(`${r.range.start.line}:${r.range.start.character}`) && !!seen.add(`${r.range.start.line}:${r.range.start.character}`));
    if (!same.length) { return []; }
    const text = (await vscode.workspace.openTextDocument(decl.uri)).getText().split('\n');
    return same.filter((r) => isAssignmentTarget(text[r.range.start.line] ?? '', r.range.start.character, r.range.end.character - r.range.start.character))
      .map((r: LspLocation) => toLocation(r));
  }

  private async goTo(loc: vscode.Location, record: boolean) {
    if (record) {
      const ed = vscode.window.activeTextEditor;
      // The place we leave, unless it is where history already stands.
      if (ed && isSvDocument(ed.document) && this.historyIndex < 0) { this.pushHistory(new vscode.Location(ed.document.uri, ed.selection)); }
      this.pushHistory(loc);
    }
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === loc.uri.toString());
    const column = visible?.viewColumn ?? (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.Beside);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: column ?? vscode.ViewColumn.Beside, selection: loc.range, preserveFocus: false });
    ed.revealRange(loc.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private pushHistory(loc: vscode.Location) {
    this.history = this.history.slice(0, this.historyIndex + 1);
    const last = this.history[this.history.length - 1];
    if (last && last.uri.toString() === loc.uri.toString() && last.range.start.line === loc.range.start.line) { return; }
    this.history.push(loc);
    if (this.history.length > 100) { this.history.shift(); }
    this.historyIndex = this.history.length - 1;
    void vscode.commands.executeCommand('setContext', 'vaporview.sourceLink.hasHistory', true);
  }

  private async navigate(step: number) {
    const next = this.historyIndex + step;
    if (this.history.length === 0 || next < 0 || next >= this.history.length) {
      // Nothing of ours to go to: VS Code's own editor history.
      await vscode.commands.executeCommand(step < 0 ? 'workbench.action.navigateBack' : 'workbench.action.navigateForward');
      return;
    }
    this.historyIndex = next;
    await this.goTo(this.history[next], false);
  }

  // #region Path mapping command
  private async editPathMappingCommand(arg?: { rules?: string | string[]; uri?: string; setting?: boolean }) {
    const cfg = vscode.workspace.getConfiguration('vaporview.sourceLink');
    // (P5c) With a waveform open, the rules are kept for its design root + dump; the setting stays the default for
    // dumps without their own rules (arg.setting: edit the setting itself).
    const wave = arg?.setting ? undefined : this.waveform.document(arg?.uri);
    const ukey = wave ? await this.userRulesKey(wave) : undefined;
    const kept = ukey ? this.context.workspaceState.get<Record<string, string[]>>(USER_RULES_STATE_KEY, {})[ukey] : undefined;
    let text: string | undefined;
    if (arg?.rules !== undefined) {
      text = Array.isArray(arg.rules) ? arg.rules.join('\n') : arg.rules;
    } else {
      const inferred = wave ? (await this.mapping(wave)).rules.filter((r) => r.isInferred).map((r) => `${r.designPrefix} = ${r.dumpPrefix}`) : [];
      text = await vscode.window.showInputBox({
        title: 'Waveform Path Mapping',
        prompt: 'Rules "design prefix = waveform prefix", separated by ";" (e.g. cpu = top_tb.dut). Inferred rules are kept and never replace yours'
          + (inferred.length ? `; inferred now: ${inferred.join('; ')}` : '') + '. Empty: same paths.',
        value: (kept ?? cfg.get<string[]>('pathMapping', []) ?? []).join('; '),
      });
      if (text === undefined) { return undefined; }
    }
    const parsed = HierarchyPathMapping.parse(text, true);
    if (!parsed) { this.say('Each rule must look like "design prefix = waveform prefix". The mapping was not changed.', true); return undefined; }
    const lines = parsed.rules.filter((r) => !r.isInferred).map((r) => `${r.designPrefix} = ${r.dumpPrefix}`);
    if (ukey) {
      const all = { ...this.context.workspaceState.get<Record<string, string[]>>(USER_RULES_STATE_KEY, {}) };
      if (lines.length) { all[ukey] = lines; } else { delete all[ukey]; } // (empty: back to the setting's rules)
      await this.context.workspaceState.update(USER_RULES_STATE_KEY, all);
      this.log.appendLine(`source link: path mapping for ${ukey}: ${lines.join('; ') || '(the setting)'}`);
    } else {
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await cfg.update('pathMapping', lines, target);
    }
    this.enums.reset();
    this.scheduleRefresh(0);
    return lines;
  }

  private async getPathMappingCommand(arg?: { uri?: string }) {
    const wave = this.waveform.document(arg?.uri);
    if (!wave) { return undefined; }
    const m = await this.mapping(wave);
    return { text: m.text, rules: m.rules };
  }

  private async setTopLevelCommand(arg?: vscode.Uri | { uri?: string }) {
    const uri = arg instanceof vscode.Uri ? arg : arg?.uri ? vscode.Uri.parse(arg.uri) : vscode.window.activeTextEditor?.document.uri;
    if (!uri) { return false; }
    await this.slang.setTopLevel(uri.fsPath);
    this.enums.reset();
    this.linkedByModule.clear();
    this.scheduleRefresh(0);
    void this.profiles.update(true);
    return (await this.designTops()).map((t) => t.name);
  }

  // #region Enum names in the viewer
  private enumsPending = 0;
  /** Whether the workspace has SystemVerilog / Verilog sources (or one is open): without them the link has no design
   *  to ask slang about, so row adds skip the slang path entirely. Cached; a created SV file or an opened one resets it. */
  private svSources: Promise<boolean> | undefined;
  private hasSvSources(): Promise<boolean> {
    if (vscode.workspace.textDocuments.some(isSvDocument)) { return Promise.resolve(true); }
    if (!this.svSources) {
      this.svSources = Promise.resolve(vscode.workspace.findFiles(SV_GLOB, '**/node_modules/**', 1)).then((f) => f.length > 0, () => false);
    }
    return this.svSources;
  }
  private sourcesChanged() { this.svSources = undefined; this.slang.resetConnection(); }

  private async enumsForAdded(e: { uri: string; instancePath: string[] }) {
    const wave = this.waveform.document(e.uri);
    if (!wave || !vscode.workspace.getConfiguration('vaporview.sourceLink').get<boolean>('enumNames', true)) { return; }
    if (!await this.hasSvSources()) { return; }
    const sent = this.enumScopesSent.get(wave) ?? new Set<string>();
    this.enumScopesSent.set(wave, sent);
    const rows = this.enumRows.get(wave) ?? new Map<string, string>();
    this.enumRows.set(wave, rows);
    let none = this.enumScopesNone.get(wave);
    if (!none || none.epoch !== this.enums.epoch) { none = { epoch: this.enums.epoch, scopes: new Set<string>() }; this.enumScopesNone.set(wave, none); }
    const noEnums = none.scopes;
    const scopes = [...new Set(e.instancePath.map((p) => join(segments(p).slice(0, -1))).filter(Boolean))].filter((s) => !sent.has(s) && !noEnums.has(s));
    if (!scopes.length) { return; }
    try {
      const mapping = await this.mapping(wave);
      const tables = new Map<string, EnumType>();
      const signals = new Map<string, string>();
      for (const dumpScope of scopes) {
        let found = await this.enums.signals(mapping.designPath(dumpScope));
        if (!found.size) {
          const designScope = await this.designScopeByInference(dumpScope, wave);
          if (designScope) { found = await this.enums.signals(designScope); }
        }
        if (!found.size) {
          // Remember it only once slang has a design (before that, "none" may just mean not elaborated yet).
          if ((await this.designTops()).length) { noEnums.add(dumpScope); }
          continue;
        }
        sent.add(dumpScope);
        for (const [name, sig] of found) {
          if (sig.isArray) { continue; }
          const label = tableLabel(sig.type);
          tables.set(label, sig.type);
          signals.set(dumpScope + '.' + name, label);
          rows.set(dumpScope + '.' + name, label);
        }
      }
      if (!tables.size) { return; }
      this.waveform.postMessage(wave, { command: 'loadValueAliases', text: aliasJson(tables, signals), fileName: 'slang-enums.json', apply: true });
      this.log.appendLine(`source link: enum tables ${[...tables.keys()].join(', ')} for ${[...signals.keys()].join(', ')}`);
    } catch (err) {
      this.log.appendLine(`source link: enum types failed: ${err}`);
    }
  }

  private async designScopeByInference(dumpScope: string, wave: VaporviewDocument): Promise<string | undefined> {
    const roots = await this.designTops();
    if (!roots.length) { return undefined; }
    const designRoots = new Map<string, HierarchyNode[]>();
    for (const r of roots.filter((r) => r.isScope)) {
      designRoots.set(r.name, (await this.slang.getScope(r.name).catch(() => [])).map((i) => ({ name: i.name, isScope: i.isScope })));
    }
    const kids = await this.waveform.scopeChildren(wave, segments(dumpScope));
    const probe = kids?.find((k) => !k.isScope);
    if (!probe) { return undefined; }
    const rule = await inferDesignRule(dumpScope + '.' + probe.name, designRoots, this.children(wave));
    if (!rule) { return undefined; }
    const m = new HierarchyPathMapping([rule]);
    return m.designPath(dumpScope);
  }

  /** Format Values > Enum Names: the row's slang enum table again. */
  private async showEnumNamesCommand(arg?: { netlistId?: number; instancePath?: string; uri?: string }) {
    const wave = this.waveform.document(arg?.uri);
    if (!wave) { return false; }
    const path = arg?.instancePath ?? (typeof arg?.netlistId === 'number' ? this.waveform.pathOfNetlistId(wave, arg.netlistId) : this.waveform.selectedSignalPath(wave));
    if (!path) { return false; }
    let label = this.enumRows.get(wave)?.get(path);
    if (!label) {
      await this.enumsForAdded({ uri: wave.uri.toString(), instancePath: [path] });
      label = this.enumRows.get(wave)?.get(path);
    }
    if (!label) { this.say(`slang-server gives no enum type for ${path}.`, true); return false; }
    const netlistId = arg?.netlistId ?? await this.waveform.netlistId(wave, path);
    this.waveform.postMessage(wave, { command: 'setDisplayFormat', netlistId, numberFormat: 'alias:' + label });
    return true;
  }

  // #region Inline values
  private scheduleRefresh(delay = 100) {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refreshAll(); }, delay);
  }

  /** A waveform debug session on the active dump gives the inline values: ours are hidden (e2e reads it). */
  private debuggerShowsValues = false;
  private lastRefreshMarker: number | null | undefined;
  /** Waveform URI -> marker time from its last markerSet event (until its context catches up). */
  private markerFromEvent = new Map<string, number>();
  private markerTime(wave: VaporviewDocument): number | null {
    const e = this.markerFromEvent.get(wave.uri.toString());
    return e !== undefined ? e : this.waveform.markerTime(wave);
  }
  private refreshIfMarkerMoved() {
    const wave = this.waveform.document();
    if (!wave) { return; }
    this.markerFromEvent.delete(wave.uri.toString()); // the context is current by now
    if (this.waveform.markerTime(wave) !== this.lastRefreshMarker) { this.scheduleRefresh(0); }
  }

  private refreshAbort: AbortController | undefined;
  // DIAGNOSTIC timing of the last inline refreshes (sourceLink.status inlineTimings, ms): marker event -> refresh start
  // (wait), modules/instances (instances), slang scope + enum types (scope), point values (values), whole refresh (total).
  private markerEventAt = 0;
  private markerEvents: number[] = [];
  private inlineTimings: { at: number; wait: number; instances: number; scope: number; values: number; total: number; cancelled?: boolean }[] = [];
  private curTiming: { instances: number; scope: number; values: number } | undefined;
  private async refreshAll() {
    const serial = ++this.refreshSerial;
    const tStart = performance.now();
    const timing = this.curTiming = { instances: 0, scope: 0, values: 0 };
    const record = (cancelled?: boolean) => {
      this.inlineTimings.push({ at: tStart, wait: this.markerEventAt ? tStart - this.markerEventAt : 0, ...timing, total: performance.now() - tStart, cancelled });
      if (this.inlineTimings.length > 128) { this.inlineTimings.shift(); }
    };
    // One point-read batch per marker move: a newer refresh cancels the older one's helper request.
    this.refreshAbort?.abort();
    const abort = this.refreshAbort = new AbortController();
    const wave = this.waveform.document();
    this.lastRefreshMarker = wave ? this.markerTime(wave) : undefined;
    const enabled = inlineMode() !== 'off';
    const dbg = WaveformDebugSession.current;
    this.debuggerShowsValues = !!(wave && dbg && dbg.time !== null && dbg.uri === wave.uri.toString());
    for (const editor of vscode.window.visibleTextEditors.filter((e) => isSvDocument(e.document))) {
      let values: InlineValue[] = [];
      if (enabled && !this.debuggerShowsValues) {
        try { values = await this.inlineValues(editor.document, editor.visibleRanges, abort.signal); } catch (e) {
          if (e instanceof LinkCancelled) { record(true); return; }
          this.log.appendLine(`source link: inline values failed: ${e}`);
        }
      }
      if (serial !== this.refreshSerial) { return; }
      this.inlineByEditor.set(editor.document.uri.toString(), values);
      this.drawInline(editor);
      this.onDidRefreshEmitter.fire(editor.document.uri.toString());
    }
    record();
  }

  /** Lines whose inline values are drawn : the cursor's line and the selected lines ("cursorLine", the default),
   *  every computed line ("all"), none ("off"). Values are computed for the visible lines either way (the hover and
   *  getInlineValues read them); only the drawing follows the mode. */
  private drawnLines(editor: vscode.TextEditor): ((line: number) => boolean) {
    const mode = inlineMode();
    if (mode === 'all') { return () => true; }
    if (mode === 'off') { return () => false; }
    const sel = editor.selections.map((s) => [s.start.line, s.end.line] as const);
    return (line) => sel.some(([a, b]) => line >= a && line <= b);
  }
  /** Draws `editor`'s computed inline values on the lines the mode shows (a cursor move redraws without a read). */
  private drawInline(editor: vscode.TextEditor) {
    const values = this.inlineByEditor.get(editor.document.uri.toString()) ?? [];
    const show = this.drawnLines(editor);
    const byLine = new Map<number, InlineValue[]>();
    for (const v of values) { if (show(v.line)) { byLine.set(v.line, [...(byLine.get(v.line) ?? []), v]); } }
    // A no-value entry reads "name = no value (port copy | not in dump | memory | not computable)" (never a bare
    // "no value"), the full reason in the line's hover (shared with the debugger: value_format.ts noValueInline).
    const text = (v: InlineValue) => v.noValue ? noValueInline(v.name, v.reason ?? '') : `${v.name} = ${v.value}`;
    const deco = (pick: (v: InlineValue) => boolean) => [...byLine].filter(([, vs]) => vs.some(pick)).map(([line, vs]) => {
      const why = vs.filter((v) => pick(v) && v.noValue).map((v) => `${v.name}: no value (${v.reason ?? 'no reason given'})`);
      return {
        range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
        ...(why.length ? { hoverMessage: new vscode.MarkdownString().appendText(why.join('\n')) } : {}),
        renderOptions: { after: { contentText: vs.filter(pick).map(text).join(INLINE_SEPARATOR) } },
      };
    });
    const shown = deco((v) => !v.noValue), none = deco((v) => !!v.noValue);
    editor.setDecorations(this.decoration, shown);
    editor.setDecorations(this.noValueDecoration, none); // dim, after the values
    this.drawnByEditor.set(editor.document.uri.toString(), [...byLine.keys()].sort((a, b) => a - b));
    this.drawnText.set(editor.document.uri.toString(), [
      ...shown.map((d) => ({ line: d.range.start.line, text: d.renderOptions.after.contentText, noValue: false })),
      ...none.map((d) => ({ line: d.range.start.line, text: d.renderOptions.after.contentText, noValue: true, hover: (d as any).hoverMessage?.value as string | undefined })),
    ]);
  }
  /** Per SV document: the after-texts drawn last (e2e: getInlineValues {drawn: true}.texts). */
  private drawnText = new Map<string, { line: number; text: string; noValue: boolean; hover?: string }[]>();
  /** Per SV document: the lines drawn last (e2e: vaporview.sourceLink.getInlineValues {drawn: true}). */
  private drawnByEditor = new Map<string, number[]>();

  /** The design instance each module of `doc` is shown as, and its dump scope (undefined: no waveform / design). */
  async instancesFor(doc: vscode.TextDocument): Promise<{ module: string; range: vscode.Range; link: LinkedInstance }[]> {
    const wave = this.waveform.document();
    if (!wave || !this.slang.mode && !await this.slang.connect()) { return []; }
    const modules = (await this.slang.scopesByModule().catch(() => [])).filter((m) => m.declLoc && sameFile(m.declLoc.uri, doc.uri));
    const mapping = await this.mapping(wave);
    const out: { module: string; range: vscode.Range; link: LinkedInstance }[] = [];
    for (const m of modules) {
      let link = this.linkedByModule.get(m.declName);
      if (!link || link.waveformUri !== wave.uri.toString()) {
        const designInstance = m.instCount === 1 && m.instPath ? m.instPath : (await this.slang.instancesOfModule(m.declName).catch(() => []))[0];
        if (!designInstance) { continue; }
        const dumpInstance = await this.dumpInstanceOf(designInstance, wave, mapping);
        if (!dumpInstance) { continue; }
        link = { designInstance, dumpInstance, waveformUri: wave.uri.toString(), module: m.declName };
      }
      out.push({ module: m.declName, range: m.declLoc!.range, link });
    }
    return out;
  }

  /** Every design instance of `module` that the current waveform dumps, with its dump scope (Show Waveform Values For). */
  private async moduleInstances(module: string): Promise<{ designInstance: string; dumpInstance: string }[]> {
    const wave = this.waveform.document();
    if (!wave) { return []; }
    const mapping = await this.mapping(wave);
    const out: { designInstance: string; dumpInstance: string }[] = [];
    for (const designInstance of (await this.slang.instancesOfModule(module).catch(() => [])).slice(0, 64)) {
      const dumpInstance = await this.dumpInstanceOf(designInstance, wave, mapping);
      if (dumpInstance) { out.push({ designInstance, dumpInstance }); }
    }
    return out;
  }

  /** The dump scope of a design instance: the mapping, else a rule inferred through one of its signals. */
  private async dumpInstanceOf(designInstance: string, wave: VaporviewDocument, mapping: HierarchyPathMapping): Promise<string | undefined> {
    for (const p of mapping.dumpPaths(designInstance)) { if (await this.waveform.scopeChildren(wave, segments(p))) { return p; } }
    const probe = (await this.slang.getScope(designInstance).catch(() => [])).find((i) => !i.isScope);
    if (!probe) { return undefined; }
    const r = await this.resolveDumpPaths(designInstance + '.' + probe.name, wave);
    if (r.kind === 'found') { return join(segments(r.paths[0]).slice(0, -1)); }
    return undefined;
  }

  async inlineValues(doc: vscode.TextDocument, ranges: readonly vscode.Range[], signal?: AbortSignal): Promise<InlineValue[]> {
    const wave = this.waveform.document();
    if (!wave) { return []; }
    const time = this.markerTime(wave);
    if (time === null || time === undefined) { return []; }
    const out: InlineValue[] = [];
    const tm = this.curTiming;
    let t = performance.now();
    const lap = (k: 'instances' | 'scope' | 'values') => { const n = performance.now(); if (tm) { tm[k] += n - t; } t = n; };
    const instances = await this.instancesFor(doc);
    lap('instances');
    for (const { range, link } of instances) {
      const items = (await this.slang.getScope(link.designInstance).catch(() => [])).filter((i) => !i.isScope && (i.kind === 'Logic' || i.kind === 'Port' || i.kind === 'Net'));
      const names = new Set(items.map((i) => i.name));
      const enums = await this.enums.signals(link.designInstance).catch(() => new Map<string, EnumSignal>());
      lap('scope');
      const wanted: { line: number; name: string }[] = [];
      for (const visible of ranges) {
        const from = Math.max(range.start.line, visible.start.line);
        const to = Math.min(range.end.line, visible.end.line);
        for (let line = from; line <= to && wanted.length < MAX_INLINE_VALUES; line++) {
          const text = doc.lineAt(line).text.replace(/\/\/.*$/, '');
          const seen = new Set<string>();
          for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
            if (names.has(m[0]) && !seen.has(m[0])) { seen.add(m[0]); wanted.push({ line, name: m[0] }); }
          }
        }
      }
      const unique = [...new Set(wanted.map((w) => w.name))];
      t = performance.now();
      const values = await this.waveform.valuesAt(wave, unique.map((n) => link.dumpInstance + '.' + n), time, signal);
      lap('values');
      const byName = new Map(unique.map((n, i) => [n, values[i]]));
      for (const w of wanted) {
        const bits = byName.get(w.name);
        const dumpPath = link.dumpInstance + '.' + w.name;
        if (typeof bits !== 'string') {
          // Read order : stored value, the helper's computed port copy (answered above when the setting allows),
          // then the design: the signal's single port / assign driver (the resolver Trace shares), else "no value".
          // noChange (nothing recorded up to t) and unreadable: the dump's own answer, no resolver call.
          const m = await missingValue(bits, () => this.resolvePort(wave, link.designInstance + '.' + w.name, time), clean);
          if ('dump' in m) { out.push({ line: w.line, name: w.name, ...m.dump, dumpPath, noValue: true }); continue; }
          const r = m.design;
          if (!isNoValue(r)) {
            const shown = formatValue(r.value, enums.get(w.name));
            if (shown) { out.push({ line: w.line, name: w.name, value: shown.value, raw: shown.raw, reason: `via ${r.via}`, dumpPath }); continue; }
          }
          const why = isNoValue(r) && r.reason === 'notComputable' && bits?.kind === 'unavailable' && bits.reason ? `${noValueText(r).replace(/^no value \((.*)\)$/, '$1')}; ${clean(bits.reason)}` : undefined;
          out.push({ line: w.line, name: w.name, value: 'no value', reason: why ?? (isNoValue(r) ? noValueText(r).replace(/^no value \((.*)\)$/, '$1') : 'not in the dump'), dumpPath, noValue: true });
          continue;
        }
        const shown = formatValue(bits, enums.get(w.name));
        if (shown) { out.push({ line: w.line, name: w.name, value: shown.value, raw: shown.raw, dumpPath }); }
      }
    }
    return out;
  }

  /** vaporview.trace.resolvePortValue (src/cmux/shared/port_resolve.ts through TraceCore): the value of a signal the
   *  dump lacks, through its single port / assign driver; undefined when it can't say (never a guess). Cached per
   *  path and time. */
  private portCache = new Map<string, PortValue>();
  private async resolvePort(wave: VaporviewDocument, designPath: string, time: number): Promise<PortValue> {
    const key = `${wave.uri.toString()}|${designPath}@${time}`;
    const hit = this.portCache.get(key);
    if (hit) { return hit; }
    if (this.portCache.size > 4096) { this.portCache.clear(); }
    let r: PortValue;
    try {
      const x: any = await vscode.commands.executeCommand('vaporview.trace.resolvePortValue', { uri: wave.uri.toString(), designPath, time });
      r = x && typeof x.value === 'string' && typeof x.via === 'string' ? { value: x.value, via: x.via, dumped: false }
        : isNoValue(x) ? x : { noValue: true, reason: 'notComputable', why: 'failed', path: designPath };
    } catch { r = { noValue: true, reason: 'notComputable', why: 'failed', path: designPath }; }
    this.portCache.set(key, r);
    return r;
  }

  private provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const range = doc.getWordRangeAtPosition(pos, IDENT);
    if (!range) { return undefined; }
    const word = doc.getText(range);
    const values = this.inlineByEditor.get(doc.uri.toString()) ?? [];
    const v = values.find((x) => x.name === word && x.line === pos.line) ?? values.find((x) => x.name === word);
    if (!v) { return undefined; }
    const wave = this.waveform.document();
    const time = wave ? this.markerTime(wave) : undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${v.dumpPath}** at the marker${time !== null && time !== undefined ? ` (${time})` : ''}: \`${v.value}\``);
    if (v.raw) { md.appendMarkdown(` = \`${v.raw}\``); }
    if (v.reason) { md.appendMarkdown(` (${v.reason.replace(/[\\`*_[\]<>]/g, '\\$&')})`); }
    return new vscode.Hover(md, range);
  }

  // #region API for other features (the debugger)
  /** The signals line `line` of `uri` assigns (assignment targets), with their design and dump paths. */
  async signalsAssignedOnLine(uri: vscode.Uri, line: number): Promise<{ name: string; designPath: string; dumpPath: string }[]> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.lineAt(line).text;
    const out: { name: string; designPath: string; dumpPath: string }[] = [];
    for (const { range, link } of await this.instancesFor(doc)) {
      if (line < range.start.line || line > range.end.line) { continue; }
      const names = new Set((await this.slang.getScope(link.designInstance).catch(() => [])).filter((i) => !i.isScope).map((i) => i.name));
      for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
        if (!names.has(m[0]) || !isAssignmentTarget(text, m.index ?? 0, m[0].length) || out.some((o) => o.name === m[0])) { continue; }
        out.push({ name: m[0], designPath: link.designInstance + '.' + m[0], dumpPath: link.dumpInstance + '.' + m[0] });
      }
    }
    return out;
  }

  /** The design instance and dump scope the editor shows at `position` (default: its first module). */
  async instanceAt(uri: vscode.Uri, position?: vscode.Position): Promise<LinkedInstance | undefined> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const all = await this.instancesFor(doc);
    return (position ? all.find((i) => i.range.contains(position)) : all[0])?.link;
  }
}

// #region Helpers
function formatValue(bits: string, enumSig: EnumSignal | undefined): { value: string; raw?: string } | undefined {
  const b = bits.toLowerCase().replace(/[^01xzuwlh-]/g, '');
  if (!b) { return bits ? { value: clean(bits) } : undefined; }
  if (enumSig && !enumSig.isArray) {
    const name = memberName(enumSig.type, b);
    const raw = hexLiteral(fitted(b, enumSig.type.width));
    return { value: name ?? raw + '?', raw };
  }
  if (b.length === 1) { return { value: b }; }
  return { value: hexLiteral(b) };
}

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f؜‎‏‪-‮⁦-⁩]/g, '').slice(0, MAX_VALUE_LENGTH);
}

function offsetAtLines(lines: string[], line: number, character: number): number {
  let o = 0;
  for (let i = 0; i < line && i < lines.length; i++) { o += lines[i].length + 1; }
  return o + character;
}
function offsetAt(text: string, pos: vscode.Position): number { return offsetAtLines(text.split('\n'), pos.line, pos.character); }
function positionAt(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset).split('\n');
  return new vscode.Position(before.length - 1, before[before.length - 1].length);
}

/** At `offset` on the port name of a named connection `.port (sig)`: the instance name's offset and the port. */
export function portConnectionAt(text: string, offset: number): { instanceOffset: number; port: string } | undefined {
  let s = offset; let e = offset;
  while (s > 0 && /[A-Za-z0-9_$]/.test(text[s - 1])) { s--; }
  while (e < text.length && /[A-Za-z0-9_$]/.test(text[e])) { e++; }
  if (s === e) { return undefined; }
  let p = s - 1;
  while (p >= 0 && /\s/.test(text[p])) { p--; }
  if (text[p] !== '.') { return undefined; }
  // Back to the `(` that opens the port list, then the instance name before it.
  let depth = 0;
  for (let i = p - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ';') { return undefined; }
    if (c === ')') { depth++; } else if (c === '(') {
      if (depth > 0) { depth--; continue; }
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j])) { j--; }
      const end = j + 1;
      while (j >= 0 && /[A-Za-z0-9_$]/.test(text[j])) { j--; }
      if (end === j + 1) { return undefined; }
      return { instanceOffset: j + 1, port: text.slice(s, e) };
    }
  }
  return undefined;
}

/** vaporview.sourceLink.inlineValues : "cursorLine" (default) | "all" | "off"; the old boolean true / false
 *  means "all" / "off". */
export function inlineMode(): 'cursorLine' | 'all' | 'off' {
  const v = vscode.workspace.getConfiguration('vaporview.sourceLink').get<unknown>('inlineValues', 'cursorLine');
  if (v === true || v === 'all') { return 'all'; }
  if (v === false || v === 'off') { return 'off'; }
  return 'cursorLine';
}
