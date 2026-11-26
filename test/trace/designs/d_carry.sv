`timescale 1ns/1ns
`define SET5 t5 = d ^ 4'hf
// H7 follow-ups. q4: p4 is a static local read (before p4 = d) only on a branch under xs, which
// is x: the run's path is not known exactly, so the read can't be ruled out (rewrites, not
// exact). q5: t5 is set inside a loop through a macro, which the loop's text doesn't name: a
// macro in a statement the walk doesn't follow counts as naming every local; at 45 d == f makes
// t5 == 0 and q5 <= 0 again.
module d_carry (input logic clk, input logic rst_n, input logic xs, input logic [3:0] d,
                output logic [3:0] q4, output logic [3:0] q5);
  always_ff @(posedge clk) begin
    logic [3:0] p4;
    if (!rst_n) q4 <= 4'd1;
    else if (xs) begin
      if (p4 == 4'h5) q4 <= 4'd1;
    end
    p4 = d;
  end
  always_ff @(posedge clk) begin
    logic [3:0] t5;
    t5 = 4'h1;
    for (int i = 0; i < 1; i++) `SET5;
    if (!rst_n) q5 <= 4'd0;
    else if (t5 == 4'h0) q5 <= 4'd0;
  end
endmodule
