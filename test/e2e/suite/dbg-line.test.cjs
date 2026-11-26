// vscode-port P4 acceptance: native line breakpoints (F9) on SystemVerilog: hit when a signal the line assigns changes,
// in this instance of the module or in any instance; conditions on them; Choose Instance for Module.
const { vscode, assert, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

const LINE = 15; // 0-based: `else if (en) cnt <= next;` in module counter
const cont = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop after continue');
const lineBp = (condition) => new vscode.SourceBreakpoint(new vscode.Location(D.SV(), new vscode.Position(LINE, 0)), true, condition);
async function lineResponse(from = 0) {
  return until(async () => {
    const r = D.sent.slice(from).reverse().find((m) => m.type === 'response' && m.command === 'setBreakpoints' && m.body.breakpoints.length);
    return r ? r.body.breakpoints[0] : null;
  }, 'setBreakpoints response');
}

module.exports = D.suite({
  'dbg: F9 line breakpoint stops when the line\'s target changes (this instance), frame at the line': async () => {
    const { uri } = await D.start();
    vscode.debug.addBreakpoints([lineBp()]);
    const bp = await lineResponse();
    assert.ok(bp.verified, JSON.stringify(bp));
    assert.match(bp.message, /watches cnt in dbg_top\.u0/);
    let r = await cont();
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    assert.deepStrictEqual(r.ev.body.hitBreakpointIds, [bp.id]);
    assert.strictEqual(r.s.time, 15); await D.markerAt(uri, 15);
    const st = await D.custom('stackTrace', { threadId: 1 });
    assert.strictEqual(st.stackFrames[0].line, LINE + 1);
    assert.match(st.stackFrames[0].source.path, /dbg_top\.sv$/);
    r = await cont();
    assert.strictEqual(r.s.time, 25, 'u0 counts every cycle');
  },
  'dbg: line breakpoint with a condition, this instance vs any instance': async () => {
    await D.start();
    // Only u1 has en == 0 when its cnt is 2 (35 ns); u0's en is always 1.
    vscode.debug.addBreakpoints([lineBp("en == 0 && cnt == 8'd2")]);
    await lineResponse();
    let r = await cont();
    assert.notStrictEqual(r.ev.body.reason, 'breakpoint');
    assert.match(r.ev.body.description, /^No breakpoint hit ahead: .*never hits in 5 ns–405 ns \(the condition is never true/, 'says why'); // 
    // The same line in any instance of the module (Toggle Line Breakpoint in Any Instance).
    const on = await vscode.commands.executeCommand('vaporview.debugger.toggleLineBreakpointAnyInstance', { uri: String(D.SV()), line: LINE });
    assert.strictEqual(on, true);
    // The marking is global (per file line): undone even when the test fails, or it leaks into the next tests.
    let off = false;
    try {
      await until(async () => { const b = [...D.sent].reverse().find((m) => m.type === 'response' && m.command === 'setBreakpoints' && m.body.breakpoints.length); return b && /dbg_top\.u0, dbg_top\.u1/.test(b.body.breakpoints[0].message) ? b : null; }, 'any-instance breakpoint');
      const cond = vscode.debug.breakpoints.find((b) => b.location && b.location.range.start.line === LINE);
      assert.strictEqual(cond.condition, "en == 0 && cnt == 8'd2", 'the condition is kept');
      await D.stopAfter(() => vscode.commands.executeCommand('vaporview.debugger.first'));
      r = await cont();
      assert.strictEqual(r.ev.body.reason, 'breakpoint');
      assert.strictEqual(r.s.time, 35);
      off = await vscode.commands.executeCommand('vaporview.debugger.toggleLineBreakpointAnyInstance', { uri: String(D.SV()), line: LINE }) === false;
      assert.ok(off, 'toggled back to this instance');
    } finally {
      if (!off) { await vscode.commands.executeCommand('vaporview.debugger.toggleLineBreakpointAnyInstance', { uri: String(D.SV()), line: LINE }); }
    }
  },
  'dbg: launch option lineBreakpointInstances any + Choose Instance for Module': async () => {
    await D.start({ lineBreakpointInstances: 'any' });
    vscode.debug.addBreakpoints([lineBp()]);
    const bp = await lineResponse();
    assert.match(bp.message, /dbg_top\.u0, dbg_top\.u1/);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    // This instance = the chosen one.
    await D.start();
    const pick = await vscode.commands.executeCommand('vaporview.debugger.chooseInstance', { uri: String(D.SV()), line: LINE, instance: 'dbg_top.u1' });
    assert.strictEqual(pick, 'dbg_top.u1');
    const from = D.sent.length;
    vscode.debug.addBreakpoints([lineBp()]);
    const b2 = await lineResponse(from);
    assert.match(b2.message, /in dbg_top\.u1 \(text scan/);
    let r = await cont();
    assert.strictEqual(r.s.time, 15);
    r = await cont();
    assert.strictEqual(r.s.time, 35, 'u1 counts every other cycle');
    await vscode.commands.executeCommand('vaporview.debugger.chooseInstance', { uri: String(D.SV()), line: LINE, instance: 'dbg_top.u0' });
  },
  'dbg: a line outside any module or naming no signal is reported': async () => {
    await D.start();
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(D.SV(), new vscode.Position(1, 0)))]);
    const bp = await lineResponse();
    assert.ok(!bp.verified);
    assert.match(bp.message, /not inside a module/);
  },
});
