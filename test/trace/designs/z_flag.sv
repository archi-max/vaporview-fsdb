`timescale 1ns/1ns
// C1: f <= 1 when set; the 1 is a constant chosen by set (a control input, not wired to f).
module z_flag (input logic clk, input logic rst_n, input logic set, input logic [3:0] lvl, output logic f, output logic [3:0] h);
  always_ff @(posedge clk) begin
    if (set) f <= 1'b1;
  end
  // h <= 4'd1 when lvl == 1: the condition's wires must not mark lvl as wired to h
  always_ff @(posedge clk) begin
    if (!rst_n) h <= '0;
    else if (lvl[0]) h <= 4'd1;
  end
endmodule
