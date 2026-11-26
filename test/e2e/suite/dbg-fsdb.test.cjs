// vscode-port acceptance: the waveform debugger on FSDB and WCZ through wisp-helper's windowed
// queries. Stepping, Break When Changes / Equals / Text Matches forward and reverse, a SystemVerilog condition,
// Locals and Evaluate on the demo SoC dump (bigsoc25k: 80K ids, 25,021 cycles), and the debugger read no signal's
// whole history but the clock's. The FSDB/WCZ are internal: found through E2E_FSDB_DIR (never in the repo); without it
// these tests print SKIP. Equality with the whole-history search: test/perf/dbg-fsdb.cjs.
// Dump facts used (bigsoc25k): clock tb_bigsoc.clk rises at 5000 + 10000k ps; tb_bigsoc.cycles (64 bits) counts.
const fs = require('fs'), path = require('path');
const { vscode, assert, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');
const w = require('./wisp-common.cjs');

const step = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
const back = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepBack'));
const cont = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop after continue', 60000);
const rcont = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.reverseContinue'), 'stop after reverse continue', 60000);
const repl = async (e) => (await D.custom('evaluate', { expression: e, frameId: 1, context: 'repl' })).result;
async function verified(n) {
  return until(async () => {
    const r = [...D.sent].reverse().find((m) => m.type === 'response' && m.command === 'setFunctionBreakpoints');
    return r && r.body.breakpoints.length === n && r.body.breakpoints.every((b) => b.verified) ? r.body.breakpoints : null;
  }, `setFunctionBreakpoints verified x${n}`, 60000);
}
const decimal = (r) => { const m = /\(([^()]*?)(-?\d+)\)\s*$/.exec(String(r)); if (!m) { throw new Error('no decimal in the Evaluate result: ' + JSON.stringify(r)); } return Number(m[2]); };

function forFile(name) {
  return async () => {
    if (!(await w.useHelper('dbg ' + name))) { return; }
    const f = w.FSDB_DIR && path.join(w.FSDB_DIR, name);
    if (!f || !fs.existsSync(f)) { console.log(`SKIP dbg ${name}: no ${name} (E2E_FSDB_DIR=${w.FSDB_DIR || 'unset'})`); return; }
    const { uri, s } = await D.start({}, vscode.Uri.file(f));
    assert.strictEqual(s.clock, 'tb_bigsoc.clk');
    assert.strictEqual(s.time, 5000); assert.strictEqual(s.cycle, 1);
    // stepping
    let r = await step(); assert.strictEqual(r.s.time, 15000);
    r = await step(); assert.strictEqual(r.s.time, 25000); await D.markerAt(uri, 25000);
    r = await back(); assert.strictEqual(r.s.time, 15000);
    // Break When Equals, forward; Evaluate and Locals at the stop
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('tb_bigsoc.cycles == 100')]);
    await verified(1);
    r = await cont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    const tEq = r.s.time;
    assert.strictEqual(decimal(await repl('tb_bigsoc.cycles')), 100, 'cycles at the stop');
    assert.strictEqual(decimal(await repl('tb_bigsoc.cycles + 1')), 101);
    await D.markerAt(uri, tEq);
    const back1 = await back();
    assert.strictEqual(decimal(await repl('tb_bigsoc.cycles')), 99, 'the cycle before: ' + back1.s.time);
    const scopes = (await D.custom('scopes', { frameId: 1 })).scopes;
    const vars = (await D.custom('variables', { variablesReference: scopes[0].variablesReference })).variables;
    assert.ok(vars.length > 0, 'Locals listed');
    // Break When Changes on cycles from there: the next change, then reverse back over the equals hit
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('tb_bigsoc.cycles changes')]);
    await verified(1);
    r = await cont(); assert.strictEqual(r.s.time, tEq, 'cycles changes into 100 at the equals stop');
    r = await cont(); assert.strictEqual(decimal(await repl('tb_bigsoc.cycles')), 101);
    r = await rcont(); assert.strictEqual(r.s.time, tEq);
    // Text Matches (hex text ends in 0) forward, with a SystemVerilog condition
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('tb_bigsoc.cycles ~ /0$/ hexadecimal', true, 'tb_bigsoc.cycles > 200')]);
    await verified(1);
    r = await cont();
    const c = decimal(await repl('tb_bigsoc.cycles'));
    assert.ok(c > 200 && c % 16 === 0, 'text + condition hit: cycles ' + c);
    r = await cont();
    assert.strictEqual(decimal(await repl('tb_bigsoc.cycles')), c + 16, 'next text + condition hit');
    r = await rcont();
    assert.strictEqual(decimal(await repl('tb_bigsoc.cycles')), c, 'reverse text + condition hit');
    // Only the clock was read whole; the rest through windowed helper queries.
    const st = await D.e2e({ kind: 'dataStats' });
    const others = st.wholeReads.filter((p) => p !== st.clock);
    assert.deepStrictEqual(others, [], 'whole-history reads besides the clock: ' + JSON.stringify(others));
    assert.ok(st.windowedRequests > 5, 'windowed requests ' + st.windowedRequests);
    console.log(`  DIAGNOSTIC dbg ${name}: equals stop at ${tEq} ps, text+condition at cycles ${c}, ${st.windowedRequests} helper requests, whole reads: clock only`);
  };
}

module.exports = D.suite({
  'dbg fsdb: stepping, breakpoints (changes / equals / text, forward and reverse, condition), Locals, Evaluate on FSDB': forFile('bigsoc25k.fsdb'),
  'dbg wcz: the same on the WCZ twin': forFile('bigsoc25k.wcz'),
});
