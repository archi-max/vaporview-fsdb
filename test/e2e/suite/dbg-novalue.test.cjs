// vscode-port: the debugger tells "no value" (not in the dump / not computable) from a real x. A signal the
// dump has no values for is read through the design (Trace's shared resolver, vaporview.trace.resolvePortValue) or shown
// as "no value (why)"; it is never shown or evaluated as x, and a breakpoint condition on it is reported, never fires.
// The VCS twins without wisp.outsideWrites carry no port copies: en1, w0/w1, u0/u1.next, u0/u1.wrap, u1.en have none.
const { vscode, assert, until, sleep } = require('./helpers.cjs');
const fmt = require('./helpers.cjs').format;
const D = require('./dbg-helpers.cjs');

const step = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
const repl = (expression) => D.custom('evaluate', { expression, frameId: 1, context: 'repl' }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, message: String(e && e.message || e) }));
const NO = /^no value \((not in the dump|not computable: .+)\)$/;

module.exports = D.suite({
  'dbg no value is never x (Locals, inline values, evaluate, breakpoint conditions)': async () => {
    if (fmt === 'vcd') { return; } // (the VCD dumps every port copy)
    // an earlier session's Choose Instance for Module (u0, as dbg-line leaves it in a full run): the launch option u1
    // wins (inline values showed u0's en, no via, for u1)
    await D.start();
    await vscode.commands.executeCommand('vaporview.debugger.chooseInstance', { uri: String(D.SV()), line: 15, instance: 'dbg_top.u0' });
    await D.stopAll();
    await D.start({ instance: 'dbg_top.u1' }, 'dbg/dbg.vcd', { outsideWrites: 'unset' });
    for (let i = 0; i < 3; i++) { await step(); } // 35 ns
    assert.strictEqual((await D.session()).time, 35);
    // Locals of u1: every value is the dump's, a design read with its via, or "no value (why)"; never a bare x for
    // a name without dump values
    const scopes = await D.custom('scopes', { frameId: 1 });
    const vars = (await D.custom('variables', { variablesReference: scopes.scopes[0].variablesReference })).variables;
    const en = vars.find((v) => v.name === 'en');
    assert.ok(en, JSON.stringify(vars.map((v) => v.name)));
    const en1 = await repl('dbg_top.en1');
    const has = (p) => D.e2e({ kind: 'dumpHas', path: p });
    if (await has('dbg_top.u1.en')) {
      // (the WCZ twin carries the converter-merged port copies: then it is the dump's value)
      assert.ok(/^1'h[01]$/.test(en.value) && !/via/.test(en.type), JSON.stringify(en));
    } else if (NO.test(en.value)) {
      assert.ok(!/via/.test(en.type), JSON.stringify(en));
    } else {
      assert.match(en.type, /via /, 'a design read says where it came from: ' + JSON.stringify(en));
      if (en1.ok) { assert.strictEqual(en.value, en1.r.result.split('  ')[0], 'u1.en reads as en1 through the port connection'); }
    }
    for (const n of ['next', 'wrap']) {
      const v = vars.find((x) => x.name === n);
      assert.ok(v, n);
      if (await has('dbg_top.u1.' + n)) { assert.ok(!/x/.test(v.value.replace(/^\d+'h/, '')), `${n}: ${JSON.stringify(v)}`); continue; }
      assert.ok(NO.test(v.value) || /via /.test(v.type), `${n}: ${JSON.stringify(v)}`);
    }
    // no entry is a bare "no value"; a no value carries its short tag, the full reason in the line's hover
    {
      const all = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 0, last: 60 });
      for (const row of all) { for (const part of row.text.split('  ')) { assert.ok(!/= no value$/.test(part), `bare no value: line ${row.line + 1}: ${row.text}`); } }
      const hov = await D.e2e({ kind: 'inlinePainted' });
      const tagged = ((hov && hov.rows && hov.rows[String(D.SV())]) || []).filter((r) => /= no value \(/.test(r.text));
      for (const r of tagged) { assert.ok(r.reasons && r.reasons.some((x) => /: no value \(/.test(x)), 'hover has the full reason: ' + JSON.stringify(r)); }
    }
    // Inline values: no x for the names without dump values
    const inline = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 0, last: 60 });
    assert.ok(inline.length > 0, 'inline values');
    for (const row of inline) {
      for (const part of row.text.split('  ')) {
        const m = /^(\w+) = (.*)$/.exec(part); // (mock v2: name = value, name = was → now; two spaces apart)
        if (!m || !['en', 'en1', 'next', 'wrap', 'w0', 'w1'].includes(m[1])) { continue; }
        const inst = row.line < 20 ? 'dbg_top.u1.' : 'dbg_top.'; // (the session's instance u1: the editor follows it for counter)
        if (await has(inst + m[1])) { assert.ok(!/x/.test(m[2]) && !/via/.test(m[2]), `line ${row.line + 1}: ${part}`); continue; }
        assert.ok(/^no value \((not in dump|not computable|port copy|memory)\)$/.test(m[2]) || /\(via /.test(m[2]), // never a bare "no value"
           `line ${row.line + 1}: ${part} (row: ${row.text}; drawn: ${JSON.stringify(((await D.e2e({ kind: 'editor' })) || {})[String(D.SV())]?.map((d) => d.module + '@' + d.instance))}; Locals en ${JSON.stringify(en)})`);
      }
    }
    // Evaluate: a name with no value is "cannot evaluate", never x
    const e = await repl('dbg_top.u0.wrap');
    if (!e.ok) { assert.match(e.message, /cannot evaluate: dbg_top\.u0\.wrap has no value/); }
    else { assert.ok(!/x/.test(e.r.result.split('  ')[0].replace(/^\d+'h/, '')), 'a design read, not x: ' + e.r.result); }
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  },
  "dbg (d'): a condition on u1.en (no dump values) is evaluated through the design and fires where phase[0] == 1 does": async () => {
    if (fmt === 'vcd') { return; }
    await D.start({}, 'dbg/dbg.vcd', { outsideWrites: 'unset' });
    const viaDesign = await hits('dbg_top.u1.en == 1');
    if (viaDesign.unverified) {
      // the design could not read it: reported with the reason, and it never fires
      assert.match(viaDesign.unverified, /cannot evaluate: dbg_top\.u1\.en has no value \(.+\)/);
      assert.strictEqual(viaDesign.times.length, 0);
      return;
    }
    const dumped = await D.e2e({ kind: 'dumpHas', path: 'dbg_top.u1.en' }); // (the WCZ twin carries merged port copies)
    if (!dumped) { assert.match(viaDesign.message, /dbg_top\.u1\.en evaluated through the design via /, viaDesign.message); }
    const ref = await hits('dbg_top.phase[0] == 1');
    assert.ok(ref.times.length >= 3, JSON.stringify(ref));
    assert.deepStrictEqual(viaDesign.times, ref.times);
    // a data breakpoint on u1.en itself: its candidate times are the changes of its dumped leaves (phase), not a scan
    if (!dumped) {
      const reads0 = (await D.e2e({ kind: 'dataStats' })).designReads;
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      const n = D.sent.length;
      vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u1.en changes', true)]);
      const bp = await until(async () => { const m = D.sent.slice(n).reverse().find((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'); return m && m.body.breakpoints.length === 1 ? m.body.breakpoints[0] : null; }, 'setFunctionBreakpoints');
      assert.ok(bp.verified && /read through the design \(changes of dbg_top\.phase\)/.test(bp.message), JSON.stringify(bp));
      const reads = (await D.e2e({ kind: 'dataStats' })).designReads - reads0;
      const phaseChanges = 42; // (one per clock edge over the 410 ns run, + the initial value)
      assert.ok(reads <= phaseChanges + 8, `design reads ${reads}: follows phase's changes, not every time`);
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
  },
  'dbg with the helper\'s computed port copies (outsideWrites none) u1.en is the dump\'s value (Locals, inline @34, conditions)': async () => {
    if (fmt === 'vcd') { return; }
    const { uri } = await D.start({ instance: 'dbg_top.u1' });
    for (let i = 0; i < 3; i++) { await step(); }
    const scopes = await D.custom('scopes', { frameId: 1 });
    const vars = (await D.custom('variables', { variablesReference: scopes.scopes[0].variablesReference })).variables;
    const en = vars.find((v) => v.name === 'en');
    assert.ok(en && /^1'h[01]$/.test(en.value) && !/via/.test(en.type), JSON.stringify(en));
    // inline values in u1 at 34 ns: en = 1 (a computed copy is read through a window, not valueAt)
    await vscode.commands.executeCommand('vaporview.debugger.chooseInstance', { uri: String(D.SV()), line: 7, instance: 'dbg_top.u1' });
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 34 });
    await until(async () => { const x = await D.session(); return x && x.time === 34 ? x : null; }, 'session at 34', 5000, 100);
    const inline = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 0, last: 20 });
    const l16 = inline.find((v) => v.line === 15);
    assert.ok(l16 && /\ben = (0 → )?1\b/.test(l16.text) && !/via/.test(l16.text), JSON.stringify(inline));
    const a = await hits('dbg_top.u1.en == 1'), ref = await hits('dbg_top.phase[0] == 1');
    assert.ok(!a.unverified && !/through the design/.test(a.message), JSON.stringify(a));
    assert.deepStrictEqual(a.times, ref.times);
  },
  'dbg: with the session instance u1, dbg_top\'s own lines read dbg_top (stored phase/instr/c0/c1 are values, never "no value"); a bare Watch name says where it looked': async () => {
    if (fmt === 'vcd') { return; }
    // (README capture: u1 holds clk/rst, so the lenient session-instance match took u1 as dbg_top's instance too)
    await D.start({ instance: 'dbg_top.u1' });
    for (let i = 0; i < 3; i++) { await step(); } // 35 ns
    assert.strictEqual((await D.session()).time, 35);
    await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Beside });
    const inline = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 20, last: 40 });
    const chips = inline.flatMap((r) => r.text.split('  ').map((t) => ({ line: r.line, t })));
    for (const n of ['phase', 'instr', 'c0', 'c1']) {
      const c = chips.find((x) => x.t.startsWith(n + ' = '));
      assert.ok(c, `${n} has a chip: ${JSON.stringify(inline)}`);
      assert.ok(!/no value/.test(c.t) && !/x/.test(c.t.slice(n.length + 3)), `line ${c.line + 1}: ${c.t}`);
    }
    // a bare name resolves in the session's instance only: the error says so and names the full path
    const w = await repl('c0');
    assert.ok(!w.ok, 'c0 is not in u1: ' + JSON.stringify(w));
    assert.match(w.message, /unknown name c0: c0 is not in dbg_top\.u1 \(the session's instance; bare names resolve there\): use the full path dbg_top\.c0/, w.message);
    const full = await repl('dbg_top.c0');
    assert.ok(full.ok, JSON.stringify(full));
  },
  'dbg: session instance dbg_top: counter has 2 instances, so its lines show no chip (never "no value") until Choose Instance; dbg_top reads dbg_top': async () => {
    if (fmt === 'vcd') { return; }
    await D.start({ instance: 'dbg_top' });
    for (let i = 0; i < 3; i++) { await step(); } // 35 ns
    let inline = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 0, last: 40 });
    assert.ok(!inline.some((r) => r.line < 20), 'no chips in counter (u0 or u1?): ' + JSON.stringify(inline));
    assert.ok(!inline.some((r) => /no value/.test(r.text)), JSON.stringify(inline));
    for (const n of ['phase', 'c0', 'c1']) { assert.ok(inline.some((r) => r.line >= 20 && r.text.split('  ').some((t) => t.startsWith(n + ' = '))), `${n}: ${JSON.stringify(inline)}`); }
    await vscode.commands.executeCommand('vaporview.debugger.chooseInstance', { uri: String(D.SV()), line: 15, instance: 'dbg_top.u0' });
    inline = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 0, last: 19 });
    const l16 = inline.find((v) => v.line === 15);
    assert.ok(l16 && /\bcnt = /.test(l16.text) && !/no value/.test(l16.text), 'u0 chosen: ' + JSON.stringify(inline));
  },
});

/** The first hits of `dbg_top.u0.cnt changes` with `condition`, from the start: { times, message, unverified }. */
async function hits(condition, max = 6) {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await vscode.commands.executeCommand('vaporview.debugger.first');
  await until(async () => { const x = await D.session(); return x && x.cycle === 1 ? x : null; }, 'first cycle');
  const n = D.sent.length;
  vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u0.cnt changes', true, condition)]);
  const bp = await until(async () => { const m = D.sent.slice(n).reverse().find((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'); return m && m.body.breakpoints.length === 1 ? m.body.breakpoints[0] : null; }, 'setFunctionBreakpoints');
  const times = [];
  if (!bp.verified) { return { times, message: bp.message, unverified: bp.message }; }
  for (let i = 0; i < max; i++) {
    const r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop after continue');
    if (r.ev.body.reason !== 'breakpoint') { break; }
    times.push(r.s.time);
  }
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  return { times, message: bp.message };
}
