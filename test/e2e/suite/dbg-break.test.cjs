// vscode-port P4 acceptance: continue / reverse continue to breakpoint hits; Break When Changes / Equals / Text Matches
// (row commands → function breakpoints in the Breakpoints view; dataBreakpoints on Locals), SystemVerilog conditions.
const { vscode, assert, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');
const path = require('path');

const cont = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop after continue');
const rcont = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.reverseContinue'), 'stop after reverse continue');
/** Waits until the adapter answered a set*Breakpoints request with `n` verified breakpoints. */
async function verified(command, n) {
  return until(async () => {
    const r = [...D.sent].reverse().find((m) => m.type === 'response' && m.command === command);
    return r && r.body.breakpoints.length === n && r.body.breakpoints.every((b) => b.verified) ? r.body.breakpoints : null;
  }, `${command} verified x${n}`);
}

module.exports = D.suite({
  'dbg: Break When Changes (row) + continue / reverse continue': async () => {
    const { uri } = await D.start();
    const name = await vscode.commands.executeCommand('vaporview.debugger.breakWhenChanges', { webviewSection: 'signal', scopePath: 'dbg_top.u1', signalName: 'cnt' });
    assert.strictEqual(name, 'dbg_top.u1.cnt changes');
    assert.ok(vscode.debug.breakpoints.some((b) => b.functionName === name), 'shows in the Breakpoints view');
    const [bp] = await verified('setFunctionBreakpoints', 1);
    let r = await cont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    assert.deepStrictEqual(r.ev.body.hitBreakpointIds, [bp.id]);
    assert.strictEqual(r.s.time, 15); await D.markerAt(uri, 15);
    r = await cont();
    assert.strictEqual(r.s.time, 35); assert.strictEqual(r.s.cycle, 4); await D.markerAt(uri, 35);
    r = await cont();
    assert.strictEqual(r.s.time, 55);
    r = await rcont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    assert.strictEqual(r.s.time, 35); await D.markerAt(uri, 35);
    r = await rcont();
    assert.strictEqual(r.s.time, 15);
  },
  // vscode-port: a signal breakpoint's stop. Locals are the stopped signal's scope (not
  // the testbench's), and the frame opens what drove the value (Trace), else nothing: never the cursor's line 1 of a
  // file that happens to be open.
  'dbg: a signal breakpoint stop: Locals = the signal\'s scope; the frame is Trace\'s driver line, never line 1 of the open file': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
    const sv = D.SV().fsPath;
    await cfg.update('trace.designArgs', [path.basename(sv), '--top', 'dbg_top'], G);
    await cfg.update('trace.designRoot', path.dirname(sv), G);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset');
    try {
      await D.start();
      const ed = await vscode.window.showTextDocument(D.SV(), { preview: false });
      ed.selection = new vscode.Selection(0, 0, 0, 0);
      vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u1.cnt changes', true)]);
      await verified('setFunctionBreakpoints', 1);
      const r = await cont();
      assert.strictEqual(r.ev.body.reason, 'breakpoint');
      const where = await until(async () => { const w = await D.e2e({ kind: 'stopLocation' }); return w && w.loc !== undefined ? w : null; }, 'stop location answered', 60000);
      assert.strictEqual(where.scope, 'dbg_top.u1', JSON.stringify(where));
      const scopes = (await D.custom('scopes', { frameId: 1 })).scopes;
      const vars = (await D.custom('variables', { variablesReference: scopes[0].variablesReference })).variables.map((v) => v.name);
      assert.ok(vars.includes('cnt') && vars.includes('next') && !vars.includes('u0'), 'Locals are u1\'s: ' + JSON.stringify(vars));
      // the statement Trace says drove cnt at the stop: counter's always_ff (line 15 or 16, 1-based), never line 1
      assert.ok(where.loc && where.loc.kind === 'driver', 'Trace answered with the driver: ' + JSON.stringify(where));
      const frame = await until(async () => { const st = await D.custom('stackTrace', { threadId: 1 }); const f = st.stackFrames[0]; return f.source && f.line === where.loc.line ? f : null; }, 'frame at the driver line');
      assert.ok(/dbg_top\.sv$/.test(frame.source.path) && [15, 16].includes(frame.line), JSON.stringify({ frame, where }));
      await until(async () => { const a = vscode.window.activeTextEditor; return a && /dbg_top\.sv$/.test(a.document.fileName) && a.selection.active.line === frame.line - 1 ? a : null; }, 'the editor shows the driver line', 15000);
      // the editor followed into counter (two instances): Locals stay the stopped one's (u1), not the module's first
      await new Promise((res) => setTimeout(res, 500));
      const after = await D.e2e({ kind: 'stopLocation' });
      assert.strictEqual(after.scope, 'dbg_top.u1', 'Locals after the editor opened the driver: ' + JSON.stringify(after));
      console.log(`DBGSTOPFRAME ${JSON.stringify({ loc: where.loc, scope: after.scope, line: frame.line })}`);
    } finally {
      await cfg.update('trace.designArgs', undefined, G);
      await cfg.update('trace.designRoot', undefined, G);
      await vscode.commands.executeCommand('vaporview.e2e.traceReset');
    }
  },
  'dbg: with no design the stop frame has no source (never the cursor\'s line 1)': async () => {
    await D.start();
    const ed = await vscode.window.showTextDocument(D.SV(), { preview: false });
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u1.cnt changes', true)]);
    await verified('setFunctionBreakpoints', 1);
    await cont();
    const where = await until(async () => { const w = await D.e2e({ kind: 'stopLocation' }); return w && w.loc !== undefined ? w : null; }, 'stop location answered', 60000);
    assert.strictEqual(where.loc, null, JSON.stringify(where));
    const f = (await D.custom('stackTrace', { threadId: 1 })).stackFrames[0];
    assert.ok(!f.source, 'no source rather than a cursor line: ' + JSON.stringify(f));
  },
  'dbg: Break When Equals (row) with sized and plain values': async () => {
    await D.start();
    await vscode.commands.executeCommand('vaporview.debugger.breakWhenEquals', { scopePath: 'dbg_top.u0', signalName: 'cnt', value: "8'h05" });
    await verified('setFunctionBreakpoints', 1);
    let r = await cont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    assert.strictEqual(r.s.time, 55);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.commands.executeCommand('vaporview.debugger.breakWhenEquals', { scopePath: 'dbg_top.u0', signalName: 'cnt', value: '9' });
    await verified('setFunctionBreakpoints', 1);
    r = await cont();
    assert.strictEqual(r.s.time, 95);
    r = await rcont();
    assert.match(r.ev.body.description, /^No breakpoint hit behind: .*its only hit is at the marker \(95 ns\)/, 'says why'); // 
    // A value that does not fit is reported on the breakpoint.
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.commands.executeCommand('vaporview.debugger.breakWhenEquals', { scopePath: 'dbg_top.u0', signalName: 'cnt', value: "9'h1ff" });
    const bad = await until(async () => { const m = [...D.sent].reverse().find((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'); return m && m.body.breakpoints.length === 1 && !m.body.breakpoints[0].verified ? m.body.breakpoints[0] : null; }, 'unverified');
    assert.match(bad.message, /not a 8-bit value/);
  },
  'dbg: Break When Text Matches (regex over the row text, riscv)': async () => {
    await D.start();
    const name = await vscode.commands.executeCommand('vaporview.debugger.breakWhenTextMatches', { scopePath: 'dbg_top', signalName: 'instr', pattern: '^jal', format: 'riscv' });
    assert.strictEqual(name, 'dbg_top.instr ~ /^jal/i riscv');
    await verified('setFunctionBreakpoints', 1);
    let r = await cont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    assert.strictEqual(r.s.time, 15);
    r = await cont();
    assert.strictEqual(r.s.time, 55);
    r = await rcont();
    assert.strictEqual(r.s.time, 15);
  },
  'dbg: a SystemVerilog condition on a breakpoint': async () => {
    await D.start();
    // Change breakpoint on u1.cnt; the condition's names resolve in the signal's scope first.
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u1.cnt changes', true, "cnt == 8'd3 && !en")]);
    await verified('setFunctionBreakpoints', 1);
    let r = await cont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    assert.strictEqual(r.s.time, 55, 'u1.cnt reaches 3 at 55 ns');
    // A condition with a syntax error is reported, not silently ignored.
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u1.cnt', true, 'cnt == == 3')]);
    const bad = await until(async () => { const m = [...D.sent].reverse().find((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'); return m && m.body.breakpoints.length === 1 && !m.body.breakpoints[0].verified ? m.body.breakpoints[0] : null; }, 'unverified');
    assert.match(bad.message, /condition: syntax error/);
  },
  'dbg: data breakpoint on a Locals variable (Break on Value Change)': async () => {
    await D.start({ instance: 'dbg_top.u1' });
    const scopes = await D.custom('scopes', { frameId: 1 });
    const info = await D.custom('dataBreakpointInfo', { variablesReference: scopes.scopes[0].variablesReference, name: 'cnt' });
    assert.strictEqual(info.dataId, 'dbg_top.u1.cnt');
    assert.deepStrictEqual(info.accessTypes, ['write']);
    const set = await D.custom('setDataBreakpoints', { breakpoints: [{ dataId: info.dataId, condition: "cnt == 8'd2" }] });
    assert.ok(set.breakpoints[0].verified);
    const r = await cont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    assert.strictEqual(r.s.time, 35);
    await D.custom('setDataBreakpoints', { breakpoints: [] });
  },
});
