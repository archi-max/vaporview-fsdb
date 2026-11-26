`timescale 1ns/1ns
// Design S: held x jumps that look exact and are not (a reviewer's cases), one instance each.
// t_lit (A1): the upper nibble's x is made at 55 by the statement's own x literal.
// t_nd (A2): at 55 bit 4's x comes from nd, a net the dump leaves out.
// t_rep (A3): at 55 q takes o, whose x is in q's own x bit: q's value does not change.
// t_mask (A7): d brings bit 3's x at 35 and bit 5's at 55; the mask clears bit 5 at 75, so the x
// left at 200 is bit 3's, d's from 35.
// t_mux (V): q takes b (sel 0); a, the arm not taken, has the same value, and an older one.
module s_lit (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       bad,
  input  logic [7:0] d,
  output logic [7:0] q
);
  always_ff @(posedge clk) begin
    if (!rst_n) q <= '0;
    else if (bad) q <= {4'bxxxx, q[3:0]};
    else q <= q | d;
  end
endmodule

module s_nd (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       sel,
  input  logic [7:0] d,
  input  logic [7:0] e,
  output logic [7:0] q
);
  logic [7:0] nd;
  assign nd = e | q;
  always_ff @(posedge clk) begin
    if (!rst_n) q <= '0;
    else if (sel) q <= nd;
    else q <= q | d;
  end
endmodule

module s_rep (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       en,
  input  logic [7:0] d,
  input  logic [7:0] o,
  output logic [7:0] q
);
  always_ff @(posedge clk) begin
    if (!rst_n) q <= '0;
    else if (en) q <= o;
    else q <= q | d;
  end
endmodule

module s_mask (
  input  logic       clk,
  input  logic       rst_n,
  input  logic [7:0] mask,
  input  logic [7:0] d,
  output logic [7:0] rn
);
  always_ff @(posedge clk) begin
    if (!rst_n) rn <= '0;
    else rn <= (rn & mask) | d;
  end
endmodule

module s_mux (
  input  logic       clk,
  input  logic       sel,
  input  logic [7:0] a,
  input  logic [7:0] b,
  output logic [7:0] q
);
  always_ff @(posedge clk) q <= sel ? a : b;
endmodule
