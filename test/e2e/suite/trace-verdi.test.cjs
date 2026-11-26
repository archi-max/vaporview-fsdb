// vscode-port: the Verdi cross-check in a real VS Code, against a MOCK verdi (fixtures/trace/mock-verdi;
// no Verdi, no licence): it starts only on request and only after the licence notice; its verdict shows in the panel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscode, assert, until, open, query, root } = require('./helpers.cjs');
const { sameTwin, FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');

const dir = path.join(root, 'test/e2e/fixtures/trace');
const panel = async (q) => { const r = await vscode.commands.executeCommand('vaporview.e2e.tracePanel', q); if (r && r.error) { throw new Error('tracePanel: ' + r.error); } return r; };
const state = () => vscode.commands.executeCommand('vaporview.e2e.traceState');
const notice = (a) => vscode.commands.executeCommand('vaporview.e2e.traceVerdiNotice', a);

// A compile directory: an FSDB stand-in (the mock never reads it), the KDB folder, the mock's answers.
function compileDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-verdi-'));
  fs.writeFileSync(path.join(d, 'dump.fsdb'), '');
  fs.mkdirSync(path.join(d, 'simv.daidir', 'kdb.elab++'), { recursive: true });
  const sv = path.join(dir, 'a_uninit.sv');
  fs.writeFileSync(path.join(d, 'mock-answers.tsv'), `tb_a.dut.dout\t${sv}\t34\ntb_a.dut.stage\t${sv}\t99\n`);
  return d;
}
async function traceDout(verdiHome = path.join(dir, 'mock-verdi')) {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  await cfg.update('trace.designArgs', ['-f', 'a.f'], vscode.ConfigurationTarget.Global);
  await cfg.update('trace.designRoot', dir, vscode.ConfigurationTarget.Global);
  await cfg.update('trace.verdiHome', verdiHome, vscode.ConfigurationTarget.Global);
  // (E2E_FORMAT: the FSDB / WCZ twin converted from a.vcd (sameTwin); the mock Verdi reads its own answers, not the dump)
  if (FORMAT) { assert.ok(await useHelper('trace verdi on ' + FORMAT), 'wisp-helper for E2E_FORMAT=' + FORMAT); }
  const uri = String(await open(vscode.Uri.file(sameTwin(path.join(dir, 'a.vcd')))));
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 60 });
  await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === 60; }, 'marker at 60', 10000);
  const st = await vscode.commands.executeCommand('vaporview.traceDriver', { uri, path: 'tb_a.dut.dout' });
  assert.ok(st && !st.error, JSON.stringify(st));
  return uri;
}

// (the trace.* settings this suite sets are put back when it ends: trace-settings-guard.cjs)
module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  // vscode-port: the cross-check shows only when a Verdi installation is found (verdiHome's bin/verdi,
  // else verdi on PATH, else VERDI_HOME's bin/verdi); with none, the Trace panel has no button for it at all.
  'Cross-check button: none without a Verdi installation; "Cross-check with your installation" with one': async () => {
    const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
    const onHost = String(process.env.PATH || '').split(path.delimiter).some((d) => d && isFile(path.join(d, 'verdi')))
      || (process.env.VERDI_HOME && isFile(path.join(process.env.VERDI_HOME, 'bin', 'verdi')));
    if (onHost) { console.log('NOT RUN cross-check hidden: this host has a Verdi on PATH or VERDI_HOME'); }
    else {
      await traceDout('');
      await until(async () => (await panel({ kind: 'count', selector: 'tr.fanin' })) > 0 ? true : null, 'panel step');
      assert.strictEqual(await panel({ kind: 'count', selector: 'button.verdi' }), 0, 'no installation: no cross-check button');
      assert.strictEqual(await panel({ kind: 'count', selector: '.verdi-row' }), 0, 'no installation: no cross-check row');
    }
    // A fake installation: a verdiHome whose bin/verdi exists (never run here).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-fake-verdi-'));
    fs.mkdirSync(path.join(home, 'bin')); fs.writeFileSync(path.join(home, 'bin', 'verdi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await traceDout(home);
    const t = await until(async () => { const x = await panel({ kind: 'texts', selector: 'button.verdi' }); return x.length ? x : null; }, 'cross-check button');
    assert.deepStrictEqual(t, ['Cross-check with your installation']);
    fs.rmSync(home, { recursive: true, force: true });
  },
  'Verdi cross-check: needs an FSDB; declining the licence notice starts nothing': async () => {
    await traceDout();
    await notice(false);
    const none = await vscode.commands.executeCommand('vaporview.traceVerdiCheck', {});
    if (FORMAT === 'fsdb') {
      // The open document is an FSDB, so the check would use it: declining the notice starts nothing.
      assert.strictEqual(none.error, 'declined', JSON.stringify(none));
    } else {
      // (VCD / WCZ document: no FSDB to check against unless one is named)
      assert.deepStrictEqual([none.verdict, none.code], ['unavailable', 'noFsdb']);
    }
    const d = compileDir();
    const r = await vscode.commands.executeCommand('vaporview.traceVerdiCheck', { fsdb: path.join(d, 'dump.fsdb') });
    assert.strictEqual(r.error, 'declined');
    // Nothing ran: the launcher's scratch copy of serve.tcl would be in a vaporview-verdi-* folder.
    const s = await state();
    assert.ok(!s.step.verdi || s.step.verdi.code === 'noFsdb', JSON.stringify(s.step.verdi));
  },
  'Verdi cross-check after the notice: agrees on dout@60, differs on stage@54 (mock Verdi), shown in the panel': async () => {
    await traceDout();
    await notice(true);
    const d = compileDir();
    const fsdb = path.join(d, 'dump.fsdb');
    const r = await vscode.commands.executeCommand('vaporview.traceVerdiCheck', { fsdb });
    assert.strictEqual(r.verdict, 'agrees', JSON.stringify(r));
    assert.deepStrictEqual([path.basename(r.verdi.file), r.verdi.line], ['a_uninit.sv', 34]);
    const v = await until(async () => { const a = await panel({ kind: 'attrs', selector: '.verdict' }); return a.length ? a : null; }, 'panel verdict');
    assert.strictEqual(v[0].verdict, 'agrees');
    // One more step (stage@54), then the same session again: Verdi names another line.
    const paths = (await panel({ kind: 'attrs', selector: 'tr.fanin' })).map((a) => a.path);
    await panel({ kind: 'click', selector: 'tr.fanin', index: paths.indexOf('tb_a.dut.stage') });
    await until(async () => { const s = await state(); return s.step && s.step.signal === 'tb_a.dut.stage'; }, 'stage step');
    const r2 = await vscode.commands.executeCommand('vaporview.traceVerdiCheck', { fsdb });
    assert.deepStrictEqual([r2.verdict, r2.verdi.line], ['differs', 99]);
    const v2 = await until(async () => { const a = await panel({ kind: 'attrs', selector: '.verdict' }); return a.length && a[0].verdict === 'differs' ? a : null; }, 'panel differs');
    assert.ok(v2);
    void query;
    await notice(null);
  },
});
