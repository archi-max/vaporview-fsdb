// vscode-port: VaporView FSDB next to upstream VaporView (keep the vaporview.* ids,
// tell the user to disable one). Exported only in installed-VSIX runs with upstream's VSIX installed too
// (run-installed.mjs <ours.vsix> <upstream.vsix>):
//  - upstream enabled: ours shows one warning naming both extensions with a button for each, and stays out of the way;
//  - upstream disabled (E2E_DISABLE=lramseyer.vaporview): no warning, and ours works (open a VCD, read the viewer).
const { vscode, assert, until, open, texts } = require('./helpers.cjs');
const UP = 'lramseyer.vaporview';
const also = (process.env.E2E_ALSO_IDS || '').toLowerCase().split(',');
const disabled = (process.env.E2E_DISABLE || '').toLowerCase().split(',').includes(UP);
const state = async () => { await vscode.extensions.getExtension(process.env.E2E_EXT_ID).activate(); return vscode.commands.executeCommand('vaporview.e2e.upstreamClash'); };

const tests = disabled ? {
  'upstream VaporView installed but disabled: no clash warning, ours opens a waveform': async () => {
    assert.strictEqual(vscode.extensions.getExtension(UP), undefined, 'upstream should be disabled in this run');
    const s = await state();
    assert.strictEqual(s.shown, null, 'warning shown although upstream is disabled');
    const uri = String(await open('trace/a.vcd'));
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'tb_a.din' });
    const labels = await until(async () => { const l = await texts('.waveform-label'); return l.some((x) => /din/.test(x)) ? l : null; }, 'din row');
    console.log(`  ours works with upstream disabled: rows ${JSON.stringify(labels)}`);
  },
} : {
  'upstream VaporView enabled next to ours: one clear warning with a button for each': async () => {
    assert.ok(vscode.extensions.getExtension(UP), 'upstream VaporView not installed/enabled in this run');
    const s = await until(async () => { const r = await state(); return r && r.shown && r; }, 'clash warning');
    assert.ok(/both enabled/.test(s.shown.message) && s.shown.message.includes(UP) && /Disable one/.test(s.shown.message), s.shown.message);
    assert.strictEqual(s.shown.buttons.length, 2);
    assert.ok(s.shown.buttons.includes('Show VaporView FSDB') && s.shown.buttons.includes('Show VaporView') && /^VaporView FSDB and VaporView \(lramseyer\.vaporview\) /.test(s.shown.message), JSON.stringify(s.shown.buttons));
    console.log(`  warning: ${s.shown.message}`);
    console.log(`  buttons: ${s.shown.buttons.join(' | ')}`);
    // the button target query is accepted by the Extensions view
    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${UP}`);
  },
};
module.exports = also.includes(UP) && process.env.E2E_EXT_ID ? tests : {};
