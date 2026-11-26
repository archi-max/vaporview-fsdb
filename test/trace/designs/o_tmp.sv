`timescale 1ns/1ns
// H6: the branch that writes q again is chosen by a block-local temp computed from d (a data
// input): q is 0 from the reset at 5/15; at 45, d == f makes t2 == 0 and q <= 0 again (no
// change); then d is 0 again. q2: the same through a chain of temps (t1, then t2). q3: the temp
// is set inside a loop (its source not followed): the step says rewrites may be missed.
module o_tmp (input logic clk, input logic rst_n, input logic [3:0] d, output logic [3:0] q, output logic [3:0] q2, output logic [3:0] q3);
  always_ff @(posedge clk) begin
    logic [3:0] t2;
    t2 = d ^ 4'hf;
    if (!rst_n) q <= 4'd0;
    else if (t2 == 4'h0) q <= 4'd0;
  end
  always_ff @(posedge clk) begin
    logic [3:0] t1, t2;
    t1 = d ^ 4'hf;
    t2 = t1;
    if (!rst_n) q2 <= 4'd0;
    else if (t2 == 4'h0) q2 <= 4'd0;
  end
  always_ff @(posedge clk) begin
    logic [3:0] t3;
    t3 = 4'h1;
    for (int i = 0; i < 1; i++) t3 = d ^ 4'hf;
    if (!rst_n) q3 <= 4'd0;
    else if (t3 == 4'h0) q3 <= 4'd0;
  end
endmodule
