// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: a long x run (synthetic). r rotates a clean byte, then loads the testbench's seed (one x
// bit) and rotates it: from the load on, r changes every cycle and always holds an x, so its x run is as long as the
// run of cycles after the load (far more than the engine's own xStart walk of 256 changes).
module xr_run (input logic clk, input logic ld, input logic [7:0] seed, output logic [7:0] r);
  initial r = 8'h01;
  always_ff @(posedge clk)
    if (ld) r <= seed;
    else    r <= {r[6:0], r[7]};
endmodule
