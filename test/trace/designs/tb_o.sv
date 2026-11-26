`timescale 1ns/1ns
module tb_o;
  logic clk = 0, rst_n = 0; logic [3:0] d = 4'h0; logic [3:0] q, q2, q3;
  o_tmp dut (.*);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("o.vcd"); $dumpvars(0, tb_o);
    #22 rst_n = 1;
    #20 d = 4'hf;      // t=42: written again at 45
    #10 d = 4'h0;      // t=52
    #48 $finish;
  end
endmodule
