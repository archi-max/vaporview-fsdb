// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: testbench of xr_run (synthetic). CYCLES cycles; the seed (one x bit) loads at cycle LOAD.
`ifndef CYCLES
`define CYCLES 2000
`endif
`ifndef LOAD
`define LOAD 100
`endif
module tb_xr;
  logic clk = 0;
  logic ld = 0;
  logic [7:0] seed = 8'b0000_001x;
  logic [7:0] r;
  xr_run dut (.clk(clk), .ld(ld), .seed(seed), .r(r));
  always #5 clk = ~clk;
  initial begin
    $dumpfile("xr.vcd");
    $dumpvars(0, tb_xr);
    #(`LOAD * 10) ld = 1;
    #10 ld = 0;
    #((`CYCLES - `LOAD) * 10) $finish;
  end
endmodule
