module tb_sb;
  logic clk = 1'b0;
  logic sel;
  logic [3:0] d = 4'h5;
  wire [3:0] q10, q11;
  always #5 clk = ~clk;
  sb_sib dut(.clk(clk), .sel(sel), .d(d), .q10(q10), .q11(q11));
  initial begin
    $dumpfile("sb.vcd"); $dumpvars(0, tb_sb);
    sel = 1'bx;
    #22 sel = 1'b0;
    #20 $finish;
  end
endmodule
