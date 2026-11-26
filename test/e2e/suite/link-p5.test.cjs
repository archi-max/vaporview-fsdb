// vscode-port P5 acceptance : SystemVerilog editor <-> waveform link, against a real slang-server.
// Needs slang-server: either the slang VS Code extension in the test instance (E2E_EXTENSIONS_DIR, route (a)) or
// slang-server on PATH (route (b), our own client). Fixture: test/e2e/fixtures/link (tb.sv/dut.sv/fsm_pkg.sv, fsm.vcd
// made by Icarus from tb.sv). Derived dumps (one signal removed, an extra wrapper scope) are written to a temp dir.
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, texts, query, sleep, root, activate, format } = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { keepDesign } = require('./link-design-guard.cjs'); // the previous design is put back after the last test

const linkDir = path.join(root, 'test/e2e/fixtures/link');
const dut = vscode.Uri.file(path.join(linkDir, 'dut.sv'));
const tb = vscode.Uri.file(path.join(linkDir, 'tb.sv'));
const ENUM = { '000': 'IDLE', '001': 'FETCH', '100': 'DECODE', '101': 'EXEC', '111': 'DONE' };

// Derived dumps, committed next to fsm.vcd so FSDB / WCZ twins exist (E2E_FORMAT; tools/fmt):
// fsm_partial.vcd = fsm.vcd with u_ctl's `busy` port left out: Add Signal on ctl's busy must show tb.dut.busy (same net
// through `.busy`). fsm_wrapped.vcd = everything one scope deeper (sim.tb...): the dump names the design differently, so
// a rule must be inferred.
const partialVcd = () => 'link/fsm_partial.vcd';
const wrappedVcd = () => 'link/fsm_wrapped.vcd';

async function lineOf(uri, re, nth = 0) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const hits = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const m = re.exec(doc.lineAt(i).text);
    if (m) { hits.push({ line: i, character: m.index + (m[0].length - m[0].trimStart().length) }); }
  }
  if (!hits[nth]) { throw new Error(`no line ${re} in ${uri.fsPath}`); }
  return hits[nth];
}
async function wordPos(uri, lineRe, word) {
  const doc = await vscode.workspace.openTextDocument(uri);
  for (let i = 0; i < doc.lineCount; i++) {
    const t = doc.lineAt(i).text;
    if (!lineRe.test(t)) { continue; }
    const m = new RegExp(`\\b${word}\\b`).exec(t);
    if (m) { return { line: i, character: m.index + 1 }; }
  }
  throw new Error(`no ${word} on ${lineRe}`);
}

// The path-mapping setting is a workspace setting: VS Code writes it to test/e2e/fixtures/.vscode/settings.json.
// Remove that file before the first test and after the mapping test, so no run sees a leftover from another.
const wsSettingsDir = path.join(root, 'test/e2e/fixtures/.vscode');
async function clearMapping() {
  await vscode.workspace.getConfiguration('vaporview.sourceLink').update('pathMapping', undefined, vscode.ConfigurationTarget.Workspace);
  fs.rmSync(path.join(wsSettingsDir, 'settings.json'), { force: true });
  try { fs.rmdirSync(wsSettingsDir); } catch { /* not empty or gone */ }
}

let topSet = false;
async function design() {
  if (topSet) { return; }
  await clearMapping();
  const tops = await until(async () => {
    const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: tb.toString() });
    return Array.isArray(r) && r.includes('tb') ? r : null;
  }, 'slang top level tb', 60000, 1000);
  assert.deepStrictEqual(tops.filter((t) => t === 'tb'), ['tb']);
  const st = await vscode.commands.executeCommand('vaporview.sourceLink.status');
  console.log(`link: slang route = ${st.slang}`);
  if (process.env.E2E_SLANG_ROUTE) { assert.strictEqual(st.slang, process.env.E2E_SLANG_ROUTE, 'slang route'); }
  topSet = true;
}
async function addAt(uri, pos, waveformUri) {
  return vscode.commands.executeCommand('vaporview.sourceLink.addSignal', { uri: uri.toString(), line: pos.line, character: pos.character, waveformUri });
}
async function closeAllViewers() { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await sleep(300); }
async function valueAt(uri, p, time) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: [p] });
  let v = r && r[0] && r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return String(Array.isArray(v) ? v[v.length - 1] : v);
}
async function rowOf(uri, name) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  const all = [];
  const walk = (xs) => (xs || []).forEach((x) => { all.push(x); walk(x.children); });
  walk(s && s.displayedSignals);
  const full = (x) => [x.name, x.signalName, x.instancePath, x.scopePath && x.signalName ? [].concat(x.scopePath, [x.signalName]).join('.') : undefined]
    .filter((v) => typeof v === 'string');
  const row = all.find((x) => full(x).some((v) => v === name || v.endsWith('.' + name)));
  return row;
}
async function rowFormat(uri, name) { const r = await rowOf(uri, name); return r && r.numberFormat; }

module.exports = keepDesign({
  'contributes Add Signal (command, editor context menu, non-Ctrl+W key) and Show in Source on rows': async () => {
    const ext = await activate();
    const c = ext.packageJSON.contributes;
    const ids = c.commands.map((x) => x.command);
    for (const id of ['vaporview.sourceLink.addSignal', 'vaporview.sourceLink.showInSource', 'vaporview.sourceLink.navigateBack',
      'vaporview.sourceLink.navigateForward', 'vaporview.sourceLink.editPathMapping', 'vaporview.sourceLink.showEnumNames']) {
      assert.ok(ids.includes(id), id);
    }
    assert.ok(c.menus['editor/context'].some((m) => m.command === 'vaporview.sourceLink.addSignal'), 'editor context menu');
    assert.ok(c.menus['webview/context'].some((m) => m.command === 'vaporview.sourceLink.showInSource'), 'row context menu');
    const keys = c.keybindings.filter((k) => k.command === 'vaporview.sourceLink.addSignal');
    assert.ok(keys.length && keys.every((k) => !/^(ctrl|cmd)\+w$/i.test(k.key) && !/^(ctrl|cmd)\+w$/i.test(k.mac || '')), JSON.stringify(keys));
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('vaporview.sourceLink.addSignal'));
  },

  'Add Signal to Waveform from the SV editor adds the dumped signal': async () => {
    await design();
    const uri = String(await open('link/fsm.vcd'));
    const pos = await wordPos(dut, /state_t state/, 'state');
    const r = await addAt(dut, pos, uri);
    assert.deepStrictEqual(r.added, ['tb.dut.u_ctl.state'], JSON.stringify(r));
    await until(async () => (await texts('.waveform-label')).some((s) => /\bstate\b/.test(s)), 'state row');
    // The editor-cursor route (the key binding / context menu call the command with no argument).
    const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut), { viewColumn: vscode.ViewColumn.Beside });
    const p2 = await wordPos(dut, /assign busy/, 'busy');
    ed.selection = new vscode.Selection(p2.line, p2.character, p2.line, p2.character);
    const r2 = await vscode.commands.executeCommand('vaporview.sourceLink.addSignal');
    assert.deepStrictEqual(r2.added, ['tb.dut.u_ctl.busy'], JSON.stringify(r2));
  },

  'Add Signal: an undumped signal shows through the net it connects to': async () => {
    await design();
    const uri = String(await open(partialVcd()));
    const pos = await wordPos(dut, /assign busy/, 'busy');
    const r = await addAt(dut, pos, uri);
    assert.deepStrictEqual(r.added, ['tb.dut.busy'], JSON.stringify(r));
    assert.ok(r.messages.some((m) => /isn't dumped; showing tb\.dut\.busy/.test(m)), JSON.stringify(r.messages));
    await until(async () => (await texts('.waveform-label')).some((s) => /\bbusy\b/.test(s)), 'busy row');
  },

  'Show Waveform Signal in Source jumps to the driver, row double-click too, with back/forward history': async () => {
    await design();
    const uri = String(await open('link/fsm.vcd'));
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'tb.dut.u_ctl.busy' });
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'tb.dut.u_lp.st' });
    await until(async () => (await texts('.waveform-label')).some((s) => /\bst\b/.test(s)), 'st row');
    const busyDriver = await lineOf(dut, /assign busy/);
    const r1 = await vscode.commands.executeCommand('vaporview.sourceLink.showInSource', { uri, instancePath: 'tb.dut.u_ctl.busy' });
    assert.ok(r1, 'showInSource result');
    assert.strictEqual(r1.drivers, 1);
    assert.strictEqual(r1.line, busyDriver.line, JSON.stringify(r1));
    await until(() => { const e = vscode.window.activeTextEditor; return e && e.document.uri.fsPath === dut.fsPath && e.selection.active.line === busyDriver.line; }, 'editor at busy driver');
    // Row double-click in the webview (several drivers: the declaration, with a peek list).
    const stDecl = await lineOf(dut, /logic \[1:0\] st;/);
    const clicked = await query({ kind: 'dblclick', selector: '.waveform-label', text: 'st' });
    assert.ok(clicked, 'double-clicked the st row');
    await until(() => { const e = vscode.window.activeTextEditor; return e && e.selection.active.line === stDecl.line; }, 'editor at st declaration', 20000);
    const st = await vscode.commands.executeCommand('vaporview.sourceLink.status');
    assert.ok(st.history.length >= 2, JSON.stringify(st));
    await vscode.commands.executeCommand('vaporview.sourceLink.navigateBack');
    await until(() => vscode.window.activeTextEditor && vscode.window.activeTextEditor.selection.active.line === busyDriver.line, 'back to busy driver');
    await vscode.commands.executeCommand('vaporview.sourceLink.navigateForward');
    await until(() => vscode.window.activeTextEditor && vscode.window.activeTextEditor.selection.active.line === stDecl.line, 'forward to st');
  },

  'Inline values at the marker in the SV editor follow the marker, outside a debug session': async () => {
    await design();
    const uri = String(await open('link/fsm.vcd'));
    const pos = await wordPos(dut, /state_t state/, 'state');
    await addAt(dut, pos, uri);
    assert.strictEqual(vscode.debug.activeDebugSession, undefined);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    // Two times where state differs.
    let t1 = 0, t2 = 0, v1, v2;
    for (let t = 15; t < 600 && !t2; t += 10) {
      const v = await valueAt(uri, 'tb.dut.u_ctl.state', t);
      if (!t1 && ENUM[v.padStart(3, '0')] && v !== '0' && v !== '000') { t1 = t; v1 = v; } else if (t1 && v !== v1 && ENUM[v.padStart(3, '0')]) { t2 = t; v2 = v; }
    }
    assert.ok(t1 && t2, `state changes ${t1} ${t2}`);
    const stateLine = (await lineOf(dut, /state_t state/)).line;
    const valueOn = async (time, want) => {
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time });
      return until(async () => {
        const vs = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: dut.toString() });
        const s = (vs || []).find((x) => x.name === 'state' && x.line === stateLine);
        return s && s.value === want ? vs : null;
      }, `inline state = ${want} at ${time}`, 30000, 250);
    };
    const vs1 = await valueOn(t1, ENUM[v1.padStart(3, '0')]);
    // Signals not shown in the viewer get values too (FSDB / WCZ: one batched helper point read, no row, no history load).
    const goLine = (await lineOf(dut, /IDLE: if \(go\)/)).line;
    const go = vs1.find((x) => x.name === 'go' && x.line === goLine);
    assert.ok(!(await rowOf(uri, 'tb.dut.u_ctl.go')), 'go is not a row in the viewer');
    assert.ok(go, `go (not shown) has an inline value: ${JSON.stringify(vs1)}`);
    assert.strictEqual(go.value, (await valueAt(uri, 'tb.dut.u_ctl.go', t1)).slice(-1), 'go inline = the dump value at the marker');
    // busy is a value where the dump stores one (VCD), else (a VCS FSDB port copy with no stream of its own) it shows
    // a value through its connection or 'no value' with the reason : never a blank or an x.
    const busy = vs1.find((x) => x.name === 'busy');
    assert.ok(busy, 'busy has an inline entry too');
    // a value (dumped, or through its connection: reason "via ..."), else dim "no value" with the reason.
    assert.ok(/^[01]$/.test(busy.value) || (busy.value === 'no value' && busy.noValue && busy.reason), `busy inline ${JSON.stringify(busy)}`);
    console.log(`INLINE ${format}: state=${vs1.find((x) => x.name === 'state').value} go=${go.value} busy=${busy.value}${busy.reason ? ' (' + busy.reason + ')' : ''}`);
    await valueOn(t2, ENUM[v2.padStart(3, '0')]);
  },

  // busy (assign busy = state != IDLE) is a VCS port copy with no stream of its own. FSDB: with
  // vaporview.wisp.outsideWrites = none (the run had no outside writes) the helper computes it (wisp-helper 15.10+).
  // WCZ: the converter links it in the file (reconverted twins), so no setting is needed.
  'Inline values: busy (a VCS port copy) has its value, = state != IDLE (FSDB with outsideWrites none; WCZ as converted)': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN busy-port-copy: FSDB / WCZ only (E2E_FORMAT=${format})`); return; }
    await design();
    const wcfg = vscode.workspace.getConfiguration('vaporview');
    // A resource-scoped setting (wisp split): written and restored at workspace level, never touching user settings.
    const before = wcfg.inspect('wisp.outsideWrites')?.workspaceValue;
    await closeAllViewers();
    if (format === 'fsdb') { await wcfg.update('wisp.outsideWrites', 'none', vscode.ConfigurationTarget.Workspace); }
    try {
      const uri = String(await open('link/fsm.vcd'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      const busyLine = (await lineOf(dut, /assign busy = state != IDLE/)).line;
      let checked = 0;
      for (let t = 15; t < 600 && checked < 2; t += 10) {
        const v = (await valueAt(uri, 'tb.dut.u_ctl.state', t)).padStart(3, '0');
        if (!ENUM[v]) { continue; }
        const want = ENUM[v] === 'IDLE' ? '0' : '1';
        if (checked === 1 && want === '0') { continue; } // one IDLE time and one busy time
        if (checked === 0 && want === '1') { continue; }
        await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t });
        const vs = await until(async () => {
          const all = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: dut.toString() });
          const b = (all || []).find((x) => x.name === 'busy' && x.line === busyLine);
          return b && b.value === want ? b : null;
        }, `inline busy = ${want} at ${t} (state ${ENUM[v]})`, 30000, 250);
        console.log(`INLINE ${format}${format === 'fsdb' ? ' outsideWrites=none' : ''} t=${t} state=${ENUM[v]} busy=${vs.value}`);
        checked++;
      }
      assert.strictEqual(checked, 2, 'checked busy at an IDLE time and a busy time');
    } finally {
      await closeAllViewers();
      await wcfg.update('wisp.outsideWrites', before, vscode.ConfigurationTarget.Workspace);
    }
  },
  'Waveform Path Mapping: user rules plus inferred rules; inferred never replace the user rules': async () => {
    await design();
    const uri = String(await open(wrappedVcd()));
    const set = await vscode.commands.executeCommand('vaporview.sourceLink.editPathMapping', { rules: 'tb.dut.u_lp = sim.tb.dut.u_lp' });
    assert.deepStrictEqual(set, ['tb.dut.u_lp = sim.tb.dut.u_lp']);
    const r = await addAt(dut, await wordPos(dut, /state_t state/, 'state'), uri);
    assert.deepStrictEqual(r.added, ['sim.tb.dut.u_ctl.state'], JSON.stringify(r));
    const m = await vscode.commands.executeCommand('vaporview.sourceLink.getPathMapping', { uri });
    const user = m.rules.filter((x) => !x.isInferred).map((x) => `${x.designPrefix} = ${x.dumpPrefix}`);
    const inferred = m.rules.filter((x) => x.isInferred).map((x) => `${x.designPrefix} = ${x.dumpPrefix}`);
    assert.deepStrictEqual(user, ['tb.dut.u_lp = sim.tb.dut.u_lp'], JSON.stringify(m));
    assert.ok(inferred.length >= 1 && inferred.every((x) => /^tb(\.dut(\.u_ctl)?)? = sim\.tb/.test(x)), JSON.stringify(m));
    // The user rule still decides its own subtree; the inferred rule covers the rest.
    const lp = await addAt(dut, await wordPos(dut, /logic \[1:0\] st;/, 'st'), uri);
    assert.deepStrictEqual(lp.added, ['sim.tb.dut.u_lp.st'], JSON.stringify(lp));
    // A user rule that conflicts with an inferred one wins.
    await vscode.commands.executeCommand('vaporview.sourceLink.editPathMapping', { rules: ['tb.dut.u_lp = sim.tb.dut.u_lp', 'tb = sim.tb'] });
    const m2 = await vscode.commands.executeCommand('vaporview.sourceLink.getPathMapping', { uri });
    assert.ok(m2.rules.some((x) => !x.isInferred && x.designPrefix === 'tb'), JSON.stringify(m2));
    const api = (await activate()).exports.sourceLink; // vscode-port: works for the installed VSIX too
    assert.strictEqual(await api.dumpPathOf('tb.dut.u_ctl.state', uri), 'sim.tb.dut.u_ctl.state');
    assert.strictEqual(await api.designPathOf('sim.tb.dut.u_lp.st', uri), 'tb.dut.u_lp.st');
    await clearMapping();
  },

  'Enum names are the default format for enum rows; Enum Names restores them; hover shows member and raw value': async () => {
    await design();
    const uri = String(await open('link/fsm.vcd'));
    await addAt(dut, await wordPos(dut, /state_t state/, 'state'), uri);
    const fmt = await until(async () => { const f = await rowFormat(uri, 'state'); return f && f.startsWith('alias:') ? f : null; }, 'state row alias format', 30000, 300)
      .catch(async (e) => {
        const st = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
        console.log('DIAG state', JSON.stringify(st && st.displayedSignals).slice(0, 1500));
        console.log('DIAG values', JSON.stringify(await texts('.value-display-item')));
        console.log('DIAG labels', JSON.stringify(await texts('.waveform-label')));
        throw e;
      });
    assert.ok(/state_t/.test(fmt), fmt);
    let t = 0, v;
    for (let x = 15; x < 600; x += 10) { v = await valueAt(uri, 'tb.dut.u_ctl.state', x); if (v !== '0' && v !== '000' && ENUM[v.padStart(3, '0')]) { t = x; break; } }
    const name = ENUM[v.padStart(3, '0')];
    await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t });
    await until(async () => (await texts('.value-display-item')).some((s) => s.includes(name)), `value column shows ${name}`, 20000);
    // Another format, then Format Values > Enum Names brings the member names back.
    const row = await rowOf(uri, 'state');
    await vscode.commands.executeCommand('vaporview.displayAsBinary', { netlistId: row.netlistId });
    await until(async () => (await rowFormat(uri, 'state')) === 'binary', 'state row binary');
    const ok = await vscode.commands.executeCommand('vaporview.sourceLink.showEnumNames', { uri, instancePath: 'tb.dut.u_ctl.state' });
    assert.strictEqual(ok, true);
    await until(async () => { const f = await rowFormat(uri, 'state'); return f === fmt; }, 'alias format restored');
    // Hover in the SV editor: member name and raw value.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    const hp = await wordPos(dut, /state_t state/, 'state');
    const raw = `3'h${parseInt(v.padStart(3, '0'), 2).toString(16)}`;
    await until(async () => {
      const hs = await vscode.commands.executeCommand('vscode.executeHoverProvider', dut, new vscode.Position(hp.line, hp.character));
      const text = (hs || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      return text.includes(name) && text.includes(raw) ? text : null;
    }, `hover shows ${name} and ${raw}`, 20000, 300);
  },

  'API for the debugger: signals a line assigns, and the dump instance an editor shows': async () => {
    await design();
    const uri = String(await open('link/fsm.vcd'));
    await addAt(dut, await wordPos(dut, /state_t state/, 'state'), uri);
    const api = (await activate()).exports.sourceLink; // vscode-port: works for the installed VSIX too
    const busyLine = (await lineOf(dut, /assign busy/)).line;
    const a = await api.signalsAssignedOnLine(dut, busyLine);
    assert.deepStrictEqual(a.map((x) => [x.name, x.designPath, x.dumpPath]), [['busy', 'tb.dut.u_ctl.busy', 'tb.dut.u_ctl.busy']]);
    const nsLine = (await lineOf(dut, /next_state = state;/)).line;
    assert.deepStrictEqual((await api.signalsAssignedOnLine(dut, nsLine)).map((x) => x.name), ['next_state']);
    const inst = await api.instanceAt(dut, new vscode.Position(busyLine, 2));
    assert.strictEqual(inst && inst.designInstance, 'tb.dut.u_ctl');
    assert.strictEqual(inst && inst.dumpInstance, 'tb.dut.u_ctl');
    const lpInst = await api.instanceAt(dut, new vscode.Position((await lineOf(dut, /assign y/)).line, 2));
    assert.strictEqual(lpInst && lpInst.dumpInstance, 'tb.dut.u_lp');
    const decl = await api.declarationOf('tb.dut.u_ctl.busy', uri);
    assert.ok(decl && decl.uri.fsPath === dut.fsPath, String(decl && decl.uri));
    await sleep(10);
  },
});
