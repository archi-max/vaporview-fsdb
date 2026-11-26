// vscode-port: value annotation (Verdi "Active Annotation") screenshots: values inline in the SV source at
// the marker, the hover, enum name + raw, the 300-value cap, the debug-session inline values. Owner of the feature:
// the source link (src/cmux/link/source_link.ts) and the debug session's inline values.
// READY FOR MERGE: every scenario skips (logs SKIP, passes) until the vaporview.sourceLink.* commands exist in the
// extension under test, so this file can merge before vsc/link does. slang-server runs only on the Mac: these
// scenarios run there (node test/e2e/run.mjs with E2E_VISUAL=1, VISUAL_HOST=mac) and their baselines live in
// test/visual/baseline-mac/ (Mac window, Mac fonts), separate from the Linux baselines.
// Checks by eye (and asserted where the API allows): values never overlap the code, readable in both themes, and equal
// to the waveform's value at the marker (asserted against waveformViewer.getValuesAtTime).
const fs = require('fs');
const path = require('path');
const t = require('../e2e/suite/helpers.cjs');
const { vscode, assert, until, open, root } = t;

const linkDir = path.join(root, 'test/e2e/fixtures/link');
const dut = vscode.Uri.file(path.join(linkDir, 'dut.sv'));
const tb = vscode.Uri.file(path.join(linkDir, 'tb.sv'));
const ENUM = { '000': 'IDLE', '001': 'FETCH', '100': 'DECODE', '101': 'EXEC', '111': 'DONE' };

async function available(name) {
  const all = await vscode.commands.getCommands(true);
  if (all.includes('vaporview.sourceLink.getInlineValues') && fs.existsSync(path.join(linkDir, 'fsm.vcd'))) { return true; }
  console.log(`SKIP link.visual :: ${name}: vaporview.sourceLink not in this build (vsc/link not merged)`);
  return false;
}
let topSet = false;
async function design() {
  if (topSet) { return; }
  await until(async () => { const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: tb.toString() }); return Array.isArray(r) && r.includes('tb'); }, 'slang top tb', 60000, 1000);
  topSet = true;
}
async function lineOf(uri, re) {
  const doc = await vscode.workspace.openTextDocument(uri);
  for (let i = 0; i < doc.lineCount; i++) { const m = re.exec(doc.lineAt(i).text); if (m) { return { line: i, character: m.index }; } }
  throw new Error(`no ${re}`);
}
async function valueAt(uri, p, time) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: [p] });
  let v = r && r[0] && r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return String(Array.isArray(v) ? v[v.length - 1] : v);
}
// Two marker times where u_ctl.state holds different enum members.
async function twoStates(uri) {
  let t1 = 0, t2 = 0, v1, v2;
  for (let x = 15; x < 600 && !t2; x += 10) {
    const v = (await valueAt(uri, 'tb.dut.u_ctl.state', x)).padStart(3, '0');
    if (!t1 && ENUM[v] && v !== '000') { t1 = x; v1 = v; } else if (t1 && v !== v1 && ENUM[v]) { t2 = x; v2 = v; }
  }
  assert.ok(t1 && t2, `state changes ${t1} ${t2}`);
  return [[t1, v1], [t2, v2]];
}
async function setup() {
  await design();
  const uri = String(await open('link/fsm.vcd'));
  const pos = await lineOf(dut, /state_t state/);
  await vscode.commands.executeCommand('vaporview.sourceLink.addSignal', { uri: dut.toString(), line: pos.line, character: pos.character + 'state_t '.length + 1, waveformUri: uri });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
  return uri;
}
// Every inline value on the state line equals the waveform at the marker.
async function inlineMatches(uri, time, raw) {
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time });
  const stateLine = (await lineOf(dut, /state_t state/)).line;
  return until(async () => {
    const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: dut.toString() });
    const s = (vs || []).find((x) => x.name === 'state' && x.line === stateLine);
    return s && s.value === ENUM[raw] ? vs : null;
  }, `inline state = ${ENUM[raw]} at ${time}`, 30000, 250);
}

module.exports = {
  'link-inline: inline values in dut.sv at the marker, then after a marker move (both themes)': async () => {
    if (!await available('link-inline')) { return; }
    const uri = await setup();
    const [[t1, v1], [t2, v2]] = await twoStates(uri);
    await inlineMatches(uri, t1, v1);
    await t.screenshotThemes('link-inline-a', { view: { fit: uri } });
    await inlineMatches(uri, t2, v2);
    await t.screenshotThemes('link-inline-b', { view: { fit: uri } });
  },
  'link-hover: the hover on state shows the member name and the raw value': async () => {
    if (!await available('link-hover')) { return; }
    const uri = await setup();
    const [[t1, v1]] = await twoStates(uri);
    await inlineMatches(uri, t1, v1);
    const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut), { preserveFocus: false });
    const p = await lineOf(dut, /state_t state/);
    const col = p.character + 'state_t '.length + 1;
    ed.selection = new vscode.Selection(p.line, col, p.line, col);
    await vscode.commands.executeCommand('editor.action.showHover');
    await t.sleep(800);
    await t.screenshotThemes('link-hover', { idle: false, view: { fit: uri } });
  },
  'link-enum: an enum row shows the member name in the waveform and name + raw in the source': async () => {
    if (!await available('link-enum')) { return; }
    const uri = await setup();
    const [[t1, v1]] = await twoStates(uri);
    await inlineMatches(uri, t1, v1);
    await until(async () => (await t.texts('.value-display-item')).some((s) => s.includes(ENUM[v1])), 'value column shows the member');
    await t.screenshotThemes('link-enum', { view: { fit: uri } });
  },
  'link-cap: a long file stops at the 300-value cap without overlapping the code': async () => {
    if (!await available('link-cap')) { return; }
    // Needs a fixture: test/e2e/fixtures/link/long.sv (+ its dump) with >300 referenced
    // signals in view. Until then this scenario is listed as still to add.
    const long = path.join(linkDir, 'long.sv');
    if (!fs.existsSync(long)) { console.log('SKIP link.visual :: link-cap: no fixtures/link/long.sv yet'); return; }
    const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: vscode.Uri.file(long).toString() });
    assert.strictEqual((vs || []).length, 300, 'cap');
    await t.screenshotThemes('link-cap');
  },
  'link-debug: inline values during a debug session ': async () => {
    if (!await available('link-debug')) { return; }
    const all = await vscode.commands.getCommands(true);
    if (!all.some((c) => c.startsWith('vaporview.debug'))) { console.log('SKIP link.visual :: link-debug: vsc/debugger not merged'); return; }
    // Filled in when vsc/debugger merges: start the waveform debug session on fsm.vcd, F10 one cycle, screenshot the
    // editor with the debugger's inline values (VS Code's InlineValuesProvider) next to the Variables view.
    console.log('SKIP link.visual :: link-debug: scenario body lands with vsc/debugger');
  },
};
