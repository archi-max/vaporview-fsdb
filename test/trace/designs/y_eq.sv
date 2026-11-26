`timescale 1ns/1ns
// V3: q = a & b; a is 1 from 12, b rises at 42 (q's 1 at 45 came with b).
// V4: r is 3 from reset; at 45 ld writes 3 again (no change in the dump); at 65 inc makes 4.
// A9: z is x from d at 35; at 55 bad writes 'x again (no change); otherwise holds.
// V5: k = m ^ n with n = 0: the bit follows m.
module y_eq (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       a, b,
  input  logic       ld, inc,
  input  logic       bad, we,
  input  logic [3:0] d,
  output logic       q,
  output logic [3:0] r,
  output logic [3:0] z
);
  always_ff @(posedge clk) q <= a & b;
  always_ff @(posedge clk) begin
    if (!rst_n) r <= 4'd3;
    else if (ld) r <= 4'd3;
    else if (inc) r <= r + 4'd1;
  end
  always_ff @(posedge clk) begin
    if (!rst_n) z <= '0;
    else if (bad) z <= 'x;
    else if (we) z <= d;
  end
endmodule
