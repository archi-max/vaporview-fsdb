`timescale 1ns/1ns
module tb_y;
  logic clk = 0, rst_n = 0, a = 0, b = 0, ld = 0, inc = 0, bad = 0, we = 0;
  logic [3:0] d = 4'h0;
  logic q; logic [3:0] r, z;
  y_eq dut (.*);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("y.vcd"); $dumpvars(0, tb_y);
    #12 a = 1;
    #10 rst_n = 1;                 // t=22
    #10 begin d = 4'bxxxx; we = 1; end // t=32: z = xxxx at 35
    #10 begin b = 1; d = 4'h0; ld = 1; we = 0; end // t=42
    #10 begin ld = 0; bad = 1; end // t=52: z <= 'x at 55 (no change)
    #10 begin bad = 0; inc = 1; end // t=62: r 4 at 65
    #10 inc = 0;                   // t=72
    #28 $finish;                   // t=100
  end
endmodule
