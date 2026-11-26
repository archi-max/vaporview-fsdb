// vscode-port P4 acceptance: stepping (next / stepBack, first / last, play / faster / slower / pause, clock choice) and
// the viewer's marker following every step.
const { vscode, assert, until, sleep } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

module.exports = D.suite({
  'dbg: attach picks clk automatically and stops on cycle 1': async () => {
    const { uri, s } = await D.start();
    assert.strictEqual(s.clock, 'dbg_top.clk');
    assert.strictEqual(s.count, 41);
    assert.strictEqual(s.cycle, 1);
    assert.strictEqual(s.time, 5);
    await D.markerAt(uri, 5);
    const init = D.received.find((m) => m.command === 'initialize');
    assert.ok(init, 'initialize seen');
    const caps = D.sent.find((m) => m.type === 'response' && m.command === 'initialize').body;
    assert.ok(caps.supportsStepBack && caps.supportsDataBreakpoints && caps.supportsConditionalBreakpoints && caps.supportsFunctionBreakpoints);
  },
  'dbg: the user puts the marker back on the first edge (t=5, where the session started) and the session follows': async () => {
    // vscode-port: the session ignored a marker time it had once set itself (the entry stop at 5), forever
    const { uri } = await D.start();
    const r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'), 'stop after next');
    assert.strictEqual(r.s.time, 15); await D.markerAt(uri, 15);
    await sleep(3200); // past the echo window of our own move to 15
    for (const t of [5, 25, 5]) {
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t });
      await until(async () => { const x = await D.session(); return x && x.time === t ? x : null; }, `session time ${t}`, 5000, 100);
    }
  },
  'dbg: right after the entry stop, the marker away and straight back to t=5 (inside the echo window): the session follows': async () => {
    // vscode-port: the entry stop's own echo (t=5, equal to the session's time) was left pending and swallowed the
    // user's move back to 5 within 3 s
    const { uri } = await D.start();
    await D.markerAt(uri, 5);
    for (const t of [25, 5, 15, 5]) {
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t });
      await until(async () => { const x = await D.session(); return x && x.time === t ? x : null; }, `session time ${t}`, 5000, 100);
    }
  },
  'dbg: next (F10) and stepBack move one cycle and the marker follows': async () => {
    const { uri } = await D.start();
    let r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'), 'stop after next');
    assert.strictEqual(r.ev.body.reason, 'step');
    assert.strictEqual(r.s.cycle, 2); assert.strictEqual(r.s.time, 15);
    await D.markerAt(uri, 15);
    r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
    assert.strictEqual(r.s.cycle, 3); await D.markerAt(uri, 25);
    r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepBack'), 'stop after stepBack');
    assert.strictEqual(r.s.cycle, 2); assert.strictEqual(r.s.time, 15);
    await D.markerAt(uri, 15);
    // The single stack frame names the cycle.
    const st = await D.custom('stackTrace', { threadId: 1 });
    assert.match(st.stackFrames[0].name, /^cycle 2 @ 15 ns$/);
  },
  'dbg: first / last cycle': async () => {
    const { uri } = await D.start();
    let r = await D.stopAfter(() => vscode.commands.executeCommand('vaporview.debugger.last'));
    assert.strictEqual(r.s.cycle, 41); assert.strictEqual(r.s.time, 405);
    await D.markerAt(uri, 405);
    r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
    assert.strictEqual(r.s.cycle, 41, 'next at the last cycle stays');
    r = await D.stopAfter(() => vscode.commands.executeCommand('vaporview.debugger.first'));
    assert.strictEqual(r.s.cycle, 1); await D.markerAt(uri, 5);
  },
  'dbg: play at N cycles/s, faster / slower, pause; marker follows': async () => {
    const { uri } = await D.start({ rate: 20 });
    let s = await D.session();
    assert.strictEqual(s.rate, 20);
    await vscode.commands.executeCommand('vaporview.debugger.slower');
    assert.strictEqual((await D.session()).rate, 10);
    await vscode.commands.executeCommand('vaporview.debugger.faster');
    await vscode.commands.executeCommand('vaporview.debugger.faster');
    assert.strictEqual((await D.session()).rate, 50);
    const t0 = Date.now();
    await vscode.commands.executeCommand('vaporview.debugger.togglePlay');
    assert.ok((await D.session()).playing, 'playing');
    assert.ok(D.sent.some((m) => m.type === 'event' && m.event === 'continued'), 'continued event');
    await sleep(400);
    const { ev, s: paused } = await D.stopAfter(() => vscode.commands.executeCommand('vaporview.debugger.togglePlay'), 'pause stop');
    const ms = Date.now() - t0;
    assert.strictEqual(ev.body.reason, 'pause');
    assert.ok(!paused.playing);
    // 50 cycles/s: about ms/20 cycles moved (timer granularity: allow -40% / +2 cycles).
    const moved = paused.cycle - 1;
    assert.ok(moved >= Math.floor(ms / 20 * 0.6) && moved <= Math.ceil(ms / 20) + 2, `moved ${moved} cycles in ${ms} ms at 50/s`);
    await D.markerAt(uri, paused.time);
  },
  'dbg: play runs to the last cycle and stops': async () => {
    const { uri } = await D.start({ rate: 500 });
    const { s } = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'end of play', 15000);
    assert.strictEqual(s.cycle, 41); assert.ok(!s.playing);
    await D.markerAt(uri, 405);
  },
  'dbg: Use Selected Signal as Clock and back to automatic': async () => {
    const { uri } = await D.start();
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'dbg_top.en1' });
    // Selected row (a click in the viewer) ...
    await until(async () => D.e2e({ kind: 'select', uri, path: 'dbg_top.en1' }), 'row to select');
    await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.selectedSignal && /en1/.test(JSON.stringify(v.selectedSignal)); }, 'selection reported');
    await vscode.commands.executeCommand('vaporview.debugger.useSelectedAsClock');
    let s = await D.session();
    assert.strictEqual(s.clock, 'dbg_top.en1');
    assert.strictEqual(s.count, 21, 'en1 rises every other cycle');
    let r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
    const t1 = r.s.time;
    r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
    assert.strictEqual(r.s.time - t1, 20, 'one en1 cycle is 20 ns');
    // ... and from the row's context menu (the row is the argument), and a multi-bit row is refused.
    await vscode.commands.executeCommand('vaporview.debugger.defaultClock');
    assert.strictEqual((await D.session()).clock, 'dbg_top.clk');
    await vscode.commands.executeCommand('vaporview.debugger.useSelectedAsClock', { webviewSection: 'signal', scopePath: 'dbg_top', signalName: 'en1' });
    assert.strictEqual((await D.session()).clock, 'dbg_top.en1');
    await vscode.commands.executeCommand('vaporview.debugger.useSelectedAsClock', { webviewSection: 'signal', scopePath: 'dbg_top', signalName: 'c0' });
    assert.strictEqual((await D.session()).clock, 'dbg_top.en1', 'an 8-bit row is not a clock');
  },
});
