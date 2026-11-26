// vscode-port: cva6-debug scenario, as it runs it (test/visual/readme.visual.cjs cva6Find):
// the workspace E2E_WORKSPACE (cva6-coremark.fsdb, cva6.f, cva6/...), outsideWrites none, cva6.f as the source link's
// build file (slang-server), a source-line breakpoint on issue_read_operands.sv `alu_valid_n[i] = 1'b1;` and continue
// right away. Reports what the breakpoint watches, when it was answered, and the stop (DIAGNOSTIC). Without
// E2E_DEMO_LINE_DUMP: no test.
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const { vscode, assert, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

const DUMP = process.env.E2E_DEMO_LINE_DUMP || '';
const SRC = process.env.E2E_DEMO_LINE_SRC || 'cva6/core/issue_read_operands.sv';
const RE = /alu_valid_n\[i\] = 1'b1;/;
const ms = (t0) => Date.now() - t0;

module.exports = D.suite(DUMP ? {
  'demo line bp (CVA6 debug scenario): stops or says why': async () => {
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = (rel) => vscode.Uri.file(path.join(ws, rel));
    await vscode.workspace.getConfiguration('vaporview.wisp').update('outsideWrites', 'none', vscode.ConfigurationTarget.Workspace);
    if (process.env.E2E_DEMO_LINE_SLANG !== '0') { await vscode.commands.executeCommand('vaporview.sourceLink.useAsBuildFile', file('cva6.f')); }
    const doc = await vscode.workspace.openTextDocument(file(SRC));
    let ln = -1; for (let i = 0; i < doc.lineCount; i++) { if (RE.test(doc.lineAt(i).text)) { ln = i; break; } }
    let t0 = Date.now();
    await D.start({}, file(DUMP));
    const tStart = ms(t0);
    const n0 = D.sent.length;
    t0 = Date.now();
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(ln, 0)), true)]);
    const nS = D.stops().length;
    // as a user does: continue right away, without waiting for the breakpoint to be answered
    await vscode.commands.executeCommand('workbench.action.debug.continue');
    const bp = await until(async () => { const m = D.sent.slice(n0).reverse().find((x) => x.type === 'response' && x.command === 'setBreakpoints' && x.body && x.body.breakpoints && x.body.breakpoints.length === 1); return m ? { b: m.body.breakpoints[0], at: ms(t0) } : null; }, 'line bp answered', 300000, 100).catch(() => null);
    const ev = await until(async () => D.stops()[nS], 'stop', 120000, 200).catch(() => null);
    const tStop = ms(t0);
    const evs = D.sent.slice(n0).filter((m) => m.type === 'event' && (m.event === 'continued' || m.event === 'output')).map((m) => m.event === 'output' ? m.body.output.trim().slice(0, 120) : 'continued').join(' | ');
    const s = await D.session();
    const note = await D.e2e({ kind: 'searchNote' });
    console.log(`  DIAGNOSTIC demo-line ${DUMP}:${ln + 1}: start ${tStart} ms; bp ${bp ? `answered at ${bp.at} ms, verified ${bp.b.verified} (${String(bp.b.message || '').slice(0, 300)})` : 'NOT answered in 300 s'}; ` +
      `${ev ? `stop ${ev.body.reason} "${ev.body.description || ''}" at ${s && s.time} after ${tStop} ms` : `NO STOP in ${tStop} ms (playing ${s && s.playing}, at ${s && s.time}; note "${note}")`}; events: ${evs.slice(0, 600)}`);
    // after the stop the waveform tab showed the dirty dot, and its group
    // showed the empty editor while the source took the other group
    await new Promise((r) => setTimeout(r, 2000));
    const groups = vscode.window.tabGroups.all.map((g) => ({ col: g.viewColumn, active: g.isActive, tabs: g.tabs.map((t) => ({ label: t.label, dirty: t.isDirty, active: t.isActive, kind: t.input && t.input.viewType ? t.input.viewType : (t.input && t.input.uri ? 'text' : typeof t.input) })) }));
    console.log(`  DIAGNOSTIC demo-line groups after stop: ${JSON.stringify(groups)}`);
    const wave = groups.flatMap((g) => g.tabs.map((t) => ({ ...t, col: g.col }))).filter((t) => t.label === path.basename(DUMP));
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await D.stopAll();
    await vscode.workspace.getConfiguration('vaporview.wisp').update('outsideWrites', undefined, vscode.ConfigurationTarget.Workspace);
    // it stops at the line, or says the breakpoint is not resolved yet; never a silent run (play) without it
    assert.ok(ev && (ev.body.reason === 'breakpoint' || /isn't resolved yet/.test(String(ev.body.description || ''))), 'stop or say why: ' + JSON.stringify(ev && ev.body));
    assert.ok(wave.length && wave.every((t) => !t.dirty), 'the waveform tab is not dirty after the stop: ' + JSON.stringify(wave));
    assert.ok(wave.some((t) => t.active), 'the waveform tab is visible (active in its group) after the stop: ' + JSON.stringify(groups));
    assert.ok(groups.some((g) => g.tabs.some((t) => t.label === path.basename(SRC) && t.active)), 'the stopped line\'s source is visible too: ' + JSON.stringify(groups));
  },
} : {});
