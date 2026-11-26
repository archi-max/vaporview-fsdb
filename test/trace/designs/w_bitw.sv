`timescale 1ns/1ns
// Design W: a bitwise operator is a copy of one operand's bit only where the other's dumped bit is
// the identity (AND 1, OR 0) at that step and its own is not (both: a joint cause). qa <= d & m, d 0:
// m[2] goes 1 -> 0 -> 1, so qa[2] is d's at 35, a 0 of both at 45. qo <= e | n, e 1: n[1] goes
// 0 -> 1 -> 0, so qo[1] is e's at 35, a 1 of both at 45.
module w_and (
  input  logic       clk,
  input  logic [3:0] d,
  input  logic [3:0] m,
  output logic [3:0] qa
);
  always_ff @(posedge clk) qa <= d & m;
endmodule

module w_or (
  input  logic       clk,
  input  logic [3:0] e,
  input  logic [3:0] n,
  output logic [3:0] qo
);
  always_ff @(posedge clk) qo <= e | n;
endmodule
