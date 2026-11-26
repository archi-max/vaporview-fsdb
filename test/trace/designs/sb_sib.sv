// Design SB: two sibling blocks of one process declare a local of the same name.
// b1 assigns its t whole; b2's t is a different variable, read before it is assigned on the arm not
// taken when sel is x. The static carried-locals rule (an uncertain path) must count b2's t as
// carried: b1's assignment says nothing about it.
module sb_sib(input logic clk, input logic sel, input logic [3:0] d, output logic [3:0] q10, output logic [3:0] q11);
  always_ff @(posedge clk) begin
    begin : b1
      logic [3:0] t;
      t = d;
    end
    begin : b2
      logic [3:0] t;
      if (sel) q10 <= t;
      else q10 <= 4'h1;
      t = d;
    end
  end
  // Control: the same process with distinct local names.
  always_ff @(posedge clk) begin
    begin : c1
      logic [3:0] t0;
      t0 = d;
    end
    begin : c2
      logic [3:0] u;
      if (sel) q11 <= u;
      else q11 <= 4'h1;
      u = d;
    end
  end
endmodule
