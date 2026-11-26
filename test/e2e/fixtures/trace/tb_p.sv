`timescale 1ns/1ns
module tb_p;
  logic clk = 0, rst_n = 0, v = 0, en = 0, ld = 0;
  logic [7:0] flit = 8'h00;
  logic [7:0] sig, sg2, hq, cv;
  p_hold dut (.*);
  always #5 clk = ~clk;
  initial begin
`ifdef FSDB
    $fsdbDumpfile("p.fsdb"); $fsdbDumpvars(0, tb_p, "+all");
`endif
    $dumpfile("p.vcd"); $dumpvars(0, tb_p);
    #22 begin rst_n = 1; v = 1; ld = 1; flit = 8'h01; end   // t=22: sig, sg2 and cv take 01 at 25
    #10 begin flit = 8'b0000_x000; en = 1; ld = 0; end      // t=32: the x flit, taken at 35 (hq too)
    #10 begin flit = 8'h02; en = 0; end             // t=42: clean flits from here on
    repeat (40) #10 flit = flit + 8'h01;            // 40 more cycles: the x is held (to t=442)
    #8 $finish;                                     // t=450
  end
endmodule
