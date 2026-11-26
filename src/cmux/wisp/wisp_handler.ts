// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: FSDB and WCZ files through wisp-helper (wisp-helper/ in this repository, MIT), our native reader.
// No vendor library is loaded or linked: the helper reads FSDB with the converter's own decoder.
//
// The netlist comes from the helper (open / children). Signal data reaches the webview two ways:
//   - windowed (default): the patched viewer's window cache (src/webview/window_cache.ts) sends its own
//     protocol-v2 requests ({command:'v2', req}); relayV2() forwards them and posts {command:'v2-reply'}.
//     Small signals are loaded whole by the window cache itself (hybrid mode).
//   - whole signals (vaporview.wisp.windowing off, and bit slices): getSignalData() asks one exact window
//     over the whole dump per signal and posts update-waveform-chunk as upstream's handlers do.
// Relay logic adapted from an earlier web viewer prototype (ScopeMerger) and cmux
// Resources/vaporview/host.js (fsdbBackend.v2).
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import * as path from 'path';
import * as fs from 'fs';
import type { EnumQueueEntry, SignalId, ValueChangeDataChunk, WaveformDumpMetadata } from '../../common/types';
import type { VaporviewDocumentDelegate } from '../../extension_core/viewer_provider';
import { type NetlistItem, createScope, createVar } from '../../extension_core/tree_view';
import type { WaveformFileParser, NetlistSearchResult } from '../../extension_core/document';
import type { ValuesAtTimeResult } from '../../../packages/vaporview-api/types';
import { WispHelperProcess, type HelperReply } from './helper_process';
import { locateHelper, helperLaunch } from './locate';
import { hostSearchText, useFormats } from './text_search';
import { relayStreamedWindow, exactBytes } from './stream_relay';
import { answerComputed, isComputed, WINDOW_ONLY, type ComputedRange } from './computed'; // vscode-port: outsideWrites none
import { NameIndex, cachedIndex, keepIndex } from './name_index';
import { classifySignalError, signalErrorStatus, computedNoValueText, signalNoteKind } from './signal_errors'; // vscode-port // vscode-port: Search Netlist index

const NO_CHANGE_FROM_PREV = false; // see askValueAt
export const NO_CHANGE_TEXT = 'no value (no change recorded in the dump up to this time)';

// What the viewer may ask the helper through the relay (the window cache's commands).
const RELAYED = new Set(['window', 'valueAt', 'edge', 'search', 'searchText', 'count', 'cancel', 'free']);
const WHOLE_BUCKETS = 4194304;  // the helper's bucket cap: an exact answer for up to 2x this many changes
// vscode-port: e2e lowers it (globalThis.vvE2EWholeBuckets) to make a small fixture's whole load a summary.
const wholeBuckets = () => Number((globalThis as any).vvE2EWholeBuckets) || WHOLE_BUCKETS;
export const SUMMARY_NOTICE = 'Some signals have more value changes than one whole load holds, so their rows show a summary, not exact values (marked "summary"). Turn on vaporview.wisp.windowing to see exact values.';

// User-visible state per open file, for the status bar and the e2e suite (vaporview.e2e.wispState).
export interface WispFileState {
  file: string;
  source: string;            // 'fsdb' | 'wcz'
  helper: string;
  refused: string | null;    // the helper's reason, once the file is refused (open or lazy check)
  withdrawn: number;         // answers shown before the lazy check refused the file
  unverified: number;        // answers given with "verified": false
  signalErrors: string[];    // per-signal read errors (damaged blocks ...), first few
  outsideWrites: string;     // vscode-port: the open's statement (vaporview.wisp.outsideWrites)
  computed: ComputedRange | null; // computed signal ids (port copies the helper computes), from stats
  computedAnswers: number;   // valueAt/edge/count answered for computed ids through windows
  timePad?: {n: number; pad: number; how: string}; // vscode-port: the view's end padding (VCD rule)
  summarySignals: number;    // whole loads answered as a summary (windowing off, too many changes)
  messages: string[];        // error / warning messages shown to the user
  status: string;            // the status bar text, '' when none
  statusLevel?: string;
  preparingNotes?: number;   // vscode-port: times the "Preparing computed signals" note was shown (e2e)      // vscode-port: 'error' | 'warning' for a signal-error status ('' / absent otherwise)
  relayed: number;
  cancels: number;           // viewer cancels passed on to the helper
  args: string[];            // the helper's command line (settings)
  envKeys: string[];         // WISP_* variables the settings set
  workers: number;           // workers the helper says it runs (open reply)
  helperPid: number;         // (memory checks)
  nativeStream: boolean;     // the helper streams window {stream: true} itself (caps.stream)
  streamedWindows: number;   // window {stream: true} requests relayed
  partialFrames: number;     // partial frames sent to the viewer
  textSearches: number;      // searchText requests answered in the extension host (text_search.ts)
  windows: number;           // window requests from the viewer
  windowsDeflateCounts: number; // ... that asked for deflated bucket counts
  lastTextSearch?: {ms: number; chunks: number; formatted: number; distinct: number; found: boolean; incomplete?: unknown};
}

export const wispStates = new Map<string, WispFileState>();

const UNAVAILABLE_ICON = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));

// dist/host_formats.js: the viewer's formatters for searchText (esbuild.js builds it next to extension.js).
let formatsLoaded = false;
function loadHostFormats() {
  if (formatsLoaded) {return;}
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useFormats(require(path.join(__dirname, 'host_formats.js')));
  formatsLoaded = true;
}

export function decodeBitRecords(raw: Buffer, width: number): [number, string][] {
  const rec = 8 + width, n = Math.floor(raw.length / rec);
  const s = raw.toString('latin1');
  const out: [number, string][] = new Array(n);
  let t = 0;
  for (let i = 0, o = 0; i < n; i++, o += rec) {
    t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296;
    out[i] = [t, s.substring(o + 8, o + rec)];
  }
  return out;
}

// Text rows (strings, reals): [u64 LE delta time][u32 LE length][bytes].
export function decodeTextRecords(raw: Buffer): [number, string][] {
  const out: [number, string][] = [];
  let t = 0, o = 0;
  while (o + 12 <= raw.length) {
    t += raw.readUInt32LE(o) + raw.readUInt32LE(o + 4) * 4294967296;
    const len = raw.readUInt32LE(o + 8);
    out.push([t, raw.toString('utf8', o + 12, o + 12 + len)]);
    o += 12 + len;
  }
  return out;
}

// vscode-port: an FSDB refused at open. A plan-size refusal says the file is too large for the budget (the
// file itself is fine) and names vaporview.wisp.planBudgetMB; other refusals give the reader's reason. Never "corrupted":
// the helper cannot tell a damaged file from one it does not support.
// The page each failed-open tab shows, by uri (viewer_provider sets it; the e2e hook reads it).
export const failedOpenPages = new Map<string, string>();
export const PLAN_SETTING = 'vaporview.wisp.planBudgetMB';
// vscode-port: what a request answers once its document closed or reloaded (code 'reloaded': callers drop it)
export const DOCUMENT_CLOSED = 'document closed';
export const PREPARING_COMPUTED = '$(sync~spin) Preparing computed signals for this file (once per open)…';
export const PLAN_LIMIT = /plan:? (byte|text size) limit/i;  // 15.11 "plan byte limit", older "plan: text size limit"
export function refusalMessage(name: string, error: string, budgetMB: string | undefined): string {
  if (PLAN_LIMIT.test(error)) {
    const now = budgetMB ? `now ${budgetMB} MiB` : 'now the helper default';
    return `${name} was not opened: its read plan is larger than wisp-helper's plan budget. This is a size limit, ` +
      `not a damaged file. Raise "${PLAN_SETTING}" (${now}, up to 32768) and open the file again. Helper: ${error}`;
  }
  return `${name} could not be read: wisp-helper refused it (${error}).`;
}

export class WispFormatHandler implements WaveformFileParser {
  public netlistSearchable = false;
  public postMessageToWebview = (_message: Record<string, unknown>) => {};
  public findTreeItemFn: (scopePath: string, msb: number | undefined, lsb: number | undefined) => Promise<NetlistItem | null> = async () => null;
  public metadata: WaveformDumpMetadata = {
    timeTableLoaded: false, scopeCount: 0, netlistIdCount: 0, signalIdCount: 0, timeTableCount: 0,
    timeEnd: 0, minTimeStep: 1, timeScale: 1, timeUnit: 'ns',
  };

  private helper: WispHelperProcess | undefined;
  private netlistTop: NetlistItem[] = [];
  private copies = new Map<number, number[]>();          // merged scope id -> ids of every copy (ScopeMerger)
  private signalInfo = new Map<SignalId, {width: number; text: boolean}>();
  private byViewer = new Map<number, number[]>();         // viewer request id -> helper request ids (cancel; a split stream has several)
  private cancelledViewer = new Set<number>();            // viewer ids cancelled while a split stream runs
  private generation = 0;
  // vscode-port: the viewer's own generation. A webview (re)init (beforeInitViewport, on every 'ready')
  // drops the old viewer's relayed requests, but not the file: extension-side reads (data.ts, Trace) keep `generation`.
  private viewerGeneration = 0;
  private statusItem: vscode.StatusBarItem | undefined;
  private state: WispFileState;
  private errorShown = false;

  constructor(private delegate: VaporviewDocumentDelegate, private uri: vscode.Uri, private extensionPath: string | undefined) {
    this.state = {file: uri.fsPath, source: '', helper: '', refused: null, withdrawn: 0, unverified: 0, signalErrors: [], messages: [], status: '', relayed: 0, cancels: 0, args: [], envKeys: [], workers: 0, helperPid: 0, nativeStream: false, streamedWindows: 0, partialFrames: 0, textSearches: 0, windows: 0, windowsDeflateCounts: 0, summarySignals: 0, outsideWrites: 'unknown', computed: null, computedAnswers: 0};
    wispStates.set(uri.toString(), this.state);
  }

  private log(m: string) { this.delegate.logOutputChannel('[wisp] ' + m); }

  // setting: a "Open setting" button that opens that setting (e.g. the plan budget after a plan-size refusal)
  private showError(message: string, setting?: string) {
    this.state.messages.push(message);
    this.log(message);
    if (!setting) {vscode.window.showErrorMessage(message); return;}
    vscode.window.showErrorMessage(message, 'Open setting').then((b) => {
      if (b) {vscode.commands.executeCommand('workbench.action.openSettings', setting);}
    });
  }

  // A message the document showed for this file (rows refused: declared without values).
  public noteMessage(message: string) { this.state.messages.push(message); }

  private setStatus(text: string, tooltip: string, level: 'error' | 'warning' | 'note' = 'error') {
    if (!this.statusItem) {
      this.statusItem = vscode.window.createStatusBarItem('vaporview.wisp.status', vscode.StatusBarAlignment.Left, 50);
      this.statusItem.name = 'FSDB file check';
    }
    // vscode-port: red only for errors (refused file, damage); a limit on some signals is a warning
    this.statusItem.backgroundColor = level === 'note' ? undefined : new vscode.ThemeColor(level === 'error' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground'); // vscode-port: a note is neutral
    this.statusItem.text = text;
    this.statusItem.tooltip = tooltip;
    this.statusItem.show();
    this.state.status = text;
  }

  // ---- open ----
  async loadNetlist(): Promise<void> {
    // A reload starts the file's checks over.
    Object.assign(this.state, {refused: null, withdrawn: 0, unverified: 0, signalErrors: [], status: '', relayed: 0, cancels: 0, nativeStream: false, streamedWindows: 0, partialFrames: 0, textSearches: 0, windows: 0, windowsDeflateCounts: 0});
    this.errorShown = false;
    this.damagedErrors = []; this.unreadableErrors.clear(); this.unknownErrors.clear(); this.noteErrors.clear(); this.state.statusLevel = ''; // vscode-port
    this.statusItem?.hide();
    const found = locateHelper(this.extensionPath);
    if (!found.path) {
      this.showError(found.error!);
      throw new Error(found.error);
    }
    this.state.helper = found.path;
    const {args, env} = helperLaunch(this.uri);
    this.state.args = args;
    this.state.envKeys = Object.keys(env).filter((k) => /^(WISP_|RUN_PLAN_)/.test(k) && env[k] !== process.env[k]).map((k) => k + '=' + env[k]);
    this.helper = new WispHelperProcess({
      helperPath: found.path, args, env,
      log: (m) => this.log(m),
      onEvent: (e) => this.onEvent(e),
    });
    this.log(`open ${this.uri.fsPath} with ${found.path} ${args.join(' ')}`);
    const wb = Number(env.WISP_WORKER_RSS_MB) || 0;
    this.log(`memory: plan budget ${env.RUN_PLAN_BUDGET_MB || 'helper default'} MB, worker bound ${wb || 'helper default (1024)'} MB, load-refusal line ${wb ? 2 * wb : 2048} MB (vaporview.wisp.planBudgetMB; wisp.env wins)`);
    // vscode-port: "outsideWrites": "none" (vaporview.wisp.outsideWrites) lets the helper compute unlinked port copies
    // resource scope: a folder's .vscode/settings.json describes the dumps in it (multi-root: the file's own folder)
    const ow = vscode.workspace.getConfiguration('vaporview', this.uri).get<string>('wisp.outsideWrites') === 'none' ? 'none' : 'unknown';
    this.state.outsideWrites = ow;
    const {line} = await this.helper.request({cmd: 'open', file: this.uri.fsPath, ...(ow === 'none' ? {outsideWrites: 'none'} : {})});
    if (line.error) {
      const name = path.basename(this.uri.fsPath);
      const msg = line.code === 'fileRefused'
        ? refusalMessage(name, String(line.error), env.RUN_PLAN_BUDGET_MB)
        : `${name} could not be opened by wisp-helper: ${line.error}`;
      if (line.code === 'fileRefused') {this.state.refused = String(line.error); this.setStatus('$(error) Waveform refused', msg);}
      this.showError(msg, PLAN_LIMIT.test(String(line.error)) ? PLAN_SETTING : undefined);
      this.helper.close();
      throw new Error(msg);
    }
    const r = line.result || {};
    const m = r.metadata || {};
    this.state.computed = null;
    if (ow === 'none') {
      const st = await this.helper.request({cmd: 'stats'});
      const c = st.line.result && st.line.result.computed;
      if (c && Number(c.signals) > 0) {this.state.computed = {first: Number(c.firstId), n: Number(c.signals)};}
      this.log(`outsideWrites none: ${this.state.computed ? this.state.computed.n + ' computed port copies (ids from ' + this.state.computed.first + ')' : 'no computed port copies'}`);
    }
    this.state.source = String(r.source || '');
    this.state.nativeStream = !!(r.caps && r.caps.stream === true);
    this.state.workers = Number(r.workers) || 0;
    this.state.helperPid = this.helper.pid || 0;
    Object.assign(this.metadata, {
      scopeCount: Number(m.scopeCount) || 0,
      netlistIdCount: Number(m.netlistIdCount) || 0,
      signalIdCount: Number(m.signalIdCount) || 0,
      timeTableCount: Number(m.timeTableCount) || 0,
      timeEnd: Number(m.timeEnd) || 0,
      timeStart: Number(m.timeStart) || 0, // vscode-port: the dump's first time (helper metadata; not in upstream's type)
      minTimeStep: Number(m.minTimeStep) || 1,
      timeScale: Number(m.timeScale) || 1,
      timeUnit: String(m.timeUnit || 'ns'),
    });
    if (Number(m.skippedVars)) {this.log(`${m.skippedVars} declared variables have no values (listed greyed, with the reason)`);}
    // One tree per name: an FSDB written by several $fsdbDumpvars calls holds the same top several times.
    const tops = this.merge(Array.isArray(r.top) ? r.top : [], (t) => t.scopeOffsetIdx, (t) => t.name);
    this.netlistTop = tops.map((t: any) => createScope(t.name, t.type || 'module', [], t.netlistId, t.scopeOffsetIdx, this.uri));
    this.topReply = tops;
  }

  async loadBody(): Promise<void> {
    // Nothing to parse up front: values are read on demand. The viewer can start now.
    await this.padTimeEnd().catch((e) => this.log('end padding: ' + (e instanceof Error ? e.message : String(e))));
    this.metadata.timeTableLoaded = true;
  }

  // vscode-port: the view ends past the last timestamp, as the VCD view does, so a change at the last timestamp is drawn
  // and zoom-to-fit covers it. The VCD rule (wellen_parser/lib.rs setchunksize) pads by the mean step, timeEnd / N with N
  // = the dump's distinct timestamps; the helper reports only timeEnd (N would need every signal read, which does not
  // scale), so the pad is timeEnd / 1000 (at least 1): no netlist walk, no per-signal reads.
  private async padTimeEnd(): Promise<void> {
    const te = this.metadata.timeEnd;
    if (!(te > 0)) {this.state.timePad = {n: 0, pad: 0, how: 'none'}; return;}
    const pad = Math.max(Math.ceil(te / 1000), 1);
    this.metadata.timeEnd = te + pad;
    this.state.timePad = {n: 1000, pad, how: 'timeEnd/1000'};
  }

  // ---- netlist ----
  private merge(list: any[], idOf: (x: any) => number | undefined, nameOf: (x: any) => string | undefined) {
    const out: any[] = [], byName = new Map<string, number>();
    for (const it of list) {
      const n = nameOf(it), id = idOf(it);
      if (n === undefined || id === undefined || !byName.has(n)) {
        out.push(it);
        if (n !== undefined && id !== undefined) {byName.set(n, id);}
        continue;
      }
      const kept = byName.get(n)!;
      const all = this.copies.get(kept) || [kept];
      for (const x of this.copies.get(id) || [id]) {if (!all.includes(x)) {all.push(x);}}
      this.copies.set(kept, all);
    }
    return out;
  }

  private async childrenReply(scopeOffsetIdx: number, scopePath: string): Promise<{scopes: any[]; vars: any[]}> {
    const ids = this.copies.get(scopeOffsetIdx) || [scopeOffsetIdx];
    const replies = await Promise.all(ids.map((id) => this.helper!.request({cmd: 'children', scopeOffsetIdx: id, scopePath})));
    const ok = replies.filter((r) => r.line && r.line.result);
    if (!ok.length) {
      const err = replies[0]?.line?.error || 'no answer';
      this.log(`children of ${scopePath}: ${err}`);
      if (/fileRefused/.test(String(replies[0]?.line?.code))) {this.onRefused(String(err), 0);}
      return {scopes: [], vars: []};
    }
    const scopes: any[] = [], vars: any[] = [], seen = new Set<string>();
    for (const r of ok) {
      for (const sc of r.line.result.scopes || []) {scopes.push(sc);}
      for (const v of r.line.result.vars || []) {if (!seen.has(v.name)) {seen.add(v.name); vars.push(v);}}
    }
    return {scopes: this.merge(scopes, (sc) => (sc.inline ? undefined : sc.scopeOffsetIdx), (sc) => (sc.inline ? undefined : sc.name)), vars};
  }

  private makeVar(v: any, scopePath: string[]): NetlistItem {
    const unavailable = v.signalId === null || v.signalId === undefined;
    const msb = Number(v.msb ?? (Number(v.width) - 1)), lsb = Number(v.lsb ?? 0);
    const item = createVar(String(v.name), '', String(v.type || 'wire'), String(v.encoding || 'BitVector'), scopePath,
      Number(v.netlistId), unavailable ? -1 : Number(v.signalId), Number(v.width) || 1, msb, lsb, '', true, this.uri);
    if (!unavailable) {
      this.signalInfo.set(Number(v.signalId), {width: Number(v.width) || 1, text: v.encoding === 'Real' || v.encoding === 'String'});
      return item;
    }
    // Declared, but the file holds no values for it: listed with the reason, never added as a row.
    const u = v.unavailable || {};
    let reason = String(u.reason || 'declared, no values');
    // vscode-port: an unlinked port copy can be computed when the run had no outside writes (vaporview.wisp.outsideWrites)
    if (/values not linked/.test(reason) && this.state.outsideWrites !== 'none') {
      reason += ' (if the run had no force, deposit or C-code write, set vaporview.wisp.outsideWrites to "none" and reopen to compute it)';
    }
    (item as any).unavailable = {state: String(u.state || 'absent'), reason};
    (item as any).command = undefined;
    item.contextValue = 'netlistVarUnavailable';
    item.iconPath = UNAVAILABLE_ICON;
    item.description = 'no values: ' + reason;
    item.tooltip = `${item.tooltip}\nNo values (${u.state || 'absent'}): ${reason}`;
    return item;
  }

  private makeItems(reply: {scopes: any[]; vars: any[]}, scopePath: string[]): NetlistItem[] {
    const out: NetlistItem[] = [];
    for (const s of reply.scopes) {
      if (s.inline) {
        // An array shown inline: its contents come with it.
        const scope = createScope(s.name, s.type || 'vhdlarray', scopePath, Number(s.netlistId ?? -1), -1, this.uri);
        scope.children = this.makeItems({scopes: s.inline.scopes || [], vars: s.inline.vars || []}, scopePath.concat([scope.name]));
        scope.fsdbVarLoaded = true;
        out.push(scope);
      } else {
        out.push(createScope(s.name, s.type || 'module', scopePath, Number(s.netlistId), Number(s.scopeOffsetIdx), this.uri));
      }
    }
    for (const v of reply.vars) {out.push(this.makeVar(v, scopePath));}
    return out;
  }

  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) {return this.netlistTop;}
    if (element.fsdbVarLoaded || element.scopeOffsetIdx < 0 || !this.helper) {return element.children;}
    const scopePath = element.scopePath.concat([element.name]);
    const reply = await this.childrenReply(element.scopeOffsetIdx, scopePath.join('.'));
    element.children = this.makeItems(reply, scopePath);
    element.fsdbVarLoaded = true;
    return element.children;
  }

  // ---- netlist search (the Search Netlist quick pick) ----
  // Same rules as the wellen handler (src/wellen_parser/lib.rs searchnetlist): the query is lower-cased and split on
  // '.'; the first part matches (substring) every scope under the search scope at any depth (and, for a one-part
  // query, every variable); each further part matches the direct children of a match. At most 100 entries, with the
  // total. vscode-port (11-25): the names come from one pass of children replies into a compact index (name_index.ts:
  // flat arrays, no NetlistItems; ~0.8 GB per 1M signals before), kept per file identity so a reopen reuses it. The
  // helper has no name search (15.12); a paged children / binary name list can fill the same index later.
  private topReply: any[] = [];
  private nameIndex: Promise<NameIndex> | null = null;
  private indexProgress: ((msg: string) => void)[] = [];

  private async indexKey(): Promise<string> {
    const st = await fs.promises.stat(this.uri.fsPath).catch(() => null);
    return [this.uri.fsPath, st ? st.size : -1, st ? st.mtimeMs : -1, this.state.outsideWrites].join('|');
  }

  private buildNameIndex(): Promise<NameIndex> {
    if (this.nameIndex) {return this.nameIndex;}
    const gen = this.generation;
    const build = async (): Promise<NameIndex> => {
      const key = await this.indexKey();
      const had = cachedIndex(key);
      if (had) {this.log(`netlist search index: reused (${had.scopes} scopes, ${had.vars} variables)`); return had;}
      const t0 = Date.now();
      const ix = new NameIndex();
      let level = ix.addChildren(-1, this.topReply, []);
      let lastNote = 0;
      while (level.length) {
        const next: {entry: number; scopeOffsetIdx: number}[] = [];
        for (let i = 0; i < level.length; i += 32) {  // at most 32 children requests in flight
          if (gen !== this.generation) {throw new Error('closed');}  // the file was closed or reloaded: stop
          const batch = level.slice(i, i + 32);
          const replies = await Promise.all(batch.map((n) => this.childrenReply(n.scopeOffsetIdx, ix.path(n.entry))));
          if (gen !== this.generation) {throw new Error('closed');}
          batch.forEach((n, j) => {next.push(...ix.addChildren(n.entry, replies[j].scopes, replies[j].vars));});
          if (Date.now() - lastNote > 250) {
            lastNote = Date.now();
            const msg = `Indexing names: ${ix.scopes.toLocaleString()} scopes, ${ix.vars.toLocaleString()} signals...`;
            for (const f of this.indexProgress) {try { f(msg); } catch { /* the quick pick is gone */ }}
          }
        }
        level = next;
      }
      this.log(`netlist search index: ${ix.scopes} scopes, ${ix.vars} variables in ${Date.now() - t0} ms`);
      keepIndex(key, ix);
      return ix;
    };
    this.nameIndex = build();
    this.nameIndex.catch(() => {if (gen === this.generation) {this.nameIndex = null;}});
    return this.nameIndex;
  }

  public async searchNetlist(searchString: string, scopeId: number, onProgress?: (msg: string) => void): Promise<NetlistSearchResult> {
    const empty = {totalResults: 0, searchResults: []};
    if (!searchString || !this.helper) {return empty;}
    const gen = this.generation;
    if (onProgress) {this.indexProgress.push(onProgress);}
    let ix: NameIndex;
    try { ix = await this.buildNameIndex(); } catch { return empty; } finally {
      if (onProgress) {this.indexProgress = this.indexProgress.filter((f) => f !== onProgress);}
    }
    if (gen !== this.generation) {return empty;}
    const r = ix.search(searchString, scopeId);
    return {totalResults: r.total, searchResults: r.hits};
  }

  // ---- reply checks: refusals, unverified answers, per-signal errors ----
  private onEvent(e: any) {
    if (e.event === 'fileRefused') {this.onRefused(String(e.error || 'refused'), Number(e.withdrawn) || 0);}
    else {this.log('event ' + JSON.stringify(e));}
  }

  // The file is refused (the lazy open's whole-file check, or any reply with code fileRefused). Everything
  // already shown stays: the viewer keeps its rows and loaded values; new reads fail.
  private onRefused(reason: string, withdrawn: number) {
    if (this.state.refused !== null) {return;}
    this.state.refused = reason;
    this.state.withdrawn = withdrawn;
    const name = path.basename(this.uri.fsPath);
    const shown = withdrawn > 0
      ? ` The values already shown (${withdrawn} answers) were read before this check finished and may be wrong; they stay on screen.`
      : ' What is already shown stays on screen.';
    const msg = `${name} was refused: the reader's whole-file check failed (${reason}).${shown} New values cannot be read from this file.`;
    this.setStatus('$(error) Waveform refused', msg);
    this.showError(msg);
  }

  // vscode-port: per-signal errors are classed (signal_errors.ts): a failed read of the file's bytes is damage (red
  // status + error message, once); a signal the helper does not read for another reason (computed in windows only, a
  // partial code-block write, a value the converted file lacks, ...) is a warning that says what it is, never red.
  private damagedErrors: string[] = [];
  // vscode-port: reason -> the signals it was said for (ids; a reply without ids counts each time). "N signals"
  // is the number of distinct signals, not of replies (a row read at every step was counted again each time).
  private unreadableErrors = new Map<string, Set<string>>(); // limits (warning)
  private unknownErrors = new Map<string, Set<string>>();    // neither a limit nor a byte failure (red, no "damaged")
  private noteErrors = new Map<string, Set<string>>();       // expected answers by SignalNoteKind (a neutral note)
  private anonErrors = 0;
  // req: the request the reply answers (valueAt errors[i] belong to req.signalIds[i]). vscode-port: an error for a
  // computed signal is a limit of the rules (warning), and a window head for one carries the row's "no value" text.
  private noteReply(line: any, req?: Record<string, any>) {
    if (!line) {return;}
    if (line.verified === false) {this.state.unverified++;}
    if (line.code === 'fileRefused') {this.onRefused(String(line.error), 0); return;}
    const errs: Array<{e: string; computed: boolean; id?: number}> = [];
    const r = line.result;
    const ids: any[] = req && Array.isArray(req.signalIds) ? req.signalIds : [];
    if (r && Array.isArray(r.errors)) {r.errors.forEach((e: any, i: number) => {if (e) {errs.push({e: String(e), computed: this.isComputedId(Number(ids[i])), id: ids[i] === undefined ? undefined : Number(ids[i])});}});}
    if (r && Array.isArray(r.signals)) {
      r.signals.forEach((h: any) => {
        if (!h || !h.error) {return;}
        const computed = this.isComputedId(Number(h.signalId));
        if (computed) {const nv = computedNoValueText(String(h.error)); if (nv) {h.noValue = nv;}}
        errs.push({e: String(h.error), computed, id: Number(h.signalId)});
      });
    }
    // vscode-port: the computed signals' memory-bound refusal comes for the whole request; noted too (a warning)
    if (line.error && !r && /computed names need about \d+ MiB .*memory room/i.test(String(line.error))) {
      const wids: any[] = req && Array.isArray(req.signals) ? req.signals.map((x: any) => x && x.signalId) : ids;
      if (wids.length) {for (const id of wids) {errs.push({e: String(line.error), computed: true, id: Number(id)});}}
      else {errs.push({e: String(line.error), computed: true});}
    }
    this.noteSignalErrors(errs);
  }
  private noteSignalErrors(list: Array<{e: string; computed: boolean; id?: number}>) {
    if (!list.length) {return;}
    const errs = list.map((x) => x.e);
    for (const e of errs) {if (this.state.signalErrors.length < 20 && !this.state.signalErrors.includes(e)) {this.state.signalErrors.push(e);}}
    let newRed = false;
    const add = (m: Map<string, Set<string>>, e: string, id?: number) => {
      let set = m.get(e);
      if (!set) {set = new Set(); m.set(e, set);}
      set.add(id !== undefined && Number.isFinite(id) ? String(id) : '?' + (this.anonErrors++));
    };
    for (const {e, computed, id} of list) {
      const k = classifySignalError(e, computed);
      const nk = k === 'damaged' ? null : signalNoteKind(e);
      if (nk) {add(this.noteErrors, nk, id);}
      else if (k === 'damaged') {if (!this.damagedErrors.includes(e)) {this.damagedErrors.push(e);} newRed = true;}
      else if (k === 'unknown') {add(this.unknownErrors, e, id); newRed = true;}
      else {add(this.unreadableErrors, e, id);}
    }
    const sizes = (m: Map<string, Set<string>>) => new Map([...m].map(([k, v]) => [k, v.size] as [string, number]));
    const st = signalErrorStatus(path.basename(this.uri.fsPath), this.damagedErrors, sizes(this.unreadableErrors), sizes(this.unknownErrors), sizes(this.noteErrors));
    if (!st) {return;}
    this.state.statusLevel = st.level;
    this.setStatus(st.text, st.message, st.level);
    if (st.level === 'error' && newRed && !this.errorShown) {this.errorShown = true; this.showError(st.message);}
    else {this.log(st.message);}
  }
  // e2e only (vaporview.e2e.wispNoteErrors): the status a reply with these per-signal errors leaves
  public e2eNoteErrors(errs: string[], computed = false, ids?: number[]): {status: string; level: string} {
    this.noteSignalErrors(errs.map((e, i) => ({e, computed, id: ids ? ids[i] : undefined})));
    return {status: this.state.status, level: String(this.state.statusLevel || '')};
  }

  // vscode-port: a signal id the helper computes (outsideWrites none port copy), for labelling it in Trace
  public isComputedId(id: number): boolean { return isComputed(this.state.computed, id) || this.windowOnly.has(id); }

  // vscode-port: signal ids the helper computes outside the stats range (it refused valueAt / edge / count for them
  // with "a computed signal answers window requests only", e.g. design H's 2-driver wire `bus`), learned per file, and
  // the 1-point windows [t, t+1] that answered them (bounded; both cleared on unload).
  private windowOnly = new Set<number>();
  private pointWindows = new Map<string, Promise<HelperReply>>();

  // e2e only (vaporview.e2e.wispForceWindowed): answer these stored ids through windows as if the helper had refused
  // them, so a test can compare the windowed answers with the helper's own (the oracle for computed rows).
  public e2eForceWindowed(ids: number[], on: boolean): number {
    for (const id of ids) { if (on) {this.windowOnly.add(Number(id));} else {this.windowOnly.delete(Number(id));} }
    this.pointWindows.clear();
    return this.windowOnly.size;
  }

  // One window request through a small cache when it is a 1-point read of one signal (what valueAt on a computed id asks).
  // After the document closed (or reloaded) nothing more is sent: the request answers 'document closed' (code
  // 'reloaded', which callers drop) instead of throwing, so computed windows still queued in a limiter end quietly.
  private askWindow(q: Record<string, any>, o?: (id: number) => void, gen = this.generation): Promise<HelperReply> {
    const helper = this.helper;
    if (!helper || gen !== this.generation) {return Promise.resolve({line: {error: DOCUMENT_CLOSED, code: 'reloaded'}, bin: null} as HelperReply);}
    const sig = Array.isArray(q.signals) && q.signals.length === 1 ? q.signals[0] : null;
    if (q.cmd !== 'window' || !sig || Number(q.t1) - Number(q.t0) > 1) {return helper.request(q, o);}
    const key = `${sig.signalId}:${sig.width}:${q.t0}:${q.t1}:${q.buckets}`;
    let p = this.pointWindows.get(key);
    if (!p) {
      const gen = this.generation;
      p = helper.request(q, o);
      p.then((r) => { if (r.line.error || gen !== this.generation) {this.pointWindows.delete(key);} }, () => this.pointWindows.delete(key));
      if (this.pointWindows.size >= 4096) {this.pointWindows.delete(this.pointWindows.keys().next().value as string);}
      this.pointWindows.set(key, p);
    }
    return p;
  }

  // vscode-port: one helper request; valueAt / edge / count naming computed ids are answered through windows (computed.ts):
  // the stats range up front, and any other id once the helper refused it as window-only.
  // vscode-port: the first read of a computed signal builds the file's derivations once per open (seconds on a large
  // FSDB: ~6 s for 1.5 GB on the team host). While a read waits on it, the status bar says so.
  private computedReady = false;
  private async ask(req: Record<string, any>, onId?: (id: number) => void, onPartial?: (r: HelperReply) => void): Promise<HelperReply> {
    const ids: unknown[] = Array.isArray(req.signals) ? req.signals.map((x: any) => x && x.signalId) : Array.isArray(req.signalIds) ? req.signalIds : [req.signalId];
    if (this.computedReady || !(this.state.computed || this.windowOnly.size) || !ids.some((id) => this.isComputedId(Number(id)))) {return this.askNow(req, onId, onPartial);}
    const gen = this.generation;
    let note: vscode.Disposable | null = null;
    const timer = setTimeout(() => {
      this.state.preparingNotes = (this.state.preparingNotes || 0) + 1;
      note = vscode.window.setStatusBarMessage(PREPARING_COMPUTED);
    }, 300);
    try {
      const r = await this.askNow(req, onId, onPartial);
      if (gen === this.generation && !(r.line && r.line.error && /computed names need about/i.test(String(r.line.error)))) {this.computedReady = true;}
      return r;
    } finally { clearTimeout(timer); (note as vscode.Disposable | null)?.dispose(); }
  }
  private async askNow(req: Record<string, any>, onId?: (id: number) => void, onPartial?: (r: HelperReply) => void): Promise<HelperReply> {
    const helper = this.helper;
    if (!helper) {return {line: {error: DOCUMENT_CLOSED, code: 'reloaded'}, bin: null} as HelperReply;}
    const gen = this.generation;
    const point = req.cmd === 'valueAt' || req.cmd === 'edge' || req.cmd === 'count' || req.cmd === 'search';
    if (!point) {return helper.request(req, onId, onPartial);}
    const viaWindows = async (): Promise<HelperReply | null> => {
      const r = await answerComputed((q, o) => this.askWindow(q, o, gen), req, (id) => this.isComputedId(Number(id)),
        (id) => this.signalInfo.get(id)?.width || 1, this.metadata.timeEnd, onId);
      if (gen !== this.generation) {return {line: {error: DOCUMENT_CLOSED, code: 'reloaded'}, bin: null} as HelperReply;}
      if (r) {this.state.computedAnswers++;}
      return r;
    };
    const first = await viaWindows();
    if (first) {return first;}
    const reply = await helper.request(req, onId, onPartial);
    // learn the ids the helper answers in windows only, then answer the request again through windows
    const res: any = reply.line && reply.line.result;
    const learned: number[] = [];
    if (req.cmd === 'valueAt' && res && Array.isArray(res.errors)) {
      res.errors.forEach((e: unknown, i: number) => { if (e && WINDOW_ONLY.test(String(e))) {learned.push(Number(req.signalIds[i]));} });
    } else if (req.cmd === 'count' && res && Array.isArray(res.counts)) {
      for (const c of res.counts) { if (c && c.error && WINDOW_ONLY.test(String(c.error))) {learned.push(Number(c.signalId));} }
    } else if (reply.line && reply.line.error && WINDOW_ONLY.test(String(reply.line.error))) {
      if (req.cmd === 'edge' || req.cmd === 'search') {learned.push(Number(req.signalId));}
      else if (Array.isArray(req.signalIds) && req.signalIds.length === 1) {learned.push(Number(req.signalIds[0]));}
    }
    if (!learned.length) {return reply;}
    for (const id of learned) {this.windowOnly.add(id);}
    this.log(`computed (window-only) signals learned from the helper: ${learned.join(', ')}`);
    return (await viaWindows()) || reply;
  }

  // vscode-port: a point read where the dump has no change at or before `t` (a signal with no
  // records at all, e.g. CVA6 i_encoder.packet_f_opt_ext_subformat[0], or a time before its first change) has no
  // value; the helper (15.12) answers "x" there. valueAt is asked with prev (free: the helper has the change at hand)
  // and such values become null with result.noValue[i] = {reason: 'noChange', text}. Computed ids are not touched.
  // OFF: "prev null" is also what a 4-state reg that stays at its initial x gives
  // (a-trace/a tb_a.dut.acc: VCS writes no record for it), and the helper's var type ("wire" for both) cannot tell
  // 2-state from 4-state. Until the helper says itself (MAC-BOX request: noValue for no-record points), x stays x.
  private async askValueAt(req: Record<string, any>, onId?: (id: number) => void): Promise<HelperReply> {
    if (!NO_CHANGE_FROM_PREV || req.prev === true) {return this.ask(req, onId);}
    const wantPrev = false;
    const reply = await this.ask(wantPrev ? req : {...req, prev: true}, onId);
    const res = reply.line && reply.line.result;
    if (!res || !Array.isArray(res.values) || !Array.isArray(res.prev) || res.prev.length !== res.values.length) {return reply;}
    const ids: number[] = Array.isArray(req.signalIds) ? req.signalIds : [];
    let noValue: any[] | undefined;
    res.values.forEach((v: unknown, i: number) => {
      if (res.prev[i] !== null || v === null || v === undefined || this.isComputedId(ids[i])) {return;}
      res.values[i] = null;
      (noValue ??= res.values.map(() => null))[i] = {reason: 'noChange', text: NO_CHANGE_TEXT};
    });
    if (noValue) {res.noValue = noValue;}
    if (!wantPrev) {delete res.prev;}
    return reply;
  }

  // ---- one helper query for extension-side features (trace, debugger, link, bridge) ----
  // Any helper command (window, valueAt, edge, search, count, derive, ...). The reply is checked like the
  // viewer's (refusals, unverified answers and unreadable signals reach the status bar). Never throws:
  //   {result, bin?, verified}  verified false = the whole-file check has not confirmed the file yet
  //   {error, code?}            helper error, helper gone, file reloaded meanwhile, or cancelled
  // opts.signal cancels it (the helper stops the request); opts.onPartial gets stream partials when the request
  // asks {stream: true}. A reply that arrives after the file was reloaded or closed is dropped (error 'reloaded').
  public async query(req: Record<string, unknown>, opts: {signal?: AbortSignal, onPartial?: (r: HelperReply) => void} = {}): Promise<{result?: any, bin?: Buffer | null, verified?: boolean, error?: string, code?: string}> {
    const helper = this.helper;
    if (!helper) {return {error: 'the file is not open'};}
    if (opts.signal?.aborted) {return {error: 'cancelled', code: 'cancelled'};}
    const gen = this.generation;
    const ids: number[] = [];
    const onAbort = () => { for (const id of ids) {helper.cancel(id);} };
    opts.signal?.addEventListener('abort', onAbort);
    try {
      const onId = (id: number) => { ids.push(id); if (opts.signal?.aborted) {helper.cancel(id);} };
      const {line, bin} = req.cmd === 'valueAt' ? await this.askValueAt(req, onId) : await this.ask(req, onId, opts.onPartial);
      if (gen !== this.generation) {return {error: 'reloaded', code: 'reloaded'};}
      this.noteReply(line, req);
      if (opts.signal?.aborted) {return {error: 'cancelled', code: 'cancelled'};}
      if (line.error || !line.result) {return {error: String(line.error || 'no answer'), code: line.code ? String(line.code) : undefined};}
      return {result: line.result, bin: bin ?? null, verified: line.verified !== false};
    } catch (e) {
      if (gen !== this.generation) {return {error: 'reloaded', code: 'reloaded'};}
      return {error: e instanceof Error ? e.message : String(e)};
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  // ---- protocol v2 relay (the window cache's requests) ----
  public windowingEnabled(): boolean {
    return vscode.workspace.getConfiguration('vaporview').get<boolean>('wisp.windowing') !== false;
  }

  // Remote mode (window_cache.ts REMOTE_*): vaporview.wisp.remoteMode auto = when VS Code runs the extension remotely
  // (Remote-SSH, containers, WSL: vscode.env.remoteName), or on / off.
  public remoteMode(): boolean {
    const m = vscode.workspace.getConfiguration('vaporview').get<string>('wisp.remoteMode') || 'auto';
    return m === 'on' || (m === 'auto' && !!vscode.env.remoteName);
  }

  // Test/perf only: vaporview.wisp.simulatedLink "<rtt ms>,<MB/s>" delays every request by half the RTT and every reply by
  // its bytes over a shared downlink plus half the RTT (in order), as a remote link would. "" = off.
  private link: {rtt: number; bps: number; free: number} | null = null;
  private linkFor(): {rtt: number; bps: number; free: number} | null {
    const v = String(vscode.workspace.getConfiguration('vaporview', this.uri).get<string>('wisp.simulatedLink') || '');
    const m = v.match(/^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/);
    if (!m) {this.link = null; return null;}
    const rtt = Number(m[1]), bps = Number(m[2]) * 1e6;
    if (!this.link || this.link.rtt !== rtt || this.link.bps !== bps) {this.link = {rtt, bps, free: 0};}
    return this.link;
  }

  // Sent before initViewport: the viewer starts windowed (protocol v2) or with whole signals.
  public beforeInitViewport(post: (m: Record<string, unknown>) => void) {
    this.viewerGeneration++; // vscode-port: was this.generation++ ("reloaded" for every read in flight at the first 'ready')
    this.byViewer.clear();
    this.cancelledViewer.clear();
    post({command: 'set-windowing', enabled: this.windowingEnabled(), remote: this.remoteMode()});
  }

  public async relayV2(req: any, post: (m: Record<string, unknown>) => void) {
    if (!req || typeof req !== 'object') {return;}
    const viewerId = req.id;
    if (!RELAYED.has(req.cmd)) {post({command: 'v2-reply', reply: {id: viewerId, error: 'not relayed: ' + String(req.cmd)}}); return;}
    if (!this.helper) {post({command: 'v2-reply', reply: {id: viewerId, error: 'no reader'}}); return;}
    if (req.cmd === 'cancel') {
      // The viewer cancels by its own id: the cancelled request's reply carries {cancelled}.
      const key = req.target ?? viewerId;
      const targets = this.byViewer.get(key);
      if (targets !== undefined) {
        this.state.cancels++;
        this.cancelledViewer.add(key);
        for (const t of targets) {this.helper.cancel(t);}
      }
      return;
    }
    this.state.relayed++;
    if (req.cmd === 'window') {this.state.windows++; if (req.deflateCounts === true) {this.state.windowsDeflateCounts++;}}
    const gen = this.generation, vgen = this.viewerGeneration; // vscode-port: + the viewer's
    const out = {...req};
    delete out.id;
    const ids: number[] = [];
    this.byViewer.set(viewerId, ids);
    const link = this.linkFor();
    if (link) {await new Promise((r) => setTimeout(r, link.rtt / 2));}  // simulated uplink
    const toViewer = (line: any, bin: Buffer | null) => {
      const reply = {...line, id: viewerId};
      delete reply.binLength;
      const send = () => {
        if (bin && bin.length) {
          post({command: 'v2-reply', reply, bin: exactBytes(bin)});
        } else {
          post({command: 'v2-reply', reply});
        }
      };
      if (!link) {send(); return;}
      // simulated downlink: one shared pipe (replies queue behind each other), then half the RTT
      const bytes = JSON.stringify(reply).length + (bin ? bin.length : 0);
      const now = Date.now();
      link.free = Math.max(now, link.free) + bytes / link.bps * 1000;
      setTimeout(send, link.free - now + link.rtt / 2);
    };
    try {
      if (req.cmd === 'window' && req.stream === true) {
        // Streamed window (the regression fix, see stream_relay.ts): partial frames as rows are ready.
        this.state.streamedWindows++;
        await relayStreamedWindow(this.helper, out, {
          native: this.state.nativeStream,
          onHelperId: (hid) => ids.push(hid),
          cancelled: () => gen !== this.generation || vgen !== this.viewerGeneration || this.cancelledViewer.has(viewerId),
          onChunkLine: (line) => this.noteReply(line),
          send: (frame, final) => {
            if (!final) {this.state.partialFrames++;}
            toViewer(frame.line, frame.bin);
          },
        });
        return;
      }
      if (req.cmd === 'searchText') {
        // wisp-helper 15.7 has no searchText: the extension host scans exact windows with the viewer's formatters
        // (text_search.ts).
        this.state.textSearches++;
        loadHostFormats();
        const width = Number(req.width) || this.signalInfo.get(req.signalId)?.width || 0;
        let result: any;
        try {
          result = await hostSearchText({...out, width}, {
            timeEnd: this.metadata.timeEnd,
            fileKey: String(gen),
            cancelled: () => gen !== this.generation || vgen !== this.viewerGeneration || this.cancelledViewer.has(viewerId),
            window: async (signalId, w, t0, t1, buckets) => {
              const {line, bin} = await this.helper!.request({cmd: 'window', signals: [{signalId, width: w}], t0, t1, buckets}, (hid) => ids.push(hid));
              const h = line.result && line.result.signals && line.result.signals[0];
              if (line.error || !h || h.error) {throw new Error(String(line.error || (h && h.error) || 'no reply'));}
              if (!h.exact) {return {exact: false, count: Number(h.count) || 0, recs: []};}
              const raw = zlib.inflateRawSync((bin || Buffer.alloc(0)).subarray(0, Number(h.bytes) || 0));
              const recs = h.text ? decodeTextRecords(raw) : decodeBitRecords(raw, w);
              return {exact: true, count: recs.length, recs};
            },
          });
        } catch (e) {
          if (gen === this.generation && vgen === this.viewerGeneration) {toViewer({error: e instanceof Error ? e.message : String(e)}, null);}
          return;
        }
        this.state.lastTextSearch = {ms: result.ms, chunks: result.chunks, formatted: result.formatted, distinct: result.distinct, found: typeof result.t === 'number', incomplete: result.incomplete};
        if (gen === this.generation && vgen === this.viewerGeneration) {toViewer({result}, null);}
        return;
      }
      delete out.stream;
      const {line, bin}: HelperReply = await this.ask(out, (hid) => ids.push(hid));
      if (gen !== this.generation || vgen !== this.viewerGeneration) {return;}  // the viewer was reset (reload or re-init) meanwhile
      this.noteReply(line, out);
      toViewer(line, bin);
    } finally {
      this.byViewer.delete(viewerId);
      this.cancelledViewer.delete(viewerId);
    }
  }

  // ---- whole signals (windowing off, bit slices) ----
  async getSignalData(signalIdList: SignalId[]): Promise<void> {
    if (!this.helper) {return;}
    const t1 = Math.max(1, this.metadata.timeEnd + 1);
    await Promise.all(signalIdList.map(async (signalId) => {
      const info = this.signalInfo.get(signalId) || {width: 1, text: false};
      const {line, bin} = await this.helper!.request({cmd: 'window', signals: [{signalId, width: info.width}], t0: 0, t1, buckets: wholeBuckets()});
      this.noteReply(line);
      const h = line.result && line.result.signals && line.result.signals[0];
      let changes: [number, string][] = [];
      let min = 0, max = 1, summary = false;
      if (!h || h.error || !bin) {
        this.log(`signal ${signalId}: ${line.error || (h && h.error) || 'no data'}`);
      } else {
        // vscode-port: a summary drawn as if exact is a wrong answer: the row is marked and the user told once per file.
        if (!h.exact) {
          summary = true;
          this.state.summarySignals++;
          this.log(`signal ${signalId}: more changes than one whole load holds; showing a summary`);
          this.noticeSummaryOnce();
        }
        const raw = zlib.inflateRawSync(bin.subarray(0, Number(h.bytes) || 0));
        changes = h.text ? decodeTextRecords(raw) : decodeBitRecords(raw, info.width);
        if (h.text && h.kind === 'real') {min = Number(h.min ?? 0); max = Number(h.max ?? 1);}
      }
      this.postMessageToWebview({
        command: 'update-waveform-chunk', signalId, transitionDataChunk: changes, totalChunks: 1, chunkNum: 0, min, max, summary,
      } as unknown as ValueChangeDataChunk as unknown as Record<string, unknown>);
    }));
  }

  private summaryNoticeShown = false;
  private noticeSummaryOnce() {
    if (this.summaryNoticeShown) {return;}
    this.summaryNoticeShown = true;
    this.state.messages.push(SUMMARY_NOTICE);
    void vscode.window.showWarningMessage(SUMMARY_NOTICE, 'Turn on windowing').then((pick) => {
      if (pick) {void vscode.workspace.getConfiguration('vaporview').update('wisp.windowing', true, vscode.ConfigurationTarget.Global);}
    });
  }

  async getEnumData(_enumList: EnumQueueEntry[]): Promise<void> { return; }

  // vscode-port: a requested name the dump lacks (a port copy or assign net the helper does not compute, e.g. with
  // vaporview.wisp.outsideWrites unset) is read through its connection by the shared resolver
  // (src/cmux/shared/port_resolve.ts via vaporview.trace.resolvePortValue, as inline values and trace do) and comes back
  // with `via`; when the design gives no value it comes back in the no-value state with the reason. A requested
  // name is never dropped silently.
  async getValuesAtTime(time: number, instancePaths: string[]): Promise<ValuesAtTimeResult[]> {
    if (!this.helper) {return [];}
    const found: {instancePath: string; signalId: number}[] = [];
    const missing: string[] = [];
    const absent = new Map<string, string>(); // vscode-port: the helper's own reason for a listed var with no values
    for (const p of instancePaths) {
      const item = await this.findTreeItemFn(p, undefined, undefined);
      if (item && item.signalId >= 0 && item.contextValue === 'netlistVar') {found.push({instancePath: p, signalId: item.signalId});}
      else if (!item || item.contextValue !== 'netlistScope') {
        missing.push(p);
        const u = item && (item as any).unavailable;
        if (u && u.reason) {absent.set(p, String(u.reason).replace(/ \(if the run had no force[^)]*\)$/, ''));}
      }
    }
    const byPath = new Map<string, ValuesAtTimeResult>();
    const nullAt: string[] = [];
    if (found.length) {
      const vreq = {cmd: 'valueAt', signalIds: found.map((f) => f.signalId), t: time};
      const {line} = await this.askValueAt(vreq);
      this.noteReply(line, vreq);
      if (line.error || !line.result) {this.log('valueAt: ' + (line.error || 'no answer'));}
      else {
        const values: any[] = line.result.values || [];
        const errors: any[] = line.result.errors || [];
        found.forEach((f, i) => {
          const nv = line.result.noValue && line.result.noValue[i];
          if (nv) {
            byPath.set(f.instancePath, {instancePath: f.instancePath, value: [], noValue: {reason: String(nv.reason), text: String(nv.text)}});
          } else if (errors[i]) {
            // vscode-port: a computed signal's refusal is a limit of the rules: "not computable: <reason>"
            const nvc = this.isComputedId(f.signalId) ? computedNoValueText(String(errors[i])) : null;
            const text = nvc || 'no value (unreadable: ' + String(errors[i]) + ')';
            byPath.set(f.instancePath, {instancePath: f.instancePath, value: [], noValue: {reason: nvc ? 'notComputable' : 'unreadable', text}});
          } else if (values[i] !== null && values[i] !== undefined) {
            byPath.set(f.instancePath, {instancePath: f.instancePath, value: [String(values[i])]});
          } else {
            nullAt.push(f.instancePath);  // vscode-port: no value and no reason from the helper: never an empty answer
          }
        });
      }
    }
    for (const p of missing) {
      const r = await this.resolveMissing(p, time);
      // vscode-port (0.1.1): when the resolver has no value either (no design: "not in the dump"; a design that cannot
      // place the name: notComputable/failed), a var the dump lists without values says why in the helper's words (an
      // unknown-mode port copy: "port copy: values not linked yet"), reason notDumped. A resolver reason that explains
      // the design side (dependsOnNoValue, noSingleDriver, cycle, depth, ...) is kept as it is.
      const why = absent.get(p);
      if (why && r.noValue && (r.noValue.reason === 'notDumped' || r.noValue.why === 'failed')) {
        r.noValue = {reason: 'notDumped', text: `no value (${why})`};
      }
      byPath.set(p, r);
    }
    for (const p of nullAt) {
      // the design may still give it (via its driver); else say the reader had none at this time
      const r = await this.resolveMissing(p, time);
      if (r.noValue && (r.noValue.reason === 'notDumped' || r.noValue.why === 'failed')) {r.noValue = {reason: 'noValueAtTime', text: 'no value (the reader has none at this time)'};}
      byPath.set(p, r);
    }
    return instancePaths.filter((p) => byPath.has(p)).map((p) => byPath.get(p)!);
  }

  private async resolveMissing(instancePath: string, time: number): Promise<ValuesAtTimeResult> {
    const none = (reason: string, why: string | undefined, text: string): ValuesAtTimeResult =>
      ({instancePath, value: [], noValue: why ? {reason, why, text} : {reason, text}});
    try {
      const x: any = await vscode.commands.executeCommand('vaporview.trace.resolvePortValue', {uri: this.uri.toString(), designPath: instancePath, time, quiet: true});
      if (x && typeof x.value === 'string' && typeof x.via === 'string') {return {instancePath, value: [x.value], via: x.via};}
      if (x && x.noValue) {return none(String(x.reason), x.why ? String(x.why) : undefined, String(x.text || 'no value'));}
    } catch (e) {
      this.log('valueAt ' + instancePath + ': resolver: ' + String((e as Error)?.message || e));
    }
    return none('notDumped', undefined, 'no value (not in the dump)');
  }

  // ---- driver tracing (src/cmux/trace/wisp_source.ts, through query() above) ----
  public get dumpEnd(): number { return Number(this.metadata.timeEnd) || 0; }
  public get dumpStart(): number { return Number((this.metadata as any).timeStart) || 0; }
  public get source(): string { return this.state.source || (this.uri.fsPath.split('.').pop() || '').toLowerCase(); }

  async unload(): Promise<void> {
    this.generation++;
    this.viewerGeneration++; // vscode-port
    this.helper?.close();
    this.helper = undefined;
    this.netlistTop = [];
    this.nameIndex = null; // vscode-port: the search index belongs to the file (the cache keys it by file identity)
    this.topReply = [];
    this.copies.clear();
    this.windowOnly.clear(); // vscode-port
    this.computedReady = false;
    this.pointWindows.clear();
    this.signalInfo.clear();
    this.byViewer.clear();
    this.metadata.timeTableLoaded = false;
  }

  dispose(): void {
    this.unload();
    this.statusItem?.dispose();
    this.statusItem = undefined;
  }
}
