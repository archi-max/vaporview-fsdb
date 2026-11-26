`timescale 1ns/1ns
// Synthetic design for source link's "no change recorded" e2e (vscode-port). Public domain / CC0.
// `quiet` and `never` are 2-state signals nothing ever assigns (as CVA6's rv_tracer packet_f_opt_ext_subformat, whose
// drivers are commented out): a VCS dump has no value change for them at all. `cnt` counts so the dump has time.
module nc_core (input logic clk, input logic rst, output logic [3:0] cnt);
  typedef enum bit [1:0] { A, B, C } e_t;
  e_t       never [1:0];
  bit [3:0] quiet;
  logic [3:0] next;
  assign next = cnt + 4'd1;
  always_ff @(posedge clk) begin
    if (rst) cnt <= 4'd0;
    else cnt <= next;
  end
endmodule

module nc_top;
  logic clk = 1'b0;
  logic rst = 1'b1;
  logic [3:0] cnt;
  always #5 clk = ~clk;
  nc_core u (.clk(clk), .rst(rst), .cnt(cnt));
  initial begin
    $dumpfile("nc.vcd");
    $dumpvars(0, nc_top);
    #12 rst = 1'b0;
    #200 $finish;
  end
endmodule
