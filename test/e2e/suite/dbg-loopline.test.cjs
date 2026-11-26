// vscode-port: a SOURCE-LINE breakpoint on a line inside a for loop in an
// always_comb (issue_read_operands.sv `alu_valid_n[i] = 1'b1;`) never stopped and said nothing. Rule: a line breakpoint
// either stops at a cycle where what the line assigns changes, or says at once why it can't (unverified with a reason,
// or "Breakpoint search failed: <reason>"); never a silent run.
// Design I (test/trace/designs/i_drivers.sv line 23: `for (int t = 0; t < 4; t++) pop[t] = valid[t] && pick == 2'(t);`
// in an always_comb; tb_i.sv: pop goes 0000 -> 0010 at t=22 (valid 0110, pick 1)). FSDB (VCS twin) then WCZ, with
// outsideWrites none (the demo folders' setting) and unset (the default).
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const { vscode, assert, until, root } = require('./helpers.cjs');
const fmt = require('./helpers.cjs').format;
const D = require('./dbg-helpers.cjs');

const SRC = () => vscode.Uri.file(path.join(root, 'test/trace/designs/i_drivers.sv'));
const LINE = 23; // 1-based

async function lineStop(opts) {
  const { s } = await D.start({}, '../../trace/dumps/i.icarus.vcd', opts);
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  const n0 = D.sent.length;
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(SRC(), new vscode.Position(LINE - 1, 0)), true)]);
  const bp = await until(async () => {
    const m = D.sent.slice(n0).reverse().find((x) => x.type === 'response' && x.command === 'setBreakpoints' && x.body && x.body.breakpoints && x.body.breakpoints.length === 1);
    return m && m.body.breakpoints.length === 1 ? m.body.breakpoints[0] : null;
  }, 'setBreakpoints answered', 30000);
  const t0 = Date.now();
  const n = D.sent.length;
  // a silent run is the bug: the stop (a hit, or a failed search / no hit with its reason) must come
  const r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), `stop on i_drivers.sv:${LINE}`, 30000);
  const out = D.sent.slice(n).filter((m) => m.type === 'event' && m.event === 'output').map((m) => m.body.output).join('').replace(/\s+/g, ' ');
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  return { bp, reason: r.ev.body.reason, text: r.ev.body.description || r.ev.body.text || '', out, time: r.s.time, ms: Date.now() - t0, entry: s.time };
}

/** A line breakpoint on dbg_top.sv:16 (counter: `else if (en) cnt <= next;`) and continue at once, as a user's
 *  scenario does; setBreakpoints is slowed by `delay` ms (a source link still loading the design). */
async function continueBeforeResolved(delay, wait) {
  await D.start();
  await D.e2e({ kind: 'bpDelay', ms: delay, wait });
  try {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    const nS = D.stops().length;
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(D.SV(), new vscode.Position(15, 0)), true)]);
    const waveShown = () => vscode.window.tabGroups.all.some((g) => g.activeTab && g.activeTab.input instanceof vscode.TabInputCustom && /\.(fsdb|wcz|vcd)$/.test(g.activeTab.input.uri.path));
    const shownBefore = waveShown();
    await vscode.commands.executeCommand('workbench.action.debug.continue');
    const ev = await until(async () => D.stops()[nS], 'stop', 30000, 50);
    await new Promise((r) => setTimeout(r, 1500)); // VS Code opens the frame's source
    const s = await D.session();
    const groups = vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => `${t.label}${t.isActive ? '*' : ''}`).join(','));
    return { reason: ev.body.reason, text: ev.body.description || '', playing: s.playing, time: s.time, shownBefore, shownAfter: waveShown(), groups };
  } finally {
    await D.e2e({ kind: 'bpDelay', ms: 0, wait: 10000 });
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  }
}

module.exports = D.suite({
  // continue right after adding a breakpoint whose resolution is slow
  // waits for it ("Resolving breakpoints…") and stops there; never a silent play without it
  'dbg: continue right after adding a slow-to-resolve line breakpoint waits for it and stops there': async () => {
    const r = await continueBeforeResolved(3000, 10000);
    assert.strictEqual(r.reason, 'breakpoint', JSON.stringify(r));
    assert.ok(!r.playing, JSON.stringify(r));
    // the stop's source opens beside the waveform, never over it
    if (r.shownBefore) { assert.ok(r.shownAfter, 'the waveform stays visible after the stop opens its source: ' + JSON.stringify(r)); }
    assert.ok(r.groups.some((g) => /dbg_top\.sv\*/.test(g)), 'the stop\'s source is visible: ' + JSON.stringify(r));
    console.log(`DBGPENDING wait: ${JSON.stringify(r)}`);
  },
  'dbg: a breakpoint still unresolved after the wait says so (never a silent run)': async () => {
    const r = await continueBeforeResolved(4000, 1000);
    assert.strictEqual(r.reason, 'step', JSON.stringify(r));
    assert.match(r.text, /^Breakpoint at dbg_top\.sv:16 isn't resolved yet/, JSON.stringify(r));
    assert.ok(!r.playing, JSON.stringify(r));
    console.log(`DBGPENDING late: ${JSON.stringify(r)}`);
  },
  // a search longer than ~2 s shows where it is in the status bar, and Pause stops it with where it got to
  'dbg: a slow breakpoint search shows "Searching for … at t of end" and Pause stops it': async () => {
    if (fmt !== 'fsdb' && fmt !== 'wcz') { console.log(`NOT RUN dbg-loopline search note: FSDB / WCZ (windowed search) only (E2E_FORMAT=${fmt})`); return; }
    await D.start();
    await D.e2e({ kind: 'searchDelay', ms: 400 });
    await D.e2e({ kind: 'searchNote', ms: 0 });
    try {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      const n0 = D.sent.length;
      vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('dbg_top.u0.cnt changes', true)]);
      await until(async () => D.sent.slice(n0).some((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'), 'bp set');
      const before = D.stops().length;
      await vscode.commands.executeCommand('workbench.action.debug.continue');
      const note = await until(async () => { const t = await D.e2e({ kind: 'searchNote' }); return /Searching for dbg_top\.u0\.cnt changes… at .+ of .+/.test(t) ? t : null; }, 'search note', 10000, 20);
      await vscode.commands.executeCommand('workbench.action.debug.pause');
      const ev = await until(async () => D.stops()[before], 'stop after Pause', 10000);
      assert.strictEqual(ev.body.reason, 'pause', JSON.stringify(ev.body));
      assert.match(String(ev.body.description || ''), /^Search stopped at /, JSON.stringify(ev.body));
      console.log(`DBGSEARCHNOTE "${note}" -> ${ev.body.description}`);
    } finally {
      await D.e2e({ kind: 'searchDelay', ms: 0 });
      await D.e2e({ kind: 'searchNote', ms: 2000 });
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
  },
  'dbg: a line breakpoint in a for loop in always_comb (design I pop[t]) stops where pop changes, or says why at once': async () => {
    if (fmt !== 'fsdb' && fmt !== 'wcz') { console.log(`NOT RUN dbg-loopline: FSDB / WCZ only (E2E_FORMAT=${fmt}; )`); return; }
    const rows = [];
    for (const ow of ['none', 'unset']) {
      const r = await lineStop(ow === 'unset' ? { outsideWrites: 'unset' } : {});
      rows.push(`${ow}: verified ${r.bp.verified} (${String(r.bp.message || '').slice(0, 160)}); ${r.reason} at ${r.time} in ${r.ms} ms: ${r.text || r.out}`);
      assert.ok(r.bp.verified, `outsideWrites ${ow}: the line resolves (it assigns pop in tb_i.dut): ${JSON.stringify(r.bp)}`);
      // what it watches, where (the hover): pop in the instance (tb_i.dut), never the testbench whose nets share the port names
      assert.match(String(r.bp.message || ''), /watches pop in tb_i\.dut\b/, `outsideWrites ${ow}: it watches pop in tb_i.dut: ${JSON.stringify(r.bp)}`);
      assert.strictEqual(r.reason, 'breakpoint', `outsideWrites ${ow}: stops at the line: ${JSON.stringify(r)}`);
      // pop first changes at 22 ns (the dump counts ps); the stop lands on the posedge at 25 ns
      assert.match(r.out, /at 22,000 ps\b/, `outsideWrites ${ow}: pop first changes at 22 ns: ${JSON.stringify(r)}`);
      assert.strictEqual(r.time, 25000, `outsideWrites ${ow}: lands on the posedge at 25 ns: ${JSON.stringify(r)}`);
    }
    console.log(`DBGLOOPLINE ${fmt}: ${rows.join(' | ')}`);
  },
});
