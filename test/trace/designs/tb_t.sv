`timescale 1ns/1ns
module tb_t;
  logic clk = 0, rst_n = 0, en = 0; logic [3:0] d = 0, d2 = 0; logic [3:0] q, q2, q3;
  t_static dut (.*);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("t.vcd"); $dumpvars(0, tb_t);
    #22 rst_n = 1;
    #10 begin d = 4'h5; en = 1; d2 = 4'h5; end // t=32
    #10 begin d = 4'h0; en = 0; d2 = 4'h0; end // t=42
    #48 $finish;
  end
endmodule
