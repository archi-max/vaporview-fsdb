`timescale 1ns/1ns
// H8/H9 (a reviewer's round): local lifetimes, and conditions that call functions.
module lf_life (input logic clk, input logic rst_n, input logic [3:0] d, input logic en, input logic [3:0] d2,
               output logic [3:0] q, output logic [3:0] q2, output logic [3:0] q3, output logic [3:0] q5, output logic [3:0] q6, output logic [3:0] q7);
  // U1: static with an initialiser: initialised once, then carries the last d.
  always_ff @(posedge clk) begin
    static logic [3:0] p = 4'h0;
    if (!rst_n) q <= 4'd1;
    else if (p == 4'h5) q <= 4'd1;
    p = d;
  end
  // U2: automatic, no initialiser: x every activation (never carried).
  always_ff @(posedge clk) begin
    automatic logic [3:0] a;
    if (!rst_n) q2 <= 4'd1;
    else if (a == 4'h5) q2 <= 4'd0;
    a = d;
  end
  // U3: a carried local used only as a write index.
  always_ff @(posedge clk) begin
    logic [1:0] ix;
    if (!rst_n) q3 <= 4'd0;
    else q3[ix] <= 1'b1;
    ix = d[1:0];
  end
  // U5: a static module function whose local carries across calls.
  function logic [3:0] f(input logic [3:0] x);
    logic [3:0] last;
    f = last;
    last = x;
  endfunction
  always_ff @(posedge clk) begin
    if (!rst_n) q5 <= 4'd1;
    else if (f(d) == 4'h5) q5 <= 4'd1;
  end
  // U6: a pure automatic function in a condition.
  function automatic logic is5(input logic [3:0] x); return x == 4'h5; endfunction
  always_ff @(posedge clk) begin
    if (!rst_n) q6 <= 4'd1;
    else if (is5(d)) q6 <= 4'd1;
  end
  // U7: copy with a carried local on the other arm.
  always_ff @(posedge clk) begin
    logic [3:0] h;
    if (!rst_n) q7 <= 4'd1;
    else q7 <= en ? q7 : h;
    h = 4'd1;
  end
endmodule
