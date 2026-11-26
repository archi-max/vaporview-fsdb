// vscode-port: the debugger on the shipped c-debugger demo folder, as a user runs it (installed VSIX).
// E2E_DEMO_DBG = the demo folder, opened as the workspace (E2E_WORKSPACE=<same absolute path>) with its own
// .vscode/settings.json; nothing in the folder is written (checked: every file's size + mtime before and after).
// dbg.fsdb, then dbg.wcz: start (F5), F10 x3, Locals and the editor's inline values for en / next / cnt are values,
// never x; a line breakpoint on `cnt <= next` with the condition cnt == 8'h2a answers with its message; Stop.
// Without E2E_DEMO_DBG: no tests.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), path = require('path');
const { vscode, assert, until, sleep, open, activate } = require('./helpers.cjs');
const { useHelper } = require('./wisp-common.cjs');

const DIR = process.env.E2E_DEMO_DBG || '';
const DT = 'vaporview-waveform';
const COND = "cnt == 8'h2a";
const sent = [];
let tracker = null;
const stops = () => sent.filter((m) => m.type === 'event' && m.event === 'stopped');
const session = () => vscode.commands.executeCommand('vaporview.debugger.e2e', { kind: 'session' });
const custom = (cmd, args) => vscode.debug.activeDebugSession.customRequest(cmd, args);
async function stopAfter(action, what, ms = 30000) {
  const before = stops().length;
  await action();
  const ev = await until(async () => stops()[before], what, ms, 50);
  await sleep(50);
  return { ev, s: await session() };
}
async function stopAll() {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  for (let i = 0; i < 25 && vscode.debug.activeDebugSession; i++) {
    const ended = new Promise((r) => { const d = vscode.debug.onDidTerminateDebugSession(() => { d.dispose(); r(); }); setTimeout(() => { d.dispose(); r(); }, 2000); });
    await vscode.debug.stopDebugging();
    await ended;
  }
  assert.ok(!vscode.debug.activeDebugSession, 'a debug session is still running after Stop');
}
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { walk(p); } else { const st = fs.statSync(p); out[path.relative(dir, p)] = st.size + '@' + st.mtimeMs; } } };
  walk(dir);
  return out;
}
const hex = (v) => /^\d+'h[0-9a-f]+$/i.test(v); // a value: no x / z digit, not "no value"

function onFile(name) {
  return async () => {
    await activate();
    const before = snapshot(DIR);
    const f = path.join(DIR, name);
    assert.ok(fs.existsSync(f), 'no ' + f);
    const ow = vscode.workspace.getConfiguration('vaporview', vscode.Uri.file(f)).inspect('wisp.outsideWrites');
    assert.ok(await useHelper('demo dbg ' + name), 'wisp-helper');
    if (!tracker) { tracker = vscode.debug.registerDebugAdapterTrackerFactory(DT, { createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => sent.push(m) }) }); }
    await stopAll();
    try {
      const uri = String(await open(vscode.Uri.file(f)));
      sent.length = 0;
      // F5: the waveform debugger on the open dump, in u1 (the counter that counts every other cycle)
      const ok = await vscode.debug.startDebugging(undefined, { type: DT, request: 'attach', name: 'demo', waveform: uri, instance: 'dbg_top.u1' }, { suppressSaveBeforeStart: true });
      assert.ok(ok, 'startDebugging');
      await until(async () => stops().length > 0, 'entry stop', 60000);
      let s = await until(async () => { const x = await session(); return x && x.cycle ? x : null; }, 'session state', 60000);
      const t0 = s.time;
      // F10 x3
      for (let i = 0; i < 3; i++) { ({ s } = await stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.stepOver'), 'F10 #' + (i + 1))); }
      assert.ok(s.time > t0, `stepped: ${t0} -> ${s.time}`);
      // Locals of u1: en / next / cnt are values, never x
      const scopes = await custom('scopes', { frameId: 1 });
      const vars = (await custom('variables', { variablesReference: scopes.scopes[0].variablesReference })).variables;
      const locals = {};
      for (const n of ['en', 'next', 'cnt']) {
        const v = vars.find((x) => x.name === n);
        assert.ok(v, `Locals has ${n}: ${JSON.stringify(vars.map((x) => x.name))}`);
        assert.ok(hex(v.value.split(' ')[0]), `Locals ${n} is a value, not x / no value: ${JSON.stringify(v)}`);
        locals[n] = v.value;
      }
      // Inline values in the module's lines of dbg_top.sv (the editor shown beside, as a user does)
      const sv = vscode.Uri.file(path.join(DIR, 'dbg_top.sv'));
      await vscode.window.showTextDocument(sv, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      const inline = await until(async () => { const x = await vscode.commands.executeCommand('vaporview.debugger.e2e', { kind: 'inline', uri: String(sv), first: 0, last: 60 }); return x && x.length ? x : null; }, 'inline values', 60000, 200);
      const seen = {};
      for (const row of inline) {
        for (const part of row.text.split('  ')) {
          const m = /^(\w+) = (.*)$/.exec(part);
          if (!m || !['en', 'next', 'cnt'].includes(m[1])) { continue; }
          assert.ok(hex(m[2].split(' → ').pop()) || /^[01]$/.test(m[2].split(' → ').pop()), `inline line ${row.line + 1}: ${part} (must be a value, not x)`);
          seen[m[1]] = m[2];
        }
      }
      assert.deepStrictEqual(Object.keys(seen).sort(), ['cnt', 'en', 'next'], 'inline values for en, next, cnt: ' + JSON.stringify(inline));
      // the condition breakpoint on `cnt <= next`: its setBreakpoints answer, then Continue
      const doc = await vscode.workspace.openTextDocument(sv);
      let line = -1;
      for (let i = 0; i < doc.lineCount; i++) { if (/cnt\s*<=\s*next/.test(doc.lineAt(i).text)) { line = i; break; } }
      assert.ok(line >= 0, 'cnt <= next in dbg_top.sv');
      const from = sent.length;
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(sv, new vscode.Position(line, 0)), true, COND)]);
      const resp = await until(async () => sent.slice(from).find((m) => m.type === 'response' && m.command === 'setBreakpoints' && m.body && m.body.breakpoints && m.body.breakpoints.length), 'setBreakpoints answer', 30000, 50);
      const bp = resp.body.breakpoints[0];
      assert.ok(bp.message || bp.verified, 'the breakpoint answers (verified or a message): ' + JSON.stringify(bp));
      const r = await stopAfter(() => vscode.commands.executeCommand('workbench.action.debug.continue'), 'stop after Continue', 120000);
      const desc = r.ev.body.description || r.ev.body.text || r.ev.body.reason;
      assert.ok(desc, 'Continue reports why it stopped: ' + JSON.stringify(r.ev.body));
      console.log(`  demo dbg ${name}: outsideWrites ${JSON.stringify(ow.workspaceValue ?? ow.workspaceFolderValue)}; F10x3 ${t0} -> ${s.time}; Locals en ${locals.en}, next ${locals.next}, cnt ${locals.cnt}; ` +
        `inline en ${seen.en}, next ${seen.next}, cnt ${seen.cnt}; bp line ${line + 1} "${COND}": ${JSON.stringify({ verified: bp.verified, message: bp.message })}; continue -> ${r.ev.body.reason} "${desc}" at ${r.s && r.s.time}`);
      // Stop
      await vscode.commands.executeCommand('vaporview.debugger.stop');
      await until(async () => !vscode.debug.activeDebugSession, 'session ended', 30000);
    } finally {
      await stopAll();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    const after = snapshot(DIR);
    assert.deepStrictEqual(after, before, 'the demo folder is unchanged');
  };
}

const dumps = DIR && fs.existsSync(DIR) ? ['dbg.fsdb', 'dbg.wcz'].filter((f) => fs.existsSync(path.join(DIR, f))) : [];
module.exports = Object.fromEntries(dumps.map((f) => [`demo c-debugger ${f}: F5, F10 x3, Locals + inline values (no x), cnt == 8'h2a breakpoint, Stop`, onFile(f)]));
