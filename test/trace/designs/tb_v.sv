`timescale 1ns/1ns
module tb_v;
  logic clk = 0;
  logic [3:0] d = 4'b1111, m = 4'b1111, e = 4'b0101, n = 4'b0000;
  logic [3:0] va, vo;
  v_and t_and (.clk, .d, .m, .va);
  v_or  t_or  (.clk, .e, .n, .vo);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("v.vcd"); $dumpvars(0, tb_v);
    #42 begin m = 4'b1011; d = 4'b1011; n = 4'b0100; end   // t=42: va 1011 of both; vo 0101 again, bit 2 1 | 1
    #38 $finish;                                            // t=80
  end
endmodule
