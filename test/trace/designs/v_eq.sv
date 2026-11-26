`timescale 1ns/1ns
// Design V (a reviewer's fourth round): equal operands and a same-value rewrite. va <= d & m with
// d = m = 1011 from 42: every 1 bit of va needs both (a joint cause). vo <= e | n, e 0101, n 0000 ->
// 0100 at 42: vo is written 0101 again at 45 (no change in the dump), and its bit 2 is then 1 | 1.
module v_and (
  input  logic       clk,
  input  logic [3:0] d,
  input  logic [3:0] m,
  output logic [3:0] va
);
  always_ff @(posedge clk) va <= d & m;
endmodule

module v_or (
  input  logic       clk,
  input  logic [3:0] e,
  input  logic [3:0] n,
  output logic [3:0] vo
);
  always_ff @(posedge clk) vo <= e | n;
endmodule
