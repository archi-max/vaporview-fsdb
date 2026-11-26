// vscode-port P1 : base VaporView smoke after the cmux patch, and terminal links (cmux patterns).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscode, assert, until, open, sleep, texts, fixture, root } = require('./helpers.cjs');
const { cmuxData, page, pageReady } = require('./bridge-helpers.cjs');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const markerTime = () => page((cmux) => (cmux.host.viewerContext.webview ? cmux.host.viewerContext.webview.markerTime : null));
async function rowsOf(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  const out = [];
  const walk = (l) => (l || []).forEach((d) => { if (d.netlistId !== undefined) { out.push(d.netlistId); } walk(d.children); });
  walk(s && s.displayedSignals);
  return out;
}
async function link(line, column) {
  const r = await vscode.commands.executeCommand('vaporview.e2e.terminalLink', line, column);
  if (!r) { throw new Error('no terminalLink reply'); }
  return r;
}

module.exports = {
  'opens FST (iverilog) and reads values': async () => {
    await open('counter.fst');
    await until(async () => (await cmuxData('children')).length, 'fst hierarchy');
    assert.deepStrictEqual((await cmuxData('children', 'top')).map((k) => k.name).sort(), ['clk', 'cnt']);
    assert.strictEqual(await cmuxData('valueAt', 'top.cnt', 35), '00000011');
    assert.deepStrictEqual((await cmuxData('posedges', 'top.clk')).slice(0, 3), [10, 20, 30]);
  },

  'opens GHW (GHDL, wellen fixture) and reads values': async () => {
    await open(vscode.Uri.file(path.join(root, 'test/e2e/fixtures/wellen-ghdl/time_test.ghw')));
    const top = await until(async () => { const t = await cmuxData('children'); return t.length ? t : null; }, 'ghw hierarchy');
    const scope = top.find((t) => t.name === 'time_test'); // the design; the others are VHDL packages
    assert.ok(scope, 'time_test scope in ' + top.map((t) => t.name));
    const kids = (await cmuxData('children', [scope.name])).map((k) => k.name);
    for (const n of ['t1', 't2', 't3']) { assert.ok(kids.includes(n), n + ' in ' + JSON.stringify({ top, kids })); }
    // VHDL time is a 64-bit integer in femtoseconds: t1 = 500 ns, t2 = 2 sec, t3 = t1 + t2 (after the first delta)
    const v = async (n, t) => BigInt('0b' + (await cmuxData('valueAt', [scope.name, n], t)));
    assert.strictEqual(await v('t1', 0), 500000000n);
    assert.strictEqual(await v('t2', 0), 2000000000000000n);
    assert.strictEqual(await v('t3', 10), 2000000500000000n);
  },

  'menus, keybindings, settings and the netlist view are contributed and registered': async () => {
    await open('counter.vcd');
    const all = new Set(await vscode.commands.getCommands(true));
    const c = pkg.contributes;
    const missing = c.commands.map((x) => x.command).filter((id) => !all.has(id));
    assert.deepStrictEqual(missing, [], 'every contributed command is registered: ' + missing.join(' '));
    const kb = c.keybindings.map((k) => k.command).filter((id) => !all.has(id));
    assert.deepStrictEqual(kb, [], 'every keybinding has a registered command: ' + kb.join(' '));
    assert.ok(c.keybindings.length > 5, 'keybindings');
    const menuCmds = Object.values(c.menus).flat().map((m) => m.command).filter(Boolean).filter((id) => !all.has(id));
    assert.deepStrictEqual([...new Set(menuCmds)], [], 'every menu entry has a registered command');
    assert.ok(c.views && Object.values(c.views).flat().some((v) => v.id === 'waveformViewerNetlistView'), 'netlist view');
    const cfg = vscode.workspace.getConfiguration('vaporview');
    assert.ok(cfg.inspect('showRulerLines') !== undefined && cfg.inspect('promptLoadSettings').defaultValue === 'Ask', 'settings');
    // a setting reaches the webview (setConfigSettings) without breaking it
    await cfg.update('showRulerLines', false, vscode.ConfigurationTarget.Global);
    try { await pageReady(); } finally { await cfg.update('showRulerLines', undefined, vscode.ConfigurationTarget.Global); }
  },

  'session save and load round trip (getViewerState / loadViewerState)': async () => {
    const uri = String(await open('counter.vcd'));
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.cnt' });
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.clk' });
    await until(async () => (await rowsOf(uri)).length === 2, 'two rows');
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 40 });
    await until(async () => (await markerTime()) === 40, 'marker 40');
    const state = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(300);
    const uri2 = String(await open('counter.vcd'));
    await pageReady();
    const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vv-sess-')), 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify(state));
    await vscode.commands.executeCommand('waveformViewer.loadViewerState', { documentUri: uri2, sessionFileUri: vscode.Uri.file(sessionFile).toString() });
    await until(async () => (await rowsOf(uri2)).length === 2, 'rows restored');
    await until(async () => (await markerTime()) === 40, 'marker restored');
    const labels = await texts('.waveform-label');
    assert.ok(labels.some((s) => /cnt/.test(s)) && labels.some((s) => /clk/.test(s)), JSON.stringify(labels));
  },

  'auto reload picks up a rewritten dump': async () => {
    // Two repo fixtures (or their E2E_FORMAT twins) with top.cnt = 0b101 / 0b111 at 0: the open copy is replaced by the
    // other one in a single rename, as a simulator rewriting its dump would.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-reload-'));
    const a = fixture('reload_a.vcd').fsPath, b = fixture('reload_b.vcd').fsPath;
    const file = path.join(dir, 'r' + path.extname(a));
    const write = (src) => { const tmp = file + '.next'; fs.copyFileSync(src, tmp); fs.renameSync(tmp, file); };
    write(a);
    await open(vscode.Uri.file(file));
    await pageReady();
    assert.strictEqual(await cmuxData('valueAt', 'top.cnt', 0), '00000101');
    await page(() => { const b = document.getElementById('autoReload'); if (!b.checked) { b.click(); } return b.checked; });
    await sleep(500);
    write(b);
    await until(async () => { try { return (await cmuxData('valueAt', 'top.cnt', 0)) === '00000111'; } catch { return false; } }, 'reloaded value', 30000, 500);
  },

  'terminal links: @ 50, 50,000 ns style times and top.a.b paths (cmux patterns)': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    // the patterns
    const types = async (line) => (await link(line)).links.map((l) => l.type + ':' + l.text).sort();
    const eq = async (line, want) => { const got = await types(line); assert.deepStrictEqual(got, want, line + ' -> ' + JSON.stringify(got)); };
    await eq('UVM_INFO tb.sv(12) @ 50: hello', ['uvm-timestamp:@ 50']);
    await eq('done at 1,250 ns and 3.5us', ['timestamp-with-units:1,250 ns', 'timestamp-with-units:3.5us']);
    await eq('sim_100ns v1.5ns', []);
    await eq('see top.cnt and top.v and xtop.cnt and a/top.cnt', ['netlist-element:top.cnt']);
    assert.deepStrictEqual(await types('bit top.instr[3:0] here'), ['netlist-element:top.instr[3:0]']);
    // clicks
    let r = await link('UVM_INFO @ 50: x', 10);
    assert.strictEqual(r.handled, 'uvm-timestamp');
    await until(async () => (await markerTime()) === 50, 'marker at @ 50');
    r = await link('fail at 20 ns', 9);
    assert.strictEqual(r.handled, 'timestamp-with-units');
    await until(async () => (await markerTime()) === 20, 'marker at 20 ns');
    r = await link('time 0.03us', 6);
    await until(async () => (await markerTime()) === 30, 'marker at 0.03us');
    r = await link('check top.cnt now', 8);
    assert.strictEqual(r.handled, 'netlist-element');
    await until(async () => (await texts('.waveform-label')).some((s) => /cnt/.test(s)), 'top.cnt added');
    void uri;
  },
};
