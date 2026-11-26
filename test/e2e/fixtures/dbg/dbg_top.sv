`timescale 1ns/1ns
// Synthetic design for the waveform debugger's e2e tests (vscode-port P4). Public domain / CC0.
// Two instances of `counter` (u0 counts every cycle, u1 every other cycle) and an instruction word that cycles
// through four RISC-V instructions. Regenerate dbg.vcd with ./gen.sh (Icarus Verilog).
module counter #(parameter STEP = 1) (
  input  logic       clk,
  input  logic       rst,
  input  logic       en,
  output logic [7:0] cnt,
  output logic       wrap
);
  logic [7:0] next;
  assign next = cnt + STEP;
  always_ff @(posedge clk) begin
    if (rst) cnt <= 8'd0;
    else if (en) cnt <= next;
  end
  assign wrap = (cnt == 8'hff);
endmodule

module dbg_top;
  logic        clk = 1'b0;
  logic        rst = 1'b1;
  logic [3:0]  phase = 4'd0;
  logic [31:0] instr = 32'h0;
  logic [7:0]  c0, c1;
  logic        w0, w1;
  logic        en1;

  always #5 clk = ~clk;

  assign en1 = phase[0];

  counter #(.STEP(1)) u0 (.clk(clk), .rst(rst), .en(1'b1), .cnt(c0), .wrap(w0));
  counter #(.STEP(1)) u1 (.clk(clk), .rst(rst), .en(en1), .cnt(c1), .wrap(w1));

  always_ff @(posedge clk) begin
    phase <= phase + 4'd1;
    case (phase[1:0])
      2'd0: instr <= 32'h00500513;  // li a0, 5
      2'd1: instr <= 32'h008000ef;  // jal ra, +8
      2'd2: instr <= 32'h00b50633;  // add a2, a0, a1
      2'd3: instr <= 32'hfe050ee3;  // beqz a0, -4
    endcase
  end

  initial begin
    $dumpfile("dbg.vcd");
    $dumpvars(0, dbg_top);
    #12 rst = 1'b0;
    #400 $finish;
  end
endmodule
