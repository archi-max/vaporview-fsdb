// vscode-port: Add Variable by Path (and the terminal links / waveformViewer.addVariable that share its
// lookup) with a variable named with its index: the memory word "mem[12]" is that variable, not bit 12 of a "mem".
// A trailing [n] on a plain vector still selects through the vector. Fixture: memword.vcd or its E2E_FORMAT twin.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), path = require('path');
const { vscode, assert, until, open, closeAll, format, query } = require('./helpers.cjs');
const { cmuxData, page, pageReady } = require('./bridge-helpers.cjs');

async function rowNames(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  const all = [];
  const walk = (xs) => (xs || []).forEach((x) => { all.push(x); walk(x.children); });
  walk(s && s.displayedSignals);
  return all.filter((x) => x.dataType === 'netlist-variable').map((x) => x.name);
}

module.exports = {
  'Add Variable by Path: a variable named mem[12] is the word, not a bit select; vec[3] still finds vec': async () => {
    await closeAll();
    const uri = String(await open('memword.vcd'));
    await pageReady();
    const kids = (await until(async () => { const k = await cmuxData('children', 'top.u_ram'); return k && k.length ? k : null; }, 'top.u_ram'))
      .map((k) => k.name);
    assert.ok(kids.includes('mem[12]') && kids.includes('mem[13]'), 'the dump names the words with their index: ' + JSON.stringify(kids));
    // by path (palette / terminal link route)
    await vscode.commands.executeCommand('vaporview.addVariableByInstancePath', { instancePath: 'top.u_ram.mem[12]' });
    await until(async () => (await rowNames(uri)).includes('top.u_ram.mem[12]'), 'mem[12] row');
    // the public API
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.u_ram.mem[13]' });
    await until(async () => (await rowNames(uri)).includes('top.u_ram.mem[13]'), 'mem[13] row');
    // a bit select of a plain vector: found through the vector
    await vscode.commands.executeCommand('vaporview.addVariableByInstancePath', { instancePath: 'top.vec[3]' });
    await until(async () => (await rowNames(uri)).some((n) => n === 'top.vec' || n.startsWith('top.vec[')), 'vec row from vec[3]');
    assert.deepStrictEqual((await rowNames(uri)).filter((n) => n.startsWith('top.u_ram.')).sort(), ['top.u_ram.mem[12]', 'top.u_ram.mem[13]']);
    await closeAll();
  },
  'adds sent together (API, by path) show once each, in the order they were made': async () => {
    await closeAll();
    const uri = String(await open('memword.vcd'));
    await pageReady();
    await Promise.all([
      vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.u_ram.mem[13]' }),
      vscode.commands.executeCommand('vaporview.addVariableByInstancePath', { instancePath: 'top.vec' }),
      vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.u_ram.mem[12]' }),
      vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.u_ram.mem[13]' }),
    ]);
    await until(async () => (await rowNames(uri)).length >= 3, '3 rows');
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual((await rowNames(uri)).map((n) => n.replace(/\[\d+:\d+\]$/, '')), ['top.u_ram.mem[13]', 'top.vec', 'top.u_ram.mem[12]']);
    await closeAll();
  },
  'adds back to back select only the last one, as one-by-one adds do (toolbar shows its format)': async () => {
    await closeAll();
    const uri = String(await open('counter.vcd'));
    await pageReady();
    for (const p of ['top.clk', 'top.cnt', 'top.instr']) { vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p }); }
    await until(async () => (await rowNames(uri)).length === 3, '3 rows');
    await until(async () => { const q = await query({ kind: 'state' }); return q && q.selected && q.selected.length ? q : null; }, 'a selection');
    await new Promise((r) => setTimeout(r, 300));
    const q = await query({ kind: 'state' });
    assert.strictEqual(q.selected.length, 1, 'one row selected, not the whole batch: ' + JSON.stringify(q.selected));
    const selRow = q.rows.find((r) => r.rowId === q.selected[0]);
    assert.strictEqual(selRow && selRow.name, 'instr', 'the last add (top.instr) is the one selected: ' + JSON.stringify(selRow));
    const st = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
    const shown = await page(() => document.getElementById('search-symbol').textContent);
    // what the toolbar shows when instr alone is selected
    const instrId = st.displayedSignals.find((r) => r.name === 'top.instr').netlistId;
    const alone = await page(async (c, a) => { c.host.toWebview({ command: 'setSelectedSignal', netlistId: a.id }); await new Promise((r) => setTimeout(r, 200)); return document.getElementById('search-symbol').textContent; }, { id: instrId });
    assert.strictEqual(shown, alone, "toolbar format is instr's");
    await closeAll();
  },
  // A real VCS dump: bigsoc25k (internal, E2E_FSDB_DIR; never in the repo) names its memory words u_ram.mem[N].
  'Add Variable by Path on a real VCS dump: bigsoc25k u_ram.mem[12] is the word (FSDB, then WCZ)': async () => {
    if (format === 'vcd') { console.log('SKIP bigsoc25k mem[12]: no VCD of this dump (E2E_FORMAT=vcd)'); return; }
    const dir = process.env.E2E_FSDB_DIR || '';
    const file = dir && path.join(dir, 'bigsoc25k.' + format);
    if (!file || !fs.existsSync(file)) { console.log(`SKIP bigsoc25k mem[12]: no bigsoc25k.${format} (E2E_FSDB_DIR=${dir || 'unset'})`); return; }
    await closeAll();
    const uri = String(await open(vscode.Uri.file(file)));
    await pageReady();
    // the first scope named u_ram (breadth first) that holds mem[12]
    let ram = null;
    const queue = (await until(async () => { const t = await cmuxData('children'); return t && t.length ? t : null; }, 'top scopes'))
      .filter((k) => k.kind === 'scope').map((k) => k.name);
    for (let seen = 0; queue.length && !ram && seen < 2000; seen++) {
      const scope = queue.shift();
      const kids = (await cmuxData('children', scope)) || [];
      if (scope.endsWith('.u_ram') || scope === 'u_ram') { if (kids.some((k) => k.name === 'mem[12]')) { ram = scope; break; } }
      kids.filter((k) => k.kind === 'scope').forEach((k) => queue.push(scope + '.' + k.name));
    }
    assert.ok(ram, 'a u_ram scope with mem[12] in bigsoc25k.' + format);
    const word = ram + '.mem[12]';
    const item = await cmuxData('findItem', word);
    assert.ok(item && item.width > 1, `${word} is a word: ${JSON.stringify(item)}`);
    await vscode.commands.executeCommand('vaporview.addVariableByInstancePath', { instancePath: word });
    await until(async () => (await rowNames(uri)).includes(word), word + ' row');
    assert.deepStrictEqual((await rowNames(uri)).filter((n) => n.startsWith(ram + '.')), [word], 'the word, not a bit of another variable');
    console.log(`bigsoc25k.${format}: ${word} width ${item.width} added by path`);
    await closeAll();
  },
  // vscode-port: a generate block's instances are scopes named with their index (lane[0], g_cl[0]).
  // Every add by path goes through document.findTreeItem: the palette, waveformViewer.addVariable, the editor link's
  // Show in Waveform and Trace's add-inputs. Fixture: design E (test/trace/designs/e_misc.sv, generate block 'lane');
  // its E2E_FORMAT twin is the VCS run (.vcs.<fmt>, twinPath), as users dump it.
  'Add Variable by Path through a generate-indexed scope: tb_e.dut.lane[1].r (palette and API); a missing path is named': async () => {
    await closeAll();
    const uri = String(await open(vscode.Uri.file(path.join(require('./helpers.cjs').root, 'test/trace/dumps/e.icarus.vcd'))));
    await pageReady();
    const lanes = await vscode.commands.executeCommand('vaporview.e2e.scopeWalk', uri, 'tb_e.dut');
    console.log('design E ' + format + ' tb_e.dut children: ' + JSON.stringify(lanes && (lanes.error ? lanes : lanes.vars.map((v) => v.path))).slice(0, 600));
    const want = ['tb_e.dut.lane[0].r', 'tb_e.dut.lane[1].r'];
    await vscode.commands.executeCommand('vaporview.addVariableByInstancePath', { instancePath: want[0] });
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: want[1] });
    await until(async () => { const n = await rowNames(uri); return want.every((w) => n.includes(w)); }, 'rows ' + want.join(', '), 20000);
    assert.deepStrictEqual((await rowNames(uri)).filter((n) => n.includes('.lane[')), want);
    // a path that is not in the dump says which one (upstream printed "Signal not found: undefined") and adds nothing
    const missing = 'tb_e.dut.lane[5].r';
    const before = (await rowNames(uri)).length;
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: missing });
    if (format !== 'vcd') {
      await until(async () => { const s = await vscode.commands.executeCommand('vaporview.e2e.wispState', uri); return s && s.messages && s.messages.includes('Signal not found: ' + missing); }, 'not-found notice names ' + missing, 10000);
    }
    assert.strictEqual((await rowNames(uri)).length, before, 'no row for a path that is not in the dump');
    await closeAll();
  },
};
