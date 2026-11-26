// vscode-port P4 acceptance + the SystemVerilog editor while stepping (driver bars on lines that drove a changed
// signal, never the paused line; no boxes, no dimming), inline chips (was→now), all removed on Stop.
const { vscode, assert, until } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

const step = () => D.stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'));
const drawn = async () => ((await D.e2e({ kind: 'editor' })) || {})[String(D.SV())] || null;

module.exports = D.suite({
  'dbg driver bars on lines that drove a changed signal (never the paused line), no change boxes, no dimming; chips show was→now in the waveform radix; removed on Stop': async () => {
    // (every module's bars: vaporview.debug.inlineValues "all"; the default draws only the stopped instance's, below)
    await vscode.workspace.getConfiguration('vaporview.debug').update('inlineValues', 'all', vscode.ConfigurationTarget.Global);
    try { await d180(); } finally { await vscode.workspace.getConfiguration('vaporview.debug').update('inlineValues', undefined, vscode.ConfigurationTarget.Global); }
  },
  'dbg a stop under the default (stoppedLine) reads only the stopped instance (Locals scope) and the clock, never the other modules of the file': async () => {
    await D.start();
    const ed = await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Beside });
    ed.selection = new vscode.Selection(15, 0, 15, 0); // in counter: Locals follow it to u0
    await until(async () => { const x = await D.session(); return x && x.scope === 'dbg_top.u0' ? x : null; }, 'Locals follow the cursor to u0', 10000, 100).catch(() => null);
    await new Promise((r) => setTimeout(r, 500));
    await D.e2e({ kind: 'readsReset' });
    await step();
    await until(async () => { const p = await D.e2e({ kind: 'inlinePainted' }); return p && Object.keys(p.rows || {}).length ? p : null; }, 'painted', 15000, 100).catch(() => null);
    await new Promise((r) => setTimeout(r, 1000)); // (any late reads of the stop)
    const reads = await D.e2e({ kind: 'reads' });
    const s = await D.session();
    const clock = (await D.e2e({ kind: 'dataStats' }) || {}).clock;
    const scope = s.scope || '';
    assert.strictEqual(scope, 'dbg_top.u0', JSON.stringify(s));
    const foreign = reads.filter((p) => p !== clock && !(p.startsWith(scope + '.') && !p.slice(scope.length + 1).includes('.')));
    assert.deepStrictEqual(foreign, [], `reads outside ${scope} and the clock ${clock}: ${JSON.stringify(reads)}`);
    assert.ok(reads.some((p) => p === scope + '.cnt'), 'the stopped instance is read: ' + JSON.stringify(reads));
  },
  'dbg: with the session on dbg_top.u1 (launch option instance), Locals, the drawing and inline values all follow u1': async () => {
    // vscode-port (installed demo test): Locals showed u1 while inline values and line breakpoints used
    // the first instance, u0 (en 1'h0 vs 1'h1)
    await D.start({ instance: 'dbg_top.u1' });
    await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Beside });
    for (let i = 0; i < 3; i++) { await step(); } // 35 ns: u1.en = phase[0] differs from u0.en (always 1) on alternate cycles
    const list = await until(async () => { const d = await drawn(); return d && d.some((m) => m.module === 'counter') ? d : null; }, 'decorations');
    assert.strictEqual(list.find((m) => m.module === 'counter').instance, 'dbg_top.u1');
    const locals = await D.custom('variables', { variablesReference: (await D.custom('scopes', { frameId: 1 })).scopes[0].variablesReference });
    const en = locals.variables.find((v) => v.name === 'en');
    assert.ok(en, JSON.stringify(locals.variables.map((v) => v.name)));
    const bit = /'h([01])$/.exec(en.value)[1];
    const inline = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 0, last: 20 });
    const withEn = inline.filter((v) => /\ben = /.test(v.text));
    assert.ok(withEn.length > 0, JSON.stringify(inline));
    for (const v of withEn) { assert.ok(new RegExp('\\ben = (\\d → )?' + bit + '\\b').test(v.text), `line ${v.line + 1} shows u1.en = ${bit} (Locals ${en.value}): ${v.text}`); }
  },
  'dbg chips follow the waveform row radix (c0 shown decimal there: decimal in the chip)': async () => {
    const { uri } = await D.start();
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'dbg_top.c0' });
    const row = await until(async () => { const st = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return (st && st.displayedSignals || []).find((r) => r.netlistId !== undefined) || null; }, 'c0 row');
    await vscode.commands.executeCommand('vaporview.displayAsDecimal', { netlistId: row.netlistId });
    await until(async () => { const st = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return (st.displayedSignals || []).some((r) => r.numberFormat === 'decimal') || null; }, 'c0 decimal');
    await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Beside });
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 125 }); // c0 = u0.cnt = 12 (0x0c)
    await until(async () => { const x = await D.session(); return x && x.time === 125 ? x : null; }, 'session at 125');
    const inline = await until(async () => { const v = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 20, last: 40 }); return v && v.some((l) => /\bc0 = /.test(l.text)) ? v : null; }, 'c0 chip');
    const c0 = inline.find((l) => /\bc0 = /.test(l.text)).text;
    assert.match(c0, /\bc0 = (8'd11 → )?8'd12\b/, 'decimal like its row: ' + c0);
    assert.match(c0, /\bc1 = 8'h[0-9a-f]{2}\b/, 'c1 has no row: hex, two digits: ' + c0);
  },
  'dbg values are quiet text on the stopped line only by default (no yellow chips: VS Code\'s inline values get none); "all" draws every visible line, "off" none': async () => {
    const cfg = vscode.workspace.getConfiguration('vaporview.debug').inspect('inlineValues');
    assert.ok(cfg.globalValue === undefined && cfg.workspaceValue === undefined && cfg.workspaceFolderValue === undefined, 'default setting: ' + JSON.stringify(cfg));
    await D.start();
    const sv = String(D.SV());
    const ed = await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Beside });
    ed.selection = new vscode.Selection(15, 0, 15, 0);
    await new Promise((r) => setTimeout(r, 1500)); // (the editor open first, then the step, as a person does)
    const before = ((await D.e2e({ kind: 'inlineCalls' })) || []).length;
    await step();
    const st = await D.custom('stackTrace', { threadId: 1 });
    assert.strictEqual(st.stackFrames[0].source.path, D.SV().fsPath);
    const frame = st.stackFrames[0].line - 1;
    const painted = async (pred) => until(async () => { const p = await D.e2e({ kind: 'inlinePainted' }); return p && pred((p.rows || {})[sv] || [], p) ? p : null; }, 'painted values', 15000, 100);
    let p = await painted((rows) => rows.length > 0);
    assert.strictEqual(p.mode, 'stoppedLine');
    assert.deepStrictEqual(p.rows[sv].map((r) => r.line), [frame], 'only the stopped line: ' + JSON.stringify(p.rows[sv]));
    assert.ok(/^\w+ = /.test(p.rows[sv][0].text), JSON.stringify(p.rows[sv]));
    // the style (mock v2, the one constant source link imports too): CodeLens foreground at 75%, not italic, 2em
    // gap, no background / border / box; "no value" at 50%
    assert.deepStrictEqual(p.style, { color: { themeColor: 'editorCodeLens.foreground' }, margin: '0 0 0 2em', textDecoration: 'none; opacity: 0.75' });
    assert.deepStrictEqual(p.noValueStyle, { color: { themeColor: 'editorCodeLens.foreground' }, margin: '0 0 0 2em', textDecoration: 'none; opacity: 0.5' });
    assert.ok(!Object.keys(p.style).some((k) => /background|border|outline|fontStyle/i.test(k)), JSON.stringify(p.style));
    // VS Code's own inline values (drawn as yellow chips) get nothing from us
    const calls = ((await D.e2e({ kind: 'inlineCalls' })) || []).slice(before).filter((x) => x.uri === sv);
    assert.ok(calls.every((c) => c.count === 0), JSON.stringify(calls));
    const target = vscode.ConfigurationTarget.Global;
    try {
      await vscode.workspace.getConfiguration('vaporview.debug').update('inlineValues', 'all', target);
      p = await painted((rows) => rows.length > 3);
      assert.ok(p.rows[sv].some((r) => r.line === 15 && /\bcnt = /.test(r.text)), 'all: every visible line, as before: ' + JSON.stringify(p.rows[sv]));
      await vscode.workspace.getConfiguration('vaporview.debug').update('inlineValues', 'off', target);
      p = await painted((rows, x) => x.mode === 'off' && rows.length === 0);
    } finally {
      await vscode.workspace.getConfiguration('vaporview.debug').update('inlineValues', undefined, target);
    }
  },
});

/** 's drawing (bars, chips, removal on Stop), run under vaporview.debug.inlineValues "all". */
async function d180() {
    await D.start();
    await vscode.window.showTextDocument(D.SV(), { preview: false, viewColumn: vscode.ViewColumn.Beside }); // code beside the waveform
    await step(); // cycle 2, 15 ns: u0.cnt 0 -> 1, u1.cnt 0 -> 1, rst went low
    // (the drawing of this stop, not the entry stop's at 5 ns, where cnt also changed (x -> 0): rst fell in this cycle)
    const list = await until(async () => { const d = await drawn(); return d && d.some((m) => m.module === 'counter' && m.changedNames.includes('cnt')) && d.some((m) => m.module === 'dbg_top' && m.changedNames.includes('rst')) && d.every((m) => m.frameLine >= -1) ? d : null; }, 'decorations');
    const counter = list.find((m) => m.module === 'counter');
    assert.strictEqual(counter.instance, 'dbg_top.u0');
    assert.ok(counter.changedNames.includes('next'), JSON.stringify(counter));
    // driver bars: cnt <= next (15) and assign next = ... (12), each with a "drives" hover; the paused line never has one
    const bars = new Set(counter.driverHovers.map((h) => h.line));
    assert.ok(bars.has(15) && bars.has(12), JSON.stringify(counter));
    assert.ok(counter.driverHovers.find((h) => h.line === 15).text.includes('drives `cnt`'), JSON.stringify(counter.driverHovers));
    // drawn as the shared driver look (driver_style.ts, owner debug): dim 3 px bars, 1-based lines
    const dp = await until(async () => { const p = await D.e2e({ kind: 'driverPainted', uri: String(D.SV()) }); return p && p.dim.includes(16) && p.dim.includes(13) ? p : null; }, 'shared driver bars', 10000, 100);
    assert.deepStrictEqual(dp.active, [], JSON.stringify(dp));
    const frame = await until(async () => { const d = await drawn(); const c = d && d.find((m) => m.module === 'counter'); return c && c.frameLine >= 0 ? c : null; }, 'paused line known');
    assert.ok(!frame.driverLines.includes(frame.frameLine), `paused line ${frame.frameLine} has no driver bar: ${JSON.stringify(frame)}`);
    for (const m of list) { assert.deepStrictEqual(m.changedLines, [], 'no change boxes'); assert.deepStrictEqual(m.dimmedLines, [], 'no dimming'); }
    // chips: changed signals as was→now, others as now, hex without the SV prefix, one bit as 0/1
    const inline = await D.e2e({ kind: 'inline', uri: String(D.SV()), first: 0, last: 60 });
    const l15 = inline.find((v) => v.line === 15);
    assert.ok(l15 && /\bcnt = 8'h00 → 8'h01\b/.test(l15.text) && /\bnext = 8'h01 → 8'h02\b/.test(l15.text) && /\ben = 1\b/.test(l15.text), JSON.stringify(inline));
    assert.ok(inline.every((v) => !/= [0-9a-f]{2,}(?![\w'])/.test(v.text)), 'multi-bit values carry width\'radix (8\'h12, never a bare 12): ' + JSON.stringify(inline));
    // Next step: the tint follows.
    await step(); // 25 ns: u1 does not count
    const after = await until(async () => { const d = await drawn(); const t = d && d.find((m) => m.module === 'dbg_top'); return t && !t.changedNames.includes('rst') ? d : null; }, 'redraw');
    assert.ok(after.find((m) => m.module === 'dbg_top').changedNames.includes('c0'));
    // Stop removes it all.
    await vscode.commands.executeCommand('vaporview.debugger.stop');
    await until(async () => !vscode.debug.activeDebugSession, 'session ended');
    await until(async () => { const d = await D.e2e({ kind: 'editor' }); return d && Object.keys(d).length === 0; }, 'decorations removed');
    await until(async () => { const p = await D.e2e({ kind: 'driverPainted', uri: String(D.SV()) }); return p && !p.dim.length && !p.active.length; }, 'shared driver bars removed', 10000, 100);
    assert.strictEqual(await D.e2e({ kind: 'session' }), null, 'no session state (Locals gone)');
}
