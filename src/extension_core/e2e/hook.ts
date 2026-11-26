// vscode-port: test-only hook so the headless e2e suite can read what the webview shows.
// Registered only when VAPORVIEW_E2E=1 (set by test/e2e/run.mjs); never active in normal use.
import * as vscode from 'vscode';
import { wispStates, failedOpenPages } from '../../cmux/wisp/wisp_handler';
import type { VaporviewDocument } from '../document';
import type { NetlistItem } from '../tree_view';

const pending = new Map<number, (v: any) => void>();
let nextId = 1;

export function e2eResolve(msg: any) {
  const f = pending.get(msg.id);
  if (f) {pending.delete(msg.id); f(msg);}
}

export function registerE2EHook(context: vscode.ExtensionContext, getPanel: () => vscode.WebviewPanel | undefined, getDocument?: (uri: string) => VaporviewDocument | undefined) {
  if (process.env.VAPORVIEW_E2E !== '1') {return;}
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.query', async (query: any) => {
    const panel = getPanel();
    if (!panel) {return {error: 'no active waveform panel'};}
    const id = nextId++;
    const reply = new Promise<any>((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) {resolve({error: 'timeout'});} }, 10000);
    });
    await panel.webview.postMessage({command: 'e2e-query', id, query});
    return reply;
  }));
  // vscode-port: one renderSignals of many ids (what Add Selected / Add All in Scope do): the batch arm
  // of the single-add gate (bridge-adds.test.cjs).
  // selectLast: the selection one-by-one adds leave (the last row only), so the gate compares the batching alone.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.renderBatch', async (uri: string, netlistIds: number[], selectLast = false) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return {error: 'no document ' + uri};}
    await doc.renderSignals(netlistIds, [], undefined, selectLast === true);
    return {ok: true};
  }));
  // vscode-port: what the wisp-helper handler showed the user for a file (status bar, error messages,
  // refusal, per-signal errors). Arg: the document uri string.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.wispState', (uri: string) => {
    const s = wispStates.get(String(uri));
    return s ? JSON.parse(JSON.stringify(s)) : null;
  }));
  // vscode-port: the page a failed-open tab shows (null when that uri has no failed-open tab)
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.failedOpen', (uri: string) => failedOpenPages.get(String(uri)) ?? null));
  // vscode-port: the Search Netlist quick pick's query for a document (its handler's searchNetlist), with the time.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.searchNetlist', async (uri: string, query: string, scopeId?: number) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return {error: 'no document ' + uri};}
    const t0 = Date.now();
    const r = await doc.searchNetlist(query, scopeId);
    return {ms: Date.now() - t0, totalResults: r.totalResults, searchResults: r.searchResults};
  }));
  // vscode-port (test only): the Search Netlist answer the earlier NetlistItem walk gave (every scope expanded through
  // the Netlist view's getScopeChildren, then wellen's rules), to check the compact index gives the same hits in the
  // same order. Builds NetlistItems for the whole design: small fixtures only.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.searchNetlistRef', async (uri: string, query: string, scopeId?: number) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return {error: 'no document ' + uri};}
    type N = {item: NetlistItem; lname: string; kids: N[]};
    const isScope = (n: N) => n.item.contextValue === 'netlistScope';
    const expand = async (item: NetlistItem | undefined): Promise<N[]> => {
      const out: N[] = [];
      for (const k of await doc.getScopeChildren(item)) {
        const n: N = {item: k, lname: k.name.toLowerCase(), kids: []};
        if (isScope(n)) {n.kids = await expand(k);}
        out.push(n);
      }
      return out;
    };
    const top = await expand(undefined);
    let roots = top;
    if (scopeId !== undefined && scopeId !== 0xFFFFFFFF) {
      const find = (l: N[]): N | null => { for (const n of l) {if (isScope(n) && n.item.netlistId === scopeId) {return n;} const f = find(n.kids); if (f) {return f;}} return null; };
      const sc = find(top); if (sc) {roots = sc.kids;}
    }
    const allScopes: N[] = [], allVars: N[] = [];
    const walk = (l: N[]) => {for (const n of l) {if (isScope(n)) {allScopes.push(n); walk(n.kids);} else {allVars.push(n);}}};
    walk(roots);
    const parts = query.toLowerCase().split('.'), found: N[] = [];
    const search = (p: string[], scopes: N[], vars: N[] | null) => {
      if (!p.length) {return;}
      const want = p[0], rest = p.slice(1);
      for (const sc of scopes) {
        if (!sc.lname.includes(want)) {continue;}
        if (!rest.length) {found.push(sc); continue;}
        search(rest, sc.kids.filter(isScope), rest.length === 1 ? sc.kids.filter((k) => !isScope(k)) : null);
      }
      if (rest.length) {return;}
      if (vars) {for (const v of vars) {if (v.lname.includes(want)) {found.push(v);}}}
    };
    search(parts, allScopes, parts.length === 1 ? allVars : null);
    const entry = (n: N) => { const it = n.item; const instancePath = it.scopePath.concat([it.name]).join('.');
      return isScope(n) ? {instancePath, type: String(it.type || 'module'), isVar: false, paramValue: '', msb: -1, lsb: -1}
        : {instancePath, type: String(it.type || 'wire'), isVar: true, paramValue: '', msb: Number(it.msb ?? -1), lsb: Number(it.lsb ?? -1)}; };
    return {totalResults: found.length, searchResults: found.slice(0, 100).map(entry)};
  }));
  // vscode-port (test only): the netlistId of the scope at a dotted path, walked as the Netlist view expands it
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.scopeNetlistId', async (uri: string, scopePath: string) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return null;}
    let item: NetlistItem | undefined = undefined;
    for (const part of String(scopePath).split('.')) {
      const kids: NetlistItem[] = await doc.getScopeChildren(item);
      item = kids.find((k) => k.contextValue === 'netlistScope' && k.name === part);
      if (!item) {return null;}
    }
    return item ? item.netlistId : null;
  }));
  // vscode-port: one helper query through a document's wisp handler (WispFormatHandler.query: valueAt / edge / count on
  // computed ids are answered through windows). Returns the query's {result, verified} or {error}.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.wispQuery', async (uri: string, req: any) => {
    const doc = getDocument?.(String(uri));
    const h: any = doc?.handler;
    if (!h || typeof h.query !== 'function') {return {error: 'no wisp document ' + uri};}
    const r = await h.query(req);
    return {result: r.result, verified: r.verified, error: r.error, code: r.code};
  }));
  // vscode-port: feed per-signal errors to a document's reply check and return the status they leave {status, level}
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.wispNoteErrors', async (uri: string, errs: string[], computed = false, ids?: number[]) => {
    const h: any = getDocument?.(String(uri))?.handler;
    if (!h || typeof h.e2eNoteErrors !== 'function') {return {error: 'no wisp document ' + uri};}
    return h.e2eNoteErrors(errs, computed, ids);
  }));
  // vscode-port: answer these stored signal ids through windows (as computed ones), or back; the windowed-answer oracle.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.wispForceWindowed', async (uri: string, ids: number[], on = true) => {
    const h: any = getDocument?.(String(uri))?.handler;
    if (!h || typeof h.e2eForceWindowed !== 'function') {return {error: 'no wisp document ' + uri};}
    return {windowOnly: h.e2eForceWindowed(ids, on)};
  }));
  // vscode-port: the netlist as the Netlist view loads it (through the document's handler), walked to
  // maxDepth, at most maxItems variables. Each variable: path, signalId, width, encoding, contextValue,
  // unavailable reason (declared without values).
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.netlist', async (uri: string, maxDepth = 8, maxItems = 5000) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return {error: 'no document ' + uri};}
    const vars: any[] = [];
    const walk = async (item: NetlistItem | undefined, depth: number): Promise<void> => {
      if (vars.length >= maxItems || depth > maxDepth) {return;}
      const kids = await doc.getScopeChildren(item);
      for (const k of kids) {
        if (vars.length >= maxItems) {return;}
        if (k.contextValue === 'netlistScope') {await walk(k, depth + 1); continue;}
        vars.push({path: k.instancePath(), signalId: k.signalId, width: k.width, msb: k.msb, lsb: k.lsb, encoding: k.encoding, type: k.type,
          contextValue: k.contextValue, description: k.description ?? '', unavailable: (k as any).unavailable ?? null});
        if (k.children && k.children.length) {for (const c of k.children) {vars.push({path: c.instancePath(), signalId: c.signalId, width: c.width, msb: c.msb, lsb: c.lsb, encoding: c.encoding, type: c.type, contextValue: c.contextValue, description: c.description ?? '', unavailable: (c as any).unavailable ?? null});}}
      }
    };
    await walk(undefined, 0);
    return {vars};
  }));
  // vscode-port: walk the Netlist view's scopes along one path (as a user expands them), timing each
  // level; with no path, find the deepest scope (scopes only, breadth first, at most maxScopes). Returns the leaf's
  // variables (instance paths, at most maxVars) so a test can add them.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.scopeWalk', async (uri: string, scopePath: string | null, maxScopes = 20000, maxVars = 200) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return {error: 'no document ' + uri};}
    const now = () => Number(process.hrtime.bigint()) / 1e6;
    const leafVars = (kids: NetlistItem[]) => kids.filter((k) => k.contextValue !== 'netlistScope' && k.signalId !== null && k.signalId !== undefined && !(k as any).unavailable).slice(0, maxVars).map((k) => ({path: k.instancePath(), netlistId: k.netlistId, name: k.name, label: String(k.label)}));
    if (scopePath) {
      const parts = scopePath.split('.');
      const levels: number[] = [];
      let item: NetlistItem | undefined = undefined;
      let kids: NetlistItem[] = [];
      for (let i = 0; i <= parts.length; i++) {
        const t0 = now();
        kids = await doc.getScopeChildren(item);
        levels.push(now() - t0);
        if (i === parts.length) {break;}
        const next = kids.find((k) => k.contextValue === 'netlistScope' && k.label === parts[i]);
        if (!next) {return {error: `scope ${parts.slice(0, i + 1).join('.')} not found`, levels, have: kids.slice(0, 20).map((k) => k.label)};}
        item = next;
      }
      return {path: scopePath, depth: parts.length, levels, totalMs: levels.reduce((a, b) => a + b, 0), nKids: kids.length, vars: leafVars(kids)};
    }
    const t0 = now();
    let frontier: {item: NetlistItem | undefined, path: string, depth: number}[] = [{item: undefined, path: '', depth: 0}];
    let deepest = {path: '', depth: 0, vars: [] as any[], nKids: 0};
    let best = {path: '', nVars: 0};
    let n = 0;
    while (frontier.length && n < maxScopes) {
      const next: typeof frontier = [];
      for (const f of frontier) {
        const kids = await doc.getScopeChildren(f.item);
        n++;
        const nv = kids.filter((k) => k.contextValue !== 'netlistScope').length;
        if (f.depth >= deepest.depth && f.item) {deepest = {path: f.path, depth: f.depth, vars: leafVars(kids), nKids: kids.length};}
        if (nv > best.nVars && f.item) {best = {path: f.path, nVars: nv};}
        for (const k of kids) {if (k.contextValue === 'netlistScope') {next.push({item: k, path: f.path ? f.path + '.' + k.label : k.label, depth: f.depth + 1});}}
        if (n >= maxScopes) {break;}
      }
      frontier = next;
    }
    return {deepest, widest: best, scopesVisited: n, complete: frontier.length === 0, ms: now() - t0};
  }));
  // vscode-port: add several netlist ids in ONE renderSignals (what Add Selected / Add All in Scope do).
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.addBatch', async (uri: string, netlistIds: number[]) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return {error: 'no document ' + uri};}
    await doc.renderSignals(netlistIds, [], undefined);
    return {ok: true};
  }));
  // vscode-port: the document's netlist search (the backend of Search Netlist), timed.
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.searchNetlistTimed', async (uri: string, query: string) => {
    const doc = getDocument?.(String(uri));
    if (!doc) {return {error: 'no document ' + uri};}
    const t0 = Number(process.hrtime.bigint()) / 1e6;
    const r: any = await doc.searchNetlist(query, undefined);
    return {ms: Number(process.hrtime.bigint()) / 1e6 - t0, total: r.totalResults, first: (r.searchResults || []).slice(0, 5).map((x: any) => x.instancePath ?? x.name ?? x)};
  }));
  // vscode-port: post a host message to the waveform webview as the extension would (e.g. setDisplayFormat
  // with a cmux format id that has no menu entry yet).
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.post', async (message: any) => {
    const panel = getPanel();
    if (!panel) {return {error: 'no active waveform panel'};}
    return {result: await panel.webview.postMessage(message)};
  }));
}
