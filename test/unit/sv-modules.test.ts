// vscode-port: module headers the debugger's text fallback must read right (its instance search matches a
// dump scope by the module's ports). CVA6-style header: a package import before the parameters, `parameter type`
// names, struct-typed ports. Run: node test/riscv/run.cjs ../unit/sv-modules.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { scanModules, portNames } from '../../src/cmux/dap/sv-lines';

const cva6 = `module cva6
  import ariane_pkg::*;
#(
    parameter config_pkg::cva6_cfg_t CVA6Cfg = build_config_pkg::build_config(cva6_config_pkg::cva6_cfg),
    parameter type rvfi_probes_t = struct packed {
      logic csr;
      logic instr;
    },
    parameter type noc_req_t = logic
) (
    // Subsystem Clock
    input logic clk_i,
    input logic rst_ni,
    input logic [CVA6Cfg.VLEN-1:0] boot_addr_i,
    input logic [1:0] irq_i,
    output rvfi_probes_t rvfi_probes_o,
    output noc_req_t noc_req_o, input noc_resp_t noc_resp_i
);
  logic [7:0] a, b;
  wire c = a & b;
  my_t d;
endmodule
module plain(clk, q);
  input clk;
  output reg [3:0] q;
endmodule
module m2 #(parameter W = 8) (input wire [W-1:0] x, output y);
endmodule
`;
const mods = scanModules(cva6);
assert.deepStrictEqual(mods.map((m) => m.name), ['cva6', 'plain', 'm2']);
assert.deepStrictEqual(mods[0].ports, ['clk_i', 'rst_ni', 'boot_addr_i', 'irq_i', 'rvfi_probes_o', 'noc_req_o', 'noc_resp_i']);
assert.deepStrictEqual(mods[0].declared, ['a', 'b', 'c']); // (my_t d: no declaration keyword, as before)
assert.deepStrictEqual(mods[1].ports, ['clk', 'q', 'clk', 'q']);
assert.deepStrictEqual(mods[2].ports, ['x', 'y']);
assert.deepStrictEqual(portNames('input logic [7:0] a, output pkg::t_s b, my_t c = 0'), ['a', 'b', 'c']);
// a wide header (many ports) and a long body stay linear
const wide = 'module w (\n' + Array.from({ length: 50000 }, (_, i) => `  input logic p${i}`).join(',\n') + '\n);\nendmodule\n';
assert.strictEqual(scanModules(wide)[0].ports.length, 50000);
// the real files, when present (the demo design): every module port of cva6 is a plain name
const fs = require('fs');
const f = process.env.CVA6_SV;
if (f && fs.existsSync(f)) {
  const m = scanModules(fs.readFileSync(f, 'utf8'))[0];
  assert.deepStrictEqual(m.ports, ['clk_i', 'rst_ni', 'boot_addr_i', 'hart_id_i', 'irq_i', 'ipi_i', 'time_irq_i', 'debug_req_i', 'rvfi_probes_o', 'cvxif_req_o', 'cvxif_resp_i', 'noc_req_o', 'noc_resp_i'], JSON.stringify(m.ports));
  console.log('  cva6.sv ports ' + m.ports.length);
}
console.log('PASS sv-modules');

// vscode-port: instantiations (one line), and the modules along a dump path from them (the session-instance rule).
{
  const { TextInstanceResolver } = require('../../src/cmux/dap/instances');
  const fs = require('fs'), path = require('path');
  const mods = scanModules(fs.readFileSync(path.join(__dirname, '../e2e/fixtures/dbg/dbg_top.sv'), 'utf8'));
  const top = mods.find((m) => m.name === 'dbg_top')!;
  assert.deepStrictEqual(top.instances, [{ type: 'counter', name: 'u0' }, { type: 'counter', name: 'u1' }]);
  assert.deepStrictEqual(mods.find((m) => m.name === 'counter')!.instances, []);
  assert.deepStrictEqual(TextInstanceResolver.modulesAlong(['dbg_top', 'u1'], mods), ['dbg_top', 'counter']);
  assert.deepStrictEqual(TextInstanceResolver.modulesAlong(['dbg_top'], mods), ['dbg_top']);
  assert.strictEqual(TextInstanceResolver.modulesAlong(['tb', 'u1'], mods), null);
  assert.strictEqual(TextInstanceResolver.modulesAlong(['dbg_top', 'gen_x'], mods), null);
  console.log('sv-modules instances: ok');
}

// vscode-port: a testbench whose nets share the module's port names (`.*`) is not its instance: the child is
// (design I: tb_i holds clk, valid, pop ... and tb_i.dut is i_drivers). A wrapper that keeps its own internals stays.
void (async () => {
  const { TextInstanceResolver } = require('../../src/cmux/dap/instances');
  const v = (name: string) => ({ kind: 'var', name });
  const sc = (...p: string[]) => ({ kind: 'scope', name: p[p.length - 1], path: p });
  const fake = (tree: Record<string, any[]>) => ({
    generation: 1,
    topScopes: async () => [{ path: ['tb_i'] }],
    children: async (p: string[]) => tree[p.join('.')] || [],
    allScopes: async () => Object.keys(tree).map((k) => k.split('.')),
  });
  const [mod] = scanModules('module i_drivers (input logic clk, input logic [3:0] valid, output logic [3:0] pop);\n  logic [7:0] lost;\nendmodule\n');
  const tb = fake({ 'tb_i': [v('clk'), v('valid'), v('pop'), sc('tb_i', 'dut')], 'tb_i.dut': [v('clk'), v('valid'), v('pop'), v('lost')] });
  assert.deepStrictEqual(await new TextInstanceResolver().thisInstance(mod, tb), ['tb_i', 'dut']);
  assert.deepStrictEqual(await new TextInstanceResolver().instancesOf(mod, tb), [['tb_i', 'dut']]);
  // a wrapper (same ports, its own `lost`) around an inner core with the same ports: the wrapper stays
  const wrap = fake({ 'tb_i': [v('clk'), v('valid'), v('pop'), v('lost'), sc('tb_i', 'core')], 'tb_i.core': [v('clk'), v('valid'), v('pop')] });
  assert.deepStrictEqual(await new TextInstanceResolver().thisInstance(mod, wrap), ['tb_i']);
  console.log('sv-modules connecting scope vs instance: ok');
})().catch((e) => { console.error(e); process.exit(1); });
