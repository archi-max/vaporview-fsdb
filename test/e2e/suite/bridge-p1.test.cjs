// vscode-port P1 : Format Values menu (RISC-V, cmux formats, alias tables), RISC-V value search,
// Load Value Alias File... + sessions that remember alias files, the <dump>.json session offer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscode, assert, until, open, sleep, texts, fixture, root } = require('./helpers.cjs');
const { cmuxData, page, pageReady } = require('./bridge-helpers.cjs');

async function addRow(uri, instancePath) {
  await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath });
  const item = await until(() => cmuxData('findItem', instancePath), instancePath);
  await until(async () => (await texts('.waveform-label')).some((s) => s.includes(item.name)), 'row ' + instancePath);
  return item;
}
// Text of the value column for the one row shown.
async function valueText(want) {
  return until(async () => {
    const v = (await texts('.value-display-item')).map((s) => s.trim()).filter(Boolean);
    return v.length && (!want || want.test(v.join('|'))) ? v.join('|') : null;
  }, 'value column ' + (want || ''), 10000);
}
async function marker(uri, time) {
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time });
  await until(() => page((cmux, a) => cmux.host.viewerContext.webview && cmux.host.viewerContext.webview.markerTime === a.time, { time }), 'marker ' + time);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vv-bridge-'));

module.exports = {
  'Format Values menu has RISC-V (4 styles), the cmux formats and alias entries': async () => {
    const menus = pkg.contributes.menus;
    const fmt = menus['vaporview.valueFormat'].map((m) => m.command || m.submenu);
    for (const c of ['vaporview.displayAsBinary', 'vaporview.displayAsHexadecimal', 'vaporview.displayAsOctal', 'vaporview.displayAsDecimal',
      'vaporview.displayAsDecimalSigned', 'vaporview.displayAsFloat', 'vaporview.displayAsBFloat', 'vaporview.displayAsTFloat',
      'vaporview.displayAsFixedPoint', 'vaporview.displayAsFixedPointSigned', 'vaporview.displayAsAscii', 'vaporview.displayAsEpochTimeNs',
      'vaporview.riscvFormat', 'vaporview.loadValueAliases', 'vaporview.displayAsAliasTable', 'vaporview.removeValueAlias']) {
      assert.ok(fmt.includes(c), 'Format Values has ' + c);
    }
    assert.deepStrictEqual(menus['vaporview.riscvFormat'].map((m) => m.command), ['vaporview.displayAsRiscv', 'vaporview.displayAsRiscvNumeric',
      'vaporview.displayAsRiscvNoAlias', 'vaporview.displayAsRiscvNumericNoAlias']);
    const all = await vscode.commands.getCommands(true);
    for (const c of menus['vaporview.riscvFormat'].map((m) => m.command).concat(['vaporview.loadValueAliases', 'vaporview.displayAsAliasTable'])) {
      assert.ok(all.includes(c), 'registered ' + c);
    }
  },

  'RISC-V format: top.instr shows li a0,10 at t=0 in all 4 styles': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    const instr = await addRow(uri, 'top.instr');
    await marker(uri, 0);
    const want = {
      'vaporview.displayAsRiscv': /^li a0,10$/, 'vaporview.displayAsRiscvNumeric': /^li x10,10$/,
      'vaporview.displayAsRiscvNoAlias': /^addi a0,zero,10$/, 'vaporview.displayAsRiscvNumericNoAlias': /^addi x10,x0,10$/,
    };
    for (const [cmd, re] of Object.entries(want)) {
      await vscode.commands.executeCommand(cmd, { netlistId: instr.netlistId });
      const v = await valueText(re);
      assert.ok(re.test(v), cmd + ': ' + v);
    }
    // a cmux number format through the same menu path
    await vscode.commands.executeCommand('vaporview.displayAsDecimal', { netlistId: instr.netlistId });
    assert.strictEqual(await valueText(/^10487059$/), '10487059'); // 0x00A00513
  },

  'RISC-V rows: value search matches the instruction text by regex': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    const instr = await addRow(uri, 'top.instr');
    await marker(uri, 0);
    await vscode.commands.executeCommand('vaporview.displayAsRiscv', { netlistId: instr.netlistId });
    await valueText(/li a0/);
    const search = (re) => page(async (cmux, a) => {
      cmux.host.toWebview({ command: 'setSelectedSignal', netlistId: a.id });
      await new Promise((r) => setTimeout(r, 100));
      document.getElementById('value-equals-button').click();
      const bar = document.getElementById('search-bar');
      bar.value = a.re;
      bar.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
      bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await new Promise((r) => setTimeout(r, 300));
      return cmux.host.viewerContext.webview.markerTime;
    }, { id: instr.netlistId, re });
    assert.strictEqual(await search('^add\\s+a2,'), 20, 'regex over the instruction text');
    assert.strictEqual(await search('ret|jalr'), 50, 'alternation, next match after the marker');
  },

  'Load Value Alias File: .alias, .rc, JSON and CSV tables; JSON binds top.cnt': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    const cnt = await addRow(uri, 'top.cnt');
    await marker(uri, 35);
    for (const f of ['cnt_names.alias', 'cnt_names.rc', 'cnt_names.csv', 'cnt_names_alias.json']) {
      await vscode.commands.executeCommand('vaporview.loadValueAliases', { aliasFile: fixture(f).fsPath });
    }
    const formats = await until(async () => {
      const l = await page(() => window.vaporviewValueFormats.listFormats().map((f) => f.id));
      return ['alias:cnt_alias', 'alias:cnt_rc', 'alias:cnt_names', 'alias:cnt_json'].every((x) => l.includes(x)) ? l : null;
    }, 'alias tables');
    assert.ok(formats.includes('alias:cnt_alias'));
    assert.strictEqual(await valueText(/J_THREE/), 'J_THREE', 'the JSON file binds top.cnt to cnt_json');
    for (const [table, name] of [['alias:cnt_alias', 'THREE'], ['alias:cnt_rc', 'RC_THREE'], ['alias:cnt_names', 'C_THREE']]) {
      await vscode.commands.executeCommand('vaporview.displayAsAliasTable', { netlistId: cnt.netlistId, aliasFormat: table });
      assert.strictEqual(await valueText(new RegExp('^' + name + '$')), name, table);
    }
    await vscode.commands.executeCommand('vaporview.removeValueAlias', { netlistId: cnt.netlistId });
    assert.strictEqual(await valueText(/^03$/), '03');
    // the session names every file by key + SHA-256
    const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
    const keys = (s.cmuxValueAliases || []).map((e) => path.basename(e.key)).sort();
    assert.deepStrictEqual(keys, ['cnt_names.alias', 'cnt_names.csv', 'cnt_names.rc', 'cnt_names_alias.json']);
    assert.ok(s.cmuxValueAliases.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
  },

  '<dump>.json session offer (default Ask) restores rows and re-reads alias files by key + SHA-256': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview');
    assert.strictEqual(cfg.inspect('promptLoadSettings').defaultValue, 'Ask');
    const dir = tmp();
    const alias = path.join(dir, 'names.json');
    fs.copyFileSync(fixture('cnt_names_alias.json').fsPath, alias);
    // 1. read the alias file once (the registry only re-reads files the extension read)
    const uri0 = String(await open('counter.vcd'));
    await pageReady();
    await addRow(uri0, 'top.cnt');
    await marker(uri0, 35);
    await vscode.commands.executeCommand('vaporview.loadValueAliases', { aliasFile: alias });
    await valueText(/J_/);
    const session = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri: uri0 });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // 2. a session next to a copy of the dump, its alias entry WITHOUT the text: must be re-read by key
    session.cmuxValueAliases = session.cmuxValueAliases.map((e) => ({ key: e.key, path: e.path, fileName: e.fileName, sha256: e.sha256 }));
    session.markerTime = 35;
    const src = fixture('counter.vcd').fsPath; // or its E2E_FORMAT twin
    const dump = path.join(dir, 'dump' + path.extname(src));
    fs.copyFileSync(src, dump);
    session.fileName = dump;
    fs.writeFileSync(path.join(dir, 'dump.json'), JSON.stringify(session));
    await cfg.update('promptLoadSettings', 'Always', vscode.ConfigurationTarget.Global);
    try {
      const uri = String(await open(vscode.Uri.file(dump)));
      await until(async () => (await texts('.waveform-label')).some((s) => s.includes('cnt')), 'row restored from dump.json');
      assert.strictEqual(await valueText(/J_THREE/), 'J_THREE', 'alias file re-read by key + SHA-256');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await sleep(300);
      // 3. the file changed after the session was saved: not used
      fs.writeFileSync(alias, fs.readFileSync(alias, 'utf8').replace('J_THREE', 'CHANGED'));
      await open(vscode.Uri.file(dump));
      await until(async () => (await texts('.waveform-label')).some((s) => s.includes('cnt')), 'row restored again');
      await sleep(1500);
      const v = await valueText();
      assert.ok(!/CHANGED/.test(v), 'a changed file is not re-read: ' + v);
      void uri;
    } finally {
      await cfg.update('promptLoadSettings', undefined, vscode.ConfigurationTarget.Global);
    }
  },
};
