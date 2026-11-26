Synthetic driver-tracing fixtures (e2e), from cmux scripts/waveform-viewer-checks/trace (designs A and P
and their plain dumps, simulator headers neutralised). a.f / p.f: the slang arguments (vaporview.trace.designArgs:
["-f", "a.f"]). The answers the e2e checks are the ones cmux's case suite pins for these designs (test/trace/cases.js).

Design H (h_bus.sv, tb_h.sv, h.f): a shared bus with two drivers (two tri-state assigns, lines 11 and 12); sel turns from b (line 12) to a (line 11) at 30. h.vcd from Icarus (date line neutralised). For the driver highlight e2e (multi-driver).

Design L (l_loop.sv, tb_l.sv, l.f): an always_comb whose write `v[i] = 1'b1;` (line 11) sits in a for loop with a
parameter bound, under `if (en[i] && c[i])`; v = '0 (line 8) before it. c turns 2'b10 at 10 (v[1] from line 11, i = 1),
en turns 2'b01 at 20 (v back to 0). l.vcd from Icarus (date line neutralised). For Trace Driver through a for loop.
