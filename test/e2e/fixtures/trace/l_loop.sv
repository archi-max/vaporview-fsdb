// Design L: an always_comb whose writes sit in a for loop with a constant (parameter) bound.
module l_loop #(parameter int unsigned N = 2) (
  input  logic [N-1:0] c,
  input  logic [N-1:0] en,
  output logic [N-1:0] v
);
  always_comb begin
    v = '0;
    for (int unsigned i = 0; i < N; i++) begin
      if (en[i] && c[i]) begin
        v[i] = 1'b1;
      end
    end
  end
endmodule
