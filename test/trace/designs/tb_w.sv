`timescale 1ns/1ns
module tb_w;
  logic clk = 0;
  logic [3:0] d = 4'b0000, m = 4'b1111, e = 4'b1111, n = 4'b0000;
  logic [3:0] qa, qo;
  w_and t_and (.clk, .d, .m, .qa);
  w_or  t_or  (.clk, .e, .n, .qo);
  always #5 clk = ~clk;
  initial begin
`ifdef FSDB
    $fsdbDumpfile("w.fsdb"); $fsdbDumpvars(0, tb_w, "+all");
`endif
    $dumpfile("w.vcd");
    $dumpvars(0, tb_w);
    #42 begin m = 4'b1011; n = 4'b0010; end   // t=42: at 45 the AND's bit 2 and the OR's bit 1 are the other operand's
    #10 begin m = 4'b1111; n = 4'b0000; end   // t=52: back at 55
    #28 $finish;                              // t=80
  end
endmodule
