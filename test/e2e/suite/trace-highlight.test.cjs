// vscode-port: the driver highlight. A selected signal (its waveform row, or the editor cursor on
// its name) marks every source line that assigns it; the statement driving it at the marker is marked strongly, with
// "drives <sig> at <t>". FSDB then WCZ (E2E_FORMAT): the twins converted from the fixtures' VCDs.
const fs = require('fs');
const path = require('path');
const { vscode, assert, until, open, root } = require('./helpers.cjs');
const { sameTwin, FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');

const dir = path.join(root, 'test/e2e/fixtures/trace');
const hl = (a) => vscode.commands.executeCommand('vaporview.e2e.driverHighlight', a);
const brief = (h) => h && h.all ? { all: h.all.map((r) => [path.basename(r.file), r.line]).sort((a, b) => a[1] - b[1]), active: h.active && [path.basename(h.active.file), h.active.line], note: h.note } : h;

async function useDesign(f) {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  await cfg.update('trace.designArgs', ['-f', f], vscode.ConfigurationTarget.Global);
  await cfg.update('trace.designRoot', dir, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('vaporview.e2e.traceReset');
}
/** Whether the waveform's tab shows the unsaved dot (the highlight must never dirty it; dbg-dirty.test.cjs). */
function dirty(uri) {
  for (const g of vscode.window.tabGroups.all) { for (const t of g.tabs) { if (t.input && t.input.uri && String(t.input.uri) === uri) { return t.isDirty; } } }
  throw new Error('no tab for ' + uri);
}
const clean = async (uri, what) => { await new Promise((r) => setTimeout(r, 400)); assert.strictEqual(dirty(uri), false, 'the waveform is dirty after ' + what); };
async function openTwin(vcd) {
  if (FORMAT) { assert.ok(await useHelper('driver highlight on ' + FORMAT), 'wisp-helper for E2E_FORMAT=' + FORMAT); }
  return String(await open(vscode.Uri.file(sameTwin(path.join(dir, vcd)))));
}
/** The marker moved as the debugger moves it (not the user's edit: no unsaved dot), so a dot afterwards is the highlight's. */
async function marker(uri, time) {
  assert.ok(await hl({ quietMarker: time, uri }), 'quiet marker: no viewer for ' + uri);
  await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === time; }, 'marker at ' + time, 10000);
}
/** Selects `p` as the waveform does (its signalSelect event) and waits for the highlight to settle. */
async function select(uri, p, want) {
  await hl({ fire: true, uri, path: p });
  try {
    return await until(async () => { const h = await hl(); return h && !h.pending && (want ? want(h) : true) ? h : null; }, 'highlight of ' + p, 180000, 50);
  } catch (e) { throw new Error(e.message + ' | state ' + JSON.stringify(await hl())); }
}

// (the trace.* settings this suite sets are put back when it ends: trace-settings-guard.cjs)
module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  'Driver highlight: a selected row marks both assigning lines of dout, line 34 drives it at 60 (33 at 15); cleared with the selection': async () => {
    await useDesign('a.f');
    const uri = await openTwin('a.vcd');
    await marker(uri, 60);
    // (bound: the first select paints within 10 s of the waveform being open, the design load included)
    const t0 = Date.now();
    const h = await select(uri, 'tb_a.dut.dout', (x) => x.active && x.time === 60);
    const firstMs = Date.now() - t0;
    assert.ok(firstMs <= 10000, `first select painted in ${firstMs} ms (bound 10 s)`);
    console.log(`  DIAGNOSTIC driver highlight ${FORMAT || 'vcd'} first select ${firstMs} ms (design load included)`);
    assert.deepStrictEqual(brief(h), { all: [['a_uninit.sv', 33], ['a_uninit.sv', 34]], active: ['a_uninit.sv', 34], note: 'drives dout at 60' + (h.unit ? ' ' + h.unit : '') }, JSON.stringify(h));
    // The marker moves: the highlight follows it (the reset branch drives dout at 15).
    await marker(uri, 15);
    const h15 = await until(async () => { const x = await hl(); return x && x.time === 15 ? x : null; }, 'highlight at 15', 60000, 50);
    assert.deepStrictEqual(brief(h15).active, ['a_uninit.sv', 33], JSON.stringify(h15));
    // No row selected: nothing marked.
    await hl({ fire: true, uri, path: '' });
    await until(async () => { const x = await hl(); return x && x.none === 'cleared' ? x : null; }, 'highlight cleared', 10000, 50);
    await clean(uri, 'a row select, a marker move and a clear');
    console.log(`  DIAGNOSTIC driver highlight ${FORMAT || 'vcd'} dout: ${JSON.stringify(brief(h))}`);
  },

  'Driver highlight: the editor cursor on a signal name marks its drivers (dout, at the marker)': async () => {
    await useDesign('a.f');
    const uri = await openTwin('a.vcd');
    await marker(uri, 60);
    const sv = await vscode.workspace.openTextDocument(path.join(dir, 'a_uninit.sv'));
    const ed = await vscode.window.showTextDocument(sv, { preview: false });
    const line = 33; // (0-based: "else        dout <= stage;")
    const col = sv.lineAt(line).text.indexOf('dout') + 1;
    ed.selection = new vscode.Selection(line, col, line, col);
    const h = await until(async () => { const x = await hl(); return x && x.signal === 'tb_a.dut.dout' && x.time === 60 ? x : null; }, 'highlight from the cursor', 60000, 50);
    assert.deepStrictEqual(brief(h).active, ['a_uninit.sv', 34], JSON.stringify(h));
    // What the editor shows: a dim bar on 33, the full bar on 34 with its note.
    const painted = await vscode.commands.executeCommand('vaporview.e2e.driverHighlight', { painted: sv.uri.toString() });
    assert.deepStrictEqual(painted, { dim: [33], active: [34], notes: [{ line: 34, text: h.note }] }, JSON.stringify(painted));
    // Off a signal name: cleared.
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    await until(async () => { const x = await hl(); return x && x.none ? x : null; }, 'highlight cleared off a name', 10000, 50);
    const gone = await vscode.commands.executeCommand('vaporview.e2e.driverHighlight', { painted: sv.uri.toString() });
    assert.deepStrictEqual(gone, { dim: [], active: [], notes: [] }, 'cleared: ' + JSON.stringify(gone));
    await clean(uri, 'the cursor highlight');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },

  'Driver highlight: a bus with two drivers marks both assigns, the enabled one drives it (design H)': async () => {
    let file;
    try { file = sameTwin(path.join(dir, 'h.vcd')); } catch (e) { console.log('NOT RUN driver highlight multi-driver: ' + e.message); return; }
    if (!fs.existsSync(file)) { console.log('NOT RUN driver highlight multi-driver: no twin ' + file); return; }
    await useDesign('h.f');
    const uri = await openTwin('h.vcd');
    for (const [t, line] of [[45, 11], [25, 12]]) {
      await marker(uri, t);
      const h = await select(uri, 'tb_h.dut.bus', (x) => x.time === t && x.signal === 'tb_h.dut.bus');
      const b = brief(h);
      assert.deepStrictEqual(b.all.filter((r) => r[0] === 'h_bus.sv').map((r) => r[1]), [11, 12], JSON.stringify(h));
      assert.deepStrictEqual(b.active, ['h_bus.sv', line], `bus @${t}: ` + JSON.stringify(h));
    }
  },

  'Driver highlight with no marker (a restored session): dim lines only, no active line, no "at 0" note; a marker event without a time keeps it so': async () => {
    await useDesign('a.f');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const uri = await openTwin('a.vcd');
    const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
    assert.ok(v && (v.markerTime === null || v.markerTime === undefined), 'a fresh waveform has no marker: ' + JSON.stringify(v && v.markerTime));
    const h = await select(uri, 'tb_a.dut.dout', (x) => !!x.all && x.signal === 'tb_a.dut.dout');
    assert.deepStrictEqual(brief(h), { all: [['a_uninit.sv', 33], ['a_uninit.sv', 34]], active: null, note: null }, JSON.stringify(h));
    // (a restored session's marker event carries no time: never read as 0)
    await hl({ fireMarker: { time: null }, uri });
    await new Promise((r) => setTimeout(r, 600));
    const h2 = await hl();
    assert.ok(h2 && h2.all && !h2.active && !h2.note && h2.time === null, 'no marker after a time-less marker event: ' + JSON.stringify(h2));
    // A marker: the active line and its note.
    await marker(uri, 60);
    const h3 = await until(async () => { const x = await hl(); return x && x.time === 60 ? x : null; }, 'highlight at 60', 60000, 50);
    assert.deepStrictEqual(brief(h3).active, ['a_uninit.sv', 34], JSON.stringify(h3));
    // (CVA6: a save of the session sends a time-less marker event; the viewer still has its marker at 60, so the
    // active line stays, never dropped to dim lines with time null)
    await hl({ fireMarker: { time: null }, uri });
    await new Promise((r) => setTimeout(r, 600));
    const h4 = await until(async () => { const x = await hl(); return x && !x.pending ? x : null; }, 'highlight after a time-less event', 60000, 50);
    assert.ok(h4.time === 60 && h4.active && h4.active.line === 34, 'the marker kept after a time-less marker event: ' + JSON.stringify(h4));
  },

  // (CVA6 alu_valid_n, written by a default and inside a for loop the design model keeps whole: dim lines only,
  // the loop's write unmarked. The marker moved by the extension's public command, waveformViewer.setMarker, as an
  // extension or the debugger's API user moves it.)
  'Driver highlight: a write inside a for loop (design L): the loop is marked, and drives v while it writes it; the public setMarker command moves it': async () => {
    await useDesign('l.f');
    const uri = await openTwin('l.vcd');
    const at = async (time) => {
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time });
      await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === time; }, 'marker at ' + time, 10000);
    };
    await at(15);
    const h = await select(uri, 'tb_l.dut.v', (x) => x.time === 15);
    const b = brief(h);
    // (both writes marked: the default on 8 and the loop (9-13), or with a model that unrolls it, the write on 11)
    assert.ok(b.all.some(([f, l]) => f === 'l_loop.sv' && l === 8), 'line 8 marked: ' + JSON.stringify(h));
    assert.ok(b.all.some(([f, l]) => f === 'l_loop.sv' && (l === 9 || l === 11)), 'the loop\'s write marked: ' + JSON.stringify(h));
    // at 15 v = 2'b10, from the loop (i = 1): the loop (or its write) is the active line, never none
    assert.ok(b.active && b.active[0] === 'l_loop.sv' && (b.active[1] === 9 || b.active[1] === 11), 'active in the loop at 15: ' + JSON.stringify(h));
    // the marker moved by the command again: the highlight follows (at 25 v = 0, from line 8)
    await at(25);
    const h25 = await until(async () => { const x = await hl(); return x && !x.pending && x.time === 25 ? x : null; }, 'highlight at 25', 60000, 50);
    assert.deepStrictEqual(brief(h25).active, ['l_loop.sv', 8], JSON.stringify(h25));
    await hl({ fire: true, uri });
  },
  // (CVA6 alu_valid_q: a marker, dim lines and no note at all. A step that fails, as a read that fails or times
  // out on a large FSDB, says so on the first marked line.)
  'Driver highlight: a step that fails shows "driver unknown at <t>: <why>", never dim lines alone': async () => {
    await useDesign('a.f');
    const uri = await openTwin('a.vcd');
    await marker(uri, 60);
    await hl({ failStep: 'read timed out (e2e)' });
    try {
      const h = await select(uri, 'tb_a.dut.dout', (x) => x.time === 60);
      assert.strictEqual(h.active, null, JSON.stringify(h));
      assert.strictEqual(h.note, 'driver unknown at 60' + (h.unit ? ' ' + h.unit : '') + ': read timed out (e2e)', JSON.stringify(h));
    } finally { await hl({ failStep: null }); }
    // (the step back: the active line and its note again)
    const ok = await select(uri, 'tb_a.dut.dout', (x) => x.active && x.time === 60);
    assert.ok(/^drives dout at 60/.test(ok.note), JSON.stringify(ok));
    await hl({ fire: true, uri });
  },
  'Driver highlight: no design chosen, nothing marked and nothing asked': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview');
    const link = vscode.workspace.getConfiguration('vaporview.sourceLink');
    const before = link.get('elaborate');
    await cfg.update('trace.designArgs', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('trace.designRoot', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vaporview.sourceLink.clearBuildFile').then(undefined, () => false);
    await vscode.commands.executeCommand('vaporview.sourceLink.resetTopLevel').then(undefined, () => false);
    await link.update('elaborate', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset');
    try {
      const uri = await openTwin('a.vcd');
      await marker(uri, 60);
      // (Trace's own history from earlier suites stays as it was: the highlight adds no step to it)
      const s0 = JSON.stringify(await vscode.commands.executeCommand('vaporview.e2e.traceState'));
      // (only this select's answer: a selection left by an earlier suite without a uri (the editor cursor) is re-run on the
      // marker move above and can answer noWaveform while the reopened waveform is not the active one yet)
      const h = await select(uri, 'tb_a.dut.dout', (x) => x.none === 'noDesign');
      assert.deepStrictEqual(h, { none: 'noDesign' }, JSON.stringify(h));
      const s1 = JSON.stringify(await vscode.commands.executeCommand('vaporview.e2e.traceState'));
      assert.strictEqual(s1, s0, 'no Trace step was made');
    } finally {
      await link.update('elaborate', before, vscode.ConfigurationTarget.Global);
    }
  },
});
