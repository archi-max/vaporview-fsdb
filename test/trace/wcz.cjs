// vscode-port: tracing over WCZ through wisp-helper (the windowed helper path of src/cmux/trace/dump.ts +
// helper_v2.ts), against the same answers as the VCD (cmux's cases.js pins): the WCZ files are converted from the
// case suite's dumps with wcz-from-vcd. Linux only (wisp-helper). Usage (a Linux host):
//   WISP_HELPER=.../wisp-helper WCZ_FROM_VCD=.../wcz-from-vcd node test/trace/wcz.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../..');
const out = path.join(os.tmpdir(), 'vv-trace-wcz-' + process.pid + '.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src/cmux/trace/core.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
const core = require(out);
const dumpOut = out.replace(/\.cjs$/, '-dump.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src/cmux/trace/dump.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: dumpOut, logLevel: 'error' });
const dumpLib = require(dumpOut);
const vm = require('vm');
const vctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'vcd.js'), 'utf8') + '\nthis.traceVcd = traceVcd;', vctx);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-trace-wcz-'));

const { helper, wczSource: wczSourceOf } = require('./wisp-client.cjs');
const wczSource = (h, meta) => wczSourceOf(h, meta, (req, r) => { if (req.cmd === 'derive' && !r.error) { derives.n++; } });

let fails = 0, oks = 0;
const derives = { n: 0 }; // derive queries (a helper build with derive answers them; stock 15.7 says it has none)
const want = (what, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) { oks++; console.log('ok   ' + what); } else { fails++; console.log(`FAIL ${what}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`); }
};

(async () => {
  const lib = core.loadEngine(path.join(root, 'media/cmux/trace'));
  const designs = path.join(__dirname, 'designs');
  const sc = new core.SvModelSidecar(path.join(root, 'media/cmux/sv-model'));
  const helpers = [];
  try {
    const wcz = (d, vcd) => {
      const f = path.join(work, d + '.wcz');
      if (fs.existsSync(f)) { return f; }
      cp.execFileSync(process.env.WCZ_FROM_VCD, [path.join(__dirname, 'dumps', vcd || d + '.plain.vcd'), f], { stdio: 'ignore' });
      return f;
    };
    const traceOn = async (d, args) => {
      const h = helper(wcz(d));
      helpers.push(h);
      const opened = await h.open();
      const ds = new core.DesignSession(sc, args, designs);
      const l = await ds.load();
      return { h, t: new core.TraceCore(lib, { design: ds, generation: l.generation }, wczSource(h, Object.assign({ top: opened.result.top }, opened.result.metadata)), '', '') };
    };
    const A = await traceOn('a', ['tb_a.sv', 'a_uninit.sv', '--top', 'tb_a']);
    const st = await A.t.step('tb_a.dut.dout', 60);
    want('wcz driver tb_a.dut.dout@60', [st.driver.kind, st.procKind, st.stmt.src, st.activation && st.activation.time, st.sample, st.since, st.value, st.trust],
      ['proc', 'AlwaysFF', 'dout <= stage;', 55, 54, 55, 'xxxxxxxx', 'exact']);
    const s2 = await A.t.step('tb_a.dut.stage', 54);
    want('wcz driver tb_a.dut.stage@54', [s2.stmt.src, s2.since, s2.trust], ['stage = tmp;', 45, 'computed']);
    const P = await traceOn('p', ['tb_p.sv', 'p_hold.sv', '--top', 'tb_p']);
    const crow = (c) => [c.end.code, c.steps.map((e) => [e.signal.replace(/^tb_[pq]\./, ''), e.time, e.why.code, e.trust, e.why.bitsChanged ? 'bits' : null])];
    const sg2 = await P.t.chain('tb_p.dut.sg2', 440, () => {}, () => false);
    want('wcz xroot tb_p.dut.sg2@440', crow(sg2), ['testbench', [['dut.sg2', 440, 'start', 'exact', null], ['dut.nx2', 434, 'only', 'exact', null], ['dut.sg2', 35, 'held', 'exact', null], ['dut.nx2', 32, 'xSince', 'exact', null], ['dut.flit', 32, 'only', 'exact', null], ['flit', 32, 'only', 'approximate', null]]]);
    const sig = await P.t.chain('tb_p.dut.sig', 440, () => {}, () => false);
    want('wcz xroot tb_p.dut.sig@440', crow(sig).slice(0, 1).concat([crow(sig)[1].slice(0, 2)]), ['testbench', [['dut.sig', 440, 'start', 'exact', null], ['dut.sig', 35, 'held', 'exact', null]]]);
    // The dump answers the engine asks for, WCZ (helper) against VCD (whole history in memory, as cmux), on every
    // signal of both cases at every time 0..end: xStart (no derive in wisp-helper: one exact whole window instead),
    // maskChangeCount, changeCount, lastChange, prevEdge, nextChange, values.
    // The long x run (designs/xr_run.sv, iverilog dump): r holds x from the load at 1005 to the end, 1,899 changes.
    const XR = helper(wcz('xr', 'xr.icarus.vcd'));
    helpers.push(XR);
    await XR.open();
    const cases = [['a', A.h, 'a.plain.vcd', 1, 65536], ['p', P.h, 'p.plain.vcd', 1, 65536], ['p', P.h, 'p.plain.vcd', 1, 3], ['xr', XR, 'xr.icarus.vcd', 97, 65536], ['xr', XR, 'xr.icarus.vcd', 97, 50]];
    for (const [d, H, vcdName, every, pageSize] of cases) {
      dumpLib.setPageChanges(pageSize);
      const vcdFile = path.join(__dirname, 'dumps', vcdName);
      const sig = vctx.traceVcd(fs.readFileSync(vcdFile, 'utf8')).sig;
      const vsrc = { kind: 'vcd', async findVar(p) { const x = sig.get(p); return x ? { key: p, width: x.width } : null; }, async changes(v) { return sig.get(v.key).changes; } };
      const opened = await H.request({ cmd: 'open', file: path.join(work, d + '.wcz') });
      const wsrc = wczSource(H, Object.assign({ top: opened.result.top }, opened.result.metadata));
      const dv = dumpLib.makeDump(dumpLib.newDumpSession(vsrc, '', ''));
      const dw = dumpLib.makeDump(dumpLib.newDumpSession(wsrc, '', ''));
      const end = Number(opened.result.metadata.timeEnd);
      let n = 0;
      const first = [], perKind = new Map();
      for (const p of sig.keys()) {
        for (let t = 0; t <= end; t += (t < 1100 ? 1 : every)) {
          const qs = [
            ['xStart', (x) => x.xStart(p, t)],
            ['lastChange', (x) => x.lastChange(p, t)],
            ['prevEdge', (x) => x.prevEdge(p, t, 'PosEdge')],
            ['nextChange', (x) => x.nextChange(p, t)],
            ['values', (x) => x.values([p], t)],
          ];
          if (t > 0) { qs.push(['changeCount', (x) => x.changeCount(p, Math.max(0, t - 7), t)], ['maskChangeCount', (x) => x.maskChangeCount(p, Math.max(0, t - 40), t)]); }
          for (const [q, f] of qs) {
            // (nextChange at the dump's start: the helper's forward edge from the start finds the first change
            // after it, and the in-memory list the start's own value; cmux's two paths differ the same way)
            if (q === 'nextChange' && t === 0) { continue; }
            const a = JSON.stringify(await f(dv)), b = JSON.stringify(await f(dw));
            n++;
            if (a !== b) { const k = (perKind.get(q) || 0) + 1; perKind.set(q, k); if (k <= 3) { first.push(`${q}(${p}, ${t}): vcd ${a} wcz ${b}`); } }
          }
        }
      }
      want(`wcz dump answers = vcd on case ${d}, page ${pageSize} changes (${n} queries, ${sig.size} signals, t 0..${end})`, first, []);
      if (perKind.size) { console.log('  differing per query: ' + JSON.stringify([...perKind])); }
    }
    {
      const ds = new core.DesignSession(sc, ['tb_xr.sv', 'xr_run.sv', '--top', 'tb_xr'], designs);
      const l = await ds.load();
      const opened = await XR.request({ cmd: 'open', file: path.join(work, 'xr.wcz') });
      dumpLib.setPageChanges(65536);
      const dw = dumpLib.makeDump(dumpLib.newDumpSession(wczSource(XR, Object.assign({ top: opened.result.top }, opened.result.metadata)), '', ''));
      want('xr: exact xStart of a 1,899-change x run (WCZ, no derive)', await dw.xStart('tb_xr.dut.r', 19995), { time: 1005, complete: true });
      dumpLib.setPageChanges(50);
      want('xr: the same across 38+ pages of 50 changes', await dw.xStart('tb_xr.dut.r', 19994), { time: 1005, complete: true });
      dumpLib.setPageChanges(65536);
      const crowX = (c) => [c.end.code, c.root, c.approximate, c.steps.map((e) => [e.signal, e.time, e.why.code, e.trust])];
      const tw = new core.TraceCore(lib, { design: ds, generation: l.generation }, wczSource(XR, Object.assign({ top: opened.result.top }, opened.result.metadata)), '', '');
      const sigX = vctx.traceVcd(fs.readFileSync(path.join(__dirname, 'dumps/xr.icarus.vcd'), 'utf8')).sig;
      const tv = new core.TraceCore(lib, { design: ds, generation: l.generation }, { kind: 'vcd', async findVar(p) { const x = sigX.get(p); return x ? { key: p, width: x.width } : null; }, async changes(v) { return sigX.get(v.key).changes; } }, '', '');
      const cw = crowX(await tw.chain('tb_xr.dut.r', 19995, () => {}, () => false));
      want('xr: Trace to Root on WCZ = on VCD', cw, crowX(await tv.chain('tb_xr.dut.r', 19995, () => {}, () => false)));
      want('xr: Trace to Root (cmux engine answer)', cw, ['uninit', 3, true, [['tb_xr.dut.r', 19995, 'start', 'exact'], ['tb_xr.dut.r', 1005, 'held', 'approximate'], ['tb_xr.dut.seed', 1004, 'only', 'exact'], ['tb_xr.seed', 1004, 'only', 'exact']]]);
    }
    if (process.env.EXPECT_DERIVE) { want(`helper derive used: ${process.env.EXPECT_DERIVE}`, derives.n > 0 ? 'yes' : 'no', process.env.EXPECT_DERIVE); }
    console.log(`derive queries: ${derives.n}`);
    console.log(`helper queries: a ${A.h.queries.n} (whole windows ${A.h.queries.whole || 0}), p ${P.h.queries.n} (whole windows ${P.h.queries.whole || 0}) (DIAGNOSTIC)`);
  } catch (e) {
    fails++; console.log('FAIL thrown', e && e.stack || e);
  } finally {
    sc.stop();
    for (const h of helpers) { h.proc.kill(); }
    fs.rmSync(out, { force: true });
    fs.rmSync(dumpOut, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`${oks} ok, ${fails} failed`);
  console.log(fails ? 'WCZ TRACE CHECKS FAILED' : 'WCZ TRACE CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})();
