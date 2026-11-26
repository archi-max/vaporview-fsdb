// vscode-port wave 1 , cmux extras that need the slang link: Split > By Declared Dimensions and Add All
// Signals in Scope from the SystemVerilog editor; also the "no cmux in UI strings" rule for media/cmux/strings.js.
// Fixture: test/e2e/fixtures/link-extras (xtb.sv + xtb.vcd, synthetic, from gen.py). Needs slang-server (as link-p5).
// Named link-* so it runs after the dbg-* tests: it sets slang's top level to xtb, and link-p5/link-perf set their own.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, closeAll, root, activate } = require('./helpers.cjs');
const { page, pageReady } = require('./bridge-helpers.cjs');
const fs = require('fs');
const path = require('path');

const dir = path.join(root, 'test/e2e/fixtures/link-extras');
const sv = vscode.Uri.file(path.join(dir, 'xtb.sv'));

async function setup() {
  await closeAll();
  await until(async () => {
    const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: sv.toString() });
    return Array.isArray(r) && r.includes('xtb');
  }, 'slang top level xtb', 60000, 1000);
  const uri = String(await open('link-extras/xtb.vcd'));
  await pageReady();
  return uri;
}
async function rows(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  const all = [];
  const walk = (xs) => (xs || []).forEach((x) => { all.push(x); walk(x.children); });
  walk(s && s.displayedSignals);
  return all;
}
const fullName = (r) => r.name; // saved rows: name = the full instance path (slices: their custom name)
const shownIn = async (uri, scope) => (await rows(uri)).filter((r) => r.dataType === 'netlist-variable' && String(r.name).startsWith(scope + '.')).map(fullName);
async function add(uri, p) {
  await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p });
  await until(async () => (await rows(uri)).some((r) => fullName(r) === p), 'row ' + p);
}
// The webview context VS Code passes to a row's menu commands (the label's data-vscode-context).
const rowContext = (signalName) => until(() => page((c, a) => {
  for (const el of document.querySelectorAll('[data-vscode-context]')) {
    try {
      const x = JSON.parse(el.getAttribute('data-vscode-context').replace(/%x20/g, ' '));
      if (x.webviewSection === 'signal' && x.signalName === a.name && x.cmuxSliceName === a.name) { return x; }
    } catch { /* not JSON */ }
  }
  return null;
}, { name: signalName }), 'row context ' + signalName);
// A row's slices as saved: [name, msb, lsb, [its slices]] with the source bits of the dumped signal.
const slices = (row) => ((row && row.cmuxSlices && row.cmuxSlices.children) || []).map((c) =>
  [c.customName, c.source[0].msb, c.source[0].lsb].concat(c.cmuxSlices ? [slices(c)] : []));
async function lineCol(uri, re, word) {
  const doc = await vscode.workspace.openTextDocument(uri);
  for (let i = 0; i < doc.lineCount; i++) {
    const t = doc.lineAt(i).text;
    if (!re.test(t)) { continue; }
    const m = new RegExp(`\\b${word}\\b`).exec(t);
    if (m) { return { line: i, character: m.index + 1 }; }
  }
  throw new Error(`no ${word} on ${re}`);
}
async function addScopeAt(word, lineRe, waveformUri, confirm) {
  const pos = await lineCol(sv, lineRe, word);
  return vscode.commands.executeCommand('vaporview.sourceLink.addScope', { uri: sv.toString(), line: pos.line, character: pos.character, waveformUri, confirm });
}

module.exports = {
  'contributes Split > By Declared Dimensions (row menu) and Add All Signals in Scope (editor menu); no cmux in UI strings': async () => {
    const ext = await activate();
    const c = ext.packageJSON.contributes;
    const split = c.menus['webview/context'].find((m) => m.submenu === 'vaporview.split');
    assert.ok(split && /cmuxDeclared/.test(split.when) && /width > 1/.test(split.when), JSON.stringify(split));
    assert.deepStrictEqual(c.menus['vaporview.split'].map((m) => m.command), ['vaporview.splitDeclared']);
    assert.ok(c.menus['editor/context'].some((m) => m.command === 'vaporview.sourceLink.addScope'), 'editor context menu');
    const all = await vscode.commands.getCommands(true);
    for (const id of ['vaporview.splitDeclared', 'vaporview.sourceLink.addScope']) { assert.ok(all.includes(id), id); }
    // Page strings (generated from cmux) never name cmux; the import rewords the two that did.
    const text = fs.readFileSync(path.join(root, 'media/cmux/strings.js'), 'utf8');
    const strings = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const named = Object.entries(strings).filter(([, v]) => /\bcmux\b/i.test(v));
    assert.deepStrictEqual(named, [], 'page strings naming cmux');
    assert.match(strings.messageDeclaredNoAnswer, /^The viewer didn't hear back/);
    assert.match(strings.messageValueAliasNotRecorded, /^The viewer has no record of this file/);
    assert.match(fs.readFileSync(path.join(root, 'tools/import-cmux-modules.sh'), 'utf8'), /REWORD/);
  },

  'Split > By Declared Dimensions splits packed arrays by their slang dimensions (descending, ascending, 3-D)': async () => {
    const uri = await setup();
    for (const n of ['pa', 'asc', 'p3', 'plain']) { await add(uri, 'xtb.u_small.' + n); }
    const ctx = await rowContext('pa');
    assert.strictEqual(ctx.cmuxDeclared, true, 'a dumped signal offers the split');
    const pa = await vscode.commands.executeCommand('vaporview.splitDeclared', ctx);
    assert.deepStrictEqual(pa, [{ msb: 7, lsb: 4, name: 'pa[1]' }, { msb: 3, lsb: 0, name: 'pa[0]' }]);
    const row = (n) => rows(uri).then((rs) => rs.find((r) => fullName(r) === 'xtb.u_small.' + n));
    await until(async () => slices(await row('pa')).length === 2, 'pa slices');
    assert.deepStrictEqual(slices(await row('pa')), [['pa[1]', 7, 4], ['pa[0]', 3, 0]]);
    // [0:2][7:0]: elements as declared, left index first at the top bits.
    await vscode.commands.executeCommand('vaporview.splitDeclared', await rowContext('asc'));
    await until(async () => slices(await row('asc')).length === 3, 'asc slices');
    assert.deepStrictEqual(slices(await row('asc')), [['asc[0]', 23, 16], ['asc[1]', 15, 8], ['asc[2]', 7, 0]]);
    // [2:0][1:0][1:0]: each element split by the next dimension, in one step.
    await vscode.commands.executeCommand('vaporview.splitDeclared', await rowContext('p3'));
    await until(async () => slices(await row('p3')).length === 3, 'p3 slices');
    const p3 = slices(await row('p3'));
    // (as cmux: the last dimension's elements are not split into bits)
    assert.deepStrictEqual(p3[0], ['p3[2]', 11, 8, [['p3[2][1]', 11, 10], ['p3[2][0]', 9, 8]]]);
    assert.deepStrictEqual(p3.map((p) => p.slice(0, 3)), [['p3[2]', 11, 8], ['p3[1]', 7, 4], ['p3[0]', 3, 0]]);
    // One packed dimension: nothing declared to split by; nothing is added.
    const none = await vscode.commands.executeCommand('vaporview.splitDeclared', await rowContext('plain'));
    assert.strictEqual(none, undefined);
    assert.deepStrictEqual(slices(await row('plain')), []);
  },

  'Add All Signals in Scope from the editor: skips shown rows, asks above 48, adds at most 128, then the next ones': async () => {
    const uri = await setup();
    // A signal's line in x_mid: its instance's 61 signals (clk + m0..m59) are more than 48, so it asks first.
    let r = await addScopeAt('m3', /logic m3;/, uri);
    assert.deepStrictEqual(r.asked, [{ dumpScope: 'xtb.u_mid', count: 61 }]);
    assert.deepStrictEqual(r.added, [], 'Cancel adds nothing');
    assert.deepStrictEqual(await shownIn(uri, 'xtb.u_mid'), []);
    r = await addScopeAt('m3', /logic m3;/, uri, true);
    assert.deepStrictEqual(r.scopes, [{ dumpScope: 'xtb.u_mid', added: 61, total: 61 }]);
    await until(async () => (await shownIn(uri, 'xtb.u_mid')).length === 61, '61 u_mid rows');
    r = await addScopeAt('m3', /logic m3;/, uri, true);
    assert.deepStrictEqual([r.asked, r.scopes], [[], [{ dumpScope: 'xtb.u_mid', added: 0, total: 0 }]], 'shown rows are skipped');
    assert.strictEqual((await shownIn(uri, 'xtb.u_mid')).length, 61);
    // An instance name (in xtb): its signals not shown yet; pa is already shown. 4 <= 48: no question.
    await add(uri, 'xtb.u_small.pa');
    r = await addScopeAt('u_small', /x_small u_small/, uri);
    assert.deepStrictEqual([r.asked, r.scopes], [[], [{ dumpScope: 'xtb.u_small', added: 4, total: 4 }]]);
    await until(async () => (await shownIn(uri, 'xtb.u_small')).length === 5, '5 u_small rows');
    assert.strictEqual(new Set(await shownIn(uri, 'xtb.u_small')).size, 5, 'no duplicate rows');
    // 141 signals in u_wide: 128 at most, then the next ones.
    r = await addScopeAt('w7', /logic w7;/, uri, true);
    assert.deepStrictEqual([r.asked, r.scopes], [[{ dumpScope: 'xtb.u_wide', count: 128 }], [{ dumpScope: 'xtb.u_wide', added: 128, total: 141 }]]);
    assert.ok(r.messages.some((m) => /Added 128 of the 141 signals in xtb\.u_wide not shown yet/.test(m)), JSON.stringify(r.messages));
    await until(async () => (await shownIn(uri, 'xtb.u_wide')).length === 128, '128 u_wide rows');
    r = await addScopeAt('w7', /logic w7;/, uri, true);
    assert.deepStrictEqual([r.asked, r.scopes], [[], [{ dumpScope: 'xtb.u_wide', added: 13, total: 13 }]]);
    await until(async () => (await shownIn(uri, 'xtb.u_wide')).length === 141, '141 u_wide rows');
    assert.strictEqual(new Set(await shownIn(uri, 'xtb.u_wide')).size, 141, 'no duplicate rows');
  },

  "VaporView's netlist Add All in Scope skips shown rows (no duplicates; the 128 cap counts new rows only)": async () => {
    const uri = await setup();
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'xtb.u_small' });
    await until(async () => (await shownIn(uri, 'xtb.u_small')).length === 5, '5 u_small rows');
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'xtb.u_small' });
    await new Promise((res) => setTimeout(res, 1500));
    assert.strictEqual((await shownIn(uri, 'xtb.u_small')).length, 5, 'Add All again adds no duplicates');
    // 128 of u_wide shown (from the editor); the netlist's Add All then adds the other 13. Before, it took the first
    // 128 children, all shown, and added nothing.
    await addScopeAt('w7', /logic w7;/, uri, true);
    await until(async () => (await shownIn(uri, 'xtb.u_wide')).length === 128, '128 u_wide rows');
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'xtb.u_wide' });
    await until(async () => (await shownIn(uri, 'xtb.u_wide')).length === 141, '141 u_wide rows');
    assert.strictEqual(new Set(await shownIn(uri, 'xtb.u_wide')).size, 141, 'no duplicate rows');
  },
};
