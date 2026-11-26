// vscode-port P5b acceptance: Trace Driver and Trace to Root in a real VS Code, on the live cmux-sv-model
// sidecar (built from media/cmux/sv-model) and VaporView's own VCD reader. The answers checked are the ones cmux's
// case suite pins for the same designs and dumps (test/trace/cases.js: design A chain 1, design P M1 C).
const path = require('path');
const { vscode, assert, until, open, query, root, sleep } = require('./helpers.cjs');

const dir = path.join(root, 'test/e2e/fixtures/trace');
const { sameTwin, FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');
const fx = (n) => vscode.Uri.file(path.join(dir, n));
// The dump a test opens: under E2E_FORMAT (fsdb | wcz) its twin converted from the VCD (format.cjs sameTwin: the expected answers are the VCD's), read through wisp-helper .
async function dump(n) {
  if (FORMAT) { assert.ok(await useHelper('trace driver on ' + FORMAT), 'wisp-helper for E2E_FORMAT=' + FORMAT); }
  return vscode.Uri.file(sameTwin(path.join(dir, n)));
}
const panel = async (q) => { const r = await vscode.commands.executeCommand('vaporview.e2e.tracePanel', q); if (r && r.error) { throw new Error('tracePanel: ' + r.error); } return r; };
const state = () => vscode.commands.executeCommand('vaporview.e2e.traceState');
// The sidecar may need a first build on a new machine (minutes); a loaded design answers in well under a second.
const LONG = 30 * 60 * 1000;

async function design(f) {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  await cfg.update('trace.designArgs', ['-f', f], vscode.ConfigurationTarget.Global);
  await cfg.update('trace.designRoot', dir, vscode.ConfigurationTarget.Global);
}
async function openA() {
  await design('a.f');
  const uri = String(await open(await dump('a.vcd')));
  await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'tb_a.dut.dout' });
  await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).some((s) => /dout/.test(s)), 'dout row');
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 60 });
  await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === 60 ? v : null; }, 'marker at 60', 10000);
  return uri;
}
async function rowContext(name) {
  const attrs = await query({ kind: 'attrs', selector: '.waveform-label[data-vscode-context]' });
  for (const a of attrs) {
    const ctx = JSON.parse(String(a['data-vscode-context']).replace(/%x20/g, ' '));
    if (ctx.signalName === name) { return ctx; }
  }
  throw new Error('no row ' + name);
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

// (the trace.* settings this suite sets are put back when it ends: trace-settings-guard.cjs)
module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  'Trace Driver from a waveform row at the marker: statement, branch taken, fan-in (cmux case A dout@60)': async () => {
    const uri = await openA();
    const ctx = await rowContext('dout');
    // What VS Code passes a webview/context command: the row's data-vscode-context, plus the document.
    const st = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', Object.assign({ uri }, ctx)), LONG, 'trace driver');
    assert.ok(st && !st.error, 'step: ' + JSON.stringify(st));
    assert.deepStrictEqual([st.signal, st.time, st.driver.kind, st.procKind, st.stmt.src, st.activation.time, st.sample, st.since, st.value, st.trust, path.basename(st.stmt.loc.file), st.stmt.loc.line],
      ['tb_a.dut.dout', 60, 'proc', 'AlwaysFF', 'dout <= stage;', 55, 54, 55, 'xxxxxxxx', 'exact', 'a_uninit.sv', 34]);
    assert.deepStrictEqual(st.decisions.map((d) => [d.src, d.taken]), [['!rst_n', 'else']]);
    // The panel shows it.
    await until(async () => (await panel({ kind: 'texts', selector: '.stmt' })).includes('dout <= stage;'), 'panel statement');
    const dec = await panel({ kind: 'texts', selector: '.decision' });
    assert.ok(dec.some((t) => /!rst_n/.test(t) && /else/i.test(t)), 'branch: ' + JSON.stringify(dec));
    const fan = await panel({ kind: 'attrs', selector: 'tr.fanin' });
    const paths = fan.map((a) => a.path);
    for (const p of ['tb_a.dut.stage', 'tb_a.dut.rst_n', 'tb_a.dut.clk']) { assert.ok(paths.includes(p), 'fan-in ' + p + ': ' + JSON.stringify(paths)); }
    const vals = await panel({ kind: 'texts', selector: 'tr.fanin td.value' });
    assert.strictEqual(vals[paths.indexOf('tb_a.dut.stage')], "8'bxxxxxxxx");
  },
  'Trace Driver: one more step per click, Back/Forward (cmux case A stage@54)': async () => {
    await openA();
    await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { path: 'tb_a.dut.dout' }), LONG, 'trace driver');
    await until(async () => (await panel({ kind: 'count', selector: 'tr.fanin' })) > 0, 'fan-in rows');
    const paths = (await panel({ kind: 'attrs', selector: 'tr.fanin' })).map((a) => a.path);
    await panel({ kind: 'click', selector: 'tr.fanin', index: paths.indexOf('tb_a.dut.stage') });
    const s2 = await until(async () => { const s = await state(); return s.step && s.step.signal === 'tb_a.dut.stage' ? s : null; }, 'stage step');
    assert.deepStrictEqual([s2.step.time, s2.step.stmt.src, s2.step.since, s2.step.trust, s2.step.decisions.map((d) => [d.src, d.taken])], [54, 'stage = tmp;', 45, 'computed', [['valid_q', 'then']]]);
    await until(async () => (await panel({ kind: 'texts', selector: '.stmt' })).includes('stage = tmp;'), 'panel shows the next step');
    await panel({ kind: 'click', selector: 'button.back' });
    await until(async () => { const s = await state(); return s.step && s.step.signal === 'tb_a.dut.dout'; }, 'back to dout');
    await panel({ kind: 'click', selector: 'button.forward' });
    await until(async () => { const s = await state(); return s.step && s.step.signal === 'tb_a.dut.stage'; }, 'forward to stage');
  },
  'Trace Driver: open the statement in the editor, add the fan-in to the waveform': async () => {
    const uri = await openA();
    await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { path: 'tb_a.dut.dout' }), LONG, 'trace driver');
    await until(async () => (await panel({ kind: 'count', selector: '.driver a.loc' })) > 0, 'statement link');
    await panel({ kind: 'click', selector: '.driver a.loc' });
    const ed = await until(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath.endsWith('a_uninit.sv')), 'a_uninit.sv open');
    assert.strictEqual(ed.selection.start.line + 1, 34, 'selection line');
    // TR4: the source opens in another column; the trace panel stays visible.
    const sp = await state();
    assert.ok(sp.panelColumn !== undefined && ed.viewColumn !== sp.panelColumn, `source column ${ed.viewColumn} vs panel ${sp.panelColumn}`);
    assert.strictEqual(sp.panelVisible, true, 'trace panel still visible');
    await panel({ kind: 'click', selector: 'button.addfanin' });
    const labels = await until(async () => { const l = await query({ kind: 'texts', selector: '.waveform-label' }); return ['stage', 'rst_n', 'clk'].every((n) => l.some((s) => s.includes(n))) ? l : null; }, 'fan-in rows in the waveform');
    assert.ok(labels.some((s) => s.includes('stage')));
    void uri;
  },
  'Trace Driver from the SystemVerilog editor (signal under the cursor, marker time)': async () => {
    await openA();
    const doc = await vscode.workspace.openTextDocument(fx('a_uninit.sv'));
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const line = doc.lineAt(33).text; // `else        dout <= stage;`
    const col = line.indexOf('dout');
    ed.selection = new vscode.Selection(33, col + 1, 33, col + 1);
    const st = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriverFromEditor'), LONG, 'trace from editor');
    assert.ok(st && !st.error, JSON.stringify(st));
    assert.deepStrictEqual([st.signal, st.time, st.stmt.src, st.trust], ['tb_a.dut.dout', 60, 'dout <= stage;', 'exact']);
  },
  'Trace to Root: automatic chain to the root cause, exact/approximate labels, ranked causes (cmux case P sg2@440)': async () => {
    await design('p.f');
    const uri = String(await open(await dump('p.vcd')));
    const out = await withTimeout(vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_p.dut.sg2', time: 440 }), LONG, 'trace to root');
    assert.ok(out && !out.error, JSON.stringify(out));
    const crow = [out.end.code, out.steps.map((e) => [e.signal.replace(/^tb_p\./, ''), e.time, e.why.code, e.trust])];
    assert.deepStrictEqual(crow, ['testbench', [['dut.sg2', 440, 'start', 'exact'], ['dut.nx2', 434, 'only', 'exact'], ['dut.sg2', 35, 'held', 'exact'], ['dut.nx2', 32, 'xSince', 'exact'], ['dut.flit', 32, 'only', 'exact'], ['flit', 32, 'only', 'approximate']]]);
    assert.deepStrictEqual([out.root, out.approximate], [5, true]);
    // TR5: started without a row, the chain puts its start signal in the waveform and the marker at the start time.
    await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).some((s) => s.includes('sg2')), 'start signal row');
    await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === 440 ? v : null; }, 'marker at 440', 10000);
    // TR2: the root mark sits in the trust cell (no extra column), and no chain cell wraps.
    assert.strictEqual(await panel({ kind: 'count', selector: 'tr.xstep td.trust .rootbadge' }), 1, 'root next to the trust badge');
    assert.strictEqual(await panel({ kind: 'count', selector: 'tr.xstep > td.rootbadge' }), 0, 'no extra root cell');
    // The panel: one row per step, the root marked, the chain's label, why it ended.
    const rows = await until(async () => { const r = await panel({ kind: 'attrs', selector: 'tr.xstep' }); return r.length === 6 ? r : null; }, 'chain rows');
    assert.ok(/root/.test(rows[5].className), 'root row');
    assert.deepStrictEqual(rows.map((r) => r.trust), ['exact', 'exact', 'exact', 'exact', 'exact', 'approximate']);
    const badge = await panel({ kind: 'attrs', selector: '.head .badge' });
    assert.ok(badge.some((b) => /approximate/.test(b.className)), 'chain label approximate: ' + JSON.stringify(badge));
    const end = await panel({ kind: 'attrs', selector: '.end' });
    assert.strictEqual(end[0].code, 'testbench');
    // Each step has its cmux step (statement, fan-in) and, where several inputs had x, its ranked causes.
    assert.ok(out.steps.every((e) => e.step && e.step.signal === e.signal));
    const st = await state();
    assert.ok(st.chain && st.chain.steps.length === 6);
  },
  'Trace to Root: a step opens its statement, moves the marker and adds its signal; Add to Waveform adds the chain': async () => {
    await design('p.f');
    const uri = String(await open(await dump('p.vcd')));
    await withTimeout(vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_p.dut.sg2', time: 440 }), LONG, 'trace to root');
    await until(async () => (await panel({ kind: 'count', selector: 'tr.xstep' })) === 6, 'chain rows');
    await panel({ kind: 'click', selector: 'tr.xstep', index: 2 }); // dut.sg2 @35, held
    const groups = () => JSON.stringify(vscode.window.tabGroups.all.map((g) => [g.viewColumn, g.isActive, g.tabs.map((t) => t.label)]));
    const ph = await until(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath.endsWith('p_hold.sv')), 'p_hold.sv open').catch(async (e) => {
      throw new Error(`${e.message}; groups ${groups()}; trace ${JSON.stringify((await state()).panelColumn)}`);
    });
    const sx = await state();
    assert.ok(ph.viewColumn !== sx.panelColumn && sx.panelVisible, `TR4: source column ${ph.viewColumn} vs panel ${sx.panelColumn}, visible ${sx.panelVisible}`);
    // (and after the step put its signal in the waveform, the source is still showing)
    await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).some((s) => s.includes('sg2')), 'sg2 row (before the source check)');
    assert.ok(vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath.endsWith('p_hold.sv')), 'source still visible: ' + groups());
    await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).some((s) => s.includes('sg2')), 'sg2 row');
    const v = await until(async () => {
      const r = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
      const t = r && r.markerTime;
      return t === 35 ? r : null;
    }, 'marker at 35');
    assert.ok(v);
    await panel({ kind: 'click', selector: 'button.xadd' });
    await until(async () => { const l = await query({ kind: 'texts', selector: '.waveform-label' }); return ['sg2', 'nx2', 'flit'].every((n) => l.some((s) => s.includes(n))); }, 'chain signals in the waveform');
  },
});
