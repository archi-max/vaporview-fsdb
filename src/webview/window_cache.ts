// Windowed waveform loading (protocol v2) for the VaporView webview.
//
// cmux addition, not part of upstream VaporView. Off unless the host sends
// {command: 'set-windowing', enabled: true}; without it every code path below is
// skipped and the viewer behaves like upstream (the one exception is an upstream bug
// fix in wavedrom.ts, which applies either way; see the README's CHANGES).
//
// A windowed signal never holds its whole value-change array. It holds a small set
// of windows, each one host reply to `window {signals, t0, t1, buckets}`:
//   exact     every change in [t0, t1) (the host sends this when count <= 2*buckets)
//   decimated per bucket the first and last change, plus per-bucket change counts
// Windows are power-of-two tiles: level L has buckets 2^L time units wide and 1024
// buckets per tile, so panning and zooming hit the same keys again. Rendering paints
// each row from the best window per time range (exact > decimated at the viewport's
// level > coarser > placeholder) with the stock renderers, clipped per range.
// Marker value, edge navigation, value search and WaveDrom copy answer locally when
// the loaded data decides the answer, and otherwise ask the host (valueAt / edge /
// search / window), one round trip.
//
// Hybrid mode (on by default): once the helper can tell a signal's whole-dump change count
// without a walk (window header `total`, or `count {exact: false}`), a signal with at most
// hybridMaxChanges changes (default 350000, and within the byte limits) is loaded whole, as
// one exact window, into dataManager.valueChangeData, after which it is an ordinary upstream
// signal: drawn, searched and navigated locally, with no host round trips, as in v1. Only
// big or dense signals stay windowed. Nothing here makes the helper walk a signal.
//
// Prefetch: besides one screen left/right and one level out, the next level in is loaded
// for the centre half of the view (a zoom-in finds its level loaded, exact or not). Host answers to edge
// and value search are kept as intervals (no match between the start and the answer), and
// while the marker sits, the next few edges of the selected windowed rows are asked for in
// the background, as is the next match after a value search lands. A step into what was
// prefetched needs no round trip; anything else needs one.
//
// Protocol. Viewer <-> host messages:
//   viewer -> host  {command: 'v2', req: {id, cmd, ...}}   (host forwards req to the helper)
//   host -> viewer  {command: 'v2-reply', reply: {id, result | error | cancelled}, bin?: ArrayBuffer}
import { type ValueChange, type SignalId, type RowId, type SignalQueueEntry, StateChangeType } from '../common/types';
import type { WaveformData } from './data_manager';
import { setRenderBounds } from './renderer';
import { NetlistVariable } from './signal_item';
import { viewport, viewerState, rowHandler, labelsPanel, vscodeWrapper, styles, events, dataManager } from './vaporview';
import { copyWaveDrom } from './wavedrom';
import { searchesBitPattern } from './value_format';
import { aliasSearchSource } from './extra_formats';
import { ActionType } from './event_handler';
import { minOf, maxOf } from '../common/arrays'; // vscode-port

const BUCKETS = 1024;      // per tile: a tile spans 512..1024 CSS px at its level
const WIDE_BUCKETS = 256;  // signals wider than 64 bits: a decimated 480-bit tile is ~4x smaller
const bucketsFor = (width: number) => (width > 64 ? WIDE_BUCKETS : BUCKETS);
const latin1 = new TextDecoder('latin1');
const QUERY_TIMEOUT_MS  = 8000;   // valueAt (the value display)
const LONG_QUERY_MS     = 120000; // edge / search / WaveDrom windows: may scan a long dump; Escape cancels
const WINDOW_TIMEOUT_MS = 10000;  // a window request older than this is cancelled and retried
const WINDOW_TIMEOUT_CAP = 180000; // ... but never waits longer than this (a lost reply must not hold tiles for ever)
const ADAPTIVE_TIMEOUT_CAP = 120000; // the RTT-based part alone: slow replies must not feed it without bound
const FAIL_SHOW_AFTER   = 3;      // failures in a row before a row says "unreadable"
const FAIL_MAX_BACKOFF  = 60000;  // a failing signal is retried at most once a minute
// vscode-port: refusals that last for the whole open (the helper does not try again until the file is reopened):
// the row says "no value (reason)" across it and is not asked again. The computed signals' first build is checked
// against the helper's memory bound (vaporview.wisp.planBudgetMB) once per open.
const FOR_THIS_OPEN: [RegExp, string][] = [
  [/computed names need about \d+ MiB .*memory room/i, 'no value (computed signals need more memory than vaporview.wisp.planBudgetMB allows)'],
];
const DENSE = /history over this request's memory room/i;
export const DENSE_TEXT = 'too dense at this zoom (zoom in to read)';
export function noValueForOpen(msg: string): string | null {
  for (const [re, text] of FOR_THIS_OPEN) {if (re.test(msg)) {return text;}}
  return null;
}
const STATS_KEEP        = 5000;
const VALUEAT_EVERY_MS  = 50;     // marker drag: at most one valueAt round trip per 50 ms
// Hybrid thresholds, from a sweep on a large FSDB dump (WKWebView, 20 signals, real helper; see
// www-window/README.md): up to 7 signals of <= 350k changes loaded whole left pan/zoom at
// 17/18 ms p50/p95; 9 signals up to 1M changes (2 GB WebContent RSS) or 18 (3.4 GB peak,
// pan p50 32 ms) did not.
const HYBRID_MAX_CHANGES = 350000;            // hybrid: signals with at most this many changes load whole
const HYBRID_MAX_BYTES   = 128 * 1024 * 1024; // ... and at most this many bytes (estimated, in the webview)
const HYBRID_BUDGET      = 512 * 1024 * 1024; // all whole-loaded signals together
const HYBRID_RETRY_MAX_MS = 30000;           // unknown counts / slow loads: asked again at most this far apart
const HYBRID_LOADS       = 2;                 // whole loads in flight at once
// vscode-port: remote mode (Remote-SSH etc.; verdict: round trips cost more than bytes there). Prefetch goes
// out in the same pass as the visible tiles (one round trip per pan, not one for the visible tiles and another for the
// rest), and the hybrid whole loads shrink and start only with nothing else in flight, one at a time, so the visible
// window never waits behind them on the downlink.
const REMOTE_HYBRID_MAX_CHANGES = 50000;
const REMOTE_HYBRID_BUDGET      = 16 * 1024 * 1024;
const REMOTE_HYBRID_LOADS       = 1;
const COUNT_BATCH        = 32;                // signals per count request
const MAX_HOST_BUCKETS   = 4194304;          // the helper clamps `buckets` to this
const SCAN_BUCKETS       = 32768; // formatted value search: exact chunks of up to 65536 changes
const TEXT_BUDGET_MS     = 5000;  // searchText: helper time per request; an unfinished one is resumed
const TEXT_MAX_PATTERN   = 4096;  // searchText's limit; longer searches use the page scan
const TEXT_FORMATS       = new Set(['riscv', 'riscv_numeric', 'riscv_noalias', 'riscv_numeric_noalias']);
const PREFETCH_DELAY_MS  = 80;   // the marker must sit this long before edges are prefetched
const PREFETCH_ROWS      = 4;    // selected windowed rows prefetched
const PREFETCH_AHEAD     = 3;    // edges / matches prefetched in the direction of travel ...
const PREFETCH_BACK      = 2;    // ... and the other way
const NAV_CACHE_KEEP     = 256;  // host answers kept per (signal, query, direction, kind)
// Estimated webview bytes per change of a whole-loaded signal: the [time, value] array, its
// number and string, and the upstream formatted-value cache. Fitted to the measured RSS
// growth (about 300 B per change for 1- to 5-bit signals, more for 32-bit ones).
const hybridBytesFor = (count: number, width: number) => count * (256 + 8 * width);
const pushStat = (arr: number[], v: number) => { arr.push(v); if (arr.length > STATS_KEEP) {arr.splice(0, arr.length - STATS_KEEP / 2);} };

interface Tile { level: number; index: number; t0: number; t1: number; key: string; priority: number; }

interface Win {
  key: string;
  level: number;
  t0: number;
  t1: number;
  buckets: number;
  exact: boolean;
  data: WaveformData;              // valueChangeData[0] is the value in effect at t0
  counts: Uint32Array | null;      // decimated only: changes per bucket
  hiddenAfter: Uint8Array | null;  // decimated only: 1 if unseen changes lie between record j and j+1
  bytes: number;
  lastUsed: number;
}

class SignalWindows {
  windows   = new Map<string, Win>();
  inflight  = new Set<string>();
  bytes     = 0;
  min       = 0;
  max       = 1;
  addedAt   = 0;
  firstDrawMs: number | null = null;
  valueAt: {t: number; value: string[]} | null = null;
  valueAtPending: number | null = null;
  // Failed window requests (decode error, malformed or missing reply, per-signal error,
  // timeout): back off exponentially, at most one try a minute; never a request loop.
  fails     = 0;
  failUntil = 0;
  failMsg   = '';
  timeouts  = 0;     // window requests that timed out in a row: back off only (a slow helper isn't a failing one)
  slowUntil = 0;
  painted   = new Set<string>(); // window keys the last render drew from (kept by evict)
  orphanSince: number | null = null;
  solo      = false; // failed (alone or in a batch): ask for it alone until it succeeds
  denseZoom = 0;     // vscode-port: the zoom at which the helper said the history is over its memory room (0: none)
  noValue   = '';    // vscode-port: a refusal for the whole open (FOR_THIS_OPEN): drawn across the row, never asked again
  // Hybrid mode: unknown -> asking -> known -> loading -> local (loaded whole), or windowed.
  hybrid: 'unknown' | 'asking' | 'known' | 'loading' | 'local' | 'windowed' = 'windowed';
  hybridTries   = 0;
  hybridRetryAt = 0;
  hybridCount   = 0; // whole-dump changes, once known
  hybridEst     = 0; // estimated bytes, while counted in hybridPending
  scanKey: string | null = null; // latest exact chunk of a formatted value search
  hybridSolo    = false; // was in a probe batch that failed as a whole: probe it alone
  loadQueryId: number | null = null; // the hybrid whole-signal load in flight
  constructor(public signalId: SignalId, public width: number) {}
}

// One request covers a contiguous run of tiles (same level); `buckets` is per tile.
interface InflightWindow { id: number; tiles: Tile[]; priority: number; buckets: number; signals: SignalId[]; sentAt: number; gen: number; timer: ReturnType<typeof setTimeout>;
  streamed?: Set<SignalId>; } // vscode-port: rows already answered by partial frames (window {stream: true})

// vscode-port (11-24 regression fix): a window over more than STREAM_CHUNK rows asks for {stream: true}: the host
// answers it as partial frames {id, partial: true, result: {signals}} (cmux helper-stream's contract) before the final
// one, so the first rows paint as soon as they are read instead of after the last row of the batch.
const STREAM_CHUNK = 16;

// A host edge/search answer from `start`: for any start in [lo, hi) (dir 1) or (lo, hi]
// (dir -1) the answer is `t` (null: no match that way).
interface NavAnswer { lo: number; hi: number; t: number | null; }
type NavCmd = {cmd: 'edge'; kind: 'any' | 'rise' | 'fall'} | {cmd: 'search'; value: string};

interface V2Reply {
  id: number;
  result?: any;
  error?: string;
  cancelled?: boolean;
  partial?: boolean; // vscode-port: a streamed window's partial frame
}

type Pred = (value: string) => boolean;

function upperBound(arr: ValueChange[], t: number) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m][0] <= t) {lo = m + 1;} else {hi = m;} }
  return lo;
}

function lowerBound(arr: ValueChange[], t: number) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m][0] < t) {lo = m + 1;} else {hi = m;} }
  return lo;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Records are [u64 LE delta time][width ASCII chars]; the first delta is from 0.
// vscode-port: text rows (reals, strings; the window header says `text: true`) come from wisp-helper as
// [u64 LE delta time][u32 LE length][bytes] records.
function parseTextRecords(raw: Uint8Array): ValueChange[] {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const utf8 = new TextDecoder();
  const out: ValueChange[] = [];
  let t = 0, o = 0;
  while (o + 12 <= raw.length) {
    t += dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
    const len = dv.getUint32(o + 8, true);
    out.push([t, utf8.decode(raw.subarray(o + 12, o + 12 + len))]);
    o += 12 + len;
  }
  return out;
}

function parseRecords(raw: Uint8Array, width: number, text = false): ValueChange[] {
  if (text) {return parseTextRecords(raw);} // vscode-port
  const rec = 8 + width;
  const n   = Math.floor(raw.length / rec);
  const dv  = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const s   = latin1.decode(raw); // one string, values are substrings of it
  const out: ValueChange[] = new Array(n);
  let t = 0;
  for (let i = 0, o = 0; i < n; i++, o += rec) {
    t += dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
    out[i] = [t, width === 1 ? s[o + 8] : s.substring(o + 8, o + rec)];
  }
  return out;
}

// Host search pattern (sent with wildcard '?'): MSB-first, exactly the signal width.
// '?' matches anything; '0' '1' 'x' 'z' are literal (upstream's '.' wildcard becomes '?';
// binary-format x/z stay literal as in upstream's regex). Short patterns are extended with
// '0', or with '1' for a negative signed value (its minimal two's complement form). So hex
// 5 means "== 5", not "contains 0101" as upstream's regex. A pattern whose extra high bits
// would change the value (hex 1FF on 8 bits) doesn't fit: null.
export function toHostPattern(parsedSearchValue: string, width: number, negative = false): string | null {
  let p = parsedSearchValue.replace(/^b/i, '');
  if (p === '.*') {return '?'.repeat(width);}
  p = p.toLowerCase().replace(/\./g, '?');
  if (!/^[01xz?]+$/.test(p)) {return null;}
  const pad = negative ? '1' : '0';
  if (p.length < width) {return pad.repeat(width - p.length) + p;}
  const extra = p.slice(0, p.length - width);
  const kept  = p.slice(p.length - width);
  if ([...extra].some((c) => c !== pad && c !== '?')) {return null;}
  if (negative && extra.length > 0 && kept[0] === '0') {return null;}
  return kept;
}

export function matchPattern(value: string, pattern: string) {
  if (value.length !== pattern.length) {return false;}
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charCodeAt(i);
    if (c !== 63 /* ? */ && c !== (value.charCodeAt(i) | 0x20)) {return false;} // values: 0 1 x z (any case)
  }
  return true;
}

export class WindowCache {
  enabled = false;
  maxBytesPerSignal   = 2 * 1024 * 1024; // soft: the current viewport's tiles are never evicted
  maxWindowsPerSignal = 32;
  debounceMs          = 16;
  windowTimeoutMs     = WINDOW_TIMEOUT_MS;
  windowTimeoutCap    = WINDOW_TIMEOUT_CAP;
  longQueryMs         = LONG_QUERY_MS;
  hybrid              = true;
  remote              = false; // vscode-port: see REMOTE_* above
  private visibleSince: number | null = null; // vscode-port: first visible request of the current wait (stats.visibleMs)
  prefetch            = true; // edge / search-match prefetch (tile prefetch is always on)
  hybridMaxChanges    = HYBRID_MAX_CHANGES;
  hybridMaxBytes      = HYBRID_MAX_BYTES;
  hybridBudget        = HYBRID_BUDGET;
  hybridBytes         = 0; // estimated bytes of the signals loaded whole
  private hybridPending = 0; // ... and of those being loaded
  countTimeoutMs        = QUERY_TIMEOUT_MS;
  private countSupported = true;
  private textSupported  = true; // the helper answers searchText (cleared by an unknown-command reply)
  private countBusy      = false;
  private loadsBusy      = 0;

  private signals  = new Map<SignalId, SignalWindows>();
  private inflight = new Map<number, InflightWindow>();
  private queries  = new Map<number, {resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private generation = 0; // bumped by reset(): continuations from an older file are dropped
  private wantedKeys = new Set<string>();
  private nextId   = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private redrawPending = false;
  private freeTimer: ReturnType<typeof setTimeout> | null = null;
  private valueAtBatch  = new Map<number, Set<SignalId>>();
  private valueAtBusy   = false;                                        // one valueAt in flight
  private valueAtNext: {t: number; ids: SignalId[]} | null = null;      // latest one waiting (marker drags)
  private valueAtLast = 0;                                              // when the last one was sent
  private valueAtTimer: ReturnType<typeof setTimeout> | null = null;
  private navBusy = false;
  private navQueued: (() => void) | null = null;
  private navEpoch = 0;          // bumped by cancelNav (Escape)
  private wavedromBusy = 0;      // WaveDrom copies fetching (they can overlap)
  private noticeEl: HTMLElement | null = null;  // "... timed out" note in the control bar
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private navQueries = new Set<number>(); // ids of edge / search / WaveDrom queries in flight
  private navCache = new Map<string, NavAnswer[]>(); // key: navKey()
  // In flight: navKey() + '@' + start. `prefetch` stays true until a user step joins it; such
  // queries are cancelled when the marker moves on (epoch).
  private navAsk = new Map<string, {id: number; p: Promise<number | null>; prefetch: boolean; epoch: number; sentAt: number}>();
  private lastEdgeKind: 'rise' | 'fall' = 'rise'; // the polarity prefetched besides 'any' on 1-bit rows
  private prefetchEpoch = 0;
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribed = false;
  private lastViewKey = '';
  private refine: {since: number; key: string} | null = null;

  stats = {
    requests: 0, cancels: 0, replies: 0, bytesIn: 0, queries: 0, decodeMs: 0, promoted: 0, prefetchQueries: 0, navHits: 0,
    firstDrawMs: [] as number[], promoteMs: [] as number[], refineMs: [] as number[], renderMs: [] as number[], rttMs: [] as number[], helperMs: [] as number[],
    partials: 0, firstPartMs: [] as number[], fullMs: [] as number[], // vscode-port: streamed windows (first frame / whole batch)
    navDone: 0, navMs: [] as number[], // vscode-port: finished edge/value searches and their times (last 50)
    slowSteps: [] as {step: string, ms: number, signalId: number, n: number, width: number}[], // vscode-port: main-thread steps over 50 ms (last 30)
    visibleMs: [] as number[], wholeLoads: 0, // vscode-port: visible-tile waits (last 50); hybrid whole loads started
    slow: [] as {ms: number; helperMs: number; workerMs: number; signals: SignalId[]; level: number; priority: number; at: number}[], // replies over 300 ms (last 50)
  };

  configure(message: {enabled: boolean; maxBytesPerSignal?: number; maxWindowsPerSignal?: number; debounceMs?: number; windowTimeoutMs?: number;
    hybrid?: boolean; hybridMaxChanges?: number; hybridMaxBytes?: number; hybridBudget?: number; prefetch?: boolean; remote?: boolean}) {
    this.enabled = !!message.enabled;
    if (message.maxBytesPerSignal)   {this.maxBytesPerSignal   = message.maxBytesPerSignal;}
    if (message.maxWindowsPerSignal) {this.maxWindowsPerSignal = message.maxWindowsPerSignal;}
    if (message.debounceMs !== undefined) {this.debounceMs = message.debounceMs;}
    if (message.windowTimeoutMs) {this.windowTimeoutMs = message.windowTimeoutMs;}
    if (message.hybrid !== undefined) {this.hybrid = !!message.hybrid;}
    if (message.prefetch !== undefined) {this.prefetch = !!message.prefetch;}
    if (message.hybridMaxChanges !== undefined) {this.hybridMaxChanges = message.hybridMaxChanges;}
    if (message.hybridMaxBytes !== undefined)   {this.hybridMaxBytes   = message.hybridMaxBytes;}
    if (message.hybridBudget !== undefined)     {this.hybridBudget     = message.hybridBudget;}
    if (message.remote !== undefined) { // vscode-port: remote mode
      this.remote = !!message.remote;
      if (this.remote) {
        this.hybridMaxChanges = Math.min(this.hybridMaxChanges, REMOTE_HYBRID_MAX_CHANGES);
        this.hybridBudget = Math.min(this.hybridBudget, REMOTE_HYBRID_BUDGET);
      }
    }
    // Debug/measurement hooks for the test harnesses.
    (window as any).__vvWindowing = this;
    (window as any).__vvDataManager = dataManager;
    (window as any).__vvLabels = labelsPanel;
    (window as any).__vvRows = rowHandler;
    if (!this.subscribed) {
      this.subscribed = true;
      events.subscribe(ActionType.MarkerSet, (_t, markerType, dragging) => {if (!dragging) {this.schedulePrefetch(markerType);}});
      events.subscribe(ActionType.SignalSelect, () => this.schedulePrefetch(0));
    }
    (window as any).__vvPatterns = {toHostPattern, matchPattern};
  }

  reset() {
    this.generation++;
    this.hideNotice();
    this.inflight.forEach((_f, id) => this.cancel(id));
    this.signals.clear();
    this.inflight.clear();
    // Settle every pending query, so navigation and WaveDrom never wait on a reply that
    // belongs to the old file (H1).
    const pending = [...this.queries.values()];
    this.queries.clear();
    pending.forEach((q) => {clearTimeout(q.timer); q.reject(new Error('reset'));});
    this.navBusy = false;
    this.navQueued = null;
    this.navQueries.clear();
    this.wantedKeys.clear();
    this.valueAtBatch.clear();
    this.valueAtBusy = false;
    this.valueAtNext = null;
    if (this.valueAtTimer !== null) {clearTimeout(this.valueAtTimer); this.valueAtTimer = null;}
    this.hybridBytes = 0;
    this.hybridPending = 0;
    this.countSupported = true;
    this.textSupported = true;
    this.countBusy = false;
    this.loadsBusy = 0;
    this.navCache.clear();
    this.navAsk.clear();
    this.prefetchEpoch++;
    if (this.prefetchTimer !== null) {clearTimeout(this.prefetchTimer); this.prefetchTimer = null;}
  }

  // A window request for this signal failed: back off (0.5 s, 1 s, 2 s ... at most a minute).
  // It is also asked for alone from now on, so a slow or failing signal can't delay the
  // replies for the others in its batch.
  // alone: the error is this signal's own (a per-signal error, or a request for it alone). A whole-batch refusal is
  // not taken as permanent for every row in it: each is asked alone next, and only its own answer can be.
  // nvText: the host's "no value" text for this row's own refusal (a computed signal: "not computable: <reason>").
  private fail(s: SignalWindows, msg: string, alone = true, nvText?: string) {
    const nv = alone ? (nvText || noValueForOpen(msg)) : null;
    if (nv) {
      if (!s.noValue) {vscodeWrapper.outputLog('window: signal ' + s.signalId + ': ' + msg);}
      s.noValue = nv; s.failMsg = msg; s.fails = Math.max(s.fails, FAIL_SHOW_AFTER); s.solo = true; s.failUntil = Infinity;
      this.scheduleRedraw();
      return;
    }
    // vscode-port: a window whose history is over the helper's memory room at this zoom is not asked again until
    // the user zooms in (a narrower window may fit); the row says so, as a warning (signal_errors: a limit).
    if (alone && DENSE.test(msg)) {
      if (!s.denseZoom) {vscodeWrapper.outputLog('window: signal ' + s.signalId + ': ' + msg);}
      s.denseZoom = viewport.zoomRatio || 1; s.failMsg = msg; s.fails = Math.max(s.fails, FAIL_SHOW_AFTER); s.solo = true; s.failUntil = Infinity;
      this.scheduleRedraw();
      return;
    }
    s.fails++;
    s.solo = true;
    s.failMsg = msg;
    s.failUntil = performance.now() + Math.min(FAIL_MAX_BACKOFF, 500 * 2 ** (s.fails - 1));
    if (s.fails === FAIL_SHOW_AFTER) {
      vscodeWrapper.outputLog('window: signal ' + s.signalId + ' unreadable: ' + msg);
      this.scheduleRedraw();
    }
    // Ask again when the backoff ends (nothing else may move the viewport).
    setTimeout(() => this.scheduleEnsure(0), Math.max(0, s.failUntil - performance.now()) + 5);
  }

  private unreadable(s: SignalWindows) {return s.fails >= FAIL_SHOW_AFTER;}

  // A window request timed out: the helper is slow (busy, cold walks), not failing. Wait
  // longer before asking again (1 s doubling to a minute), but don't send the signal alone
  // or call it unreadable (N2).
  private slow(s: SignalWindows) {
    s.timeouts++;
    s.slowUntil = performance.now() + Math.min(FAIL_MAX_BACKOFF, 1000 * 2 ** (s.timeouts - 1));
    if (s.timeouts === 1) {this.scheduleRedraw();} // show "loading (helper is slow)"
    setTimeout(() => this.scheduleEnsure(0), Math.max(0, s.slowUntil - performance.now()) + 5);
  }

  // Window timeout: at least windowTimeoutMs (10 s), longer when replies are slow (5x the p95
  // RTT), and doubled for each timeout in a row of the slowest signal in the request, so a
  // request that always takes longer than the base timeout still completes. RTT samples only
  // come from replies that made it, so without the doubling it would never grow. Capped.
  private windowTimeout(who: SignalWindows[] = []) {
    let ms = this.windowTimeoutMs;
    const r = this.stats.rttMs;
    if (r.length >= 20) {
      const recent = r.slice(-200).sort((a, b) => a - b);
      ms = Math.max(ms, Math.min(ADAPTIVE_TIMEOUT_CAP, 5 * recent[Math.floor(recent.length * 0.95)]));
    }
    const t = Math.min(8, Math.max(0, ...who.map((s) => s.timeouts)));
    return Math.min(this.windowTimeoutCap, ms * 2 ** t);
  }

  isWindowed(signalId: SignalId | undefined): boolean {
    return this.enabled && signalId !== undefined && this.signals.has(signalId) && dataManager.valueChangeData[signalId] === undefined;
  }

  // Called by dataManager.requestData. Returns the entries that still need the
  // whole-signal path (bit slices / custom signals read the full array).
  takeSignals(entries: SignalQueueEntry[]): SignalQueueEntry[] {
    if (!this.enabled) {return entries;}
    const rest: SignalQueueEntry[] = [];
    entries.forEach((entry) => {
      if (entry.customSignalId !== undefined) {
        // A bit slice reads its source whole through the v1 path: a hybrid load of that
        // source would transfer it a second time (review #5).
        const s = this.signals.get(entry.signalId);
        if (s) {this.loadedWholeElsewhere(s);}
        rest.push(entry);
        return;
      }
      if (!this.signals.has(entry.signalId)) {
        const s = new SignalWindows(entry.signalId, entry.signalWidth);
        s.addedAt = performance.now();
        // Already loaded whole (v1 path for a bit slice's source): an ordinary local signal.
        // Being fetched whole by v1 (the slice row came first): windows until it arrives.
        const v1 = this.v1Whole(entry.signalId);
        s.hybrid = v1 === 'loaded' ? 'local' : v1 === 'pending' || !this.hybrid ? 'windowed' : 'unknown';
        this.signals.set(entry.signalId, s);
      }
    });
    this.scheduleEnsure(0);
    this.scheduleRedraw();
    return rest;
  }

  // ---- levels and tiles ----
  private maxLevel() {
    return Math.max(0, Math.ceil(Math.log2(Math.max(viewport.timeStop, 1) / BUCKETS)));
  }

  private levelFor(pixelTime: number) {
    return Math.min(Math.max(0, Math.floor(Math.log2(pixelTime))), this.maxLevel());
  }

  private tilesFor(level: number, a: number, b: number, priority: number): Tile[] {
    const out: Tile[] = [];
    if (level > this.maxLevel()) {return out;}
    const span = BUCKETS * 2 ** level;
    const lo = Math.max(0, a);
    const hi = Math.min(b, viewport.timeStop);
    if (hi <= lo) {return out;}
    for (let i = Math.floor(lo / span); i * span < hi; i++) {
      out.push({level, index: i, t0: i * span, t1: (i + 1) * span, key: level + ':' + i, priority});
    }
    return out;
  }

  // An exact window at a coarser level already holds every change of this tile.
  private coveredExact(s: SignalWindows, tile: Tile) {
    const max = this.maxLevel();
    for (let l = tile.level; l <= max; l++) {
      const w = s.windows.get(l + ':' + Math.floor(tile.t0 / (BUCKETS * 2 ** l)));
      if (w && w.exact) {return true;}
    }
    return false;
  }

  private visibleSignals(): SignalWindows[] {
    const result = new Set<SignalWindows>();
    const top = viewport.pseudoScrollTop, bottom = top + viewport.viewerHeight;
    viewerState.visibleSignalsFlat.forEach((rowId) => {
      const item = rowHandler.rowItems[rowId];
      if (!(item instanceof NetlistVariable) || !this.isWindowed(item.signalId)) {return;}
      const bounds = viewport.getRowIdBounds(rowId);
      if (bounds === null || bounds[1] <= top || bounds[0] >= bottom) {return;}
      result.add(this.signals.get(item.signalId!)!);
    });
    return [...result];
  }

  // ---- request scheduling ----
  afterRender(startTime: number) {
    if (!this.enabled) {return;}
    pushStat(this.stats.renderMs, performance.now() - startTime);
    if (performance.now() - startTime > 50) {this.stats.slowSteps.push({step: 'render', ms: Math.round(performance.now() - startTime), signalId: -1, n: 0, width: 0});} // vscode-port
    const key = this.levelFor(viewport.pixelTime) + ':' + viewport.timeScrollLeft + ':' + viewport.timeScrollRight + ':' + viewport.pseudoScrollTop;
    if (key !== this.lastViewKey) {
      this.lastViewKey = key;
      this.refine = {since: performance.now(), key};
    }
    this.scheduleEnsure(this.debounceMs);
  }

  // Leading-edge throttle: a lone viewport change asks at once; a continuous pan/zoom
  // asks at most once per `delay` ms.
  private lastEnsure = 0;
  private scheduleEnsure(delay: number) {
    if (this.timer !== null) {return;}
    const wait = Math.max(0, this.lastEnsure + delay - performance.now());
    this.timer = setTimeout(() => {this.timer = null; this.lastEnsure = performance.now(); this.ensure();}, wait);
  }

  private wantedTiles(): Tile[] {
    const L = viewport.timeScrollLeft, R = viewport.timeScrollRight;
    if (!(R > L)) {return [];}
    const level = this.levelFor(viewport.pixelTime);
    const span  = R - L;
    const all = [
      ...this.tilesFor(level, L, R, 0),                      // what's on screen
      ...this.tilesFor(level + 1, L - span, R + span, 1),    // one zoom level out
      ...this.tilesFor(level, L - span, L, 2),               // one screen left
      ...this.tilesFor(level, R, R + span, 2),               // one screen right
      ...(level > 0 ? this.tilesFor(level - 1, L + span / 4, R - span / 4, 3) : []), // one level in, centre half
    ];
    const byKey = new Map<string, Tile>();
    all.forEach((t) => { const old = byKey.get(t.key); if (!old || t.priority < old.priority) {byKey.set(t.key, t);} });
    return [...byKey.values()].sort((a, b) => a.priority - b.priority);
  }

  private ensure() {
    if (!this.enabled || events.isBatchMode) {return;}
    this.freeRemoved();
    const now   = performance.now();
    // zoomed in well past where the history was too dense: the row is read again (from the cache, or asked)
    const zoomedIn = (s: SignalWindows) => {
      if (!(s.denseZoom > 0 && (viewport.zoomRatio || 0) > s.denseZoom * 1.9)) {return false;}
      s.denseZoom = 0; s.fails = 0; s.failUntil = 0; s.failMsg = ''; s.solo = false;
      this.scheduleRedraw();
      return true;
    };
    const sigs  = this.visibleSignals().filter((s) => (now >= s.failUntil || zoomedIn(s)) && now >= s.slowUntil);
    const tiles = this.wantedTiles();
    this.wantedKeys = new Set(tiles.map((t) => t.key));

    // Drop requests the viewport no longer needs.
    this.inflight.forEach((f, id) => {
      if (!f.tiles.some((t) => this.wantedKeys.has(t.key))) {this.cancel(id);}
    });

    // Batched requests: per run of contiguous tiles (same level and priority) and bucket
    // count, one request for every visible signal missing any tile of the run. Prefetch
    // (zoom-out, left/right) waits until what's on screen is answered, so it never sits
    // ahead of the visible tiles in the helper's queue or on the wire. A signal that was in
    // a batch the host rejected as a whole goes alone, so it can't hold the others back.
    let visiblePending = false;
    this.inflight.forEach((f) => {if (f.priority === 0) {visiblePending = true;}});
    // vscode-port: stats.visibleMs, from the first visible request of a wait to no visible request in flight
    if (!visiblePending && this.visibleSince !== null) {
      this.stats.visibleMs.push(performance.now() - this.visibleSince); if (this.stats.visibleMs.length > 50) {this.stats.visibleMs.shift();}
      this.visibleSince = null;
    }
    const covered = new Map<string, boolean>(); // coveredExact per (signal, tile) for this pass
    const missing = (s: SignalWindows, t: Tile) => {
      if (s.windows.has(t.key) || s.inflight.has(t.key)) {return false;}
      const k = s.signalId + '/' + t.key;
      let c = covered.get(k);
      if (c === undefined) {c = this.coveredExact(s, t); covered.set(k, c);}
      return !c;
    };
    const runs: Tile[][] = [];
    tiles.forEach((t) => {
      const last = runs[runs.length - 1];
      const prev = last && last[last.length - 1];
      if (prev && prev.level === t.level && prev.priority === t.priority && prev.index + 1 === t.index) {last.push(t);}
      else {runs.push([t]);}
    });
    const groups: {buckets: number; sigs: SignalWindows[]}[] = [];
    [BUCKETS, WIDE_BUCKETS].forEach((buckets) => {
      const g = sigs.filter((s) => bucketsFor(s.width) === buckets);
      // A batch that timed out twice is split in half, and again for each further timeout
      // (still batched, not solo), so one slow wide signal can't hold up the rest (N2).
      groups.push({buckets, sigs: g.filter((s) => !s.solo && s.timeouts < 2)});
      // Each timeout level is split on its own (2^(t-1) parts), so signals that just became
      // slow are halved, not cut as finely as one that has timed out many times.
      const levels = new Map<number, SignalWindows[]>();
      g.filter((s) => !s.solo && s.timeouts >= 2).forEach((s) => {
        const t = Math.min(8, s.timeouts);
        if (!levels.has(t)) {levels.set(t, []);}
        levels.get(t)!.push(s);
      });
      levels.forEach((slow, t) => {
        slow.sort((a, b) => a.signalId - b.signalId);
        const parts = Math.min(slow.length, 2 ** (t - 1));
        const size = Math.ceil(slow.length / parts);
        for (let k = 0; k < slow.length; k += size) {groups.push({buckets, sigs: slow.slice(k, k + size)});}
      });
      g.filter((s) => s.solo).forEach((s) => groups.push({buckets, sigs: [s]}));
    });
    runs.forEach((run) => {
      if (run[0].priority > 0 && visiblePending && !this.remote) {return;} // vscode-port: remote pipelines prefetch
      groups.forEach(({buckets, sigs: group}) => {
        const needed = run.filter((t) => group.some((s) => missing(s, t)));
        if (needed.length === 0) {return;}
        const span = run.slice(run.indexOf(needed[0]), run.indexOf(needed[needed.length - 1]) + 1);
        const who = group.filter((s) => span.some((t) => missing(s, t)));
        this.sendWindow(span, run[0].priority, buckets, who);
        if (run[0].priority === 0) {visiblePending = true; if (this.visibleSince === null) {this.visibleSince = performance.now();}}
      });
    });
    // Hybrid probes wait for what's on screen, like prefetch: they must not delay the first draw.
    if (!visiblePending && (!this.remote || this.inflight.size === 0)) {this.hybridStep();} // vscode-port: remote: only on an idle link
    this.checkRefined(sigs, tiles);
  }

  // ---- hybrid mode ----
  // A signal's whole-dump change count comes from the helper without a walk: the `total` in a
  // window reply header (once the helper has the signal stored), or `count {exact: false}`,
  // which answers only stored signals and says unknown for the rest. Unknown is asked again
  // later (1 s doubling to 30 s, never given up), so a signal is decided once its first
  // windows have been read. A small one is then loaded whole with one exact window, at most
  // HYBRID_LOADS at a time, visible rows first; all of it waits for the visible tiles.
  private hybridStep() {
    if (!this.hybrid) {return;}
    this.askCounts();
    this.startLoads();
  }

  private hybridOrder(list: SignalWindows[]) {
    const vis = new Set(this.visibleSignals());
    return list.sort((x, y) => (vis.has(x) ? 0 : 1) - (vis.has(y) ? 0 : 1) || x.signalId - y.signalId);
  }

  private askCounts() {
    if (!this.countSupported || this.countBusy) {return;}
    const now = performance.now();
    const want = this.hybridOrder([...this.signals.values()].filter((s) => s.hybrid === 'unknown' && now >= s.hybridRetryAt && !this.settleIfV1(s)));
    if (want.length === 0) {return;}
    const solo = want.find((s) => s.hybridSolo);
    const group = solo ? [solo] : want.slice(0, COUNT_BATCH);
    group.forEach((s) => {s.hybrid = 'asking';});
    this.countBusy = true;
    const gen = this.generation;
    const {reply} = this.query('count', {signalIds: group.map((s) => s.signalId), exact: false}, this.countTimeoutMs);
    reply.then(({result}) => {
      if (gen !== this.generation) {return;}
      const list: any[] = Array.isArray(result?.counts) ? result.counts : [];
      list.forEach((c) => {
        const s = this.signals.get(c?.signalId);
        if (!s || s.hybrid !== 'asking' || !group.includes(s)) {return;}
        try {
          if (c.error) {s.hybrid = 'windowed'; return;} // the helper can't read it: final
          if (c.unknown || typeof c.count !== 'number') {this.hybridLater(s); return;}
          this.decideCount(s, c.count);
        } catch {
          this.hybridLater(s);
        }
      });
      group.forEach((s) => {if (s.hybrid === 'asking') {this.hybridLater(s);}}); // left out of the reply
    }, (e) => {
      if (gen !== this.generation) {return;}
      const timedOut = !!(e && e.timedOut);
      const msg = String(e && e.message);
      if (!timedOut && /unknown (cmd|command)|not supported|unsupported/i.test(msg)) {
        // An older helper: decide from window headers only.
        this.countSupported = false;
        group.forEach((s) => {if (s.hybrid === 'asking') {s.hybrid = 'unknown';}});
        return;
      }
      group.forEach((s) => {
        if (s.hybrid !== 'asking') {return;}
        // A failed batch (one unknown id fails the request): ask each alone, so one can't
        // block the others. Alone: a timeout is asked again later; an error is final.
        if (group.length > 1) {s.hybridSolo = true; s.hybrid = 'unknown'; s.hybridRetryAt = 0;}
        else if (timedOut) {this.hybridLater(s);}
        else {s.hybrid = 'windowed';}
      });
    }).finally(() => {
      if (gen !== this.generation) {return;}
      this.countBusy = false;
      this.scheduleEnsure(0);
    });
  }

  // Count not known yet (or the helper was slow): ask again later. Never final.
  private hybridLater(s: SignalWindows, state: 'unknown' | 'known' = 'unknown') {
    s.hybridTries++;
    s.hybrid = state;
    const delay = Math.min(HYBRID_RETRY_MAX_MS, 1000 * 2 ** Math.min(10, s.hybridTries - 1));
    s.hybridRetryAt = performance.now() + delay;
    setTimeout(() => this.scheduleEnsure(0), delay + 5);
  }

  private decideCount(s: SignalWindows, count: number) {
    if (s.hybrid !== 'unknown' && s.hybrid !== 'asking') {return;}
    const est = hybridBytesFor(count, s.width);
    if (count > this.hybridMaxChanges || est > this.hybridMaxBytes || this.hybridBytes + est > this.hybridBudget) {
      s.hybrid = 'windowed';
      return;
    }
    // Over budget only with the loads still pending: those may fail and free it, so decide
    // again later rather than for good (review L3).
    if (this.hybridBytes + this.hybridPending + est > this.hybridBudget) {
      this.hybridLater(s);
      return;
    }
    s.hybrid = 'known';
    s.hybridCount = count;
    s.hybridEst = est;
    s.hybridTries = 0;
    s.hybridRetryAt = 0;
    this.hybridPending += est;
    this.scheduleEnsure(0);
  }

  private startLoads() {
    const now = performance.now();
    const ready = this.hybridOrder([...this.signals.values()].filter((s) => s.hybrid === 'known' && now >= s.hybridRetryAt && !this.settleIfV1(s)));
    const most = this.remote ? REMOTE_HYBRID_LOADS : HYBRID_LOADS; // vscode-port
    while (this.loadsBusy < most && ready.length > 0) {this.loadWhole(ready.shift()!);}
  }

  // Whether the v1 (whole-signal) path holds the signal or is fetching it: a bit slice reads
  // its source that way, whatever order the rows were added in (session or undo restores).
  private v1Whole(id: SignalId): 'loaded' | 'pending' | null {
    if (dataManager.valueChangeData[id] !== undefined) {return 'loaded';}
    const temp = dataManager.valueChangeDataTemp[id];
    return temp && temp.customSignalIdList && temp.customSignalIdList.length > 0 ? 'pending' : null;
  }

  // Before a count or a hybrid load: a signal v1 has (or is fetching) needs neither (review
  // verify N1: the guard at cache entry alone missed a source added after its slice's fetch).
  private settleIfV1(s: SignalWindows): boolean {
    const v1 = this.v1Whole(s.signalId);
    if (v1 === null) {return false;}
    if (v1 === 'loaded') {
      if (s.hybrid === 'known' || s.hybrid === 'loading') {this.unpend(s);}
      if (s.hybrid === 'loading' && s.loadQueryId !== null) {s.hybrid = 'local'; this.cancelQuery(s.loadQueryId, 'cancelled');}
      s.hybrid = 'local';
    } else {
      this.loadedWholeElsewhere(s);
    }
    return true;
  }

  // The signal is being loaded whole by the v1 path (a bit slice's source): no hybrid load.
  // Its windows serve it until the whole data arrives (then isWindowed() is false).
  private loadedWholeElsewhere(s: SignalWindows) {
    if (s.hybrid === 'local') {return;} // already whole: nothing in flight
    const loading = s.hybrid === 'loading';
    if (s.hybrid === 'known' || loading) {this.unpend(s);}
    s.hybrid = 'windowed'; // before the cancel, so the load's rejection is ignored
    if (loading && s.loadQueryId !== null) {this.cancelQuery(s.loadQueryId, 'cancelled');}
  }

  private unpend(s: SignalWindows) {
    this.hybridPending -= s.hybridEst;
    s.hybridEst = 0;
  }

  // One exact window of the whole dump: the signal as v1 would hold it.
  // vscode-port: time one main-thread step; steps over 50 ms are kept in stats.slowSteps (the e2e memory test
  // reports them with the page's long tasks).
  private timed<T>(step: string, s: {signalId: number, width: number}, n: number, fn: () => T): T {
    const t0 = performance.now();
    try { return fn(); } finally {
      const ms = performance.now() - t0;
      if (ms > 50) {this.stats.slowSteps.push({step, ms: Math.round(ms), signalId: s.signalId, n, width: s.width}); if (this.stats.slowSteps.length > 30) {this.stats.slowSteps.shift();}}
    }
  }

  private loadWhole(s: SignalWindows) {
    this.stats.wholeLoads++; // vscode-port
    if (this.settleIfV1(s)) {return;}
    s.hybrid = 'loading';
    this.loadsBusy++;
    const gen = this.generation, t1 = viewport.timeStop + 1;
    const buckets = Math.min(MAX_HOST_BUCKETS, Math.ceil(s.hybridCount / 2) + 1);
    const final = () => {this.unpend(s); s.hybrid = 'windowed';};
    const {id, reply} = this.query('window', {signals: [{signalId: s.signalId, width: s.width}], t0: 0, t1, buckets}, this.longQueryMs);
    s.loadQueryId = id;
    reply.then(async ({result, bin}) => {
      if (gen !== this.generation) {return;}
      const [d] = await this.decodeSignals(result, bin || new Uint8Array(0), buckets);
      if (gen !== this.generation || s.hybrid !== 'loading') {return;}
      if (!d || d.h.signalId !== s.signalId) {this.hybridLater(s, 'known'); return;}
      if (d.h.error) {final(); return;}
      if (d.err !== null || d.raw === null) {this.hybridLater(s, 'known'); return;}
      if (!d.h.exact) {final(); return;}
      const records = this.timed('whole.parseRecords', s, d.raw.length, () => parseRecords(d.raw!, s.width, !!d.h.text)); // vscode-port: text rows
      if (records.length === 0 || records[0][0] !== 0) {this.hybridLater(s, 'known'); return;}
      const est = s.hybridEst;
      this.unpend(s);
      this.promote(s, records, d.h.min ?? 0, d.h.max ?? 1, est);
    }, (e) => {
      if (gen !== this.generation || s.hybrid !== 'loading') {return;}
      if (e && e.timedOut) {this.hybridLater(s, 'known');} else {final();}
    }).catch(() => {
      if (gen === this.generation && s.hybrid === 'loading') {this.hybridLater(s, 'known');}
    }).finally(() => {
      if (s.loadQueryId === id) {s.loadQueryId = null;}
      if (gen !== this.generation) {return;}
      this.loadsBusy--;
      this.scheduleEnsure(0);
    });
  }

  // Signals whose hybrid decision is still open and being worked on (measurement hook):
  // not counting those the helper said it doesn't know yet.
  hybridPendingCount() {
    let n = 0;
    this.signals.forEach((s) => {
      if (s.hybrid === 'asking' || s.hybrid === 'known' || s.hybrid === 'loading' || (s.hybrid === 'unknown' && s.hybridTries === 0)) {n++;}
    });
    return n;
  }

  // Install a whole signal the way the v1 path does (dataManager.updateWaveform): from now
  // on isWindowed() is false for it and every upstream code path reads valueChangeData.
  private promote(s: SignalWindows, records: ValueChange[], min: number, max: number, est: number) {
    s.hybrid = 'local';
    s.windows.clear(); s.bytes = 0; s.painted.clear(); s.valueAt = null; s.inflight.clear();
    this.inflight.forEach((f, id) => {if (f.signals.length === 1 && f.signals[0] === s.signalId) {this.cancel(id);}});
    if (dataManager.valueChangeData[s.signalId] !== undefined) {return;}
    dataManager.valueChangeData[s.signalId] = {
      valueChangeData: this.timed('whole.removeGlitch', s, records.length, () => dataManager.removeGlitchTransitions(records)),
      formattedValues: {}, signalWidth: s.width, min, max,
    };
    this.hybridBytes += est;
    this.stats.promoted++;
    pushStat(this.stats.promoteMs, performance.now() - s.addedAt);
    this.rowsOf(s.signalId).forEach((item) => {
      labelsPanel.valueAtMarker[item.rowId] = item.getValueAtTime(viewerState.markerTime);
      this.timed('whole.redrawVariable', s, records.length, () => events.redrawVariable(item.rowId));
      if (item.encoding === "Real") {item.min = min; item.max = max;}
      this.timed('whole.setValueFormat', s, records.length, () => rowHandler.setValueFormat(item.getWaveformData(), item.valueFormat, false));
    });
    this.timed('whole.renderValueDisplay', s, records.length, () => labelsPanel.renderValueDisplay());
    this.scheduleRedraw();
  }

  private sendWindow(span: Tile[], priority: number, buckets: number, who: SignalWindows[]) {
    const id = this.nextId++;
    who.forEach((s) => span.forEach((t) => s.inflight.add(t.key)));
    // A reply that never comes (lost on the wire, helper restart) must not keep these tiles
    // "in flight" forever: expire, count a failure, ask again after the backoff (M7).
    const timer = setTimeout(() => {
      const f = this.inflight.get(id);
      if (!f) {return;}
      this.cancel(id);
      f.signals.forEach((sid) => {const s = this.signals.get(sid); if (s) {this.slow(s);}});
    }, this.windowTimeout(who));
    this.inflight.set(id, {id, tiles: span, priority, buckets, signals: who.map((s) => s.signalId), sentAt: performance.now(), gen: this.generation, timer});
    this.stats.requests++;
    vscodeWrapper.sendV2Request({id, cmd: 'window', signals: who.map((s) => ({signalId: s.signalId, width: s.width})),
      t0: span[0].t0, t1: span[span.length - 1].t1, buckets: buckets * span.length, deflateCounts: true, // vscode-port: deflated counts
      ...(who.length > STREAM_CHUNK ? {stream: true} : {})}); // vscode-port: streamed
  }

  // Signals no longer shown in any row drop their windows after a few seconds (M8). The
  // small SignalWindows record stays, so a row that comes back (undo, re-add) loads again.
  private freeRemoved() {
    const shown = new Set<SignalId>();
    viewerState.displayedSignalsFlat.forEach((rowId) => {
      const item = rowHandler.rowItems[rowId];
      if (item instanceof NetlistVariable && item.signalId !== undefined) {shown.add(item.signalId);}
    });
    const now = performance.now();
    this.signals.forEach((s) => {
      if (shown.has(s.signalId)) {s.orphanSince = null; return;}
      if (s.orphanSince === null) {s.orphanSince = now; return;}
      if (now - s.orphanSince < 5000 || s.windows.size === 0) {return;}
      s.windows.clear(); s.bytes = 0; s.painted.clear(); s.valueAt = null;
      this.inflight.forEach((f, id) => {if (f.signals.length === 1 && f.signals[0] === s.signalId) {this.cancel(id);}});
    });
    if (this.freeTimer === null && [...this.signals.values()].some((s) => s.orphanSince !== null && s.windows.size > 0)) {
      this.freeTimer = setTimeout(() => {this.freeTimer = null; this.scheduleEnsure(0);}, 5100);
    }
  }

  // Refinement = every visible signal has data at the viewport's own level (or exact) on screen.
  private checkRefined(sigs: SignalWindows[], tiles: Tile[]) {
    if (!this.refine) {return;}
    const visible = tiles.filter((t) => t.priority === 0);
    // Signals the host keeps failing on (unreadable) or timing out on (slow) don't hold refinement up.
    const done = sigs.every((s) => s.fails > 0 || s.timeouts > 0 || visible.every((t) => s.windows.has(t.key) || this.coveredExact(s, t)));
    if (done) {
      pushStat(this.stats.refineMs, performance.now() - this.refine.since);
      this.refine = null;
    }
  }

  private cancel(id: number) {
    const f = this.inflight.get(id);
    if (!f) {return;}
    clearTimeout(f.timer);
    this.inflight.delete(id);
    this.clearInflight(f);
    this.stats.cancels++;
    vscodeWrapper.sendV2Request({id, cmd: 'cancel'});
  }

  private clearInflight(f: InflightWindow) {
    f.signals.forEach((sid) => {const s = this.signals.get(sid); if (s) {f.tiles.forEach((t) => s.inflight.delete(t.key));}});
  }

  private scheduleRedraw() {
    if (this.redrawPending) {return;}
    this.redrawPending = true;
    requestAnimationFrame(() => {
      this.redrawPending = false;
      viewport.renderAllWaveforms();
    });
  }

  // ---- replies ----
  handleReply(message: {reply: V2Reply; bin?: ArrayBuffer | Uint8Array | string}) {
    const reply = message.reply;
    let bin: Uint8Array | null = null;
    if (typeof message.bin === 'string') {
      const b = atob(message.bin); bin = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) {bin[i] = b.charCodeAt(i);}
    } else if (message.bin) {
      bin = message.bin instanceof Uint8Array ? message.bin : new Uint8Array(message.bin);
    }
    this.stats.replies++;
    if (bin) {this.stats.bytesIn += bin.length;}

    const q = this.queries.get(reply.id);
    if (q) {
      this.queries.delete(reply.id);
      clearTimeout(q.timer);
      if (reply.error || reply.cancelled) {q.reject(new Error(reply.error || 'cancelled'));}
      else {q.resolve({result: reply.result, bin});}
      return;
    }
    const f = this.inflight.get(reply.id);
    // Not ours any more (cancelled, timed out, from before a reset): don't even inflate it.
    if (!f) {return;}
    // vscode-port: a partial frame stores its rows now; the request stays in flight until the final frame.
    if (reply.partial) {
      if (!reply.result || !Array.isArray(reply.result.signals)) {return;}
      const rows = (reply.result.signals as any[]).map((h) => h.signalId).filter((sid: SignalId) => f.signals.includes(sid));
      if (!f.streamed) {
        f.streamed = new Set();
        pushStat(this.stats.firstPartMs, performance.now() - f.sentAt);
      }
      rows.forEach((sid: SignalId) => f.streamed!.add(sid));
      this.stats.partials++;
      this.storeWindows({...f, signals: rows}, reply.result, bin || new Uint8Array(0));
      return;
    }
    this.inflight.delete(reply.id);
    clearTimeout(f.timer);
    if (reply.cancelled) {this.clearInflight(f); return;}
    // vscode-port: the final frame of a streamed window answers only the rows no partial frame did.
    const rest = f.streamed ? f.signals.filter((sid) => !f.streamed!.has(sid)) : f.signals;
    if (f.streamed || (reply.result && typeof reply.result.parts === 'number')) {pushStat(this.stats.fullMs, performance.now() - f.sentAt);}
    if (reply.error || !reply.result) {
      // The whole batch failed: back off every signal in it, and ask for each alone next
      // time so one bad signal can't keep the others from loading (L3).
      this.clearInflight(f);
      vscodeWrapper.outputLog('window request failed: ' + (reply.error || 'no result'));
      rest.forEach((sid) => { // vscode-port: (rows already streamed keep their windows)
        const s = this.signals.get(sid);
        if (s) {this.fail(s, reply.error || 'no result', rest.length === 1);}
      });
      return;
    }
    const rtt = performance.now() - f.sentAt;
    pushStat(this.stats.rttMs, rtt);
    if (rtt > 300) {
      this.stats.slow.push({ms: Math.round(rtt), helperMs: Math.round((reply as any).ms ?? -1), workerMs: Math.round((reply as any).workerMs ?? -1), signals: f.signals, level: f.tiles[0].level, priority: f.priority, at: Math.round(f.sentAt)});
      if (this.stats.slow.length > 50) {this.stats.slow.shift();}
    }
    if (typeof (reply as any).ms === 'number') {pushStat(this.stats.helperMs, (reply as any).ms);}
    this.storeWindows(f.streamed ? {...f, signals: rest} : f, reply.result, bin || new Uint8Array(0)); // vscode-port: streamed
  }

  // Per signal: inflated records and counts, or an error string. One bad signal (corrupt
  // deflate, bytes past the end of the reply, short counts) never spoils the others.
  private async decodeSignals(result: any, bin: Uint8Array, expectBuckets: number) {
    const heads: any[] = Array.isArray(result && result.signals) ? result.signals : [];
    let off = 0;
    const jobs = heads.map(async (h): Promise<{h: any; raw: Uint8Array | null; counts: Uint32Array | null; err: string | null}> => {
      if (h.error) {return {h, raw: null, counts: null, err: String(h.error)};}
      const bytes = Number(h.bytes) || 0, bucketBytes = Number(h.bucketBytes) || 0;
      const recBytes = bin.subarray(off, off + bytes); off += bytes;
      const countBytes = bin.slice(off, off + bucketBytes); off += bucketBytes;
      if (off > bin.length) {return {h, raw: null, counts: null, err: 'reply shorter than its header'};}
      try {
        const raw = await inflateRaw(recBytes);
        // vscode-port: every window asks deflateCounts (pan/zoom-1% bytes -28%), so the counts come deflated.
        let counts: Uint32Array | null = null;
        if (!h.exact) {
          const c = bucketBytes ? await inflateRaw(countBytes) : new Uint8Array(0);
          // A decimated window without one count per bucket can't tell hidden changes apart (M3).
          if (c.length !== 4 * expectBuckets) {return {h, raw: null, counts: null, err: `decimated window with ${c.length} count bytes (inflated), expected ${4 * expectBuckets}`};}
          const own = c.byteOffset % 4 === 0 ? c : c.slice();
          counts = new Uint32Array(own.buffer, own.byteOffset, own.length >> 2);
        }
        return {h, raw, counts, err: null};
      } catch (e) {
        return {h, raw: null, counts: null, err: 'inflate failed: ' + e};
      }
    });
    return Promise.all(jobs);
  }

  private makeWindow(key: string, level: number, t0: number, t1: number, buckets: number, h: any, records: ValueChange[], counts: Uint32Array | null, width: number): Win {
    let hiddenAfter: Uint8Array | null = null;
    if (!h.exact && counts) {
      // Mark the gaps that hide changes: a bucket with >= 3 changes shows only its first and last.
      hiddenAfter = new Uint8Array(records.length);
      const lastIdx = new Int32Array(buckets).fill(-1);
      for (let j = 1; j < records.length; j++) {
        const k = Math.min(buckets - 1, Math.floor(((records[j][0] - t0) * buckets) / (t1 - t0)));
        lastIdx[k] = j;
      }
      for (let k = 0; k < buckets; k++) {
        if (counts[k] >= 3 && lastIdx[k] >= 1) {hiddenAfter[lastIdx[k] - 1] = 1;}
      }
    }
    return {
      key, level, t0, t1, buckets, exact: !!h.exact, counts, hiddenAfter,
      data: {valueChangeData: records, formattedValues: {}, signalWidth: width, min: h.min ?? 0, max: h.max ?? 1},
      bytes: records.length * (width + 48) + (counts ? counts.byteLength * 2 : 0),
      lastUsed: performance.now(),
    };
  }

  private async storeWindows(f: InflightWindow, result: any, bin: Uint8Array) {
    const decoded = await this.decodeSignals(result, bin, f.buckets * f.tiles.length);
    // A reset (file reload) while we were decoding: these tiles belong to the old file (M2).
    if (f.gen !== this.generation) {return;}
    this.clearInflight(f);
    const firstWindow: SignalWindows[] = [];
    const t = performance.now();
    const answered = new Set<SignalId>();
    let stored = 0;
    decoded.forEach(({h, raw, counts, err}) => {
      const s = this.signals.get(h.signalId);
      if (!s || !f.signals.includes(h.signalId)) {return;}
      answered.add(s.signalId);
      if (s.hybrid === 'local') {return;} // loaded whole meanwhile (hybrid): windows not needed
      if (this.hybrid && typeof h.total === 'number') {this.decideCount(s, h.total);} // the helper knows its whole count
      if (err !== null || raw === null) {this.fail(s, err || 'no data', true, typeof (h as any).noValue === 'string' ? (h as any).noValue : undefined); return;}
      const all = this.timed('window.parseRecords', s, raw.length, () => parseRecords(raw, s.width, !!h.text)); // vscode-port: text rows
      // The first record must be the value at the request's t0 (L4).
      if (all.length === 0 || all[0][0] !== f.tiles[0].t0) {this.fail(s, 'window does not start with the value at t0'); return;}
      if (s.windows.size === 0) {firstWindow.push(s);}
      // Split the run back into tiles: each starts with the value in effect at its t0.
      f.tiles.forEach((tile, k) => {
        let records = all, tileCounts = counts;
        if (f.tiles.length > 1) {
          const i0 = Math.max(0, upperBound(all, tile.t0) - 1), i1 = lowerBound(all, tile.t1);
          records = [[tile.t0, all[i0][1]] as ValueChange].concat(all.slice(i0 + 1, i1));
          tileCounts = counts ? counts.slice(k * f.buckets, (k + 1) * f.buckets) : null;
        }
        const w = this.makeWindow(tile.key, tile.level, tile.t0, tile.t1, f.buckets, h, records, tileCounts, s.width);
        const old = s.windows.get(tile.key);
        if (old) {s.bytes -= old.bytes;}
        s.windows.set(tile.key, w);
        s.bytes += w.bytes;
        stored++;
      });
      s.fails = 0; s.failUntil = 0; s.failMsg = ''; s.noValue = ''; s.denseZoom = 0; s.solo = false; s.timeouts = 0; s.slowUntil = 0;
      s.min = h.min ?? 0; s.max = h.max ?? 1;
      this.evict(s);
    });
    // A signal the reply left out would otherwise be asked for again at once, forever (H2).
    f.signals.forEach((sid) => {
      const s = this.signals.get(sid);
      if (s && !answered.has(sid)) {this.fail(s, 'missing from the reply');}
    });
    this.stats.decodeMs += performance.now() - t;
    if (performance.now() - t > 50) {this.stats.slowSteps.push({step: 'window.store', ms: Math.round(performance.now() - t), signalId: -1, n: f.signals.length, width: 0});}
    firstWindow.forEach((s) => this.timed('window.onFirstWindow', s, 0, () => this.onFirstWindow(s)));
    if (stored > 0) {this.scheduleRedraw();}
    this.checkRefined(this.visibleSignals(), this.wantedTiles());
  }

  // LRU per signal, never dropping what the current viewport wants.
  private evict(s: SignalWindows) {
    while (s.bytes > this.maxBytesPerSignal || s.windows.size > this.maxWindowsPerSignal) {
      let victim: Win | null = null;
      s.windows.forEach((w) => {
        // Keep what the viewport wants and what the last frame painted from (L9).
        if (this.wantedKeys.has(w.key) || s.painted.has(w.key) || w.key === s.scanKey) {return;}
        if (!victim || w.lastUsed < victim.lastUsed) {victim = w;}
      });
      if (!victim) {break;}
      s.windows.delete((victim as Win).key);
      s.bytes -= (victim as Win).bytes;
    }
  }

  private rowsOf(signalId: SignalId): NetlistVariable[] {
    const out: NetlistVariable[] = [];
    viewerState.displayedSignalsFlat.forEach((rowId) => {
      const item = rowHandler.rowItems[rowId];
      if (item instanceof NetlistVariable && item.signalId === signalId) {out.push(item);}
    });
    return out;
  }

  private onFirstWindow(s: SignalWindows) {
    this.rowsOf(s.signalId).forEach((item) => {
      if (item.encoding === "Real") {item.min = s.min; item.max = s.max;}
      labelsPanel.valueAtMarker[item.rowId] = item.getValueAtTime(viewerState.markerTime);
    });
    labelsPanel.renderValueDisplay();
  }

  // ---- rendering ----
  private quality(w: Win, target: number) {
    return w.exact ? 1000 : 500 - Math.abs(w.level - target) * 2 - (w.level > target ? 1 : 0);
  }

  // Time ranges of [L, R) and the window that should paint each (null = nothing loaded).
  private segments(s: SignalWindows, L: number, R: number): {a: number; b: number; w: Win | null}[] {
    const target = this.levelFor(viewport.pixelTime);
    const cands: Win[] = [];
    s.windows.forEach((w) => { if (w.t1 > L && w.t0 < R) {cands.push(w);} });
    cands.sort((x, y) => this.quality(x, target) - this.quality(y, target));
    let segs: {a: number; b: number; w: Win | null}[] = [{a: L, b: R, w: null}];
    for (const w of cands) {
      const a = Math.max(L, w.t0), b = Math.min(R, w.t1);
      const next: typeof segs = [];
      for (const sg of segs) {
        if (sg.b <= a || sg.a >= b) {next.push(sg); continue;}
        if (sg.a < a) {next.push({a: sg.a, b: a, w: sg.w});}
        if (sg.b > b) {next.push({a: b, b: sg.b, w: sg.w});}
      }
      next.push({a, b, w});
      segs = next.sort((x, y) => x.a - y.a);
    }
    const merged: typeof segs = [];
    segs.forEach((sg) => {
      const last = merged[merged.length - 1];
      if (last && last.w === sg.w && last.b === sg.a) {last.b = sg.b;} else {merged.push(sg);}
    });
    return merged;
  }

  renderRow(item: NetlistVariable) {
    const s = this.signals.get(item.signalId!);
    const ctx = viewport.waveformsCanvas;
    if (!s || !ctx || item.topBounds === null) {return;}
    const L = viewport.timeScrollLeft, R = viewport.timeScrollRight;
    const rowTop = item.topBounds + styles.rowPadding - viewport.pseudoScrollTop;
    const canvasHeight = item.rowHeight * styles.rowHeight - styles.rowPadding * 2;
    const toX = (t: number) => (t - L) * viewport.zoomRatio;
    const now = performance.now();
    ctx.clearRect(0, rowTop, viewport.viewerWidth, canvasHeight);
    const segs = this.segments(s, L, R);
    let drewData = false;
    s.painted.clear();
    // Unreadable: the host keeps failing for this signal; it is retried with backoff.
    const label = s.noValue ? s.noValue : s.denseZoom ? DENSE_TEXT : this.unreadable(s) ? 'unreadable: ' + s.failMsg + ' (retrying)' : s.timeouts > 0 ? 'loading (helper is slow)' : '';

    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      if (sg.w === null) {
        this.drawPlaceholder(ctx, Math.max(0, Math.floor(toX(sg.a))), Math.min(viewport.viewerWidth, Math.ceil(toX(sg.b))), rowTop, canvasHeight, label);
        continue;
      }
      // A run of loaded segments becomes one array, so values that cross a window
      // boundary draw as one element (one label, no fake edge at the boundary).
      const run: ValueChange[] = [];
      const unresolved: [number, number][] = []; // gaps hiding changes, wider than 2 px
      const runStart = sg.a;
      const firstSeg = i;
      // One window painting the whole run: its own array can go to the renderer as is (the
      // clip limits drawing to the run), unless something in view must be collapsed (L7).
      const single = i + 1 >= segs.length || segs[i + 1].w === null;
      const minDt = 2 / viewport.zoomRatio;
      let anyDense = false;
      let j = i;
      for (; j < segs.length && segs[j].w !== null; j++) {
        const w = segs[j].w!;
        w.lastUsed = now;
        s.painted.add(w.key);
        const recs = w.data.valueChangeData;
        const i0 = Math.max(0, upperBound(recs, segs[j].a) - 1);
        const i1 = lowerBound(recs, segs[j].b);
        for (let k = i0; k < i1; k++) {
          if (this.hidden(w, k) && k + 1 < recs.length && (recs[k + 1][0] - recs[k][0]) * viewport.zoomRatio > 2) {
            unresolved.push([Math.max(recs[k][0], segs[j].a), Math.min(recs[k + 1][0], segs[j].b)]);
          }
          if (single) {
            if (!anyDense && k + 1 < i1 && recs[k + 1][0] - recs[k][0] < minDt) {anyDense = true;}
            continue;
          }
          if (k === i0 && run.length > 0) {
            // value in effect at the boundary: only a change if it differs from what's drawn
            if (recs[k][1] !== run[run.length - 1][1]) {run.push([segs[j].a, recs[k][1]]);}
            continue;
          }
          run.push(recs[k]);
        }
      }
      const runEnd = segs[j - 1].b;
      i = j - 1;
      drewData = true;
      let thin: ValueChange[], dense: [number, number][];
      if (single && !anyDense) {
        thin = sg.w.data.valueChangeData; dense = [];
      } else {
        if (single) {
          const recs = sg.w.data.valueChangeData;
          for (let k = Math.max(0, upperBound(recs, sg.a) - 1), e = lowerBound(recs, sg.b); k < e; k++) {run.push(recs[k]);}
        }
        ({thin, dense} = this.collapseDense(run, minDt));
      }
      const data: WaveformData = {valueChangeData: thin, formattedValues: {}, signalWidth: s.width, min: s.min, max: s.max};
      const bounds = setRenderBounds(item, data);
      // After the run's last record the value holds to the run's end (then a placeholder or
      // the viewport edge); the next change is unknown, so end the element past the clip.
      if (bounds.endIndex >= thin.length) {
        bounds.postState = [runEnd < R ? runEnd : Math.min(viewport.timeStop, R + 20 * viewport.pixelTime), ''];
      }
      const xa = Math.max(0, Math.floor(toX(runStart))), xb = Math.min(viewport.viewerWidth, Math.ceil(toX(runEnd)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(xa, 0, xb - xa, viewport.viewerHeight);
      ctx.clip();
      ctx.beginPath();
      item.renderType.draw(bounds, item);
      dense.forEach(([ta, tb]) => this.drawDenseBand(ctx, item, Math.max(xa, toX(ta)), Math.min(xb, toX(tb)), rowTop, canvasHeight));
      // A coarser window can't say what happens inside a dense bucket: don't show the value
      // drawn across it, show an unresolved dense block until finer data arrives.
      unresolved.forEach(([ta, tb]) => this.drawUnresolved(ctx, item, Math.max(xa, toX(ta)), Math.min(xb, toX(tb)), rowTop, canvasHeight));
      ctx.restore();
      for (let k = firstSeg; k < j; k++) {
        const w = segs[k].w!;
        if (w.counts) {this.shadeDense(ctx, item, w, segs[k].a, segs[k].b, rowTop, canvasHeight, toX);}
      }
    }
    if (drewData && s.firstDrawMs === null) {
      s.firstDrawMs = now - s.addedAt;
      pushStat(this.stats.firstDrawMs, s.firstDrawMs);
    }
  }

  // Stretches where consecutive changes are closer than minDt (2 CSS px) would cost the stock
  // renderer one shape per change for what is a solid band on screen. Keep the first and last
  // record of each stretch and report the stretch so it is painted as one band, the way
  // upstream paints its sub-pixel noDrawRanges.
  private collapseDense(run: ValueChange[], minDt: number): {thin: ValueChange[]; dense: [number, number][]} {
    const thin: ValueChange[] = [], dense: [number, number][] = [];
    for (let k = 0; k < run.length; k++) {
      if (k + 1 >= run.length || run[k + 1][0] - run[k][0] >= minDt) {thin.push(run[k]); continue;}
      const start = k;
      while (k + 1 < run.length && run[k + 1][0] - run[k][0] < minDt) {k++;}
      thin.push(run[start]);
      thin.push(run[k]);
      if (run[k][0] - run[start][0] >= minDt) {dense.push([run[start][0], run[k][0]]);}
    }
    return {thin, dense};
  }

  private drawDenseBand(ctx: CanvasRenderingContext2D, item: NetlistVariable, x0: number, x1: number, rowTop: number, height: number) {
    if (x1 - x0 < 1) {return;}
    ctx.save();
    ctx.clearRect(x0, rowTop, x1 - x0, height);
    ctx.fillStyle = item.color;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(x0, rowTop + 1, x1 - x0, height - 2);
    ctx.restore();
  }

  private drawUnresolved(ctx: CanvasRenderingContext2D, item: NetlistVariable, x0: number, x1: number, rowTop: number, height: number) {
    if (x1 - x0 < 1) {return;}
    ctx.save();
    ctx.clearRect(x0, rowTop, x1 - x0, height);
    ctx.fillStyle = item.color;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(x0, rowTop + 1, x1 - x0, height - 2);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, rowTop + 1.5, x1 - x0 - 1, height - 3);
    ctx.restore();
  }

  private drawPlaceholder(ctx: CanvasRenderingContext2D, xa: number, xb: number, rowTop: number, height: number, label = '') {
    if (xb <= xa) {return;}
    if (label) {
      ctx.save();
      ctx.fillStyle = styles.textColor;
      ctx.globalAlpha = 0.7;
      ctx.font = styles.fontStyle;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, xa + 6, rowTop + height / 2, Math.max(0, xb - xa - 12));
      ctx.restore();
    }
    ctx.save();
    ctx.fillStyle = styles.textColor;
    ctx.globalAlpha = 0.06;
    ctx.fillRect(xa, rowTop, xb - xa, height);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = styles.textColor;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(xa, rowTop + height / 2 + 0.5);
    ctx.lineTo(xb, rowTop + height / 2 + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // Dense buckets (more changes than the two drawn) get a band whose opacity follows the count.
  private shadeDense(ctx: CanvasRenderingContext2D, item: NetlistVariable, w: Win, a: number, b: number,
                     rowTop: number, height: number, toX: (t: number) => number) {
    const counts = w.counts!;
    const bw = (w.t1 - w.t0) / w.buckets;
    const k0 = Math.max(0, Math.floor((a - w.t0) / bw)), k1 = Math.min(w.buckets, Math.ceil((b - w.t0) / bw));
    ctx.save();
    ctx.fillStyle = item.color;
    let runStart = -1, runAlpha = 0;
    const flush = (kEnd: number) => {
      if (runStart < 0) {return;}
      const x0 = Math.max(toX(Math.max(a, w.t0 + runStart * bw)), 0), x1 = toX(Math.min(b, w.t0 + kEnd * bw));
      ctx.globalAlpha = runAlpha;
      ctx.fillRect(x0, rowTop + 1, Math.max(x1 - x0, 1), height - 2);
      runStart = -1;
    };
    for (let k = k0; k < k1; k++) {
      const c = counts[k];
      const alpha = c >= 3 ? Math.min(0.55, 0.12 + 0.06 * Math.log2(c)) : 0;
      if (alpha !== runAlpha || alpha === 0) {flush(k);}
      if (alpha > 0 && runStart < 0) {runStart = k; runAlpha = alpha;}
    }
    flush(k1);
    ctx.restore();
  }

  // ---- local answers from loaded windows ----
  private bestWindowAt(s: SignalWindows, t: number, needEnd = false): Win | null {
    let best: Win | null = null;
    s.windows.forEach((w) => {
      if (t < w.t0 || (needEnd ? t > w.t1 : t >= w.t1)) {return;}
      if (!best || (w.exact && !best.exact) || (w.exact === best.exact && w.level < best.level)) {best = w;}
    });
    return best;
  }

  private hidden(w: Win, j: number) {
    return w.hiddenAfter !== null && j >= 0 && j < w.hiddenAfter.length && w.hiddenAfter[j] === 1;
  }

  // The value in effect at t, or null if the loaded windows can't tell.
  private localValue(s: SignalWindows, t: number): string | null {
    const w = this.bestWindowAt(s, t);
    if (!w) {return null;}
    const arr = w.data.valueChangeData;
    const j = upperBound(arr, t) - 1;
    if (j < 0 || this.hidden(w, j)) {return null;}
    return arr[j][1];
  }

  // As upstream's getValueAtTime: [old, new] when a change is exactly at t, else [value]
  // (L1: the same answer whichever window is loaded). Times are integers, so a change at
  // t is the same as value(t - 1) !== value(t).
  localValueAt(s: SignalWindows, t: number): string[] | null {
    const cur = this.localValue(s, t);
    if (cur === null) {return null;}
    if (t <= 0) {return [cur];}
    const prev = this.localValue(s, t - 1);
    if (prev === null) {return null;}
    return prev !== cur ? [prev, cur] : [cur];
  }

  // Next (dir 1) or previous (dir -1) change matching pred. undefined = the windows can't tell.
  localEdge(s: SignalWindows, t: number, dir: number, pred: Pred | null): number | null | undefined {
    const w = this.bestWindowAt(s, t, dir < 0);
    if (!w) {return undefined;}
    const arr = w.data.valueChangeData;
    const ok = (k: number) => pred === null || pred(arr[k][1]);
    if (dir > 0) {
      const j = upperBound(arr, t) - 1;
      if (this.hidden(w, j)) {return undefined;}
      for (let k = j + 1; k < arr.length; k++) {
        if (ok(k)) {return arr[k][0];}
        if (this.hidden(w, k)) {return undefined;}
      }
      return undefined;
    }
    if (t <= w.t0) {return undefined;}
    const j = lowerBound(arr, t) - 1;
    if (this.hidden(w, j)) {return undefined;}
    for (let k = j; k >= 1; k--) {
      if (ok(k)) {return arr[k][0];}
      if (this.hidden(w, k - 1)) {return undefined;}
    }
    return undefined; // record 0 is the value at t0, not a change
  }

  // Click-to-snap: the nearest real change among loaded records of every window around t
  // (decimated records are real changes too). Record 0 of a window is the value carried in
  // at its t0, not a change, so a tile boundary is never a snap target (M1).
  nearestTransition(signalId: SignalId, t: number): ValueChange {
    const s = this.signals.get(signalId);
    let best: ValueChange | null = null;
    s?.windows.forEach((w) => {
      const arr = w.data.valueChangeData;
      const k = lowerBound(arr, t);
      for (const j of [k - 1, k]) {
        if (j < 1 || j >= arr.length) {continue;}
        if (!best || Math.abs(arr[j][0] - t) < Math.abs(best[0] - t)) {best = arr[j];}
      }
    });
    return best ?? [t, ''];
  }

  // ---- host queries ----
  // Every query settles: with the reply, on reset(), or after QUERY_TIMEOUT_MS (then the
  // host is told to cancel it), so nothing waiting on one can hang (H1).
  // Returns the request id with the reply promise, so callers can track or cancel it.
  query(cmd: string, args: Record<string, unknown>, timeoutMs = QUERY_TIMEOUT_MS, prefetch = false): {id: number; reply: Promise<{result: any; bin: Uint8Array | null}>} {
    const id = this.nextId++;
    if (prefetch) {this.stats.prefetchQueries++;} else {this.stats.queries++;}
    const reply = new Promise<{result: any; bin: Uint8Array | null}>((resolve, reject) => {
      const timer = setTimeout(() => this.cancelQuery(id, cmd + ' timed out', true), timeoutMs);
      this.queries.set(id, {resolve, reject, timer});
      vscodeWrapper.sendV2Request({id, cmd, ...args, ...(cmd === 'window' ? {deflateCounts: true} : {})}); // vscode-port: deflated counts
    });
    return {id, reply};
  }

  private cancelQuery(id: number, why: string, timedOut = false) {
    const q = this.queries.get(id);
    if (!q) {return;}
    this.queries.delete(id);
    clearTimeout(q.timer);
    vscodeWrapper.sendV2Request({id, cmd: 'cancel'});
    q.reject(Object.assign(new Error(why), {timedOut}));
  }

  // Long queries (edge / search / WaveDrom) of the current navigation; Escape cancels them.
  private navQuery(cmd: string, args: Record<string, unknown>) {
    const {id, reply} = this.query(cmd, args, this.longQueryMs);
    this.navQueries.add(id);
    return reply.finally(() => this.navQueries.delete(id));
  }

  // A short, dismissible note in the control bar ("value search timed out"): a long host
  // query that ran out of time must say so, not just log it. Replaced by a newer note,
  // closed by its button, by Escape, by a reload, or after 15 s.
  showNotice(text: string) {
    this.hideNotice();
    const bar = document.getElementById('control-bar');
    if (!bar) {vscodeWrapper.outputLog(text); return;}
    const el = document.createElement('div');
    el.id = 'vv-window-notice';
    el.setAttribute('role', 'status');
    Object.assign(el.style, {display: 'flex', alignItems: 'center', gap: '6px', padding: '0 6px', margin: 'auto 4px',
      height: '20px', borderRadius: '3px', fontSize: '12px', whiteSpace: 'nowrap',
      color: 'var(--vscode-inputValidation-warningForeground, inherit)',
      background: 'var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.25))',
      border: '1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,0.8))'});
    const label = document.createElement('span');
    label.textContent = text;
    const close = document.createElement('span');
    close.className = 'codicon codicon-close';
    close.title = 'Dismiss';
    close.setAttribute('role', 'button');
    close.style.cursor = 'pointer';
    close.addEventListener('click', (e) => {e.stopPropagation(); this.hideNotice();});
    el.append(label, close);
    bar.appendChild(el);
    this.noticeEl = el;
    this.noticeTimer = setTimeout(() => this.hideNotice(), 15000);
    vscodeWrapper.outputLog(text);
  }

  hideNotice() {
    if (this.noticeTimer !== null) {clearTimeout(this.noticeTimer); this.noticeTimer = null;}
    if (this.noticeEl) {this.noticeEl.remove(); this.noticeEl = null;}
  }

  // A failed host search must say so: a timeout, or any other error (not Escape or a reload).
  private noticeIfTimedOut(e: unknown, what: string, waitedMs = this.longQueryMs) {
    if (e && (e as {timedOut?: boolean}).timedOut) {this.showNotice(what + ' timed out after ' + Math.max(1, Math.round(waitedMs / 1000)) + ' s'); return;}
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'cancelled' && msg !== 'reset') {this.showNotice(what + ' failed: ' + msg);}
  }

  // Escape: cancel the running navigation / search / WaveDrom copy, drop a queued step, and
  // stop a WaveDrom copy between its fetch passes (navEpoch). Returns true if something was
  // running, so the caller can skip Escape's other effects.
  cancelNav(): boolean {
    if (!this.enabled) {return false;}
    this.hideNotice();
    this.navEpoch++;
    const queued = this.navQueued !== null;
    this.navQueued = null;
    const busy = this.navQueries.size > 0 || this.wavedromBusy > 0;
    [...this.navQueries].forEach((id) => this.cancelQuery(id, 'cancelled'));
    if (busy || queued) {vscodeWrapper.outputLog('search cancelled');}
    return busy || queued;
  }

  // Synchronous answer for the value display; when the windows can't tell, ask the host
  // (batched per time) and fill the value display in when the reply arrives.
  valueAtTime(signalId: SignalId, t: number | null): string[] {
    const s = this.signals.get(signalId);
    if (!s || t === null) {return [];}
    const local = this.localValueAt(s, t);
    if (local !== null) {return local;}
    if (s.valueAt && s.valueAt.t === t) {return s.valueAt.value;}
    if (s.valueAtPending === t) {return [];}
    s.valueAtPending = t;
    if (!this.valueAtBatch.has(t)) {
      this.valueAtBatch.set(t, new Set());
      queueMicrotask(() => this.flushValueAt(t));
    }
    this.valueAtBatch.get(t)!.add(signalId);
    return [];
  }

  // At most one valueAt in flight and one per VALUEAT_EVERY_MS; meanwhile only the latest
  // marker time waits, so a marker drag sends a few queries, not one per mouse move (M9).
  private flushValueAt(t: number) {
    const ids = [...(this.valueAtBatch.get(t) || [])];
    this.valueAtBatch.delete(t);
    if (ids.length === 0) {return;}
    if (this.valueAtNext && this.valueAtNext.t === t) {
      // Same time: everyone waiting gets asked (N3).
      this.valueAtNext = {t, ids: [...new Set([...this.valueAtNext.ids, ...ids])]};
    } else {
      if (this.valueAtNext) {this.clearValueAtPending(this.valueAtNext.t, this.valueAtNext.ids);}
      this.valueAtNext = {t, ids};
    }
    this.pumpValueAt();
  }

  private pumpValueAt() {
    if (this.valueAtBusy || this.valueAtTimer !== null || !this.valueAtNext) {return;}
    const wait = this.valueAtLast + VALUEAT_EVERY_MS - performance.now();
    if (wait > 0) {
      this.valueAtTimer = setTimeout(() => {this.valueAtTimer = null; this.pumpValueAt();}, wait);
      return;
    }
    const next = this.valueAtNext;
    this.valueAtNext = null;
    this.valueAtLast = performance.now();
    this.sendValueAt(next.t, next.ids);
  }

  private clearValueAtPending(t: number, ids: SignalId[]) {
    ids.forEach((id) => {const s = this.signals.get(id); if (s && s.valueAtPending === t) {s.valueAtPending = null;}});
  }

  private sendValueAt(t: number, ids: SignalId[]) {
    this.valueAtBusy = true;
    const gen = this.generation;
    // The value just before t too, so a change exactly at t shows [old, new] as upstream does.
    const times = t > 0 ? [t, t - 1] : [t];
    Promise.all(times.map((tt) => this.query('valueAt', {signalIds: ids, t: tt}).reply)).then((replies) => {
      if (gen !== this.generation) {return;}
      ids.forEach((id, i) => {
        const s = this.signals.get(id);
        if (!s) {return;}
        const cur = replies[0].result.values[i], prev = replies.length > 1 ? replies[1].result.values[i] : null;
        // null: the host has no value for it (e.g. an unreadable alias)
        s.valueAt = {t, value: typeof cur !== 'string' ? [] : typeof prev === 'string' && prev !== cur ? [prev, cur] : [cur]};
        if (s.valueAtPending === t) {s.valueAtPending = null;}
        if (viewerState.markerTime !== t) {return;}
        this.rowsOf(id).forEach((item) => {labelsPanel.valueAtMarker[item.rowId] = s.valueAt!.value;});
      });
      if (viewerState.markerTime === t) {labelsPanel.renderValueDisplay();}
    }).catch(() => {
      if (gen === this.generation) {this.clearValueAtPending(t, ids);}
    }).finally(() => {
      if (gen !== this.generation) {return;}
      this.valueAtBusy = false;
      this.pumpValueAt();
    });
  }

  // One navigation at a time; a key held down queues at most one more step. fn gets the
  // generation it started in and must not move the marker if a reset happened meanwhile.
  private runNav(fn: (gen: number) => Promise<void>, what = 'edge search') {
    if (this.navBusy) {this.navQueued = () => this.runNav(fn, what); return;}
    this.navBusy = true;
    const gen = this.generation;
    const startedAt = performance.now();
    fn(gen).catch((e) => {
      // The wait the user saw (a joined prefetch times out sooner than longQueryMs; review #8).
      if (gen === this.generation) {vscodeWrapper.outputLog('navigation: ' + e.message); this.noticeIfTimedOut(e, what, performance.now() - startedAt);}
    }).finally(() => {
      if (gen !== this.generation) {return;} // reset() already cleared navBusy/navQueued
      this.stats.navDone++; this.stats.navMs.push(performance.now() - startedAt); if (this.stats.navMs.length > 50) {this.stats.navMs.shift();} // vscode-port
      this.navBusy = false;
      const q = this.navQueued; this.navQueued = null;
      if (q) {q();}
    });
  }

  // ---- edge / search answers and their prefetch ----
  private navKey(s: SignalWindows, q: NavCmd, dir: number) {
    return s.signalId + '|' + q.cmd + '|' + dir + '|' + (q.cmd === 'edge' ? q.kind : q.value);
  }

  private navLookup(key: string, start: number, dir: number): number | null | undefined {
    const list = this.navCache.get(key);
    if (!list) {return undefined;}
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (dir > 0 ? a.lo <= start && start < a.hi : a.lo < start && start <= a.hi) {return a.t;}
    }
    return undefined;
  }

  private navStore(key: string, a: NavAnswer) {
    let list = this.navCache.get(key);
    if (!list) {list = []; this.navCache.set(key, list);}
    list.push(a);
    if (list.length > NAV_CACHE_KEEP) {list.splice(0, list.length - NAV_CACHE_KEEP);}
  }

  // The host's answer from `start`: from the answer cache, from the same question already
  // in flight (a prefetch), or one round trip. `startIsMatch`: start is itself a match (a
  // previous answer), so the answer also gives the way back. A user's question (prefetch
  // false) is an Escape-cancellable navigation query, also when it joins a prefetch.
  private hostNav(s: SignalWindows, q: NavCmd, dir: number, start: number, startIsMatch: boolean, prefetch: boolean): Promise<number | null> {
    const key = this.navKey(s, q, dir);
    const hit = this.navLookup(key, start, dir);
    if (hit !== undefined) {if (!prefetch) {this.stats.navHits++;} return Promise.resolve(hit);}
    const askKey = key + '@' + start;
    const joined = this.navAsk.get(askKey);
    // Join a question already in flight, unless it is old enough that its timeout would cut
    // a user's wait short (then ask afresh: an old prefetch is cancelled, an old user
    // question is left to finish).
    if (joined && (prefetch || performance.now() - joined.sentAt < this.longQueryMs / 2)) {
      if (!prefetch) {
        joined.prefetch = false; // a user waits on it now: not cancelled by a marker move
        if (this.queries.has(joined.id)) {this.navQueries.add(joined.id); joined.p.finally(() => this.navQueries.delete(joined.id)).catch(() => {});}
      }
      return joined.p;
    }
    // Asking afresh past an old prefetch: drop it now. Once its navAsk entry is replaced,
    // no marker move could cancel it any more (review L1).
    if (joined && joined.prefetch) {this.navAsk.delete(askKey); this.cancelQuery(joined.id, 'cancelled');}
    const gen = this.generation;
    const args = q.cmd === 'edge' ? {kind: q.kind} : {value: q.value, wildcard: '?'};
    const {id, reply} = this.query(q.cmd, {signalId: s.signalId, t: start, dir, ...args}, this.longQueryMs, prefetch);
    if (!prefetch) {this.navQueries.add(id);}
    const p = reply.then(({result}) => {
      const t = typeof result?.t === 'number' ? result.t as number : null;
      if (gen === this.generation) {
        this.navStore(key, dir > 0 ? {lo: start, hi: t ?? Infinity, t} : {lo: t ?? -Infinity, hi: start, t});
        // No match strictly between start and t, and both are matches: the way back is known too.
        if (startIsMatch && t !== null) {
          this.navStore(this.navKey(s, q, -dir), dir > 0 ? {lo: start, hi: t, t: start} : {lo: t, hi: start, t: start});
        }
      }
      return t;
    }).finally(() => {
      if (this.navAsk.get(askKey)?.id === id) {this.navAsk.delete(askKey);}
      this.navQueries.delete(id);
    });
    this.navAsk.set(askKey, {id, p, prefetch, epoch: this.prefetchEpoch, sentAt: performance.now()});
    p.catch(() => {}); // a prefetch nobody joined may fail quietly
    return p;
  }

  // Walk `depth` answers from `start` (local where the windows decide, else the host),
  // stopping when the marker moves on (a new prefetch round) or the file reloads.
  private async prefetchChain(s: SignalWindows, q: NavCmd, dir: number, start: number, depth: number, epoch: number) {
    const gen = this.generation;
    const pred: Pred | null = q.cmd === 'search' ? (v) => matchPattern(v, q.value) : q.kind === 'any' ? null : (v) => v === (q.kind === 'rise' ? '1' : '0');
    let t: number | null = start, isMatch = q.cmd === 'search'; // a search chain starts on a match
    for (let k = 0; k < depth && t !== null; k++) {
      if (epoch !== this.prefetchEpoch || gen !== this.generation || !this.isWindowed(s.signalId)) {return;}
      let r = this.localEdge(s, t, dir, pred);
      if (r === undefined) {
        try {r = await this.hostNav(s, q, dir, t, isMatch, true);} catch {return;}
      }
      t = r; isMatch = true;
    }
  }

  // The marker settled (or the selection changed): prefetch the next edges of the selected
  // windowed rows both ways, for any edge and, on 1-bit rows, the polarity last stepped (rise at first).
  private schedulePrefetch(markerType: number) {
    if (!this.enabled || !this.prefetch) {return;}
    this.prefetchEpoch++;
    // The marker moved on: prefetches still in flight that no user step joined are stale.
    this.navAsk.forEach((a, k) => {
      if (a.prefetch && a.epoch !== this.prefetchEpoch) {this.navAsk.delete(k); this.cancelQuery(a.id, 'cancelled');}
    });
    if (this.prefetchTimer !== null) {clearTimeout(this.prefetchTimer);}
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      const start = markerType === 0 ? viewerState.markerTime : viewerState.altMarkerTime;
      if (start === null) {return;}
      const epoch = this.prefetchEpoch;
      const seen = new Set<SignalId>();
      viewerState.selectedSignal.forEach((rowId) => {
        const item = rowHandler.rowItems[rowId];
        if (!(item instanceof NetlistVariable) || !this.isWindowed(item.signalId) || seen.has(item.signalId!) || seen.size >= PREFETCH_ROWS) {return;}
        seen.add(item.signalId!);
        const s = this.signals.get(item.signalId!)!;
        const kinds: ('any' | 'rise' | 'fall')[] = s.width === 1 ? ['any', this.lastEdgeKind] : ['any'];
        kinds.forEach((kind) => {
          this.prefetchChain(s, {cmd: 'edge', kind}, 1, start, PREFETCH_AHEAD, epoch);
          this.prefetchChain(s, {cmd: 'edge', kind}, -1, start, PREFETCH_BACK, epoch);
        });
      });
    }, PREFETCH_DELAY_MS);
  }

  // controlBar.goToNextTransition for windowed rows. edge: [] any, ['1'] rising, ['0'] falling.
  goToNextTransition(markerType: number, direction: number, edge: string[]) {
    this.runNav(async (gen) => {
      const start = markerType === 0 ? viewerState.markerTime : viewerState.altMarkerTime;
      if (start === null || viewerState.selectedSignal.length === 0) {return;}
      const kind = edge.length === 1 && edge[0] === '1' ? 'rise' : edge.length === 1 && edge[0] === '0' ? 'fall' : 'any';
      if (kind !== 'any') {this.lastEdgeKind = kind;}
      const pred: Pred | null = kind === 'any' ? null : (v) => v === edge[0];
      const times = await Promise.all(viewerState.selectedSignal.map(async (rowId) => {
        const item = rowHandler.rowItems[rowId];
        if (!(item instanceof NetlistVariable) || !this.isWindowed(item.signalId)) {
          return item ? item.getNextEdge(start, direction, edge) : null;
        }
        const s = this.signals.get(item.signalId!)!;
        const local = this.localEdge(s, start, direction, pred);
        if (local !== undefined) {return local;}
        return this.hostNav(s, {cmd: 'edge', kind}, direction, start, false, false);
      }));
      const found = times.filter((t): t is number => t !== null && t !== undefined);
      if (found.length === 0 || gen !== this.generation) {return;}
      const next = direction === 1 ? minOf(found) : maxOf(found); // vscode-port: no spread (one hit per row)
      events.markerSet(next, markerType, false);
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
    });
  }

  // controlBar.handleSearchGoTo (value search) for a windowed row. `negative`: the search
  // text is a negative number in the signed format (its parsed form is the minimal two's
  // complement, which must be sign-extended).
  // `raw`: the search text as typed (ASCII's helper search parses it itself).
  searchValue(item: NetlistVariable, parsedSearchValue: string, direction: number, negative = false, raw?: string) {
    const s = this.signals.get(item.signalId!);
    if (!s) {return;}
    // Only bit-pattern formats go to the helper as a pattern. Text formats (RISC-V, alias,
    // ASCII, string, enum, fixed point, epoch) and regexes match the formatted values the way
    // upstream does, over loaded windows and then exact chunks from the host. Their text is
    // never read as bits, even "x1" or "0" (toHostPattern would take those for a pattern).
    const pattern = searchesBitPattern(item.valueFormat) ? toHostPattern(parsedSearchValue, s.width, negative) : null;
    if (pattern === null) {this.searchFormatted(s, item, parsedSearchValue, direction, raw); return;}
    this.runNav(async (gen) => {
      const start = viewerState.markerTime === null ? -1 : viewerState.markerTime;
      let t = this.localEdge(s, start, direction, (v) => matchPattern(v, pattern));
      if (t === undefined) {t = await this.hostNav(s, {cmd: 'search', value: pattern}, direction, start, false, false);}
      if (t === null || t === undefined || gen !== this.generation) {return;}
      events.markerSet(t, 0, false);
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
      // The next match (and the previous one) before the user asks: t is a match.
      if (!this.prefetch) {return;}
      const epoch = this.prefetchEpoch;
      this.prefetchChain(s, {cmd: 'search', value: pattern}, direction, t, PREFETCH_AHEAD - 1, epoch);
      this.prefetchChain(s, {cmd: 'search', value: pattern}, -direction, t, 1, epoch);
    }, 'value search');
  }

  // Value search with upstream's rule: the first change after the marker (or last before it)
  // whose value passes format.checkSearchValue(parsed, bits, formatted). Loaded windows
  // answer when they decide it. Otherwise the helper's searchText formats and matches the
  // values next to the dump (RISC-V, ASCII, alias tables: the viewer's own formatters), and
  // only the hit's time comes back. For the other text formats, a helper
  // without searchText, or a signal too large for it, exact chunks are fetched from the
  // host, adapting their span to stay exact, scanned locally and kept as windows (so the
  // next search in the same stretch is local). Escape cancels; a timeout shows the note.
  private searchFormatted(s: SignalWindows, item: NetlistVariable, parsed: string, direction: number, raw?: string) {
    const fmt = item.valueFormat;
    const ok = (v: string) => {
      try {return fmt.checkSearchValue(parsed, v, fmt.formatString(v, s.width, !fmt.is9State(v)));} catch {return false;}
    };
    const text = this.textSearchArgs(fmt.id, parsed, raw);
    this.runNav(async (gen) => {
      const start = viewerState.markerTime === null ? -1 : viewerState.markerTime;
      let t = this.localEdge(s, start, direction, ok);
      if (t === undefined && text) {t = await this.hostTextSearch(s, start, direction, text, gen);}
      if (t === undefined) {t = await this.scanChunks(s, start, direction, ok, gen);}
      if (t === null || t === undefined || gen !== this.generation) {return;}
      events.markerSet(t, 0, false);
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
    }, 'value search');
  }

  // searchText's format and pattern for a row's format, or null when the helper can't
  // search it (the page scan does). RISC-V and alias patterns are the viewer's (a regex, else
  // plain text, case-insensitive); ASCII sends the typed text, which the helper turns into
  // the same bit regex as formatAscii.parseSearchValue. An alias table goes with its file.
  private textSearchArgs(formatId: string, parsed: string, raw?: string): Record<string, unknown> | null {
    if (!this.textSupported) {return null;}
    const ok = (p: string | undefined): p is string => typeof p === 'string' && p.length > 0 && p.length <= TEXT_MAX_PATTERN;
    if (TEXT_FORMATS.has(formatId)) {return ok(parsed) ? {format: formatId, pattern: parsed} : null;}
    if (formatId === 'ascii') {return ok(raw) ? {format: 'ascii', pattern: raw} : null;}
    if (formatId.startsWith('alias:')) {
      const table = formatId.slice('alias:'.length);
      const source = aliasSearchSource(table);
      if (!source || !ok(parsed)) {return null;}
      const alias: Record<string, unknown> = {text: source.text, table, fileName: source.fileName};
      if (source.bareRadix) {alias.bareRadix = source.bareRadix;}
      return {format: 'alias', pattern: parsed, alias};
    }
    return null;
  }

  // The helper's searchText from `start` (-1: no marker, so t=0 counts): the hit's time,
  // null for no match, or undefined when the helper can't answer (no searchText, tooLarge,
  // an error), so the page scan runs. A request the helper stops at its budget says where it
  // got to; the search resumes there (inclusive: that change is not judged yet) until it
  // ends or longQueryMs has passed. Escape cancels the request in flight (navQuery).
  private async hostTextSearch(s: SignalWindows, start: number, dir: number, text: Record<string, unknown>, gen: number): Promise<number | null | undefined> {
    if (dir < 0 && start < 0) {return null;}
    const epoch = this.navEpoch;
    const began = performance.now();
    let t = Math.max(0, start), inclusive = start < 0;
    for (;;) {
      const left = this.longQueryMs - (performance.now() - began);
      if (left <= 0) {throw Object.assign(new Error('value search timed out'), {timedOut: true});}
      let result: any;
      try {
        ({result} = await this.navQuery('searchText', {signalId: s.signalId, t, dir, inclusive, ...text,
          budgetMs: Math.max(100, Math.min(TEXT_BUDGET_MS, Math.floor(left)))}));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if ((e as {timedOut?: boolean}).timedOut || msg === 'cancelled' || msg === 'reset') {throw e;}
        // An older helper (or relay) without searchText: don't ask again for this file.
        if (/unknown command|not relayed|not supported by this helper/.test(msg)) {this.textSupported = false;} // vscode-port: wisp-helper 15.7's wording
        vscodeWrapper.outputLog('value search: searchText failed (' + msg + '), scanning in the viewer');
        return undefined;
      }
      if (this.navEpoch !== epoch || gen !== this.generation) {throw new Error('cancelled');}
      if (typeof result?.t === 'number') {return result.t;}
      const inc = result?.incomplete;
      if (!inc) {return result && result.t === null ? null : undefined;}
      if (inc.cancelled) {throw new Error('cancelled');}
      if (inc.timedOut && inc.resume && typeof inc.resume.t === 'number') {
        t = inc.resume.t; inclusive = inc.resume.inclusive === true;
        continue;
      }
      if (inc.tooLarge) {vscodeWrapper.outputLog('value search: ' + (inc.reason || 'signal too large for searchText') + ', scanning in the viewer');}
      return undefined;
    }
  }

  private async scanChunks(s: SignalWindows, start: number, dir: number, ok: Pred, gen: number): Promise<number | null | undefined> {
    const epoch = this.navEpoch;
    const end = viewport.timeStop + 1;
    // First span: about SCAN_BUCKETS changes at the density of a loaded window around start.
    let span = Math.max(1024, viewport.timeScrollRight - viewport.timeScrollLeft);
    const near = this.bestWindowAt(s, Math.max(0, start));
    if (near) {
      const n = near.counts ? near.counts.reduce((x, y) => x + y, 0) : near.data.valueChangeData.length;
      if (n > 0) {span = Math.max(16, Math.floor((near.t1 - near.t0) * SCAN_BUCKETS / n));}
    }
    let a = Math.max(0, start);      // dir 1: changes in (a, ...) are scanned next
    let b = Math.min(end, start);    // dir -1: changes in [..., b) are scanned next
    for (let round = 0; round < 100000; round++) {
      if (this.navEpoch !== epoch || gen !== this.generation) {return undefined;}
      if (dir > 0 ? a >= end : b <= 0) {return null;}
      // dir 1: window [a, a + span): record 0 is the value at a, records 1.. the changes in
      // (a, a + span). dir -1: window [lo - 1, b): records 1.. the changes in [lo, b); at
      // lo = 0 record 0 (the value at time 0) counts too, as in upstream's array.
      const t0 = dir > 0 ? a : Math.max(0, b - span - 1);
      const t1 = dir > 0 ? Math.min(end, a + span) : b;
      const {result, bin} = await this.navQuery('window', {signals: [{signalId: s.signalId, width: s.width}], t0, t1, buckets: SCAN_BUCKETS});
      if (this.navEpoch !== epoch || gen !== this.generation) {return undefined;}
      const [d] = await this.decodeSignals(result, bin || new Uint8Array(0), SCAN_BUCKETS);
      if (!d || d.err !== null || d.raw === null) {throw new Error('value search: ' + (d ? d.err : 'no reply'));}
      const count = Number(d.h.count) || 0;
      if (!d.h.exact) { // too dense for one exact chunk: shrink to fit and ask again
        span = Math.max(1, Math.floor((t1 - t0) * (SCAN_BUCKETS * 1.6) / Math.max(1, count)));
        continue;
      }
      const recs = parseRecords(d.raw, s.width, !!d.h.text); // vscode-port: text rows
      if (recs.length === 0 || recs[0][0] !== t0) {throw new Error('value search: window does not start at t0');}
      this.keepScanWindow(s, t0, t1, d.h, recs);
      if (dir > 0) {
        // No marker (start -1): record 0, the value at time 0, counts too, as upstream's
        // search from index 0 (review L2).
        for (let i = start < 0 && t0 === 0 ? 0 : 1; i < recs.length; i++) {if (recs[i][0] > start && ok(recs[i][1])) {return recs[i][0];}}
        a = t1 - 1; // the next window's record 0 is the value at t1 - 1, so a change at t1 is a record
        if (t1 >= end) {return null;}
      } else {
        for (let i = recs.length - 1; i >= 1; i--) {if (recs[i][0] < start && ok(recs[i][1])) {return recs[i][0];}}
        if (t0 === 0) {return recs[0][0] < start && ok(recs[0][1]) ? 0 : null;}
        b = t0 + 1;
      }
      // Grow toward about half the exact limit.
      span = Math.max(1, Math.floor((t1 - t0) * Math.min(8, Math.max(1, (SCAN_BUCKETS * 1.0) / Math.max(1, count)))));
    }
    return undefined;
  }

  // An exact chunk fetched by a search: kept as an exact window (drawn and searched locally).
  private keepScanWindow(s: SignalWindows, t0: number, t1: number, h: any, recs: ValueChange[]) {
    if (!this.isWindowed(s.signalId)) {return;}
    const key = 'scan:' + t0 + ':' + t1;
    const w = this.makeWindow(key, 0, t0, t1, SCAN_BUCKETS, {...h, exact: true}, recs, null, s.width);
    const old = s.windows.get(key);
    if (old) {s.bytes -= old.bytes;}
    s.windows.set(key, w);
    s.bytes += w.bytes;
    s.scanKey = key; // the latest chunk survives eviction until the next one
    this.evict(s);
    this.scheduleRedraw();
  }

  // WaveDrom copy: fetch exact data for [marker, alt marker], then run upstream's copyWaveDrom
  // on it. Upstream's output stops at 32 transitions (clock mode: 32 clock edges), so when
  // the range is too dense for one reply it is cut to what the output can use, and the rows
  // still dense there are fetched again with enough buckets to be exact.
  async copyWaveDrom() {
    if (viewerState.markerTime === null || viewerState.altMarkerTime === null) {return;}
    const gen = this.generation;
    const epoch = this.navEpoch;
    // Start one unit early so the first record precedes the window (wavedrom.ts looks one back).
    const t0 = Math.max(0, Math.min(viewerState.markerTime, viewerState.altMarkerTime) - 1);
    let t1 = Math.max(viewerState.markerTime, viewerState.altMarkerTime) + 1;
    const ids: SignalId[] = [];
    viewerState.displayedSignalsFlat.forEach((rowId) => {
      const item = rowHandler.rowItems[rowId];
      if (item instanceof NetlistVariable && this.isWindowed(item.signalId) && !ids.includes(item.signalId!)) {ids.push(item.signalId!);}
    });
    const clockItem = rowHandler.rowItems.find((r) => r instanceof NetlistVariable && r.netlistId === dataManager.waveDromClock.netlistId);
    const clockId = clockItem instanceof NetlistVariable ? clockItem.signalId : undefined;
    // The clock may be windowed or loaded whole (hybrid); either way it alone sets the reach.
    const clockLocal = clockId !== undefined && !ids.includes(clockId) ? dataManager.valueChangeData[clockId]?.valueChangeData : undefined;
    const clockMode = dataManager.waveDromClock.netlistId !== null && clockId !== undefined && (ids.includes(clockId) || clockLocal !== undefined);
    const exact = new Map<SignalId, ValueChange[]>();
    const fetch = async (sigIds: SignalId[], buckets: number) => {
      // Escape, or a file reload, between passes: stop (never query the new file).
      if (this.navEpoch !== epoch || gen !== this.generation) {throw new Error('cancelled');}
      const sigs = sigIds.map((id) => this.signals.get(id)).filter((x): x is SignalWindows => x !== undefined);
      if (sigs.length === 0) {return [];}
      const {result, bin} = await this.navQuery('window', {signals: sigs.map((x) => ({signalId: x.signalId, width: x.width})), t0, t1, buckets});
      const dense: {id: SignalId; counts: Uint32Array; count: number}[] = [];
      const decoded = await this.decodeSignals(result, bin || new Uint8Array(0), buckets);
      // The decode awaits (inflate): an Escape or reload may have come in meanwhile.
      if (this.navEpoch !== epoch || gen !== this.generation) {throw new Error('cancelled');}
      const widthOf = new Map(sigs.map((x) => [x.signalId, x.width])); // the widths this request was made with
      decoded.forEach(({h, raw, counts, err}) => {
        if (err !== null || raw === null) {vscodeWrapper.outputLog('WaveDrom: ' + h.signalId + ' left out: ' + err); return;}
        const width = widthOf.get(h.signalId);
        if (width === undefined) {return;}
        if (h.exact) {exact.set(h.signalId, parseRecords(raw, width, !!h.text));} // vscode-port: text rows
        else {dense.push({id: h.signalId, counts: counts!, count: Number(h.count) || 0});}
      });
      return dense;
    };
    // Cut t1 where `counts` passes n changes (counts cover [t0, t1)).
    const cutAt = (counts: Uint32Array, n: number) => {
      let sum = 0;
      for (let k = 0; k < counts.length; k++) {
        sum += counts[k];
        if (sum >= n) {return t0 + Math.floor(((k + 1) * (t1 - t0)) / counts.length);}
      }
      return t1;
    };
    this.wavedromBusy++;
    try {
      let dense = ids.length ? await fetch(ids, 64) : [];
      if (clockMode) {
        // Only the clock decides how far clock-mode output reaches (M6): just past its 33rd
        // change of the chosen polarity, or ~70 changes when it is too dense to say exactly.
        const clockExact = exact.get(clockId!);
        const clockDense = dense.find((d) => d.id === clockId);
        if (clockLocal) {
          let n = 0;
          for (let i = upperBound(clockLocal, t0); i < clockLocal.length && clockLocal[i][0] < t1; i++) {
            if (clockLocal[i][1] === dataManager.waveDromClock.edge && ++n > 33) {t1 = clockLocal[i][0] + 1; break;}
          }
        } else if (clockExact) {
          const edges = clockExact.filter((r, i) => i > 0 && r[1] === dataManager.waveDromClock.edge);
          if (edges.length > 33) {t1 = edges[33][0] + 1;}
        } else if (clockDense) {
          t1 = Math.min(t1, cutAt(clockDense.counts, 70));
        }
      } else {
        dense.forEach(({counts}) => {t1 = Math.min(t1, cutAt(counts, 70));});
      }
      // Rows exact on the long range stay exact on the shorter one; fetch the dense rest
      // with enough buckets to be exact (L6: say so if a row still isn't).
      for (let pass = 0; pass < 2 && dense.length; pass++) {
        const want = Math.max(64, ...dense.map((d) => Math.ceil(d.count / 2) + 1));
        dense = await fetch(dense.map((d) => d.id), Math.min(1 << 20, pass === 0 ? 64 : want));
      }
      dense.forEach((d) => vscodeWrapper.outputLog('WaveDrom: ' + d.id + ' left out: too many changes in range'));
    } catch (e) {
      vscodeWrapper.outputLog('WaveDrom: ' + (e as Error).message);
      if (gen === this.generation) {this.noticeIfTimedOut(e, 'WaveDrom copy');}
      return;
    } finally {
      this.wavedromBusy--;
    }
    if (gen !== this.generation || this.navEpoch !== epoch) {return;}
    copyWaveDrom((signalId) => exact.get(signalId));
  }

  getStats() {
    let windows = 0, bytes = 0;
    this.signals.forEach((s) => {windows += s.windows.size; bytes += s.bytes;});
    return {...this.stats, signals: this.signals.size, windows, bytesCached: bytes, inflight: this.inflight.size};
  }
}
