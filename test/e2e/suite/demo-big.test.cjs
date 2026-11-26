// vscode-port: the big demo design through the installed product (DIAGNOSTIC timings). E2E_DEMO_BIG = the
// demo folder (4-big-design: CVA6 CoreMark under VCS, every signal dumped, FSDB + WCZ, sources + cva6.f). On each dump in
// it: open, add a signal and read it, a Break When Changes breakpoint + steps, the debugger's inline values in the
// signal's source file, and Trace Driver at the breakpoint's change. E2E_DEMO_SIG / E2E_DEMO_SRC / E2E_DEMO_ARGS override
// the signal, its source (relative to the folder) and the trace design arguments. Without E2E_DEMO_BIG: no tests.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), path = require('path');
const { vscode, assert, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');
const w = require('./wisp-common.cjs');

const DIR = process.env.E2E_DEMO_BIG || '';
const SIG = process.env.E2E_DEMO_SIG || 'ariane_tb.dut.i_ariane.i_cva6.pc_id_ex';
const SRC = process.env.E2E_DEMO_SRC || 'cva6/core/cva6.sv';
const ARGS = (process.env.E2E_DEMO_ARGS || '-f cva6.f').split(' ');
const LEAF = SIG.split('.').pop();
const ms = (t0) => Date.now() - t0;
const step = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'), 'step', 120000);
const cont = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop after continue', 300000);

function onFile(name) {
  return async () => {
    const f = path.join(DIR, name);
    assert.ok(fs.existsSync(f), 'no ' + f);
    assert.ok(await w.useHelper('demo ' + name), 'wisp-helper');
    const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
    await cfg.update('wisp.outsideWrites', 'none', G);  // (as the demo folder's settings)
    await cfg.update('trace.designArgs', ARGS, G);
    await cfg.update('trace.designRoot', DIR, G);
    const uri = vscode.Uri.file(f), u = String(uri);
    // open -> netlist
    let t0 = Date.now();
    await vscode.commands.executeCommand('vscode.openWith', uri, 'vaporview.waveformViewer');
    const ws = await until(async () => { const s = await w.wispState(u); return s && s.source ? s : null; }, 'wisp state', 300000, 100);
    assert.strictEqual(ws.refused, null, JSON.stringify(ws).slice(0, 300));
    await until(async () => { const n = await vscode.commands.executeCommand('vaporview.e2e.netlist', u, 6, 50); return n && n.vars && n.vars.length ? n : null; }, 'netlist', 300000, 100);
    const tOpen = ms(t0);
    // add a signal, first value
    t0 = Date.now();
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: u, instancePath: SIG });
    const meta = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri: u });
    const v0 = await until(async () => { const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: u, time: 1000000, instancePaths: [SIG] }); return r && r.length && r[0].value !== undefined ? r : null; }, 'value', 300000, 100);
    const tAdd = ms(t0);
    // debugger: Break When Changes on the PC far into the run, then steps
    t0 = Date.now();
    const { s } = await D.start({}, uri);
    const tAttach = ms(t0);
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(`${SIG} changes`)]);
    t0 = Date.now();
    let r = await cont();
    const tBreak = ms(t0);
    assert.strictEqual(r.ev.body.reason, 'breakpoint');
    const tHit = r.s.time;
    t0 = Date.now();
    r = await step(); r = await step();
    const tStep = ms(t0) / 2;
    assert.ok(r.s.time > tHit, 'stepped past the hit');
    // inline values in picorv32.v (the debugger's, at the stop)
    const src = vscode.Uri.file(path.join(DIR, SRC));
    await vscode.window.showTextDocument(src, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    // what the product does at a stop (default stoppedLine): the stopped line's values painted, the stopped
    // instance read; the cursor on a line naming the PC so the stopped line has values
    const srcText = (await vscode.workspace.openTextDocument(src)).getText().split('\n');
    const atLine = srcText.findIndex((l) => new RegExp('\\b' + LEAF + '\\b').test(l));
    const srcEd = vscode.window.visibleTextEditors.find((e) => String(e.document.uri) === String(src));
    if (srcEd && atLine >= 0) { srcEd.selection = new vscode.Selection(atLine, 0, atLine, 0); }
    await new Promise((res) => setTimeout(res, 500));
    await D.e2e({ kind: 'readsReset' });
    const notes0 = ((await D.e2e({ kind: 'readingNotes' })) || {}).shown || 0;
    const dr0 = ((await D.e2e({ kind: 'dataStats' })) || {}).designReads || 0;
    t0 = Date.now();
    await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'), 'product stop', 120000);
    const painted = await until(async () => { const p = await D.e2e({ kind: 'inlinePainted' }); const rows = p && p.rows && p.rows[String(src)]; return rows && rows.length ? rows : null; }, 'stopped-line values painted', 120000, 100).catch(() => null);
    const tProduct = ms(t0);
    const nReads = ((await D.e2e({ kind: 'reads' })) || []).length;
    const nDesign = (((await D.e2e({ kind: 'dataStats' })) || {}).designReads || 0) - dr0;
    const tPaint = t0 + tProduct;
    // a slow stop is never silent: the status bar said "Reading N signals from the dump…" while it read
    const notesStop = (((await D.e2e({ kind: 'readingNotes' })) || {}).shown || 0) - notes0;
    if (tProduct > 2000) { assert.ok(notesStop > 0, `a ${tProduct} ms stop showed no reading note`); }
    const log = ((await D.e2e({ kind: 'readLog' })) || []).filter((e) => e.at <= tPaint);
    const profile = log.map((e) => `${e.caller} ${e.n} sig ${e.ms < 0 ? 'pending' : e.ms + ' ms'} @+${e.at - t0}`).join(' | ');
    const productNote = `product stop -> stopped-line values painted ${painted ? tProduct + ' ms' : 'NOT painted in ' + tProduct + ' ms'} (${notesStop} reading notes; ${nReads} signals read, ${nDesign} design reads; reads before the paint: ${profile}; line ${atLine + 1}: ${painted ? painted[0].text.slice(0, 60) : '-'}), `;
    t0 = Date.now();
    let inline;
    try {
      inline = await until(async () => { const x = await D.e2e({ kind: 'inline', uri: String(src), first: 0, last: 5000 }); return x && x.length ? x : null; }, 'inline values in ' + SRC, 120000, 200);
    } catch (e) {
      const calls = ((await D.e2e({ kind: 'inlineCalls' })) || []).filter((c) => c.error).slice(-1);
      throw new Error(e.message + (calls.length ? '\n  provider error: ' + calls[0].error.slice(0, 1500) : ''));
    }
    const tInline = ms(t0);
    const pcLine = inline.find((x) => x.text.includes(LEAF + ' = '));
    // #13: the next stop reads the same signals (no new first touch), and a slow first read said so in the status bar
    const notes = (await D.e2e({ kind: 'readingNotes' })) || {};
    await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'), 'second stop', 120000);
    t0 = Date.now();
    const inline2 = await until(async () => { const x = await D.e2e({ kind: 'inline', uri: String(src), first: 0, last: 5000 }); return x && x.length ? x : null; }, 'inline values at the next stop', 120000, 200);
    const tInline2 = ms(t0);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    // a data breakpoint on a port the dump has no values for (E2E_DEMO_UNDUMPED), read through the design
    let undumped = '';
    if (process.env.E2E_DEMO_UNDUMPED) {
      const has = await D.e2e({ kind: 'dumpHas', path: process.env.E2E_DEMO_UNDUMPED });
      const reads0 = ((await D.e2e({ kind: 'dataStats' })) || {}).designReads || 0;
      const n = D.sent.length;
      t0 = Date.now();
      vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(`${process.env.E2E_DEMO_UNDUMPED} changes`)]);
      const bp = await until(async () => { const m = D.sent.slice(n).reverse().find((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'); return m && m.body.breakpoints.length === 1 ? m.body.breakpoints[0] : null; }, 'undumped bp', 600000, 200);
      const tSet = ms(t0);
      const reads = (((await D.e2e({ kind: 'dataStats' })) || {}).designReads || 0) - reads0;
      undumped = `; undumped bp ${process.env.E2E_DEMO_UNDUMPED} (dump has values: ${has}) set in ${tSet} ms, verified ${bp.verified}, ${reads} design reads: ${String(bp.message).slice(0, 200)}`;
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
    // a source-line breakpoint (E2E_DEMO_LINE_BP = "<file relative to the folder>:<1-based line>",
    // e.g. cva6/core/issue_read_operands.sv:755, a line in a for loop in always_comb) stops or says why; never silent
    let lineBp = '';
    if (process.env.E2E_DEMO_LINE_BP) {
      const [lf, ln] = process.env.E2E_DEMO_LINE_BP.split(':');
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      await vscode.commands.executeCommand('vaporview.debugger.first');
      const n0 = D.sent.length;
      t0 = Date.now();
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(path.join(DIR, lf)), new vscode.Position(Number(ln) - 1, 0)), true)]);
      const bp = await until(async () => { const m = D.sent.slice(n0).reverse().find((x) => x.type === 'response' && x.command === 'setBreakpoints' && x.body && x.body.breakpoints && x.body.breakpoints.length === 1); return m ? m.body.breakpoints[0] : null; }, 'line bp answered', 300000, 200).catch(() => null);
      lineBp = `; line bp ${process.env.E2E_DEMO_LINE_BP}: ${bp ? `verified ${bp.verified} in ${ms(t0)} ms (${String(bp.message || '').slice(0, 300)})` : 'NOT answered in 300 s'}`;
      if (bp && bp.verified) {
        const n = D.sent.length;
        t0 = Date.now();
        const hit = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop on the line', 180000).catch(() => null);
        const out = D.sent.slice(n).filter((m) => m.type === 'event' && m.event === 'output').map((m) => m.body.output).join(' ').replace(/\s+/g, ' ').slice(0, 400);
        const wsNow = await w.wispState(u);
        lineBp += hit ? ` -> ${hit.ev.body.reason} at ${hit.s.time} in ${ms(t0)} ms (${hit.ev.body.description || ''} ${out})` : ` -> NO STOP in 180 s (${out}; reads in flight: ${JSON.stringify(((await D.e2e({ kind: 'readLog' })) || []).filter((e) => e.ms < 0).slice(0, 5))})`;
        lineBp += `; status ${wsNow && wsNow.statusLevel || '-'} "${wsNow && wsNow.status || ''}" errors ${JSON.stringify(wsNow && wsNow.signalErrors || []).slice(0, 400)}`;
        if (!hit) {
          // the status bar said where the search was; Pause stops it and says where it got to
          const note = await D.e2e({ kind: 'searchNote' });
          const nP = D.stops().length;
          t0 = Date.now();
          await vscode.commands.executeCommand('workbench.action.debug.pause').then(undefined, () => undefined);
          const ev = await until(async () => D.stops()[nP], 'stop after Pause', 120000, 100).catch(() => null);
          lineBp += `; search note "${note}"; Pause -> ${ev ? `${ev.body.reason} "${ev.body.description || ''}" in ${ms(t0)} ms` : 'NO STOP in 120 s'}`;
        }
      }
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
    // a value breakpoint on a signal the helper computes (E2E_DEMO_COMPUTED_BP, e.g. "<path> == 1"; FSDB under
    // outsideWrites none) stops, or says why; it never runs to the end silently
    let computedBp = '';
    // (several, ';'-separated; each verified first: an unverified one reports its message)
    for (const label of (process.env.E2E_DEMO_COMPUTED_BP && /\.fsdb$/.test(name) ? process.env.E2E_DEMO_COMPUTED_BP.split(';').filter(Boolean) : [])) {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      await vscode.commands.executeCommand('vaporview.debugger.first');
      const n0 = D.sent.length;
      vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(label)]);
      const bp = await until(async () => { const m = D.sent.slice(n0).reverse().find((x) => x.type === 'response' && x.command === 'setFunctionBreakpoints'); return m && m.body.breakpoints.length === 1 ? m.body.breakpoints[0] : null; }, 'setFunctionBreakpoints ' + label, 120000, 100);
      if (!bp.verified) { computedBp += `; bp "${label}": NOT verified (${String(bp.message).slice(0, 200)})`; continue; }
      const n = D.sent.length;
      t0 = Date.now();
      const hit = await D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop on ' + label, 600000);
      const out = D.sent.slice(n).filter((m) => m.type === 'event' && m.event === 'output').map((m) => m.body.output).join(' ').replace(/\s+/g, ' ').slice(0, 300);
      computedBp += `; bp "${label}": ${hit.ev.body.reason} at ${hit.s.time} in ${ms(t0)} ms (${out})`;
      if (hit.ev.body.reason === 'breakpoint') {
        // where the stop opens (Trace's driver, else the declaration; never line 1), Locals' scope
        // and names (no slang-internal unnamed$$_N), and the status the session's reads leave (which errors, if red)
        const where = await until(async () => { const x = await D.e2e({ kind: 'stopLocation' }); return x && x.loc !== undefined ? x : null; }, 'stop location', 180000, 200).catch(() => null);
        const st = (await D.custom('stackTrace', { threadId: 1 })).stackFrames[0] || {};
        const sc = (await D.custom('scopes', { frameId: 1 })).scopes;
        const lv = (await D.custom('variables', { variablesReference: sc[0].variablesReference })).variables;
        const wsNow = await w.wispState(u);
        computedBp += ` [frame ${st.source ? st.source.path.split('/').pop() + ':' + st.line : 'no source'} (${where ? JSON.stringify(where.loc) : 'not answered'}); locals ${where && where.scope} ${lv.length}: ${lv.slice(0, 8).map((v) => v.name + '=' + String(v.value).slice(0, 40)).join(', ')}` +
          `${lv.some((v) => /unnamed\$\$/.test(v.name)) ? ' (GENERATED NAME SHOWN)' : ''}; status ${wsNow && wsNow.statusLevel || '-'} "${wsNow && wsNow.status || ''}" errors ${JSON.stringify(wsNow && wsNow.signalErrors || []).slice(0, 600)}]`;
      }
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
    await D.stopAll();
    // Trace Driver at the breakpoint's change of the PC
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri: u, time: tHit });
    await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri: u }); return v && v.markerTime === tHit; }, 'marker', 30000);
    t0 = Date.now();
    const tr = await vscode.commands.executeCommand('vaporview.traceDriver', { uri: u, path: SIG });
    const tTrace = ms(t0);
    assert.ok(tr && !tr.error, 'trace: ' + JSON.stringify(tr).slice(0, 400));
    console.log(`  DIAGNOSTIC demo ${name}: open ${tOpen} ms, add+value ${tAdd} ms (${SIG}=${JSON.stringify(v0[0].value)}), attach ${tAttach} ms (clock ${s.clock}), ` +
      `break when changes ${tBreak} ms (t=${tHit}), step ${tStep.toFixed(0)} ms, ${productNote}harness full-file inline ${inline.length} lines in ${tInline} ms (${pcLine ? pcLine.text.slice(0, 80) : 'no ' + LEAF + ' line'}), ` +
      `next stop inline ${inline2.length} lines in ${tInline2} ms, reading notes shown ${notes.shown || 0} ("${notes.last || ''}"), ` +
      `trace driver ${tTrace} ms -> ${JSON.stringify([tr.signal, tr.time, tr.driver && tr.driver.kind, tr.stmt && tr.stmt.src]).slice(0, 200)}; end ${meta && meta.timeEnd}${undumped}` + lineBp + computedBp);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  };
}

const dumps = DIR && fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /\.(fsdb|wcz)$/.test(f)).sort((a, b) => (a.endsWith('.fsdb') ? 0 : 1) - (b.endsWith('.fsdb') ? 0 : 1) || a.localeCompare(b)) : [];
module.exports = DIR ? D.suite(Object.fromEntries(dumps.map((f) => [`demo big ${f}: open, add, debugger, inline values, Trace Driver`, onFile(f)]))) : {};
