// Synthetic e2e fixture source for counter.fst (vscode-port).
`timescale 1ns/1ns
module top;
  reg clk = 1;
  reg [7:0] cnt = 0;
  always #5 clk = ~clk;
  always @(posedge clk) if ($time > 0) cnt <= cnt + 1;
  initial begin $dumpfile("counter.fst"); $dumpvars(0, top); #100 $finish; end
endmodule
