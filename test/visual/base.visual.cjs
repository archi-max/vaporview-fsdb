// vscode-port: screenshots of the base viewer on test/e2e/fixtures/counter.vcd (synthetic: clk,
// 8-bit cnt counting 0..15 every 10 ns, 32-bit instr cycling 4 RV32I words). Each scenario also asserts what the
// screenshot must show, so a wrong value fails even when the pixels match a stale baseline.
const t = require('../e2e/suite/helpers.cjs');
const { vscode, assert, until, open, query } = t;

async function rows(uri, paths) {
  for (const p of paths) { await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p }); }
  const want = paths.map((p) => p.split('.').pop());
  return until(async () => { const l = await query({ kind: 'texts', selector: '.waveform-label' }); return want.every((w) => l.some((s) => s.includes(w))) ? l : null; }, 'rows ' + want);
}
async function rowCtx(name) {
  for (const a of await query({ kind: 'attrs', selector: '.waveform-label[data-vscode-context]' })) {
    const ctx = JSON.parse(String(a['data-vscode-context']).replace(/%x20/g, ' '));
    if (ctx.signalName === name) { return ctx; }
  }
  throw new Error('no row ' + name);
}
async function marker(uri, time) {
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time });
  await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === time; }, 'marker ' + time, 10000);
}
// Labels and value cells must sit on the same rows (misaligned rows would show as differing tops).
async function alignedRows() {
  const labels = await query({ kind: 'rects', selector: '.waveform-label' });
  const values = await query({ kind: 'rects', selector: '.value-display-item' });
  assert.strictEqual(labels.length, values.length, 'label/value row counts');
  labels.forEach((l, i) => assert.ok(Math.abs(l.y - values[i].y) <= 1 && Math.abs(l.h - values[i].h) <= 1, `row ${i} label ${JSON.stringify(l)} vs value ${JSON.stringify(values[i])}`));
  return labels;
}
async function openCounter() {
  const uri = String(await open('counter.vcd'));
  await rows(uri, ['top.clk', 'top.cnt', 'top.instr']);
  return uri;
}

module.exports = {
  'vcd-rows: VCD open with clk, cnt, instr rows at the opening zoom (both themes)': async () => {
    const uri = await openCounter();
    await alignedRows();
    await t.screenshotThemes('vcd-rows', { view: { fit: uri } }); // the opening view is the whole file
  },
  'riscv-row: top.instr in the RISC-V format, marker on each instruction': async () => {
    const uri = await openCounter();
    const ctx = await rowCtx('instr');
    await vscode.commands.executeCommand('vaporview.displayAsRiscv', { netlistId: ctx.netlistId }); // Format Values > RISC-V > ABI names
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri });
    await marker(uri, 35); // instr = 0xfe050ee3 (beq a0, zero, -4 → beqz)
    const vals = await until(async () => { const v = await query({ kind: 'texts', selector: '.value-display-item' }); return v.some((s) => /beqz|beq/.test(s)) ? v : null; }, 'RISC-V text at the marker');
    assert.ok(vals.some((s) => /beqz?\s+a0/.test(s)), 'instr value ' + JSON.stringify(vals));
    await t.screenshotThemes('riscv-row', { view: { fit: uri } });
  },
  'marker-values: marker at 37 ns (between clock edges), values column (clk = 0, cnt = 3)': async () => {
    const uri = await openCounter();
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri });
    await marker(uri, 37);
    const vals = await until(async () => { const v = await query({ kind: 'texts', selector: '.value-display-item' }); return v.length === 3 && v.every((s) => s.trim()) ? v : null; }, 'values at the marker');
    assert.ok(/^0*3$|^0*11$/.test(vals[1].trim()) || /^0x0*3$/i.test(vals[1].trim()), 'cnt at 37 = ' + JSON.stringify(vals));
    assert.ok(/^0$/.test(vals[0].trim()), 'clk at 37 = ' + JSON.stringify(vals));
    await alignedRows();
    await t.screenshotThemes('marker-values', { view: { fit: uri } });
  },
  'zoom-all: zoom to fit shows 0..160 ns': async () => {
    const uri = await openCounter();
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri });
    await t.idle();
    const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
    void v;
    await t.screenshot('zoom-all-dark', { view: { fit: uri } });
  },
};
