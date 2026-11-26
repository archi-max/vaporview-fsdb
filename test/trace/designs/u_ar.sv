`timescale 1ns/1ns
// R1: q is 0 from d at 15; an async reset low 42..58 writes 0 again (at 42, and at the edges 45, 55);
// en is 0 after: the 0 in effect at 90 is the reset's, not d's.
module u_ar (input logic clk, input logic rst_n, input logic en, input logic [3:0] d, output logic [3:0] q);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= '0;
    else if (en) q <= d;
  end
endmodule
