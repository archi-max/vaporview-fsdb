`timescale 1ns/1ns
// H7: block-local variables in always blocks are static: one read before it is assigned holds
// the last activation's value. q: prev holds the last d; d = 5 sampled at 35 makes prev 5, so
// the edge at 45 writes q's 1 again (no change). q2: t3 is set only when en; en at 35 with
// d2 = 5 leaves t3 = 5, so every later edge writes q2's 1 again. q3: the value written is the
// last activation's acc (d at 35 -> q3 = 5 at 45).
module t_static (input logic clk, input logic rst_n, input logic [3:0] d, input logic en, input logic [3:0] d2,
                 output logic [3:0] q, output logic [3:0] q2, output logic [3:0] q3);
  always_ff @(posedge clk) begin
    logic [3:0] prev;
    if (!rst_n) q <= 4'd1;
    else if (prev == 4'h5) q <= 4'd1;
    prev = d;
  end
  always_ff @(posedge clk) begin
    logic [3:0] t3;
    if (en) t3 = d2;
    if (!rst_n) q2 <= 4'd1;
    else if (t3 == 4'h5) q2 <= 4'd1;
  end
  always_ff @(posedge clk) begin
    logic [3:0] acc;
    if (!rst_n) q3 <= 4'd0;
    else q3 <= acc;
    acc = d;
  end
endmodule
