`timescale 1ns/1ns
module tb_d;
  logic clk = 0, rst_n = 0, xs; logic [3:0] d = 0; logic [3:0] q4, q5;
  d_carry dut (.*);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("d.vcd"); $dumpvars(0, tb_d);
    #22 rst_n = 1;
    #10 d = 4'h5;      // t=32
    #10 d = 4'hf;      // t=42: q5 written again at 45
    #10 d = 4'h0;      // t=52
    #48 $finish;
  end
endmodule
