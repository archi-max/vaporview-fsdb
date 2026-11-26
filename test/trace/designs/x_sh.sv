`timescale 1ns/1ns
// Design X: shift registers and a counter where a selection rule's pick is not proof (a
// reviewer's cases). so: declared [8:1]. sp: its high bits written by a part write while the
// tracked bit stays where a shift put it (the part write at 55 never touches it). cnt: a counter
// with a clear (clr only chose the counting arm). sm: a value with two 1 bits that entered at
// different times (a shift jump follows one bit, and says which).
module x_sh (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       in,
  input  logic       in2,
  input  logic       sh,
  input  logic       wl,
  input  logic [1:0] hi,
  input  logic       clr,
  output logic [8:1] so,
  output logic [7:0] sp,
  output logic [3:0] cnt,
  output logic [7:0] sm
);
  always_ff @(posedge clk) begin
    if (!rst_n) so <= '0;
    else so <= {so[7:1], in};
  end
  always_ff @(posedge clk) begin
    if (!rst_n) sp <= '0;
    else if (sh) sp <= {sp[6:0], in};
    else if (wl) sp[7:6] <= hi;
  end
  always_ff @(posedge clk) begin
    if (!rst_n) cnt <= '0;
    else cnt <= clr ? 4'd0 : cnt + 4'd1;
  end
  always_ff @(posedge clk) begin
    if (!rst_n) sm <= '0;
    else sm <= {sm[6:0], in2};
  end
endmodule
