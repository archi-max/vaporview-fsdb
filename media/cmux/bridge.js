// vscode-port: the host bridge for cmux's page modules in the VS Code webview. GPL-3.0 (VaporView, cmux).
// Adapted from cmux's Resources/vaporview/host.js (hostApi, link), which hosted VaporView in an <iframe>.
//
// Loaded before VaporView's webview.js; the cmux modules (media/cmux/cmux-*.js) load after it.
//  - Acquires the VS Code API once and shares it with webview.js (window.cmuxVsCodeApi), tapping what
//    VaporView posts to the extension so the modules hear its contextUpdate / emitEvent / ready / initialized.
//  - window.cmuxWaveform.host: the object the modules call (host.js's hostApi). Waveform data lives in the
//    extension (src/cmux/data.ts); calls go as RPC messages ({command: 'cmux-rpc'}). The netlist items the
//    modules read synchronously (netlistItem, doc.items, doc.netlist) are mirrored here as RPCs return them.
//  - The modules reach "the viewer frame" through document.getElementById('viewer').contentWindow: a hidden
//    stand-in element answers with this window and document, so messages they post to it are dispatched
//    locally as `message` events, the way VaporView receives the extension's messages.
//  - host.toNative({type, ...}) goes to the extension as {command: 'cmux-native', msg}.
//  - The extension calls into the modules with {cmuxBridge: true, kind: 'call', id, path: 'fsm.show', args}
//    (a function under window.cmuxWaveform) and gets {command: 'cmux-page-reply', id, result | error}.
(function () {
  'use strict';
  const api = acquireVsCodeApi();
  const rawPost = api.postMessage.bind(api);
  const sameDocument = window;

  // ---- RPC to the extension ----
  let nextId = 1;
  const pending = new Map();
  function rpc(method, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      rawPost({ command: 'cmux-rpc', id, method, args });
    });
  }
  const toNative = (msg) => rawPost({ command: 'cmux-native', msg });
  const log = (message) => toNative({ type: 'log', message: String(message && message.stack ? message.stack : message) });

  // ---- what the page knows of the open dump ----
  const doc = { uri: '', documentId: 'vscode', metadata: null, netlist: [], items: new Map() };
  const viewerContext = { keys: {}, webview: null };
  let loadGeneration = 0;
  let backend = null; // an opaque token per load: modules compare it to notice a reload
  let initialized = false;

  function closedError() { const e = new Error('closed'); e.cmuxClosed = true; return e; }

  function adopt(item) {
    if (!item) { return null; }
    const known = item.kind === 'var' ? doc.items.get(item.netlistId) : null;
    if (known && known.name === item.name && known.scopePath.join('\u0000') === item.scopePath.join('\u0000')) { return known; }
    const o = Object.assign({}, item);
    if (o.kind === 'var') { doc.items.set(o.netlistId, o); }
    return o;
  }

  const pathOf = (v) => (v.scopePath || []).concat([v.name]).map(String);
  const segments = (path) => (Array.isArray(path) ? path.map(String) : (path ? String(path).split('.') : []));

  function getChildren(item) {
    if (item.children) { return Promise.resolve(item.children); }
    if (!backend) { return Promise.reject(closedError()); }
    if (!item.childrenRequest) {
      const generation = loadGeneration;
      item.childrenRequest = rpc('children', { path: pathOf(item) }).then((list) => {
        if (generation !== loadGeneration) { throw closedError(); }
        item.children = (list || []).map(adopt);
        return item.children;
      }).finally(() => { delete item.childrenRequest; });
    }
    return item.childrenRequest;
  }

  async function findLinkItem(path, varOnly) {
    if (!backend) { return null; }
    const generation = loadGeneration;
    const item = await rpc('findItem', { path: segments(path), varOnly: !!varOnly });
    return generation === loadGeneration ? adopt(item) : null;
  }

  // The netlist ids of the shown rows: 'all', 'pinned' (outside the debugger's Locals) or 'locals'.
  const isLocals = (d) => !!(hostApi.isTransientGroup && hostApi.isTransientGroup(d));
  function rowIds(list, which) {
    const out = new Set();
    const walk = (items, inLocals) => (items || []).forEach((d) => {
      const locals = inLocals || isLocals(d);
      if (d.netlistId !== undefined && (which === 'all' || (which === 'locals') === locals)) { out.add(d.netlistId); }
      walk(d.children, locals);
    });
    walk(viewerContext.webview && viewerContext.webview.displayedSignals, false);
    return out;
  }
  function shownFormats() {
    const out = new Map();
    const walk = (list) => (list || []).forEach((d) => {
      if (d.netlistId !== undefined && !out.has(d.netlistId)) { out.set(d.netlistId, d.numberFormat); }
      walk(d.children);
    });
    walk(viewerContext.webview && viewerContext.webview.displayedSignals);
    return out;
  }

  // [[time, value], ...] as cmux's backends answer (the extension sends times as a Float64Array).
  // A change list from src/cmux/bridge_host.ts toWire: times as {dt} (Uint32 gaps) or {times}; values as {table, codes}
  // (one code per change into the table of distinct values), {packed} (ASCII, valueWidth bytes each) or {values}.
  const latin = new TextDecoder('latin1');
  function pairs(c) {
    if (!c) { return c; }
    const n = c.n !== undefined ? c.n : c.times.length;
    const out = new Array(n);
    let times = c.times;
    if (c.dt) {
      times = new Float64Array(n);
      for (let i = 0, t = 0; i < n; i++) { t += c.dt[i]; times[i] = t; }
    }
    const w = c.valueWidth;
    if (c.codes) {
      const table = c.table, codes = c.codes;
      for (let i = 0; i < n; i++) { out[i] = [times[i], table[codes[i]]]; }
      return out;
    }
    if (c.packed) {
      const text = latin.decode(c.packed);
      for (let i = 0, at = 0; i < n; i++, at += w) { out[i] = [times[i], text.substr(at, w)]; }
      return out;
    }
    for (let i = 0; i < n; i++) { out[i] = [times[i], c.values[i]]; }
    return out;
  }
  const refOf = (v) => (v && v.netlistId !== undefined ? { netlistId: v.netlistId } : segments(v));

  // ---- messages into the page (as if posted to the viewer frame) ----
  function toWebview(msg) {
    sameDocument.dispatchEvent(new MessageEvent('message', { data: msg }));
  }

  const hostApi = {
    doc, viewerContext, toWebview, toNative, getChildren,
    netlistItem: (id) => doc.items.get(id) || null,
    pinnedIds: () => rowIds(null, 'pinned'),
    // Undefined while no dump is loaded; null past maxChanges.
    signalChanges: (v, maxChanges) => (backend ? rpc('signalChanges', { ref: refOf(v), max: maxChanges ?? null }).then(pairs) : Promise.resolve(undefined)),
    // A 1-bit variable's rising-edge times (Float64Array); rejects past maxEdges.
    signalPosedges: (v, maxEdges) => (backend ? rpc('posedges', { ref: refOf(v), max: maxEdges ?? null }).then((e) => {
      if (e === null) { throw new Error('too many clock edges'); }
      return e;
    }) : null),
    // netlistId -> bits in effect at `time`.
    rawValuesAt: async (time, vars) => {
      const out = new Map();
      if (!backend || !vars || !vars.length) { return out; }
      const values = await rpc('valuesAt', { refs: vars.map(refOf), time: Number(time) });
      vars.forEach((v, i) => { if (values[i] !== null && values[i] !== undefined) { out.set(v.netlistId, String(values[i])); } });
      return out;
    },
    shownFormats,
    get currentBackend() { return backend; },
    dumpIdentity: () => (backend ? backend.identity : null),
    dataReady: () => !!backend && !!doc.metadata,
    findLinkItem, pathOf,
    viewerEventListeners: [],
    contextListeners: [],
    openedListeners: [],
    quietEvents: 0,
    isTransientGroup: null,
    topLevelIndexOutsideTransient: null,
    log,
    get config() { return {}; },
    get loadGeneration() { return loadGeneration; },
    rpc, // vscode-port: generic call into src/cmux/bridge_host.ts (see RPC_METHODS there)
  };

  // The source link (cmux's cmuxWaveform.link), the part the modules use.
  const link = Object.freeze({
    markerTime: () => (viewerContext.webview ? viewerContext.webview.markerTime ?? null : null),
    setMarker: (time) => { toWebview({ command: 'setMarker', time: Number(time), markerType: 0 }); },
    hasSignal: async (path) => !!(await findLinkItem(path, true)),
    scopeChildren: async (path) => {
      const list = await rpc('children', { path: segments(path) });
      return (list || []).slice(0, 5000).map((c) => (c.kind === 'scope' ? { name: c.name, isScope: true } : { name: c.name, isScope: false, width: c.width }));
    },
    addSignal: (path) => rpc('addSignal', { path: segments(path) }),
    selectedSignal: () => {
      const id = viewerContext.webview ? viewerContext.webview.selectedSignal : null;
      const v = id === null || id === undefined ? null : doc.items.get(id);
      return v ? pathOf(v) : null;
    },
  });

  // ---- the stand-in for cmux's <iframe id="viewer"> ----
  const frame = document.createElement('div');
  frame.id = 'viewer';
  frame.hidden = true;
  Object.defineProperty(frame, 'contentWindow', { get: () => window });
  Object.defineProperty(frame, 'contentDocument', { get: () => document });
  frame.getBoundingClientRect = () => (document.getElementById('vaporview-top') || document.body).getBoundingClientRect();
  // The panes the modules add (#fsm, ...) sit at the right edge, over the viewer.
  const panes = document.createElement('div');
  panes.id = 'panes';
  document.body.appendChild(frame);
  document.body.appendChild(panes);

  // ---- what VaporView posts to the extension, seen on the way ----
  async function mirrorItems(ids) {
    const missing = ids.filter((id) => !doc.items.has(id));
    if (!missing.length || !backend) { return; }
    try { (await rpc('items', { ids: missing.slice(0, 2000) })).forEach(adopt); } catch (e) { log(e); }
  }

  let contextChain = Promise.resolve();
  async function onOpened() {
    const generation = ++loadGeneration;
    const info = await rpc('opened', {});
    if (generation !== loadGeneration) { return; }
    doc.uri = info.uri;
    doc.metadata = info.metadata;
    doc.items.clear();
    doc.netlist = (info.top || []).map(adopt);
    backend = Object.freeze({ kind: info.kind, generation, identity: info.uri + '#' + info.generation });
    initialized = true;
    hostApi.openedListeners.forEach((l) => { try { l(); } catch (e) { log(e); } });
  }

  function seen(m) {
    if (!m || typeof m !== 'object') { return; }
    switch (m.command) {
      case 'ready':
        // VaporView posts ready on its first load and from every unload (reload): the old dump is gone.
        backend = null; doc.metadata = null; doc.netlist = []; doc.items.clear(); viewerContext.webview = null; initialized = false;
        loadGeneration++;
        break;
      case 'initialized':
        onOpened().catch(log);
        break;
      case 'contextUpdate': {
        const ids = Array.from(rowIds(null, 'all'));
        contextChain = contextChain.then(async () => {
          const shown = [];
          const walk = (list) => (list || []).forEach((d) => { if (d.netlistId !== undefined) { shown.push(d.netlistId); } walk(d.children); });
          walk(m.displayedSignals);
          await mirrorItems(shown.concat(ids));
          if (initialized) { viewerContext.webview = m; }
          hostApi.contextListeners.forEach((l) => { try { l(m); } catch (e) { log(e); } });
        });
        break;
      }
      case 'emitEvent':
        hostApi.viewerEventListeners.forEach((l) => { try { l(m); } catch (e) { log(e); } });
        break;
    }
  }

  const tapped = {
    postMessage: (m) => {
      // Rows the debugger adds or removes for Locals select and deselect as a side effect: not the user's doing.
      if (!(m && m.command === 'emitEvent' && hostApi.quietEvents)) { rawPost(m); }
      try { seen(m); } catch (e) { log(e); }
    },
    setState: (s) => api.setState(s),
    getState: () => api.getState(),
  };
  window.cmuxVsCodeApi = tapped;

  // ---- messages from the extension for the bridge ----
  function resolvePath(path) {
    let target = window.cmuxWaveform;
    const parts = String(path).split('.');
    for (let i = 0; i < parts.length - 1; i++) { target = target && target[parts[i]]; }
    const fn = target && target[parts[parts.length - 1]];
    return typeof fn === 'function' ? fn.bind(target) : null;
  }
  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (!m || m.cmuxBridge !== true) { return; }
    if (m.kind === 'rpc-reply') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) { return; }
      if (m.error !== undefined) { p.reject(Object.assign(new Error(m.error), { code: m.code })); } else { p.resolve(m.result); }
      return;
    }
    if (m.kind === 'call' || m.kind === 'e2e-eval') {
      let result, error;
      try {
        let fn;
        // e2e-eval is only ever sent by the extension's test command, which exists only when VAPORVIEW_E2E=1.
        if (m.kind === 'e2e-eval') { fn = new Function('cmux', 'args', '"use strict"; return (' + m.source + ')(cmux, args);'); result = await fn(window.cmuxWaveform, m.args); }
        else {
          fn = resolvePath(m.path);
          if (!fn) { throw new Error('no page function ' + m.path); }
          result = await fn(m.args);
        }
      } catch (err) { error = String(err && err.stack ? err.stack : err); }
      try { rawPost({ command: 'cmux-page-reply', id: m.id, result, error }); }
      catch (err) { rawPost({ command: 'cmux-page-reply', id: m.id, error: 'unserializable result: ' + err }); }
    }
  });

  window.cmuxWaveform = { host: hostApi, viewerContext, strings: window.cmuxPageStrings || {} };
  Object.defineProperty(window.cmuxWaveform, 'link', { value: link, writable: false, configurable: false, enumerable: true });
  Object.defineProperty(window, 'cmuxWaveform', { value: window.cmuxWaveform, writable: false, configurable: false });
})();
