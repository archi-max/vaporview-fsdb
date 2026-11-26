`timescale 1ns/1ns
module tb_h;
  logic clk = 0, sel = 0;
  logic [3:0] a = 4'h5, b = 4'ha;
  logic [3:0] q;
  h_top dut (.*);
  always #5 clk = ~clk;
  initial begin
`ifdef FSDB
    $fsdbDumpfile("h.fsdb"); $fsdbDumpvars(0, tb_h, "+all");
`endif
    $dumpfile("h.vcd"); $dumpvars(0, tb_h);
    #30 sel = 1;          // t=30: bus from a (line 11); before, from b (line 12)
    #30 $finish;          // t=60
  end
endmodule
