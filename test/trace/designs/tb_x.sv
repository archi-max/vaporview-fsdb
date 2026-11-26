`timescale 1ns/1ns
module tb_x;
  logic clk = 0, rst_n = 0, in = 0, in2 = 0, sh = 0, wl = 0, clr = 0;
  logic [1:0] hi = 2'b00;
  logic [8:1] so; logic [7:0] sp; logic [3:0] cnt; logic [7:0] sm;
  x_sh dut (.*);
  always #5 clk = ~clk;
  initial begin
`ifdef FSDB
    $fsdbDumpfile("x.fsdb"); $fsdbDumpvars(0, tb_x, "+all");
`endif
    $dumpfile("x.vcd"); $dumpvars(0, tb_x);
    #22 begin rst_n = 1; in = 1; sh = 1; in2 = 1; end // t=22: in, in2 = 1 sampled at 25
    #10 begin in = 0; in2 = 0; end                    // t=32: shifts at 35, 45
    #10 in2 = 1;                                      // t=42: in2 = 1 again at 45 (sm = 101)
    #10 begin sh = 0; wl = 1; hi = 2'b10; in2 = 0; end // t=52: at 55 sp[7:6] <= 10 (sp = 10000100)
    #10 begin wl = 0; sh = 1; end                     // t=62: at 65 shift: sp = 00001000
    #10 sh = 0;                                       // t=72
    #28 $finish;                                      // t=100
  end
endmodule
