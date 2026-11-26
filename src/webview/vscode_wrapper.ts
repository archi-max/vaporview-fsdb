import * as vscodeTypes from 'vscode';

import { MarkerSetEvent, SignalEvent, ValueLinkEvent } from "../../packages/vaporview-api/types";
import { createInstancePath } from "../common/functions";
import { QueueEntry, WindowMessageType, StateChangeType, NetlistId, RowId, ConfigSettingsMessage, ExternalKeyDownMessage, EmitEventMessage, WebviewDropMessage } from "../common/types";
import { ActionType, type EventHandler } from './event_handler';
import { SignalGroup, NetlistVariable, CustomVariable } from "./signal_item";
import { viewerState, events, createWebviewContext, viewport, rowHandler, getParentGroupIdList, labelsPanel, dataManager, controlBar, styles, unload, init, revealSignal, config, dragController, windowCache, vscodeWrapper } from "./vaporview"; // cmux: windowed loading
import { copyWaveDrom } from "./wavedrom";

import { differenceCiede2000, rgb } from "culori";
import { handleExtraMessage } from "./extra_formats";

declare function acquireVsCodeApi(): VsCodeApi;
const vscode: VsCodeApi = (window as unknown as {cmuxVsCodeApi?: VsCodeApi}).cmuxVsCodeApi || acquireVsCodeApi(); // vscode-port: media/cmux/bridge.js acquires it first and shares it

// vscode-port: e2e test hook. The extension only sends 'e2e-query' when VAPORVIEW_E2E=1, so this is inert otherwise.
// query.kind 'texts': innerText of every element matching query.selector (max 500); 'count': number of matches.
// vscode-port: viewer state and actions for the wisp e2e tests (windowed rows, marker, edges, value search).
// A row on screen, as window_cache.visibleSignals() decides it (row bounds inside the vertical scroll range).
function e2eInView(rowId: number): boolean {
  if (!viewerState.visibleSignalsFlat.includes(rowId)) {return false;}
  const b = viewport.getRowIdBounds(rowId); const top = viewport.pseudoScrollTop;
  return b !== null && b[1] > top && b[0] < top + viewport.viewerHeight;
}
let e2eScrollMs = -1;
// Main-thread blocks over 50 ms seen since the first e2e query (PerformanceObserver 'longtask'): the longest and
// the last 20, so a test can report how long the page was unresponsive.
let e2eLongTasks: {max: number, recent: number[]} | null = null;
function e2eWatchLongTasks() {
  if (e2eLongTasks) {return;}
  e2eLongTasks = {max: 0, recent: []};
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { const lt = e2eLongTasks!; lt.max = Math.max(lt.max, e.duration); lt.recent.push(Math.round(e.duration)); if (lt.recent.length > 20) {lt.recent.shift();} } })
      .observe({type: 'longtask', buffered: true} as any);
  } catch { /* no longtask support: max stays 0 */ }
}
function e2eRows() {
  return viewerState.displayedSignalsFlat.map((rowId) => {
    const item: any = rowHandler.rowItems[rowId];
    const sid = item?.signalId;
    return {rowId, name: item?.signalName, signalId: sid, encoding: item?.encoding, windowed: sid !== undefined && windowCache.isWindowed(sid),
      format: item?.valueFormat?.id, formatCached: !!(item?.getWaveformData?.()?.formattedValues?.[item?.valueFormat?.id]?.formatCached), inView: e2eInView(rowId), value: labelsPanel.valueAtMarker[rowId] ?? null, loaded: sid !== undefined && !!dataManager.valueChangeData[sid], summary: sid !== undefined && dataManager.summarySignals.has(sid), summaryBadge: !!document.querySelector(`#label-${rowId} .vv-summary-badge`)};
  });
}
function e2eAction(q: any): any {
  const rows = e2eRows();
  const row = q.name !== undefined ? rows.find((r) => r.name === q.name) : undefined;
  if (q.kind === 'select') {
    if (!row) {throw new Error('no row ' + q.name);}
    events.signalSelect([row.rowId], row.rowId);
  } else if (q.kind === 'marker') {
    events.markerSet(Number(q.time), 0, false);
    // click: true does what a click in the viewport does after the marker event: send the context (the extension's
    // markerTime follows). Off by default, so the other suites' message counts are unchanged.
    if (q.click) {vscodeWrapper.sendWebviewContext(StateChangeType.User);}
  } else if (q.kind === 'edge') {
    controlBar.goToNextTransition(0, Number(q.direction), q.edge || []);
  } else if (q.kind === 'zoomRange') {
    viewport.animateZoomRange(Number(q.t0), Number(q.t1));
  } else if (q.kind === 'cancelProbe') {
    // A whole-dump window for one windowed row, cancelled at once: the cancel goes viewer -> host -> helper.
    if (!row) {throw new Error('no row ' + q.name);}
    const wc: any = windowCache;
    const {id, reply} = wc.query('window', {signals: [{signalId: row.signalId, width: (rowHandler.rowItems[row.rowId] as any).signalWidth}], t0: 0, t1: Math.max(1, viewport.timeStop), buckets: 4194304}, 60000);
    reply.catch(() => {});
    wc.cancelQuery(id, 'cancelled');
  } else if (q.kind === 'windowFail') { // vscode-port: e2e feeds a row's own window error (as the helper words it)
    if (!row) {throw new Error('no row ' + q.name);}
    const wc: any = windowCache;
    const s = wc.signals.get(row.signalId);
    if (!s) {throw new Error('row ' + q.name + ' is not windowed');}
    wc.fail(s, String(q.msg), true);
    return {fails: s.fails, noValue: s.noValue, denseZoom: s.denseZoom};
  } else if (q.kind === 'hybrid') { // vscode-port: e2e turns hybrid whole loads off/on (wisp-stream needs windows)
    (windowCache as any).hybrid = !!q.on;
    return {hybrid: (windowCache as any).hybrid};
  } else if (q.kind === 'formatSlicePause') {
    (globalThis as any).vvE2EFormatSlicePauseMs = Number(q.ms) || 0; // row_handler's format-cache slices wait this long
  } else if (q.kind === 'scrollTop') {
    // Scrolls after this reply (the redraw can be long with many whole-loaded rows); e2eScrollMs = the last scroll's
    // redraw time, for the test's diagnostics.
    const top = Math.max(0, Math.min(viewport.maxScrollTop, Number(q.top)));
    setTimeout(() => { const t0 = performance.now(); viewport.handleScrollEvent(viewport.pseudoScrollLeft, top); e2eScrollMs = performance.now() - t0; }, 0);
  } else if (q.kind === 'format') {
    // A row's value format, as the setDisplayFormat message sets it (e.g. riscv); textSearch false makes value
    // searches skip searchText and scan in the page (the perf comparison).
    if (!row) {throw new Error('no row ' + q.name);}
    rowHandler.setDisplayFormat({rowId: row.rowId, numberFormat: q.format} as any, true);
    if (q.textSearch !== undefined) {(windowCache as any).textSupported = q.textSearch !== false;}
  } else if (q.kind === 'searchValue') {
    const cb: any = controlBar;
    cb.searchBar.value = String(q.value);
    cb.handleSearchButtonSelect(1); // SearchState.Value
    cb.handleSearchGoTo(Number(q.direction) || 1);
  }
  const wc: any = windowCache;
  const sigs: any[] = [];
  (wc.signals as Map<number, any>).forEach((s: any) => sigs.push({signalId: s.signalId, hybrid: s.hybrid, windows: s.windows.size,
    exactWindows: [...s.windows.values()].filter((w: any) => w.exact).length, decimatedWindows: [...s.windows.values()].filter((w: any) => !w.exact).length,
    fails: s.fails, failMsg: s.failMsg, noValue: s.noValue, denseZoom: s.denseZoom, inflight: s.inflight.size}));
  return {longTasks: e2eLongTasks, scrollMs: e2eScrollMs, scrollTop: viewport.pseudoScrollTop, maxScrollTop: viewport.maxScrollTop, viewerHeight: viewport.viewerHeight, markerTime: viewerState.markerTime, selected: viewerState.selectedSignal, rows: e2eRows(), timeStop: viewport.timeStop,
    viewerWidth: viewport.viewerWidth, zoomRatio: viewport.zoomRatio, scrollLeft: viewport.pseudoScrollLeft, viewerWidthTime: viewport.viewerWidthTime,
    windowing: {enabled: wc.enabled, stats: {requests: wc.stats.requests, replies: wc.stats.replies, cancels: wc.stats.cancels, queries: wc.stats.queries,
      prefetchQueries: wc.stats.prefetchQueries, navHits: wc.stats.navHits, bytesIn: wc.stats.bytesIn, promoted: wc.stats.promoted,
      partials: wc.stats.partials, firstPartMs: wc.stats.firstPartMs.slice(-20), fullMs: wc.stats.fullMs.slice(-20), navDone: wc.stats.navDone, navMs: wc.stats.navMs.slice(-20), visibleMs: wc.stats.visibleMs.slice(-50), wholeLoads: wc.stats.wholeLoads, slowSteps: wc.stats.slowSteps.slice(-30), renderMsMax: Math.round(Math.max(0, ...wc.stats.renderMs)), remote: wc.remote, inflight: wc.inflight.size}, signals: sigs}};
}
// vscode-port: 'idle' waits two animation frames, then reports whether data or window requests are
// still pending (the visual suite captures only when idle); 'rects' gives each match's bounding box (layout checks).
async function e2eIdle() {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wc: any = windowCache;
  const pendingQueries = wc && wc.queries && typeof wc.queries.size === 'number' ? wc.queries.size : 0;
  const busy = dataManager.requestActive || dataManager.queued.length > 0 || pendingQueries > 0 || !!(wc && wc.navBusy);
  return {idle: !busy, requestActive: dataManager.requestActive, queued: dataManager.queued.length, pendingQueries, navBusy: !!(wc && wc.navBusy)};
}
function handleE2EQuery(message: any) {
  e2eWatchLongTasks();
  let result: any = null; let error: string | null = null;
  const q0 = message.query || {};
  if (q0.kind === 'view') { // vscode-port: the visible time range and the marker
    vscode.postMessage({command: 'e2e-reply', id: message.id, error: null, result: {left: viewport.timeScrollLeft, right: viewport.timeScrollRight, width: viewport.viewerWidth, marker: viewerState.markerTime}});
    return;
  }
  if (q0.kind === 'idle') {
    e2eIdle().then((r) => vscode.postMessage({command: 'e2e-reply', id: message.id, result: r, error: null}),
      (e) => vscode.postMessage({command: 'e2e-reply', id: message.id, result: null, error: String(e)}));
    return;
  }
  try {
    const q = message.query || {};
    const els = Array.from(document.querySelectorAll(String(q.selector || 'body'))).slice(0, 500) as HTMLElement[];
    if (['state', 'select', 'edge', 'searchValue', 'marker', 'zoomRange', 'cancelProbe', 'format', 'scrollTop', 'formatSlicePause', 'hybrid', 'windowFail'].includes(q.kind)) {result = e2eAction(q);} // vscode-port
    else if (q.kind === 'count') {result = els.length;}
    else if (q.kind === 'rects') {result = els.map(e => { const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, text: e.innerText}; });}
    else if (q.kind === 'dblclick') { // vscode-port: double-click the first match whose text contains q.text
      const el = els.find(e => !q.text || e.innerText.includes(String(q.text)));
      if (el) {el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true, view: window}));}
      result = !!el;
    }
    else if (q.kind === 'attrs') {result = els.map(e => { const o: any = {}; for (const a of Array.from(e.attributes)) {o[a.name] = a.value;} return o; });}
    else {result = els.map(e => e.innerText);}
  } catch (e) {error = String(e);}
  vscode.postMessage({command: 'e2e-reply', id: message.id, result, error});
}
interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(newState: unknown): void;
  getState(): unknown;
}

export enum OS {
  Mac,
  Windows,
  Linux,
  Unknown
}

export class Configuration {
  touchpadScrolling: boolean        = false;
  autoTouchpadScrolling: boolean    = false;
  touchpadPinchSensitivity: number  = 18;
  rulerLines: boolean               = true;
  fillMultiBitValues: boolean       = false;
  multiBitFixedHeight: boolean      = true;
  removeGlitchTransitions: boolean  = false;
  defaultTimeUnit: string           = "none";
  enableAnimations: boolean         = true;
  animationDuration: number         = 50;
  useGlow: boolean                  = false;
  overrideDevicePixelRatio: boolean = false;
  userPixelRatio: number            = 1;
  disableAnalogRendererOptimizations: boolean = false;

  defaultNameType: string           = 'fullPath';
  defaultSingleBitColor: number     = 0;
  defaultMultiBitColor: number      = 0;
  defaultParamColor: number         = 0;
  defaultStringColor: number        = 0;
  defaultEnumColor: number          = 0;
  defaultCustomSignalColor: number  = 0;
  customColorPalette: string[]      = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];

  os: OS                            = OS.Unknown;

  constructor() {
    this.os = this.getOS();
  }

  setConfigSettings(settings: ConfigSettingsMessage) {
    // Scroll and zoom settings
    if (settings.scrollingMode !== undefined) {
      controlBar.setScrollMode(settings.scrollingMode);
    }
    if (settings.touchpadPinchSensitivity !== undefined) {
      config.touchpadPinchSensitivity = settings.touchpadPinchSensitivity;
    }
    if (settings.rulerLines !== undefined) {
      if (this.rulerLines !== settings.rulerLines) {
        this.rulerLines = settings.rulerLines;
        viewport.updateBackgroundCanvas();
      }
    }
    if (settings.defaultTimeUnit !== undefined) {
      this.defaultTimeUnit = settings.defaultTimeUnit;
    }

    // Renderer Settings
    if (settings.fillMultiBitValues !== undefined) {
      this.fillMultiBitValues = settings.fillMultiBitValues;
      viewport.renderAllWaveforms();
    }

    if (settings.multiBitFixedHeight !== undefined) {
      this.multiBitFixedHeight = settings.multiBitFixedHeight;
      viewport.renderAllWaveforms();
    }

    if (settings.disableAnalogRendererOptimizations !== undefined) {
      this.disableAnalogRendererOptimizations = settings.disableAnalogRendererOptimizations;
    }

    if (settings.removeGlitchTransitions !== undefined) {
      this.removeGlitchTransitions = settings.removeGlitchTransitions;
      viewport.renderAllWaveforms();
    }

    // Animation Settings
    if (settings.enableAnimations !== undefined) {
      this.enableAnimations = settings.enableAnimations;
    }
    if (settings.animationDuration !== undefined) {
      this.animationDuration = settings.animationDuration;
    }

    // Glow Settings
    if (settings.useGlow !== undefined) {
      this.useGlow = settings.useGlow;
      styles.updateglowBlur();
      viewport.renderAllWaveforms();
    }

    // Default Colors and Name Type
    if (settings.defaultNameType !== undefined) {
      this.defaultNameType = settings.defaultNameType;
    }
    if (settings.defaultSingleBitColor !== undefined) {
      this.defaultSingleBitColor = Math.floor(settings.defaultSingleBitColor - 1);
    }
    if (settings.defaultMultiBitColor !== undefined) {
      this.defaultMultiBitColor = Math.floor(settings.defaultMultiBitColor - 1);
    }
    if (settings.defaultParamColor !== undefined) {
      this.defaultParamColor = Math.floor(settings.defaultParamColor - 1);
    }
    if (settings.defaultStringColor !== undefined) {
      this.defaultStringColor = Math.floor(settings.defaultStringColor - 1);
    }
    if (settings.defaultEnumColor !== undefined) {
      this.defaultEnumColor = Math.floor(settings.defaultEnumColor - 1);
    }
    if (settings.defaultCustomSignalColor !== undefined) {
      this.defaultCustomSignalColor = Math.floor(settings.defaultCustomSignalColor - 1);
    }

    // Fallback custom colors
    if (settings.customColorPalette !== undefined) {
      this.customColorPalette = settings.customColorPalette;
      if (!styles.themeValid) {
        styles.updateColorPalette(this.customColorPalette, this.customColorPalette, false);
      }
    }

    // Pixel Ratio
    const oldPixelRatio = viewport.pixelRatio;
    if (settings.overrideDevicePixelRatio !== undefined) {
      config.overrideDevicePixelRatio = settings.overrideDevicePixelRatio;
      viewport.setPixelRatio();
    }
    if (settings.userPixelRatio !== undefined) {
      config.userPixelRatio = settings.userPixelRatio;
      viewport.setPixelRatio();
    }
    if (oldPixelRatio !== viewport.pixelRatio) {
      // this is an expensive operation, so only do it if the pixel ratio changed
      viewport.updateViewportWidth();
    }
    viewport.setRulerVscodeContext();
  }

  getOS(): OS {
    const platform = navigator.userAgent ?? "";
    //console.log('platform', platform);
    if (/mac/i.test(platform))     return OS.Mac;
    if (/win/i.test(platform))     return OS.Windows;
    if (/linux/i.test(platform))   return OS.Linux;
    return OS.Unknown;
  }
}

interface ColorProfile {
  index: number;
  color: string;
  rgbColor: ReturnType<typeof rgb>;
  deltaBackground: number | undefined;
  deltaXZ: number | undefined;
  tier: number;
}

export class ThemeColors {

  colorKey: string[] = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];
  themeValid: boolean = false;
  xzColor: string = 'red';
  textColor: string = 'white';
  rulerTextColor: string = 'grey';
  rulerGuideColor: string = 'grey';
  edgeGuideColor: string = 'orange';
  markerColor: string = 'white';
  highlightColor: string = 'blue';
  backgroundColor: string = 'black';
  dropBackgroundColor: string = 'grey';
  fontSize: string = '12px';
  fontFamily: string = 'Menlo';
  fontStyle: string = '12px Menlo';
  characterWidth: number = 7.69;
  baselineOffset: number = 0;
  markerAnnotation: string = 'white';
  selectionBackgroundColor: string = 'blue';
  selectionContrastBorder: string = 'white';
  selectionBorderColor: string = 'white';
  rowHeight: number = 28;
  rowPadding: number = 4;
  rulerHeight: number = 36;
  scrollbarHeight: number = 12;
  scrollbarWidth: number = 14;
  glowBlur: number = 0;       // waveform traces (canvas)
  textGlowBlur: number = 0;   // bus value text (canvas)

  constructor(
    private events: EventHandler
  ) {
    this.handleUpdateColorTheme = this.handleUpdateColorTheme.bind(this);
    this.events.subscribe(ActionType.UpdateColorTheme, this.handleUpdateColorTheme);
  }

  handleUpdateColorTheme() {
    this.getThemeColors();
  }

  updateglowBlur() {
    this.glowBlur     = config.useGlow ? 4 * viewport.pixelRatio : 0;
    this.textGlowBlur = config.useGlow ? 3 * viewport.pixelRatio : 0;
  }

  getThemeColors() {

    const style = window.getComputedStyle(document.body);
    // Token colors
    //this.colorKey[0] = style.getPropertyValue('--vscode-debugTokenExpression-number');
    //this.colorKey[1] = style.getPropertyValue('--vscode-debugTokenExpression-string');
    //this.colorKey[2] = style.getPropertyValue('--vscode-debugTokenExpression-type');
    //this.colorKey[3] = style.getPropertyValue('--vscode-debugTokenExpression-name');

    // Non-2-State Signal Color
    this.xzColor = style.getPropertyValue('--vscode-debugTokenExpression-error');
    //this.xzColor = style.getPropertyValue('--vscode-list-errorForeground');

    // Text Color
    this.textColor = style.getPropertyValue('--vscode-editor-foreground');

    // Ruler Color
    this.rulerTextColor = style.getPropertyValue('--vscode-editorLineNumber-foreground');
    this.rulerGuideColor = style.getPropertyValue('--vscode-editorIndentGuide-background');
    //this.edgeGuideColor = style.getPropertyValue('--vscode-terminal-findMatchBackground');
    this.edgeGuideColor = style.getPropertyValue('--vscode-terminalOverviewRuler-findMatchForeground');

    // Marker Color
    this.markerColor = style.getPropertyValue('--vscode-editorLineNumber-activeForeground');

    this.highlightColor = style.getPropertyValue('--vscode-editor-selectionBackground');

    // I calculated this as 174, 176, 173 @ 10% opacity in the default theme, but there was no CSS color that matched
    this.markerAnnotation = document.documentElement.style.getPropertyValue('--vscode-editorOverviewRuler-selectionHighlightForeground');

    // Selection colors
    this.selectionBackgroundColor = style.getPropertyValue('--vscode-list-activeSelectionBackground');
    this.selectionContrastBorder = style.getPropertyValue('--vscode-contrastActiveBorder');
    this.selectionBorderColor = style.getPropertyValue('--vscode-focusBorder');

    // Background Color
    this.backgroundColor = style.getPropertyValue('--vscode-editor-background');

    // Drop Background Color
    this.dropBackgroundColor = style.getPropertyValue('--vscode-list-dropBackground');

    // Font
    this.fontSize = style.getPropertyValue('--vscode-editor-font-size');
    this.fontFamily = style.getPropertyValue('--vscode-editor-font-family');
    this.fontStyle = this.fontSize + ' ' + this.fontFamily;

    // Look through all of the fonts in the fontFamily to see which font was used
    const fontList = this.fontFamily.split(',').map((font) => font.trim());
    let usedFont = '';
    for (let i = 0; i < fontList.length; i++) {
      const font = fontList[i];
      if (document.fonts.check('12px ' + font)) {
        usedFont = fontList[i];
        break;
      }
    }

    const sample        = '0'.repeat(100);
    const ctx           = viewport.overlayCanvas;
    ctx.font            = this.fontStyle;
    this.characterWidth = ctx.measureText(sample).width / sample.length;
    this.baselineOffset = (usedFont === 'Consolas') ? 1 : 0;

    this.rowHeight   = parseInt(style.getPropertyValue('--waveform-height'));
    this.rowPadding  = parseInt(style.getPropertyValue('--waveform-padding'));
    this.rulerHeight = parseInt(style.getPropertyValue('--ruler-height'));
    this.scrollbarHeight = parseInt(style.getPropertyValue('--scrollbar-height'));
    this.scrollbarWidth  = parseInt(style.getPropertyValue('--scrollbar-width'));
  }

  // We're not done selecting a color palette here! We need to filter out
  // colors that are too close to the background color or the non-2-state color
  // Step 5: Compare the colors in the palette to the background color and the
  //         non-2-state color, and bin them based on how close they are
  // Step 6: Select from all of our top tier colors, and if we don't have
  //         enough colors, then select from the next tier, etc.
  updateColorPalette(colorPalette: string[], errorColorPalette: string[], themeValid: boolean) {

    const style          = window.getComputedStyle(document.body);
    this.backgroundColor = style.getPropertyValue('--vscode-editor-background');
    this.xzColor         = style.getPropertyValue('--vscode-debugTokenExpression-error');
    this.themeValid      = themeValid;

    if (!themeValid) {
      //console.log("Using default color palette because theme is not valid");
      this.colorKey = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];
      this.colorKey[0] = style.getPropertyValue('--vscode-debugTokenExpression-number');
      this.colorKey[1] = style.getPropertyValue('--vscode-debugTokenExpression-string');
      this.colorKey[2] = style.getPropertyValue('--vscode-debugTokenExpression-type');
      this.colorKey[3] = style.getPropertyValue('--vscode-debugTokenExpression-name');
      this.colorKey[4] = config.customColorPalette[0];
      this.colorKey[5] = config.customColorPalette[1];
      this.colorKey[6] = config.customColorPalette[2];
      this.colorKey[7] = config.customColorPalette[3];
      this.events.updateColorTheme();
      return;
    }

    if (this.backgroundColor === undefined) {return;}
    if (this.xzColor === undefined) {return;}
    const rgbBackground = rgb(this.backgroundColor);
    const rgbXZ = rgb(this.xzColor);
    if (rgbBackground === undefined) {return;}
    if (rgbXZ === undefined) {return;}

    //console.log(`--- Background color: ${this.backgroundColor} rgb(${rgbBackground.r}, ${rgbBackground.g}, ${rgbBackground.b})`);
    //console.log(`--- XZ color: ${this.xzColor} rgb(${rgbXZ.r}, ${rgbXZ.g}, ${rgbXZ.b})`);

    const deltaE = differenceCiede2000();
    let colorIndex = 1;

    const topTierColors: number[] = [];
    const midTierColors: number[] = [];
    const lowTierColors: number[] = [];
    const bottomTierColors: number[] = [];

    const colorProfiles: ColorProfile[] = [];

    // Arrange colors into tiers based on their distance from the background color
    // And similarity to the XZ color
    const colorList = colorPalette.concat(errorColorPalette);
    colorList.forEach((color, index) => {
      //if (topTierColors.length >= 8) {return;}
      const rgbColor = rgb(color);
      if (rgbColor === undefined) {
        colorProfiles.push({
          index: index,
          color: color,
          rgbColor: undefined,
          deltaBackground: undefined,
          deltaXZ: undefined,
          tier: 5,
        });
        return;
      }

      // round to 2 decimal places for logging
      const deltaBackground = Math.round(deltaE(rgbBackground, rgbColor) * 100) / 100;
      const deltaXZ         = Math.round(deltaE(rgbColor, rgbXZ) * 100) / 100;

      let tier = 0;
      if (deltaBackground >= 35 && deltaXZ >= 15) {
        topTierColors.push(index);
        tier = 1;
      } else if (deltaBackground >= 30 && deltaXZ >= 15) {
        midTierColors.push(index);
        tier = 2;
      } else if (deltaBackground >= 25 && deltaXZ >= 10) {
        lowTierColors.push(index);
        tier = 3;
      } else if (deltaBackground >= 15) {
        bottomTierColors.push(index);
        tier = 4;
      }

      colorProfiles.push({
        index: index,
        color: color,
        rgbColor: rgbColor,
        deltaBackground: deltaBackground,
        deltaXZ: deltaXZ,
        tier: tier,
      });

      //console.log(`Color ${colorIndex} ${color} has deltaE of ${deltaBackground} from background color and deltaE of ${deltaXZ} from XZ color - tier: ${tier}`);
      colorIndex++;
    });

    const contrastSortedColors = topTierColors.concat(midTierColors).concat(lowTierColors).concat(bottomTierColors);
    const finalColorPalette: number[] = [];
    const secondaryColorPalette: number[] = [];
    const tertiaryColorPalette: number[] = [];

    // Next, we check to see how similar they are to each other, and bump them in to lower tiers if
    // they're too similar to other colors in the color palette
    contrastSortedColors.forEach(index => {
      if (finalColorPalette.length >= 8) {return;}
      const testColorProfile = colorProfiles[index];
      if (!testColorProfile) {return;}
      const testRgbColor = testColorProfile.rgbColor;
      if (testRgbColor === undefined) {return;}

      let minDelta = Infinity;
      finalColorPalette.forEach(index => {
        const paletteColorProfile = colorProfiles[index];
        if (!paletteColorProfile) {return;}
        const paletteRgbColor = paletteColorProfile.rgbColor;
        if (paletteRgbColor === undefined) {return;}
        const delta = Math.round(deltaE(testRgbColor, paletteRgbColor) * 100) / 100;
        minDelta = Math.min(minDelta, delta);
      });

      //console.log(`Color ${testColorProfile.color} has minimum deltaE of ${minDelta} from colors in final palette`);

      if (minDelta >= 8) {
        finalColorPalette.push(index);
      } else if (minDelta >= 5) {
        secondaryColorPalette.push(index);
      } else {
        tertiaryColorPalette.push(index);
      }
    });

    // Lastly, we want to make sure that something kind of far from red is color 1
    const similaritySortedColors = finalColorPalette.concat(secondaryColorPalette).concat(tertiaryColorPalette);

    const color1Index   = similaritySortedColors[0];
    const color1Profile = colorProfiles[color1Index];
    const color1DeltaXZ = Math.min(color1Profile.deltaXZ ?? 0, 35);
    const color2Index   = similaritySortedColors[1];
    const color2Profile = colorProfiles[color2Index];
    const color2DeltaXZ = Math.min(color2Profile.deltaXZ ?? 0, 35);
    if (color1DeltaXZ < color2DeltaXZ) {
      // Swap color1 and color2
      similaritySortedColors[0] = color2Index;
      similaritySortedColors[1] = color1Index;
    }

    this.colorKey = similaritySortedColors.map(index => colorProfiles[index].color);
    this.events.updateColorTheme();
  }
}

export class VscodeWrapper {

  private initComplete: boolean = false;

  constructor(private events: EventHandler) {

    window.addEventListener('message', (e) => {this.handleMessage(e);});
    window.addEventListener('blur',    ()  => {this.handleFocusBlur(false);});
    window.addEventListener('focus',   ()  => {this.handleFocusBlur(true);});

    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);
    this.handleMarkerSet    = this.handleMarkerSet.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);

    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
  }

  webviewReady() {
    vscode.postMessage({command: 'ready'});
  }

  setInitComplete() {
    this.initComplete = true;
    vscode.postMessage({command: 'initialized'});
  }

  handleMessage(e: MessageEvent) {
    const message = e.data;
    if (handleExtraMessage(message)) {return;} // RISC-V and alias formats
    if (message && message.cmuxBridge === true) {return;} // vscode-port: for media/cmux/bridge.js
    if (message && message.command === 'e2e-query') {handleE2EQuery(message); return;} // vscode-port: test hook (only answered when the extension runs its e2e suite)

    switch (message.command) {
      case 'initViewport':          {init(message); break;}
      case 'unload':                {unload(); break;}
      case 'getContext':            {this.sendWebviewContext(StateChangeType.None); break;}
      case 'setConfigSettings':     {config.setConfigSettings(message); break;}
      case 'apply-state':           {rowHandler.applyState(message.state, message.stateChangeType); break;}
      case 'add-variable':          {rowHandler.addVariable(message.signalList, message.groupPath, undefined, message.index, message.selectLast === true); break;} // vscode-port: selectLast
      case 'add-separator':         {rowHandler.addSeparator(message.name, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected); break;}
      case 'add-bit-slice':         {rowHandler.addCustomVariable(message.name, message.groupPath, message.parentGroupId, message.eventRowId, undefined, message.msb, message.lsb, undefined); break;}
      case 'add-all-bit-slices':    {rowHandler.addAllBitSlices(message.name, message.groupPath, message.parentGroupId, message.eventRowId, message.bitWidth); break;}
      case 'cmux-add-slices':       {rowHandler.addSlices(message.rowId, Array.isArray(message.parts) ? message.parts : []); break;} // cmux: slices
      case 'cmux-remove-slices':    {rowHandler.removeSlices(message.rowId); break;}
      case 'newSignalGroup':        {rowHandler.addSignalGroup(message.groupName, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected, message.showRenameInput); break;}
      case 'setDisplayFormat':      {rowHandler.setDisplayFormat(message, false); break;}
      case 'renameSignalGroup':     {rowHandler.renameSignalGroup(message.rowId, message.groupName); break;}
      case 'editSignalGroup':       {rowHandler.editSignalGroup(message); break;}
      case 'remove-signal':         {rowHandler.removeVariable(message.netlistId, message.rowId, message.removeAllSelected); break;}
      case 'remove-group':          {rowHandler.removeSignalGroup(message.groupId, message.recursive); break;}
      case 'remove-separator':      {rowHandler.removeVariable(undefined, message.rowId, message.removeAllSelected); break;}
      case 'update-waveform-chunk': {dataManager.updateWaveformChunk(message); break;}
      case 'update-waveform-chunk-compressed': {dataManager.updateWaveformChunkCompressed(message); break;}
      case 'update-enum-chunk':     {dataManager.updateEnumChunk(message); break;}
      case 'handle-keypress':       {this.externalKeyDownHandler(message); break;}
      case 'setWaveDromClock':      {dataManager.waveDromClock = {netlistId: message.netlistId, edge:  message.edge,}; break;}
      case 'setMarker':             {this.setMarker(message.time, message.markerType, message.notUser === true); break;}
      case 'setViewportTo':         {viewport.moveViewToTime(message.time); break;}
      case 'setViewportRange':      {viewport.setViewportRange(message.startTime, message.endTime); break;}
      case 'updateRulerSettings':   {this.handleUpdateRuler(message.units, message.pixelTime); break;}
      case 'setSelectedSignal':     {this.setSelectedSignal(message.netlistId); break;}
      case 'copyWaveDrom':          {if (windowCache.enabled) {windowCache.copyWaveDrom();} else {copyWaveDrom();} break;} // cmux
      case 'copyValueAtMarker':     {labelsPanel.copyValueAtMarker(message.rowId); break;}
      case 'updateColorPalette':    {styles.updateColorPalette(message.colorPalette, message.errorColorPalette, message.themeValid); break;}
      // cmux: windowed loading (protocol v2), see window_cache.ts
      case 'set-windowing':         {windowCache.configure(message); break;}
      case 'v2-reply':              {windowCache.handleReply(message); break;}
      default:                      {this.outputLog('Unknown webview message type: ' + message.command); break;}
    }
  }

  externalKeyDownHandler(e: ExternalKeyDownMessage) {
    switch (e.keyCommand) {
      //case 'nextEdge':     {controlBar.goToNextTransition(0, 1, []); break;}
      //case 'previousEdge': {controlBar.goToNextTransition(0, -1, []); break;}
      case 'zoomToFit':    {viewport.animateZoomRange(0, viewport.timeStop); break;}
      case 'increaseVerticalScale': {this.handleUpdateVerticalScale(e.event, 2); break;}
      case 'decreaseVerticalScale': {this.handleUpdateVerticalScale(e.event, 0.5); break;}
      case 'resetVerticalScale':    {this.handleUpdateVerticalScale(e.event, 0); break;}
    }
  }

  setSelectedSignal(netlistId: NetlistId | undefined) {
    if (netlistId === undefined) {return;}
    const rowIdList = rowHandler.getRowIdsFromNetlistId(netlistId);
    if (rowIdList.length === 0) {return;}
    this.events.signalSelect(rowIdList, rowIdList[0]);
    //console.log('handleSetSelectedSignal');
    this.sendWebviewContext(StateChangeType.User);
  }

  setMarker(time: number, markerType: number, notUser = false) {
    //console.log('handleMessage - setMarker');
    this.events.markerSet(time, markerType, false);
    // vscode-port: the debugger's own marker moves (notUser) are not the user's edit: upstream marks a User state change
    // dirty (866973b, undo/redo; Save writes the viewer session), which put the unsaved dot on the waveform tab while
    // stepping. Still sent, so the extension's markerTime follows.
    this.sendWebviewContext(notUser ? StateChangeType.None : StateChangeType.User);
  }

  handleUpdateRuler(units: string | undefined, pixelTime: number | undefined) {
    if (units !== undefined) {
      viewport.updateUnits(units, true);
    }
    if (pixelTime !== undefined) {
      viewport.updateRulerNumberBasis(pixelTime, true);
    }
  }

  handleUpdateVerticalScale(event: { rowId?: RowId } | null | undefined, scale: number) {
    let rowIdList: RowId[] = viewerState.selectedSignal;
    if (event && event.rowId !== undefined && !viewerState.selectedSignal.includes(event.rowId)) {
      rowIdList = [event.rowId];
    }

    rowIdList.forEach((rowId) => {
      if (rowId === null) {return;}
      const netlistData = rowHandler.rowItems[rowId];
      if (!(netlistData instanceof NetlistVariable) && !(netlistData instanceof CustomVariable)) {return;}
      const renderType = netlistData.renderType.id;
      if (renderType === "multiBit" || renderType === "binary") {return;}
      netlistData.verticalScale = Math.max(1, netlistData.verticalScale * scale);
      this.events.redrawVariable(rowId);
    }); 
  }

  handleRemoveVariable(rowIdList: RowId[], recursive: boolean) {
    const instancePathList: string[] = [];
    const netlistIdList: number[] = [];
    rowIdList.forEach(rowId => {
      const signalItem = rowHandler.rowItems[rowId];
      if (!(signalItem instanceof NetlistVariable)) {return;}
      const instancePath = createInstancePath(signalItem.scopePath, signalItem.signalName);
      if (signalItem.netlistId !== undefined) {
        netlistIdList.push(signalItem.netlistId);
      }
      instancePathList.push(instancePath);
    });

    this.emitRemoveVariableEvent(instancePathList, netlistIdList);
  }

  handleMarkerSet(time: number, markerType: number, dragging: boolean) {
    if (dragging) {return;}
    if (time > viewport.timeStop || time < 0) {return;}
    this.emitMarkerSetEvent(time, viewport.timeUnit);
  }

  handleSignalSelect(rowIdList: RowId[], lastSelected: RowId | null = null) {

    const netlistIdList: number[] = [];
    const instancePathList: string[] = [];
    rowIdList.forEach(rowId => {
      const netlistData = rowHandler.rowItems[rowId];
      if (netlistData === undefined) {return;}
      if (!(netlistData instanceof NetlistVariable)) {return;}
      if (netlistData.netlistId !== undefined) {
        netlistIdList.push(netlistData.netlistId);
      }
      const instancePath = createInstancePath(netlistData.scopePath, netlistData.signalName);
      instancePathList.push(instancePath);
    });

    if (rowIdList.length === 1) {
      this.emitSignalSelectEvent(instancePathList, netlistIdList);
    }
  }

  handleFocusBlur(state: boolean) {
    this.executeCommand('setContext', ['vaporview.waveformViewerFocused', state]);
  }

  focusWebview() {
    vscode.postMessage({command: 'focus',});
  }

  sendWebviewContext(stateChangeType: StateChangeType) {
    if (events.isBatchMode) {return;}
    if (!this.initComplete) {return;}
    const context = createWebviewContext() as Record<string, unknown>;
    context.stateChangeType = stateChangeType;
    vscode.setState(context);
    context.command = 'contextUpdate';
    vscode.postMessage(context);
  }

  restoreState() {
    const state = vscode.getState();
    vscode.postMessage({
      command: 'restoreState',
      state: state,
      uri: viewerState.uri,
    });
  }

  executeCommand(command: string, args: unknown[]) {
    vscode.postMessage({
      command: 'executeCommand',
      commandName: command,
      args: args,
    });
  }

  updateConfiguration(property: string, value: unknown) {
    vscode.postMessage({
      command: 'updateConfiguration',
      property: property,
      value: value,
    });
  }

  showMessage(messageType: WindowMessageType, message: string) {
    vscode.postMessage({
      command: 'showMessage',
      messageType: messageType,
      message: message,
    });
  }

  copyToClipboard(text: string) {
    vscode.postMessage({
      command: 'copyToClipboard',
      text: text,
    });
  }

  fetchData(requestList: QueueEntry[]) {
    //console.log('fetchData', requestList);
    vscode.postMessage({
      command: 'fetchDataFromFile',
      requestList: requestList,
    });
  }

  // cmux: protocol v2 request (window/valueAt/edge/search/cancel); the host forwards req to the helper.
  sendV2Request(req: Record<string, unknown>) {
    vscode.postMessage({command: 'v2', req: req});
  }

  outputLog(message: string) {
    vscode.postMessage({
      command: 'logOutput',
      message: message,
    });
  }

  emitRemoveVariableEvent(instancePathList: string[], netlistIdList: number[]) {
    const eventData: SignalEvent = {
      uri: viewerState.uri?.toString() || "",
      instancePath: instancePathList,
      netlistId: netlistIdList,
      source: 'viewer',
    };
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'removeVariable',
      eventData: eventData,
    } as EmitEventMessage);
  }

  emitSignalSelectEvent(instancePathList: string[], netlistIdList: number[]) {
    const eventData: SignalEvent = {
      uri: viewerState.uri?.toString() || "",
      instancePath: instancePathList,
      netlistId: netlistIdList,
      source: 'viewer',
    };
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'signalSelect',
      eventData: eventData,
    } as EmitEventMessage);
  }

  emitMarkerSetEvent(time: number, units: string) {
    const eventData: MarkerSetEvent = {
      uri: viewerState.uri?.toString() || "",
      time: time,
      units: units,
    };
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'markerSet',
      eventData: eventData,
    } as EmitEventMessage);
  }

  emitValueLinkEvent(event: ValueLinkEvent) {
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'valueLink',
      eventData: event,
    } as EmitEventMessage);
  }

  handleDrop(e: DragEvent) {
    e.preventDefault();

    if (!e.dataTransfer) {return;}
    const data    = e.dataTransfer.getData('codeeditors');
    if (!data) {return;}
    const dataObj = JSON.parse(data);
    const uriList = dataObj.map((d: { resource: vscodeTypes.Uri }) => {return d.resource;});

    const {newGroupId, newIndex} = labelsPanel.dragEndExternal(e, false);
    dragController.markEnded();

    // get the group path for the new group id
    let groupPath: string[] = [];
    const groupRowId = rowHandler.groupIdTable[newGroupId];
    if (groupRowId || groupRowId === 0) {
      groupPath = getParentGroupIdList(groupRowId).map((id) => {
        const item = rowHandler.rowItems[rowHandler.groupIdTable[id]];
        if (item instanceof SignalGroup) {
          return item.label;
        }
        return '';
      });
      const groupItem = rowHandler.rowItems[groupRowId];
      if (groupItem instanceof SignalGroup) {
        groupPath.push(groupItem.label);
      }
    }

    vscode.postMessage({
      command: 'handleDrop',
      groupPath: groupPath,
      dropIndex: newIndex,
      resourceUriList: uriList,
      uri: viewerState.uri,
      documentId: viewerState.documentId,
    } as WebviewDropMessage);
  }
}
