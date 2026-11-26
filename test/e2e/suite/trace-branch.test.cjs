// vscode-port: the branch Trace Driver names must agree with the dump. The user's demo design (dbg_top: two
// `counter`s, u1 enabled by en1 = phase[0]) on its VCS-run twin (open() prefers <rel>.vcs.<fmt>), where the port copy
// dbg_top.u1.en is not in the dump (VCS dumps no port copies): Trace reads it through its connection (.en(en1)).
// u1.cnt goes 01 -> 02 at the 35 edge (en = 1: `cnt <= next` ran) and holds at the 45 edge (en = 0).
// FSDB then WCZ (E2E_FORMAT). Run: tools/linux-test.sh fmt trace-branch
// SPDX-License-Identifier: GPL-3.0-or-later
const path = require('path');
const { vscode, assert, open, root, query } = require('./helpers.cjs');
const { FORMAT } = require('./format.cjs');
const { useHelper, setSetting } = require('./wisp-common.cjs');

const dir = path.join(root, 'test/e2e/fixtures/dbg');
const LONG = 30 * 60 * 1000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);
const state = () => vscode.commands.executeCommand('vaporview.e2e.traceState');
const panel = (q) => vscode.commands.executeCommand('vaporview.e2e.tracePanel', q);

async function setup(outsideWrites) {
  if (FORMAT) { assert.ok(await useHelper('trace branch on ' + FORMAT), 'wisp-helper for E2E_FORMAT=' + FORMAT); }
  await setSetting('wisp.outsideWrites', outsideWrites);
  const cfg = vscode.workspace.getConfiguration('vaporview');
  await cfg.update('trace.designArgs', ['dbg_top.sv', '--top', 'dbg_top'], vscode.ConfigurationTarget.Global);
  await cfg.update('trace.designRoot', dir, vscode.ConfigurationTarget.Global);
  const uri = String(await open('dbg/dbg.vcd'));
  assert.ok(!FORMAT || new RegExp(`\\.${FORMAT}$`).test(uri), `the ${FORMAT} twin: ${uri}`);
  return uri;
}
async function trace(uri, time) {
  const st = await withTimeout(vscode.commands.executeCommand('vaporview.traceDriver', { uri, designPath: 'dbg_top.u1.cnt', time }), LONG, 'trace u1.cnt@' + time);
  assert.ok(st && !st.error, `trace u1.cnt@${time}: ${JSON.stringify(st)}`);
  return { st, em: (await state()).emphasis };
}
const enOf = (st) => (st.fanin || []).find((f) => f.path === 'dbg_top.u1.en');
const brief = (st) => JSON.stringify({ stmt: st.stmt && st.stmt.src, line: st.stmt && st.stmt.loc && st.stmt.loc.line, decisions: (st.decisions || []).map((d) => [d.src, d.value, d.taken, !!d.xCond]),
  en: enOf(st) && [enOf(st).value, enOf(st).dumped, enOf(st).resolvedVia, enOf(st).noValueText], noValue: (st.fanin || []).filter((f) => f.noValue).map((f) => f.path), reasons: (st.reasons || []).map((r) => r.code), value: st.value, since: st.since, xInfer: st.xInfer, candidates: st.candidates });

// The fan-in table fits a narrow panel: names relative to the traced signal's
// instance (en, not dbg_top.u1.en) with the full path as the tooltip; every row one line high (a long via/computed
// note is cut, not wrapped into a blank gap); no sideways overflow; each value in view.
async function fits(what) {
  const L = await vscode.commands.executeCommand('vaporview.e2e.tracePanel', { kind: 'layout', width: 300 });
  const msg = what + ': ' + JSON.stringify(L);
  assert.ok(L && L.heights && L.heights.length, msg);
  const i = L.titles.findIndex((t) => t.split('\n')[0] === 'dbg_top.u1.en');
  assert.ok(i >= 0 && L.names[i] === 'en', 'relative name, full path in the tooltip: ' + msg);
  assert.ok(L.heights.every((h) => h === L.heights[0] && h <= L.line + 6), 'one line per row: ' + msg);
  assert.ok(L.overflow <= 0, 'no sideways overflow: ' + msg);
  assert.ok(L.valueVisible.every(Boolean), 'values in view: ' + msg);
}

// (the trace.* settings this suite sets are put back when it ends: trace-settings-guard.cjs)
module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  'Trace Driver u1.cnt@37: `cnt <= next` ran (en = 1, read via en1 when the dump has no u1.en); the editor marks that line inside the block': async () => {
    const uri = await setup();
    // DIAGNOSTIC: is the port copy in this file (VCS: no), and does the helper compute it (outsideWrites=none)?
    const direct = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time: 34, instancePaths: ['dbg_top.u1.en'] }).catch((e) => String(e));
    console.log(`  DIAGNOSTIC trace-branch (${FORMAT || 'vcd'}) ${path.basename(uri)}: dbg_top.u1.en in the viewer at 34: ${JSON.stringify(direct)}`);
    const { st, em } = await trace(uri, 37);
    console.log(`  DIAGNOSTIC trace-branch u1.cnt@37: ${brief(st)}; emphasis ${JSON.stringify(em)}`);
    assert.strictEqual(st.stmt.src.replace(/\s+/g, ' ').trim(), 'cnt <= next;', brief(st));
    assert.strictEqual(st.stmt.loc.line, 16, brief(st));
    assert.notStrictEqual(st.wrote, false, brief(st));
    assert.ok(!(st.reasons || []).some((r) => r.code === 'noWrite' || r.code === 'notDumped' || r.code === 'branchInferred'), brief(st));
    assert.deepStrictEqual((st.decisions || []).map((d) => [d.src, d.taken, !!d.xCond]), [['rst', 'else', false], ['en', 'then', false]], brief(st));
    const en = enOf(st);
    assert.ok(en && en.value === '1', 'en = 1: ' + brief(st));
    assert.ok(en.dumped !== false || /dbg_top\.en1/.test(en.resolvedVia || ''), 'en read from the dump, or via en1: ' + brief(st));
    if (en.dumped === false) {
      const rows = await panel({ kind: 'attrs', selector: 'tr.fanin' });
      assert.ok(rows.some((r) => r.path === 'dbg_top.u1.en' && /dbg_top\.en1/.test(r.via || '')), 'the panel says via en1: ' + JSON.stringify(rows));
    }
    await fits('u1.cnt@37');
    // The editor: the block (14-17) stays highlighted; line 16 is the driver; line 15 (`cnt <= 8'd0`) another write;
    // the if lines show their conditions' values.
    assert.ok(em && /dbg_top\.sv$/.test(em.file), JSON.stringify(em));
    assert.deepStrictEqual(em.block, [[14, 17]], JSON.stringify(em));
    assert.deepStrictEqual(em.driver, [[16, 16]], JSON.stringify(em));
    assert.deepStrictEqual(em.possible, [], JSON.stringify(em));
    assert.ok(em.others.some(([a, b]) => a === 15 && b === 15), 'line 15 is another write: ' + JSON.stringify(em));
    assert.ok(em.conditions.some((c) => c.line === 15 && /rst = 1'b0/.test(c.text)) && em.conditions.some((c) => c.line === 16 && /en = 1'b1/.test(c.text)), JSON.stringify(em.conditions));
  },

  'outsideWrites none: u1.cnt@37 reads en from the helper\'s computed port copy (as the waveform shows it), labelled, not via the design': async () => {
    try {
      const uri = await setup('none');
      const { st } = await trace(uri, 37);
      const en = enOf(st);
      console.log(`  DIAGNOSTIC trace-branch outsideWrites none u1.cnt@37: ${brief(st)}; en ${JSON.stringify(en)}`);
      assert.strictEqual(st.stmt.loc.line, 16, brief(st));
      assert.ok(en && en.value === '1' && en.dumped !== false && !en.resolvedVia, 'en from the file, not via the design: ' + JSON.stringify(en));
      if (FORMAT === 'fsdb') {
        // VCS dumps no port copy: on the FSDB it is the helper's computed one
        assert.ok(en.computed && en.computedText === 'computed by the helper (port copy)', 'labelled computed: ' + JSON.stringify(en));
        const rows = await panel({ kind: 'attrs', selector: 'tr.fanin' });
        assert.ok(rows.some((r) => r.path === 'dbg_top.u1.en' && r.computed === 'computed by the helper (port copy)'), JSON.stringify(rows));
        await fits('outsideWrites none u1.cnt@37 (computed note)');
      }
    } finally { await setSetting('wisp.outsideWrites', undefined); }
  },

  'Trace Driver u1.cnt@47: cnt held at the 45 edge (en = 0), so the value in effect (02) was made at the 35 edge by `cnt <= next`, not "keeps its value"': async () => {
    // Trace Driver explains the value at the marker: the 45 edge's run took the else of `if (en)` and wrote nothing,
    // so the step is the run that made 02 (the 35 edge). The invariant (index.cjs) checks it against the dump.
    const uri = await setup();
    const { st, em } = await trace(uri, 47);
    console.log(`  DIAGNOSTIC trace-branch u1.cnt@47: ${brief(st)}; activation ${JSON.stringify(st.activation)}; emphasis ${JSON.stringify(em)}`);
    assert.strictEqual(st.since, 35, brief(st));
    assert.strictEqual(st.activation && st.activation.time, 35, 'made at the 35 edge: ' + JSON.stringify(st.activation));
    assert.strictEqual(st.stmt.loc.line, 16, brief(st));
    assert.ok(!(st.reasons || []).some((r) => r.code === 'noWrite'), brief(st));
    assert.strictEqual(enOf(st) && enOf(st).value, '1', 'en at the 35 edge: ' + brief(st));
    assert.deepStrictEqual(em.block, [[14, 17]], JSON.stringify(em));
    assert.deepStrictEqual(em.driver, [[16, 16]], JSON.stringify(em));
    assert.ok(em.others.some(([a]) => a === 15), JSON.stringify(em));
    // en at the 45 edge (sample 44) is 0 in the dump or through en1: the held value.
    const at44 = await vscode.commands.executeCommand('vaporview.trace.resolvePortValue', { uri, designPath: 'dbg_top.u1.en', time: 44 });
    const direct = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time: 44, instancePaths: ['dbg_top.u1.en'] }).catch(() => null);
    console.log(`  DIAGNOSTIC trace-branch u1.en@44: resolved ${JSON.stringify(at44)}; viewer ${JSON.stringify(direct)}`);
    const dumped = Array.isArray(direct) && direct[0] && Array.isArray(direct[0].value) && direct[0].value.length;
    if (!dumped) { assert.deepStrictEqual(at44, { value: '0', via: 'dbg_top.en1 (port connection)', dumped: false }); }
  },

  ', without reading through connections: u1.en has NO VALUE (not in the dump), never 1\'bx; no branch assumed; only the dump-confirmed or possible drivers': async () => {
    const uri = await setup();
    await vscode.commands.executeCommand('vaporview.e2e.traceResolveMissing', false);
    try {
      const { st, em } = await trace(uri, 37);
      console.log(`  DIAGNOSTIC trace-branch u1.cnt@37 unresolved: ${brief(st)}; en ${JSON.stringify(enOf(st))}; emphasis ${JSON.stringify(em)}`);
      if (enOf(st) && enOf(st).dumped !== false) { console.log('  NOT RUN trace-branch no-value: this file has dbg_top.u1.en'); return; }
      const en = enOf(st);
      assert.ok(en && en.value === null && en.noValueText === 'no value (not in the dump)', 'en: no value (not in the dump): ' + JSON.stringify(en));
      const d = (st.decisions || []).find((x) => x.src === 'en');
      assert.ok(d && d.noValue && d.value === null && d.noValueText === 'en: no value (not in the dump)', 'the en condition has no value: ' + JSON.stringify(d));
      assert.ok(!em.conditions.some((c) => /'bx/.test(c.text)), 'no 1\'bx shown: ' + JSON.stringify(em.conditions));
      assert.ok(em.conditions.some((c) => c.line === 16 && /en: no value \(not in the dump\)/.test(c.text)), JSON.stringify(em.conditions));
      assert.ok(!(st.reasons || []).some((r) => r.code === 'noWrite'), 'never "keeps its value" on a no-value condition: ' + brief(st));
      if (st.inferred) {
        // the dump confirmed one branch only: named as inferred (the possible-driver style), never the plain driver style
        assert.strictEqual(st.stmt.loc.line, 16, brief(st));
        assert.ok(d.inferred && d.taken === 'then', JSON.stringify(d));
        assert.deepStrictEqual(em.driver, [], JSON.stringify(em));
        assert.deepStrictEqual(em.possible, [[16, 16]], JSON.stringify(em));
      } else {
        // `cnt <= next` is the only branch a run can take with rst = 0 and the value changing; next's value is not
        // confirmed (not in the dump here either), so it is listed as possible, not named.
        assert.strictEqual(d.taken, 'unknown', JSON.stringify(d));
        assert.ok((st.reasons || []).some((r) => r.code === 'noValueCondition'), brief(st));
        assert.deepStrictEqual((st.candidates || []).map((c) => c.loc.line), [16], 'possible drivers: ' + brief(st));
        assert.deepStrictEqual(em.driver, [], JSON.stringify(em));
        assert.deepStrictEqual(em.possible, [[16, 16]], JSON.stringify(em));
      }
      const rows = await panel({ kind: 'attrs', selector: 'tr.fanin' });
      assert.ok(rows.some((r) => r.path === 'dbg_top.u1.en' && r.novalue === 'no value (not in the dump)'), 'the panel says no value: ' + JSON.stringify(rows));
      const lis = await panel({ kind: 'texts', selector: 'li.decision' });
      assert.ok(lis.some((t) => /if \(en\): en: no value \(not in the dump\)/.test(t)) && !lis.some((t) => /'bx|= x/.test(t)), JSON.stringify(lis));
      // the shared resolver says the same, typed
      const r = await vscode.commands.executeCommand('vaporview.trace.resolvePortValue', { uri, designPath: 'dbg_top.u1.en', time: 34 });
      assert.deepStrictEqual(r, { noValue: true, reason: 'notDumped', path: 'dbg_top.u1.en', text: 'no value (not in the dump)' });
    } finally {
      await vscode.commands.executeCommand('vaporview.e2e.traceResolveMissing', true);
    }
  },
});
