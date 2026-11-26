`timescale 1ns/1ns
module tb_m;
  logic clk = 0, we = 0; logic [7:0] bus = 8'h5a; logic [7:0] cfg;
  m_cfg dut (.*);
  always #5 clk = ~clk;
  always @(negedge clk) if ($time > 30) bus <= bus + 8'd1;
  initial begin
    $dumpfile("m.vcd"); $dumpvars(0, tb_m);
    #12 we = 1;
    #10 we = 0;
    #2000 $finish;
  end
endmodule
