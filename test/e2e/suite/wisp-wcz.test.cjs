// vscode-port P2 acceptance: WCZ files through wisp-helper (small fixtures, committed: generated from
// test/e2e/fixtures/counter.vcd and strreal.vcd with wcz-from-vcd).
const { vscode, assert, until, open, fixture, texts, closeAll } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

module.exports = {
  'wisp: opens a WCZ, values from the API and the webview, small signals load whole': async () => {
    if (!(await w.useHelper('wcz open'))) return;
    const uri = String(await open('counter.wcz'));
    await w.add(uri, ['top.cnt', 'top.clk', 'top.instr']);
    // API (helper valueAt): cnt = 3 from t=30 to 39 (counter.vcd)
    assert.strictEqual(await w.apiValue(uri, 35, 'top.cnt'), '00000011');
    assert.strictEqual(await w.apiValue(uri, 35, 'top.clk'), '0');
    assert.strictEqual(await w.apiValue(uri, 75, 'top.cnt'), '00000111');
    // Webview: windowing is on, and these small signals were loaded whole (hybrid 'local').
    const s = await until(async () => { const st = await w.state(); return st.windowing.enabled && st.windowing.signals.length >= 3 && st.windowing.signals.every((x) => x.hybrid === 'local') ? st : null; }, 'whole loads');
    assert.ok(s.rows.every((r) => !r.windowed), JSON.stringify(s.rows));
    assert.strictEqual(await w.markerValue('cnt', 35), '00000011');
    assert.strictEqual(await w.markerValue('cnt', 40), '00000100');
    assert.strictEqual(await w.markerValue('instr', 30), '11111110000001010000111011100011');
    const labels = await texts('.waveform-label');
    assert.ok(labels.some((l) => /cnt/.test(l)), JSON.stringify(labels));
    const ws = await w.wispState(uri);
    assert.strictEqual(ws.source, 'wcz'); assert.ok(ws.relayed > 0, 'viewer requests went through the relay'); assert.strictEqual(ws.refused, null);
    console.log('  DIAGNOSTIC relayed', ws.relayed, 'bytesIn', s.windowing.stats.bytesIn);
  },

  'wisp: reals from a WCZ (API and webview)': async () => {
    if (!(await w.useHelper('wcz reals'))) return;
    const uri = String(await open('strreal.wcz'));
    await w.add(uri, ['top.temp', 'top.nib']);
    assert.strictEqual(await w.apiValue(uri, 15, 'top.temp'), '-2.25');
    assert.strictEqual(await w.apiValue(uri, 25, 'top.temp'), '31250000000');
    assert.strictEqual(await w.apiValue(uri, 25, 'top.nib'), '1x0z');
    const s = await w.state();
    assert.strictEqual(s.rows.find((r) => r.name === 'temp').encoding, 'Real');
    assert.strictEqual(await w.markerValue('temp', 5), '1.5');
    assert.strictEqual(await w.markerValue('temp', 12), '-2.25');
    assert.strictEqual(await w.markerValue('temp', 30), '0');
    assert.strictEqual(await w.markerValue('nib', 22), '1x0z');
  },

  'wisp: whole-signal mode (windowing off) loads through getSignalData': async () => {
    if (!(await w.useHelper('wcz whole'))) return;
    await w.setSetting('wisp.windowing', false);
    try {
      const uri = String(await open('counter.wcz'));
      await w.add(uri, ['top.cnt', 'top.instr']);
      const s = await until(async () => { const st = await w.state(); return !st.windowing.enabled && st.rows.every((r) => r.loaded) ? st : null; }, 'whole signals');
      assert.ok(s);
      assert.strictEqual(await w.markerValue('cnt', 55), '00000101');
      assert.strictEqual(await w.markerValue('instr', 10), '00000000000000001000000001100111');
    } finally { await w.setSetting('wisp.windowing', undefined); }
  },

  'wisp: windowing off, a summarised whole load is marked on its row; exact rows are not': async () => {
    if (!(await w.useHelper('wcz whole summary'))) return;
    await w.setSetting('wisp.windowing', false);
    globalThis.vvE2EWholeBuckets = 4;  // e2e only: exact up to 8 changes; top.cnt changes far more often
    try {
      const uri = String(await open('counter.wcz'));
      await w.add(uri, ['top.cnt']);
      const s = await until(async () => { const st = await w.state(); return st.rows.length && st.rows.every((r) => r.loaded) ? st : null; }, 'whole signals');
      const cnt = s.rows.find((r) => r.name === 'cnt');
      assert.ok(cnt.summary && cnt.summaryBadge, 'cnt is marked as a summary: ' + JSON.stringify(cnt));
      const ws = await w.wispState(uri);
      assert.strictEqual(ws.messages.filter((m) => /summary, not exact values/.test(m)).length, 1, JSON.stringify(ws.messages));
      // The same file with the real cap: exact, no marker.
      delete globalThis.vvE2EWholeBuckets;
      await closeAll();
      const uri2 = String(await open('counter.wcz'));
      await w.add(uri2, ['top.cnt']);
      const s2 = await until(async () => { const st = await w.state(); return st.rows.length && st.rows.every((r) => r.loaded) ? st : null; }, 'whole signals (exact)');
      const cnt2 = s2.rows.find((r) => r.name === 'cnt');
      assert.ok(!cnt2.summary && !cnt2.summaryBadge, 'exact load: no marker ' + JSON.stringify(cnt2));
    } finally { delete globalThis.vvE2EWholeBuckets; await w.setSetting('wisp.windowing', undefined); await closeAll(); }
  },

  'wisp: no helper found gives a message that says how to build it': async () => {
    if (!(await w.useHelper('missing helper'))) return;
    await w.setSetting('wispHelperPath', '/nonexistent/wisp-helper');
    try {
      const uri = fixture('counter.wcz');
      await vscode.commands.executeCommand('vaporview.openFile', { uri });
      const ws = await until(async () => { const st = await w.wispState(uri); return st && st.messages.length ? st : null; }, 'missing-helper message');
      assert.ok(/VSIX for your platform/.test(ws.messages[0]) && /wispHelperPath/.test(ws.messages[0]), ws.messages[0]);
    } finally { await w.setSetting('wispHelperPath', w.HELPER); }
  },

  'wisp: a corrupted WCZ shows a clear error and keeps the view': async () => {
    if (!(await w.useHelper('corrupted wcz'))) return;
    // A copy of counter.wcz with 4 bytes flipped inside segment 1 (its blocks): it opens, the damaged signals fail.
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-wisp-'));
    const bad = path.join(dir, 'counter-damaged.wcz');
    const bytes = fs.readFileSync(fixture('counter.wcz').fsPath);
    bytes.writeUInt32LE(0xefbeadde, 800);
    fs.writeFileSync(bad, bytes);
    const uri = String(await open(vscode.Uri.file(bad)));
    await w.add(uri, ['top.cnt']);
    const ws = await until(async () => { const st = await w.wispState(uri); return st && st.messages.length ? st : null; }, 'damage message');
    assert.ok(/cannot be read/.test(ws.messages[0]) && /damaged/.test(ws.messages[0]), ws.messages[0]);
    assert.ok(/Waveform/.test(ws.status), ws.status);
    assert.ok(ws.signalErrors.length > 0);
    // The view stays: the row is still there, the netlist still answers.
    const s = await w.state();
    assert.ok(s.rows.some((r) => r.name === 'cnt'));
    // A WCZ whose index is damaged does not open at all, with the reader's reason.
    const bad2 = path.join(dir, 'counter-badindex.wcz');
    const b2 = Buffer.from(fs.readFileSync(fixture('counter.wcz').fsPath)); b2.writeUInt32LE(0xefbeadde, 1200); fs.writeFileSync(bad2, b2);
    await vscode.commands.executeCommand('vaporview.openFile', { uri: vscode.Uri.file(bad2) });
    const ws2 = await until(async () => { const st = await w.wispState(vscode.Uri.file(bad2)); return st && st.messages.length ? st : null; }, 'open error');
    assert.ok(/could not be opened|refused/.test(ws2.messages[0]) && /INDEX|checksum/.test(ws2.messages[0]), ws2.messages[0]);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  'wisp: Search Netlist on a WCZ answers like the VCD it was made from (wellen rules)': async () => {
    if (!(await w.useHelper('netlist search'))) return;
    // Paths and kinds must match; bit ranges are the handler's own (wellen gives -1/-1 for a VCD var without a range).
    const key = (r) => r.searchResults.map((e) => (e.isVar ? 'v ' : 's ') + e.instancePath).sort();
    for (const [vcd, wcz] of [['counter.vcd', 'counter.wcz'], ['strreal.vcd', 'strreal.wcz']]) {
      const uv = String(await open(vcd)), uz = String(await open(wcz));
      for (const q of ['c', 'cnt', 'top', 'top.c', 'TOP.CL', 'o', 'r', 'zz_nothing', 'top.']) {
        const a = await vscode.commands.executeCommand('vaporview.e2e.searchNetlist', uv, q);
        const b = await vscode.commands.executeCommand('vaporview.e2e.searchNetlist', uz, q);
        assert.ok(!a.error && !b.error, JSON.stringify([a.error, b.error]));
        assert.strictEqual(b.totalResults, a.totalResults, `${wcz} "${q}": ${JSON.stringify(key(b))} vs VCD ${JSON.stringify(key(a))}`);
        assert.deepStrictEqual(key(b), key(a), `${wcz} "${q}"`);
      }
      const a = await vscode.commands.executeCommand('vaporview.e2e.searchNetlist', uv, 'cnt');
      console.log(`  DIAGNOSTIC search ${wcz}: "cnt" -> ${a.totalResults}`);
    }
  },
};
