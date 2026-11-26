`timescale 1ns/1ns
module tb_u;
  logic clk = 0, rst_n = 1, en = 1; logic [3:0] d = 4'h0; logic [3:0] q;
  u_ar dut (.*);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("u.vcd"); $dumpvars(0, tb_u);
    #22 en = 0;            // t=22: q = 0 from d at 5 and 15
    #20 rst_n = 0;         // t=42: async reset writes 0 again
    #16 rst_n = 1;         // t=58
    #42 $finish;           // t=100
  end
endmodule
