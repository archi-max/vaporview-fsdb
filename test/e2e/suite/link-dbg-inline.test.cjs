// vscode-port: one set of inline values per line. While a waveform debug session runs on the dump, the
// debugger's InlineValuesProvider (values of the stopped cycle) is the only one: source link's after-line annotations
// hide on the SV editors; they come back when the session ends (a user report: every line twice).
// FSDB, then WCZ (E2E_FORMAT).
// SPDX-License-Identifier: GPL-3.0-or-later
const { vscode, assert, until, activate, format } = require('./helpers.cjs');
const D = require('./dbg-helpers.cjs');
const { keepDesign } = require('./link-design-guard.cjs');

const linkValues = (sv) => vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: sv });
const linkStatus = () => vscode.commands.executeCommand('vaporview.sourceLink.status');

module.exports = keepDesign(D.suite({
  'Inline values: during a waveform debug session only the debugger\'s; source link\'s come back after Stop': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN link-dbg-inline: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    await activate();
    const sv = String(D.SV());
    await until(async () => {
      const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: sv });
      return Array.isArray(r) && r.includes('dbg_top') ? r : null;
    }, 'slang top level dbg_top', 60000, 1000);
    const { uri } = await D.start();
    await vscode.window.showTextDocument(D.SV(), { viewColumn: vscode.ViewColumn.Beside });
    // During the session: the debugger gives values, source link none (status says why).
    const dbg = await until(async () => {
      const v = await D.e2e({ kind: 'inline', uri: sv, first: 0, last: 60 });
      return v && v.length ? v : null;
    }, 'debugger inline values', 20000, 250);
    await until(async () => (await linkStatus()).debuggerShowsValues === true, 'source link sees the debug session', 10000, 100);
    await until(async () => { const v = await linkValues(sv); return Array.isArray(v) && v.length === 0; }, 'source link inline values hidden', 10000, 100);
    // Exactly one value set per line: no line carries both.
    const link = (await linkValues(sv)) || [];
    const both = dbg.map((d) => d.line).filter((l) => link.some((x) => x.line === l));
    assert.deepStrictEqual(both, [], `lines with two value sets: ${both}`);
    const dbgLines = dbg.length;
    // Stop: the debugger's go, source link's come back (for the marker the session left).
    await D.stopAll();
    await until(async () => (await linkStatus()).debuggerShowsValues === false, 'source link sees the session end', 10000, 100);
    const back = await until(async () => { const v = await linkValues(sv); return Array.isArray(v) && v.length ? v : null; }, 'source link inline values back after Stop', 30000, 250);
    assert.ok(back.every((v) => v.value !== undefined), JSON.stringify(back));
    console.log(`LINKDBG ${format}: during the session debugger lines ${dbgLines} (e.g. line ${dbg[0].line}: ${JSON.stringify(dbg[0].text)}), source link 0; after Stop source link ${back.length} values on ${new Set(back.map((v) => v.line)).size} lines (${uri.split('/').pop()})`);
  },
}));
