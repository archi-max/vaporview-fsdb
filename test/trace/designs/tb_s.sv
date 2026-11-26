`timescale 1ns/1ns
module tb_s;
  logic clk = 0, rst_n = 0;
  logic bad = 0, sel = 0, en = 0, msel = 0;
  logic [7:0] ld = 8'h00, nd_d = 8'h00, nd_e = 8'h00, rd = 8'h00, ro = 8'h00;
  logic [7:0] mask = 8'hff, md = 8'h00, a = 8'h00, b = 8'h00;
  logic [7:0] lq, nq, rq, mrn, mq;
  s_lit  t_lit  (.clk, .rst_n, .bad, .d(ld), .q(lq));
  s_nd   t_nd   (.clk, .rst_n, .sel, .d(nd_d), .e(nd_e), .q(nq));
  s_rep  t_rep  (.clk, .rst_n, .en, .d(rd), .o(ro), .q(rq));
  s_mask t_mask (.clk, .rst_n, .mask, .d(md), .rn(mrn));
  s_mux  t_mux  (.clk, .sel(msel), .a, .b, .q(mq));
  always #5 clk = ~clk;
  initial begin
`ifdef FSDB
    $fsdbDumpfile("s.fsdb"); $fsdbDumpvars(0, tb_s, "+all");
`endif
    $dumpfile("s.vcd");
    // Everything but t_nd.nd (A2's input the dump leaves out).
    $dumpvars(1, tb_s);
    $dumpvars(0, tb_s.t_lit, tb_s.t_rep, tb_s.t_mask, tb_s.t_mux);
    $dumpvars(1, tb_s.t_nd.clk, tb_s.t_nd.rst_n, tb_s.t_nd.sel, tb_s.t_nd.d, tb_s.t_nd.e, tb_s.t_nd.q);
    #22 rst_n = 1;
    #10 begin ld = 8'b0000_000x; nd_d = 8'b0000_000x; rd = 8'b0000_000x; md = 8'b0000_x000; end  // t=32: an x at 35
    #10 begin ld = 8'h00; nd_d = 8'h00; rd = 8'h00; md = 8'h00; end                                 // t=42
    #10 begin bad = 1; sel = 1; nd_e = 8'b000x_0000; en = 1; ro = 8'b0000_000x; md = 8'b00x0_0000; end  // t=52: at 55
    #10 begin bad = 0; sel = 0; nd_e = 8'h00; en = 0; ro = 8'h00; md = 8'h00; end                  // t=62
    #10 mask = 8'b1101_1111;                                                                       // t=72: bit 5 cleared at 75
    #10 mask = 8'hff;                                                                              // t=82
    #118 $finish;                                                                                  // t=200
  end
  initial begin
    #12 a = 8'h05;   // t=12: a is 5 (not taken)
    #30 b = 8'h05;   // t=42: b is 5, mq takes it at 45
  end
endmodule
