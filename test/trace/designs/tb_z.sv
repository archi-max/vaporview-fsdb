`timescale 1ns/1ns
module tb_z;
  logic clk = 0, rst_n = 0, set = 0; logic [3:0] lvl = 0; logic f; logic [3:0] h;
  z_flag dut (.*);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("z.vcd"); $dumpvars(0, tb_z);
    #22 rst_n = 1;
    #10 begin set = 1; lvl = 4'd1; end // t=32: f = 1, h = 1 at 35
    #10 begin set = 0; lvl = 4'd0; end
    #48 $finish;
  end
endmodule
