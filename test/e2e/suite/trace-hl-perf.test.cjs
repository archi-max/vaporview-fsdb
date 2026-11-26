// vscode-port: DIAGNOSTIC timings of the driver highlight (no pass bound beyond "it answers").
// The quiet step = what a marker move costs once the signal is selected: one step at a new time (not cached) plus
// building the marks. Fixture A (dout) always; CVA6 when E2E_WORKSPACE holds cva6.f + cva6/ (as link-cva6), with the dumps
// in E2E_CVA6_DIR (default ~/vaporview-demo/cva6); E2E_CVA6_SIG overrides the signal.
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const os = require('os');
const { vscode, assert, open, root } = require('./helpers.cjs');
const { sameTwin, FORMAT } = require('./format.cjs');
const { useHelper } = require('./wisp-common.cjs');

const hl = (a) => vscode.commands.executeCommand('vaporview.e2e.driverHighlight', a);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };

async function measure(label, uri, sig, times) {
  let t0 = Date.now();
  const first = await hl({ compute: true, uri, dumpPath: sig, time: times[0] });
  const firstMs = Date.now() - t0;
  assert.ok(first && first.all, `${label}: no highlight: ${JSON.stringify(first).slice(0, 300)}`);
  const quiet = [];
  for (const t of times.slice(1)) {
    t0 = Date.now();
    const h = await hl({ compute: true, uri, dumpPath: sig, time: t });
    quiet.push(Date.now() - t0);
    assert.ok(h && h.all, `${label} at ${t}: ${JSON.stringify(h).slice(0, 300)}`);
  }
  t0 = Date.now();
  await hl({ compute: true, uri, dumpPath: sig, time: times[1] });
  const cached = Date.now() - t0;
  console.log(`  DIAGNOSTIC driver highlight perf ${FORMAT || 'vcd'} ${label} ${sig}: first ${firstMs} ms (design load + lines); ` +
    `quiet step n=${quiet.length} p50 ${q(quiet, 0.5)} ms p95 ${q(quiet, 0.95)} ms max ${Math.max(...quiet)} ms; cached ${cached} ms; ` +
    `${first.all.length} assigning lines, active ${first.active ? path.basename(first.active.file) + ':' + first.active.line : 'none'}`);
}

module.exports = require('./trace-settings-guard.cjs').keepTraceSettings({
  'Driver highlight perf (DIAGNOSTIC): fixture A dout, quiet step at 20 marker times': async () => {
    const dir = path.join(root, 'test/e2e/fixtures/trace');
    const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
    await cfg.update('trace.designArgs', ['-f', 'a.f'], G);
    await cfg.update('trace.designRoot', dir, G);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset');
    if (FORMAT) { assert.ok(await useHelper('hl perf ' + FORMAT), 'wisp-helper'); }
    const uri = String(await open(vscode.Uri.file(sameTwin(path.join(dir, 'a.vcd')))));
    await measure('a', uri, 'tb_a.dut.dout', Array.from({ length: 21 }, (_, i) => 5 + i * 5));
  },

  'Driver highlight perf (DIAGNOSTIC): one CVA6 signal, quiet step at 20 marker times': async () => {
    const ws = process.env.E2E_WORKSPACE || '', dumps = process.env.E2E_CVA6_DIR || path.join(os.homedir(), 'vaporview-demo/cva6');
    if (!ws || !fs.existsSync(path.join(ws, 'cva6.f')) || !FORMAT) { console.log('NOT RUN driver highlight perf CVA6: E2E_WORKSPACE needs cva6.f; FSDB / WCZ only'); return; }
    const f = path.join(dumps, 'cva6-coremark.' + FORMAT);
    assert.ok(fs.existsSync(f), 'no ' + f);
    assert.ok(await useHelper('hl perf cva6 ' + FORMAT), 'wisp-helper');
    const cfg = vscode.workspace.getConfiguration('vaporview'), G = vscode.ConfigurationTarget.Global;
    await cfg.update('wisp.outsideWrites', 'none', G);
    await cfg.update('trace.designArgs', ['-f', 'cva6.f'], G);
    await cfg.update('trace.designRoot', ws, G);
    await vscode.commands.executeCommand('vaporview.e2e.traceReset');
    const uri = String(await open(vscode.Uri.file(f)));
    const sig = process.env.E2E_CVA6_SIG || 'ariane_tb.dut.i_ariane.i_cva6.pc_id_ex';
    // (times spread over the first part of the run, where CoreMark is executing)
    await measure('cva6', uri, sig, Array.from({ length: 21 }, (_, i) => 100000 + i * 37010));
    await cfg.update('wisp.outsideWrites', undefined, G);
  },
});
