`timescale 1ns/1ns
// Design R: a value shifted along a register (SERV's serv_bufreg2 dlo, the same shape). dlo
// loads din's low bits when ld is set, else shifts down taking dhi's bit 0 in at the top; the 1
// it holds at 50 came from din at 25, through two shifts, not from ld (the select). cnt counts
// tick (SERV's o_cnt <= o_cnt + cnt_r[3]): its value comes from tick, not from its own last count.
// rg is a ring (SERV's cnt_lsb): its 1 goes round, re-entering at bit 0 through an OR with inj.
// pc <= cp + 2 through a blocking temp cp = pc (a CPU's next pc): the + makes its bits, so pc's
// own bits read through cp are not wired to its value, and it is not a shift.
// pd <= cd + (inj ? 4 : 2), cd = pd (a CPU's pc + 2 or 4): its only data input is itself, with
// another value (a count); what it counts by is the select inj, the input that isn't itself.
module r_shift (
  input  logic        clk,
  input  logic        rst_n,
  input  logic        ld,
  input  logic [31:0] din,
  output logic [23:0] dlo,
  output logic [7:0]  dhi,
  input  logic        tick,
  output logic [3:0]  cnt,
  input  logic        inj,
  output logic [3:0]  rg,
  output logic [3:0]  pc,
  output logic [3:0]  pd
);
  logic [3:0] cp, cd;
  always_ff @(posedge clk) begin
    if (!rst_n) begin
      dlo <= '0;
      dhi <= '0;
    end else begin
      dhi <= ld ? din[31:24] : {1'b0, dhi[7:1]};
      dlo <= ld ? din[23:0] : {dhi[0:0], dlo[23:1]};
    end
  end

  always_ff @(posedge clk) begin
    if (!rst_n) cnt <= '0;
    else cnt <= cnt + {3'd0, tick};
  end

  always_ff @(posedge clk) begin
    if (!rst_n) rg <= '0;
    else rg <= {rg[2:0], rg[3] | inj};
  end

  always @(posedge clk) begin
    cp = pc;
    if (!rst_n) pc <= 4'd2;
    else if (tick) pc <= cp + 4'd2;
  end

  always @(posedge clk) begin
    cd = pd;
    if (!rst_n) pd <= 4'd2;
    else if (tick) pd <= cd + (inj ? 4'd4 : 4'd2);
  end
endmodule
