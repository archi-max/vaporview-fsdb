// vscode-port: the slang profile chooser (port of cmux's SlangProfileActions), against a real slang-server.
// Workspace = test/e2e/fixtures/link-profiles (E2E_WORKSPACE=link-profiles): its profiles build the link fixture's
// sources (../link, outside the folder, like a build file of another checkout): .slang/sim.f (--top tb, the testbench the waveform was dumped from) and .slang/core.f (--top top, the design alone).
// Opening the dump (FSDB / WCZ twin of link/fsm.vcd) auto-picks sim.f (its --top matches the dump's top scope), with
// Undo; switching profiles uses slang.setBuildFile; inline values and Add Signal still resolve after each switch.
// Runs as its own invocation: E2E_WORKSPACE=link-profiles tools/linux-test.sh fmt link-prof
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, open, sleep, root, activate, format } = require('./helpers.cjs');
const path = require('path');
const fs = require('fs');

const ws = path.join(root, 'test/e2e/fixtures/link-profiles');
const dut = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/link/dut.sv'));
const tb = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/link/tb.sv'));
const simF = path.join(ws, '.slang/sim.f');
const coreF = path.join(ws, '.slang/core.f');
const ENUM = { '000': 'IDLE', '001': 'FETCH', '100': 'DECODE', '101': 'EXEC', '111': 'DONE' };

const inWorkspace = () => (vscode.workspace.workspaceFolders || []).some((f) => f.uri.fsPath === ws);
const status = () => vscode.commands.executeCommand('vaporview.sourceLink.profileStatus');

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
async function valueAt(uri, p, time) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: [p] });
  let v = r && r[0] && r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return String(Array.isArray(v) ? v[v.length - 1] : v);
}
async function rows(uri) {
  const s = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  const all = [];
  const walk = (xs) => (xs || []).forEach((x) => { all.push(x); walk(x.children); });
  walk(s && s.displayedSignals);
  return all.map((x) => [x.instancePath, x.scopePath && x.signalName ? [].concat(x.scopePath, [x.signalName]).join('.') : undefined, x.name].find((v) => typeof v === 'string' && v.includes('.')) || x.name);
}
const addAt = (uri, pos, waveformUri) => vscode.commands.executeCommand('vaporview.sourceLink.addSignal', { uri: uri.toString(), line: pos.line, character: pos.character, waveformUri });

/** Add Signal on `word` (line matching lineRe) adds the dump row `want`; inline state at a marker time = the dump's. */
async function linkWorks(uri, label) {
  const before = await rows(uri);
  const goPos = await wordPos(dut, /IDLE: if \(go\)/, 'go');
  const r = await addAt(dut, goPos, uri);
  const after = await until(async () => { const a = await rows(uri); return a.includes('tb.dut.u_ctl.go') ? a : null; }, `${label}: Add Signal go -> tb.dut.u_ctl.go`, 30000, 250)
    .catch(async (e) => { throw new Error(`${e.message}; addSignal returned ${JSON.stringify(r)}; rows before ${JSON.stringify(before)}, now ${JSON.stringify(await rows(uri))}`); });
  assert.ok(after.includes('tb.dut.u_ctl.go'));
  // A time where state is not IDLE, then its inline value in the SV editor.
  let t = 0, v;
  for (let k = 15; k < 600 && !t; k += 10) { const x = (await valueAt(uri, 'tb.dut.u_ctl.state', k)).padStart(3, '0'); if (ENUM[x] && x !== '000') { t = k; v = ENUM[x]; } }
  assert.ok(t, 'a time where state is not IDLE');
  const stateLine = (await wordPos(dut, /state_t state/, 'state')).line;
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: t });
  const vs = await until(async () => {
    const all = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: dut.toString() });
    const s = (all || []).find((x) => x.name === 'state' && x.line === stateLine);
    return s && s.value === v ? all : null;
  }, `${label}: inline state = ${v} at ${t}`, 30000, 250);
  const go = vs.find((x) => x.name === 'go');
  assert.ok(go && /^[01]$/.test(go.value), `${label}: go has an inline value ${JSON.stringify(go)}`);
  console.log(`PROFILE ${format} ${label}: Add Signal go ok, inline state=${v}@${t} go=${go.value}`);
}

module.exports = {
  'contributes the profile chooser (commands, editor context menu, setting)': async () => {
    const ext = await activate();
    const c = ext.packageJSON.contributes;
    for (const id of ['chooseProfile', 'useFileAsTopLevel', 'exploreMode', 'editProfiles', 'restartSlang', 'undoProfileAutoPick',
      'setTopLevelHere', 'resetTopLevel', 'useAsBuildFile', 'clearBuildFile', 'showValuesFor']) {
      assert.ok(c.commands.some((x) => x.command === 'vaporview.sourceLink.' + id), id);
    }
    assert.ok(c.menus['editor/context'].some((m) => m.command === 'vaporview.sourceLink.chooseProfile'), 'editor context menu');
    assert.ok(c.menus['editor/context'].some((m) => m.command === 'vaporview.sourceLink.setTopLevelHere'), 'Set as Top Level in the editor menu');
    assert.ok(c.menus['explorer/context'].some((m) => m.command === 'vaporview.sourceLink.useAsBuildFile'), 'Use as Build File in the explorer menu');
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('vaporview.sourceLink.switchProfile') && all.includes('vaporview.sourceLink.profileStatus'));
  },

  'opening the dump auto-picks the matching profile (with Undo); switching profiles keeps inline values and Add Signal': async () => {
    if (!inWorkspace()) { console.log('NOT RUN link-profiles: its own invocation, E2E_WORKSPACE=link-profiles tools/linux-test.sh fmt link-prof'); return; }
    await activate();
    assert.ok(fs.existsSync(simF) && fs.existsSync(coreF), 'fixture profiles');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut));
    const s0 = await status();
    // dut.sv sits outside the opened folder (fixtures/link): its root is still the one folder's, never the repository's
    // nearest .git (installed dev.3310d96 listed no profiles: the chooser looked in the repo root).
    assert.strictEqual(fs.realpathSync(s0.root), fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath), `chooser root ${s0.root}`);
    assert.deepStrictEqual(s0.profiles.map((p) => p.name).sort(), ['core', 'sim'], `profiles listed: ${JSON.stringify(s0.profiles)}`);
    assert.ok(s0.visible, 'status item shows on an SV editor');

    // 1. Auto-pick on open: sim.f's --top tb matches the dump's top scope tb.
    const uri = String(await open('link/fsm.vcd'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    const s1 = await until(async () => { const s = await status(); return s.events.some((e) => e.startsWith('auto-pick')) ? s : null; }, 'auto-pick ran', 60000, 250)
      .catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await status())}`); });
    console.log(`PROFILE ${format} auto-pick: ${s1.events.join(' | ')}; label "${s1.label}"; slang ${s1.slangMode}`);
    assert.ok(s1.events.includes('auto-pick sim -> tb'), `auto-picked sim: ${s1.events}`);
    assert.strictEqual(s1.compilation.target.kind, 'buildFile');
    assert.strictEqual(path.resolve(s1.compilation.target.path), simF);
    assert.strictEqual(s1.autoPick.profile, 'sim');
    assert.strictEqual(s1.label, 'slang: sim · top tb');
    await until(async () => (await status()).shown.includes('switched to sim to match the waveform'), 'status bar notice', 10000, 200);

    // 2. Undo: back to no design; no further auto-picks.
    assert.strictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.undoProfileAutoPick'), true, 'undo');
    const s2 = await status();
    assert.strictEqual(s2.compilation.target, undefined);
    assert.deepStrictEqual(s2.tops, []);
    assert.ok(s2.autoPickDeclined);

    // 3. Switch to sim explicitly (setBuildFile, no restart, nothing written): the link resolves.
    const mtime = (f) => fs.statSync(f).mtimeMs;
    const m0 = [mtime(simF), mtime(coreF)];
    const starts0 = (await vscode.commands.executeCommand('vaporview.sourceLink.status')).slangCounts.serverStarts;
    assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.switchProfile', simF), ['tb']);
    assert.strictEqual((await status()).label, 'slang: sim · top tb');
    await linkWorks(uri, 'sim');

    // 4. Switch to core (top = the design alone): paths map onto the dump's tb.dut, the link still resolves.
    await vscode.commands.executeCommand('waveformViewer.removeVariable', { uri, instancePath: 'tb.dut.u_ctl.go' }).catch(() => undefined);
    await until(async () => !(await rows(uri)).includes('tb.dut.u_ctl.go'), 'go row removed', 10000, 200).catch(() => undefined);
    assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.switchProfile', coreF), ['top']);
    assert.strictEqual((await status()).label, 'slang: core · top top');
    await linkWorks(uri, 'core');
    const starts1 = (await vscode.commands.executeCommand('vaporview.sourceLink.status')).slangCounts.serverStarts;
    assert.ok(starts1 - starts0 === 0, `switching started no new slang-server (${starts1 - starts0})`);
    assert.deepStrictEqual([mtime(simF), mtime(coreF)], m0, 'switching wrote no profile file');
    assert.ok(!fs.existsSync(path.join(ws, '.slang/local/server.json')), 'switching wrote no server.json');

    // 5. Explore mode, then "use this file as top level" (tb.sv).
    await vscode.commands.executeCommand('vaporview.sourceLink.exploreMode');
    const s5 = await status();
    assert.ok(s5.compilation.explore && s5.label === 'slang: explore', `explore: ${s5.label}`);
    assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.useFileAsTopLevel', tb), ['tb']);
    assert.strictEqual((await status()).label, 'slang: tb.sv · top tb');

    // 6. Set as SystemVerilog Top Level on the module under the caret (dut.sv's `top`), then Reset Top Level.
    const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dut));
    const topPos = await wordPos(dut, /^module top\b/, 'top');
    ed.selection = new vscode.Selection(topPos.line, topPos.character, topPos.line, topPos.character);
    assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevelHere'), ['top']);
    assert.strictEqual((await status()).label, 'slang: dut.sv · top top');
    assert.strictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.resetTopLevel'), true);
    const s6 = await status();
    assert.ok(!s6.compilation.target && s6.tops.length === 0, `reset: ${JSON.stringify(s6.compilation)} ${s6.tops}`);

    // 7. Use as SystemVerilog Build File (explorer) on core.f, then Clear Build File.
    assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.useAsBuildFile', vscode.Uri.file(coreF)), ['top']);
    assert.strictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.clearBuildFile'), true);
    assert.deepStrictEqual((await status()).tops, []);

    // 8. Servers without slang.setBuildFile: "build" in .slang/local/server.json + a restart (own server), then Clear puts
    // the file back (removed: it did not exist).
    const cfg = path.join(ws, '.slang/local/server.json');
    try {
      assert.deepStrictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.useBuildFileThroughConfig', simF, true), ['tb']);
      assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).build, simF);
      const s8 = await status();
      assert.strictEqual(s8.label, 'slang: sim · top tb');
      assert.strictEqual(await vscode.commands.executeCommand('vaporview.sourceLink.clearBuildFile'), true);
      assert.ok(!fs.existsSync(cfg), 'Clear Build File removed the server.json it created');
      assert.deepStrictEqual((await status()).tops, []);
    } finally { fs.rmSync(path.join(ws, '.slang/local'), { recursive: true, force: true }); }

    // 9. Show Waveform Values For: ctl's dump instances (one here) after the design is back.
    await vscode.commands.executeCommand('vaporview.sourceLink.switchProfile', simF);
    const sv = await vscode.commands.executeCommand('vaporview.sourceLink.showValuesFor', { module: 'ctl', instance: 'tb.dut.u_ctl' });
    assert.deepStrictEqual(sv.instances, ['tb.dut.u_ctl'], JSON.stringify(sv));
    assert.strictEqual(sv.chosen, 'tb.dut.u_ctl');
    console.log(`PROFILE ${format} actions: top-here, reset, build file use/clear, server.json route + restart, values-for ok`);
    await sleep(100);
  },
};
