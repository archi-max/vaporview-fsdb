// vscode-port: a signal the helper computes OUTSIDE the stats port-copy range (VCS does not store design
// H's 2-driver wire tb_h.dut.bus; with outsideWrites none the helper computes it and answers it in windows only). Its
// valueAt was refused ("a computed signal answers window requests only"), so the value API, inline values, Locals and
// Watch showed nothing for it. The data layer learns such ids from the refusal and answers them through windows.
// FSDB (h.vcs.fsdb, outsideWrites none), then WCZ (h.vcs.wcz; the converter stores bus). Truth: tb_h.sv, bus = b (1010)
// before t=30, a (0101) after.
const { vscode, assert, until, open, root, activate, format } = require('./helpers.cjs');
const path = require('path');

const tb = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/trace/tb_h.sv'));
const src = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/trace/h_bus.sv'));
const api = (uri, time, paths) => vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: paths });
const last = (v) => { if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } } return Array.isArray(v) ? v[v.length - 1] : v; };
const bits4 = (v) => { const s = String(v).trim().toLowerCase().replace(/_/g, ''); const m = /^(?:\d*'s?)?([bh]?)([0-9a-fxz]+)$/.exec(s);
  if (!m) { return s; } if (m[1] === 'h' || (!m[1] && !/^[01]{4}$/.test(m[2]))) { return parseInt(m[2], 16).toString(2).padStart(4, '0'); } return m[2].padStart(4, '0'); };

module.exports = {
  'Computed FSDB signal outside the port-copy range (design H bus, outsideWrites none): value API, inline value and search': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN computed bus: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    await activate();
    const c = vscode.workspace.getConfiguration('vaporview');
    const before = c.inspect('wisp.outsideWrites')?.workspaceValue;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (format === 'fsdb') { await c.update('wisp.outsideWrites', 'none', vscode.ConfigurationTarget.Workspace); }
    try {
      await until(async () => {
        const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: tb.toString() });
        return Array.isArray(r) && r.includes('tb_h') ? r : null;
      }, 'slang top level tb_h', 60000, 1000);
      const uri = String(await open('trace/h.vcd'));
      const lines = [];
      for (const [t, want] of [[45, '0101'], [0, '1010'], [15, '1010'], [55, '0101']]) {
        const [x] = await api(uri, t, ['tb_h.dut.bus']);
        assert.ok(x && !x.noValue && Array.isArray(x.value) && x.value.length, `bus@${t}: a value: ${JSON.stringify(x)}`);
        assert.strictEqual(bits4(last(x.value)), want, `bus@${t}: ${JSON.stringify(x)}`);
        lines.push(`bus@${t}=${last(x.value)}${x.via ? ' via ' + x.via : ''}`);
      }
      // inline value on `q <= bus;` with the marker at 45
      const doc = await vscode.workspace.openTextDocument(src);
      let qLine = -1;
      for (let i = 0; i < doc.lineCount; i++) { if (/q <= bus;/.test(doc.lineAt(i).text)) { qLine = i; } }
      assert.ok(qLine >= 0, 'q <= bus; line');
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time: 45 });
      const iv = await until(async () => {
        const all = await vscode.commands.executeCommand('vaporview.sourceLink.getInlineValues', { uri: src.toString() });
        const b = (all || []).find((y) => y.name === 'bus' && y.line === qLine);
        return b && b.value !== undefined && b.value !== null && bits4(b.value) === '0101' ? b : null;
      }, 'inline bus = 0101 at 45', 30000, 250);
      lines.push(`inline bus@45=${iv.value}`);
      // The debugger's breakpoint search (DAP nextMatch: helper cmd 'search') on the computed bus: the first change TO
      // the value strictly after / before t, as on a stored row; never a refusal (a breakpoint search would not end).
      const net = await vscode.commands.executeCommand('vaporview.e2e.netlist', uri, 8, 500);
      const bv = ((net && net.vars) || []).find((v) => v.path === 'tb_h.dut.bus');
      assert.ok(bv && bv.signalId >= 0, 'bus in the netlist with a signal id: ' + JSON.stringify(bv));
      const q = (req) => vscode.commands.executeCommand('vaporview.e2e.wispQuery', uri, req);
      for (const [req, want] of [[{ t: 0, dir: 1, value: '0101' }, 30], [{ t: 60, dir: -1, value: '0101' }, 30], [{ t: 30, dir: 1, value: '1010' }, null],
        [{ t: 0, dir: 1, value: '01??', wildcard: '?' }, 30], [{ t: 30, dir: 1, value: '0101' }, null]]) {
        const r = await q({ cmd: 'search', signalId: bv.signalId, ...req });
        assert.ok(r && !r.error && r.result, `search ${JSON.stringify(req)}: an answer: ${JSON.stringify(r)}`);
        assert.strictEqual(r.result.t, want, `search ${JSON.stringify(req)}: ${JSON.stringify(r)}`);
        lines.push(`search ${req.value} from ${req.t} dir ${req.dir} -> ${r.result.t}`);
      }
      // Oracle: on stored rows the helper's own search / edge / valueAt answers equal the windowed answers (the same ids
      // forced through the computed path), both directions, exact values and '?' wildcards.
      let compared = 0;
      for (const name of ['tb_h.dut.q', 'tb_h.clk', 'tb_h.sel', 'tb_h.a', 'tb_h.b']) {
        const sv = ((net && net.vars) || []).find((v) => v.path === name);
        assert.ok(sv && sv.signalId >= 0, name + ' stored: ' + JSON.stringify(sv));
        const w = sv.width || 1;
        const vals = w === 1 ? ['0', '1', 'x', 'z', '?'] : ['0101', '1010', '0000', 'xxxx', 'zzzz', '1x1x', '?1?1', '1???', '????', '101'];
        const reqs = [];
        for (const value of vals) { for (const t of [0, 4, 5, 6, 30, 31, 45, 60]) { for (const dir of [1, -1]) { reqs.push({ cmd: 'search', signalId: sv.signalId, t, dir, value, ...(value.includes('?') ? { wildcard: '?' } : {}) }); } } }
        const kinds = w === 1 ? ['any', 'rise', 'fall', 'posedge', 'negedge', 'edge'] : ['any', 'rise', 'fall', 'posedge'];
        for (const t of [0, 1, 5, 6, 29, 30, 31, 36, 55, 60]) { for (const dir of [1, -1]) { for (const kind of kinds) { reqs.push({ cmd: 'edge', signalId: sv.signalId, t, dir, kind }); } } reqs.push({ cmd: 'valueAt', signalIds: [sv.signalId], t }); }
        const native = [];
        for (const r of reqs) { native.push(await q(r)); }
        await vscode.commands.executeCommand('vaporview.e2e.wispForceWindowed', uri, [sv.signalId], true);
        try {
          for (let i = 0; i < reqs.length; i++) {
            const got = await q(reqs[i]);
            const pick = (x) => x && x.result ? (reqs[i].cmd === 'valueAt' ? x.result.values : x.result.t) : { error: x && x.error };
            assert.deepStrictEqual(pick(got), pick(native[i]), `${name} ${JSON.stringify(reqs[i])}: windowed ${JSON.stringify(got)} vs helper ${JSON.stringify(native[i])}`);
            compared++;
          }
        } finally { await vscode.commands.executeCommand('vaporview.e2e.wispForceWindowed', uri, [sv.signalId], false); }
      }
      lines.push(`oracle: ${compared} windowed answers = the helper's on 5 stored rows`);
      // Status : reading computed rows leaves no red "damaged" status; a refusal or a limit is a warning that says
      // what it is; only a failed read of the bytes is red.
      const ws = await vscode.commands.executeCommand('vaporview.e2e.wispState', uri);
      assert.ok(!/damaged|unreadable signals/.test(String(ws.status)) && ws.statusLevel !== 'error', 'no red status after computed reads: ' + JSON.stringify({ status: ws.status, level: ws.statusLevel, errs: ws.signalErrors }));
      const note = (errs) => vscode.commands.executeCommand('vaporview.e2e.wispNoteErrors', uri, errs);
      const s1 = await note(['a computed signal answers window requests only']);
      // an expected answer (window-only computed signal) is a neutral note, not counted as "can't be read"
      assert.deepStrictEqual(s1, { status: '$(info) Waveform: 1 computed signal is read in windows only', level: 'note' }, JSON.stringify(s1));
      const s2 = await note(['code block writes only part of its value']);
      assert.deepStrictEqual(s2, { status: "$(info) Waveform: 1 signal can't be read", level: 'warning' }, JSON.stringify(s2));
      // "N signals" counts distinct signals, not replies: one row re-read at three steps (same id) adds 1, not 3 (a
      // CVA6 debug session reached "337 signals" from a few rows read at every step)
      const noteIds = (errs, ids) => vscode.commands.executeCommand('vaporview.e2e.wispNoteErrors', uri, errs, false, ids);
      let sR;
      for (let i = 0; i < 3; i++) {sR = await noteIds(['code block writes only part of its value', 'code block writes only part of its value'], [900001, 900002]);}
      assert.deepStrictEqual(sR, { status: "$(info) Waveform: 3 signals can't be read", level: 'warning' }, 'distinct signals: ' + JSON.stringify(sR));
      const s3 = await note(['truncated record']);
      assert.deepStrictEqual(s3, { status: '$(warning) Waveform: unreadable signals', level: 'error' }, JSON.stringify(s3));
      lines.push(`status: computed reads ${ws.statusLevel || 'none'}; window-only ${s1.level}; limit ${s2.level}; distinct ${sR.status}; damage ${s3.level}`);
      console.log(`COMPUTEDBUS ${format}${format === 'fsdb' ? ' outsideWrites=none' : ''}: ${lines.join('; ')}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await c.update('wisp.outsideWrites', before, vscode.ConfigurationTarget.Workspace);
    }
  },
};
