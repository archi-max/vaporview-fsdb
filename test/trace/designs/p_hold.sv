`timescale 1ns/1ns
// Design P: registers that hold an x for many cycles after reset (a trace sink's running
// signature). One flit with an x bit comes in once, at 35; sig rotates and xors in a clean flit
// every cycle after that, so its x moves (each cycle is a change, x to x) and it never gets rid
// of it. sg2 does the same through a combinational next value (nx2: the hold goes round
// through an enable mux), and hq holds through `en ? flit : hq` with en low (no change at all).
// cv is the clean case: it takes the flit 01 once (ld at 25) and holds it through `ld ? flit : cv`.
module p_hold (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       v,
  input  logic       en,
  input  logic       ld,
  input  logic [7:0] flit,
  output logic [7:0] sig,
  output logic [7:0] sg2,
  output logic [7:0] hq,
  output logic [7:0] cv
);
  always_ff @(posedge clk) begin
    if (!rst_n) sig <= '0;
    else if (v) sig <= {sig[6:0], sig[7]} ^ flit;
  end

  logic [7:0] nx2;
  assign nx2 = v ? {sg2[6:0], sg2[7]} ^ flit : sg2;
  always_ff @(posedge clk) begin
    if (!rst_n) sg2 <= '0;
    else sg2 <= nx2;
  end

  always_ff @(posedge clk) begin
    if (!rst_n) hq <= '0;
    else hq <= en ? flit : hq;
  end

  always_ff @(posedge clk) begin
    if (!rst_n) cv <= '0;
    else cv <= ld ? flit : cv;
  end
endmodule
