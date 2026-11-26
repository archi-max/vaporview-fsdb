// vscode-port: a value breakpoint on a signal the helper COMPUTES (an FSDB open with outsideWrites none:
// VCS does not store design H's 2-driver wire tb_h.dut.bus) ran to the end and never stopped: the helper refuses
// search / edge for computed ids ("a computed signal answers window requests only") and the refusal was lost in the
// search. The debugger now answers them through exact windows, and a search that fails stops the run with the reason.
// FSDB (h.vcs.fsdb, outsideWrites none), then WCZ (the converter stores bus). Truth: tb_h.sv, bus = b (1010) before
// t=30, a (0101) from 30.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until } = require('./helpers.cjs');
const fmt = require('./helpers.cjs').format;
const D = require('./dbg-helpers.cjs');

async function hitOf(label, condition) {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await vscode.commands.executeCommand('vaporview.debugger.first');
  const n0 = D.sent.length;
  vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(label, true, condition)]);
  const bp = await until(async () => { const m = D.sent.slice(n0).reverse().find((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'); return m && m.body.breakpoints.length === 1 ? m.body.breakpoints[0] : null; }, 'setFunctionBreakpoints');
  assert.ok(bp.verified, `${label}${condition ? ' if ' + condition : ''}: ${JSON.stringify(bp)}`);
  const n = D.sent.length;
  const r = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), `stop on ${label}`, 30000);
  const out = D.sent.slice(n).filter((m) => m.type === 'event' && m.event === 'output').map((m) => m.body.output).join('');
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  return { reason: r.ev.body.reason, text: r.ev.body.description || r.ev.body.text || '', out, time: r.s.time };
}

module.exports = D.suite({
  'dbg: a value breakpoint on a computed signal (design H bus, FSDB outsideWrites none) stops at its change; a change breakpoint too': async () => {
    if (fmt !== 'fsdb' && fmt !== 'wcz') { console.log(`NOT RUN dbg-computed: FSDB / WCZ only (E2E_FORMAT=${fmt}; )`); return; }
    const { uri } = await D.start({}, 'trace/h.vcd');
    const eq = await hitOf("tb_h.dut.bus == 4'h5");
    assert.strictEqual(eq.reason, 'breakpoint', JSON.stringify(eq));
    assert.match(eq.out, /Hit .*bus.* at 30\b/, JSON.stringify(eq));
    const ch = await hitOf('tb_h.dut.bus changes');
    assert.strictEqual(ch.reason, 'breakpoint', JSON.stringify(ch));
    assert.match(ch.out, /Hit .*bus.* at 30\b/, JSON.stringify(ch));
    // an SV condition on a computed signal (edge + valueAt): clk changes if bus == 4'h5 -> the first clock change at or
    // after 30
    const cond = await hitOf('tb_h.clk changes', "tb_h.dut.bus == 4'h5");
    assert.strictEqual(cond.reason, 'breakpoint', JSON.stringify(cond));
    assert.match(cond.out, /Hit .* at 3[05]\b/, JSON.stringify(cond));
    // computed reads in a debug session never give a red "file may be damaged" status
    const ws = await vscode.commands.executeCommand('vaporview.e2e.wispState', uri);
    assert.ok(ws && ws.statusLevel !== 'error' && !/damaged|unreadable signals/i.test(String(ws.status || '')), 'status: ' + JSON.stringify(ws && { status: ws.status, statusLevel: ws.statusLevel }));
    console.log(`DBGCOMPUTED ${fmt}: == 4'h5 -> ${eq.out.trim()}; changes -> ${ch.out.trim()}; condition -> ${cond.out.trim()}`);
  },
});
