// vscode-port: in a workspace with no SystemVerilog sources, adding rows must not start slang-server
// (the link's enum lookup skips slang there; before 4acc9c9 every add could start and stop one).
// Runs only as its own invocation: E2E_NOSRC=1 tools/linux-test.sh link-nosrc (run.mjs then opens an empty temp folder
// as the workspace). In the normal suite (workspace = test/e2e/fixtures, which has sources) it prints NOT RUN.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, activate } = require('./helpers.cjs');

const ROWS = ['tb.clk', 'tb.rst', 'tb.go', 'tb.stall', 'tb.a', 'tb.b', 'tb.seed', 'tb.dut.clk', 'tb.dut.rst', 'tb.dut.go'];

async function displayed(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  let n = 0;
  const walk = (xs) => (xs || []).forEach((x) => { n++; walk(x.children); });
  walk(s && s.displayedSignals);
  return n;
}

module.exports = {
  'no SV sources in the workspace: 10 row adds start no slang-server': async () => {
    if (process.env.E2E_NOSRC !== '1') { console.log('NOT RUN link-nosrc: its own invocation, E2E_NOSRC=1 tools/linux-test.sh link-nosrc'); return; }
    await activate();
    const found = await vscode.workspace.findFiles('**/*.{sv,svh,v,vh,svi,svp}', undefined, 1);
    assert.strictEqual(found.length, 0, `the workspace has no SV sources (found ${found.map(String)})`);
    const uri = String(await open('link/fsm.vcd'));
    const s0 = await vscode.commands.executeCommand('vaporview.sourceLink.status');
    for (const p of ROWS) { await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p }); }
    await until(async () => (await displayed(uri)) >= ROWS.length, `${ROWS.length} rows`, 60000, 100);
    await until(async () => (await vscode.commands.executeCommand('vaporview.sourceLink.status')).enumsPending === 0, 'enum lookups done', 60000, 100);
    const s1 = await vscode.commands.executeCommand('vaporview.sourceLink.status');
    const starts = s1.slangCounts.serverStarts - s0.slangCounts.serverStarts;
    const connects = s1.slangCounts.connects - s0.slangCounts.connects;
    console.log(`NOSRC rows=${ROWS.length} slangConnects=${connects} slangServerStarts=${starts}`);
    assert.strictEqual(starts, 0, `slang-server started ${starts} times for ${ROWS.length} adds in a workspace with no SV sources`);
    assert.strictEqual(connects, 0, `the link tried to connect to slang ${connects} times`);
  },
};
