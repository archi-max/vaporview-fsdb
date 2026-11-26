// vscode-port: a minimal wisp-helper client and a TraceDumpSource over it (src/cmux/trace/dump.ts's
// helper path), for the WCZ trace checks (test/trace/wcz.cjs) and the trace perf check (test/perf/trace-perf.cjs).
'use strict';
const cp = require('child_process');

// A minimal wisp-helper client: JSON requests on stdin, replies on fd 3 (a reply with binLength: that many bytes after).
function helper(file, bin) {
  const proc = cp.spawn(bin || process.env.WISP_HELPER, [], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0), want = null, next = 1;
  const pending = new Map();
  const queries = { n: 0 };
  proc.stdio[3].on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (want) { if (buf.length < want.n) { return; } const bin = Buffer.from(buf.subarray(0, want.n)); buf = buf.subarray(want.n); const l = want.line; want = null; l.bin = bin; done(l); continue; }
      const i = buf.indexOf(10);
      if (i < 0) { return; }
      const line = JSON.parse(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1);
      if (Number(line.binLength) > 0) { want = { line, n: Number(line.binLength) }; } else { done(line); }
    }
  });
  function done(line) { const p = pending.get(line.id); if (p) { pending.delete(line.id); p(line); } }
  const request = (req) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); proc.stdin.write(JSON.stringify(Object.assign({}, req, { id })) + '\n'); });
  return { proc, request, queries, async open() { return request({ cmd: 'open', file }); } };
}

function wczSource(h, meta, onReply) {
  const scopes = new Map(); // scope path -> children reply
  const children = async (scopePath, scopeOffsetIdx) => {
    if (!scopes.has(scopePath)) { scopes.set(scopePath, h.request({ cmd: 'children', scopeOffsetIdx, scopePath }).then((r) => r.result)); }
    return scopes.get(scopePath);
  };
  return {
    kind: 'wcz',
    start: () => Number(meta.timeStart) || 0,
    end: () => Number(meta.timeEnd) || 0,
    async findVar(p) {
      // (meta.vars: the netlist in memory, as the extension's data provider has it; else scope by scope)
      if (meta.vars) { const v = meta.vars.get(p); return v ? { key: String(v.signalId), signalId: v.signalId, width: v.width } : null; }
      const segs = p.split('.');
      let scope = meta.top.find((t) => t.name === segs[0]);
      if (!scope) { return null; }
      let at = segs[0];
      for (let i = 1; i < segs.length; i++) {
        const c = await children(at, scope.scopeOffsetIdx);
        if (i === segs.length - 1) {
          const v = c.vars.find((x) => x.name === segs[i]);
          return v && v.signalId !== null ? { key: String(v.signalId), signalId: v.signalId, width: v.width } : null;
        }
        scope = c.scopes.find((x) => x.name === segs[i]);
        if (!scope) { return null; }
        at += '.' + segs[i];
      }
      return null;
    },
    async changes() { return null; },
    async v2(req) {
      h.queries.n++;
      if (req.cmd === 'window' && req.buckets > 1000) { h.queries.whole = (h.queries.whole || 0) + 1; }
      const r = await h.request(req);
      if (onReply) { onReply(req, r); }
      return r.error ? { error: r.error } : Object.assign(r.result, r.bin ? { bin: r.bin } : {});
    },
  };
}

// The whole netlist (path -> var of children's answer, with netlistId), read once scope by scope.
async function netlist(h, top) {
  const vars = new Map();
  const walk = async (scopePath, scopeOffsetIdx) => {
    const r = await h.request({ cmd: 'children', scopeOffsetIdx, scopePath });
    const c = r.result || { vars: [], scopes: [] };
    for (const v of c.vars || []) { if (v.signalId !== null && v.signalId !== undefined) { vars.set(scopePath + '.' + v.name, v); } }
    for (const sc of c.scopes || []) { await walk(scopePath + '.' + sc.name, sc.scopeOffsetIdx); }
  };
  for (const t of top) { await walk(t.name, t.scopeOffsetIdx); }
  return vars;
}

module.exports = { helper, wczSource, netlist };
