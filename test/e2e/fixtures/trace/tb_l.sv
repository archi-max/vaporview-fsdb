`timescale 1ns/1ns
module tb_l;
  logic [1:0] c = 2'b00, en = 2'b11;
  logic [1:0] v;
  l_loop dut (.*);
  initial begin
`ifdef FSDB
    $fsdbDumpfile("l.fsdb"); $fsdbDumpvars(0, tb_l, "+all");
`endif
    $dumpfile("l.vcd"); $dumpvars(0, tb_l);
    #10 c = 2'b10;        // t=10: v[1] from line 11 (i = 1)
    #10 en = 2'b01;       // t=20: v back to 0 (line 8)
    #10 $finish;          // t=30
  end
endmodule
