// cmux's driver tracing, the engine (design: status/tracex-design.md, phase P1): the active
// driver of a signal at a time. It finds the statement that produced the value in effect: a
// continuous assignment, the branch of a procedure actually taken (re-executed with simulator
// semantics on the dump's values), or a port connection, with the fan-in of that statement and
// its conditions at the time it was sampled, and says how far to trust it (exact, computed,
// approximate or inconsistent, with reasons).
//
// Pure: no DOM, no host. The design comes from cmux-sv-model (Resources/vaporview/sv-model, built
// on slang), one instance at a time; values come from the dump; both are injected. Expressions are
// evaluated by cmux-expr.js. Paths are design paths (slang's hierarchy); the dump provider maps
// them to the dump's names.
//
//   createEngine({ models, dump, options }) -> { active(path, time) -> step, model(path) }
//     models.instance(path) -> Promise<model>          cmux-sv-model's instance reply (its "model")
//     models.lookup(path) -> Promise<{ instance, name }> the instance a path is in, and the rest
//     models.writers(path) -> Promise<[instance path]>  (optional) the other instances that write
//         into an instance (an interface instance's signals, written through modport ports)
//     dump.values(paths, time) -> Promise<Map(path -> bits | undefined)>   undefined: not dumped
//     dump.lastChange(path, time) -> Promise<number | null>   the change in effect at time (0: the
//         start), null: not dumped
//     dump.prevEdge(path, time, 'PosEdge' | 'NegEdge' | 'BothEdges') -> Promise<number | null>
//         the last such edge at or before time
//     dump.nextChange(path, time) -> Promise<number | null>   (optional) the first change at or
//         after time, null: none (or not dumped). Without it, nextOf answers null.
//     dump.xStart(path, time) -> Promise<{ time, complete } | null | undefined>   (optional) where
//         the x run in effect at time began (see xStart below); undefined: the engine walks the
//         changes itself. A z counts as x here (a floating bus is traced like an unknown).
//     dump.start -> number | () => number   (optional) when the dump starts (default 0). An x run
//         reaching back to a later start began before the dump: { time: start, dumpStart: true }.
//     dump.changeCount(path, from, to), dump.maskChangeCount(path, from, to) -> Promise<number |
//         undefined>   (optional) changes in (from, to], of the value and of its x/z bits alone.
//     dump.unrecorded(from, to) -> { from, to } | { from, toEnd } | null   (optional) a capture gap
//         (a WCZ file's: nothing recorded in (from, to]) that may hide changes in (from, to]. A step
//         whose value or last change it hides says so (notRecorded), approximate.
//     options.xprop: 'auto' (default) | 'on' | 'off'   X-propagation (VCS -xprop): an if or case on
//         an x condition merges its branches. 'auto' re-runs a step that way when the dump
//         disagrees with the x-optimistic run and agrees with the merged one.
//     options.xRunChanges: the changes xStart walks back over itself at most (default 256).
//
// A step: { signal, time, value (bits), since, driver (driver.writer: the instance of a statement
// that writes into the signal's instance from outside it), stmt, decisions, fanin, predicted,
// trust, reasons, drivers, root?, activation? }. Reasons are codes with arguments; the page
// words them (strings in cmux).
(function (root) {
  'use strict';
  const MODEL_VERSION = 1;
  // Statements run per activation before giving up (loops are P3; this bounds bad models).
  const MAX_STATEMENTS = 4096;
  // Re-executions to fetch unpacked-array elements whose index is only known after a run.
  const MAX_ELEMENT_ROUNDS = 3;
  // Elements an x index may name that X-propagation's resolution read merges (more: all x).
  const MAX_RESOLUTION = 64;

  const maskOf = (w) => (1n << BigInt(w)) - 1n;
  const allX = (w) => ({ w, a: maskOf(w), b: maskOf(w) });
  const hasX = (v) => v.b !== 0n;
  const fit = (v, w) => ({ w, a: v.a & maskOf(w), b: v.b & maskOf(w) });
  const bitsOf = (X, v) => (v ? X.toBits(v) : null);

  // Bits [lsb, lsb + w) of v.
  const slice = (v, lsb, w) => ({ w, a: (v.a >> BigInt(lsb)) & maskOf(w), b: (v.b >> BigInt(lsb)) & maskOf(w) });
  // v with bits [lsb, lsb + part.w) replaced by part.
  function insert(v, lsb, part) {
    const m = maskOf(part.w) << BigInt(lsb);
    return { w: v.w, a: ((v.a & ~m) | ((part.a << BigInt(lsb)) & m)) & maskOf(v.w), b: ((v.b & ~m) | ((part.b << BigInt(lsb)) & m)) & maskOf(v.w) };
  }
  // Per bit: the same known value in both, else x (X-propagation's merge).
  function merge(p, q) {
    const w = Math.max(p.w, q.w);
    const a = fit(p, w), b = fit(q, w);
    const differ = (a.a ^ b.a) | (a.b ^ b.b) | a.b | b.b;
    return { w, a: (a.a & ~differ) | differ, b: differ & maskOf(w) };
  }
  const same = (p, q) => p.w === q.w && p.a === q.a && p.b === q.b;

  function caseMatch(a, b, cond) {
    const w = Math.max(a.w, b.w);
    const x = fit(a, w), y = fit(b, w);
    let care = maskOf(w);
    const zOf = (v) => ~v.a & v.b;
    if (cond === 'WildcardJustZ') { care &= ~(zOf(x) | zOf(y)); }
    if (cond === 'WildcardXOrZ') { care &= ~(x.b | y.b); }
    return ((x.a ^ y.a) & care) === 0n && ((x.b ^ y.b) & care) === 0n;
  }
  // Whether a case item can match a selector with x bits (X-propagation's candidates).
  function caseMayMatch(a, b) {
    const w = Math.max(a.w, b.w);
    const x = fit(a, w), y = fit(b, w);
    const care = maskOf(w) & ~(x.b | y.b);
    return ((x.a ^ y.a) & care) === 0n;
  }

  function createEngine(config) {
    const X = config.expr || root.cmuxExpr;
    const models = config.models;
    const dump = config.dump;
    // The capture gap that may hide changes in (from, to] (dump.unrecorded, optional), or null.
    const unrecorded = (from, to) => { try { return typeof dump.unrecorded === 'function' ? dump.unrecorded(from, to) || null : null; } catch (error) { return null; } };
    const options = Object.assign({ xprop: 'auto' }, config.options || {});
    const modelCache = new Map();
    const parsed = new Map();
    const indexCache = new WeakMap();

    const writersCache = new Map();
    // Drivers outside the signal's instance: the statements of the instances that write into it
    // ($abs: lvalues), each run in its own instance's model. [{ m, d, name }]
    async function outsideDrivers(m, name) {
      if (typeof models.writers !== 'function' || isLocal(name)) { return []; }
      if (!writersCache.has(m.path)) {
        writersCache.set(m.path, Promise.resolve(models.writers(m.path)).then((w) => (Array.isArray(w) ? w : []), () => []));
      }
      const s = signalOf(m, name);
      const base = '$abs:' + m.path + '.' + (s && s.element ? s.element.array : name);
      const out = [];
      for (const w of await writersCache.get(m.path)) {
        const wm = await model(w);
        if (!wm) { continue; }
        for (const d of driversOf(wm, base)) { out.push({ m: wm, d, name: '$abs:' + m.path + '.' + name }); }
      }
      return out;
    }

    async function model(path) {
      if (!modelCache.has(path)) {
        modelCache.set(path, Promise.resolve(models.instance(path)).then((m) => {
          if (m && m.version !== undefined && m.version !== MODEL_VERSION) { throw new Error('model version ' + m.version); }
          return m;
        }));
      }
      try {
        return await modelCache.get(path);
      } catch (error) {
        modelCache.delete(path);
        throw error;
      }
    }

    // ---- names ----
    const absOf = (inst, name) => (name.startsWith('$abs:') ? name.slice(5) : inst + '.' + name);
    const isLocal = (name) => name.startsWith('$local:');
    function relOf(m, path) { return path.startsWith(m.path + '.') ? path.slice(m.path.length + 1) : '$abs:' + path; }

    // ---- locations ----
    function locOf(m, l) {
      if (!l || !Array.isArray(l)) { return null; }
      return { file: m.files[l[0]], line: l[1], col: l[2], endLine: l[3], endCol: l[4] };
    }

    // ---- expressions ----
    function parse(text) {
      if (!parsed.has(text)) {
        // Internal callers lift the user-facing caps when cmux-expr supports it.
        let r = X.parse(text, { maxSignals: Infinity, maxText: Infinity });
        parsed.set(text, r);
      }
      return parsed.get(text);
    }

    // The signals' info in a model by relative name (and $abs paths, by their own instance).
    function signalOf(m, name) {
      if (!m || isLocal(name)) { return null; }
      if (m.signals[name]) { return m.signals[name]; }
      const em = /^(.*)\[(-?\d+)\]$/.exec(name);
      if (em && m.signals[em[1]] && m.signals[em[1]].array) {
        const s = m.signals[em[1]];
        return { width: s.array.elemWidth, kind: s.kind, element: { array: em[1], k: Number(em[2]) } };
      }
      return null;
    }

    // The dump paths an expression reads (its leaves, element indices' leaves).
    function leafPaths(m, e, out) {
      if (!e) { return out; }
      for (const l of e.leaves) { if (!isLocal(l)) { out.add(absOf(m.path, l)); } }
      for (const el of e.elems || []) { leafPaths(m, el.index, out); }
      return out;
    }

    // ctx: { m, vals: Map(path -> value | undefined), locals, blocking, writes, decisions, reasons,
    //        needElems: Set(path), elemsRead, statements }
    function evalExpr(e, ctx, width) {
      const reads = [];
      const leafValue = (name) => {
        if (isLocal(name)) {
          const l = ctx.locals.get(name);
          // (not assigned yet in this run: a static local holds the last activation's value,
          // not known here; the run says so, staticLocal)
          if ((!l || l.carried) && ctx.carried) { ctx.carried.add(name); }
          return { value: l ? l.value : allX(1), src: 'local', name, write: l && l.write };
        }
        const p = absOf(ctx.m.path, name);
        if (ctx.blocking.has(p)) { const b = ctx.blocking.get(p); return { value: b.value, src: 'blocking', path: p, write: b.write }; }
        const v = ctx.vals.get(p);
        if (v === undefined) {
          const s = signalOf(ctx.m, name);
          const w = s ? Math.max(1, s.width) : 1;
          ctx.missing.add(p);
          return { value: allX(w), src: ctx.vals.has(p) ? 'notDumped' : 'notFetched', path: p };
        }
        return { value: v, src: 'signal', path: p };
      };
      const env = (segs) => {
        const tok = segs.join('.');
        let r;
        const lm = /^_L(\d+)_$/.exec(tok);
        const em = /^_E(\d+)_$/.exec(tok);
        const om = /^_O(\d+)_$/.exec(tok);
        if (lm) {
          const name = e.leaves[Number(lm[1])];
          r = leafValue(name);
          reads.push(Object.assign({ leaf: Number(lm[1]), name }, r));
        } else if (em) {
          const el = e.elems[Number(em[1])];
          r = elemValue(el, ctx);
          reads.push(Object.assign({ elem: Number(em[1]), name: el.array }, r));
        } else if (om) {
          const o = e.opaque[Number(om[1])];
          ctx.reasons.push({ code: 'opaque', src: o.src, why: o.why });
          r = { value: allX(Math.max(1, o.width || 32)), src: 'opaque' };
          reads.push(Object.assign({ opaque: Number(om[1]) }, r));
        } else {
          return null;
        }
        return { width: r.value.w, msb: r.value.w - 1, lsb: 0, value: r.value };
      };
      // The target's width is the context width (no `W'b0 | (...)` wrapper: an OR makes z bits x).
      const p = parse(e.text);
      if (p.error) {
        ctx.reasons.push({ code: p.error === 'tooManySignals' || p.error === 'tooLong' ? 'limits' : 'evaluator', src: e.src, error: p.error });
        return { value: allX(width || Math.max(1, e.width || 1)), reads, failed: true };
      }
      const r = X.evaluate(p.ast, env, width ? { width, wires: true } : { wires: true });
      if (r.error) {
        ctx.reasons.push({ code: 'evaluator', src: e.src, error: r.error });
        return { value: allX(width || Math.max(1, e.width || 1)), reads, failed: true };
      }
      // Which leaves only choose (a conditional's condition: a select, not where the value came
      // from), and where each bit of the value came from (reads.wires: [leaf, bit] or null, bit 0
      // first), for Trace to Root of a clean value.
      // (inOp: inside an operator's operand, as pc + (c ? 2 : 4): there the condition chose what
      // was added; a conditional at the top, or under a concatenation, only chose an arm)
      const selects = new Set(), inOperand = new Set();
      const under = (n, inCond, inOp) => {
        if (!n || typeof n !== 'object') { return; }
        if (n.t === 'name' && inCond) { selects.add(n.path.join('.')); if (inOp) { inOperand.add(n.path.join('.')); } }
        if (n.t === 'cond') { under(n.c, true, inOp); under(n.a, inCond, inOp); under(n.b, inCond, inOp); return; }
        const op = inOp || n.t === 'bin' || n.t === 'un';
        for (const k of ['e', 'l', 'r', 'i', 'c', 'a', 'b']) { if (n[k]) { under(n[k], inCond, op); } }
        if (Array.isArray(n.parts)) { n.parts.forEach((x) => under(x, inCond, op)); }
      };
      under(p.ast, false, false);
      for (const rd of reads) {
        if (rd.leaf !== undefined && selects.has('_L' + rd.leaf + '_')) { rd.select = true; }
        if (rd.leaf !== undefined && inOperand.has('_L' + rd.leaf + '_')) { rd.selectInOperand = true; }
      }
      const lm = (name) => { const m = /^_L(\d+)_$/.exec(name); return m ? Number(m[1]) : null; };
      reads.wires = (r.wires || []).map((x) => (x && lm(x.name) !== null ? [lm(x.name), x.bit] : null));
      return { value: width ? fit(r.value, width) : r.value, reads };
    }

    // An unpacked-array element: its index first; x index or out of range reads all x.
    function elemValue(el, ctx) {
      const idx = evalExpr(el.index, ctx);
      if (hasX(idx.value)) {
        ctx.sawXIndex = true;
        // X-propagation's "resolution" read: the merge of every element the index could name.
        if (ctx.mode === 'xprop') {
          const known = idx.value.a & ~idx.value.b;
          let merged = null, count = 0;
          for (let k = el.lo; k <= el.hi && count <= MAX_RESOLUTION; k++) {
            if ((BigInt(k) & ~idx.value.b & maskOf(idx.value.w)) !== known) { continue; }
            count++;
            const p = absOf(ctx.m.path, el.array) + `[${k}]`;
            ctx.elemsRead.add(p);
            if (!ctx.vals.has(p)) { ctx.needElems.add(p); merged = allX(el.width); continue; }
            const v = ctx.vals.get(p);
            if (v === undefined) { ctx.missing.add(p); }
            const ev = v === undefined ? allX(el.width) : fit(v, el.width);
            merged = merged ? merge(merged, ev) : ev;
          }
          if (merged && count <= MAX_RESOLUTION) { return { value: fit(merged, el.width), src: 'xIndex', index: idx, resolution: count }; }
        }
        return { value: allX(el.width), src: 'xIndex', index: idx };
      }
      const k = Number(idx.value.a);
      if (k < el.lo || k > el.hi) { return { value: allX(el.width), src: 'outOfRange', k }; }
      const p = absOf(ctx.m.path, el.array) + `[${k}]`;
      ctx.elemsRead.add(p);
      if (!ctx.vals.has(p)) { ctx.needElems.add(p); return { value: allX(el.width), src: 'notFetched', path: p, k, index: idx }; }
      const v = ctx.vals.get(p);
      if (v === undefined) { ctx.missing.add(p); return { value: allX(el.width), src: 'elemNotDumped', path: p, k, index: idx }; }
      return { value: v, src: 'element', path: p, k, index: idx };
    }

    // ---- statements ----
    // vscode-port: a leaf with NO VALUE (not in the dump, not computable) is not x. The walk still
    // evaluates it as x, but a condition that reads one is marked (noValue) and is never reported as taking a branch:
    // the step infers the branch from the dump (one match only) or lists the possible ones.
    function noValueLeaves(ctx, e) {
      const out = [];
      for (const p of leafPaths(ctx.m, e, new Set())) { if (ctx.vals.has(p) && ctx.vals.get(p) === undefined) { out.push(p); } }
      return out;
    }
    function newCtx(m, vals, mode) {
      return { m, vals, mode: mode || 'optimistic', locals: new Map(), blocking: new Map(), writes: new Map(), decisions: [],
        reasons: [], missing: new Set(), carried: new Set(), needElems: new Set(), elemsRead: new Set(), statements: 0, path: [], opaque: [], ran: new Set() };
    }
    function fork(ctx) {
      return Object.assign({}, ctx, { locals: new Map(ctx.locals), blocking: new Map(ctx.blocking), writes: new Map([...ctx.writes].map(([k, v]) => [k, v.slice()])), decisions: ctx.decisions.slice(), path: ctx.path.slice() });
    }

    function widthOfTarget(ctx, name) {
      if (isLocal(name)) { const l = ctx.locals.get(name); return l ? l.value.w : null; }
      const s = signalOf(ctx.m, name);
      return s ? s.width : null;
    }
    // The current value of a variable inside a run: its blocking writes so far, else sampled.
    function currentValue(ctx, name, width) {
      if (isLocal(name)) { const l = ctx.locals.get(name); return l ? l.value : allX(width); }
      const p = absOf(ctx.m.path, name);
      if (ctx.blocking.has(p)) { return ctx.blocking.get(p).value; }
      const v = ctx.vals.get(p);
      return v === undefined ? allX(width) : fit(v, width);
    }

    function write(ctx, s, lhs, value) {
      if (lhs.concat) {
        // {a, b} = rhs: the parts take rhs's bits from the top down.
        let top = value.w;
        for (const part of lhs.concat) {
          const w = part.width || 1;
          top -= w;
          write(ctx, s, part, slice(value, Math.max(0, top), w));
        }
        return;
      }
      if (lhs.opaque !== undefined || !lhs.name) {
        ctx.reasons.push({ code: 'lvalue', src: lhs.opaque || s.src });
        // The variable it writes, when the model knows it: the write ran, its bits aren't modelled.
        if (lhs.name) { ctx.opaque.push({ stmt: s, name: lhs.name }); }
        return;
      }
      const name = lhs.name;
      let target = name, lsb = lhs.lsb !== undefined ? lhs.lsb : 0;
      const full = lhs.full || widthOfTarget(ctx, name) || value.w;
      if (lhs.elem) {
        const idx = evalExpr(lhs.elem, ctx).value;
        // An x index writes nothing (as VCS does).
        if (hasX(idx)) { ctx.decisions.push({ kind: 'xWriteIndex', stmt: s, value: idx }); return; }
        target = name + `[${Number(idx.a)}]`;
      }
      if (lhs.off) {
        const off = evalExpr(lhs.off, ctx).value;
        if (hasX(off)) { ctx.decisions.push({ kind: 'xWriteIndex', stmt: s, value: off }); return; }
        lsb = Number(off.a);
      }
      const width = lhs.width || value.w;
      const rec = { stmt: s, lhs, target, lsb, width, value: fit(value, width), decisions: ctx.decisions.slice(), path: ctx.path.slice(), ctx: null };
      rec.ctx = { m: ctx.m, vals: ctx.vals, locals: new Map(ctx.locals), blocking: new Map(ctx.blocking) };
      if (isLocal(target)) {
        const old = ctx.locals.get(target);
        const base = old ? old.value : allX(full);
        const whole = lsb === 0 && width >= base.w;
        // (a part write keeps the other bits: still carried if they were)
        ctx.locals.set(target, { value: whole ? fit(value, base.w) : insert(base, lsb, fit(value, width)), carried: !whole && (!old || !!old.carried), write: rec });
        return;
      }
      const p = absOf(ctx.m.path, target);
      if (!ctx.writes.has(p)) { ctx.writes.set(p, []); }
      ctx.writes.get(p).push(rec);
      if (!s.nb && !lhs.elem) {
        const base = currentValue(ctx, target, full);
        ctx.blocking.set(p, { value: lsb === 0 && width >= base.w ? fit(value, base.w) : insert(base, lsb, fit(value, width)), write: rec });
      }
    }

    function exec(s, ctx) {
      if (!s) { return; }
      if (++ctx.statements > MAX_STATEMENTS) { if (ctx.statements === MAX_STATEMENTS + 1) { ctx.reasons.push({ code: 'budget' }); } return; }
      ctx.ran.add(s);
      switch (s.k) {
        case 'seq': for (const x of s.s) { exec(x, ctx); } return;
        case 'decl': {
          // lifetime (the sidecar's): static, one variable for every activation (its initialiser
          // ran once, before time 0): the last activation's value, carried; automatic: new each
          // activation (x, or its initialiser). An older sidecar gives none: it may be static,
          // so carried, initialised or not (never a wrong exact from a stale model).
          const stat = s.lifetime !== 'automatic';
          const v = s.init && !stat ? evalExpr(s.init, ctx, s.width).value : allX(s.width);
          ctx.locals.set(s.name, { value: v, carried: stat, write: s.init && !stat ? { stmt: s, value: v, decl: true, lhs: { name: s.name }, ctx: { m: ctx.m, vals: ctx.vals, locals: new Map(ctx.locals), blocking: new Map(ctx.blocking) }, decisions: ctx.decisions.slice() } : null });
          return;
        }
        case 'asgn': {
          const lhs = s.lhs;
          const w = lhs.concat ? lhs.width : (lhs.width || widthOfTarget(ctx, lhs.name) || s.rhs.width || 1);
          const v = evalExpr(s.rhs, ctx, w).value;
          write(ctx, s, lhs, v);
          // What the functions its right side calls write (the model's "writes").
          ranWrites(s, ctx);
          return;
        }
        case 'timed': ctx.reasons.push({ code: 'delay', src: s.src }); exec(s.stmt, ctx); return;
        case 'if': {
          ranWrites(s, ctx);
          const c = evalExpr(s.c, ctx).value;
          const t = X.truthy(c);
          const unknown = !t && hasX(c);
          const d = { kind: 'if', stmt: s, value: c, taken: t ? 'then' : 'else', xCond: unknown };
          if (unknown) { const nv = noValueLeaves(ctx, s.c); if (nv.length) { d.noValue = nv; } }
          if (unknown && ctx.mode === 'xprop') {
            d.taken = 'merge';
            ctx.decisions.push(d);
            runMerged(ctx, [s.t, s.f || null], d);
            return;
          }
          ctx.decisions.push(d);
          ctx.path.push({ stmt: s, branch: t ? 't' : 'f' });
          exec(t ? s.t : s.f, ctx);
          ctx.path.pop();
          return;
        }
        case 'case': {
          ranWrites(s, ctx);
          const sel = evalExpr(s.e, ctx).value;
          let hit = -1;
          // Items are compared as written (a width context would turn their z wildcards into x).
          const matches = s.items.map((it) => it.m.map((m) => evalExpr(m, ctx).value));
          for (let i = 0; i < s.items.length && hit < 0; i++) {
            if (matches[i].some((v) => caseMatch(sel, v, s.cond))) { hit = i; }
          }
          const d = { kind: 'case', stmt: s, value: sel, taken: hit >= 0 ? hit : 'default', xCond: hasX(sel) };
          if (d.xCond) { const nv = noValueLeaves(ctx, s.e); if (nv.length) { d.noValue = nv; } }
          if (d.xCond && ctx.mode === 'xprop' && s.cond === 'Normal') {
            // Every item that could match an x selector, and the default.
            const branches = [];
            s.items.forEach((it, i) => { if (matches[i].some((v) => caseMayMatch(sel, v))) { branches.push(it.s); } });
            branches.push(s.dflt || null);
            d.taken = 'merge';
            ctx.decisions.push(d);
            runMerged(ctx, branches, d);
            return;
          }
          if (s.check === 'Unique' || s.check === 'Unique0' || s.check === 'Priority') {
            const n = matches.filter((ms) => ms.some((v) => caseMatch(sel, v, s.cond))).length;
            if (n === 0 && !s.dflt && s.check !== 'Unique0') { d.violation = 'noMatch'; }
            if (n > 1 && s.check !== 'Priority') { d.violation = 'multipleMatches'; }
          }
          ctx.decisions.push(d);
          ctx.path.push({ stmt: s, branch: hit >= 0 ? hit : 'd' });
          exec(hit >= 0 ? s.items[hit].s : s.dflt, ctx);
          ctx.path.pop();
          return;
        }
        default:
          ctx.reasons.push({ code: 'statement', why: s.why, src: s.src });
          ranWrites(s, ctx);
      }
    }
    // A statement that isn't re-executed (or a condition with side effects, such as a
    // $value$plusargs output, or an assignment whose right side calls a function that writes a
    // module variable) ran: what the model says it writes.
    function ranWrites(s, ctx) {
      if (Array.isArray(s.writes)) { s.writes.forEach((w) => ctx.opaque.push({ stmt: s, name: w.name })); }
    }

    // X-propagation: run each branch from the same state and merge what they write, per bit
    // (a branch that doesn't write a variable keeps its value there).
    function runMerged(ctx, branches, decision) {
      const runs = branches.map((b) => { const c = fork(ctx); exec(b, c); return c; });
      const targets = new Set();
      for (const r of runs) { for (const p of r.writes.keys()) { targets.add(p); } for (const p of r.blocking.keys()) { targets.add(p); } }
      for (const r of runs) { r.reasons.forEach((x) => ctx.reasons.push(x)); r.missing.forEach((x) => ctx.missing.add(x)); r.needElems.forEach((x) => ctx.needElems.add(x)); }
      for (const p of targets) {
        const name = relOf(ctx.m, p);
        const w = widthOfTarget(ctx, name) || 1;
        let merged = null;
        const recs = [];
        for (const r of runs) {
          const v = r.blocking.has(p) ? r.blocking.get(p).value : lastFull(r, p, name, w);
          merged = merged ? merge(merged, v) : v;
          const ws = r.writes.get(p);
          const before = ctx.writes.get(p) || [];
          if (ws && ws.length > before.length) { recs.push(...ws.slice(before.length)); }
        }
        const rec = { stmt: recs.length ? recs[recs.length - 1].stmt : null, merged: recs, lhs: { name }, target: name, lsb: 0, width: w, value: merged, decisions: ctx.decisions.slice(), path: ctx.path.slice(), ctx: { m: ctx.m, vals: ctx.vals, locals: new Map(ctx.locals), blocking: new Map(ctx.blocking) }, xprop: decision };
        if (!ctx.writes.has(p)) { ctx.writes.set(p, []); }
        ctx.writes.get(p).push(rec);
        if (runs.some((r) => r.blocking.has(p))) { ctx.blocking.set(p, { value: merged, write: rec }); }
      }
      ctx.statements = Math.max(...runs.map((r) => r.statements));
    }
    // A variable's value at the end of a run: its writes applied to the value before.
    function lastFull(run, p, name, w) {
      let v = currentValue(Object.assign({}, run, { blocking: new Map() }), name, w);
      for (const rec of run.writes.get(p) || []) { v = rec.lsb === 0 && rec.width >= w ? fit(rec.value, w) : insert(v, rec.lsb, fit(rec.value, rec.width)); }
      return v;
    }

    // Every leaf a procedure may read (fetched in one batch at its sample time).
    function procReads(m, p, out) {
      const visit = (s) => {
        if (!s) { return; }
        switch (s.k) {
          case 'seq': s.s.forEach(visit); return;
          case 'decl': leafPaths(m, s.init, out); return;
          case 'asgn': leafPaths(m, s.rhs, out); lvalReads(m, s.lhs, out); return;
          case 'timed': visit(s.stmt); return;
          case 'if': leafPaths(m, s.c, out); visit(s.t); visit(s.f); return;
          case 'case': leafPaths(m, s.e, out); s.items.forEach((it) => { it.m.forEach((x) => leafPaths(m, x, out)); visit(it.s); }); visit(s.dflt); return;
          default:
        }
      };
      visit(p.body);
      return out;
    }
    function lvalReads(m, lhs, out) {
      if (!lhs) { return; }
      if (lhs.concat) { lhs.concat.forEach((x) => lvalReads(m, x, out)); return; }
      if (lhs.elem) { leafPaths(m, lhs.elem, out); }
      if (lhs.off) { leafPaths(m, lhs.off, out); }
      // A partial write keeps the other bits: the target's own value is read too.
      if (lhs.name && !isLocal(lhs.name) && (lhs.lsb !== undefined || lhs.off)) { out.add(absOf(m.path, lhs.name)); }
    }
    function writesTo(lhs, name) {
      if (!lhs) { return false; }
      if (lhs.concat) { return lhs.concat.some((x) => writesTo(x, name)); }
      return lhs.name === name;
    }
    // What an opaque statement or a condition with side effects writes (the model's "writes").
    const opaqueWrites = (s, name) => Array.isArray(s.writes) && s.writes.some((w) => w.name === name);
    function stmtWrites(s, name) {
      if (!s) { return false; }
      if (opaqueWrites(s, name)) { return true; }
      switch (s.k) {
        case 'seq': return s.s.some((x) => stmtWrites(x, name));
        case 'asgn': return writesTo(s.lhs, name);
        case 'timed': return stmtWrites(s.stmt, name);
        case 'if': return stmtWrites(s.t, name) || stmtWrites(s.f, name);
        case 'case': return s.items.some((it) => stmtWrites(it.s, name)) || stmtWrites(s.dflt, name);
        default: return false;
      }
    }

    // vscode-port: the assignments in a statement that write `name` (the editor marks them: the one that
    // ran is the driver, the others are the block's other writes).
    // (opaque: also a statement the model keeps whole (a for loop it does not unroll) that writes `name`, as one
    // write: the driver highlight marks its range, so the write inside it is never left unmarked)
    function writeStmts(s, name, out, opaque = false) {
      if (!s) { return out; }
      switch (s.k) {
        case 'seq': s.s.forEach((x) => writeStmts(x, name, out, opaque)); break;
        case 'asgn': if (writesTo(s.lhs, name)) { out.push(s); } break;
        case 'timed': writeStmts(s.stmt, name, out, opaque); break;
        case 'if': writeStmts(s.t, name, out, opaque); writeStmts(s.f, name, out, opaque); break;
        case 'case': s.items.forEach((it) => writeStmts(it.s, name, out, opaque)); writeStmts(s.dflt, name, out, opaque); break;
        default: if (opaque && opaqueWrites(s, name)) { out.push(s); } break;
      }
      return out;
    }

    // ---- drivers ----
    // The drivers of `name` (relative to model m): assigns, procedures, the instance's input
    // port (connected in the parent), and child instances' output ports connected to it.
    function driversOf(m, name) {
      let idx = indexCache.get(m);
      if (!idx) { idx = new Map(); indexCache.set(m, idx); }
      if (idx.has(name)) { return idx.get(name); }
      const out = [];
      const s = signalOf(m, name);
      const base = s && s.element ? s.element.array : name;
      m.assigns.forEach((a, i) => { if (writesTo(a.lhs, base)) { out.push({ type: 'assign', a, i }); } });
      // A net's declaration assignment (wire w = e) is a continuous assignment, not an initializer.
      if (s && s.kind === 'net' && s.init && !s.element) {
        out.push({ type: 'assign', i: -1, a: { lhs: { name, width: s.width, full: s.width, loc: s.loc }, rhs: s.init, src: `${name} = ${s.init.src || leafText(s.init)}`, loc: s.init.loc } });
      }
      m.procs.forEach((p) => { if (stmtWrites(p.body, base)) { out.push({ type: 'proc', p }); } });
      for (const port of m.ports) {
        if ((port.dir === 'In' || port.dir === 'InOut') && port.internal === base && port.conn && m.parent) { out.push({ type: 'portIn', port }); }
      }
      for (const child of m.children) {
        for (const port of child.ports) {
          if ((port.dir === 'Out' || port.dir === 'InOut') && port.connLval && writesTo(port.connLval, base)) { out.push({ type: 'portOut', child, port }); }
        }
      }
      idx.set(name, out);
      return out;
    }

    async function fetch(paths, t) {
      const list = [...paths];
      const raw = list.length ? await dump.values(list, t) : new Map();
      const out = new Map();
      for (const p of list) {
        const bits = raw.get(p);
        out.set(p, bits === undefined || bits === null ? undefined : X.fromBits(String(bits), String(bits).length));
      }
      return out;
    }

    // Runs a procedure at one sample time, fetching array elements its run reads.
    // Block locals some path of the process may read before every path to that read has assigned
    // them whole (blocking, or a declaration's initialiser): static, they may carry the last
    // activation's value. A statement the walk doesn't follow (opaque) counts as reading the locals
    // its text names that are not yet assigned; with no text, or a macro (a backtick), every local
    // of the process. Kept per process.
    const carriedMemo = new WeakMap();
    function carriedLocals(p) {
      if (carriedMemo.has(p)) { return carriedMemo.get(p); }
      const carry = new Set(), every = new Set();
      let all = false;
      const note = (l) => { if (isLocal(l)) { every.add(l); } };
      const readsOf = (e, A) => {
        if (!e) { return; }
        for (const l of e.leaves || []) { note(l); if (isLocal(l) && !A.has(l)) { carry.add(l); } }
        for (const el of e.elems || []) { readsOf(el.index, A); }
      };
      const lhsReads = (lhs, A) => {
        if (!lhs) { return; }
        if (lhs.concat) { lhs.concat.forEach((x) => lhsReads(x, A)); return; }
        readsOf(lhs.elem, A); readsOf(lhs.off, A);
        if (lhs.name) { note(lhs.name); }
        // (a part write keeps the other bits: a read of them)
        if (lhs.name && isLocal(lhs.name) && (lhs.elem || lhs.off || lhs.lsb !== undefined) && !A.has(lhs.name)) { carry.add(lhs.name); }
      };
      const wholeNames = (lhs, out) => {
        if (!lhs) { return; }
        if (lhs.concat) { lhs.concat.forEach((x) => wholeNames(x, out)); return; }
        if (lhs.name && isLocal(lhs.name) && !lhs.elem && !lhs.off && lhs.lsb === undefined) { out.push(lhs.name); }
      };
      const meet = (sets) => new Set([...sets[0]].filter((x) => sets.every((y) => y.has(x))));
      const flow = (x, A) => {
        if (!x) { return A; }
        switch (x.k) {
          case 'seq': for (const y of x.s) { A = flow(y, A); } return A;
          // (locals are keyed by name only, so a declaration starts a new variable: a
          // sibling block's whole write of a same-named local says nothing about this one)
          case 'decl': {
            note(x.name);
            const fresh = new Set([...A].filter((l) => l !== x.name));
            if (x.init && x.lifetime === 'automatic') { readsOf(x.init, A); fresh.add(x.name); }
            return fresh;
          }
          case 'asgn': {
            readsOf(x.rhs, A); lhsReads(x.lhs, A);
            if (x.nb) { return A; }
            const names = [];
            wholeNames(x.lhs, names);
            return names.length ? new Set([...A, ...names]) : A;
          }
          case 'timed': return flow(x.stmt, A);
          case 'if': readsOf(x.c, A); return meet([flow(x.t, A), x.f ? flow(x.f, A) : A]);
          case 'case': {
            readsOf(x.e, A);
            const outs = x.items.map((it) => { it.m.forEach((y) => readsOf(y, A)); return flow(it.s, A); });
            outs.push(x.dflt ? flow(x.dflt, A) : A);
            return meet(outs);
          }
          default: {
            const src = typeof x.src === 'string' && x.src ? x.src : null;
            if (src === null || src.includes('`')) { all = true; return A; }
            for (const w of src.match(/[A-Za-z_][A-Za-z0-9_$]*/g) || []) { const l = '$local:' + w; if (!A.has(l)) { carry.add(l); } }
            return A;
          }
        }
      };
      flow(p.body, new Set());
      const out = all ? every : new Set([...carry].filter((l) => every.has(l)));
      carriedMemo.set(p, out);
      return out;
    }
    // A run's path is known exactly unless a branch condition (or case selector) was x, a case
    // violated its check, an input was not in the dump, or it ran a statement the walk doesn't
    // follow: then the locals its process may carry count as read (the static rule, for that run).
    function pathUncertain(ctx) {
      return ctx.decisions.some((d) => d.xCond || d.violation) || ctx.missing.size > 0 || (Array.isArray(ctx.opaque) && ctx.opaque.length > 0);
    }

    async function runProc(m, p, sample, extra, mode) {
      const reads = procReads(m, p, new Set());
      const vals = await fetch(reads, sample);
      for (const [k, v] of extra || []) { vals.set(k, v); }
      let ctx;
      for (let round = 0; ; round++) {
        ctx = newCtx(m, vals, mode);
        exec(p.body, ctx);
        if (!ctx.needElems.size || round >= MAX_ELEMENT_ROUNDS) { break; }
        const more = await fetch(ctx.needElems, sample);
        for (const [k, v] of more) { vals.set(k, v); }
      }
      if (pathUncertain(ctx)) { for (const l of carriedLocals(p)) { ctx.carried.add(l); } }
      return ctx;
    }

    // Values for display: a cmux value -> bits text.
    const shown = (v) => bitsOf(X, v);

    // A read of a temp written earlier in the same run (a local, or a variable written blocking) also
    // lists what that write read: the temp's dumped value is not what was read (a block may end with
    // tmp = 'bx), so following the temp alone would go astray. `through` names the temp.
    function faninOf(m, e, reads, time, role, out, seen) {
      for (const r of reads) {
        if (r.src === 'opaque') { continue; }
        const entry = { role, time };
        if (r.leaf !== undefined) {
          entry.name = r.name;
          entry.locs = (e.leafLocs && e.leafLocs[r.leaf] || []).map((l) => locOf(m, l)).filter(Boolean);
        } else if (r.elem !== undefined) {
          entry.name = r.k !== undefined ? `${r.name}[${r.k}]` : r.name;
          const el = e.elems[r.elem];
          if (el && el.index) { faninOf(m, el.index, r.index ? r.index.reads : [], time, 'index', out); }
        }
        entry.value = shown(r.value);
        entry.width = r.value.w;
        if (r.src === 'local') { entry.local = true; entry.name = r.name.slice(7); if (r.write) { entry.via = { src: r.write.stmt.src, loc: locOf(m, r.write.stmt.loc) }; } }
        else if (r.src === 'blocking') { entry.path = r.path; entry.blocking = true; if (r.write) { entry.via = { src: r.write.stmt && r.write.stmt.src, loc: r.write.stmt && locOf(m, r.write.stmt.loc) }; } }
        else if (r.path) { entry.path = r.path; }
        entry.dumped = !(r.src === 'notDumped' || r.src === 'elemNotDumped' || r.src === 'notFetched');
        if (r.src === 'xIndex') { entry.xIndex = true; }
        if (r.select) { entry.select = true; }
        if (r.selectInOperand) { entry.selectInOperand = true; }
        // The bits of the value this leaf is wired to ([value bit, leaf bit], bit 0 first): a data
        // read only (a condition's or an index's wires are to the condition, not to the target).
        if (role === 'data' && r.leaf !== undefined && Array.isArray(reads.wires)) {
          const w = [];
          reads.wires.forEach((x, k) => { if (x && x[0] === r.leaf) { w.push([k, x[1]]); } });
          if (w.length) { entry.wires = w; }
        }
        if (seen && seen.through) { entry.through = seen.through; }
        const key = (entry.path || entry.name) + '|' + role;
        if (!out.some((x) => (x.path || x.name) + '|' + x.role === key)) { out.push(entry); }
        const w = (r.src === 'local' || r.src === 'blocking') && r.write;
        const done = (seen && seen.writes) || new Set();
        // What the temp's write read: its rhs, or a declaration's initializer (logic t = e;).
        const rhs = w && w.stmt && (w.stmt.rhs || (w.decl && w.stmt.init));
        if (rhs && w.ctx && !done.has(w)) {
          // At most 16 temps' writes are followed; past that the fan-in is cut, and the step says so.
          if (done.size >= 16) { out.limited = true; continue; }
          done.add(w);
          // The temp write's reads, wired to this statement's value: through the bits of the temp
          // this one is wired to (none where an operator made the value from the temp).
          const inner = readsOf(rhs, w.ctx, w.width || w.stmt.width);
          if (Array.isArray(reads.wires)) {
            const tw = inner.wires || [];
            inner.wires = reads.wires.map((x) => (x && x[0] === r.leaf && tw[x[1]] ? tw[x[1]] : null));
          } else { inner.wires = undefined; }
          faninOf(m, rhs, inner, time, role, out, { writes: done, through: (seen && seen.through) || entry.path || entry.name });
        }
      }
      return out;
    }

    // Re-runs an expression only to list its reads (fan-in), in the context it was evaluated in.
    function readsOf(e, wctx, width) {
      const ctx = Object.assign(newCtx(wctx.m, wctx.vals), { locals: wctx.locals || new Map(), blocking: wctx.blocking || new Map() });
      return evalExpr(e, ctx, width).reads;
    }

    function decisionsOut(m, ds) {
      return ds.filter((d) => d.kind === 'if' || d.kind === 'case').map((d) => {
        const s = d.stmt;
        const out = { kind: d.kind, src: d.kind === 'if' ? s.c.src : s.e.src, loc: locOf(m, (d.kind === 'if' ? s.c.loc : s.e.loc) || s.loc), stmtLoc: locOf(m, s.loc), value: shown(d.value), taken: d.taken, xCond: d.xCond };
        // The branch taken and the ones not taken (the editor dims those).
        const branches = d.kind === 'if' ? [['then', s.t], ['else', s.f]] : s.items.map((it, i) => [i, it.s]).concat([['default', s.dflt]]);
        out.untaken = branches.filter(([k, b]) => b && b.loc && k !== d.taken && d.taken !== 'merge').map(([, b]) => locOf(m, b.loc));
        const taken = branches.find(([k]) => k === d.taken);
        if (taken && taken[1]) { out.takenLoc = locOf(m, taken[1].loc); }
        if (d.kind === 'case' && typeof d.taken === 'number' && s.items[d.taken].m[0]) { out.item = s.items[d.taken].m.map((x) => x.src).join(', '); }
        if (d.violation) { out.violation = d.violation; }
        // no value: no branch is reported as taken (unless inferred from the dump), and the value is not x.
        if (d.noValue) { out.noValue = d.noValue; out.value = null; out.xCond = false; }
        if (d.inferredFrom) { out.inferred = true; out.inferredFrom = d.inferredFrom; if (!d.noValue) { out.value = shown(allX(d.value.w)); out.xCond = true; } }
        if (d.noValue && !d.inferredFrom) { out.taken = 'unknown'; out.untaken = []; delete out.takenLoc; }
        return out;
      });
    }

    // The clock and async controls of an edge procedure: an event whose signal the top if reads
    // is an async control; the remaining one is the clock (the usual synthesis rule).
    function clocking(m, p) {
      let top = p.body;
      while (top && top.k === 'seq' && top.s.length === 1) { top = top.s[0]; }
      if (top && top.k === 'seq' && top.s[0] && top.s[0].k === 'if') { top = top.s[0]; }
      const condLeaves = new Set(top && top.k === 'if' ? top.c.leaves : []);
      const evs = p.events.filter((e) => e.edge !== 'Other' && e.expr && e.expr.leaves.length).map((e) => ({ edge: e.edge, name: e.expr.leaves[0], path: absOf(m.path, e.expr.leaves[0]), iff: e.iff, simple: /^_L0_$/.test(e.expr.text) }));
      const asyncs = evs.filter((e) => condLeaves.has(e.name));
      const clocks = evs.filter((e) => !condLeaves.has(e.name));
      return { clock: clocks.length === 1 ? clocks[0] : (clocks[0] || null), asyncs, all: evs };
    }
    // Initial and final blocks, and an always that waits on a delay (always #5 clk = ~clk): the
    // testbench's stimulus, not logic re-run from its inputs.
    const isStimulus = (p) => p.kind === 'Initial' || p.kind === 'Final'
      || (p.kind === 'Always' && p.events.some((e) => e.edge === 'Other' && e.kind !== 'ImplicitEvent'));
    const isEdgeProc = (p) => p.events.some((e) => e.edge === 'PosEdge' || e.edge === 'NegEdge' || e.edge === 'BothEdges');

    // The first statement slang could not elaborate (its writes unknown), or null.
    function unknownWrites(s) {
      if (!s || typeof s !== 'object') { return null; }
      if (s.k === 'opaque' && s.why === 'Invalid') { return s; }
      for (const k of ['s', 'stmt', 't', 'f', 'dflt']) {
        const v = s[k];
        const hit = Array.isArray(v) ? v.map(unknownWrites).find(Boolean) : unknownWrites(v);
        if (hit) { return hit; }
      }
      return Array.isArray(s.items) ? s.items.map((it) => unknownWrites(it.s)).find(Boolean) || null : null;
    }
    // Whether `now`, unchanged since `since`, is what the signal started with: its declaration's
    // initializer, else x, or 0 for a 2-state type (the model's `twoState`; without it, 4-state).
    // False when it changed after the start.
    async function startValue(m, sig, now, since) {
      if (Number(since) !== 0) { return false; }
      if (!sig.init) { return sig.twoState === true ? /^0+$/.test(shown(now)) : /^x+$/.test(shown(now)); }
      const vals = await fetch(leafPaths(m, sig.init, new Set()), 0);
      const ctx = newCtx(m, vals);
      await fillElements(ctx, m, sig.init, 0);
      const ev = evalExpr(sig.init, ctx, sig.width);
      return !ctx.reasons.length && same(fit(ev.value, now.w), now);
    }

    // ---- the step ----
    async function active(path, time, opts) {
      const o = opts || {};
      const t = Number(time);
      const where = await models.lookup(path);
      if (!where || !where.instance) { return { signal: path, time: t, error: 'notInDesign' }; }
      const m = await model(where.instance);
      const name = where.name;
      const sig = signalOf(m, name);
      const step = { signal: path, time: t, instance: m.path, name, reasons: [] };
      if (!sig) { step.error = 'notASignal'; return step; }
      step.width = sig.width;
      if (sig.loc) { step.declLoc = locOf(m, sig.loc); }
      const now = (await fetch([path], t)).get(path);
      step.value = shown(now);
      step.dumped = now !== undefined;
      // (a time inside a capture gap, a WCZ file's: not recorded, rather than not dumped)
      const gapNow = now === undefined ? unrecorded(t - 1, t) : null;
      if (now === undefined) { step.reasons.push(gapNow ? { code: 'notRecorded', time: Number(gapNow.from) } : { code: 'targetNotDumped', path }); }
      step.since = now === undefined ? null : await dump.lastChange(path, t);
      // Dumped, but when it last changed is unknown (the reader refused it, or a capture gap may
      // hide it): the activation found from the clock is a guess.
      if (now !== undefined && step.since === null) {
        const gap = unrecorded(-Infinity, t);
        step.reasons.push(gap ? { code: 'notRecorded', time: Number(gap.from) } : { code: 'sinceUnknown' });
      }
      // The instance's own drivers, else statements of other instances that write into it.
      let cands = driversOf(m, name).map((d) => ({ m, d, name }));
      if (!cands.length) { cands = await outsideDrivers(m, name); }
      const all = cands.map((c) => c.d);
      step.drivers = cands.map((c) => Object.assign(driverSummary(c.m, c.d), c.m === m ? {} : { writer: c.m.path }));
      const live = cands.filter((c) => c.d.type !== 'proc' || !isStimulus(c.d.p));
      if (!all.length) {
        // A statement slang could not elaborate may write anything in its instance: its block is
        // the candidate, approximate.
        const unknown = m.procs.filter((p) => unknownWrites(p.body));
        if (unknown.length) {
          const uc = unknown.map((p) => ({ m, d: { type: 'proc', p }, name }));
          step.drivers = uc.map((c) => driverSummary(m, c.d));
          const op = unknownWrites(unknown[0].body);
          const opaque = { code: 'opaque', src: op.src, why: op.why };
          if (unknown.every(isStimulus)) { const r = stimulusStep(step, uc, m, name, sig, t); r.reasons.push(opaque); r.trust = trustOf(r); return r; }
          const p = unknown.find((x) => !isStimulus(x));
          step.driver = driverSummary(m, { type: 'proc', p });
          step.procKind = p.kind;
          step.stmt = { src: op.src, loc: locOf(m, op.loc || p.loc) };
          step.reasons.push(opaque);
          step.trust = trustOf(step);
          return step;
        }
        step.driver = { kind: sig.kind === 'net' ? 'undriven' : 'none' };
        const topInput = !m.parent && m.ports.some((p) => p.internal === name && p.dir === 'In');
        if (topInput) { step.driver.kind = 'topInput'; }
        if (sig.init) { step.driver.kind = 'initializer'; step.stmt = { src: sig.init.src, loc: locOf(m, sig.init.loc) }; }
        // Nothing found writes it, so its value is the one it started with: unless it changed after
        // the start or isn't that value, a write the model doesn't show made it (never exact).
        if (!topInput && now !== undefined && step.since !== null && !(await startValue(m, sig, now, step.since))) {
          if (step.driver.kind === 'initializer') { step.candidates = [step.stmt]; delete step.stmt; step.driver.kind = 'none'; }
          step.reasons.push({ code: 'writeNotFound' });
        }
        step.trust = trustOf(step);
        return step;
      }
      // Only stimulus: the testbench (tracing stops here by default).
      if (!live.length) { return stimulusStep(step, cands, m, name, sig, t); }
      const multi = live.length > 1 ? { code: 'multiDriven', count: live.length } : null;
      if (multi) { step.reasons.push(multi); }
      // Each live driver is tried; the one whose prediction agrees with the dump is the active one.
      // With several that agree, which one made the value is not known (multiDriven, consistent > 1:
      // approximate). A driver predicting all z (a tri-state driver that is off) adds nothing to a
      // resolved net, so it doesn't count.
      let best = null, agree = 0;
      for (const c of live) {
        const r = await runDriver(c.m, c.d, c.name, sig, t, now, step.since, o);
        if (c.m !== m) { r.driver.writer = c.m.path; }
        if (rank(r) >= 3 && !/^z+$/.test(r.predicted || '')) { agree++; }
        if (!best || rank(r) > rank(best)) { best = r; }
        if (rank(r) >= 3 && !multi) { break; }
      }
      if (multi) { multi.consistent = agree; }
      // The instance's own drivers can't explain the value (inconsistent, or no write): another
      // instance's write into it can (a testbench's force or $deposit, a hierarchical write). Its
      // statement is shown, approximate ('force'), with the own driver's answer as a candidate.
      if (rank(best) <= 1 && cands.every((c) => c.m === m)) {
        const outs = await outsideDrivers(m, name);
        const outLive = outs.filter((c) => c.d.type !== 'proc' || !isStimulus(c.d.p));
        let out = null;
        for (const c of outLive) {
          const r = await runDriver(c.m, c.d, c.name, sig, t, now, step.since, o);
          r.driver.writer = c.m.path;
          if (rank(r) >= 2 && (!out || rank(r) > rank(out))) { out = r; }
        }
        const own = best.stmt ? [{ src: best.stmt.src, loc: best.stmt.loc }] : [];
        if (out) {
          Object.assign(step, out, { reasons: step.reasons.concat(out.reasons || [], [{ code: 'force' }]) });
          step.candidates = own;
          step.trust = trustOf(step);
          return step;
        }
        if (outs.length) {
          const r = stimulusStep(step, outs, m, name, sig, t);
          r.reasons.push({ code: 'force' });
          r.candidates = own.concat(r.candidates || []).slice(0, 32);
          return r;
        }
      }
      Object.assign(step, best, { reasons: step.reasons.concat(best.reasons || []) });
      // Its process held the value since the start and never wrote it (a flop whose enable never
      // came): the value is the one it started with, not the process's doing (the process is a
      // candidate).
      if (best.wrote === false && Number(step.since) === 0 && now !== undefined && await startValue(m, sig, now, 0)) {
        const held = step.stmt ? [{ src: step.stmt.src, loc: step.stmt.loc }] : [];
        delete step.activation; delete step.decisions; delete step.stmt;
        step.driver = { kind: sig.init ? 'initializer' : 'none' };
        if (sig.init) { step.stmt = { src: sig.init.src || `${name} = ${sig.init.text}`, loc: locOf(m, sig.init.loc) }; }
        step.candidates = held;
        step.reasons = step.reasons.filter((r) => r.code !== 'noWrite');
      }
      step.trust = trustOf(step);
      return step;
    }

    // A testbench's statements write the signal (only stimulus, or another instance's force or
    // $deposit): the write in effect at t, approximate.
    function stimulusStep(step, cands, m, name, sig, t) {
      const c = cands.find((x) => x.d.type === 'proc') || cands[0];
      const d = c.d, cm = c.m;
      step.driver = { kind: 'initial', procKind: d.p.kind, loc: locOf(cm, d.p.loc) };
      if (cm !== m) { step.driver.writer = cm.path; }
      const writes = [];
      collectWrites(d.p.body, c.name, writes);
      // The write in effect at t (its #delays summed), else the body's last write.
      const at = d.p.kind === 'Initial' ? writeAt(d.p.body, c.name, step.since, t) : null;
      const shownWrite = at || writes[writes.length - 1];
      step.stmt = shownWrite ? { src: shownWrite.src, loc: locOf(cm, shownWrite.loc) } : { src: d.p.body.src, loc: locOf(cm, d.p.loc) };
      // Unchanged since 0 and no write at 0: the declaration's initializer.
      if (!at && Number(step.since) === 0 && sig.init && d.p.kind === 'Initial') { step.stmt = { src: sig.init.src || `${name} = ${sig.init.text}`, loc: locOf(m, sig.init.loc) }; }
      step.candidates = writes.slice(0, 32).map((s) => ({ src: s.src, loc: locOf(cm, s.loc) }));
      step.root = 'testbench';
      step.trust = 'approximate';
      step.reasons.push({ code: 'testbench' });
      return step;
    }

    function rank(r) {
      if (r.wrote === false) { return 0; }
      if (r.consistent === true) { return 3; }
      if (r.consistent === undefined) { return 2; }
      return 1;
    }

    function trustOf(step) {
      if (step.consistent === false) { return 'inconsistent'; }
      const approximate = step.reasons.some((r) => (r.code === 'multiDriven' && r.consistent > 1) || ['opaque', 'limits', 'evaluator', 'statement', 'delay', 'lvalue', 'budget', 'notDumped', 'testbench', 'xprop', 'race', 'targetNotDumped', 'noActivation', 'sinceUnknown', 'force', 'writeNotFound', 'rewrites', 'staticLocal', 'notRecorded'].includes(r.code));
      if (approximate) { return 'approximate'; }
      return step.computed ? 'computed' : 'exact';
    }

    // An initial block's writes to `name` with their start times in delay units ({ s, at }); after a
    // delay that is not a plain number (a unit, an expression, an event), the times are unknown.
    function timedWrites(s, name, at, out) {
      if (!s) { return at; }
      switch (s.k) {
        case 'seq': for (const x of s.s) { at = timedWrites(x, name, at, out); } return at;
        case 'asgn': if (writesTo(s.lhs, name)) { out.push({ s, at }); } return at;
        case 'timed': {
          // The control is what precedes the statement's own text (the source may start with comments).
          const all = String(s.src || ''), own = String((s.stmt && s.stmt.src) || '');
          const head = own && all.endsWith(own) ? all.slice(0, all.length - own.length) : all;
          const m = /#\s*(\d+)\s*$/.exec(head);
          return timedWrites(s.stmt, name, m && at !== null ? at + Number(m[1]) : null, out);
        }
        case 'if': case 'case': {
          const inner = [];
          collectWrites(s, name, inner);
          inner.forEach((x) => out.push({ s: x, at }));
          return hasTimed(s) ? null : at;
        }
        default: return hasTimed(s) ? null : at;
      }
    }
    function hasTimed(s) {
      if (!s || typeof s !== 'object') { return false; }
      if (s.k === 'timed') { return true; }
      return ['s', 'stmt', 't', 'f', 'dflt'].some((k) => (Array.isArray(s[k]) ? s[k].some(hasTimed) : hasTimed(s[k])))
        || (Array.isArray(s.items) && s.items.some((it) => hasTimed(it.s)));
    }
    // The write in effect at t: the dump's time unit per delay unit is a power of ten that puts one
    // of the writes at `since` (the value's last change); the last write at or before t under it
    // (the largest such scale when several fit). Null when none fits.
    function writeAt(body, name, since, t) {
      if (since === null || since === undefined) { return null; }
      const list = [];
      timedWrites(body, name, 0, list);
      const known = list.filter((w) => w.at !== null);
      let pick = null;
      for (let scale = 1; scale <= 1e15; scale *= 10) {
        if (!known.some((w) => w.at * scale === Number(since))) { continue; }
        const before = known.filter((w) => w.at * scale <= Number(t));
        if (before.length) { pick = before[before.length - 1].s; }
      }
      return pick;
    }

    function collectWrites(s, name, out) {
      if (!s) { return; }
      switch (s.k) {
        case 'seq': s.s.forEach((x) => collectWrites(x, name, out)); return;
        case 'asgn': if (writesTo(s.lhs, name) || opaqueWrites(s, name)) { out.push(s); } return;
        case 'timed': collectWrites(s.stmt, name, out); return;
        case 'if': collectWrites(s.t, name, out); collectWrites(s.f, name, out); return;
        case 'case': s.items.forEach((it) => collectWrites(it.s, name, out)); collectWrites(s.dflt, name, out); return;
        default: if (opaqueWrites(s, name)) { out.push(s); }
      }
    }

    function driverSummary(m, d) {
      if (d.type === 'assign') { return { kind: 'assign', src: d.a.src, loc: locOf(m, d.a.loc) }; }
      if (d.type === 'proc') { return { kind: 'proc', procKind: d.p.kind, src: d.p.body.src, loc: locOf(m, d.p.loc) }; }
      // (an input port's connection is the parent's text, evaluated there: `from`)
      if (d.type === 'portIn') { return { kind: 'portIn', port: d.port.name, instance: m.path, from: m.parent, src: connText(d.port.conn), loc: locOf(m, d.port.loc) }; }
      return { kind: 'portOut', port: d.port.name, instance: d.child.path, src: connText(d.port.conn), loc: locOf(m, d.port.loc) };
    }

    // A connection's source text; implicit .name and .* connections have none: their leaves'.
    function leafText(e) { return String(e.text || '').replace(/_L(\d+)_/g, (all, i) => (e.leaves && e.leaves[Number(i)] !== undefined ? e.leaves[Number(i)] : all)); }
    function connText(e) { return e ? (e.src || leafText(e)) : ''; }

    // The bits of the target a write covers, compared with the dump: undefined when not comparable.
    function consistentWith(rec, now, sig) {
      if (!now || !rec || !rec.value) { return undefined; }
      if (rec.after && rec.after.length) {
        // The chosen write's bits with the later writes laid over them, against the dump's same bits.
        const lo = rec.lsb || 0, hi = Math.min(now.w, lo + (rec.width || now.w));
        if (lo >= hi) { return undefined; }
        let v = fit(rec.value, hi - lo);
        for (const a of rec.after) {
          if (!a.value) { return undefined; }
          const alo = a.lsb || 0, aw = a.width || now.w, from = Math.max(lo, alo), to = Math.min(hi, alo + aw);
          if (from < to) { v = insert(v, from - lo, slice(fit(a.value, aw), from - alo, to - from)); }
        }
        return same(v, slice(now, lo, hi - lo));
      }
      if (rec.width >= now.w && rec.lsb === 0) { return same(fit(rec.value, now.w), now); }
      if (rec.lsb + rec.width > now.w) { return undefined; }
      return same(slice(now, rec.lsb, rec.width), rec.value);
    }

    async function runDriver(m, d, name, sig, t, now, since, o) {
      const r = { reasons: [] };
      r.driver = driverSummary(m, d);
      if (d.type === 'assign') {
        const vals = await fetch(leafPaths(m, d.a.rhs, new Set()), t);
        let ctx = newCtx(m, vals, options.xprop === 'on' ? 'xprop' : 'optimistic');
        await fillElements(ctx, m, d.a.rhs, t);
        if (d.a.opaque !== undefined || !d.a.lhs) { r.reasons.push({ code: 'lvalue', src: d.a.src }); return r; }
        const w = d.a.lhs.concat ? d.a.lhs.width : (d.a.lhs.width || sig.width);
        let ev = evalExpr(d.a.rhs, ctx, w);
        if (options.xprop === 'auto' && ctx.sawXIndex && now) {
          // An x index under X-propagation reads the merge of the elements it could name.
          const xctx = newCtx(m, vals, 'xprop');
          await fillElements(xctx, m, d.a.rhs, t);
          const xev = evalExpr(xctx.m ? d.a.rhs : d.a.rhs, xctx, w);
          const before = recFor(ctx, d.a.lhs, name, ev.value, w), after = recFor(xctx, d.a.lhs, name, xev.value, w);
          if (consistentWith(before, now, sig) === false && consistentWith(after, now, sig) === true) { ctx = xctx; ev = xev; r.reasons.push({ code: 'xprop' }); }
        }
        ctx.reasons.forEach((x) => r.reasons.push(x));
        if (d.a.delay) { r.reasons.push({ code: 'delay', src: d.a.src }); }
        const delayed = !!d.a.delay;
        const rec = recFor(ctx, d.a.lhs, name, ev.value, w);
        r.stmt = { src: d.a.src, loc: locOf(m, d.a.loc), rhs: d.a.rhs.src || leafText(d.a.rhs), rhsLoc: locOf(m, d.a.rhs.loc) };
        r.sample = t;
        r.predicted = rec ? shown(rec.value) : null;
        r.bits = rec ? { lsb: rec.lsb, width: rec.width } : null;
        r.consistent = consistentWith(rec, now, sig);
        // A delayed assignment's value at t is its right side's at t - d: not comparable at t.
        if (delayed && r.consistent === false) { r.consistent = undefined; }
        r.fanin = faninOf(m, d.a.rhs, ev.reads, t, 'data', []);
        if (r.fanin.limited) { r.reasons.push({ code: 'limits', why: 'temps' }); }
        notDumped(r, ctx);
        if (r.consistent === false) { explainMismatch(r, ctx); }
        return r;
      }
      if (d.type === 'portIn' || d.type === 'portOut') {
        // A port hop: the value passes through unchanged.
        let pm, e, label;
        if (d.type === 'portIn') { pm = await model(m.parent); e = d.port.conn; label = d.port.name; }
        else { pm = await model(d.child.path); e = { text: '_L0_', leaves: [d.port.internal], leafLocs: [[]], width: d.port.width, src: d.port.internal }; label = d.port.name; }
        const vals = await fetch(leafPaths(pm, e, new Set()), t);
        const ctx = newCtx(pm, vals);
        await fillElements(ctx, pm, e, t);
        const ev = evalExpr(e, ctx, sig.width);
        ctx.reasons.forEach((x) => r.reasons.push(x));
        r.stmt = { src: d.type === 'portIn' ? `.${label}(${e.src || leafText(e)})` : `.${label}(${connText(d.port.conn)})`, loc: locOf(m, d.port.loc) };
        r.port = { name: label, dir: d.port.dir, instance: d.type === 'portIn' ? m.path : d.child.path };
        r.sample = t;
        // An output port into a part of the parent's net covers those bits only.
        const lhs = d.type === 'portOut' ? d.port.connLval : null;
        const rec = lhs ? recFor(ctx, lhs, name, ev.value, lhs.concat ? lhs.width : (lhs.width || sig.width)) : { lsb: 0, width: sig.width, value: fit(ev.value, sig.width) };
        r.predicted = rec ? shown(rec.value) : null;
        r.bits = rec ? { lsb: rec.lsb, width: rec.width } : null;
        r.consistent = consistentWith(rec, now, sig);
        r.fanin = faninOf(pm, e, ev.reads, t, 'data', []);
        notDumped(r, ctx);
        if (r.consistent === false) { explainMismatch(r, ctx); }
        return r;
      }
      return runProcDriver(m, d.p, name, sig, t, now, since, o, r);
    }

    // A write record for the part of an lvalue (assign or port) that names `name`.
    function recFor(ctx, lhs, name, value, width) {
      const c = newCtx(ctx.m, ctx.vals);
      c.locals = ctx.locals; c.blocking = new Map();
      write(c, { src: '', nb: true }, lhs, fit(value, width));
      const s = signalOf(ctx.m, name);
      const base = s && s.element ? s.element.array : name;
      for (const [p, recs] of c.writes) {
        const rel = relOf(ctx.m, p);
        if (rel === name || (s && s.element && rel === name) || (!s?.element && rel === base)) { return recs[recs.length - 1]; }
      }
      return null;
    }

    async function fillElements(ctx, m, e, t) {
      for (let round = 0; round < MAX_ELEMENT_ROUNDS; round++) {
        ctx.needElems = new Set();
        evalExpr(e, ctx);
        if (!ctx.needElems.size) { break; }
        const more = await fetch(ctx.needElems, t);
        for (const [k, v] of more) { ctx.vals.set(k, v); }
      }
      ctx.reasons = [];
      ctx.missing = new Set();
      ctx.carried = new Set();
    }

    // Leaves missing from the dump: listed, and the prediction (made with x for them) can't be
    // held against the dump.
    // So are block locals the run read before assigning them (static: the last activation's value,
    // not known here): staticLocal.
    function notDumped(r, ctx) {
      for (const p of ctx.missing) { r.reasons.push({ code: 'notDumped', path: p }); }
      for (const l of ctx.carried || []) { r.reasons.push({ code: 'staticLocal', path: l.slice('$local:'.length) }); }
      if ((ctx.missing.size || (ctx.carried && ctx.carried.size)) && r.consistent === false) { r.consistent = undefined; }
    }

    function explainMismatch(r, ctx) {
      if (ctx.missing.size || (ctx.carried && ctx.carried.size)) { return; }
      if (!r.reasons.some((x) => ['opaque', 'limits', 'evaluator', 'statement', 'lvalue'].includes(x.code))) {
        r.reasons.push({ code: 'mismatch', predicted: r.predicted });
      }
    }

    // The last activation in (since, t] whose run writes the target (with the value in effect):
    // { te, trig }, or null: none did. The inputs its conditions read (if and case conditions,
    // write indices, asynchronous inputs) are constant between their changes, so every clock edge
    // between two such changes takes the same branches: the last edge of each interval is run,
    // latest first, and each asynchronous edge (its run, at that time). A run that writes is the
    // answer, unless it copies the target back bit for bit (a mux arm holding it): then the data
    // inputs' changes inside that interval cut it finer. An input with no changes to ask (not
    // dumped, an array) is fine while no run reads it. undefined, not known: a run that reads one,
    // past REWRITE_CHANGES condition (or data) changes, or a run that writes another value.
    // Memoised per (target, since, t).
    // Whether a write copies the target's own bits back, bit for bit (its value is the one before).
    function selfCopy(rec, targetPath) {
      try {
        if (!rec || rec.merged || !rec.stmt || !rec.stmt.rhs || !rec.ctx) { return false; }
        const rd = readsOf(rec.stmt.rhs, rec.ctx, rec.width);
        const ws = rd.wires || [], lsb = rec.lsb || 0;
        for (let k = 0; k < rec.width; k++) {
          const x = ws[k];
          const leaf = x && rd.find((r) => r.leaf === x[0]);
          if (!leaf || leaf.path !== targetPath || x[1] !== lsb + k) { return false; }
        }
        return rec.width > 0;
      } catch (error) { return false; }
    }
    // The inputs that choose whether the process writes (its if/case conditions and its write
    // indices), for the rewrite walk's cuts: { paths, opaque }. A block-local temp in a condition
    // has no dump history: it stands for the reads of its assignments in the process (blocking,
    // and declaration initialisers), followed transitively through chained temps; a blocking temp
    // that is a signal is kept and its sources added too. opaque: a local in a condition whose
    // sources the walk can't see (no assignment, or a statement it doesn't follow, e.g. a loop,
    // whose text names it, or has no text or a macro): the caller can't tell the rewrites.
    // A static local carrying the last activation's value is caught per run instead: a run that
    // reads a local before assigning it is not known (ctx.carried, the walk's runAt), so the
    // walk answers rewrites exactly when the path it would assume reads carried state.
    function condReads(m, p) {
      const out = new Set();
      const srcs = new Map();
      const hiddenSrc = [];
      let opaque = false;
      const addSrc = (name, e) => { if (!srcs.has(name)) { srcs.set(name, []); } if (e) { srcs.get(name).push(e); } };
      const lhsSrc = (lhs, e) => {
        if (!lhs) { return; }
        if (lhs.concat) { lhs.concat.forEach((x) => lhsSrc(x, e)); return; }
        if (lhs.name) { addSrc(lhs.name, e); if (lhs.elem) { addSrc(lhs.name, lhs.elem); } if (lhs.off) { addSrc(lhs.name, lhs.off); } }
      };
      const collect = (x) => {
        if (!x) { return; }
        switch (x.k) {
          case 'seq': x.s.forEach(collect); return;
          case 'decl': if (x.init && x.lifetime === 'automatic') { addSrc(x.name, x.init); } return;
          case 'asgn': if (!x.nb) { lhsSrc(x.lhs, x.rhs); } return;
          case 'timed': collect(x.stmt); return;
          case 'if': collect(x.t); collect(x.f); return;
          case 'case': x.items.forEach((it) => collect(it.s)); collect(x.dflt); return;
          default: hiddenSrc.push(typeof x.src === 'string' && x.src ? x.src : null);
        }
      };
      collect(p.body);
      const seen = new Set();
      const exprReads = (e) => {
        if (!e) { return; }
        // (a part the model doesn't follow, e.g. a call: its reads are not known)
        if (Array.isArray(e.opaque) && e.opaque.length) { opaque = true; }
        for (const l of e.leaves || []) { nameReads(l); }
        for (const el of e.elems || []) { exprReads(el.index); }
      };
      const nameReads = (l) => {
        if (!isLocal(l)) { out.add(absOf(m.path, l)); }
        if (seen.has(l)) { return; }
        seen.add(l);
        const ss = srcs.get(l);
        if (isLocal(l)) {
          const bare = l.slice('$local:'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const named = new RegExp('(^|[^A-Za-z0-9_$])' + bare + '($|[^A-Za-z0-9_$])');
          if (!ss || !ss.length || hiddenSrc.some((src) => src === null || src.includes('`') || named.test(src))) { opaque = true; return; }
        }
        for (const e of ss || []) { exprReads(e); }
      };
      const visit = (x) => {
        if (!x) { return; }
        switch (x.k) {
          case 'seq': x.s.forEach(visit); return;
          case 'asgn': writeIndexReads(x.lhs, exprReads); return;
          case 'timed': visit(x.stmt); return;
          case 'if': exprReads(x.c); visit(x.t); visit(x.f); return;
          case 'case': exprReads(x.e); x.items.forEach((it) => { it.m.forEach(exprReads); visit(it.s); }); visit(x.dflt); return;
          default:
        }
      };
      visit(p.body);
      return { paths: out, opaque };
    }
    function writeIndexReads(lhs, reads) {
      if (!lhs) { return; }
      if (lhs.concat) { lhs.concat.forEach((x) => writeIndexReads(x, reads)); return; }
      if (lhs.elem) { reads(lhs.elem); }
      if (lhs.off) { reads(lhs.off); }
    }
    const rewriteMemo = new Map();
    async function lastRewrite(m, p, ck, targetPath, s, now, sig, since, t) {
      const key = targetPath + '|' + since + '|' + t + '|' + shown(now) + (typeof options.rewriteKey === 'function' ? '|' + options.rewriteKey() : '');
      if (rewriteMemo.has(key)) { return rewriteMemo.get(key); }
      if (options.stats && typeof options.stats === 'object') { options.stats.rewriteWalks = (options.stats.rewriteWalks || 0) + 1; }
      const out = await rewriteWalk(m, p, ck, targetPath, s, now, sig, since, t);
      if (rewriteMemo.size >= 4096) { rewriteMemo.clear(); }
      rewriteMemo.set(key, out);
      return out;
    }
    async function rewriteWalk(m, p, ck, targetPath, s, now, sig, since, t) {
      const mode = options.xprop === 'on' ? 'xprop' : 'optimistic';
      const asyncPaths = new Set(ck.asyncs.map((a) => a.path));
      const cr = condReads(m, p);
      if (cr.opaque) { return undefined; }
      const conds = [...cr.paths].filter((q) => q !== targetPath && q !== ck.clock.path);
      for (const a of asyncPaths) { if (!conds.includes(a)) { conds.push(a); } }
      const data = [...procReads(m, p, new Set())].filter((q) => q !== targetPath && q !== ck.clock.path && !conds.includes(q));
      let blind = false;
      // The changes of `qs` in (lo, hi] (each input's count first, all at once where the dump
      // counts: one with none is not walked; past `cap` in all, undefined).
      const cutsOf = async (qs, lo, hi, cap) => {
        if (!(hi > lo) || !qs.length) { return []; }
        const counts = await Promise.all(qs.map(async (q) => {
          if (typeof dump.changeCount !== 'function') { return undefined; }
          try { const k = await dump.changeCount(q, lo, hi); return Number.isFinite(Number(k)) && k !== null ? Number(k) : undefined; } catch (error) { return undefined; }
        }));
        if (counts.reduce((a, k) => a + (k || 0), 0) > cap) { return undefined; }
        const walk = async (q) => {
          const got = [];
          for (let u = hi; ;) {
            let lc;
            try { lc = await dump.lastChange(q, u); } catch (error) { lc = null; }
            if (lc === null || lc === undefined) { return null; }
            if (Number(lc) <= lo) { return got; }
            got.push(Number(lc));
            if (got.length > cap) { return got; }
            u = Number(lc) - 1;
          }
        };
        const walked = await Promise.all(qs.map((q, i) => (counts[i] === 0 ? [] : walk(q))));
        const cuts = new Set();
        let n = 0;
        for (const w of walked) {
          if (w === null) { blind = true; continue; }
          n += w.length;
          if (n > cap) { return undefined; }
          w.forEach((x) => cuts.add(x));
        }
        return [...cuts].sort((a, b) => b - a);
      };
      // A run at te (trigger trig, its value at te; the rest sampled at te - 1): 'none' (no write),
      // 'copy' (a bit-for-bit copy of the target), 'write', or undefined (not known).
      const runAt = async (te, trig) => {
        const tv = await fetch([trig.path], te);
        const lc = await runProc(m, p, te - 1, new Map([[trig.path, tv.get(trig.path)]]), mode);
        if (lc.missing.size || (lc.carried && lc.carried.size) || (blind && lc.elemsRead.size)) { return undefined; }
        // (a run through a part it doesn't follow: what it did there is not known)
        if (lc.reasons.some((x) => ['opaque', 'evaluator', 'statement', 'lvalue'].includes(x.code))) { return undefined; }
        const lw = pickWrite(lc, targetPath, s, now);
        if (!lw) { return 'none'; }
        if (selfCopy(lw, targetPath)) { return 'copy'; }
        return consistentWith(lw, now, sig) === true ? 'write' : undefined;
      };
      const lastEdge = async (lo, hi) => {
        const te = await dump.prevEdge(ck.clock.path, Math.min(hi, t), ck.clock.edge);
        return te !== null && te !== undefined && Number(te) - 1 >= lo && Number(te) > since ? Number(te) : null;
      };
      const condCuts = await cutsOf(conds, since, t - 1, REWRITE_CHANGES);
      if (condCuts === undefined) { return undefined; }
      // Asynchronous edges inside: their runs are activations too.
      const asyncEdges = [];
      for (const a of ck.asyncs) {
        // (no change in (since, t]: no edge; not walked)
        let k;
        try { k = typeof dump.changeCount === 'function' ? await dump.changeCount(a.path, since, t) : undefined; } catch (error) { k = undefined; }
        if (k === 0) { continue; }
        for (let u = t; asyncEdges.length <= REWRITE_CHANGES;) {
          let e;
          try { e = await dump.prevEdge(a.path, u, a.edge); } catch (error) { e = null; }
          if (e === null || e === undefined || Number(e) <= since) { break; }
          asyncEdges.push({ te: Number(e), trig: a });
          u = Number(e) - 1;
        }
      }
      if (asyncEdges.length > REWRITE_CHANGES) { return undefined; }
      // Intervals [lo, hi) of constant conditions, latest first, with their asynchronous edges.
      let hi = t + 1;
      for (const lo of condCuts.concat([since])) {
        const cands = asyncEdges.filter((x) => x.te >= lo && x.te < hi);
        const te = await lastEdge(lo, hi);
        if (te !== null) { cands.push({ te, trig: ck.clock, interval: true }); }
        cands.sort((a, b) => b.te - a.te);
        for (const cand of cands) {
          const got = await runAt(cand.te, cand.trig);
          if (got === undefined) { return undefined; }
          if (got === 'write') { return { te: cand.te, trig: cand.trig }; }
          if (got === 'copy' && cand.interval) {
            // (the same branch at every edge here; a data input may still choose what is copied)
            const dataCuts = await cutsOf(data, lo, cand.te - 2, REWRITE_CHANGES);
            if (dataCuts === undefined) { return undefined; }
            let top = cand.te - 1;
            for (const dlo of dataCuts.concat([lo])) {
              const de = await lastEdge(dlo, top);
              if (de !== null && de < cand.te) {
                const dg = await runAt(de, ck.clock);
                if (dg === undefined) { return undefined; }
                if (dg === 'write') { return { te: de, trig: ck.clock }; }
              }
              top = dlo;
            }
          }
        }
        hi = lo;
      }
      return null;
    }

    async function runProcDriver(m, p, name, sig, t, now, since, o, r) {
      const s = sig;
      // An outside writer's target is already an $abs: path.
      const target = s.element && !name.startsWith('$abs:') ? `${s.element.array}[${s.element.k}]` : name;
      const targetPath = absOf(m.path, target);
      r.procKind = p.kind;
      let sample = t;
      let trigger = null;
      const extra = new Map();
      const edge = isEdgeProc(p);
      if (edge) {
        const ck = clocking(m, p);
        r.clock = ck.clock ? { edge: ck.clock.edge, path: ck.clock.path } : null;
        // The activation that produced the value in effect: the edge at its last change, else
        // (x since the start, or no change) the last clock edge at or before t.
        let te = null;
        // (re-run for the cause check: the activation of the step it checks)
        const pinned = typeof options.pinActivation === 'function' ? options.pinActivation(targetPath, t) : null;
        if (pinned !== null && pinned !== undefined && ck.clock) {
          te = Number(pinned); trigger = ck.clock;
          if (options.stats && typeof options.stats === 'object') { options.stats.pinnedRuns = (options.stats.pinnedRuns || 0) + 1; }
        }
        const xFromStart = now && hasX(now) && (since === 0 || since === null);
        // A value may have been written again with no change in the dump (x to x, 3 to 3): the
        // value in effect came from the last edge in (since, t] whose run wrote it, which can have
        // another cause than the change (a CPU core's ALU result: an idle cycle's 'bx, later a
        // jump's x operand). Not known (too many input changes to check): the step says so.
        if (te === null && now && !xFromStart && since && ck.clock) {
          const rw = await lastRewrite(m, p, ck, targetPath, s, now, sig, Number(since), t);
          if (rw === undefined) { r.reasons.push({ code: 'rewrites', time: Number(since) }); }
          else if (rw !== null) { te = rw.te; trigger = rw.trig; }
        }
        if (te !== null) {
          // The last edge (above).
        } else if (since !== null && since !== undefined && !xFromStart) {
          for (const ev of ck.all) {
            if (await dump.prevEdge(ev.path, since, ev.edge) === since) { te = since; trigger = ev; break; }
          }
          if (te === null) {
            if (since === 0) { r.reasons.push({ code: 'initialValue' }); }
            else { r.reasons.push({ code: 'noActivation', time: since }); }
            te = since;
          }
        } else if (ck.clock) {
          te = await dump.prevEdge(ck.clock.path, t, ck.clock.edge);
          trigger = ck.clock;
        }
        if (te === null) { r.wrote = false; r.reasons.push({ code: 'noEdge' }); r.stmt = { src: p.body.src, loc: locOf(m, p.loc) }; return r; }
        sample = te > 0 ? te - 1 : 0;
        r.activation = { time: te, trigger: trigger ? { edge: trigger.edge, path: trigger.path } : null };
        if (trigger) { const tv = await fetch([trigger.path], te); extra.set(trigger.path, tv.get(trigger.path)); }
      }
      r.sample = sample;
      const mode = options.xprop === 'on' ? 'xprop' : 'optimistic';
      let ctx = await runProc(m, p, sample, extra, mode);
      let pick = pickWrite(ctx, targetPath, s, now);
      let consistent = pick ? consistentWith(pick, now, sig) : undefined;
      // A comb procedure's value in effect was made by its run when the value last changed; a later
      // run that took other branches can give the same value by another statement (the default,
      // once an override's condition fell). The statement that made it, when that run explains the
      // value. (An x value is left to the run at t: x again is no change, and its cause is now's.)
      if (!edge && pick && consistent === true && ctx.decisions.length && !hasX(now) && since !== null && since !== undefined && since < t) {
        const at = await runProc(m, p, since, extra, mode);
        const ap = pickWrite(at, targetPath, s, now);
        if (ap && ap.stmt !== pick.stmt && consistentWith(ap, now, sig) === true) { ctx = at; pick = ap; sample = since; r.sample = since; }
      }
      // X-propagation: an x condition on the path and a dump that disagrees: try merged branches.
      if (options.xprop === 'auto' && consistent === false && (ctx.decisions.some((d) => d.xCond) || ctx.sawXIndex)) {
        const merged = await runProc(m, p, sample, extra, 'xprop');
        const mp = pickWrite(merged, targetPath, s, now);
        if (mp && consistentWith(mp, now, sig) === true) {
          ctx = merged; pick = mp; consistent = true;
          r.reasons.push({ code: 'xprop' });
        }
      }
      // A same-time race: inputs changed at the edge itself; the post-edge values may explain it.
      // (not when re-run with some inputs forced: the cause check asks what the sample made)
      if (edge && consistent === false && r.activation && !options.sampleOnly) {
        const late = await runProc(m, p, r.activation.time, extra, ctx.mode);
        const lp = pickWrite(late, targetPath, s, now);
        if (lp && consistentWith(lp, now, sig) === true) { r.reasons.push({ code: 'race', time: r.activation.time }); ctx = late; pick = lp; consistent = true; }
      }
      // A comb procedure that didn't write the target on its path holds it (a latch): the
      // activation is when it last changed.
      if (!pick && !edge && since !== null && since !== undefined && since !== t) {
        const held = await runProc(m, p, since, extra, ctx.mode);
        const hp = pickWrite(held, targetPath, s, now);
        if (hp) { r.reasons.push({ code: 'held', time: since }); ctx = held; pick = hp; consistent = consistentWith(hp, now, sig); r.sample = since; }
      }
      // vscode-port: a write the dump contradicts, while a statement the walk keeps whole (a for loop the
      // design model does not unroll) also writes the target: that statement wrote last (CVA6 alu_valid_n = '0, then
      // alu_valid_n[i] = 1'b1 inside the loop). It is named (approximate), never the contradicted write.
      if (pick && consistent === false) {
        const sgo = signalOf(m, name);
        const baseo = sgo && sgo.element ? sgo.element.array : name;
        if (ctx.opaque.some((o) => o.name === baseo || o.name === name)) { pick = null; consistent = undefined; }
      }
      // vscode-port: never contradict the dump. An x condition sent an edge procedure down a branch that
      // doesn't write the target, but the dump shows the target changing at that edge: the procedure is run again with
      // the x condition bits forced (1-bit leaves, at most 3: 8 runs), and the first run whose write gives the dump's
      // value is the step, labelled branchInferred. Unchanged with an x condition: the writing branches are listed as
      // possible (xBranch) instead of "keeps its value".
      let xForced = null;
      const nvDecision = ctx.decisions.some((d) => d.noValue);
      if ((!pick && ctx.decisions.some((d) => d.xCond)) || nvDecision) {
        const xLeaves = [];
        let unforceable = false;
        for (const d of ctx.decisions) {
          if (!d.xCond || (d.kind !== 'if' && d.kind !== 'case')) { continue; }
          for (const lp of leafPaths(m, d.kind === 'if' ? d.stmt.c : d.stmt.e, new Set())) {
            const v = ctx.vals.get(lp);
            if (v !== undefined && !hasX(v)) { continue; }
            const w = v !== undefined ? v.w : (signalOf(m, lp.startsWith(m.path + '.') ? lp.slice(m.path.length + 1) : lp) || {}).width;
            if (w !== 1) { unforceable = true; continue; }
            if (!xLeaves.includes(lp)) { xLeaves.push(lp); }
          }
        }
        const changed = edge && r.activation ? since !== null && since !== undefined && Number(since) === Number(r.activation.time) : undefined;
        // The outcomes of each forced run: a write (its statement; does it give the dump's value?) or no write (the
        // signal keeps its value: impossible when the dump changed it at that edge).
        const outcomes = [];
        if (xLeaves.length && xLeaves.length <= 3 && !unforceable) {
          for (let k = 0; k < (1 << xLeaves.length); k++) {
            const forced = new Map(extra);
            xLeaves.forEach((lp, i) => forced.set(lp, X.fromBits(String((k >> i) & 1), 1)));
            const run = await runProc(m, p, sample, forced, 'optimistic');
            const wp = pickWrite(run, targetPath, s, now);
            // (a written value made x by an input with no value is not a mismatch: its fit is unknown)
            if (wp) { const f = consistentWith(wp, now, sig); outcomes.push({ run, wp, stmt: wp.stmt, fit: f === false && wp.value && hasX(wp.value) && run.missing.size ? undefined : f }); }
            else if (changed !== true) { outcomes.push({ run, wp: null, stmt: null, fit: changed === false ? true : undefined }); }
          }
        }
        const possible = outcomes.filter((o) => o.fit !== false);
        const kinds = new Set(possible.map((o) => o.stmt));
        r.xInfer = { leaves: xLeaves, unforceable, changed, outcomes: outcomes.map((o) => [o.stmt && o.stmt.src, o.wp && o.wp.value ? shown(o.wp.value) : null, o.fit]), now: now ? shown(now) : null, runs: outcomes.length, possible: possible.length, fits: possible.filter((o) => o.fit === true).length }; // (DIAGNOSTIC)
        // One outcome only, and the dump confirms it: that branch. Anything else: no guess.
        if (kinds.size === 1 && possible.every((o) => o.fit === true) && possible[0].stmt) { xForced = possible[0]; }
        if (xForced) {
          const missing = new Set([...ctx.decisions].flatMap((d) => d.noValue || []));
          ctx = xForced.run; pick = xForced.wp; consistent = true;
          for (const d of ctx.decisions) {
            if (d.kind !== 'if' && d.kind !== 'case') { continue; }
            const lv = [...leafPaths(m, d.kind === 'if' ? d.stmt.c : d.stmt.e, new Set())].filter((x) => xLeaves.includes(x));
            if (lv.length) { d.inferredFrom = lv; const nv = lv.filter((x) => missing.has(x)); if (nv.length) { d.noValue = nv; } }
          }
          r.reasons.push({ code: 'branchInferred', paths: xLeaves });
          r.inferred = true;
        } else {
          const list = possible.length ? possible.map((o) => o.stmt).filter(Boolean) : writeStmts(p.body, s && s.element ? s.element.array : name, []);
          const seen = new Set();
          r.candidates = list.filter((x) => x && !seen.has(x) && seen.add(x)).map((x) => ({ src: x.src, loc: locOf(m, x.loc) }));
          if (nvDecision) { pick = null; r.noValueCondition = ctx.decisions.filter((d) => d.noValue).flatMap((d) => d.noValue); }
          if (r.candidates.length || nvDecision) { r.xBranch = true; }
        }
      }
      ctx.reasons.forEach((x) => r.reasons.push(x));
      r.decisions = decisionsOut(m, pick ? pick.decisions : ctx.decisions);
      r.fanin = [];
      if (r.activation && r.activation.trigger) {
        const tp = r.activation.trigger.path;
        r.fanin.push({ role: 'clock', path: tp, name: relOf(m, tp), value: shown(extra.get(tp)), time: r.activation.time, dumped: extra.get(tp) !== undefined });
      }
      // The conditions on the way to the write (or to nowhere: everything decided), and those of a
      // later if or case that could have written the signal again but didn't (y = 'bx, then a
      // case (1'b1) whose items all failed: the items are why y stayed x). A case's items count up
      // to the one taken (all of them when none was).
      const before = pick ? pick.decisions : ctx.decisions;
      const sgw = signalOf(m, name);
      const wname = sgw && sgw.element ? sgw.element.array : name;
      r.writes = writeStmts(p.body, wname, []).map((x) => ({ src: x.src, loc: locOf(m, x.loc) }));
      const sameRun = pick && before.every((d, i) => ctx.decisions[i] === d);
      const after = sameRun ? ctx.decisions.slice(before.length).filter((dd) => (dd.kind === 'if' || dd.kind === 'case') && stmtWrites(dd.stmt, wname)) : [];
      const condCtx = { m, vals: ctx.vals, locals: new Map(), blocking: new Map() };
      for (const dd of before.concat(after)) {
        if (dd.kind !== 'if' && dd.kind !== 'case') { continue; }
        const e = dd.kind === 'if' ? dd.stmt.c : dd.stmt.e;
        faninOf(m, e, readsOf(e, condCtx), r.sample, 'control', r.fanin);
        if (dd.kind === 'case') {
          const upto = typeof dd.taken === 'number' ? dd.taken + 1 : dd.stmt.items.length;
          dd.stmt.items.slice(0, upto).forEach((it) => (it.m || []).forEach((x) => faninOf(m, x, readsOf(x, condCtx), r.sample, 'control', r.fanin)));
        }
      }
      if (!pick) {
        // Written by a statement that isn't re-executed: that statement, its value unpredicted.
        const sg = signalOf(m, name);
        const base = sg && sg.element ? sg.element.array : name;
        const ow = ctx.opaque.find((o) => o.name === base || o.name === name);
        if (ow) {
          r.stmt = { src: ow.stmt.src, loc: locOf(m, ow.stmt.loc) };
          if (!r.reasons.some((x) => x.code === 'statement' || x.code === 'lvalue')) { r.reasons.push({ code: 'statement', why: ow.stmt.why, src: ow.stmt.src }); }
          notDumped(r, ctx);
          return r;
        }
        r.wrote = false;
        r.stmt = { src: p.body.src, loc: locOf(m, p.loc) };
        r.reasons.push(r.noValueCondition ? { code: 'noValueCondition', paths: r.noValueCondition, path: r.noValueCondition.join(', ') } : { code: r.xBranch ? 'xBranch' : 'noWrite' });
        notDumped(r, ctx);
        return r;
      }
      if (pick.merged) {
        r.merged = pick.merged.map((w) => ({ src: w.stmt.src, loc: locOf(m, w.stmt.loc) }));
        r.stmt = pick.stmt ? { src: pick.stmt.src, loc: locOf(m, pick.stmt.loc) } : { src: p.body.src, loc: locOf(m, p.loc) };
        for (const w of pick.merged) { faninOf(m, w.stmt.rhs, readsOf(w.stmt.rhs, w.ctx, w.width), r.sample, 'data', r.fanin); }
      } else {
        r.stmt = { src: pick.stmt.src, loc: locOf(m, pick.stmt.loc), rhs: pick.stmt.rhs.src, rhsLoc: locOf(m, pick.stmt.rhs.loc), nb: !!pick.stmt.nb };
        const reads = readsOf(pick.stmt.rhs, pick.ctx, pick.lhs && pick.lhs.concat ? pick.lhs.width : pick.width);
        faninOf(m, pick.stmt.rhs, reads, r.sample, 'data', r.fanin);
        if (r.fanin.limited) { r.reasons.push({ code: 'limits', why: 'temps' }); }
        if (pick.lhs && pick.lhs.elem) { faninOf(m, pick.lhs.elem, readsOf(pick.lhs.elem, pick.ctx), r.sample, 'index', r.fanin); }
        if (reads.some((x) => x.src === 'local' || x.src === 'blocking')) { r.computed = true; }
      }
      r.predicted = shown(pick.value);
      r.bits = { lsb: pick.lsb, width: pick.width };
      r.consistent = consistent;
      r.path = (pick.path || []).map((x) => ({ loc: locOf(m, x.stmt.loc), branch: x.branch }));
      // A plain `always @*` does not run at time 0 (always_comb does): x since the start
      // with an input that has not changed yet is the block not having run.
      if (consistent === false && !edge && p.kind === 'Always' && now && hasX(now) && (since === 0 || since === null || since === undefined)) {
        r.reasons.push({ code: 'noActivation', time: 0 });
        r.consistent = undefined;
      }
      notDumped(r, ctx);
      if (r.consistent === false) { explainMismatch(r, ctx); }
      return r;
    }

    // The write that produced the target: the last one in the run that covers it.
    // The write that made the value in effect: the last one, unless the value has x bits that a
    // later partial write covered (s <= s0; s.chk <= f(s0.pkt) with s0.pkt x): then the write
    // that made the most of the x bits (the later one on a tie), with the later writes it was
    // overlaid by (`after`).
    function pickWrite(ctx, targetPath, s, now) {
      const recs = ctx.writes.get(targetPath);
      if (!recs || !recs.length) { return null; }
      const last = recs[recs.length - 1];
      if (!now || recs.length < 2 || !hasX(now)) { return last; }
      const bits = shown(now), w = bits.length;
      const isX = (k) => k >= 0 && k < w && /[xz]/.test(bits[w - 1 - k]);
      const covered = new Set();
      let best = -1, most = 0;
      for (let i = recs.length - 1; i >= 0; i--) {
        const r = recs[i], lo = r.lsb || 0, hi = Math.min(w, lo + (r.width || w));
        let n = 0;
        for (let k = lo; k < hi; k++) { if (!covered.has(k)) { if (isX(k)) { n++; } covered.add(k); } }
        if (n > most) { most = n; best = i; }
      }
      return best < 0 || best === recs.length - 1 ? last : Object.assign({}, recs[best], { after: recs.slice(best + 1) });
    }

    // ---- loads (load trace: who reads a signal) ----
    // Whether expression e (in m) reads the signal at `sig`: 'yes', 'maybe' (it reads the array
    // `sig` is an element of, at an index the model doesn't fix), or ''. An element select of an
    // unpacked array (`elems`: mem[i]) reads the array: 'yes' for the array, 'maybe' for an element.
    function readsSig(m, e, sig) {
      if (!e) { return ''; }
      let found = '';
      for (const l of e.leaves || []) {
        if (isLocal(l)) { continue; }
        const p = absOf(m.path, l);
        if (p === sig) { return 'yes'; }
        if (sig.startsWith(p + '[')) { found = 'maybe'; }
      }
      for (const el of e.elems || []) {
        if (el.array && !isLocal(el.array)) {
          const a = absOf(m.path, el.array);
          if (a === sig) { return 'yes'; }
          if (sig.startsWith(a + '[')) { found = 'maybe'; }
        }
        const r = readsSig(m, el.index, sig);
        if (r === 'yes') { return r; }
        if (r) { found = r; }
      }
      return found;
    }
    // The signals an lvalue writes (block locals as `$local:` names), and whether its index reads sig.
    function lvalNames(m, lhs, out) {
      if (!lhs) { return out; }
      if (lhs.concat) { lhs.concat.forEach((x) => lvalNames(m, x, out)); return out; }
      if (lhs.name) { out.push(isLocal(lhs.name) ? lhs.name : absOf(m.path, lhs.name)); }
      return out;
    }
    function lvalIndexReads(m, lhs, sig) {
      if (!lhs) { return ''; }
      if (lhs.concat) { return lhs.concat.map((x) => lvalIndexReads(m, x, sig)).find(Boolean) || ''; }
      return readsSig(m, lhs.elem, sig) || readsSig(m, lhs.off, sig);
    }
    // Everything a statement may write (its targets when a condition or an event reads the signal).
    function writtenBy(m, st, out) {
      if (!st) { return out; }
      if (Array.isArray(st.writes)) { st.writes.forEach((w) => { if (w && w.name) { out.add(isLocal(w.name) ? w.name : absOf(m.path, w.name)); } }); }
      switch (st.k) {
        case 'seq': st.s.forEach((x) => writtenBy(m, x, out)); break;
        case 'asgn': lvalNames(m, st.lhs, []).forEach((n) => out.add(n)); break;
        case 'timed': writtenBy(m, st.stmt, out); break;
        case 'if': writtenBy(m, st.t, out); writtenBy(m, st.f, out); break;
        case 'case': st.items.forEach((it) => writtenBy(m, it.s, out)); writtenBy(m, st.dflt, out); break;
        default:
      }
      return out;
    }
    const exprText = (e) => (e ? (e.src || leafText(e)) : '');
    // Whether source text (comments and strings dropped) names sig as an identifier of instance m
    // (sig is one of m's own signals: m.path + '.' + a plain name), other than as an assignment's
    // target (`sig[..] <=` / `sig =`; an index inside the target still counts).
    function namedIn(m, text, sig) {
      if (!text || !sig.startsWith(m.path + '.')) { return false; }
      const name = sig.slice(m.path.length + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) { return false; }
      const code = String(text).replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const id = name.replace(/\$/g, '\\$');
      // An assignment's target: `x =` anywhere (not ==), `x <=` only where a statement starts (else it
      // is a comparison, a read: if (x <= 3)).
      const sel = '((\\s*\\[[^\\]]*\\])*)';
      const target = new RegExp('(^|[^A-Za-z0-9_$.\'])' + id + sel + '\\s*=(?!=)', 'g');
      const nonblocking = new RegExp('(^|[;):]|\\bbegin(?:\\s*:\\s*[A-Za-z_][A-Za-z0-9_$]*)?|\\belse|#\\s*[0-9][A-Za-z0-9_.\']*)(\\s*)' + id + sel + '\\s*<=(?!=)', 'g');
      // (a `:` starts a statement after a case label, not in a ternary: a `?` since the statement
      // began, outside based literals (casez wildcards, 4'b1???) and parentheses (a case expression))
      const ternary = (at) => {
        let head = code.slice(0, at).split(/;|\bbegin\b|\bend\b/).pop().replace(/'[sS]?[bBoOhHdD]\s*[0-9a-fA-FxXzZ?_]+/g, ' ');
        for (let prev = ''; prev !== head;) { prev = head; head = head.replace(/\([^()]*\)/g, ' '); }
        return /\?/.test(head);
      };
      const reads = code.replace(nonblocking, (all, pre, space, sel, inner, at) => (pre === ':' && ternary(at) ? all : pre + space + ' ' + (sel || '')))
        .replace(target, (all, pre, sel) => pre + ' ' + (sel || ''));
      return new RegExp('(^|[^A-Za-z0-9_$.\'])' + id + '(?![A-Za-z0-9_$])').test(reads);
    }
    const EDGE_WORD = { PosEdge: 'posedge ', NegEdge: 'negedge ', BothEdges: 'edge ' };
    // The readers of `sig` inside instance m: assigns, declaration initializers, statements (data,
    // condition, index), procedures' sensitivity, and the child input ports it connects. `opaque`
    // counts the statements slang could not elaborate (their reads unknown).
    // Each entry's place in the model, for loadsAt: { m, p (procedure), st (statement), e (the
    // expression read), a (assign) }.
    const loadRefs = new WeakMap();
    function loadsIn(m, sig, out, limits) {
      const entry = (o, l) => Object.assign({ instance: m.path, loc: locOf(m, l) }, o);
      let ref = {};
      const push = (o, l, how) => { const e = entry(o, l); if (how === 'maybe') { e.maybe = true; } loadRefs.set(e, Object.assign({ m }, ref)); out.push(e); };
      for (const a of m.assigns) {
        ref = { a, e: a.rhs };
        const r = readsSig(m, a.rhs, sig);
        if (r) { push({ kind: 'assign', role: 'data', src: a.src, targets: lvalNames(m, a.lhs, []) }, a.loc, r); }
        const ir = lvalIndexReads(m, a.lhs, sig);
        ref = { a, e: null };
        if (ir) { push({ kind: 'assign', role: 'index', src: a.src, targets: lvalNames(m, a.lhs, []) }, a.loc, ir); }
      }
      for (const [name, info] of Object.entries(m.signals)) {
        const r = info.init ? readsSig(m, info.init, sig) : '';
        ref = { init: name, e: info.init };
        if (r) { push({ kind: info.kind === 'net' ? 'assign' : 'initializer', role: 'data', src: `${name} = ${exprText(info.init)}`, targets: [absOf(m.path, name)] }, info.init.loc || info.loc, r); }
      }
      for (const p of m.procs) {
        const proc = { procKind: p.kind, procLoc: locOf(m, p.loc) };
        for (const ev of p.events || []) {
          ref = { p, ev, e: ev.expr };
          const r = ev.expr ? readsSig(m, ev.expr, sig) : '';
          if (r) { push(Object.assign({ kind: 'event', role: 'sensitivity', src: (EDGE_WORD[ev.edge] || '') + exprText(ev.expr), targets: [...writtenBy(m, p.body, new Set())] }, proc), p.loc, r); }
        }
        const visit = (st) => {
          if (!st) { return; }
          switch (st.k) {
            case 'seq': st.s.forEach(visit); return;
            case 'timed': visit(st.stmt); return;
            case 'decl': {
              ref = { p, st, e: st.init };
              const r = readsSig(m, st.init, sig);
              if (r) { push(Object.assign({ kind: 'stmt', role: 'data', src: `${st.name.replace(/^\$local:/, '')} = ${exprText(st.init)}`, targets: [st.name] }, proc), st.loc, r); }
              return;
            }
            case 'asgn': {
              ref = { p, st, e: st.rhs };
              const r = readsSig(m, st.rhs, sig);
              if (r) { push(Object.assign({ kind: 'stmt', role: 'data', src: st.src, targets: lvalNames(m, st.lhs, []) }, proc), st.loc, r); }
              const ir = lvalIndexReads(m, st.lhs, sig);
              if (ir) { push(Object.assign({ kind: 'stmt', role: 'index', src: st.src, targets: lvalNames(m, st.lhs, []) }, proc), st.loc, ir); }
              return;
            }
            case 'if': {
              ref = { p, st, e: st.c };
              const r = readsSig(m, st.c, sig);
              if (r) {
                const t = new Set(); writtenBy(m, st.t, t); writtenBy(m, st.f, t);
                push(Object.assign({ kind: 'stmt', role: 'condition', src: `if (${exprText(st.c)})`, targets: [...t] }, proc), st.c.loc, r);
              }
              visit(st.t); visit(st.f);
              return;
            }
            case 'case': {
              const t = writtenBy(m, st, new Set());
              const conds = [st.e].concat(...st.items.map((it) => it.m));
              for (const e of conds) {
                ref = { p, st, e };
                const r = readsSig(m, e, sig);
                if (r) { push(Object.assign({ kind: 'stmt', role: 'condition', src: e === st.e ? `case (${exprText(e)})` : exprText(e), targets: [...t] }, proc), e.loc, r); }
              }
              st.items.forEach((it) => visit(it.s)); visit(st.dflt);
              return;
            }
            case 'opaque': {
              // slang left it unelaborated (a loop, a call...): its reads are unknown. Named in its
              // text, the signal may be read there: listed as maybe (role 'opaque').
              limits.opaque++;
              ref = { p, st, e: null };
              // (slang's text can carry the trivia before it, on one line: a one-line statement's
              // text is its last endCol - startCol characters)
              let text = String(st.src || '');
              const one = Array.isArray(st.loc) && st.loc[1] === st.loc[3] && st.loc[4] > st.loc[2];
              if (one && !text.includes('\n') && text.length > st.loc[4] - st.loc[2]) { text = text.slice(-(st.loc[4] - st.loc[2])); }
              if (namedIn(m, text, sig)) {
                const t = new Set(); writtenBy(m, st, t);
                // (a text starting with comment lines: the place is its first code line)
                const trivia = (text.match(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/) || [''])[0];
                const lead = trivia.split('\n').length - 1;
                const src = text.slice(trivia.length);
                const l = lead && Array.isArray(st.loc) ? [st.loc[0], st.loc[1] + lead, 1].concat(st.loc.slice(3)) : st.loc;
                push(Object.assign({ kind: 'stmt', role: 'opaque', src, targets: [...t] }, proc), l, 'maybe');
              }
              return;
            }
            default:
          }
        };
        visit(p.body);
      }
      for (const child of m.children) {
        for (const port of child.ports) {
          if (port.dir !== 'In' && port.dir !== 'InOut') { continue; }
          const r = readsSig(m, port.conn, sig);
          ref = { child, port, e: port.conn };
          if (r) { push({ kind: 'portIn', role: 'connection', src: `.${port.name}(${connText(port.conn) || port.name})`, port: port.name, targets: [child.path + '.' + port.internal] }, port.loc, r); }
        }
      }
    }
    const locKey = (e) => [e.instance, e.loc ? e.loc.file || '' : '', e.loc ? e.loc.line : 0, e.loc ? e.loc.col : 0];
    function byPlace(x, y) {
      const a = locKey(x), b = locKey(y);
      for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) { return -1; } if (a[i] > b[i]) { return 1; } }
      return 0;
    }
    // Load trace: the static readers of the signal at `path` (design path), in instance path then
    // source order, one page at a time ({ offset, limit }, limit at most 512, 64 by default).
    // { signal, total, entries, next (the next page's offset, or null), limits }. An entry: { kind
    // ('assign' | 'initializer' | 'stmt' | 'event' | 'portIn' | 'portOut' | 'modport'), role ('data' |
    // 'condition' | 'index' | 'sensitivity' | 'connection' | 'opaque'), instance, src, loc, targets
    // (the paths it writes: the next hop; block locals as `$local:` names), procKind?, procLoc?,
    // port?, maybe? (it reads the whole array the signal is an element of, or names it in a
    // statement slang could not elaborate), via? ('interface': a read through an interface port) }.
    // Not seen: reads from other instances through hierarchical references (limits.hierarchical;
    // an interface's are walked: limits.interfaceWalk), and what statements slang could not
    // elaborate read without naming the signal (limits.opaque counts them).
    async function loads(path, opts) {
      const all = await collectLoads(path);
      if (all.error) { return all; }
      const { entries, total, next } = pageOf(all.entries, opts);
      return { signal: path, total, instances: all.instances, entries, next, limits: all.limits };
    }
    function pageOf(list, opts) {
      const o = opts || {};
      const limit = Math.max(1, Math.min(512, Number(o.limit) || 64));
      const offset = Math.max(0, Number(o.offset) || 0);
      return { total: list.length, entries: list.slice(offset, offset + limit), next: offset + limit < list.length ? offset + limit : null };
    }
    // An interface's signal: each modport taking it as an input (kind 'modport', a connection),
    // and its reads (`via: 'interface'`) in the interface's parent and in the instances its interface
    // ports are bound to (the model's `connections`, at any depth: its real fanout), up to
    // INTERFACE_WALK instances (limits.interfaceWalk: { instances, of, capped }). A model without
    // `connections` (an older sidecar): the parent and every instance under it, breadth first.
    const INTERFACE_WALK = 512;
    async function interfaceLoads(m, path, base, out, limits) {
      for (const mp of m.modports || []) {
        for (const pt of mp.ports || []) {
          if ((pt.internal || pt.name) !== base || !['In', 'InOut', 'Ref'].includes(pt.dir)) { continue; }
          const e = { kind: 'modport', role: 'connection', instance: m.path, src: `modport ${mp.name} (${pt.dir === 'In' ? 'input' : pt.dir === 'Ref' ? 'ref' : 'inout'} ${pt.name})`,
            port: mp.name + '.' + pt.name, loc: locOf(m, pt.loc || mp.loc), targets: [m.path + '.' + mp.name + '.' + pt.name] };
          loadRefs.set(e, { m, modport: mp });
          out.push(e);
        }
      }
      if (!m.parent) { return; }
      // (the parent too: it can read the interface instance's members itself)
      const visit = (x) => {
        const found = [];
        loadsIn(x, path, found, limits);
        found.forEach((e) => { e.via = 'interface'; out.push(e); });
      };
      if (Array.isArray(m.connections)) {
        const paths = [...new Set([m.parent].concat(m.connections.map((c) => c.instance)))].filter((p) => p && p !== m.path);
        let walked = 0;
        for (const p of paths) {
          if (walked >= INTERFACE_WALK) { limits.interfaceWalk = { instances: walked, of: paths.length, capped: true }; return; }
          const x = await model(p);
          if (!x) { continue; }
          walked++;
          visit(x);
        }
        limits.interfaceWalk = { instances: walked, of: paths.length, capped: false };
        return;
      }
      const pm = await model(m.parent);
      const todo = pm ? [pm] : [];
      let seen = 0;
      while (todo.length) {
        const x = todo.shift();
        if (++seen > INTERFACE_WALK) { limits.interfaceWalk = { instances: INTERFACE_WALK, capped: true }; return; }
        visit(x);
        for (const c of x.children || []) {
          if (c.path === m.path) { continue; }
          const cm = await model(c.path);
          if (cm) { todo.push(cm); }
        }
      }
      limits.interfaceWalk = { instances: seen, capped: false };
    }
    async function collectLoads(path) {
      const where = await models.lookup(path);
      if (!where || !where.instance) { return { signal: path, error: 'notInDesign' }; }
      const m = await model(where.instance);
      if (!m) { return { signal: path, error: 'notInDesign' }; }
      const name = where.name;
      const out = [];
      const limits = { opaque: 0, hierarchical: true };
      loadsIn(m, path, out, limits);
      // An output port: the parent's signals connected to it (where its value goes next).
      const s = signalOf(m, name);
      const base = s && s.element ? s.element.array : name;
      if (m.parent) {
        const outs = m.ports.filter((pt) => (pt.dir === 'Out' || pt.dir === 'InOut') && pt.internal === base);
        if (outs.length) {
          const pm = await model(m.parent);
          const me = pm && pm.children.find((c) => c.path === m.path);
          for (const pt of outs) {
            const cp = me && me.ports.find((q) => q.name === pt.name);
            if (!cp) { continue; }
            const targets = cp.connLval ? lvalNames(pm, cp.connLval, []) : [...leafPaths(pm, cp.conn, new Set())];
            const pe = { kind: 'portOut', role: 'connection', instance: pm.path, src: `.${cp.name}(${connText(cp.conn) || cp.name})`, port: cp.name, loc: locOf(pm, cp.loc), targets, maybe: s && s.element ? true : undefined };
            loadRefs.set(pe, { m: pm, out: true });
            out.push(pe);
          }
        }
      }
      if (m.interface) { await interfaceLoads(m, path, base, out, limits); }
      out.sort(byPlace);
      return { entries: out, limits, instances: new Set(out.map((e) => e.instance)).size };
    }

    // Load trace at a time: loads' page, each entry with `active`, judged at the reader's last
    // activation at or before t (the dump is searched backward, as driver tracing does): { status,
    // time (the activation), trust, reasons, taken? (a condition's branch), follow? ({ path, time }:
    // the change the read caused, where following the entry goes) }. Status: 'propagated' (the
    // target changed with this read), 'noChange', 'notRun' (the statement was not on the path),
    // 'read' (into a block local or an index: nothing dumped to follow), 'taken' / 'untaken' (a
    // condition), 'triggered' / 'notTriggered' (a sensitivity), 'pending' (an edge procedure whose
    // last edge came before the signal's change: it is sampled at a later one), 'stimulus' (a
    // testbench process), 'start' (an initializer), 'notEvaluated' (budget, or a construct not
    // re-executed). opts: as loads, plus budgetMs (per entry, 2000).
    async function loadsAt(path, time, opts) {
      const all = await collectLoads(path);
      if (all.error) { return all; }
      const t = Number(time);
      const page = pageOf(all.entries, opts);
      const since = await dump.lastChange(path, t);
      const budget = Math.max(1, Number((opts || {}).budgetMs) || 2000);
      const entries = [];
      for (const e of page.entries) {
        const out = Object.assign({}, e);
        // The budget needs a timer (a page has one; a bare JS context may not: no budget there).
        let h = null;
        const timer = typeof setTimeout === 'function'
          ? new Promise((resolve) => { h = setTimeout(() => resolve({ status: 'notEvaluated', reasons: [{ code: 'budget' }] }), budget); })
          : null;
        try {
          out.active = await (timer ? Promise.race([activeLoad(e, path, t, since), timer]) : activeLoad(e, path, t, since));
          if (h !== null && typeof clearTimeout === 'function') { clearTimeout(h); }
        } catch (error) {
          out.active = { status: 'notEvaluated', reasons: [{ code: 'error', message: String(error && error.message || error) }] };
        }
        if (!out.active.trust) { out.active.trust = out.active.status === 'notEvaluated' ? 'approximate' : 'exact'; }
        if (e.maybe && out.active.trust === 'exact') { out.active.trust = 'approximate'; out.active.reasons = (out.active.reasons || []).concat([{ code: 'maybe' }]); }
        entries.push(out);
      }
      return { signal: path, time: t, since, total: page.total, instances: all.instances, entries, next: page.next, limits: all.limits };
    }
    // Whether target changed at exactly `at` (with the read), and the follow for it.
    async function changedAt(target, at) {
      if (!target || isLocal(target)) { return null; }
      const tc = await dump.lastChange(target, at);
      return tc === at ? { path: target, time: at } : false;
    }
    async function activeLoad(e, sigPath, t, since) {
      const ref = loadRefs.get(e) || {};
      const m = ref.m;
      const reasons = [];
      const target = (e.targets || [])[0];
      // Continuous: assigns, net declarations, port connections. The target changes with the signal.
      if (e.kind === 'assign' || e.kind === 'portIn' || e.kind === 'portOut') {
        if (since === null || since === undefined) { return { status: 'notEvaluated', reasons: [{ code: 'notDumped' }] }; }
        if (e.role === 'index') { return { status: 'read', time: since, reasons }; }
        const f = await changedAt(target, since);
        if (f === null) { return { status: 'read', time: since, reasons }; }
        return f ? { status: 'propagated', time: since, follow: f, reasons } : { status: 'noChange', time: since, reasons };
      }
      if (e.kind === 'modport') {
        if (since === null || since === undefined) { return { status: 'notEvaluated', reasons: [{ code: 'notDumped' }] }; }
        return { status: 'read', time: since, reasons };
      }
      if (e.kind === 'initializer') { return { status: 'start', time: 0, reasons }; }
      const p = ref.p;
      if (!p) { return { status: 'notEvaluated', reasons: [{ code: 'unknown' }] }; }
      if (isStimulus(p)) { return { status: 'stimulus', reasons }; }
      if (e.role === 'opaque') { return { status: 'notEvaluated', reasons: [{ code: 'opaque', what: e.src }], trust: 'approximate' }; }
      const edge = isEdgeProc(p);
      if (e.kind === 'event') {
        if (!edge || !ref.ev || !ref.ev.edge) { return { status: 'notEvaluated', reasons: [{ code: 'evaluator' }] }; }
        const te = await dump.prevEdge(sigPath, t, ref.ev.edge);
        return te !== null && te === since ? { status: 'triggered', time: te, reasons } : { status: 'notTriggered', time: te, reasons };
      }
      // A statement in a procedure: the run that sampled the signal's value in effect.
      let sample = t, extra = new Map(), at = t;
      if (edge) {
        const ck = clocking(m, p);
        if (!ck.clock) { return { status: 'notEvaluated', reasons: [{ code: 'noClock' }] }; }
        const te = await dump.prevEdge(ck.clock.path, t, ck.clock.edge);
        if (te === null) { return { status: 'pending', reasons: [{ code: 'noEdge' }] }; }
        sample = te > 0 ? te - 1 : 0;
        at = te;
        if (since !== null && since !== undefined && since > sample) { return { status: 'pending', time: te, reasons }; }
        const tv = await fetch([ck.clock.path], te);
        extra.set(ck.clock.path, tv.get(ck.clock.path));
      } else if (since !== null && since !== undefined) {
        at = since;
      }
      const ctx = await runProc(m, p, sample, extra, options.xprop === 'on' ? 'xprop' : 'optimistic');
      ctx.reasons.forEach((x) => reasons.push(x));
      const approx = reasons.some((r) => ['budget', 'statement', 'delay', 'opaque'].includes(r.code));
      const trust = approx ? 'approximate' : undefined;
      const st = ref.st;
      if (!ctx.ran.has(st)) { return { status: 'notRun', time: at, reasons, trust }; }
      if (e.role === 'condition') {
        const d = ctx.decisions.find((x) => x.stmt === st);
        if (!d) { return { status: 'notEvaluated', time: at, reasons, trust: 'approximate' }; }
        const out = { time: at, reasons, trust, taken: d.taken };
        if (st.k === 'if') { out.status = d.taken === 'then' ? 'taken' : d.taken === 'else' ? 'untaken' : 'merged'; }
        else {
          // A case item reading the signal: taken when its item matched; the selector: taken.
          const item = st.items.findIndex((it) => it.m.includes(ref.e));
          out.status = item < 0 ? 'taken' : d.taken === item ? 'taken' : d.taken === 'merge' ? 'merged' : 'untaken';
        }
        if (out.status === 'merged') { out.trust = 'approximate'; }
        return out;
      }
      if (e.role === 'index') { return { status: 'read', time: at, reasons, trust }; }
      const f = await changedAt(target, at);
      if (f === null) { return { status: 'read', time: at, reasons, trust }; }
      if (!f) { return { status: 'noChange', time: at, reasons, trust }; }
      // The run's write explains the target's new value: exact.
      const w = await models.lookup(target);
      const tm = w && w.instance === m.path ? m : null;
      const tsig = tm ? signalOf(tm, w.name) : null;
      let consistent;
      if (tsig) {
        const now = (await fetch([target], at)).get(target);
        const pick = pickWrite(ctx, target, tsig, now);
        consistent = pick ? consistentWith(pick, now, tsig) : undefined;
      }
      return { status: 'propagated', time: at, follow: f, reasons, trust: consistent === false ? 'inconsistent' : consistent === true && !approx ? 'exact' : 'approximate' };
    }

    // Follow forward: where a load entry's target goes next, its first change at or after t
    // ({ path, time | null, direction: 'forward' }), when the dump can search forward; null when it
    // can't or the entry has no dumped target (the caller keeps the entry's backward follow).
    async function nextOf(e, t) {
      if (!e || e.kind === 'modport' || typeof dump.nextChange !== 'function') { return null; }
      const target = (e.targets || []).find((x) => x && !isLocal(x));
      if (!target) { return null; }
      const at = await dump.nextChange(target, t);
      return { path: target, time: at === null || at === undefined ? null : Number(at), direction: 'forward' };
    }
    // Where the x run in effect at `time` began: the change since which the signal has had x or z
    // bits all along (the one before it had none), from the dump; time 0 when it has had them since
    // the start. { time, complete }: complete false when options.xRunChanges changes were walked
    // without getting there (time: the earliest reached). null: no x or z at `time`, or not dumped.
    // The dump's own xStart answers when it can (one search instead of a walk).
    // A z bit counts as x (the dump's derived x-run signal reads z as x too).
    const dumpStartOf = () => { const v = Number(typeof dump.start === 'function' ? dump.start() : dump.start); return Number.isFinite(v) && v > 0 ? v : 0; };
    async function xStart(path, time) {
      const r = await xStartRaw(path, time);
      // x from a dump that starts late: there when the dump starts, not since time 0.
      const s0 = dumpStartOf();
      if (r && s0 > 0 && Number(r.time) <= s0 && r.complete !== false) { return { time: s0, complete: true, dumpStart: true }; }
      return r;
    }
    // Where the run of the exact x/z bits in effect at `time` began, not before `floor` (the x run's
    // start): back over the changes while the x and z bits stay where they are (other bits may
    // change). { time, complete } (complete false: xRunChanges walked first); null: not dumped.
    async function xMaskStart(path, time, floor) {
      const low = Number.isFinite(Number(floor)) ? Number(floor) : 0;
      const max = Number(options.xRunChanges) >= 1 ? Math.floor(Number(options.xRunChanges)) : X_RUN_CHANGES;
      const valueAt = async (t) => (await dump.values([path], t)).get(path);
      const now = await valueAt(time);
      if (now === undefined) { return null; }
      const mask = xMask(now);
      let at = await dump.lastChange(path, time);
      for (let n = 0; ; n++) {
        if (at === null || at === undefined) { return null; }
        at = Number(at);
        if (at <= low) { return { time: low, complete: true }; }
        const before = await valueAt(at - 1);
        if (before === undefined) { return null; }
        if (xMask(before, String(now).length) !== mask) { return { time: at, complete: true }; }
        if (n + 1 >= max) { return { time: at, complete: false }; }
        at = await dump.lastChange(path, at - 1);
      }
    }
    // Which input brought the x bits a signal has at `time` (a change of its x bits inside a held
    // run): its statement again with the other inputs' x and z bits forced to 0, then to 1 (a copy
    // of this engine over a dump that answers them so). Bits still x both ways: the signal's own
    // x, held ({ cause: 'self' }); one gone: a new x came in from those inputs ({ cause: 'new',
    // sources }). An input that is combinational (an assign, an always_comb, a port) and whose
    // own x is the signal's (sg2 <= nx2, nx2 = f(sg2)) counts as the signal's, to 3 levels.
    // null: not known (no prediction, or the prediction has no x where the dump has).
    let forced = null, forcing = null, forceQueue = Promise.resolve();
    function forcedEngine() {
      if (forced) { return forced; }
      const fdump = Object.assign({}, dump, {
        async values(paths, t) {
          const got = await dump.values(paths, t);
          const out = new Map(got);
          if (forcing) {
            for (const p of paths) {
              const v = out.get(p);
              if (!forcing.paths.has(p) || typeof v !== 'string') { continue; }
              // (the target's own value in effect is the dump's: only what it read is forced)
              if (p === forcing.target && Number(t) >= forcing.time) { continue; }
              // (only: some of its bits, by index in its value at its width)
              const only = forcing.only && forcing.only.get(p);
              if (!only) { out.set(p, v.replace(/[xz]/gi, forcing.bit)); continue; }
              const W = Number(forcing.width) || v.length;
              const full = v.length < W ? (/[xz]/i.test(v[0]) ? v[0] : '0').repeat(W - v.length) + v : v;
              out.set(p, Array.from(full, (ch, i) => (only.has(i) && /[xz]/i.test(ch) ? forcing.bit : ch)).join(''));
            }
          }
          return out;
        },
      });
      delete fdump.xStart;
      forced = createEngine(Object.assign({}, config, { dump: fdump, options: Object.assign({}, options, { sampleOnly: true,
        pinActivation: (p, t) => (forcing && forcing.activation !== undefined && p === forcing.target && Number(t) === forcing.time ? forcing.activation : null),
        // (its rewrite memo keyed by the forcing too: the target's run is pinned, but any other
        // run that walks sees the forced values, so no result is shared across forcings)
        rewriteKey: () => (forcing ? JSON.stringify([[...forcing.paths], forcing.bit, forcing.target, forcing.time, forcing.activation, forcing.width,
          forcing.only ? [...forcing.only].map(([k, v]) => [k, [...v]]) : null]) : '') }) }));
      return forced;
    }
    function forcedPredicted(path, time, paths, bit, only, width, activation) {
      const run = forceQueue.then(async () => {
        forcing = { paths: new Set(paths), bit, only: only || null, width: width || 0, target: path, time: Number(time), activation };
        try {
          const st = await forcedEngine().active(path, time);
          return st && !st.error && typeof st.predicted === 'string' ? st.predicted : null;
        } finally { forcing = null; }
      });
      forceQueue = run.catch(() => {});
      return run;
    }
    const keepsX = (base, got) => {
      const w = Math.max(String(base).length, String(got).length);
      const a = xMask(base, w), b = xMask(got, w);
      for (let i = 0; i < w; i++) { if (a[i] !== '.' && b[i] === '.') { return false; } }
      return true;
    };
    // xCause(path, time, care): whose are the x bits `care` (an x mask at the signal's width: the
    // bits still x at the traced time; default all) at a point of a held run. 'self' only when it
    // is proven: forcing the held signal's own x bits (to 0, and to 1) removes them and forcing
    // the other inputs' does not; then { care } is its own bits that carry them, for the point
    // before. 'new': forcing the other inputs' removes some and forcing its own does not, so they
    // came in here. null, not known: an inexact step, an x input that can't be forced (undumped, a
    // temp, a local), an x the statement makes itself (a literal), a bit both make, or an
    // activation that is not at this point.
    async function xCause(path, time, care) { return causeOf(path, Number(time), path, 0, care); }
    async function causeOf(path, time, self, depth, care) {
      const st = await active(path, time);
      if (!st || st.error || !xBits(st.value) || st.trust !== 'exact') { return null; }
      if (depth === 0 && st.activation && Number(st.activation.time) !== time) { return null; }
      // (a step the post-edge values explain: the forced re-runs ask the sample; not comparable)
      if ((st.reasons || []).some((r) => r.code === 'race')) { return null; }
      const base = st.predicted;
      if (typeof base !== 'string' || !keepsX(st.value, base)) { return null; }
      const act = st.activation ? Number(st.activation.time) : undefined;
      const w = String(st.value).length;
      const vm = xMask(st.value, w);
      const cm = care ? xMask(care, w) : vm;
      const careIdx = [];
      for (let i = 0; i < w; i++) { if (cm[i] !== '.' && vm[i] !== '.') { careIdx.push(i); } }
      if (!careIdx.length) { return null; }
      const fan = (st.fanin || []).filter((f) => f.role !== 'clock' && xBits(f.value));
      if (fan.some((f) => typeof f.path !== 'string' || !f.path || f.dumped === false || f.blocking || f.local)) { return null; }
      const selfs = [], others = [];
      for (const f of fan) {
        if (f.path === self) { if (!selfs.includes(f.path)) { selfs.push(f.path); } continue; }
        if (depth < 3) {
          const fs = await active(f.path, Number(f.time));
          const d = (fs && fs.driver) || {};
          const comb = d.kind === 'assign' || d.procKind === 'AlwaysComb' || d.kind === 'portIn' || d.kind === 'portOut';
          if (comb) {
            const k = await causeOf(f.path, Number(f.time), self, depth + 1, null);
            // (not known, and it reads the signal: whose its x is is not known either)
            if (!k && (fs.fanin || []).some((x) => x.path === self)) { return null; }
            if (k && k.cause === 'self') { if (!selfs.includes(f.path)) { selfs.push(f.path); } continue; }
          }
        }
        if (!others.includes(f.path)) { others.push(f.path); }
      }
      // Each bit: no longer x with these inputs' x bits forced to 0, and to 1.
      const gone = async (paths, only) => {
        const out = new Array(w).fill(paths.length > 0);
        if (!paths.length) { return out; }
        for (const bit of ['0', '1']) {
          const got = await forcedPredicted(path, time, paths, bit, only, w, act);
          if (got === null) { return null; }
          const gm = xMask(got, w);
          for (let i = 0; i < w; i++) { if (gm[i] !== '.') { out[i] = false; } }
        }
        return out;
      };
      const bySelf = await gone(selfs);
      const byOthers = await gone(others);
      if (!bySelf || !byOthers) { return null; }
      let fresh = false, own = true;
      for (const i of careIdx) {
        if (byOthers[i] && !bySelf[i]) { fresh = true; } else if (!(bySelf[i] && !byOthers[i])) { own = false; }
      }
      if (fresh) { return { cause: 'new', sources: others }; }
      if (!own) { return null; }
      if (depth > 0) { return { cause: 'self', sources: [] }; }
      // Its own bits that carry them: each x bit of its own read, forced alone, that removes one;
      // together they must remove them all. Read only through a combinational next value (no
      // direct read of itself), or not covered: all of its x bits (imprecise: a 'new' found from
      // there on is not known).
      const read = (st.fanin || []).find((f) => f.path === self && f.role !== 'clock' && xBits(f.value));
      const all = { cause: 'self', sources: [], care: null, imprecise: true };
      if (!read || selfs.length !== 1 || String(read.value).length > w) { return all; }
      const rm = xMask(read.value, w), carried = [];
      const ownX = [];
      for (let j = 0; j < w; j++) { if (rm[j] !== '.') { ownX.push(j); } }
      const careMask = (bits) => Array.from({ length: w }, (_, j) => (bits.includes(j) ? 'x' : '.')).join('');
      // (one x bit of its own: forcing it is forcing all of them, already asked)
      if (ownX.length === 1) { return { cause: 'self', sources: [], care: careMask(ownX), imprecise: false }; }
      for (const j of ownX) {
        // (either value removing one counts: a bit an AND or OR lets through only one way)
        for (const bit of ['0', '1']) {
          const got = await forcedPredicted(path, time, [self], bit, new Map([[self, new Set([j])]]), w, act);
          if (got === null) { return null; }
          const gm = xMask(got, w);
          if (careIdx.some((i) => gm[i] === '.')) { carried.push(j); break; }
        }
      }
      if (!carried.length) { return all; }
      // (all of its own x bits carry them: forcing those is forcing all, already asked)
      if (carried.length < ownX.length) {
        const whole = await gone([self], new Map([[self, new Set(carried)]]));
        if (!whole) { return null; }
        if (!careIdx.every((i) => whole[i])) { return all; }
      }
      return { cause: 'self', sources: [], care: careMask(carried), imprecise: false };
    }
    // xLink(path, time, input, care): is the step's x in bits `care` (an x mask; default all) the
    // input's? { ok: true } when the step is exact, its write covers them, and forcing the input's
    // x bits to 0, and to 1, removes every one of them (the statement re-run with its value). null,
    // not known: an inexact or racing step, an input that is not its x fan-in or can't be forced.
    async function xLink(path, time, input, care) {
      const st = await active(path, Number(time));
      if (!st || st.error || !xBits(st.value) || st.trust !== 'exact') { return null; }
      if ((st.reasons || []).some((r) => r.code === 'race')) { return null; }
      if (typeof st.predicted !== 'string' || !keepsX(st.value, st.predicted)) { return null; }
      const w = String(st.value).length;
      const vm = xMask(st.value, w), cm = care ? xMask(care, w) : vm;
      const lsb = Number(st.bits && st.bits.lsb) || 0;
      const bw = st.bits && Number(st.bits.width) > 0 ? Number(st.bits.width) : w;
      const careIdx = [];
      for (let i = 0; i < w; i++) {
        if (cm[i] === '.' || vm[i] === '.') { continue; }
        const b = w - 1 - i;
        if (b < lsb || b >= lsb + bw) { return null; }
        careIdx.push(i);
      }
      if (!careIdx.length) { return null; }
      const f = (st.fanin || []).find((x) => x.path === input && x.role !== 'clock' && xBits(x.value));
      if (!f || f.dumped === false || f.blocking || f.local) { return null; }
      const act = st.activation ? Number(st.activation.time) : undefined;
      for (const bit of ['0', '1']) {
        const got = await forcedPredicted(path, Number(time), [input], bit, null, w, act);
        if (got === null) { return null; }
        const gm = xMask(got, w);
        if (careIdx.some((i) => gm[i] !== '.')) { return null; }
      }
      return { ok: true };
    }
    // The activations inside a held run (from, time] where an input of its procedure other than the
    // signal had x (an x can replace the held one there with no change in the dump): their edge
    // times, latest first ({ edges }). null, not known: no single edge procedure, an input not
    // dumped or not checkable (an array element), or past `cap` changes walked.
    async function xInputEdges(path, time, from, cap) {
      const max = Number(cap) >= 1 ? Math.floor(Number(cap)) : X_RUN_CHANGES;
      const t = Number(time), lo = Number(from);
      const w = await models.lookup(path);
      if (!w) { return null; }
      const m = await model(w.instance);
      if (!m) { return null; }
      const ds = driversOf(m, w.name);
      if (ds.length !== 1) { return null; }
      const valueAt = async (q, at) => (await dump.values([q], at)).get(q);
      const edges = new Set();
      let n = 0;
      // (an input's x bits did not change inside and it has none at the end: never x there)
      const clean = async (q) => {
        const now = await valueAt(q, t);
        if (now === undefined) { return undefined; }
        if (xBits(now) || typeof dump.maskChangeCount !== 'function') { return false; }
        return (await dump.maskChangeCount(q, lo, t)) === 0;
      };
      // A combinational driver (an assign, an always_comb): every change of another input with x.
      if (ds[0].type === 'assign' || (ds[0].type === 'proc' && !isEdgeProc(ds[0].p) && ds[0].p.kind === 'AlwaysComb')) {
        const e = ds[0].type === 'assign' ? ds[0].a.rhs : null;
        if (e && /"elems":\[\{/.test(JSON.stringify(e))) { return null; }
        if (!e && (unknownWrites(ds[0].p.body) || /"elems":\[\{/.test(JSON.stringify(ds[0].p.body)))) { return null; }
        const reads = e ? leafPaths(m, e, new Set()) : procReads(m, ds[0].p, new Set());
        for (const q of [...reads].filter((x) => x !== path)) {
          const k = await clean(q);
          if (k === undefined) { return null; }
          if (k) { continue; }
          for (let u = t; ;) {
            if (++n > max) { return null; }
            const lc = await dump.lastChange(q, u);
            if (lc === null || lc === undefined) { return null; }
            if (Number(lc) <= lo) { break; }
            if (xBits(await valueAt(q, Number(lc)))) { edges.add(Number(lc)); }
            u = Number(lc) - 1;
          }
        }
        return { edges: [...edges].sort((a, b) => b - a) };
      }
      if (ds[0].type !== 'proc' || !isEdgeProc(ds[0].p)) { return null; }
      const p = ds[0].p;
      if (unknownWrites(p.body) || /"elems":\[\{/.test(JSON.stringify(p.body))) { return null; }
      const ck = clocking(m, p);
      if (!ck.clock) { return null; }
      const written = new Set();
      const visit = (x) => {
        if (!x || typeof x !== 'object') { return; }
        if (x.k === 'asgn' && x.lhs && x.lhs.name && !isLocal(x.lhs.name)) { written.add(absOf(m.path, x.lhs.name)); }
        for (const k of ['s', 'stmt', 't', 'f', 'dflt']) { const v = x[k]; if (Array.isArray(v)) { v.forEach(visit); } else { visit(v); } }
        if (Array.isArray(x.items)) { x.items.forEach((it) => visit(it.s)); }
      };
      visit(p.body);
      const ins = [...procReads(m, p, new Set())].filter((q) => q !== path && q !== ck.clock.path && !written.has(q) && !ck.asyncs.some((a) => a.path === q));
      for (const q of ins) {
        const k = await clean(q);
        if (k === undefined) { return null; }
        if (k) { continue; }
        let u = t;
        for (;;) {
          if (++n > max) { return null; }
          const v = await valueAt(q, u);
          if (v === undefined) { return null; }
          if (xBits(v)) {
            const r = await xStart(q, u);
            if (!r || r.complete === false) { return null; }
            const s0 = Math.max(Number(r.time), lo);
            // an edge samples the value just before it: those with a sample in [s0, u]
            let te = await dump.prevEdge(ck.clock.path, Math.min(u + 1, t), ck.clock.edge);
            while (te !== null && te !== undefined && Number(te) - 1 >= s0 && Number(te) > lo) {
              edges.add(Number(te));
              if (++n > max) { return null; }
              te = await dump.prevEdge(ck.clock.path, Number(te) - 1, ck.clock.edge);
            }
            if (Number(r.time) <= lo) { break; }
            u = Number(r.time) - 1;
          } else {
            const lc = await dump.lastChange(q, u);
            if (lc === null || lc === undefined) { return null; }
            if (Number(lc) <= lo) { break; }
            u = Number(lc) - 1;
          }
        }
      }
      return { edges: [...edges].sort((a, b) => b - a) };
    }
    // How many times the signal changed in (from, to], and its x/z bits alone, from the dump
    // (one helper window each); undefined when the dump can't say.
    async function xChangeCount(path, from, to) { return typeof dump.changeCount === 'function' ? dump.changeCount(path, from, to) : undefined; }
    async function xMaskChangeCount(path, from, to) { return typeof dump.maskChangeCount === 'function' ? dump.maskChangeCount(path, from, to) : undefined; }
    async function xStartRaw(path, time) {
      if (typeof dump.xStart === 'function') {
        const r = await dump.xStart(path, time);
        if (r !== undefined) { return r; }
      }
      const max = Number(options.xRunChanges) >= 1 ? Math.floor(Number(options.xRunChanges)) : X_RUN_CHANGES;
      const valueAt = async (t) => (await dump.values([path], t)).get(path);
      if (!xBits(await valueAt(time))) { return null; }
      let at = await dump.lastChange(path, time);
      for (let n = 0; ; n++) {
        if (at === null || at === undefined) { return null; }
        at = Number(at);
        if (at <= 0) { return { time: 0, complete: true }; }
        const before = await valueAt(at - 1);
        if (before === undefined) { return null; }
        if (!xBits(before)) { return { time: at, complete: true }; }
        if (n + 1 >= max) { return { time: at, complete: false }; }
        at = await dump.lastChange(path, at - 1);
      }
    }
    return { active, model, loads, loadsAt, nextOf, xStart, xMaskStart, xCause, xLink, xInputEdges, xChangeCount, xMaskChangeCount, driversOf: async (path) => { const w = await models.lookup(path); const m = await model(w.instance); return driversOf(m, w.name).map((d) => driverSummary(m, d)); },
      // where the signal is declared ({ file, line, col, ... } 1-based), or null: the debugger's stop frame
      // when no statement drove the value.
      declOf: async (path) => {
        const w = await models.lookup(path);
        if (!w || !w.instance) { return null; }
        const m = await model(w.instance);
        const sg = signalOf(m, w.name);
        return sg && sg.loc ? locOf(m, sg.loc) : null;
      },
      // every source line that assigns the signal: an assign or port connection's line, a procedure's
      // writes of it (the procedure itself when none is found); for the driver highlight.
      assigningLines: async (path) => {
        const w = await models.lookup(path);
        if (!w || !w.instance) { return []; }
        const m = await model(w.instance);
        const sg = signalOf(m, w.name);
        const wname = sg && sg.element ? sg.element.array : w.name;
        return driversOf(m, w.name).map((d) => {
          const sum = driverSummary(m, d);
          if (d.type !== 'proc') { return sum; }
          const ws = writeStmts(d.p.body, wname, [], true).map((x) => ({ src: x.src, loc: locOf(m, x.loc) }));
          return Object.assign(sum, { writes: ws });
        });
      } };
  }

  // ---- Trace to Root ----
  // From a value with x or z bits, the fan-in that brought the x, step by step, to where it was
  // made. Each step follows the fan-in with x or z (data, condition or index; never the clock, a
  // blocking temporary (the engine's fan-in has already gone through it to what it read) or an
  // undumped signal) whose own x arrived earliest (the smallest `since`). It stops at:
  //   noXInput   no input has x: the statement makes it ('bx, a default, an x index...)
  //   uninit     never written since the start, or nothing but a declaration drives it
  //   testbench  the testbench's stimulus sets it          input   a top-level input
  //   force      a force or deposit from outside the instance
  //   loop       the x would go round to a signal already in the chain, at a time already on it
  //   budget     maxSteps steps (no root)                  failed  a step could not be traced
  //   cancelled  cancelled() said so (no root)
  //   made       (mode value) the statement makes the value from no input at all (a constant)
  //   dumpStart  the x was there when the dump starts (a dump starting late; no root)
  // On a start without x or z (mode 'value', Trace to Root of a clean value) the chain follows the
  // value itself back through the data inputs: one with the same bits first (why same; bit for bit,
  // else leading zeros aside for another width, never a 1-bit select), else as for x (only /
  // earliest; before 'earliest', the input the value's bits are wired from, why bits, and the inputs
  // that don't only select). A value with no data input (a reset's '0) follows its control inputs instead (why
  // control: an if's or case's condition, as the web does). A value already on the chain jumps to
  // its last change (held). out.mode: 'x' | 'value'.
  //
  //   xChain({ path, time }, { step(path, time) -> Promise<step>, probe?(path, time) -> Promise<step>,
  //            xStart?(path, time) -> Promise<{ time, complete } | null>,
  //            maskStart?(path, time, floor) -> Promise<{ time, complete } | null>,
  //            xCause?(path, time) -> Promise<{ cause, sources } | null>, maxCauses?, causeSteps?, causeHangMs?, shiftHangMs?,
  //            changeCount?(path, from, to), maskChangeCount?(path, from, to), now?() -> ms,
  //            onStep?(entry, index), cancelled?() -> bool, maxSteps?, maxProbes? })
  //     -> { steps: [{ step, signal, time, value, since, trust, why }], end: { code, signal? },
  //          root (index, -1 without one), approximate, mode }
  // `step` traces a step of the chain (the page confirms it with Verdi), `probe` a candidate
  // (default: step). `why` says why a step follows the one before: start, only (the only input
  // with x) or earliest (of `count` inputs with x); `limited` when more than maxProbes had x.
  // An input with x that is already on the chain (a register holding its x: q <= en ? d : q, a
  // signature rotating its x every cycle, or round through a next-value mux) is not walked back a
  // cycle at a time, nor taken for a loop: with xStart (the engine's), the chain jumps to where
  // that signal last became x, the step there with why held { since: that time } (`limited`:
  // xStart's walk stopped at its cap first, so the jump goes as far as it got and may jump again);
  // why xSince for a driver with no activation edge (combinational: x since then, not held). An
  // xStart that fails fails the chain; one with no x there drops that input. The jump is exact only
  // when the x/z bits are the same at both ends and (maskStart?(path, time, floor) -> the start of
  // the exact-mask run, the engine's xMaskStart) all the way; otherwise the entry is approximate,
  // why.bitsChanged { from, to } (the x moved between bits: the run may have taken in a new x).
  // With xCause?(path, time) -> { cause: 'self' | 'new', sources } | null (the engine's), each change
  // of the x bits inside the run (latest first, at most maxCauses, default 64) is asked where its x
  // came from: all the signal's own, the jump goes to the run's start, exact; a new x, the jump
  // stops at that change, exact, and the next step takes one of `sources` (why cause). Unknown or
  // too many: B's label above. Before any walk, changeCount (the run's changes) and, over maxCauses,
  // maskChangeCount (its x bits' changes) bound it: over maxCauses both, no walk (why.causeSkipped
  // 'changes'); the walk also stops past causeSteps calls (default 160: maxCauses changes fit;
  // why.causeSkipped 'budget'). Labels never depend on wall time: the only clock is a hang guard,
  // causeHangMs / shiftHangMs (default 10 s) on each call (a dump call that does not come back),
  // never on a walk's whole time, why.causeSkipped 'timeout' / why.timedOut.
  // x since the start is uninitialised; a jump to a signal at a time already on the chain, a loop.
  const X_CHAIN_STEPS = 30;
  const X_RUN_CHANGES = 256;
  // At most this many input changes are walked for a value written again with no change.
  const REWRITE_CHANGES = 64;
  const X_CHAIN_PROBES = 16;
  // Changes of a held x's bits whose cause is asked at most, per jump (then B's approximate label).
  const X_CAUSE_EVALS = 64;
  // The calls a held jump's cause walk may make (counts, mask starts, input edges, causes), then
  // B's label: deterministic (maxCauses changes fit), unlike a wall-time budget.
  const X_CAUSE_STEPS = 160;
  // A hang guard only (ms): past it, the walk (or a shift jump) stops, labelled as timed out.
  const X_HANG_MS = 10000;
  // Stages a shift jump follows a bit along at most.
  const X_SHIFT_STAGES = 256;
  const xBits = (v) => v !== null && v !== undefined && /[xz]/i.test(String(v));
  // The x and z bits of a value ('.' for a 0 or 1), to `width` bits (a shorter value extends as
  // Verilog does: by its leading x or z, else by 0).
  const xMask = (v, width) => {
    const t = String(v).toLowerCase();
    const w = Math.max(Number(width) || 0, t.length);
    const lead = t[0] === 'x' || t[0] === 'z' ? t[0] : '.';
    return (lead.repeat(w - t.length) + t).replace(/[^xz]/g, '.');
  };
  // The same bits (leading zeros aside: a port or a part of another width).
  const sameBits = (a, b) => String(a).toLowerCase().replace(/^0+(?=.)/, '') === String(b).toLowerCase().replace(/^0+(?=.)/, '');
  function xStop(st) {
    const reasons = st.reasons || [];
    const kind = st.driver ? st.driver.kind : 'none';
    if (reasons.some((r) => r.code === 'force')) { return 'force'; }
    if (st.root === 'testbench') { return 'testbench'; }
    if (kind === 'topInput') { return 'input'; }
    if (kind === 'none' || kind === 'undriven' || kind === 'initializer') { return 'uninit'; }
    if (Number(st.since) === 0 && reasons.some((r) => r.code === 'noWrite' || r.code === 'initialValue')) { return 'uninit'; }
    return null;
  }
  async function xChain(start, config) {
    const c = config || {};
    const step = c.step, probe = c.probe || c.step;
    const cancelled = c.cancelled || (() => false);
    const maxSteps = Number(c.maxSteps) >= 1 ? Math.floor(Number(c.maxSteps)) : X_CHAIN_STEPS;
    const maxProbes = Number(c.maxProbes) >= 1 ? Math.floor(Number(c.maxProbes)) : X_CHAIN_PROBES;
    const out = { steps: [], end: null, root: -1, approximate: false, mode: null };
    const finish = (code, extra) => {
      out.end = Object.assign({ code }, extra || {});
      if (!['budget', 'failed', 'cancelled', 'noX', 'dumpStart'].includes(code) && out.steps.length) { out.root = out.steps.length - 1; }
      out.approximate = out.steps.some((e) => e.trust === 'approximate' || e.trust === 'inconsistent');
      return out;
    };
    const CANCELLED = {};
    async function shiftJump(from, f) {
      const v = String(from.value).toLowerCase(), lsb = Number(from.bits && from.bits.lsb) || 0;
      const one = f.wires.find(([k]) => v[v.length - 1 - (lsb + k)] === '1');
      if (!one) { return null; }
      const bitAt = (x, i) => { const y = String(x).toLowerCase(); return y[y.length - 1 - i]; };
      // (the bit followed, of the value it was traced from; its read is a copy of it)
      const bit = lsb + one[0];
      let q = one[1], t = Number(f.time), stages = 1, hops = 0, exact = from.trust === 'exact' && bitAt(f.value, q) === '1';
      // (the hang guard is per step: a step that does not come back in shiftHangMs, never the whole
      // jump's time, so a slow dump alone never changes the label)
      let last = null;
      const writeOf = async (st) => {
        let at = null;
        try { at = await step(f.path, Number(st.since)); } catch (error) { at = null; }
        return at && !at.error && at.value === st.value ? at : st;
      };
      for (;;) {
        let st = null, hung = false;
        try { const g = await guarded(() => step(f.path, t), shiftHangMs); hung = g.late; st = g.v === LATE ? last : g.v; } catch (error) { st = null; }
        if (cancelled()) { return CANCELLED; }
        if (!st || st.error || st.since === null || st.since === undefined) { return null; }
        last = st;
        if (st.trust !== 'exact' || bitAt(st.value, q) !== '1') { exact = false; }
        const sl = Number(st.bits && st.bits.lsb) || 0;
        const sw = st.bits && Number(st.bits.width) > 0 ? Number(st.bits.width) : String(st.value).length;
        if (++hops > shiftStages * 2 || hung) {
          const at = hung ? st : await writeOf(st);
          if (cancelled()) { return CANCELLED; }
          return { st: at, stages, exact: false, limited: true, timedOut: hung, bit, track: [q] };
        }
        // A write of other bits (a part write): the bit was held there; the write before it.
        if (q < sl || q >= sl + sw) {
          if (!(Number(st.since) > 0)) { return null; }
          t = Number(st.since) - 1;
          continue;
        }
        const e = (st.fanin || []).find((x) => x.role === 'data' && Array.isArray(x.wires) && x.wires.some(([k]) => k + sl === q));
        if (!e || e.path !== f.path) {
          const at = await writeOf(st);
          if (cancelled()) { return CANCELLED; }
          return { st: at, stages, exact, entry: e ? e.path : null, bit, track: [q] };
        }
        if (stages >= shiftStages) {
          const at = await writeOf(st);
          if (cancelled()) { return CANCELLED; }
          return { st: at, stages, exact: false, limited: true, bit, track: [q] };
        }
        q = e.wires.find(([k]) => k + sl === q)[1];
        if (bitAt(e.value, q) !== '1') { exact = false; }
        t = Number(e.time);
        stages++;
      }
    }
    // The link from step `from` (its statement) to its fan-in entry `f`, for the bits `track` of
    // from's signal (bit 0 first): proven when (a) from is an exact step whose write covers them,
    // (b) f is wired to each (a name, a select, a concatenation, a conditional's taken arm), and
    // (c) f's bits there are theirs. An x through an operator: xLink (forcing f's x bits to 0, and
    // to 1, removes them). The bits of f traced next, or null.
    const bitAt = (x, i) => { const y = String(x).toLowerCase(); return y[y.length - 1 - i]; };
    const allBits = (v) => Array.from({ length: String(v).length }, (_, i) => i);
    const xBitsOf = (v) => allBits(v).filter((i) => /[xz]/.test(bitAt(v, i)));
    const xLinkOf = typeof c.xLink === 'function' ? c.xLink : null;
    async function linkOf(from, f, track) {
      if (!from || from.trust !== 'exact' || !f || !Array.isArray(track) || !track.length) { return null; }
      const lsb = Number(from.bits && from.bits.lsb) || 0;
      const width = from.bits && Number(from.bits.width) > 0 ? Number(from.bits.width) : String(from.value).length;
      if (track.some((b) => b < lsb || b >= lsb + width)) { return null; }
      const map = new Map((Array.isArray(f.wires) ? f.wires : []).map(([k, j]) => [k + lsb, j]));
      const next = [];
      let wired = true;
      for (const b of track) {
        const j = map.get(b), a = bitAt(from.value, b), d = j === undefined ? undefined : bitAt(f.value, j);
        if (j === undefined || a === undefined || d === undefined || !(a === d || (/[xz]/.test(a) && /[xz]/.test(d)))) { wired = false; break; }
        next.push(j);
      }
      if (wired) { return [...new Set(next)]; }
      if (valueModeOf(from) || !xLinkOf || typeof f.path !== 'string') { return null; }
      const w = String(from.value).length;
      const care = Array.from({ length: w }, (_, i) => (track.includes(w - 1 - i) ? 'x' : '.')).join('');
      let k = null;
      try { k = await xLinkOf(from.signal, Number(from.time), f.path, care); } catch (error) { k = null; }
      return k && k.ok ? xBitsOf(f.value) : null;
    }
    const valueModeOf = (st) => !xBits(st.value);
    // Exact is earned by the link from the step before (linkOf), never by the rule that chose the
    // step: an exact step whose link is not proven is approximate (and a held jump whose x bits
    // changed, or a shift that is not a copy all the way).
    const add = (st, why, earned) => {
      const proven = earned !== false && !(why && (why.bitsChanged || why.exact === false));
      const e = { step: st, signal: st.signal, time: st.time, value: st.value, since: st.since, trust: st.trust === 'exact' && !proven ? 'approximate' : st.trust, why };
      out.steps.push(e);
      if (c.onStep) { c.onStep(e, out.steps.length - 1); }
    };
    let cur;
    try { cur = await step(start.path, start.time); } catch (error) { cur = null; }
    if (cancelled()) { return finish('cancelled'); }
    if (!cur || cur.error) { if (cur) { add(cur, { code: 'start' }); } return finish('failed'); }
    add(cur, { code: 'start' });
    // The bits of cur the chain explains: all of a clean value's, an x value's x bits.
    let track = xBits(cur.value) ? xBitsOf(cur.value) : allBits(cur.value);
    // A value without x or z: its own chain (the value's origin), through the data inputs.
    const valueMode = !xBits(cur.value);
    out.mode = valueMode ? 'value' : 'x';
    const seen = new Set([cur.signal]);
    // Signal@time of each step: a held jump back to one of them is a loop.
    const visited = new Set([cur.signal + '@' + Number(cur.time)]);
    const xStartOf = typeof c.xStart === 'function' ? c.xStart : null;
    const maskStartOf = typeof c.maskStart === 'function' ? c.maskStart : null;
    const xCauseOf = typeof c.xCause === 'function' ? c.xCause : null;
    // (the activations where another input had x: points of the walk too, without a change)
    const xInputEdgesOf = typeof c.xInputEdges === 'function' ? c.xInputEdges : null;
    // A deadline around each call of the walk (a helper count or derive can take its own timeout):
    // the page's setTimeout, or an injected timer(ms) -> Promise; none: between calls only.
    const LATE = {};
    // One call under the hang guard: { v, late } (always this wrapper, never the call's own
    // result, so no step field can be mistaken for the marker). late: it did not come back within
    // ms (v is LATE), or came back after it. The page's timer is cleared when the call returns.
    const guarded = async (call, ms) => {
      const s0 = clock();
      const pr = call();
      let v;
      if (typeof c.timer === 'function') {
        v = await Promise.race([pr, c.timer(ms).then(() => LATE)]);
      } else if (typeof setTimeout === 'function') {
        let id = null;
        const fire = new Promise((r) => { id = setTimeout(() => r(LATE), ms); });
        try { v = await Promise.race([pr, fire]); } finally { if (typeof clearTimeout === 'function') { clearTimeout(id); } }
      } else {
        v = await pr;
      }
      return { v, late: v === LATE || clock() - s0 > ms };
    };
    const maxCauses = Number(c.maxCauses) >= 1 ? Math.floor(Number(c.maxCauses)) : X_CAUSE_EVALS;
    const num = (v, d) => (Number(v) >= 0 && v !== null && v !== undefined ? Number(v) : d);
    const causeSteps = num(c.causeSteps, X_CAUSE_STEPS);
    const causeHangMs = num(c.causeHangMs, X_HANG_MS);
    const changeCountOf = typeof c.changeCount === 'function' ? c.changeCount : null;
    const clock = typeof c.now === 'function' ? c.now : () => Date.now();
    const shiftStages = Number(c.shiftStages) >= 1 ? Math.floor(Number(c.shiftStages)) : X_SHIFT_STAGES;
    const shiftHangMs = num(c.shiftHangMs, X_HANG_MS);
    const maskChangeCountOf = typeof c.maskChangeCount === 'function' ? c.maskChangeCount : null;
    // The inputs a held jump found the new x came from: the next step follows one of them.
    let prefer = null;
    for (;;) {
      const stop = xStop(cur);
      if (stop) { return finish(stop); }
      if (out.steps.length >= maxSteps) { return finish('budget'); }
      const traceable = (cur.fanin || []).filter((f) => typeof f.path === 'string' && f.path && f.role !== 'clock' && f.dumped !== false && !f.blocking && !f.local);
      let cands, same = false, control = false, viaCause = false, byBits = false;
      if (valueMode) {
        // The data inputs; those with the value itself first (where it came from).
        const data = traceable.filter((f) => f.role === 'data' && typeof f.value === 'string' && !xBits(f.value));
        // (after a shift jump: the input the bit entered from)
        const entered = prefer ? data.filter((f) => prefer.has(f.path)) : [];
        prefer = null;
        // (bit for bit first; leading zeros aside only when no input has the same width)
        const exact = data.filter((f) => String(f.value).toLowerCase() === String(cur.value).toLowerCase());
        let alike = exact.length ? exact : data.filter((f) => String(f.value).length !== String(cur.value).length && String(f.value).length > 1 && sameBits(f.value, cur.value));
        // (the statement wires some inputs to the value, the taken arm of a conditional: of those
        // with the same value, only they; an arm not taken can have it too)
        if (data.some((f) => Array.isArray(f.wires) && f.wires.length)) { alike = alike.filter((f) => Array.isArray(f.wires) && f.wires.length); }
        same = alike.length > 0;
        cands = same ? alike : data;
        if (entered.length) { cands = entered; same = false; byBits = true; }
        else if (!same && data.length) {
          // No input has the value: the one its bits are wired from (a shift, a slice, a
          // concatenation, a conditional's taken arm), the most of its 1 bits first, then the most
          // bits that agree; else the inputs that don't only select (a conditional's condition).
          const v = String(cur.value).toLowerCase(), lsb = (cur.bits && Number(cur.bits.lsb)) || 0;
          const outBit = (k) => v[v.length - 1 - (lsb + k)];
          const scored = data.filter((f) => Array.isArray(f.wires) && f.wires.length).map((f) => {
            const fv = String(f.value).toLowerCase();
            let ones = 0, agree = 0;
            for (const [k, j] of f.wires) { const o = outBit(k), i = fv[fv.length - 1 - j]; if (o !== undefined && o === i) { agree++; if (o === '1') { ones++; } } }
            return { f, ones, agree };
          // (a value with 1 bits: an input wired only to its 0s isn't where it came from)
          }).filter((x) => x.agree > 0 && (x.ones > 0 || !v.includes('1')));
          scored.sort((a, b) => (b.ones - a.ones) || (b.agree - a.agree));
          if (scored.length) { cands = [scored[0].f]; byBits = true; }
          else {
            const plain = data.filter((f) => !f.select);
            if (plain.length) { cands = plain; }
            // The signal itself with another value (a counter's last count) is not where this
            // value came from when another input is there to follow.
            const others = cands.filter((f) => f.path !== cur.signal);
            if (others.length && others.length < cands.length) { cands = others; }
            // (itself alone, as pc <= pc + (c ? 2 : 4): what it counts by, the selects that aren't it)
            else if (!others.length && cands.length) {
              const selects = data.filter((f) => f.select && f.selectInOperand && f.path !== cur.signal);
              if (selects.length) { cands = selects; }
            }
          }
        }
        // No data input: the conditions that chose the statement (a reset), like the web.
        if (!traceable.some((f) => f.role === 'data')) {
          cands = traceable.filter((f) => f.role === 'control' && typeof f.value === 'string' && !xBits(f.value));
          control = cands.length > 0;
        }
      } else {
        cands = traceable.filter((f) => xBits(f.value));
        if (prefer) {
          const from = cands.filter((f) => prefer.has(f.path));
          if (from.length) { cands = from; viaCause = true; }
          prefer = null;
        }
      }
      // A value's bit wired from the signal itself (a shift register): along the stages that copy
      // it, to where it entered (from another input: the next step takes it) or was made (an
      // operator), in one step, why shifted { stages, since }; exact when every stage is an exact
      // step and a copy. Past shiftStages (or a step past the hang guard shiftHangMs: why.timedOut): as far as it
      // got, approximate (limited).
      if (valueMode && byBits && cands.length === 1 && cands[0].path === cur.signal && Array.isArray(cands[0].wires)) {
        const jump = await shiftJump(cur, cands[0]);
        if (jump === CANCELLED) { return finish('cancelled'); }
        if (jump) {
          const to = jump.st;
          if (visited.has(to.signal + '@' + Number(to.time))) { return finish('loop', { signal: to.signal }); }
          const why = { code: 'shifted', role: 'data', stages: jump.stages, since: Number(to.since), bit: jump.bit };
          if (!jump.exact) { why.exact = false; }
          if (jump.limited) { why.limited = true; }
          if (jump.timedOut) { why.timedOut = true; }
          seen.add(to.signal);
          visited.add(to.signal + '@' + Number(to.time));
          // (from here on, that bit alone: the jump followed it)
          const linked = await linkOf(cur, cands[0], [jump.bit]);
          add(to, why, !!linked);
          track = jump.track;
          prefer = jump.entry ? new Set([jump.entry]) : null;
          cur = to;
          continue;
        }
      }
      if (!cands.length) { return finish(valueMode ? 'made' : 'noXInput'); }
      const probed = [];
      for (const f of cands.slice(0, maxProbes)) {
        let st = null, since, run = null;
        if (seen.has(f.path) && xStartOf && !valueMode) {
          // On the chain already: when its x began (no probe; the step, if taken, is at that time).
          try { run = await xStartOf(f.path, f.time); } catch (error) { return finish('failed', { signal: f.path }); }
          if (cancelled()) { return finish('cancelled'); }
          // (no x there after all: not where the x came from)
          if (!run) { continue; }
          since = Number.isFinite(Number(run.time)) ? Number(run.time) : Infinity;
        } else {
          try { st = await probe(f.path, f.time); } catch (error) { st = null; }
          if (cancelled()) { return finish('cancelled'); }
          if (!st || st.error) { continue; }
          since = st.since === null || st.since === undefined ? Infinity : Number(st.since);
          // A value held on the chain: its run starts at its last change (the step's since).
          if (valueMode && seen.has(f.path)) { run = { time: since, complete: true }; }
        }
        probed.push({ f, st, since, run });
      }
      // Earliest x first; on a tie a signal not yet on the chain first, then the fan-in's order (a stable sort).
      probed.sort((p, q) => (p.since - q.since) || (seen.has(p.f.path) - seen.has(q.f.path)));
      if (!probed.length) { return finish('failed'); }
      let best = null, next = null, heldRun = null;
      for (const cand of probed) {
        if (seen.has(cand.f.path)) {
          // Back to a signal of the chain. x since the start all the way round (an unreset
          // cnt <= cnt + 1) is uninitialised storage.
          const from = out.steps.findIndex((e) => e.signal === cand.f.path);
          if (from >= 0 && out.steps.slice(from).every((e) => Number(e.since) === 0)) { return finish('uninit', { signal: cand.f.path }); }
          const run = cand.run;
          if (run && run.dumpStart) { return finish('dumpStart', { signal: cand.f.path }); }
          if (run && Number(run.time) === 0 && run.complete !== false) { return finish('uninit', { signal: cand.f.path }); }
          // A held x: the step where the signal last became x, unless the chain has been there
          // (then the x goes round a loop).
          const at = run && Number.isFinite(Number(run.time)) ? Number(run.time) : null;
          if (at === null || at > Number(cand.f.time) || visited.has(cand.f.path + '@' + at)) { return finish('loop', { signal: cand.f.path }); }
          // (C) With xCause: the changes of its x bits inside the run, latest first (at most
          // maxCauses), each asked where its x came from; the first with a new x is where the jump
          // stops. Unknown, or too many: the jump to the run's start, B's label.
          let jumpTo = at, attributed = false, sources = null, bitsChanged = null, skipped = null;
          // (a clean value written again with no change: the write in effect, the read's activation)
          if (valueMode && cand.st && cand.st.activation && Number(cand.st.activation.time) > at && Number(cand.st.activation.time) <= Number(cand.f.time)) {
            jumpTo = Number(cand.st.activation.time);
            if (visited.has(cand.f.path + '@' + jumpTo)) { return finish('loop', { signal: cand.f.path }); }
          }
          if (!valueMode && maskStartOf && xCauseOf) {
            const changes = [];
            let t = Number(cand.f.time), ok = true;
            // (the budget: calls; the clock is a hang guard only, 'timeout', per call: one that does
            // not come back in causeHangMs, never the walk's whole time, so slowness alone never
            // changes a label)
            let calls = 0;
            const OVER = {};
            const bounded = async (call) => {
              if (++calls > causeSteps) { return OVER; }
              const g = await guarded(call, causeHangMs);
              return g.late ? LATE : g.v;
            };
            const why = (v) => (v === OVER ? 'budget' : 'timeout');
            // The bound first (one window each): the run's changes, else its x bits' changes, over
            // maxCauses: too many to walk.
            const count = async (f) => { if (!f) { return undefined; } try { const n = await bounded(() => f(cand.f.path, at, Number(cand.f.time))); return n === LATE || n === OVER ? n : Number.isFinite(Number(n)) && n !== null ? Number(n) : undefined; } catch (error) { return undefined; } };
            const all = await count(changeCountOf);
            if (cancelled()) { return finish('cancelled'); }
            if (all === LATE || all === OVER) { ok = false; skipped = why(all); }
            if (ok && all !== undefined && all > maxCauses) {
              const bits = await count(maskChangeCountOf);
              if (cancelled()) { return finish('cancelled'); }
              if (bits === LATE || bits === OVER) { ok = false; skipped = why(bits); } else if (bits === undefined || bits > maxCauses) { ok = false; skipped = 'changes'; }
            }
            for (; ok;) {
              let m = null;
              try { m = await bounded(() => maskStartOf(cand.f.path, t, at)); } catch (error) { m = null; }
              if (cancelled()) { return finish('cancelled'); }
              if (m === LATE || m === OVER) { ok = false; skipped = why(m); break; }
              if (!m) { ok = false; break; }
              if (m.complete === false) { ok = false; skipped = 'changes'; break; }
              if (Number(m.time) <= at) { break; }
              if (changes.length >= maxCauses) { ok = false; skipped = 'changes'; break; }
              changes.push(Number(m.time));
              t = Number(m.time) - 1;
            }
            // The activations where another input had x (no change of its own there): asked too.
            if (ok && xInputEdgesOf) {
              let e = null;
              try { e = await bounded(() => xInputEdgesOf(cand.f.path, Number(cand.f.time), at)); } catch (error) { e = null; }
              if (cancelled()) { return finish('cancelled'); }
              if (e === LATE || e === OVER) { ok = false; skipped = why(e); } else if (!e || !Array.isArray(e.edges)) { ok = false; } else {
                for (const te of e.edges) { if (te > at && te <= Number(cand.f.time) && !changes.includes(te)) { changes.push(te); } }
                changes.sort((a, b) => b - a);
                if (changes.length > maxCauses) { ok = false; skipped = 'changes'; }
              }
            }
            // Latest first, the bits still x at the traced time followed back through each.
            let care = String(cand.f.value), imprecise = false;
            for (const ch of ok ? changes : []) {
              let k = null;
              try { k = await bounded(() => xCauseOf(cand.f.path, ch, care)); } catch (error) { k = null; }
              if (cancelled()) { return finish('cancelled'); }
              if (k === LATE || k === OVER) { ok = false; skipped = why(k); break; }
              if (!k) { ok = false; break; }
              if (k.cause === 'new') {
                if (imprecise) { ok = false; break; }
                jumpTo = ch; sources = k.sources || []; break;
              }
              if (k.care !== undefined) { care = k.care; }
              if (k.imprecise) { imprecise = true; }
            }
            attributed = true;
            if (!ok) { jumpTo = at; sources = null; bitsChanged = { from: at, to: Number(cand.f.time) }; }
            if (jumpTo !== at && visited.has(cand.f.path + '@' + jumpTo)) { return finish('loop', { signal: cand.f.path }); }
          }
          let st;
          try { st = await step(cand.f.path, jumpTo); } catch (error) { st = null; }
          if (cancelled()) { return finish('cancelled'); }
          if (!st || st.error) { return finish('failed'); }
          if (!valueMode && !xBits(st.value)) { continue; }
          best = cand;
          next = st;
          heldRun = { since: jumpTo, complete: jumpTo !== at || run.complete !== false };
          if (attributed) {
            if (bitsChanged) { heldRun.bitsChanged = bitsChanged; }
            if (skipped) { heldRun.causeSkipped = skipped; }
            prefer = sources && sources.length ? new Set(sources) : null;
          } else if (!valueMode) {
            // (B) Exact only when the x bits are the same all the way: the same mask at both ends
            // and (with maskStart) the exact mask's run starting at the jump too.
            const w = Math.max(String(cand.f.value).length, String(st.value).length);
            let same = xMask(cand.f.value, w) === xMask(st.value, w);
            if (same && maskStartOf) {
              let m = null;
              try { m = await maskStartOf(cand.f.path, Number(cand.f.time), at); } catch (error) { m = null; }
              if (cancelled()) { return finish('cancelled'); }
              same = !!m && m.complete !== false && Number(m.time) <= at;
            }
            if (!same) { heldRun.bitsChanged = { from: at, to: Number(cand.f.time) }; }
            // (and no activation inside where another input had x: it could have replaced them)
            if (same) {
              let e = null;
              if (xInputEdgesOf) { try { e = await xInputEdgesOf(cand.f.path, Number(cand.f.time), at); } catch (error) { e = null; } }
              if (cancelled()) { return finish('cancelled'); }
              if (!e || !Array.isArray(e.edges) || e.edges.length) { heldRun.unproven = true; }
            }
          }
          // (C without the input check: not proven all the way)
          if (attributed && !xInputEdgesOf) { heldRun.unproven = true; }
          // A clean value held: proven when its statement last ran there (the step at the read
          // time is that write; a later run, the same value written again, is not proven).
          if (valueMode) {
            const ps = cand.st, act = ps && ps.activation ? Number(ps.activation.time) : null;
            const d = (ps && ps.driver) || {};
            const ran = act !== null ? act : d.kind === 'assign' || d.procKind === 'AlwaysComb' ? Number(ps.since) : null;
            if (!ps || ps.trust !== 'exact' || ran !== jumpTo) { heldRun.unproven = true; }
          }
          break;
        }
        let st = cand.st;
        if (probe !== step) {
          try { st = await step(cand.f.path, cand.f.time); } catch (error) { st = null; }
          if (cancelled()) { return finish('cancelled'); }
          if (!st || st.error) { return finish('failed'); }
        }
        // The step can disagree with its probe (Verdi's answer, an edge off by one): a value with
        // no x is not where the x came from; try the next candidate.
        if (!valueMode && !xBits(st.value)) { continue; }
        best = cand;
        next = st;
        break;
      }
      if (!best) { return finish('failed'); }
      let why;
      if (heldRun) {
        // (held by storage; x since then for a combinational value: a continuous assignment, an
        // always_comb, or a process woken by no edge)
        const act = next.activation, edge = act && act.trigger ? act.trigger.edge : null, d = next.driver || {};
        const comb = d.kind === 'assign' || d.procKind === 'AlwaysComb' || (act && !['PosEdge', 'NegEdge', 'BothEdges'].includes(edge));
        why = { code: comb && !valueMode ? 'xSince' : 'held', role: best.f.role, since: heldRun.since };
        if (!heldRun.complete) { why.limited = true; }
        if (heldRun.bitsChanged) { why.bitsChanged = heldRun.bitsChanged; }
        if (heldRun.causeSkipped) { why.causeSkipped = heldRun.causeSkipped; }
      } else {
        why = viaCause ? { code: 'cause', role: best.f.role }
          : byBits ? { code: 'bits', role: best.f.role }
          : control ? { code: 'control', role: best.f.role, count: cands.length }
          : same ? { code: 'same', role: best.f.role, count: cands.length }
          : cands.length === 1 ? { code: 'only', role: best.f.role } : { code: 'earliest', role: best.f.role, count: cands.length };
        if (cands.length > maxProbes) { why.limited = true; }
      }
      seen.add(next.signal);
      visited.add(next.signal + '@' + Number(next.time));
      const linked = await linkOf(cur, best.f, track);
      if (cancelled()) { return finish('cancelled'); }
      add(next, why, !!linked && !(heldRun && heldRun.unproven));
      track = xBits(next.value) ? xBitsOf(next.value) : linked || allBits(next.value);
      cur = next;
    }
  }

  root.cmuxTrace = Object.freeze({ createEngine, xChain, MODEL_VERSION });
})(typeof window !== 'undefined' ? window : globalThis);
