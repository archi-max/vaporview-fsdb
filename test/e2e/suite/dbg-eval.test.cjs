// vscode-port P4 acceptance: Evaluate (SystemVerilog, IEEE 1800 widths/sign, 4-state), watches in the native Watch view
// that update every step, Evaluate at Cycle N, Locals = signals of the current instance, following the editor's cursor.
const { vscode, assert, until, sleep } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

const step = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
const evalRepl = (expression) => D.custom('evaluate', { expression, frameId: 1, context: 'repl' });

module.exports = D.suite({
  'dbg: Evaluate SystemVerilog expressions (widths, sign, 4-state)': async () => {
    await D.start();
    for (let i = 0; i < 5; i++) { await step(); } // cycle 6, 55 ns
    assert.strictEqual((await D.session()).time, 55);
    let r = await evalRepl('c0 + c1');
    assert.strictEqual(r.result, "8'h08  (8'd8)");
    r = await evalRepl("c0 + 9'd0");
    assert.strictEqual(r.type, '9 bits', 'context-determined width');
    r = await evalRepl('u1.cnt == 3 && !en1');
    assert.strictEqual(r.result, "1'h1  (1'd1)");
    // 4-state: x propagates through &, a known 0 masks it.
    let e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: "4'b1x0z & 4'b1111" });
    assert.strictEqual(e.bits, '1x0x');
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: "4'b1x0z & 4'b1010" });
    assert.strictEqual(e.bits, '1000');
    // Signed arithmetic shift keeps the sign.
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: "-8'sd4 >>> 1" });
    assert.strictEqual(e.bits, '11111110');
    // Errors are reported with their column.
    await assert.rejects(() => evalRepl('c0 +'), /syntax error/);
    await assert.rejects(() => evalRepl('nosuch + 1'), /unknown name nosuch/);
    // Evaluate at Cycle N (the editor's right-click item) reads another cycle without moving the marker.
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluateAtCycle', { expr: 'u0.cnt', cycle: 3 });
    assert.strictEqual(e.value, "8'h02"); assert.strictEqual(e.time, 25);
    assert.strictEqual((await D.session()).time, 55);
    // At cycle 1 the counters are reset, before it they are x.
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluateAtCycle', { expr: 'c0', cycle: 1 });
    assert.strictEqual(e.bits, '00000000');
  },
  'dbg: Debug Console evaluate: concatenation, replication, ternary, z, full signal path, unsized width': async () => {
    await D.start();
    for (let i = 0; i < 5; i++) { await step(); } // 55 ns: c0 = 5, c1 = 3
    const repl = async (e) => { const r = await D.custom('evaluate', { expression: e, frameId: 1, context: 'repl' }); return [r.result, r.type]; };
    assert.deepStrictEqual(await repl('{c0, c1}'), ["16'h0503  (16'd1283)", '16 bits']);
    assert.deepStrictEqual((await repl("{c0[3:0], 4'hz}"))[1], '8 bits');
    let e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: "{c0[3:0], 4'hz}" });
    assert.strictEqual(e.bits, '0101zzzz');
    assert.deepStrictEqual((await repl("c0 > c1 ? 8'd1 : 8'd2"))[0], "8'h01  (8'd1)");
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: '{2{c1[1:0]}}' });
    assert.strictEqual(e.bits, '1111');
    // A full dump path works from any scope; the unsized 1 makes the sum 32 bits (IEEE 1800 11.6).
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: 'dbg_top.u1.cnt + 1' });
    assert.strictEqual(e.width, 32); assert.strictEqual(e.value, "32'h00000004");
    // 4-state: z | 0 is x, x | 0 is x.
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: "4'bz01x | 4'b0000" });
    assert.strictEqual(e.bits, 'x01x');
    // Signed: -3 + 1 = -2 in 4 bits.
    e = await vscode.commands.executeCommand('vaporview.debugger.evaluate', { expr: "-4'sd3 + 4'sd1" });
    assert.strictEqual(e.bits, '1110');
  },
  'dbg: watches (evaluate, context watch) update every step': async () => {
    // Protocol level (the Watch view's own requests); the view's rendering is screenshot scenario.
    const { uri } = await D.start();
    const watch = async () => (await D.custom('evaluate', { expression: "c0 + 8'd100", frameId: 1, context: 'watch' })).result;
    assert.strictEqual(await watch(), "8'h64");
    await step(); assert.strictEqual(await watch(), "8'h65");
    await step(); assert.strictEqual(await watch(), "8'h66");
    await assert.rejects(() => D.custom('evaluate', { expression: 'nosuch', frameId: 1, context: 'watch' }), /unknown name nosuch/);
    // The single frame has a source, so VS Code focuses it (Thread.getTopStackFrame skips frames without one).
    const st = await D.custom('stackTrace', { threadId: 1 });
    assert.ok(st.stackFrames[0].source && st.stackFrames[0].source.path === vscode.Uri.parse(uri).fsPath, JSON.stringify(st.stackFrames[0]));
  },
  'dbg: Locals = signals of the current instance, follows the editor cursor': async () => {
    await D.start();
    await step(); await step(); // 25 ns
    const scopes = (await D.custom('scopes', { frameId: 1 })).scopes;
    assert.deepStrictEqual(scopes.map((x) => [x.name, x.presentationHint]), [['Locals', 'locals']]);
    console.log('  [dbg-eval] VS Code itself asked for: ' + JSON.stringify([...new Set(D.received.map((m) => m.command))]));
    let vars = (await D.custom('variables', { variablesReference: scopes[0].variablesReference })).variables;
    const byName = (n) => vars.find((v) => v.name === n);
    assert.strictEqual(byName('c0').value, "8'h02");
    assert.ok(byName('u0') && byName('u0').variablesReference > 0, 'sub-instances are expandable');
    assert.strictEqual(byName('instr').type, 'logic [31:0]');
    // The cursor in module counter → Locals = its instance.
    const ed = await vscode.window.showTextDocument(D.SV(), { viewColumn: vscode.ViewColumn.Beside });
    ed.selection = new vscode.Selection(15, 4, 15, 4);
    await until(async () => (await D.session()).scope === 'dbg_top.u0', 'Locals follow the cursor into counter');
    vars = (await D.custom('variables', { variablesReference: 1 })).variables;
    // The VCS twins (dbg.vcs.fsdb/.wcz) hold no parameters: that simulation dumped without them, so STEP (a parameter in
    // the VCD) is not a signal of the dump there. Every dumped signal must still be listed.
    const fmt = require('./helpers.cjs').format;
    assert.deepStrictEqual(vars.map((v) => v.name).sort(), [...(fmt === 'vcd' ? ['STEP'] : []), 'clk', 'cnt', 'en', 'next', 'rst', 'wrap']);
    // Evaluate uses the same scope.
    assert.strictEqual((await evalRepl('cnt')).result, "8'h02  (8'd2)");
    ed.selection = new vscode.Selection(30, 2, 30, 2);
    await until(async () => (await D.session()).scope === 'dbg_top', 'back to dbg_top');
  },
});
