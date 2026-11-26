`timescale 1ns/1ns
// Design H: a shared bus with two drivers (two tri-state assigns), each enabled in turn.
module h_top (
  input  logic       clk,
  input  logic       sel,
  input  logic [3:0] a,
  input  logic [3:0] b,
  output logic [3:0] q
);
  wire [3:0] bus;
  assign bus = sel ? a : 4'bz;
  assign bus = !sel ? b : 4'bz;

  always_ff @(posedge clk)
    q <= bus;
endmodule
