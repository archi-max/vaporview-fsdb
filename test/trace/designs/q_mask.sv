`timescale 1ns/1ns
// Design Q: where a held x's bits came from when they change inside the run (Trace to Root's
// cause attribution). rn <= (rn & mask) | d: d brings an x into bit 3 at 35, then at 55 the mask
// clears bit 3 while d brings an x into bit 5 (a new x, from d, not from rn). ms rotates its x
// every cycle and d2 xors an x into the very bit the rotation brings it to at 65 (the x is still
// rn's own: forcing d2 to 0 or 1 leaves it).
module q_mask (
  input  logic       clk,
  input  logic       rst_n,
  input  logic [7:0] mask,
  input  logic [7:0] d,
  input  logic [7:0] d2,
  output logic [7:0] rn,
  output logic [7:0] ms
);
  always_ff @(posedge clk) begin
    if (!rst_n) rn <= '0;
    else rn <= (rn & mask) | d;
  end

  always_ff @(posedge clk) begin
    if (!rst_n) ms <= '0;
    else ms <= {ms[6:0], ms[7]} ^ d2;
  end
endmodule
