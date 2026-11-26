// vscode-port: Show Waveform Values For (port of cmux FilePreviewLanguageFeatures instanceMenu): a module the
// dump has twice (dbg fixture: counter u0 counts every cycle, u1 every other one) shows inline values for the chosen
// instance. Picked through the real QuickPick, then by argument; FSDB, then WCZ (E2E_FORMAT).
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, sleep, root, activate, format } = require('./helpers.cjs');
const path = require('path');
const { keepDesign } = require('./link-design-guard.cjs'); // the previous design is put back after the last test

const src = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/dbg/dbg_top.sv'));

async function valueAt(uri, p, time) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: [p] });
  let v = r && r[0] && r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return String(Array.isArray(v) ? v[v.length - 1] : v);
}
// Dump values come as bits; inline values as Verilog literals (8'h02).
const num = (v) => { const m = /^\d*'([hdbo])([0-9a-fA-F_]+)$/.exec(v); if (m) { return parseInt(m[2].replace(/_/g, ''), { h: 16, d: 10, b: 2, o: 8 }[m[1]]); } return /^[01]+$/.test(v) ? parseInt(v, 2) : /^\d+$/.test(v) ? Number(v) : NaN; };

module.exports = keepDesign({
  'Show Waveform Values For: a module dumped twice follows the chosen instance (QuickPick and argument)': async () => {
    await activate();
    const tops = await until(async () => {
      const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: src.toString() });
      return Array.isArray(r) && r.includes('dbg_top') ? r : null;
    }, 'slang top level dbg_top', 60000, 1000);
    assert.ok(tops.includes('dbg_top'));
    const uri = String(await open('dbg/dbg.vcd'));
    const doc = await vscode.workspace.openTextDocument(src);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    // Caret in `counter`.
    const line = doc.getText().split('\n').findIndex((l) => /assign next = cnt \+ STEP/.test(l));
    ed.selection = new vscode.Selection(line, 4, line, 4);
    // A time where u0 and u1 count differently.
    let t = 0;
    for (let k = 25; k < 600 && !t; k += 10) {
      const a = num(await valueAt(uri, 'dbg_top.u0.cnt', k)), b = num(await valueAt(uri, 'dbg_top.u1.cnt', k));
      if (a > 2 && b > 0 && a !== b) { t = k; }
    }
    assert.ok(t, 'a time where u0.cnt != u1.cnt');
    const want = { u0: num(await valueAt(uri, 'dbg_top.u0.cnt', t)), u1: num(await valueAt(uri, 'dbg_top.u1.cnt', t)) };
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t });
    const cntLine = line; // `assign next = cnt + STEP;`: cnt's inline value is on this line
    const inlineCnt = async (inst) => until(async () => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
      const c = (vs || []).find((x) => x.name === 'cnt' && x.line === cntLine);
      return c && num(c.value) === want[inst] ? c : null;
    }, `inline cnt = ${inst}'s ${want[inst]} at ${t}`, 30000, 250).catch(async (e) => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
      const st = await vscode.commands.executeCommand('vaporview.sourceLink.status');
      throw new Error(`${e.message}; inline now ${JSON.stringify(vs)}; visible ${vscode.window.visibleTextEditors.map((x) => x.document.uri.fsPath)}; slang ${st.slang}`);
    });

    // 1. The real QuickPick: two entries, the second (u1) picked.
    const pending = vscode.commands.executeCommand('vaporview.sourceLink.showValuesFor');
    await sleep(1500);
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const r1 = await pending;
    assert.deepStrictEqual(r1.instances, ['dbg_top.u0', 'dbg_top.u1'], JSON.stringify(r1));
    assert.strictEqual(r1.chosen, 'dbg_top.u1', `picked u1 in the QuickPick: ${JSON.stringify(r1)}`);
    await inlineCnt('u1');

    // 2. By argument: back to u0.
    const r2 = await vscode.commands.executeCommand('vaporview.sourceLink.showValuesFor', { module: 'counter', instance: 'dbg_top.u0' });
    assert.strictEqual(r2.chosen, 'dbg_top.u0');
    await inlineCnt('u0');
    console.log(`VALUESFOR ${format}: counter instances ${r1.instances.join(',')}; at ${t} u0.cnt=${want.u0} u1.cnt=${want.u1}; inline follows the choice`);
  },

  // From the link side: dbg.vcs.fsdb lacks VCS port copies and assign nets (u1.en, en1,
  // next, w0/w1). Inline values read: stored value, else the design through the signal's connection (the resolver
  // Trace shares, src/cmux/shared/port_resolve.ts; hover "via ..."), else a dim "no value" with the reason: never an
  // x and never "unavailable". WCZ (as converted) stores u1.en: the value is direct.
  'Inline values : stored, resolved through the connection (u1.en at 34 via en1), or "no value" with a reason': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN port-resolve: FSDB / WCZ only (E2E_FORMAT=${format})`); return; }
    const uri = String(await open('dbg/dbg.vcd'));
    const doc = await vscode.workspace.openTextDocument(src);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    const r = await vscode.commands.executeCommand('vaporview.sourceLink.showValuesFor', { module: 'counter', instance: 'dbg_top.u1' });
    assert.strictEqual(r.chosen, 'dbg_top.u1');
    const lines = doc.getText().split('\n');
    const enLine = lines.findIndex((l) => /input\s+logic\s+en\b/.test(l));
    // en1 = phase[0] (assign en1 = phase[0]); phase is stored.
    const phase = num(await valueAt(uri, 'dbg_top.phase', 34));
    assert.ok(!Number.isNaN(phase), 'phase is stored');
    const want = String(phase & 1);
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 34 });
    const all = await until(async () => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
      const e = (vs || []).find((x) => x.name === 'en' && x.line === enLine && x.dumpPath === 'dbg_top.u1.en');
      return e && e.value !== 'unavailable' ? vs : null;
    }, 'inline u1.en at 34', 30000, 250);
    const en = all.find((x) => x.name === 'en' && x.line === enLine && x.dumpPath === 'dbg_top.u1.en');
    assert.strictEqual(String(num(en.value)), want, `u1.en = en1 = phase[0] (${want}) at 34: ${JSON.stringify(en)}`);
    // (stored = the value API reads it from the dump: a value with no `via`; since the value API resolves names the
    // dump lacks too, a value alone no longer says "stored")
    const apiEn = ((await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time: 34, instancePaths: ['dbg_top.u1.en'] })) || [])[0];
    const storedEn = !!apiEn && !apiEn.via && !apiEn.noValue && /^[01]$/.test(String([].concat(apiEn.value).pop()));
    if (storedEn) { assert.ok(!en.reason && !en.noValue, `stored, no via: ${JSON.stringify(en)}`); }
    else { assert.ok(en.reason && en.reason.includes('dbg_top.en1') && en.reason.includes('port connection'), `via en1: ${JSON.stringify(en)}`); }
    // Every entry: a value (no x, never "unavailable"), or "no value" + reason, dim (noValue).
    for (const x of all) {
      assert.ok(x.value !== 'unavailable' && x.value !== 'unreadable', `no "unavailable" wording: ${JSON.stringify(x)}`);
      if (x.noValue) { assert.ok(x.value === 'no value' && /^(not in the dump|not computable)/.test(x.reason || ''), `no value with a reason: ${JSON.stringify(x)}`); }
    }
    const state = (n, p) => { const x = all.find((v) => v.name === n && v.dumpPath === p); return x ? (x.noValue ? `no value (${x.reason})` : `${x.value}${x.reason ? ' ' + x.reason : ''}`) : 'absent'; };
    const others = [['en1', 'dbg_top.en1'], ['next', 'dbg_top.u1.next'], ['w0', 'dbg_top.w0'], ['w1', 'dbg_top.w1'], ['wrap', 'dbg_top.u1.wrap']].map(([n, p]) => `${p}=${state(n, p)}`);
    const stored = all.find((x) => !x.noValue && !x.reason);
    assert.ok(stored, 'a stored value too');
    if (format === 'fsdb') {
      const resolved = all.filter((x) => !x.noValue && x.reason && x.reason.startsWith('via '));
      assert.ok(resolved.length, 'FSDB: at least one value through its connection');
    }
    console.log(`PORTRESOLVE ${format}: u1.en@34 = ${en.value}${en.reason ? ' (' + en.reason + ')' : ' (stored)'}; phase[0] = ${want}; ${others.join('; ')}; noValue entries ${all.filter((x) => x.noValue).length}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  // on dumps that lack u1's counter register. dbg_partial: VCS twin with $fsdbSuppress(dbg_top.u1.cnt); VCS still
  // keeps u1.cnt through its port wire c1, so u1.cnt has a value (stored or via c1), never "no value". dbg_partial2:
  // also without c1, so u1.cnt (an always_ff register whose only connection is c1) has no value at all: a dim
  // "no value" with a "not computable: ..." reason, never an x. VCS stores next / wrap in both twins.
  'Inline values : u1.cnt through its port wire, then "no value (not computable ...)" when both are missing': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN no-value: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    const entry = (vs, n) => (vs || []).find((x) => x.name === n && x.dumpPath === 'dbg_top.u1.' + n);
    const u1At34 = async (file) => {
      const uri = String(await open(file));
      const doc = await vscode.workspace.openTextDocument(src);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      const r = await vscode.commands.executeCommand('vaporview.sourceLink.showValuesFor', { module: 'counter', instance: 'dbg_top.u1' });
      assert.strictEqual(r.chosen, 'dbg_top.u1', JSON.stringify(r));
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 34 });
      const all = await until(async () => {
        const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
        return ['cnt', 'next', 'wrap'].every((n) => entry(vs, n)) ? vs : null;
      }, `inline cnt / next / wrap of u1 at 34 (${file})`, 30000, 250).catch(async (e) => {
        const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
        throw new Error(`${e.message}; inline ${JSON.stringify(vs)}`);
      });
      for (const x of all) { assert.ok(!/^[0-9]*'?[hbd]?[xz]+$/i.test(x.value) && x.value !== 'unavailable', `${file}: never x / unavailable: ${JSON.stringify(x)}`); }
      return { uri, all, cnt: entry(all, 'cnt'), next: entry(all, 'next'), wrap: entry(all, 'wrap') };
    };
    const show = (x) => `${x.value}${x.reason ? ' (' + x.reason + ')' : ' (stored)'}`;
    // dbg_partial: u1.cnt = c1 at 34.
    const a = await u1At34('dbg/dbg_partial.vcd');
    const c1 = num(await valueAt(a.uri, 'dbg_top.c1', 34));
    assert.ok(!a.cnt.noValue && num(a.cnt.value) === c1, `dbg_partial u1.cnt = c1 (${c1}): ${JSON.stringify(a.cnt)}`);
    for (const x of [a.next, a.wrap]) { assert.ok(!x.noValue, `dbg_partial u1.${x.name} has a value: ${JSON.stringify(x)}`); }
    console.log(`NOVALUE ${format} dbg_partial: u1.cnt = ${show(a.cnt)}, c1 = ${c1}; u1.next = ${show(a.next)}; u1.wrap = ${show(a.wrap)}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // dbg_partial2: u1.cnt has no value.
    const b = await u1At34('dbg/dbg_partial2.vcd');
    assert.ok(b.cnt.noValue && b.cnt.value === 'no value' && /^not computable: .+/.test(b.cnt.reason || ''), `dbg_partial2 u1.cnt: ${JSON.stringify(b.cnt)}`);
    // Drawn : "cnt = no value (not computable)", never a bare "no value"; the full reason in the line's hover.
    {
      const cfg = vscode.workspace.getConfiguration('vaporview.sourceLink');
      await cfg.update('inlineValues', 'all', vscode.ConfigurationTarget.Global);
      try {
        const NO_VALUE_ENTRY = /^[\w$.[\]]+ = no value \((port copy|not in dump|memory|not computable)\)$/;
        const d = await until(async () => {
          const r = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString(), drawn: true });
          return (r.texts || []).find((t) => t.noValue && t.line === b.cnt.line) ? r : null;
        }, 'drawn no-value text on u1.cnt\'s line', 15000, 250);
        const t = d.texts.find((x) => x.noValue && x.line === b.cnt.line);
        const entries = t.text.split('  ');
        assert.ok(entries.every((e) => NO_VALUE_ENTRY.test(e)), `drawn no-value entries tagged: ${JSON.stringify(t)}`);
        assert.ok(entries.includes('cnt = no value (not computable)'), `cnt drawn: ${JSON.stringify(t)}`);
        // (the hover is markdown: appendText escapes spaces as &nbsp; and punctuation with a backslash)
        const hover = (t.hover || '').replace(/&nbsp;/g, ' ').replace(/\\(.)/g, '$1');
        assert.ok(hover.includes(b.cnt.reason), `hover carries the full reason: ${JSON.stringify({ ...t, hover })}`);
        for (const x of d.texts) { for (const e of x.text.split('  ')) { assert.ok(!/= no value$/.test(e), `no bare "no value": ${JSON.stringify(x)}`); } }
        console.log(`NOVALUE ${format} drawn: ${t.text} | hover ${hover}`);
      } finally { await cfg.update('inlineValues', undefined, vscode.ConfigurationTarget.Global); }
    }
    // u0 keeps its stored values.
    await vscode.commands.executeCommand('vaporview.sourceLink.showValuesFor', { module: 'counter', instance: 'dbg_top.u0' });
    const u0 = await until(async () => {
      const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
      const c = (vs || []).find((x) => x.name === 'cnt' && x.dumpPath === 'dbg_top.u0.cnt');
      return c && !c.noValue ? c : null;
    }, 'u0.cnt stored', 30000, 250);
    console.log(`NOVALUE ${format} dbg_partial2: u1.cnt = ${show(b.cnt)}; u1.next = ${show(b.next)}; u1.wrap = ${show(b.wrap)}; u0.cnt = ${u0.value}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },
});
