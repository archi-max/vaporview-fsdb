`timescale 1ns/1ns
// P1: cfg written once (we at 15), held for many cycles while bus toggles every cycle.
module m_cfg (input logic clk, input logic we, input logic [7:0] bus, output logic [7:0] cfg);
  always_ff @(posedge clk) if (we) cfg <= bus;
endmodule
