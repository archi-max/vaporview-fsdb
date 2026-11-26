// vscode-port: the SV <-> waveform link in a multi-root workspace. Two folders, two designs, each with
// its own slang root (one slang-server per root): fixtures/multiroot/fsm (the link fixture's tb, rtl/ links to its
// sources, .slang/server.json builds .slang/fsm.f) and fixtures/multiroot/dbg (the debugger fixture's dbg_top, the
// same way). The dumps are the existing ones (link/fsm.vcd, dbg/dbg.vcd) opened as their E2E_FORMAT twins (FSDB, then
// WCZ); they sit outside both folders, so each waveform finds its design root by its top scopes. In each folder: Set as Top Level, Add Signal from the editor, inline values
// at the marker; a path-mapping rule saved for one dump does not apply to the other.
// Runs as its own invocation: E2E_WORKSPACE=multiroot.code-workspace tools/linux-test.sh fmt link-multi
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const fs = require('fs'), os = require('os');
const { vscode, assert, until, open, root, format, activate } = require('./helpers.cjs');

const fx = path.join(root, 'test/e2e/fixtures');
const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
const mr = path.join(fx, 'multiroot');
const inWorkspace = () => folders().includes(path.join(mr, 'fsm')) && folders().includes(path.join(mr, 'dbg'));
const status = () => vscode.commands.executeCommand('vaporview.sourceLink.status');

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

const DESIGNS = [
  { name: 'fsm', top: 'tb', topFile: 'multiroot/fsm/rtl/tb.sv', sv: 'multiroot/fsm/rtl/dut.sv', dump: 'link/fsm.vcd', lineRe: /state_t state/, word: 'state', path: 'tb.dut.u_ctl.state', time: 105 },
  { name: 'dbg', top: 'dbg_top', topFile: 'multiroot/dbg/rtl/dbg_top.sv', sv: 'multiroot/dbg/rtl/dbg_top.sv', dump: 'dbg/dbg.vcd', lineRe: /logic \[7:0\]\s+c0, c1;/, word: 'c0', path: 'dbg_top.c0', time: 105 },
];

module.exports = {
  'Multi-root: one slang root per folder; Add Signal and inline values work in both folders; path-mapping rules are per design + dump': async () => {
    if (!inWorkspace()) { console.log('NOT RUN link-multiroot: its own invocation, E2E_WORKSPACE=multiroot.code-workspace tools/linux-test.sh fmt link-multi'); return; }
    await activate(); // (the multi-root window has no waveform open yet: the extension activates on demand)
    const s0 = await status();
    const uris = {};
    for (const d of DESIGNS) {
      const topUri = vscode.Uri.file(path.join(fx, d.topFile));
      const tops = await until(async () => {
        const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: topUri.toString() });
        return Array.isArray(r) && r.includes(d.top) ? r : null;
      }, `slang top ${d.top} in ${d.name}/`, 90000, 1000);
      assert.ok(tops.includes(d.top), JSON.stringify(tops));
      // The other design's top is not in this root's compilation.
      const other = DESIGNS.find((x) => x !== d).top;
      assert.ok(!tops.includes(other), `${d.name}/ compiles only its own design: ${JSON.stringify(tops)}`);
    }
    const s1 = await status();
    console.log(`  DIAGNOSTIC multiroot (${format}): slang roots ${JSON.stringify(s1.slangRoots)}, route ${s1.slang}, server starts ${s1.slangCounts.serverStarts - s0.slangCounts.serverStarts}`);
    for (const d of DESIGNS) { assert.ok(s1.slangRoots.includes(path.join(mr, d.name)), `a slang root for ${d.name}/: ${JSON.stringify(s1.slangRoots)}`); }

    for (const d of DESIGNS) {
      const uri = String(await open(d.dump));
      uris[d.name] = uri;
      assert.ok(format === 'vcd' || new RegExp(`\\.${format}$`).test(uri), `the ${format} twin: ${uri}`);
      const sv = vscode.Uri.file(path.join(fx, d.sv));
      const pos = await wordPos(sv, d.lineRe, d.word);
      const r = await vscode.commands.executeCommand('vaporview.sourceLink.addSignal', { uri: sv.toString(), line: pos.line, character: pos.character, waveformUri: uri });
      assert.ok(r && r.added && r.added.includes(d.path), `${d.name}: Add Signal ${d.word} -> ${d.path}: ${JSON.stringify(r)}`);
      // Inline values at the marker in this folder's editor.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sv), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: d.time });
      const vs = await until(async () => {
        const all = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: sv.toString() });
        const hit = (all || []).find((x) => x.name === d.word && x.line === pos.line);
        return hit && hit.value && hit.value !== 'unavailable' && !hit.noValue ? all : null; // (no value is not a value)
      }, `${d.name}: inline ${d.word} at ${d.time}`, 30000, 250);
      const hit = vs.find((x) => x.name === d.word && x.line === pos.line);
      console.log(`  DIAGNOSTIC multiroot ${d.name}: added ${d.path}; inline ${d.word} = ${hit.value} at ${d.time} (${vs.length} inline values)`);
    }

    // A marker move from the webview side (not a command) in dbg's waveform, with dbg_top.sv visible: the refresh starts
    // from an event, outside any entry point call; its inline values must come from dbg's root (link's design has no
    // dbg_top, so a value for c0 proves the route), at the new time.
    {
      const d = DESIGNS[1];
      const sv = vscode.Uri.file(path.join(fx, d.sv));
      await open(d.dump); // (its panel active again: the webview query goes to it)
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sv), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      const pos = await wordPos(sv, d.lineRe, d.word);
      const before = ((await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: sv.toString() })) || []).find((x) => x.name === d.word && x.line === pos.line);
      const t2 = 205;
      const r = await vscode.commands.executeCommand('vaporview.e2e.query', { kind: 'marker', time: t2, click: true });
      assert.ok(!(r && r.error), 'webview marker: ' + JSON.stringify(r));
      const want = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: uris.dbg, time: t2, instancePaths: [d.path] });
      let last;
      const hit = await until(async () => {
        const all = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: sv.toString() });
        const h = last = (all || []).find((x) => x.name === d.word && x.line === pos.line);
        return h && h.value && h.value !== 'unavailable' && !h.noValue && (!before || h.value !== before.value) ? h : null;
      }, `dbg: inline ${d.word} after a webview marker move to ${t2}`, 30000, 250).catch(async (e) => {
        const st = await status();
        const view = await vscode.commands.executeCommand('vaporview.e2e.query', { kind: 'view' });
        console.log(`  DIAGNOSTIC multiroot dbg webview marker FAILED: before ${JSON.stringify(before)} last ${JSON.stringify(last)}; panel view ${JSON.stringify(view)}; ` +
          `visible ${JSON.stringify(vscode.window.visibleTextEditors.map((x) => x.document.uri.fsPath))}; markerEvents ${JSON.stringify(st.markerEvents.slice(-3))}; ` +
          `inlineTimings ${JSON.stringify(st.inlineTimings.slice(-3))}; outside ${JSON.stringify(st.slangOutside)}`);
        throw e;
      });
      console.log(`  DIAGNOSTIC multiroot dbg webview marker ${t2}: inline ${d.word} ${before && before.value} -> ${hit.value}; dump ${JSON.stringify(want)}`);
    }
    // Profile switch in folder 2 (dbg, its editor active): dbg's root now builds .slang/dbg.f; folder 1's (fsm)
    // compilation is unchanged.
    {
      const fsmRoot = path.join(mr, 'fsm'), dbgRoot = path.join(mr, 'dbg');
      const sv = vscode.Uri.file(path.join(fx, DESIGNS[1].sv));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sv), { preview: false });
      const before = (await status()).slangCompilations;
      assert.ok(before && before[fsmRoot], `fsm root compilation before: ${JSON.stringify(before)}`);
      const profile = vscode.Uri.file(path.join(dbgRoot, '.slang', 'dbg.f'));
      const tops = await vscode.commands.executeCommand('vaporview.sourceLink.switchProfile', profile);
      assert.ok(Array.isArray(tops) && tops.includes('dbg_top'), `dbg: switch to dbg.f -> tops ${JSON.stringify(tops)}`);
      const after = (await status()).slangCompilations;
      assert.deepStrictEqual(after[fsmRoot], before[fsmRoot], `fsm compilation unchanged: ${JSON.stringify({ before, after })}`);
      assert.strictEqual(after[dbgRoot] && after[dbgRoot].target && after[dbgRoot].target.path, profile.fsPath, `dbg compilation: ${JSON.stringify(after)}`);
      const ps = await vscode.commands.executeCommand('vaporview.sourceLink.profileStatus');
      assert.ok(ps.compilation && ps.compilation.target && ps.compilation.target.path === profile.fsPath, `status bar shows dbg's profile: ${JSON.stringify(ps.compilation)}`);
      assert.ok(/^slang: dbg\b/.test(ps.shown), `status bar text after the switch: ${JSON.stringify(ps.shown)}`);
      console.log(`  DIAGNOSTIC multiroot profile switch in dbg: fsm ${JSON.stringify(after[fsmRoot])}; dbg ${JSON.stringify(after[dbgRoot])}; status bar "${ps.shown}"`);
    }

    // A source outside both folders, under a .git of its own (a copy of fixtures/link/dut.sv in a temp dir with a .git:
    // the synced test tree has no .git, so the repository's cannot be relied on): it belongs to one of the two folders'
    // roots (the call's scope, else the first folder), never to a third root at the nearest .git.
    {
      const roots0 = (await status()).slangRoots;
      const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-mr-outside-'));
      fs.mkdirSync(path.join(gitDir, '.git'));
      fs.copyFileSync(path.join(fx, 'link', 'dut.sv'), path.join(gitDir, 'dut.sv'));
      const outsideSv = vscode.Uri.file(path.join(gitDir, 'dut.sv'));
      assert.ok(!folders().some((f) => outsideSv.fsPath.startsWith(f + path.sep)), 'dut.sv is outside both folders');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(outsideSv), { preview: false });
      await vscode.commands.executeCommand('vscode.executeHoverProvider', outsideSv, new vscode.Position(0, 0)).catch(() => null);
      const ps = await vscode.commands.executeCommand('vaporview.sourceLink.profileStatus');
      const after = await status();
      console.log(`  DIAGNOSTIC multiroot file outside both folders: root ${JSON.stringify(ps.root)}; roots ${JSON.stringify(after.slangRoots)} (before ${JSON.stringify(roots0)})`);
      assert.ok([path.join(mr, 'fsm'), path.join(mr, 'dbg')].includes(ps.root), `a folder's root, not the repository: ${JSON.stringify(ps.root)}`);
      const fr = [path.join(mr, 'fsm'), path.join(mr, 'dbg')];
      assert.ok((after.slangRoots || []).every((r) => fr.includes(r)), `no third slang root: ${JSON.stringify(after.slangRoots)}`);
      assert.ok(Object.keys(after.slangCompilations || {}).every((r) => fr.includes(r)), `no third compilation: ${JSON.stringify(Object.keys(after.slangCompilations || {}))}`);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      if (gitDir.startsWith(os.tmpdir() + path.sep)) { fs.rmSync(gitDir, { recursive: true, force: true }); }
    }

    // Path mapping kept per design root + dump: a rule saved for dbg's dump is not one of link's.
    try {
      const set = await vscode.commands.executeCommand('vaporview.sourceLink.editPathMapping', { rules: 'dbg_top.u9 = dbg_top.u0', uri: uris.dbg });
      assert.deepStrictEqual(set, ['dbg_top.u9 = dbg_top.u0']);
      const md = await vscode.commands.executeCommand('vaporview.sourceLink.getPathMapping', { uri: uris.dbg });
      const ml = await vscode.commands.executeCommand('vaporview.sourceLink.getPathMapping', { uri: uris.fsm });
      const user = (m) => m.rules.filter((x) => !x.isInferred).map((x) => `${x.designPrefix} = ${x.dumpPrefix}`);
      assert.deepStrictEqual(user(md), ['dbg_top.u9 = dbg_top.u0'], JSON.stringify(md));
      assert.deepStrictEqual(user(ml), [], 'fsm\'s dump keeps its own (no) rules: ' + JSON.stringify(ml));
      const setting = vscode.workspace.getConfiguration('vaporview.sourceLink').get('pathMapping') || [];
      assert.ok(!setting.includes('dbg_top.u9 = dbg_top.u0'), 'the setting is not changed: ' + JSON.stringify(setting));
    } finally {
      await vscode.commands.executeCommand('vaporview.sourceLink.editPathMapping', { rules: '', uri: uris.dbg });
    }
    // No slang call in any of the steps above reached the pool outside a design root (each warning names its caller).
    const s2 = await status();
    assert.deepStrictEqual(s2.slangOutside, [], `slang calls outside a design root: ${JSON.stringify(s2.slangOutside)}`);
  },
};
