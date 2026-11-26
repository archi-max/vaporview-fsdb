// vscode-port: the viewer's value API (waveformViewer.getValuesAtTime) on FSDB / WCZ for names the dump
// lacks. With vaporview.wisp.outsideWrites unset the helper does not compute VCS port copies or assign nets (dbg:
// dbg_top.en1, dbg_top.u0.next), so the value API reads them through the shared resolver (as inline values and Trace do)
// and labels them `via`; where the design gives no value (dbg_partial2: dbg_top.u1.cnt without its port wire) the entry
// is the no-value state with the reason. Never a dropped entry ("no value" where the design has an answer).
const { vscode, assert, until, open, root, activate, format } = require('./helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const w = require('./wisp-common.cjs');

const src = vscode.Uri.file(path.join(root, 'test/e2e/fixtures/dbg/dbg_top.sv'));
const api = (uri, time, paths) => vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time, instancePaths: paths });
const last = (v) => { if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } } return Array.isArray(v) ? v[v.length - 1] : v; };
const num = (v) => /^[01]+$/.test(String(v)) ? parseInt(String(v), 2) : NaN;

async function unsetOutsideWrites() {
  const c = vscode.workspace.getConfiguration('vaporview');
  for (const t of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]) { await c.update('wisp.outsideWrites', undefined, t); }
}
/** The design comes from the link's top level (dbg_top): a vaporview.trace.designArgs / designRoot another test left
 *  (trace-wisp sets them per case) would make the resolver load that design instead. Saved, cleared, restored. */
async function withoutTraceDesign(fn) {
  const c = () => vscode.workspace.getConfiguration('vaporview');
  const keys = ['trace.designArgs', 'trace.designRoot'];
  const T = [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace];
  const saved = keys.map((k) => { const i = c().inspect(k) || {}; return [i.globalValue, i.workspaceValue]; });
  for (const k of keys) { for (const t of T) { await c().update(k, undefined, t); } }
  try { return await fn(); } finally {
    for (let i = 0; i < keys.length; i++) { for (let j = 0; j < T.length; j++) { if (saved[i][j] !== undefined) { await c().update(keys[i], saved[i][j], T[j]); } } }
  }
}

module.exports = {
  'Value API (outsideWrites unset): names the dump lacks come through the resolver with `via`, else the no-value state': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN value API: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    await activate();
    await unsetOutsideWrites();
    await withoutTraceDesign(async () => {
    await until(async () => {
      const r = await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: src.toString() });
      return Array.isArray(r) && r.includes('dbg_top') ? r : null;
    }, 'slang top level dbg_top', 60000, 1000);
    try {
      const uri = String(await open('dbg/dbg.vcd'));
      const ws = await w.wispState(uri);
      assert.ok(!ws || ws.outsideWrites !== 'none', 'opened with outsideWrites unset: ' + JSON.stringify(ws && ws.outsideWrites));
      const lines = [];
      let viaSeen = 0;
      for (const t of [34, 105, 256]) {
        const want = {};
        // The truth from stored signals only (u0's counter is stored as c0 or u0.cnt, whichever the simulator kept).
        const stored = (await api(uri, t, ['dbg_top.phase', 'dbg_top.c0', 'dbg_top.u0.cnt'])).filter((x) => !x.via && !x.noValue);
        const val = (p) => { const x = stored.find((y) => y.instancePath === p); return x ? num(last(x.value)) : NaN; };
        const ph = val('dbg_top.phase');
        const c0 = Number.isNaN(val('dbg_top.c0')) ? val('dbg_top.u0.cnt') : val('dbg_top.c0');
        assert.ok(!Number.isNaN(ph) && !Number.isNaN(c0), `phase and c0 are stored at ${t}: ${JSON.stringify(stored)}`);
        want['dbg_top.en1'] = ph & 1;
        want['dbg_top.u0.next'] = (c0 + 1) & 0xff;
        const paths = Object.keys(want);
        const r = await api(uri, t, paths);
        assert.deepStrictEqual(r.map((x) => x.instancePath), paths, `one entry per requested name, in order, at ${t}: ${JSON.stringify(r)}`);
        for (const x of r) {
          assert.ok(!x.noValue, `${x.instancePath}@${t} has a design answer, not "no value": ${JSON.stringify(x)}`);
          assert.strictEqual(num(last(x.value)), want[x.instancePath], `${x.instancePath}@${t}: ${JSON.stringify(x)}`);
          if (x.via) { viaSeen++; assert.ok(/\((port connection|continuous assign)\)$/.test(x.via), `via label: ${JSON.stringify(x)}`); }
          lines.push(`${x.instancePath}@${t}=${last(x.value)}${x.via ? ' via ' + x.via : ' (stored)'}`);
        }
      }
      // FSDB (VCS) stores neither en1 nor u0.next: both must come through the resolver.
      if (format === 'fsdb') { assert.ok(viaSeen >= 2, `FSDB: resolved through the design (${viaSeen} via)`); }
      // A name that is in neither the dump nor the design: the no-value state, never dropped.
      const [bogus] = await api(uri, 34, ['dbg_top.no_such_net']);
      assert.ok(bogus && bogus.noValue && Array.isArray(bogus.value) && bogus.value.length === 0 && /^no value/.test(bogus.noValue.text), `no_such_net: ${JSON.stringify(bogus)}`);
      lines.push(`no_such_net: ${bogus.noValue.text}`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      // dbg_partial2 (u1.cnt and its port wire c1 dropped): u1.cnt has no value, with a "not computable" reason.
      const u2 = String(await open('dbg/dbg_partial2.vcd'));
      const [cnt] = await api(u2, 105, ['dbg_top.u1.cnt']);
      assert.ok(cnt && cnt.noValue && cnt.noValue.reason === 'notComputable' && /^no value \(not computable/.test(cnt.noValue.text), `dbg_partial2 u1.cnt: ${JSON.stringify(cnt)}`);
      lines.push(`dbg_partial2 u1.cnt@105: ${cnt.noValue.text}`);
      console.log(`VALUEAPI ${format} outsideWrites unset: ${lines.join('; ')}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    });
  },

  // an unknown-mode port copy the dump lists without values (VCS FSDB, outsideWrites unset:
  // "port copy: values not linked yet") says so in its no-value text when the resolver has no value either; the
  // reason code stays notDumped. A name the dump does not list keeps "not in the dump". WCZ links the copies itself.
  'Value API (outsideWrites unset, FSDB): a port copy without values says why ("port copy: values not linked yet")': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN value API port copy: FSDB / WCZ only (E2E_FORMAT=${format}; )`); return; }
    await activate();
    await unsetOutsideWrites();
    await withoutTraceDesign(async () => {
      try {
        const uri = String(await open('link/fsm.vcd'));
        const ws = await w.wispState(uri);
        assert.ok(!ws || ws.outsideWrites !== 'none', 'opened with outsideWrites unset: ' + JSON.stringify(ws && ws.outsideWrites));
        const r = await api(uri, 475, ['tb.dut.busy', 'tb.dut.u_ctl.busy', 'tb.dut.no_such_net']);
        assert.deepStrictEqual(r.map((x) => x.instancePath), ['tb.dut.busy', 'tb.dut.u_ctl.busy', 'tb.dut.no_such_net'], 'one entry each: ' + JSON.stringify(r));
        const lines = r.map((x) => `${x.instancePath}: ${x.noValue ? x.noValue.reason + ' ' + x.noValue.text : last(x.value) + (x.via ? ' via ' + x.via : '')}`);
        console.log(`PORTCOPY ${format}: ${lines.join('; ')}`);
        const bogus = r[2];
        // (the resolver may hold another test's design: then it is notComputable/failed, else "not in the dump")
        assert.ok(bogus.noValue && /^no value/.test(bogus.noValue.text) && !/port copy/.test(bogus.noValue.text), 'no_such_net: ' + JSON.stringify(bogus));
        if (format === 'fsdb') {
          let said = 0;
          for (const x of r.slice(0, 2)) {
            assert.ok(x.noValue || x.via, `${x.instancePath}: an unlinked copy is a resolver answer or no value: ${JSON.stringify(x)}`);
            if (x.noValue) { said++; assert.deepStrictEqual(x.noValue, { reason: 'notDumped', text: 'no value (port copy: values not linked yet)' }, JSON.stringify(x)); }
          }
          assert.ok(said >= 1, 'at least one unlinked copy has no value and says why: ' + JSON.stringify(r));
        }
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    });
  },

  // CVA6: 1-bit array elements whose index equals their own range (msb=lsb=0). createVar lists
  // "packet_valid[0]" (1-D unpacked) as "packet_valid"; "vld_mirror[83][0]" (2-D) lost its [0]. A path with the
  // index must still find the signal: the value API answered "no value" where the dump has '1'.
  'Value API: 1-bit array elements by their full path (CVA6 packet_valid[0], vld_mirror[n][0])': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN array elements: FSDB / WCZ only (E2E_FORMAT=${format})`); return; }
    const dir = process.env.E2E_CVA6_DIR || path.join(os.homedir(), 'vaporview-demo/cva6');
    const file = path.join(dir, 'cva6-coremark.' + format);
    if (!fs.existsSync(file)) { console.log(`NOT RUN array elements: no ${file}`); return; }
    await unsetOutsideWrites();
    const IC = 'ariane_tb.dut.i_ariane.i_cva6.gen_cache_wt.i_cache_subsystem.i_cva6_icache';
    const DC = 'ariane_tb.dut.i_ariane.i_cva6.gen_cache_wt.i_cache_subsystem.i_wt_dcache.i_wt_dcache_mem';
    // [path, time, value the dump has there (truth reader), or null: any 0/1]
    const cases = format === 'fsdb'
      ? [[IC + '.vld_mirror[83][0]', 1644730, '1'], [DC + '.vld_mirror[42][0]', 1620170, '1'], ['ariane_tb.dut.i_encoder.packet_valid[0]', 1644730, null]]
      : [[IC + '.vld_mirror[201][0]', 20310, '1'], ['ariane_tb.dut.i_encoder.packet_valid[0]', 1644730, null]];
    try {
      const uri = String(await open(vscode.Uri.file(file)));
      const lines = [];
      for (const [p, t, want] of cases) {
        const r = await until(async () => { const x = await api(uri, t, [p]); return x && x.length ? x : null; }, `${p}@${t}`, 120000, 500);
        const x = r[0];
        assert.ok(!x.noValue && !x.via, `${p}@${t} is in the dump: ${JSON.stringify(x)}`);
        const v = String(last(x.value));
        if (want !== null) { assert.strictEqual(v, want, `${p}@${t}: ${JSON.stringify(x)}`); } else { assert.ok(/^[01]$/.test(v), `${p}@${t}: ${JSON.stringify(x)}`); }
        lines.push(`${p.split('.').slice(-2).join('.')}@${t}=${v}`);
      }
      // A signal with no change recorded (rv_tracer packet_f_opt_ext_subformat, drivers commented out): the helper's
      // answer as is (x) until the helper says "no records" itself; never dropped.
      const NC = 'ariane_tb.dut.i_encoder.packet_f_opt_ext_subformat[0]';
      const [nc] = await api(uri, 7114890, [NC]);
      assert.ok(nc && (nc.noValue || /^[01xz]$/i.test(String(last(nc.value)))), `${NC}@7114890: an entry: ${JSON.stringify(nc)}`);
      lines.push(`packet_f_opt_ext_subformat[0]@7114890: ${nc.noValue ? nc.noValue.text : last(nc.value)}`);
      console.log(`ARRAYELEM ${format}: ${lines.join('; ')}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  },

  // a 4-state reg with no reset stays x and VCS writes no record for it (a-trace/a tb_a.dut.acc).
  // Its value is x, never "no value".
  'Value API: an x the dump never changes (a-trace/a acc, no reset) is x, not no value': async () => {
    if (format !== 'fsdb' && format !== 'wcz') { console.log(`NOT RUN x: FSDB / WCZ only (E2E_FORMAT=${format})`); return; }
    const fmt = process.env.E2E_FIXTURES_FMT_DIR || '';
    const file = path.join(fmt, format, 'test/e2e/fixtures/trace/a.vcs.' + format);
    if (!fmt || !fs.existsSync(file)) { console.log(`NOT RUN x: no ${file}`); return; }
    await unsetOutsideWrites();
    try {
      const uri = String(await open(vscode.Uri.file(file)));
      const out = [];
      for (const t of [5, 55, 100]) {
        const [x] = await api(uri, t, ['tb_a.dut.acc']);
        assert.ok(x && !x.noValue && /^x+$/i.test(String(last(x.value))), `acc@${t} = x: ${JSON.stringify(x)}`);
        out.push(`acc@${t}=${last(x.value)}`);
      }
      console.log(`XSTAYS ${format}: ${out.join('; ')}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  },
};
