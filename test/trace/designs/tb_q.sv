`timescale 1ns/1ns
module tb_q;
  logic clk = 0, rst_n = 0;
  logic [7:0] mask = 8'hff, d = 8'h00, d2 = 8'h00;
  logic [7:0] rn, ms;
  q_mask dut (.*);
  always #5 clk = ~clk;
  initial begin
`ifdef FSDB
    $fsdbDumpfile("q.fsdb"); $fsdbDumpvars(0, tb_q, "+all");
`endif
    $dumpfile("q.vcd"); $dumpvars(0, tb_q);
    #22 rst_n = 1;
    #10 begin d = 8'b0000_x000; d2 = 8'b0000_x000; end   // t=32: x into bit 3 of both, at 35
    #10 begin d = 8'h00; d2 = 8'h00; end                 // t=42
    #10 begin mask = 8'b1111_0111; d = 8'b00x0_0000; end // t=52: at 55 rn's bit 3 cleared, d's x in bit 5
    #10 begin mask = 8'hff; d = 8'h00; d2 = 8'b0x00_0000; end // t=62: at 65 d2's x meets ms's (bit 6)
    #10 d2 = 8'h00;                                      // t=72
    #128 $finish;                                        // t=200
  end
endmodule
