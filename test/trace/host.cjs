// vscode-port: the extension host's tracing (src/cmux/trace/core.ts, dump.ts, sidecar.ts) on a live
// cmux-sv-model and the case suite's dumps, outside VS Code. Checks the answers the cmux case suite pins (cases.js)
// for the paths the extension takes: resolve, a Trace Driver step, Trace to Root with the page's full config.
// Usage: node test/trace/host.cjs   (needs the sidecar built: it builds it into the cache the first time)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../..');
const out = path.join(os.tmpdir(), 'vv-trace-host-' + process.pid + '.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src/cmux/trace/core.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
const core = require(out);
const { SvModelSidecar, DesignSession } = require(out);
const vm = require('vm');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'vcd.js'), 'utf8') + '\nthis.traceVcd = traceVcd;', ctx);

function vcdSource(file) {
  const { sig } = ctx.traceVcd(fs.readFileSync(file, 'utf8'));
  return { kind: 'vcd', async findVar(p) { const s = sig.get(p); return s ? { key: p, width: s.width } : null; }, async changes(v) { return sig.get(v.key).changes; } };
}

let fails = 0, oks = 0;
const want = (what, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) { oks++; console.log('ok   ' + what); } else { fails++; console.log(`FAIL ${what}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`); }
};

(async () => {
  const lib = core.loadEngine(path.join(root, 'media/cmux/trace'));
  const sidecar = require(out);
  const designs = path.join(__dirname, 'designs');
  const sc = new SvModelSidecar(path.join(root, 'media/cmux/sv-model'), (p) => console.log('build', JSON.stringify(p)));
  const session = (args) => new DesignSession(sc, args, designs);
  try {
    // Design A: Trace Driver (cases.js chain 1's first step).
    const da = session(['tb_a.sv', 'a_uninit.sv', '--top', 'tb_a']);
    const la = await da.load();
    const ba = { design: da, generation: la.generation };
    const ra = await core.resolveDumpPath(ba, ['tb_a', 'dut', 'dout']);
    want('resolve tb_a.dut.dout', [ra.kind, ra.designPath, ra.designPrefix, ra.dumpPrefix], ['signal', 'tb_a.dut.dout', '', '']);
    // A simulator wrapper scope (TOP.tb_a...) maps onto the design.
    const rw = await core.resolveDumpPath(ba, ['TOP', 'tb_a', 'dut', 'dout']);
    want('resolve TOP.tb_a.dut.dout', [rw.kind, rw.designPath, rw.designPrefix, rw.dumpPrefix], ['signal', 'tb_a.dut.dout', '', 'TOP']);
    const ta = new core.TraceCore(lib, ba, vcdSource(path.join(__dirname, 'dumps/a.plain.vcd')), '', '');
    const st = await ta.step('tb_a.dut.dout', 60);
    want('driver tb_a.dut.dout@60', [st.driver.kind, st.procKind, st.stmt.src, st.activation && st.activation.time, st.sample, st.since, st.value, st.trust, path.basename(st.stmt.loc.file), st.stmt.loc.line],
      ['proc', 'AlwaysFF', 'dout <= stage;', 55, 54, 55, 'xxxxxxxx', 'exact', 'a_uninit.sv', 34]);
    want('driver fan-in', st.fanin.filter((f) => ['tb_a.dut.stage', 'tb_a.dut.rst_n', 'tb_a.dut.clk'].includes(f.path)).map((f) => [f.path, f.value]).sort(),
      [['tb_a.dut.clk', '1'], ['tb_a.dut.rst_n', '1'], ['tb_a.dut.stage', 'xxxxxxxx']]);
    want('driver decisions', st.decisions.map((d) => [d.src, d.taken]), [['!rst_n', 'else']]);
    const s2 = await ta.step('tb_a.dut.stage', 54);
    want('driver tb_a.dut.stage@54', [s2.stmt.src, s2.since, s2.trust, s2.decisions.map((d) => [d.src, d.taken])], ['stage = tmp;', 45, 'computed', [['valid_q', 'then']]]);
    // Design P: Trace to Root, the page's config (cases.js M1 C: crow of sg2 and sig).
    const dp = session(['tb_p.sv', 'p_hold.sv', '--top', 'tb_p']);
    const lp = await dp.load();
    const tp = new core.TraceCore(lib, { design: dp, generation: lp.generation }, vcdSource(path.join(__dirname, 'dumps/p.plain.vcd')), '', '');
    const crow = (c) => [c.end.code, c.steps.map((e) => [e.signal.replace(/^tb_[pq]\./, ''), e.time, e.why.code, e.trust, e.why.bitsChanged ? 'bits' : null])];
    const seen = [];
    const sg2 = await tp.chain('tb_p.dut.sg2', 440, (e) => seen.push(e.signal), () => false);
    want('xroot tb_p.dut.sg2@440', crow(sg2), ['testbench', [['dut.sg2', 440, 'start', 'exact', null], ['dut.nx2', 434, 'only', 'exact', null], ['dut.sg2', 35, 'held', 'exact', null], ['dut.nx2', 32, 'xSince', 'exact', null], ['dut.flit', 32, 'only', 'exact', null], ['flit', 32, 'only', 'approximate', null]]]);
    want('xroot streams its steps', seen.length, sg2.steps.length);
    want('xroot root and label', [sg2.root, sg2.approximate], [5, true]);
    const sig = await tp.chain('tb_p.dut.sig', 440, () => {}, () => false);
    want('xroot tb_p.dut.sig@440', crow(sig).slice(0, 1).concat([crow(sig)[1].slice(0, 2)]), ['testbench', [['dut.sig', 440, 'start', 'exact', null], ['dut.sig', 35, 'held', 'exact', null]]]);
    // Ranked causes: the inputs with x each step was chosen among, earliest first.
    const withCauses = sg2.steps.filter((e) => e.causes && e.causes.length);
    want('xroot ranked causes present', withCauses.length > 0, true);
    want('xroot causes sorted by since', withCauses.every((e) => e.causes.every((c, i) => i === 0 || (c.since ?? Infinity) >= (e.causes[i - 1].since ?? Infinity))), true);
    // Cancelled: no root.
    const cn = await tp.chain('tb_p.dut.sg2', 440, () => {}, () => true);
    want('xroot cancelled', [cn.end.code, cn.root], ['cancelled', -1]);
  } catch (e) {
    fails++; console.log('FAIL thrown', e && e.stack || e);
  } finally {
    sc.stop();
    fs.rmSync(out, { force: true });
  }
  console.log(`${oks} ok, ${fails} failed`);
  console.log(fails ? 'HOST TRACE CHECKS FAILED' : 'HOST TRACE CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})();
