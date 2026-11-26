// vscode-port: "dumped": x is a value. trace/a (a_uninit.sv): acc has no reset, so the dump's value
// is all-x for the whole run (VCS writes no change for it: it stays at its 4-state default). Inline values show it as
// x (8'hxx: x / z per hex digit, as the waveform row), never "no value"; sum (= acc ^ ...) likewise x, stored or through its assign. RC 876c50d regression: the
// wisp noChange rule turned these into "no value". FSDB, then WCZ.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, root, activate, format } = require('./helpers.cjs');
const path = require('path');
const { keepDesign } = require('./link-design-guard.cjs');

const src = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/trace/a_uninit.sv'));
const tb = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/trace/tb_a.sv'));

module.exports = keepDesign({
  'Inline values : an all-x register (acc, no reset) shows x, never "no value"': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN link-dumped-x: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    await activate();
    await until(async () => {
      const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: tb.toString() });
      return Array.isArray(r) && r.includes('tb_a') ? r : null;
    }, 'slang top level tb_a', 60000, 1000);
    const uri = String(await open('trace/a.vcd'));
    const doc = await vscode.workspace.openTextDocument(src);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 55 });
    const pick = (vs, n) => (vs || []).filter((x) => x.name === n && x.dumpPath === 'tb_a.dut.' + n);
    const all = await until(async () => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
      return pick(vs, 'acc').length && pick(vs, 'sum').length && pick(vs, 'valid_q').length ? vs : null;
    }, 'inline acc / sum / valid_q at 55', 30000, 250).catch(async (e) => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
      throw new Error(`${e.message}; inline ${JSON.stringify(vs)}`);
    });
    for (const n of ['acc', 'sum']) {
      for (const x of pick(all, n)) {
        // (0.1.1: x / z per hex digit as the waveform row; 0.1.0 showed 8'h??)
        assert.ok(!x.noValue && x.value === "8'hxx", `${n} at 55 line ${x.line}: the dumped x (8'hxx), not "${x.value}": ${JSON.stringify(x)}`);
      }
    }
    const vq = pick(all, 'valid_q')[0];
    assert.ok(!vq.noValue && vq.value === '1', `valid_q at 55 = 1: ${JSON.stringify(vq)}`);
    const show = (n) => pick(all, n).map((x) => `${x.value}${x.reason ? ' (' + x.reason + ')' : ''}@${x.line}`).join(', ');
    console.log(`DUMPEDX ${format}: acc = ${show('acc')}; sum = ${show('sum')}; valid_q = ${show('valid_q')}`);
  },
});
