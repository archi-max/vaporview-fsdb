// vscode-port: the waveform side of the source link: VaporView's open documents, their netlist trees, and the
// public waveformViewer.* commands. Replaces cmux's `window.cmuxWaveform.link` page API (host.js): in VS Code the
// netlist lives in the extension host, so no webview round trip is needed except for adding rows.
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import type { WaveformViewerProvider } from '../../extension_core/viewer_provider';
import type { VaporviewDocument } from '../../extension_core/document';
import type { NetlistItem } from '../../extension_core/tree_view';
import { HierarchyNode, segments } from './path_mapping';

const MAX_CHILDREN = 5000;

/** A point value: bits, or why the file has none: `unreadable` (the read failed, e.g. a damaged block) or
 *  `unavailable` (the dump lists the signal without values of its own, e.g. a VCS port copy not linked to a stream). */
import { PointValue, wispPointValues } from './point_value';
export type { PointValue } from './point_value';
/** The request was cancelled (a newer marker move) or the file reloaded: the caller drops its result. */
export class LinkCancelled extends Error { constructor() { super('cancelled'); } }

interface WispQuery {
  query(req: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{ result?: any; error?: string; code?: string; verified?: boolean }>;
}
/** The wisp-helper handler of an FSDB / WCZ document (its query() API), else undefined. */
function wispOf(doc: VaporviewDocument): WispQuery | undefined {
  const h = (doc as any)._handler;
  return h && typeof h.query === 'function' && 'findTreeItemFn' in h ? h as WispQuery : undefined;
}

export class WaveformAccess {
  constructor(private provider: WaveformViewerProvider) {}

  documents(): VaporviewDocument[] {
    return this.provider.getAllDocumentUris()
      .map((u) => this.provider.getDocumentFromOptionalUri(u))
      .filter((d): d is VaporviewDocument => !!d);
  }

  /** The viewer the link uses: the given one, else the active / last active, else the first open. */
  document(uri?: string): VaporviewDocument | undefined {
    if (uri) { return this.provider.getDocumentFromOptionalUri(uri); }
    return this.provider.getLastActiveDocument ?? this.provider.getDocumentFromOptionalUri(undefined) ?? this.documents()[0];
  }

  private async item(doc: VaporviewDocument, path: string[]): Promise<NetlistItem | null> {
    if (path.length === 0) { return null; }
    return doc.findTreeItem(path.join('.'), undefined, undefined).catch(() => null);
  }

  private static isScope(item: NetlistItem): boolean {
    return item.contextValue === 'netlistScope';
  }

  /** Children of the dump scope at `path` ([] = the tops), or undefined if there is no such scope. */
  async scopeChildren(doc: VaporviewDocument, path: string[]): Promise<HierarchyNode[] | undefined> {
    let kids: NetlistItem[];
    if (path.length === 0) {
      kids = doc.treeData;
    } else {
      const item = await this.item(doc, path);
      if (!item || !WaveformAccess.isScope(item)) { return undefined; }
      kids = item.children.length ? item.children : await doc.getScopeChildren(item);
    }
    return kids.slice(0, MAX_CHILDREN).map((k) => ({ name: k.name, isScope: WaveformAccess.isScope(k), width: k.width || undefined }));
  }

  async hasSignal(doc: VaporviewDocument, path: string[]): Promise<boolean> {
    const parent = await this.scopeChildren(doc, path.slice(0, -1));
    return !!parent?.some((k) => !k.isScope && k.name === path[path.length - 1]);
  }

  async netlistId(doc: VaporviewDocument, path: string): Promise<number | undefined> {
    const item = await this.item(doc, segments(path));
    return item && !WaveformAccess.isScope(item) ? item.netlistId : undefined;
  }

  async addSignal(doc: VaporviewDocument, path: string): Promise<boolean> {
    if (!await this.hasSignal(doc, segments(path))) { return false; }
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: doc.uri.toString(), instancePath: path, reveal: true });
    return true;
  }

  isDisplayed(doc: VaporviewDocument, netlistId: number | undefined): boolean { return doc.isSignalDisplayed(netlistId); }

  markerTime(doc: VaporviewDocument): number | null { return doc.webviewContext.markerTime; }

  selectedSignalPath(doc: VaporviewDocument): string | undefined {
    const id = doc.webviewContext.selectedSignal;
    if (id === null || id === undefined) { return undefined; }
    return doc.netlistIdTable[id]?.instancePath();
  }

  pathOfNetlistId(doc: VaporviewDocument, id: number): string | undefined { return doc.netlistIdTable[id]?.instancePath(); }

  /** Each path's value at `time` (bits), undefined where the dump has
   *  no such signal (`{ kind, reason }` where the file cannot give it). FSDB / WCZ (wisp helper): one batched point read (`valueAt`) for all paths, shown in the viewer
   *  or not, with no history load; `signal` cancels it (the helper stops the request). Other formats: the viewer's
   *  getValuesAtTime. */
  async valuesAt(doc: VaporviewDocument, paths: string[], time: number, signal?: AbortSignal): Promise<PointValue[]> {
    if (paths.length === 0) { return []; }
    const wisp = wispOf(doc);
    if (wisp) { return this.wispValuesAt(doc, wisp, paths, time, signal); }
    let result: { instancePath: string; value: unknown }[] = [];
    try { result = await doc.getValuesAtTime({ time, instancePaths: paths } as any) as any; } catch { result = []; }
    const byPath = new Map<string, string>();
    const noChange = new Map<string, string>();
    for (const r of result ?? []) {
      let v: unknown = r.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
      const last = Array.isArray(v) ? v[v.length - 1] : v;
      if (last !== undefined && last !== null) { byPath.set(r.instancePath, String(last)); }
      else if ((r as any).noValue?.reason === 'noChange') { noChange.set(r.instancePath, String((r as any).noValue.text)); }
    }
    return paths.map((p) => byPath.get(p) ?? (noChange.has(p) ? { kind: 'noChange', reason: noChange.get(p)! } : undefined));
  }

  private async wispValuesAt(doc: VaporviewDocument, wisp: WispQuery, paths: string[], time: number, signal?: AbortSignal): Promise<PointValue[]> {
    const fixed: PointValue[] = paths.map(() => undefined);
    const ids = await Promise.all(paths.map(async (p, i) => {
      const item: any = await doc.findTreeItem(p, undefined, undefined).catch(() => null);
      if (!item || item.contextValue === 'netlistScope') { return undefined; }
      if (typeof item.signalId === 'number' && item.signalId >= 0) { return item.signalId as number; }
      if (item.unavailable) { fixed[i] = { kind: 'unavailable', reason: String(item.unavailable.reason || item.unavailable.state || 'no values') }; }
      return undefined;
    }));
    const asked = [...new Set(ids.filter((i): i is number => i !== undefined))];
    if (!asked.length || signal?.aborted) { return fixed; }
    const r = await wisp.query({ cmd: 'valueAt', signalIds: asked, t: time }, { signal });
    if (r.code === 'cancelled' || r.code === 'reloaded') { throw new LinkCancelled(); }
    if (r.error || !r.result) { return paths.map((_, i) => ids[i] === undefined ? fixed[i] : { kind: 'unreadable', reason: r.error ?? 'no answer' }); }
    const byId = wispPointValues(asked, r.result);
    return ids.map((id, i) => id === undefined ? fixed[i] : byId.get(id));
  }

  postMessage(doc: VaporviewDocument, message: Record<string, unknown>) { doc.postMessageToWebview(message); }

  /** Netlist ids of the signals (not child scopes) of dump scope `path`, or undefined if there is no such scope. */
  async scopeVariables(doc: VaporviewDocument, path: string[]): Promise<number[] | undefined> {
    const item = await this.item(doc, path);
    if (!item || !WaveformAccess.isScope(item)) { return undefined; }
    const kids = item.children.length ? item.children : await doc.getScopeChildren(item);
    return kids.filter((k) => k.contextValue === 'netlistVar').map((k) => k.netlistId);
  }

  /** `ids` without the ones shown or being added (in order, once each). */
  notShown(doc: VaporviewDocument, ids: number[]): number[] { return doc.filterNewSignals(ids); }

  /** Adds rows for `ids` (shown ones are skipped). */
  async addNetlistIds(doc: VaporviewDocument, ids: number[]) { await doc.renderSignals(ids, [], undefined); }

  /** Stable key of the dump for the mapping store: its file name and top scope names. Undefined while loading. */
  async dumpKey(doc: VaporviewDocument): Promise<string | undefined> {
    const tops = await this.scopeChildren(doc, []);
    if (!tops || tops.length === 0) { return undefined; }
    const file = doc.uri.path.split('/').pop() ?? '';
    return file + '|' + tops.map((t) => t.name).sort().join(',');
  }
}
