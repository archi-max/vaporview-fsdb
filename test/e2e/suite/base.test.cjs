// vscode-port P1 acceptance: open a VCD, add signals, read values from the API and from the webview.
const { vscode, assert, until, open, texts } = require('./helpers.cjs');
module.exports = {
  'opens a VCD and reads values at a time': async () => {
    const uri = String(await open("counter.vcd"));
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.cnt' });
    const v = await until(async () => {
      const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time: 35, instancePaths: ['top.cnt'] });
      return r && r.length ? r : null;
    }, 'value of top.cnt');
    // value is documented as [current] or [previous, current]; accept a JSON string too.
    let val = v[0].value; if (typeof val === 'string') { try { val = JSON.parse(val); } catch { val = [val]; } }
    const cur = Array.isArray(val) ? val[val.length - 1] : val;
    assert.ok(/^0*11$/.test(String(cur)) || String(cur) === '3', `cnt at 35 = ${JSON.stringify(v)}`);
  },
  'webview shows the added row': async () => {
    const uri = String(await open("counter.vcd"));
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.instr' });
    const labels = await until(async () => { const l = await texts('.waveform-label'); return l.some((s) => /instr/.test(s)) ? l : null; }, 'instr label');
    assert.ok(labels.some((s) => /instr/.test(s)));
  },
};
