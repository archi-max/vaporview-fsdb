// vscode-port P3 : the extension data API (src/cmux/data.ts), the page-module bridge
// (media/cmux/bridge.js <-> src/cmux/bridge_host.ts) and the wellen split-bit fix.
const { vscode, assert, until, open, sleep, format } = require('./helpers.cjs');

const { cmuxData, page, pageReady } = require('./bridge-helpers.cjs');

module.exports = {
  'data.ts: hierarchy, changes, posedges and values at a time': async () => {
    await open('counter.vcd');
    const top = await until(async () => { const t = await cmuxData('children'); return t && t.length ? t : null; }, 'top scopes');
    assert.deepStrictEqual(top.map((s) => [s.kind, s.name]), [['scope', 'top']]);
    const kids = await cmuxData('children', 'top');
    assert.deepStrictEqual(kids.map((k) => k.name).sort(), ['clk', 'cnt', 'instr']);
    const cnt = await cmuxData('findItem', 'top.cnt');
    assert.strictEqual(cnt.width, 8);
    const ch = await cmuxData('signalChanges', ['top', 'cnt']);
    assert.deepStrictEqual(ch.times.slice(0, 4), [0, 10, 20, 30]);
    assert.deepStrictEqual(ch.values.slice(0, 4), ['00000000', '00000001', '00000010', '00000011']);
    // a limit below the count answers null; at or above it answers the changes
    assert.strictEqual(await cmuxData('signalChanges', 'top.cnt', 3), null);
    const clk = await cmuxData('posedges', 'top.clk');
    assert.deepStrictEqual(clk.slice(0, 3), [10, 20, 30], 'posedges skip the first value (1 at t=0)');
    assert.strictEqual(await cmuxData('valueAt', 'top.cnt', 35), '00000011');
    assert.strictEqual(await cmuxData('valueAt', 'top.cnt', -1), null);
    assert.deepStrictEqual(await cmuxData('valuesAt', ['top.cnt', 'top.nothing', { netlistId: cnt.netlistId }], 20), ['00000010', null, '00000010']);
    await assert.rejects(cmuxData('signalChanges', 'top.nothing'), /no variable/);
  },

  'page modules load and round-trip data through the bridge': async () => {
    await open('counter.vcd');
    await pageReady();
    const r = await page(async (cmux) => {
      const host = cmux.host;
      const top = host.doc.netlist.map((x) => x.name);
      const scope = host.doc.netlist[0];
      const kids = (await host.getChildren(scope)).map((k) => k.name).sort();
      const cnt = await host.findLinkItem(['top', 'cnt'], true);
      const pairs = await host.signalChanges(cnt);
      const clk = await host.findLinkItem('top.clk', true);
      const edges = await host.signalPosedges(clk);
      const at = await host.rawValuesAt(30, [cnt, clk]);
      return {
        modules: Object.keys(cmux).sort(),
        hasHostFns: ['signalChanges', 'signalPosedges', 'getChildren', 'pathOf', 'findLinkItem', 'netlistItem', 'pinnedIds', 'toNative', 'log']
          .filter((k) => typeof host[k] !== 'function'),
        top, kids, path: host.pathOf(cnt), sameItem: host.netlistItem(cnt.netlistId) === cnt,
        pairs: pairs.slice(0, 3), edgesIsF64: edges instanceof Float64Array, edges: Array.from(edges).slice(0, 3),
        at: [at.get(cnt.netlistId), at.get(clk.netlistId)], scopeChildren: await cmux.link.scopeChildren('top'),
      };
    });
    assert.deepStrictEqual(r.hasHostFns, [], 'host functions missing');
    for (const m of ['debugger', 'link', 'host', 'strings']) { assert.ok(r.modules.includes(m), 'module ' + m + ' in ' + r.modules); }
    assert.deepStrictEqual(r.top, ['top']);
    assert.deepStrictEqual(r.kids, ['clk', 'cnt', 'instr']);
    assert.deepStrictEqual(r.path, ['top', 'cnt']);
    assert.ok(r.sameItem, 'netlistItem mirrors the item findLinkItem returned');
    assert.deepStrictEqual(r.pairs, [[0, '00000000'], [10, '00000001'], [20, '00000010']]);
    assert.ok(r.edgesIsF64, 'posedges arrive as a Float64Array');
    assert.deepStrictEqual(r.edges, [10, 20, 30]);
    assert.deepStrictEqual(r.at, ['00000011', '1']);
    assert.deepStrictEqual(r.scopeChildren.map((c) => c.name).sort(), ['clk', 'cnt', 'instr']);
  },

  'page toNative reaches the extension (copy) and the link adds a signal once': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    const token = 'cmux-bridge-' + Date.now();
    await page((cmux, a) => cmux.host.toNative({ type: 'copy', text: a.token }), { token });
    await until(async () => (await vscode.env.clipboard.readText()) === token, 'clipboard from page copy');
    await page(async (cmux) => { await cmux.link.addSignal('top.cnt'); await cmux.link.addSignal('top.cnt'); });
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.cnt' });
    await sleep(1500);
    const rows = await until(async () => {
      const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
      const ids = (s.displayedSignals || []).map((d) => d.netlistId).filter((x) => x !== undefined);
      return ids.length ? ids : null;
    }, 'rows');
    assert.strictEqual(rows.length, 1, 'top.cnt shown once: ' + JSON.stringify(rows));
  },

  'wellen split-bit fix: merged bits start at their first value (patched wasm)': async () => {
    // VCD-only (labelled): the fix is in the patched wellen wasm, which parses VCD only. FSDB/WCZ are read by
    // wisp-helper, whose data path the tests above cover on their twins (E2E_FORMAT=fsdb|wcz).
    if (format !== 'vcd') { console.log(`SKIP wellen split-bit fix: VCD-only (patched wellen VCD parser; E2E_FORMAT=${format} reads through wisp-helper)`); return; }
    await open('split_bits.vcd');
    const ch = await until(() => cmuxData('signalChanges', 'tb.valid'), 'tb.valid changes');
    // unpatched wellen 0.25.7 starts the merged vector wrong when no bit changes at the first time-table entry
    assert.deepStrictEqual(ch.times.map((t, i) => [t, ch.values[i]]), [[5, 'xx'], [35, '01'], [42, '11']]);
  },
};
