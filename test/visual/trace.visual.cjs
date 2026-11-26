// vscode-port: screenshots of Trace Driver and Trace to Root (P5b) on the trace fixtures
// (test/e2e/fixtures/trace: synthetic designs A and P, cmux's case answers), plus the Verdi licence notice (mock Verdi,
// declined: nothing starts). Same flows as test/e2e/suite/trace-*.test.cjs; this file only adds the pictures.
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../e2e/suite/helpers.cjs');
const { vscode, assert, until, open, query, root, sleep } = t;

const dir = path.join(root, 'test/e2e/fixtures/trace');
// vscode-port: under E2E_FORMAT the twin converted from the VCD (format.cjs sameTwin), as tests:
// the exact chains are the VCD's values; a VCS-run twin of the same sources is another simulation.
const { sameTwin } = require('../e2e/suite/format.cjs');
const fx = (n) => vscode.Uri.file(/\.vcd$/.test(n) ? sameTwin(path.join(dir, n)) : path.join(dir, n));
const panel = async (q) => { const r = await vscode.commands.executeCommand('vaporview.e2e.tracePanel', q); if (r && r.error) { throw new Error('tracePanel: ' + r.error); } return r; };
const state = () => vscode.commands.executeCommand('vaporview.e2e.traceState');
const LONG = 30 * 60 * 1000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

async function design(f) {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  await cfg.update('trace.designArgs', ['-f', f], vscode.ConfigurationTarget.Global);
  await cfg.update('trace.designRoot', dir, vscode.ConfigurationTarget.Global);
}
async function traceDout() {
  await design('a.f');
  const uri = String(await open(fx('a.vcd')));
  await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'tb_a.dut.dout' });
  await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).some((s) => /dout/.test(s)), 'dout row');
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 60 });
  await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === 60; }, 'marker at 60', 10000);
  const st = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout' }), LONG, 'trace driver');
  assert.ok(st && !st.error, JSON.stringify(st));
  await until(async () => (await panel({ kind: 'texts', selector: '.stmt' })).includes('dout <= stage;'), 'panel statement');
  await until(async () => (await panel({ kind: 'count', selector: 'tr.fanin' })) >= 3, 'fan-in rows');
  return uri;
}
async function stepToStage() {
  const paths = (await panel({ kind: 'attrs', selector: 'tr.fanin' })).map((a) => a.path);
  await panel({ kind: 'click', selector: 'tr.fanin', index: paths.indexOf('tb_a.dut.stage') });
  await until(async () => { const s = await state(); return s.step && s.step.signal === 'tb_a.dut.stage'; }, 'stage step');
  await until(async () => (await panel({ kind: 'texts', selector: '.stmt' })).includes('stage = tmp;'), 'panel shows stage = tmp;');
}

module.exports = {
  'trace-driver: Trace Driver panel from the dout row: statement, branch, fan-in (both themes)': async () => {
    await traceDout();
    const vals = await panel({ kind: 'texts', selector: 'tr.fanin td.value' });
    assert.ok(vals.includes("8'bxxxxxxxx"), 'fan-in values ' + JSON.stringify(vals));
    await t.screenshotThemes('trace-driver', { view: [40, 80] });
  },
  'trace-step: one more step (stage@54 via the fan-in row)': async () => {
    await traceDout();
    await stepToStage();
    await t.screenshotThemes('trace-step', { view: [40, 80] });
  },
  'trace-editor: the driving statement opened in the editor (a_uninit.sv:34)': async () => {
    await traceDout();
    await panel({ kind: 'click', selector: '.driver a.loc' });
    const ed = await until(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath.endsWith('a_uninit.sv')), 'a_uninit.sv open');
    assert.strictEqual(ed.selection.start.line + 1, 34);
    await t.screenshotThemes('trace-editor', { view: [40, 80] });
  },
  'trace-x-root: Trace to Root chain on p.vcd sg2@440: exact/approximate labels, ranked causes (both themes)': async () => {
    await design('p.f');
    const uri = String(await open(fx('p.vcd')));
    const out = await withTimeout(vscode.commands.executeCommand('vaporview.traceXRoot', { uri, path: 'tb_p.dut.sg2', time: 440 }), LONG, 'trace to root');
    assert.ok(out && !out.error, JSON.stringify(out));
    await until(async () => (await panel({ kind: 'count', selector: 'tr.xstep' })) === 6, 'chain rows');
    await t.screenshotThemes('trace-x-root', { view: [280, 460] });
  },
  'verdi-notice: the Verdi licence notice before a cross-check (mock Verdi, declined)': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview');
    await cfg.update('trace.verdiHome', path.join(dir, 'mock-verdi'), vscode.ConfigurationTarget.Global);
    try {
      await traceDout();
      await vscode.commands.executeCommand('vaporview.e2e.traceVerdiNotice', null); // the real modal, not a preset answer
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-verdi-'));
      fs.writeFileSync(path.join(d, 'dump.fsdb'), '');
      fs.mkdirSync(path.join(d, 'simv.daidir', 'kdb.elab++'), { recursive: true });
      let refused = null;
      const pending = Promise.resolve(vscode.commands.executeCommand('vaporview.traceVerdiCheck', { fsdb: path.join(d, 'dump.fsdb') }))
        .catch((e) => { refused = e; return { error: 'refused' }; });
      await sleep(1500);
      // @vscode/test-electron refuses every modal dialog ("DialogService: refused to show dialog in tests"), so the real
      // notice can't be drawn in an extension-test window. Listed as still to add (needs a launch outside test mode).
      if (refused && /refused to show dialog in tests/.test(String(refused && refused.message))) {
        console.log('SKIP trace.visual :: verdi-notice: modal dialogs are refused in extension tests');
        return;
      }
      await t.screenshot('verdi-notice-dark', { idle: false, keepNotifications: true });
      await t.key('Escape');
      const r = await withTimeout(pending, 15000, 'notice closed');
      assert.strictEqual(r.error, 'declined', JSON.stringify(r));
    } finally {
      await cfg.update('trace.verdiHome', undefined, vscode.ConfigurationTarget.Global);
    }
  },
};
