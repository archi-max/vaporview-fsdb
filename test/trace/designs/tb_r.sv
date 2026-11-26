`timescale 1ns/1ns
module tb_r;
  logic clk = 0, rst_n = 0, ld = 0;
  logic [31:0] din = 32'h0;
  logic [23:0] dlo;
  logic [7:0] dhi;
  logic tick = 0;
  logic [3:0] cnt;
  logic inj = 0;
  logic [3:0] rg;
  logic [3:0] pc, pd;
  r_shift dut (.*);
  always #5 clk = ~clk;
  initial begin
`ifdef FSDB
    $fsdbDumpfile("r.fsdb"); $fsdbDumpvars(0, tb_r, "+all");
`endif
    $dumpfile("r.vcd"); $dumpvars(0, tb_r);
    #12 rst_n = 1;
    #10 begin ld = 1; din = 32'h0000_0004; inj = 1; end   // t=22: dlo loads 4 at 25; rg 0001 at 25
    #10 begin ld = 0; din = 32'h0; inj = 0; end   // t=32: shifts: 2 at 35, 1 at 45, 0 at 55; rg goes round
    #40 tick = 1;                                 // t=72: cnt counts to 1 at 75; pc 2 -> 4
    #10 tick = 0;                                 // t=82
    #10 tick = 1;                                 // t=92: and to 2 at 95; pc -> 6
    #10 tick = 0;                                 // t=102
    #20 $finish;                                  // t=122
  end
endmodule
