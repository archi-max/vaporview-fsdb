// vscode-port P4 acceptance: every debugger command is in the palette (contributes.commands) with a category, the
// stepping commands have keys that VS Code does not already use, the debug type is contributed, and the palette's
// Debug This Waveform starts a session on the active viewer.
const { vscode, assert, until, activate } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');

module.exports = D.suite({
  'dbg: commands in the palette with keys; debug type contributed': async () => {
    const ext = await activate();
    const pkg = ext.packageJSON;
    const all = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith('vaporview.debugger.') && c !== 'vaporview.debugger.e2e');
    assert.ok(all.length >= 20, `${all.length} debugger commands registered`);
    const contributed = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
    for (const id of all) {
      assert.ok(contributed.has(id), `${id} is not in contributes.commands`);
      assert.strictEqual(contributed.get(id).category, 'VaporView FSDB', id);  // vscode-port: one palette category
    }
    const hidden = (pkg.contributes.menus.commandPalette || []).filter((m) => m.command.startsWith('vaporview.debugger.') && m.when === 'false');
    assert.deepStrictEqual(hidden, [], 'none is hidden from the palette');
    const keys = pkg.contributes.keybindings;
    const keyOf = (cmd) => keys.find((k) => k.command === cmd);
    for (const cmd of ['workbench.action.debug.stepBack', 'workbench.action.debug.reverseContinue', 'vaporview.debugger.first', 'vaporview.debugger.last',
      'vaporview.debugger.togglePlay', 'vaporview.debugger.faster', 'vaporview.debugger.slower', 'vaporview.debugger.start', 'vaporview.debugger.toggleLineBreakpointAnyInstance']) {
      assert.ok(keyOf(cmd), `no key for ${cmd}`);
    }
    // Keys VS Code binds by default (Shift+F10 context menu, Shift+F5 stop, Ctrl+F5 run, Alt+F5 next change ...) are not reused.
    const taken = ['shift+f10', 'shift+f5', 'ctrl+f5', 'alt+f5', 'shift+alt+f5', 'ctrl+shift+f5', 'ctrl+shift+f10', 'alt+f9', 'ctrl+f9', 'f9', 'f10', 'f11', 'shift+f11'];
    for (const k of keys.filter((x) => String(x.command).startsWith('vaporview.debugger.') || String(x.when || '').includes('vaporview-waveform'))) {
      assert.ok(!taken.includes(k.key), `${k.command} uses ${k.key}`);
    }
    const dbg = pkg.contributes.debuggers.find((d) => d.type === D.DT);
    assert.ok(dbg && dbg.configurationAttributes.attach, 'debuggers contribution');
    assert.ok(pkg.contributes.breakpoints.some((b) => b.language === 'systemverilog'), 'F9 in .sv files');
    // Row menu items.
    const row = pkg.contributes.menus['webview/context'].filter((m) => String(m.command).startsWith('vaporview.debugger.')).map((m) => m.command);
    assert.deepStrictEqual(row.sort(), ['vaporview.debugger.breakWhenChanges', 'vaporview.debugger.breakWhenEquals', 'vaporview.debugger.breakWhenTextMatches', 'vaporview.debugger.useSelectedAsClock']);
  },
  'dbg: Debug This Waveform (palette / F5 in the viewer) starts on the active viewer; Stop ends it': async () => {
    const log = (m) => console.log(`  [dbg-commands] ${m}`);
    const bounded = (p, what, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
    const { uri } = await bounded(D.start(), 'start');
    log('started'); await bounded(D.stopAll(), 'stopAll'); log('stopped');
    assert.ok(!vscode.debug.activeDebugSession, 'no session before the command');
    await bounded(Promise.resolve(vscode.commands.executeCommand('vaporview.debugger.start')), 'vaporview.debugger.start');
    log('command returned');
    const s = await until(async () => { const x = await D.session(); return x && x.cycle ? x : null; }, 'session from the command');
    assert.strictEqual(s.uri, uri);
    assert.strictEqual(vscode.debug.activeDebugSession.type, D.DT);
    await bounded(Promise.resolve(vscode.commands.executeCommand('vaporview.debugger.stop')), 'vaporview.debugger.stop');
    log('stop returned');
    await until(async () => !vscode.debug.activeDebugSession, 'stopped');
  },
});
