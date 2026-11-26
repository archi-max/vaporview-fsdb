// vscode-port: the Verdi cross-check's session and verdicts, against a MOCK verdi
// (test/e2e/fixtures/trace/mock-verdi/bin/verdi; no Verdi, no licence) through cmux's own launcher and protocol.
// Usage: node test/trace/verdi.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../..');
const out = path.join(os.tmpdir(), 'vv-trace-verdi-' + process.pid + '.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src/cmux/trace/verdi.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
const { VerdiSession, compare, unitsMatch } = require(out);
const scripts = path.join(root, 'media/cmux/verdi-trace');
const mock = path.join(root, 'test/e2e/fixtures/trace/mock-verdi');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-trace-verdi-'));

let fails = 0, oks = 0;
const want = (what, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) { oks++; console.log('ok   ' + what); } else { fails++; console.log(`FAIL ${what}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`); }
};
// A compile directory with an FSDB (an empty stand-in: the mock never reads it) and a KDB folder next to it.
function compileDir(name, answers, kdb = true) {
  const d = path.join(work, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'dump.fsdb'), '');
  if (kdb) { fs.mkdirSync(path.join(d, 'simv.daidir', 'kdb.elab++'), { recursive: true }); }
  fs.writeFileSync(path.join(d, 'mock-answers.tsv'), answers);
  return d;
}
const step = (file, line) => ({ signal: 'tb_a.dut.dout', time: 60, stmt: { loc: { file, line } } });

(async () => {
  const sessions = [];
  const open = (o) => { const s = new VerdiSession(Object.assign({ scripts, startTimeoutMs: 30000, requestTimeoutMs: 10000 }, o)); sessions.push(s); return s; };
  try {
    const d = compileDir('a', 'tb_a.dut.dout\ta_uninit.sv\t34\ntb_a.dut.stage\ta_uninit.sv\t99\n');
    const s = open({ fsdb: path.join(d, 'dump.fsdb'), verdiHome: mock });
    const ready = await s.ready;
    want('mock session ready (engine verdi)', [ready.ready, ready.engine], [true, 'verdi']);
    const info = await s.request({ cmd: 'info' });
    want('info units match', unitsMatch(info), true);
    const a = await s.request({ cmd: 'active', signal: 'tb_a.dut.dout', time: 60 });
    want('active dout: Verdi agrees with our statement', compare(step(path.join(d, 'a_uninit.sv'), 34), a), { verdict: 'agrees', verdi: { file: path.join(d, 'a_uninit.sv'), line: 34, scope: 'tb_a.dut' } });
    const b = await s.request({ cmd: 'active', signal: 'tb_a.dut.stage', time: 54 });
    want('active stage: Verdi names another statement', compare(step(path.join(d, 'a_uninit.sv'), 22), b).verdict, 'differs');
    const c = await s.request({ cmd: 'active', signal: 'tb_a.dut.nope', time: 1 });
    want('unknown signal: unavailable notFound', [compare(step('x', 1), c).verdict, compare(step('x', 1), c).code], ['unavailable', 'notFound']);
    s.stop();

    // Refusals by the launcher (cmux's codes): no Verdi, no KDB, no FSDB; units differ.
    const empty = fs.mkdtempSync(path.join(work, 'empty-'));
    const env = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    delete process.env.VERDI_HOME;
    const nv = open({ fsdb: path.join(d, 'dump.fsdb'), verdiHome: empty });
    want('no Verdi: noVerdi', await nv.ready.then(() => 'started', (e) => e.code), 'noVerdi');
    process.env.PATH = env;
    const nk = compileDir('nokdb', '', false);
    want('no KDB: noKDB', await open({ fsdb: path.join(nk, 'dump.fsdb'), verdiHome: mock }).ready.then(() => 'started', (e) => e.code), 'noKDB');
    want('no FSDB: noFile', await open({ fsdb: path.join(work, 'missing.fsdb'), verdiHome: mock }).ready.then(() => 'started', (e) => e.code), 'noFile');
    const u = compileDir('units', 'units\t1ps\t1ns\n');
    const us = open({ fsdb: path.join(u, 'dump.fsdb'), verdiHome: mock });
    await us.ready;
    want('units differ: refused', unitsMatch(await us.request({ cmd: 'info' })), false);
  } catch (e) {
    fails++; console.log('FAIL thrown', e && e.stack || e);
  } finally {
    for (const s of sessions) { s.stop(); }
    fs.rmSync(out, { force: true });
    setTimeout(() => {
      fs.rmSync(work, { recursive: true, force: true });
      console.log(`${oks} ok, ${fails} failed`);
      console.log(fails ? 'VERDI MOCK CHECKS FAILED' : 'VERDI MOCK CHECKS PASSED');
      process.exit(fails ? 1 : 0);
    }, 300);
  }
})();
