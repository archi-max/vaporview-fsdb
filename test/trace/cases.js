// The checks run.sh trace runs on cmux-trace.js (the active driver, phase P1 of driver tracing):
// the prototype's seven hand-traced x chains (status/tracex-design.md section 11), one active()
// step at a time, on every dump of each design (VCS plain, -xprop variants, Icarus); design E's
// constructs; and the replay oracle (every change of every signal re-executed and compared with
// the dump). Fields of a case, each checked when present:
//   kind (driver.kind), proc (procKind), file + line + stmt (a substring of the statement),
//   act (activation edge), sample, since, value (bits), dec [[condition substring, taken]...],
//   fanin { path or local name: bits, or '*' for any value }, noFanin [names that must not be fan-in], roles { fan-in name: 'data' | 'control' }, xIndex [fan-in names read through an x index],
//   trust, noTrust (a trust it must not have), root, reasons [codes that must be there], viol [each decision's case violation or null],
//   noReasons [codes that must not], dumps [variants it runs on; default all of the design's; 'stale' is
//   the Icarus dump with staleModel's model, 'nowrites' with that model's write lists removed only].
/* global cmuxTrace, traceVcd, traceFiles */
/* exported runTraceChecks */

const TRACE_DUMPS = {
  a: ['plain', 'flowctrl', 'tmerge', 'xcfg', 'icarus'],
  b: ['plain', 'flowctrl', 'tmerge', 'xcfg', 'icarus'],
  c: ['plain', 'flowctrl', 'tmerge', 'xcfg', 'icarus'],
  e: ['plain', 'flowctrl', 'tmerge', 'xcfg', 'icarus'],
  // Icarus 12 has no interface ports.
  f: ['plain', 'flowctrl', 'tmerge', 'xcfg'],
  g: ['plain', 'flowctrl', 'tmerge', 'xcfg', 'icarus'],
  h: ['plain', 'flowctrl', 'tmerge', 'xcfg', 'icarus'],
  i: ['icarus'],
  j: ['icarus'],
  // The vendor task is $deposit under Icarus (the model sees $cmux_poke).
  k: ['icarus'],
  // The classes a Verdi oracle run found exact but wrong on a larger SoC testbench, small.
  l: ['icarus'],
  // Registers that hold an x for many cycles (Trace X's held jump; VCS only: no Icarus host).
  p: ['plain'],
  // A held x whose bits change inside its run: a new x (rn) or the same one moving (ms).
  q: ['plain'],
  // A clean value shifted along a register (Trace to Root's bit slices over a select).
  r: ['plain'],
  // Held x jumps that look exact and are not: a literal x, an undumped input, an x replaced with
  // no change, an x that came and went, a same value on the arm not taken (a reviewer's cases).
  s: ['plain'],
  v: ['plain'],
  w: ['plain'],
  y: ['plain'],
  u: ['plain'],
  m: ['plain'],
  o: ['plain'],
  t: ['plain'],
  d: ['plain'],
  lf: ['plain'],
  z: ['plain'],
  // Shift registers and a counter where a rule's pick is not proof (exact must be earned).
  x: ['plain'],
  // H10 : sibling blocks with same-named locals (Icarus).
  sb: ['icarus'],
};

const XX = 'xxxxxxxx';
const TRACE_CASES = [
  // ---- SB (H10): b1's whole write of its own t must not count as b2's t assigned. sel is x at
  // the edge at 5: the else arm runs (q10 <= 1), so the path is uncertain and b2's t, read before
  // assigned on the arm not taken, is carried (staticLocal, approximate). q11, the control with
  // distinct names, gets the same label. ----
  { d: 'sb', sig: 'tb_sb.dut.q10', t: 10, kind: 'proc', proc: 'AlwaysFF', file: 'sb_sib.sv', stmt: "q10 <= 4'h1;", act: 5, value: '0001', reasons: ['staticLocal'], trust: 'approximate' },
  { d: 'sb', sig: 'tb_sb.dut.q11', t: 10, kind: 'proc', proc: 'AlwaysFF', file: 'sb_sib.sv', stmt: "q11 <= 4'h1;", act: 5, value: '0001', reasons: ['staticLocal'], trust: 'approximate' },
  // ---- A: an uninitialized flop through comb logic and a blocking temp (chain 1) ----
  { d: 'a', sig: 'tb_a.dut.dout', t: 60, kind: 'proc', proc: 'AlwaysFF', file: 'a_uninit.sv', line: 34, stmt: 'dout <= stage;',
    act: 55, sample: 54, since: 55, value: XX, dec: [['!rst_n', 'else']], fanin: { 'tb_a.dut.stage': XX, 'tb_a.dut.rst_n': '1', 'tb_a.dut.clk': '1' }, trust: 'exact' },
  { d: 'a', sig: 'tb_a.dut.stage', t: 54, kind: 'proc', proc: 'AlwaysComb', file: 'a_uninit.sv', line: 28, stmt: 'stage = tmp;',
    since: 45, dec: [['valid_q', 'then']], fanin: { tmp: XX, 'tb_a.dut.valid_q': '1', 'tb_a.dut.sum': XX }, trust: 'computed' },
  { d: 'a', sig: 'tb_a.dut.sum', t: 54, kind: 'assign', file: 'a_uninit.sv', line: 23, stmt: 'sum = acc ^ {8{valid_q}}',
    since: 0, fanin: { 'tb_a.dut.acc': XX, 'tb_a.dut.valid_q': '1' }, trust: 'exact' },
  { d: 'a', sig: 'tb_a.dut.acc', t: 54, kind: 'proc', proc: 'AlwaysFF', file: 'a_uninit.sv', line: 21, stmt: 'acc <= acc + din;',
    act: 45, sample: 44, dec: [['en', 'then']], fanin: { 'tb_a.dut.acc': XX, 'tb_a.dut.din': '00000011' } },
  // Known values: the else branch (en low) and the reset branch.
  { d: 'a', sig: 'tb_a.dut.stage', t: 30, kind: 'proc', line: 29, stmt: 'stage = din;', dec: [['valid_q', 'else']], value: '00000011', trust: 'exact' },
  { d: 'a', sig: 'tb_a.dut.dout', t: 10, kind: 'proc', line: 33, stmt: "dout <= '0;", value: '00000000', dec: [['!rst_n', 'then']], trust: 'exact' },
  { d: 'a', sig: 'tb_a.dut.valid_q', t: 48, kind: 'proc', line: 18, stmt: 'valid_q <= en;', act: 45, sample: 44, value: '1', trust: 'exact' },

  // ---- B: x index, unwritten memory, x-assignment, x selector (chains 2-5) ----
  { d: 'b', sig: 'tb_b.dut.rdata', t: 60, kind: 'proc', proc: 'AlwaysComb', file: 'b_select.sv', line: 32, stmt: 'rdata = mem[raddr_q];',
    since: 55, value: XX, dec: [['mode_q', 0]], fanin: { 'tb_b.dut.raddr_q': 'xx' }, xIndex: ['mem'], dumps: ['plain', 'flowctrl', 'tmerge', 'icarus'] },
  { d: 'b', sig: 'tb_b.dut.raddr_q', t: 60, kind: 'proc', proc: 'AlwaysFF', line: 26, stmt: 'raddr_q <= raddr;', act: 55, sample: 54,
    dec: [['!rst_n', 'else']], fanin: { 'tb_b.dut.raddr': 'xx' }, trust: 'exact' },
  { d: 'b', sig: 'tb_b.dut.raddr', t: 54, kind: 'portIn', file: 'tb_b.sv', line: 6, since: 50, fanin: { 'tb_b.raddr': 'xx' }, trust: 'exact' },
  { d: 'b', sig: 'tb_b.raddr', t: 54, kind: 'initial', root: 'testbench', since: 50, reasons: ['testbench'], file: 'tb_b.sv', line: 16, stmt: "raddr = 2'bxx;" },
  { d: 'b', sig: 'tb_b.dut.rdata', t: 80, kind: 'proc', line: 32, stmt: 'rdata = mem[raddr_q];', dec: [['mode_q', 0]],
    fanin: { 'tb_b.dut.raddr_q': '11', 'tb_b.dut.mem[3]': XX }, dumps: ['plain', 'flowctrl', 'tmerge', 'xcfg'] },
  { d: 'b', sig: 'tb_b.dut.rdata', t: 100, kind: 'proc', line: 35, stmt: "rdata = 'x;", dec: [['mode_q', 'default']], value: XX, trust: 'exact' },
  { d: 'b', sig: 'tb_b.dut.rdata', t: 120, kind: 'proc', line: 35, stmt: "rdata = 'x;", dec: [['mode_q', 'default']], value: XX,
    fanin: { 'tb_b.dut.mode_q': 'xx' }, dumps: ['plain', 'flowctrl', 'tmerge', 'icarus'] },
  { d: 'b', sig: 'tb_b.dut.mode_q', t: 120, kind: 'proc', line: 27, stmt: 'mode_q  <= mode;', act: 115, sample: 114, fanin: { 'tb_b.dut.mode': 'xx' } },
  { d: 'b', sig: 'tb_b.dut.mode', t: 114, kind: 'portIn', file: 'tb_b.sv', line: 6, since: 110, fanin: { 'tb_b.mode': 'xx' } },
  { d: 'b', sig: 'tb_b.mode', t: 114, kind: 'initial', root: 'testbench', file: 'tb_b.sv', line: 19, stmt: "mode = 2'bxx;" },
  // The testbench's write in effect at t, not the body's last (#delays summed along the body).
  { d: 'b', sig: 'tb_b.mode', t: 100, kind: 'initial', file: 'tb_b.sv', line: 18, stmt: 'mode = 2\'d3;' },
  // Known: case item 1 and the memory write (FSDB-only memories: the VCDs have no mem).
  { d: 'b', sig: 'tb_b.dut.rdata', t: 140, kind: 'proc', line: 33, stmt: 'rdata = ~mem[raddr_q];', dec: [['mode_q', 1]], value: '11011101', reasons: ['notDumped'], trust: 'approximate', dumps: ['icarus'] },
  { d: 'b', sig: 'tb_b.dut.rdata', t: 140, kind: 'proc', line: 33, stmt: 'rdata = ~mem[raddr_q];', dec: [['mode_q', 1]], value: '11011101', reasons: ['notDumped'], trust: 'approximate', dumps: ['plain'] },

  // ---- C: hierarchy and a packed-struct port (chains 6 and 7) ----
  { d: 'c', sig: 'tb_c.dut.q', t: 60, kind: 'portOut', file: 'c_struct.sv', line: 81, since: 55, fanin: { 'tb_c.dut.u_mid.q': XX }, trust: 'exact' },
  { d: 'c', sig: 'tb_c.dut.u_mid.q', t: 60, kind: 'portOut', line: 68, fanin: { 'tb_c.dut.u_mid.u_sink.q': XX } },
  { d: 'c', sig: 'tb_c.dut.u_mid.u_sink.q', t: 60, kind: 'proc', proc: 'AlwaysFF', line: 56, stmt: 'q  <= mix;', act: 55, sample: 54,
    dec: [['!rst_n', 'else'], ['in.valid', 'then']], fanin: { 'tb_c.dut.u_mid.u_sink.mix': XX }, trust: 'exact' },
  { d: 'c', sig: 'tb_c.dut.u_mid.u_sink.mix', t: 54, kind: 'assign', line: 49, stmt: 'mix = in.data + {4\'b0, in.id}', since: 0 },
  { d: 'c', sig: 'tb_c.dut.u_mid.u_sink.in', t: 54, kind: 'portIn', line: 68, since: 45, fanin: { 'tb_c.dut.u_mid.pin': '1xxxx00010000' }, trust: 'exact' },
  { d: 'c', sig: 'tb_c.dut.u_mid.pin', t: 54, kind: 'portIn', line: 81, fanin: { 'tb_c.dut.p': '1xxxx00010000' } },
  // A port's connection is evaluated in the parent: the driver says so (the page checks it against the KDB).
  { d: 'c', sig: 'tb_c.dut.u_mid.u_sink.in', t: 54, kind: 'portIn', from: 'tb_c.dut.u_mid' },
  { d: 'c', sig: 'tb_c.dut.p', t: 54, kind: 'portOut', line: 80, fanin: { 'tb_c.dut.u_src.out': '1xxxx00010000' } },
  { d: 'c', sig: 'tb_c.dut.u_src.out', t: 54, kind: 'assign', line: 37, stmt: "out = '{valid: valid_q", fanin: { 'tb_c.dut.u_src.id_q': 'xxxx' }, trust: 'exact', dumps: ['plain', 'flowctrl', 'tmerge', 'xcfg'] },
  { d: 'c', sig: 'tb_c.dut.u_src.out', t: 54, kind: 'assign', line: 35, stmt: 'out = {valid_q, id_q, data_q}', fanin: { 'tb_c.dut.u_src.id_q': 'xxxx' }, trust: 'exact', dumps: ['icarus'] },
  { d: 'c', sig: 'tb_c.dut.u_src.id_q', t: 54, kind: 'proc', line: 29, stmt: "id_q   <= id_q + 4'd1;", act: 45, sample: 44, dec: [['go', 'then']] },
  { d: 'c', sig: 'tb_c.qd', t: 80, kind: 'portOut', file: 'tb_c.sv', line: 6, since: 75, fanin: { 'tb_c.dut.qd': XX } },
  { d: 'c', sig: 'tb_c.dut.qd', t: 80, kind: 'portOut', line: 81 },
  { d: 'c', sig: 'tb_c.dut.u_mid.u_sink.qd', t: 80, kind: 'proc', line: 57, stmt: 'qd <= in.data;', act: 75, sample: 74, dec: [['!rst_n', 'else'], ['in.valid', 'then']] },
  { d: 'c', sig: 'tb_c.dut.u_src.data_q', t: 74, kind: 'proc', line: 30, stmt: 'data_q <= d;', act: 65, sample: 64, since: 65, fanin: { 'tb_c.dut.u_src.d': XX } },
  { d: 'c', sig: 'tb_c.dut.u_src.d', t: 64, kind: 'portIn', line: 80, since: 60, fanin: { 'tb_c.dut.d': XX } },
  { d: 'c', sig: 'tb_c.dut.d', t: 64, kind: 'portIn', file: 'tb_c.sv', line: 6, fanin: { 'tb_c.d': XX } },
  { d: 'c', sig: 'tb_c.d', t: 64, kind: 'initial', root: 'testbench', since: 60 },

  // ---- E: more constructs ----
  { d: 'e', sig: 'tb_e.dut.lat', t: 45, kind: 'proc', proc: 'AlwaysLatch', line: 27, stmt: 'lat = a;', value: '00010010', reasons: ['held'], sample: 30 },
  { d: 'e', sig: 'tb_e.dut.lat', t: 35, kind: 'proc', proc: 'AlwaysLatch', line: 27, value: '00010010', noReasons: ['held'], dec: [['en', 'then']] },
  { d: 'e', sig: 'tb_e.dut.dec', t: 35, kind: 'proc', line: 33, stmt: "dec = 4'd4;", dec: [['op', 1]], value: '0100', trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.dec', t: 60, kind: 'proc', line: 32, stmt: "dec = 4'd8;", dec: [['op', 0]], value: '1000', trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.dec', t: 100, kind: 'proc', line: 34, stmt: "dec = 4'd2;", value: '0010', trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.carry', t: 35, kind: 'assign', line: 42, stmt: '{carry, sum} = a + b', value: '0', trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.sum', t: 35, kind: 'assign', line: 42, value: '01000110', trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.hi_lo', t: 35, kind: 'assign', reasons: ['multiDriven'], value: '00100011' },
  { d: 'e', sig: 'tb_e.dut.y', t: 35, kind: 'assign', line: 66, stmt: 'y = lane[0].r ^ lane[1].r', trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.lane[1].r', t: 35, kind: 'proc', proc: 'AlwaysFF', line: 64, stmt: 'r <= r + a;', act: 35, sample: 34, trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.pk', t: 35, kind: 'assign', line: 71, value: '00110100', fanin: { 'tb_e.dut.op': '0110' }, trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.asc', t: 35, kind: 'assign', line: 74, value: '01001000', trust: 'exact' },
  { d: 'e', sig: 'tb_e.dut.t2', t: 40, kind: 'proc', line: 84, stmt: "t2 <= tmp2 + 8'd1;", act: 35, value: '00100111', trust: 'computed',
    // (act 35: the edge at 35 wrote the same value again; the value in effect is that write's.)
    // A blocking temp's fan-in carries what its write read (tmp2 = a ^ b), not just the temp.
    fanin: { 'tb_e.dut.tmp2': '*', 'tb_e.dut.a': '*', 'tb_e.dut.b': '*' } },
  // An if on x in a flop and in comb logic: x-optimistic sims take the else branch...
  { d: 'e', sig: 'tb_e.dut.xc', t: 75, kind: 'proc', proc: 'AlwaysComb', line: 56, stmt: 'xc = b;', value: '01111000', dec: [['sel', 'else']], trust: 'exact', dumps: ['plain', 'flowctrl', 'icarus'] },
  { d: 'e', sig: 'tb_e.dut.xf', t: 80, kind: 'proc', proc: 'AlwaysFF', line: 52, stmt: 'xf <= b;', act: 75, value: '01111000', dec: [['!rst_n', 'else'], ['sel', 'else']], trust: 'exact', dumps: ['plain', 'flowctrl', 'icarus'] },
  // ...X-propagation merges both branches (tmerge: the bits they agree on, else x).
  { d: 'e', sig: 'tb_e.dut.xc', t: 75, kind: 'proc', value: '01x1xxx0', dec: [['sel', 'merge']], reasons: ['xprop'], trust: 'approximate', dumps: ['tmerge', 'xcfg'] },
  { d: 'e', sig: 'tb_e.dut.xf', t: 80, kind: 'proc', act: 75, value: '01x1xxx0', dec: [['!rst_n', 'else'], ['sel', 'merge']], reasons: ['xprop'], dumps: ['tmerge', 'xcfg'] },
  // Branches that agree: the merge is the common value.
  { d: 'e', sig: 'tb_e.dut.xc', t: 60, kind: 'proc', value: '01010110', trust: 'exact' },

  // ---- F: interface signals written by other instances through modport ports ----
  // The memory model's comb read of a never-written element (its memory isn't in the VCD).
  { d: 'f', sig: 'tb_f.bus.rdata', t: 60, kind: 'proc', proc: 'AlwaysComb', writer: 'tb_f.u_mem', file: 'f_bus.sv', line: 23,
    stmt: 'bus.rdata = store[bus.addr[1:0]];', value: XX, dec: [['bus.req', 'then']], fanin: { 'tb_f.bus.req': '1', 'tb_f.bus.addr': '00000011' } },
  { d: 'f', sig: 'tb_f.bus.rdata', t: 20, kind: 'proc', writer: 'tb_f.u_mem', line: 24, stmt: "bus.rdata = 8'h00;", value: '00000000', dec: [['bus.req', 'else']], trust: 'exact' },
  { d: 'f', sig: 'tb_f.bus.resp', t: 40, kind: 'proc', proc: 'AlwaysFF', writer: 'tb_f.u_mem', line: 28, stmt: 'bus.resp <= bus.req;', act: 35, sample: 34, value: '1', trust: 'exact' },
  { d: 'f', sig: 'tb_f.bus.addr', t: 55, kind: 'assign', writer: 'tb_f.dut', line: 32, stmt: 'bus.addr = a', value: '00000011', fanin: { 'tb_f.dut.a': '00000011' }, trust: 'exact' },
  { d: 'f', sig: 'tb_f.bus.req', t: 30, kind: 'proc', writer: 'tb_f.dut', line: 38, stmt: "bus.req <= 1'b1;", act: 25, value: '1', dec: [['!rst_n', 'else']], trust: 'exact' },
  // The reader's side: the dut's flop takes the interface's x.
  { d: 'f', sig: 'tb_f.dut.q', t: 60, kind: 'proc', proc: 'AlwaysFF', line: 39, stmt: 'q <= bus.rdata;', act: 55, value: XX, fanin: { 'tb_f.bus.rdata': XX } },
  // ---- G: a default then an override in one run: the last write that runs is the driver ----
  { d: 'g', sig: 'tb_g.dut.q', t: 30, kind: 'proc', proc: 'AlwaysFF', file: 'g_override.sv', line: 16, stmt: 'q <= d;', act: 25, sample: 24,
    value: '01011010', dec: [['!rst_n', 'else'], ['en', 'then']], fanin: { 'tb_g.dut.d': '01011010' }, trust: 'exact' },
  { d: 'g', sig: 'tb_g.dut.q', t: 48, kind: 'proc', line: 15, stmt: "q <= 8'h0f;", act: 45, value: '00001111', dec: [['!rst_n', 'else']], trust: 'exact' },
  { d: 'g', sig: 'tb_g.dut.y', t: 30, kind: 'proc', proc: 'AlwaysComb', line: 21, stmt: "y = d ^ 8'hff;", value: '10100101', dec: [['en', 'then']], trust: 'exact' },
  { d: 'g', sig: 'tb_g.dut.y', t: 45, kind: 'proc', line: 20, stmt: "y = 8'h00;", value: '00000000', dec: [], trust: 'exact' },
  // ---- H: z and tri-state, NBA, casex, x-index write, multi-driver, priority/unique, merge, delay ----
  // (the dump is in ps, the design's delays in ns)
  // A z passes through ports (implicit .* connections, the leaf names shown) and a tri-state bus.
  { d: 'h', sig: 'tb_h.dut.u_leaf.sel', t: 72000, kind: 'portIn', stmt: '.sel(sel)', value: '0z10', trust: 'exact' },
  { d: 'h', sig: 'tb_h.dut.sel', t: 72000, kind: 'portIn', stmt: '.sel(sel)', value: '0z10', trust: 'exact' },
  { d: 'h', sig: 'tb_h.dut.u_leaf.sel_o', t: 72000, kind: 'assign', value: '0z10', trust: 'exact' },
  { d: 'h', sig: 'tb_h.sel_o', t: 72000, kind: 'portOut', stmt: '.sel_o(sel_o)', value: '0z10', trust: 'exact' },
  { d: 'h', sig: 'tb_h.dut.bus', t: 72000, kind: 'assign', value: 'zzzzzzzz', reasons: ['multiDriven'], trust: 'exact' },
  // Two drivers: the second is the one whose value is on the bus.
  { d: 'h', sig: 'tb_h.dut.bus', t: 56000, kind: 'assign', line: 61, stmt: 'bus = oe_b ? ~din', value: '10101011', reasons: ['multiDriven'], trust: 'exact' },
  // Nonblocking read-after-write: r takes q's old value.
  { d: 'h', sig: 'tb_h.dut.r', t: 36000, kind: 'proc', line: 40, stmt: "r <= q + 8'h01;", value: '00100010', fanin: { 'tb_h.dut.q': '00100001' }, trust: 'exact' },
  // casex: an x in the selector, a z in the selector, wildcards in the items.
  { d: 'h', sig: 'tb_h.dut.cx', t: 66000, kind: 'proc', stmt: "cx = 8'ha1;", value: '10100001', dec: [['sel', 0]], trust: 'exact', dumps: ['plain', 'flowctrl', 'icarus'] },
  { d: 'h', sig: 'tb_h.dut.cx', t: 76000, kind: 'proc', stmt: "cx = 8'hb2;", value: '10110010', dec: [['sel', 1]], trust: 'exact', dumps: ['plain', 'flowctrl', 'icarus'] },
  { d: 'h', sig: 'tb_h.dut.cx', t: 46000, kind: 'proc', stmt: "cx = 8'hc3;", value: '11000011', dec: [['sel', 2]], trust: 'exact' },
  // An x-index write writes no element: mem[0] keeps the write before it (Icarus dumps the elements).
  { d: 'h', sig: 'tb_h.dut.mem[0]', t: 50000, kind: 'proc', stmt: 'mem[0] <= din;', value: '01000011', trust: 'exact', dumps: ['icarus'] },
  { d: 'h', sig: 'tb_h.dut.mem[1]', t: 50000, kind: 'proc', value: '00111101', trust: 'computed', dumps: ['icarus'] },
  // priority: two items match, no violation; unique: the same is a violation.
  { d: 'h', sig: 'tb_h.dut.pv', t: 36000, kind: 'proc', stmt: "pv = 8'h01;", value: '00000001', dec: [['pr', 0]], viol: [null], trust: 'exact' },
  { d: 'h', sig: 'tb_h.dut.uv', t: 36000, kind: 'proc', stmt: "uv = 8'h11;", value: '00010001', dec: [['pr', 0]], viol: ['multipleMatches'] },
  // An if on x under X-propagation: both branches merged, the step names the last write.
  { d: 'h', sig: 'tb_h.dut.mv', t: 56000, kind: 'proc', line: 80, stmt: "mv <= 8'h5a;", reasons: ['xprop'], dumps: ['tmerge', 'xcfg'] },
  { d: 'h', sig: 'tb_h.dut.mv', t: 56000, kind: 'proc', line: 80, stmt: "mv <= 8'h5a;", value: '01011010', dec: [['c', 'else']], dumps: ['plain', 'icarus'] },
  // An RTL delay makes the step approximate.
  { d: 'h', sig: 'tb_h.dut.dly', t: 30000, kind: 'assign', stmt: 'dly = din', reasons: ['delay'], trust: 'approximate' },
  // The testbench write in effect at t: the delays (ns) scaled to the dump's ps.
  { d: 'h', sig: 'tb_h.din', t: 45000, kind: 'initial', file: 'tb_h.sv', line: 21, stmt: "din = 8'h43;", root: 'testbench' },
  { d: 'h', sig: 'tb_h.din', t: 10000, kind: 'initial', file: 'tb_h.sv', line: 6, stmt: "din = 8'b00010000", root: 'testbench' },
  { d: 'h', sig: 'tb_h.din', t: 80000, kind: 'initial', file: 'tb_h.sv', line: 24, stmt: "din = 8'h76;", root: 'testbench' },
  // Several delay scales fit (#5 at 1000 ps per ns, #50 at 100): the largest, so the #5 write.
  { d: 'h', sig: 'tb_h.ms', t: 30000, kind: 'initial', file: 'tb_h.sv', line: 30, stmt: "ms = 8'h99;", root: 'testbench' },

  // ---- I: writes that are found though not re-executed (approximate, never "no driver") ----
  // A loop-indexed comb write, per-lane counters in a loop, byte writes into memory words in a loop.
  { d: 'i', sig: 'tb_i.dut.pop', t: 30000, kind: 'proc', proc: 'AlwaysComb', file: 'i_drivers.sv', line: 23, stmt: 'for (int t = 0; t < 4; t++)',
    trust: 'approximate', reasons: ['statement'], noReasons: ['noWrite'] },
  { d: 'i', sig: 'tb_i.dut.lost[2]', t: 30000, kind: 'proc', proc: 'AlwaysFF', file: 'i_drivers.sv', line: 27, stmt: 'for (int c = 0; c < 4; c++) if (valid[c]',
    trust: 'approximate', reasons: ['statement'], noReasons: ['noWrite'] },
  { d: 'i', sig: 'tb_i.dut.mem[0]', t: 30000, kind: 'proc', proc: 'Always', file: 'i_drivers.sv', line: 30, stmt: 'for (int b = 0; b < 4; b++)',
    trust: 'approximate', reasons: ['statement'], noReasons: ['noWrite'] },
  // The testbench: x++ in a clocked block; a $value$plusargs output and an initial block that also
  // calls a dump task the elaborator doesn't know.
  { d: 'i', sig: 'tb_i.settle', t: 30000, kind: 'proc', proc: 'Always', file: 'tb_i.sv', line: 14, stmt: 'settle++;', noReasons: ['noWrite'] },
  { d: 'i', sig: 'tb_i.iters', t: 30000, kind: 'initial', root: 'testbench', file: 'tb_i.sv', line: 16 },
  { d: 'i', sig: 'tb_i.epoch', t: 30000, kind: 'initial', root: 'testbench', file: 'tb_i.sv', line: 17, stmt: 'epoch = iters;' },

  // ---- J: an x through a blocking temp the block ends with tmp = 'bx; a default 'bx no later case item replaced ----
  // q <= tmp, tmp = go ? a : b earlier in the block: q's fan-in is a and go (what reached q), not just tmp.
  { d: 'j', sig: 'tb_j.dut.q', t: 20000, kind: 'proc', file: 'j_temps.sv', line: 20, stmt: 'q <= tmp;', act: 15000, value: 'xxxx0001',
    fanin: { 'tb_j.dut.a': 'xxxx0001', 'tb_j.dut.go': '1', 'tb_j.dut.tmp': '*' } },
  // y = 'bx, then case (1'b1) with x items: nothing matched, so the items are why y stayed x.
  { d: 'j', sig: 'tb_j.dut.y', t: 10000, kind: 'proc', file: 'j_temps.sv', line: 29, stmt: "y = 'bx;",
    fanin: { 'tb_j.dut.is_add': 'x', 'tb_j.dut.is_xor': 'x' } },
  // wire is_add = op == 2'd1: a net's declaration assignment is a continuous assignment (its fan-in
  // is op), not a declaration initializer.
  { d: 'j', sig: 'tb_j.dut.is_add', t: 10000, kind: 'assign', file: 'j_temps.sv', line: 26, stmt: "is_add = op == 2'd1", fanin: { 'tb_j.dut.op': 'xx' } },
  // zq went x at 15 (zq <= 8'bx) and was rewritten x from a2 at 25 and 35: the value in effect was
  // written at the last edge, from a2, though its last change (since) is 15.
  { d: 'j', sig: 'tb_j.dut.zq', t: 40000, kind: 'proc', file: 'j_temps.sv', line: 43, stmt: 'zq <= a2;', act: 35000, since: 15000,
    fanin: { 'tb_j.dut.a2': XX, 'tb_j.dut.zsel': '10' }, roles: { 'tb_j.dut.a2': 'data', 'tb_j.dut.zsel': 'control' } },
  // p1 <= p0 then p1[3:0] <= 4'h0: p1's x bits (the high nibble, from a) came from the whole write.
  { d: 'j', sig: 'tb_j.dut.p1', t: 20000, kind: 'proc', file: 'j_temps.sv', line: 49, stmt: 'p1 <= p0;', value: 'xxxx000100100000',
    fanin: { 'tb_j.dut.p0': 'xxxx000100100010' } },
  // The x part-select write a later narrower write of known bits overlaid is the one shown, compared
  // over its own bits with the later write laid over them; also inside a wider word.
  { d: 'j', sig: 'tb_j.dut.st', t: 30000, kind: 'proc', line: 61, stmt: "st[7:2] = 6'bx;", value: 'xxxx0011', trust: 'exact' },
  { d: 'j', sig: 'tb_j.dut.w16', t: 30000, kind: 'proc', line: 66, stmt: "w16[7:0] = 'bx;", value: '00000000xxxx0011', trust: 'exact' },
  // A local declared with an initializer: the fan-in goes on through the initializer's reads.
  // (Icarus 12 does not run a block local's initializer, so its dump keeps dq at x: fan-in only.)
  { d: 'j', sig: 'tb_j.dut.dq', t: 20000, kind: 'proc', line: 72, stmt: 'dq <= t2;', fanin: { t2: '*', 'tb_j.dut.b': '00100010' } },
  // A net declaration assignment whose initializer has no source text (a width extension).
  { d: 'j', sig: 'tb_j.dut.wz', t: 20000, kind: 'assign', stmt: 'wz = go', rhs: 'go', value: '00000001', fanin: { 'tb_j.dut.go': '1' }, trust: 'exact' },

  // ---- K: writes that aren't re-executed: a driver that may have written, never a confident "nothing" ----
  // A simulator's own task given vq by name ($cmux_poke(vq, a)): it may write vq.
  { d: 'k', sig: 'tb_k.dut.vq', t: 20000, kind: 'proc', file: 'k_writes.sv', line: 21, stmt: '$cmux_poke(vq, a);', trust: 'approximate', reasons: ['statement'] },
  // A task call whose body writes tq.
  { d: 'k', sig: 'tb_k.dut.tq', t: 20000, kind: 'proc', file: 'k_writes.sv', line: 28, trust: 'approximate', reasons: ['statement'] },
  // fq <= bump(a), and bump's body writes fcnt.
  // ky = a, then if (go) kz = a: the later if doesn't write ky, so go isn't in its fan-in.
  { d: 'k', sig: 'tb_k.dut.ky', t: 30000, kind: 'proc', file: 'k_writes.sv', line: 39, stmt: 'ky = a;', fanin: { 'tb_k.dut.a': '00100010' }, noFanin: ['tb_k.dut.go'] },
  // fr went x at 15 (xa x), then the testbench forced it at 22: the runs at 25 and 35 write 05, so
  // the x in effect is still traced at 15, not moved to the last edge.
  { d: 'k', sig: 'tb_k.dut.fr', t: 40000, kind: 'proc', file: 'k_writes.sv', line: 44, stmt: 'fr <= xa;', act: 15000, since: 15000, value: XX,
    fanin: { 'tb_k.dut.xa': XX } },
  // cnt is written only by its if's condition (cnt++ == 3), in a live procedure.
  { d: 'k', sig: 'tb_k.dut.cnt', t: 20000, kind: 'proc', file: 'k_writes.sv', line: 47, trust: 'approximate', reasons: ['statement'] },
  // gq <= a, but the testbench forced it to 77 at 27; dq's last own write was 11 at 15, then the
  // testbench deposited 44 at 27: the testbench's statement, approximate ('force'), never exact.
  { d: 'k', sig: 'tb_k.dut.gq', t: 30000, kind: 'initial', file: 'tb_k.sv', stmt: 'force dut.gq', since: 27000, value: '01110111', trust: 'approximate', reasons: ['force'] },
  { d: 'k', sig: 'tb_k.dut.dq', t: 30000, kind: 'initial', file: 'tb_k.sv', stmt: '$deposit(dut.dq', since: 27000, value: '01000100', trust: 'approximate', reasons: ['force'] },
  // lq <= c17 through 18 blocking temps: the fan-in stops at 16 of them, with a 'limits' reason.
  { d: 'k', sig: 'tb_k.dut.lq', t: 20000, kind: 'proc', file: 'k_writes.sv', stmt: 'lq <= c17;', trust: 'approximate', reasons: ['limits'] },
  { d: 'k', sig: 'tb_k.dut.fcnt', t: 30000, kind: 'proc', file: 'k_writes.sv', line: 35, stmt: 'fq <= bump(a);', trust: 'approximate', reasons: ['statement'] },
  // ---- L: classes a Verdi oracle run found exact but wrong, as Verdi answers them ----
  // A: a reset declared low and raised by the initial block after clock edges: the write that
  // raised it (approximate, the testbench's), never the declaration; through the port too.
  { d: 'l', sig: 'tb_l.rst_n', t: 40000, kind: 'initial', file: 'tb_l.sv', line: 27, stmt: "rst_n = 1'b1;", since: 26000, value: '1', trust: 'approximate', root: 'testbench' },
  { d: 'l', sig: 'tb_l.dut.rst_n', t: 40000, kind: 'portIn', since: 26000, fanin: { 'tb_l.rst_n': '1' } },
  // Values from the initial block's opening statements (a plusarg, then a copy): their writes.
  { d: 'l', sig: 'tb_l.epoch_iters', t: 40000, kind: 'initial', file: 'tb_l.sv', line: 24, stmt: 'epoch_iters = iters;', trust: 'approximate' },
  { d: 'l', sig: 'tb_l.iters', t: 40000, kind: 'initial', file: 'tb_l.sv', stmt: 'iters = 4;', trust: 'approximate' },
  // A counter incremented in a clocked block of the testbench: that statement.
  { d: 'l', sig: 'tb_l.settle', t: 40000, file: 'tb_l.sv', stmt: 'settle++;', trust: 'approximate' },
  // A, as the oracle's model had it ('stale': no statement lists what it writes, and the initial
  // block is one statement slang could not elaborate). The block may write anything: it is named,
  // approximate; a value nothing explains is never exact, and the declaration did not make a
  // value that changed at 26.
  { d: 'l', sig: 'tb_l.rst_n', t: 40000, dumps: ['stale'], kind: 'initial', file: 'tb_l.sv', line: 18, since: 26000, trust: 'approximate', reasons: ['opaque'] },
  { d: 'l', sig: 'tb_l.epoch_iters', t: 40000, dumps: ['stale'], kind: 'initial', file: 'tb_l.sv', line: 18, trust: 'approximate', reasons: ['opaque'] },
  { d: 'l', sig: 'tb_l.iters', t: 40000, dumps: ['stale'], kind: 'initial', file: 'tb_l.sv', line: 18, trust: 'approximate', reasons: ['opaque'] },
  // The initial block may write settle too: named, approximate. With only the write lists gone
  // ('nowrites': settle++ is opaque and says nothing), nothing found writes it, yet it changed at 35.
  { d: 'l', sig: 'tb_l.settle', t: 40000, dumps: ['stale'], kind: 'initial', line: 18, since: 35000, trust: 'approximate', reasons: ['opaque'] },
  { d: 'l', sig: 'tb_l.settle', t: 40000, dumps: ['nowrites'], kind: 'none', since: 35000, trust: 'approximate', reasons: ['writeNotFound'] },
  { d: 'l', sig: 'tb_l.iters', t: 40000, dumps: ['nowrites'], kind: 'initial', stmt: 'iters = 4;', trust: 'approximate', noReasons: ['writeNotFound'] },
  // B: y unchanged since 35 (the override made it); at 40 and 50 the default gives the same value
  // (sel fell at 45). The statement that made the value, run when it changed, as Verdi names it.
  { d: 'l', sig: 'tb_l.dut.y', t: 50000, kind: 'proc', proc: 'Always', file: 'l_oracle.sv', line: 19, stmt: 'y = b;', since: 35000, sample: 35000, value: '00110011', trust: 'exact' },
  { d: 'l', sig: 'tb_l.dut.y', t: 40000, kind: 'proc', line: 19, stmt: 'y = b;', since: 35000, value: '00110011', trust: 'exact' },
  // c = 0 by the override while in reset (2), then by the default (26): the override, as Verdi
  // names picorv32's clear_prefetched_high_word at t=0. (Both write 1'b0: the line tells them apart.)
  { d: 'l', sig: 'tb_l.dut.c', t: 40000, kind: 'proc', file: 'l_oracle.sv', line: 24, since: 2000, value: '0', trust: 'exact' },
  // A1: a value nothing in the model writes is the start value only as the type starts: x for a
  // 4-state type, 0 for a 2-state one ('hidden': the initial block that wrote mode4 = 0 left out).
  { d: 'l', sig: 'tb_l.mode4', t: 40000, kind: 'initial', stmt: "mode4 = 4'b0;", trust: 'approximate' },
  { d: 'l', sig: 'tb_l.mode4', t: 40000, dumps: ['hidden'], value: '0000', trust: 'approximate', reasons: ['writeNotFound'] },
  { d: 'l', sig: 'tb_l.mode2', t: 40000, dumps: ['hidden'], value: '00000000000000000000000000000000', trust: 'exact', noReasons: ['writeNotFound'] },
  // B1: two writers that both explain the value: which one made it is not known.
  { d: 'l', sig: 'tb_l.dut.y', t: 50000, dumps: ['two'], kind: 'proc', value: '00110011', trust: 'approximate', reasons: ['multiDriven'] },
  // F: a flop that never took a value is its start value (x since 0), not its block.
  { d: 'l', sig: 'tb_l.dut.k', t: 40000, kind: 'none', since: 0, value: 'xxxxxxxx', trust: 'exact' },

];

// The model an older cmux-sv-model gave (the one the Verdi oracle ran on): no statement lists what
// it writes, and an initial block slang could not elaborate is one opaque statement.
// ('nowrites': the write lists only.)
// Load trace (who reads a signal: engine.loads): each case's entries, as
// 'kind/role/line/targets' (targets joined by ','), in the order loads gives them; `page`
// [offset, limit, total, next] checks one page.
const LOAD_CASES = [
  // A flop's output read by a continuous assign and as an always_comb's if condition.
  { d: 'a', sig: 'tb_a.dut.valid_q', want: ['assign/data/23/tb_a.dut.sum', 'stmt/condition/28/tb_a.dut.stage'] },
  // An input read as data (valid_q <= en) and as a condition (if (en) acc <= ...).
  { d: 'a', sig: 'tb_a.dut.en', want: ['stmt/data/18/tb_a.dut.valid_q', 'stmt/condition/21/tb_a.dut.acc'] },
  // A clock: each edge procedure's sensitivity, its writes the targets.
  { d: 'a', sig: 'tb_a.dut.clk', want: ['event/sensitivity/16/tb_a.dut.valid_q', 'event/sensitivity/20/tb_a.dut.acc', 'event/sensitivity/32/tb_a.dut.dout'] },
  { d: 'a', sig: 'tb_a.dut.clk', page: [1, 1, 3, 2], want: ['event/sensitivity/20/tb_a.dut.acc'] },
  { d: 'a', sig: 'tb_a.dut.clk', page: [2, 64, 3, null], want: ['event/sensitivity/32/tb_a.dut.dout'] },
  // The testbench's clock: its own toggle, and the DUT's input port it connects (the next hop down).
  { d: 'a', sig: 'tb_a.clk', want: ['portIn/connection/6/tb_a.dut.clk', 'stmt/data/7/tb_a.clk'] },
  // An output port: the parent's signal connected to it (the next hop up).
  { d: 'a', sig: 'tb_a.dut.dout', want: ['portOut/connection/6/tb_a.dout'] },
  // Read into a block-local temporary (tmp = sum + 1).
  { d: 'a', sig: 'tb_a.dut.sum', want: ['stmt/data/27/$local:tmp'] },
  // Read by nothing.
  { d: 'a', sig: 'tb_a.dout', want: [] },
];

// Active loads at a time (engine.loadsAt): each entry as 'line/role/status' in loads' order;
// `follow` { line: [path, time] }: where following that entry goes (the change it caused);
// `trust` { line: trust }. The reader's last activation at or before t is judged (the dump is
// searched backward, as driver tracing does): a flop whose input changed after its last edge is
// 'pending'.
const LOAD_AT_CASES = [
  // valid_q went 0 -> 1 at 45: sum = acc ^ {8{valid_q}} stays x (no change); the always_comb's
  // if (valid_q) takes its then branch.
  { d: 'a', sig: 'tb_a.dut.valid_q', t: 50, want: ['23/data/noChange', '28/condition/taken'] },
  { d: 'a', sig: 'tb_a.dut.valid_q', t: 30, want: ['23/data/noChange', '28/condition/untaken'] },
  // en rose at 40, sampled at the edge at 45: valid_q <= en made valid_q's change at 45.
  { d: 'a', sig: 'tb_a.dut.en', t: 50, want: ['18/data/propagated', '21/condition/taken'], follow: { 18: ['tb_a.dut.valid_q', 45] }, trust: { 18: 'exact' } },
  // At 42 the last edge (35) came before en's change: not sampled yet.
  { d: 'a', sig: 'tb_a.dut.en', t: 42, want: ['18/data/pending', '21/condition/pending'] },
  // The clock's posedge at 45 triggered each edge procedure; its negedge at 50 none.
  { d: 'a', sig: 'tb_a.dut.clk', t: 45, want: ['16/sensitivity/triggered', '20/sensitivity/triggered', '32/sensitivity/triggered'] },
  { d: 'a', sig: 'tb_a.dut.clk', t: 50, want: ['16/sensitivity/notTriggered', '20/sensitivity/notTriggered', '32/sensitivity/notTriggered'] },
  // din: read into acc at 45 (acc stays x), and stage = din is on the else branch, not run at 50.
  { d: 'a', sig: 'tb_a.dut.din', t: 50, want: ['21/data/noChange', '29/data/notRun'] },
  // The testbench clock: the DUT's clk port follows it at 50; its own toggle is stimulus.
  { d: 'a', sig: 'tb_a.clk', t: 50, want: ['6/connection/propagated', '7/data/stimulus'], follow: { 6: ['tb_a.dut.clk', 50] } },
  // An output port: the parent's dout changed with it at 25.
  { d: 'a', sig: 'tb_a.dut.dout', t: 30, want: ['6/connection/propagated'], follow: { 6: ['tb_a.dout', 25] } },
  // Into a block-local temporary (not dumped): read, nothing to follow.
  { d: 'a', sig: 'tb_a.dut.sum', t: 50, want: ['27/data/read'] },
];

// Follow forward: an entry's target's first change at or after t (engine.nextOf), on a provider
// with nextChange; without one, null (the page falls back to the change the read caused).
// line: the load entry; want: [path, time] | null (no later change); back: the provider has no nextChange.
const NEXT_CASES = [
  // en rose at 40; at 42 its read is pending: valid_q takes it at the edge at 45.
  { d: 'a', sig: 'tb_a.dut.en', t: 42, line: 18, want: ['tb_a.dut.valid_q', 45] },
  // At a change itself: at or after, so the same time.
  { d: 'a', sig: 'tb_a.clk', t: 50, line: 6, want: ['tb_a.dut.clk', 50] },
  // No nextChange in the provider: no forward answer.
  { d: 'a', sig: 'tb_a.dut.en', t: 42, line: 18, back: true, want: null },
  // Into a block-local temporary: nothing dumped to follow.
  { d: 'a', sig: 'tb_a.dut.sum', t: 50, line: 27, want: null },
];

// The load list against Verdi's (TRACE_ORACLE_DIR/<design>.json, not in this repository; the check SKIPs without it: npi-loads.py's lang.trace_load2 on
// each design's VCS KDB, is_pass_thr off = `stop`, on = `through`). A load is keyed by file:line,
// a port connection by the signals it reaches (Verdi places it at the child's port declaration, we
// at the instance). Verdi's "load in an upper statement" entries (statements under a condition or
// event that reads the signal) are ours as that condition or event entry. `through` is compared
// with ours followed through each port connection. The differences left, each with its reason:
// An interface's signal: Verdi lists each modport that takes it as an input (keyed by the
// modport port, iface.modport.name); ours list those too, plus the reads through the interface
// port in each instance it reaches (INTERFACE_READS), which Verdi does not list: counted, not listed.
// verdiOnly (and upper: an upper statement with no condition or event of ours reading the signal
//   whose procedure encloses it)
//   dumpTask: $dumpvars naming the signal (a dump directive, not a design read);
//   sysFunctionOutput: $value$plusargs's output argument (it writes the signal), and the statement
//     under that condition (upper);
// oursOnly
//   assignmentPattern: a read inside an assignment pattern ('{a: x, ...}), which Verdi does not list;
//   localInitializer: a procedural block local's declaration initializer, which Verdi does not list;
//   lvalueIndex: an index read in a two-level target select in a loop (mem[widx][8*b +: 8] <=),
//     which Verdi does not list (it does list mem[waddr] <=);
//   increment: x++ reads x; Verdi does not list it.
// Statements slang leaves opaque (loops, calls) are listed when their text names the signal
// (role 'opaque', maybe): Verdi's loads inside for and repeat loops match them.
const INTERFACE_READS = {
  'tb_n.bus.data': ['tb_n.u_prod:20', 'tb_n.u_mid.u_leaf:28', 'tb_n.u_mon:36'],
  'tb_n.bus.valid': ['tb_n:10', 'tb_n.u_mid.u_leaf:28', 'tb_n.u_mon:36'],
  'tb_n.bus.clk': ['tb_n.u_prod:15', 'tb_n.u_mid.u_leaf:27'],
  'tb_n.bus.ready': ['tb_n.u_prod:19'],
  'tb_f.bus.addr': ['tb_f.u_mem:23'],
  'tb_f.bus.req': ['tb_f.u_mem:23', 'tb_f.u_mem:28'],
  'tb_f.bus.clk': ['tb_f.u_mem:26', 'tb_f.dut:33'],
  'tb_f.bus.resp': ['tb_f.dut:39'],
  'tb_f.bus.rdata': ['tb_f.dut:39'],
};
const LOAD_ORACLE_DIFFS = [
  'verdiOnly h tb_h.dut.mem tb_h.sv:17 dumpTask',
  'verdiOnly i tb_i.dut.lost tb_i.sv:25 dumpTask',
  'verdiOnly i tb_i.dut.mem tb_i.sv:26 dumpTask',
  'verdiOnly i tb_i.iters tb_i.sv:16 sysFunctionOutput',
  'verdiOnly l tb_l.iters tb_l.sv:23 sysFunctionOutput',
  'upper i tb_i.iters tb_i.sv:16 sysFunctionOutput',
  'upper l tb_l.iters tb_l.sv:23 sysFunctionOutput',
  'oursOnly c tb_c.dut.u_src.data_q c_struct.sv:37 assignmentPattern',
  'oursOnly c tb_c.dut.u_src.id_q c_struct.sv:37 assignmentPattern',
  'oursOnly c tb_c.dut.u_src.valid_q c_struct.sv:37 assignmentPattern',
  'oursOnly j tb_j.dut.b j_temps.sv:71 localInitializer',
  'oursOnly i tb_i.dut.widx i_drivers.sv:30 lvalueIndex',
  'oursOnly i tb_i.settle tb_i.sv:14 increment',
  'oursOnly l tb_l.settle tb_l.sv:34 increment',
];

function staleModel(all, invalidInitial) {
  const strip = (x) => {
    if (Array.isArray(x)) { x.forEach(strip); return; }
    if (!x || typeof x !== 'object') { return; }
    delete x.writes;
    Object.values(x).forEach(strip);
  };
  for (const m of Object.values(all.instances)) {
    strip(m.procs);
    for (const p of m.procs) { if (invalidInitial && p.kind === 'Initial') { p.body = { k: 'opaque', why: 'Invalid', src: p.body.src || '', loc: p.loc }; } }
  }
}

function runTraceChecks() {
  const out = [];
  const designText = traceFiles.designs;
  const results = { cases: 0, failures: 0, oracle: {} };
  const engines = {};
  const lineOf = (file, snippet) => {
    const lines = (designText[file] || '').split('\n');
    const i = lines.findIndex((l) => l.includes(snippet));
    return i < 0 ? null : i + 1;
  };
  const base = (f) => (f ? String(f).split('/').pop() : f);

  // (options: a fresh engine with those engine options, not shared)
  function engineFor(d, variant, options) {
    const key = d + '.' + variant;
    if (engines[key] && !options) { return engines[key]; }
    const modelName = d === 'c' && variant === 'icarus' ? 'c.icarus' : d;
    const all = JSON.parse(traceFiles.models[modelName]);
    // 'stale': the Icarus dump with the model an older sidecar gave for that testbench.
    if (variant === 'stale' || variant === 'nowrites') { staleModel(all, variant === 'stale'); }
    // 'hidden': the testbench's initial blocks left out of the model (a write the model doesn't show).
    if (variant === 'hidden') { for (const m of Object.values(all.instances)) { m.procs = m.procs.filter((p) => p.kind !== 'Initial'); } }
    // 'two': the DUT's first always @* listed twice (two writers that both explain the value).
    if (variant === 'two') { const m = all.instances['tb_l.dut']; m.procs.splice(1, 0, JSON.parse(JSON.stringify(m.procs[0]))); }
    // 'nolife': the plain dump with a model from an older sidecar (no lifetime on declarations).
    if (variant === 'nolife') {
      const strip = (x) => { if (Array.isArray(x)) { x.forEach(strip); return; } if (!x || typeof x !== 'object') { return; } delete x.lifetime; Object.values(x).forEach(strip); };
      for (const m of Object.values(all.instances)) { strip(m.procs); }
    }
    // 'macro': the plain dump with a model whose loop text names its local through a macro (the
    // sidecar writes expanded text today; another front end may not).
    if (variant === 'macro') {
      const fix = (x) => { if (Array.isArray(x)) { x.forEach(fix); return; } if (!x || typeof x !== 'object') { return; } if (x.k === 'opaque' && /t5 = d/.test(String(x.src))) { x.src = 'for (int i = 0; i < 1; i++) `SET5;'; } Object.values(x).forEach(fix); };
      for (const m of Object.values(all.instances)) { fix(m.procs); }
    }
    const onIcarus = ['stale', 'nowrites', 'hidden', 'two'].includes(variant);
    const vcd = traceVcd(traceFiles.dumps[`${d}.${onIcarus ? 'icarus' : variant === 'macro' || variant === 'nolife' ? 'plain' : variant}`]);
    const models = {
      instance: async (p) => all.instances[p],
      // What cmux-sv-model's `writers` answers: the instances that write into `p` from outside it.
      writers: async (p) => Object.keys(all.instances).filter((k) => k !== p && JSON.stringify(all.instances[k]).includes('"name":"$abs:' + p + '.')),
      lookup: async (p) => {
        let best = null;
        for (const k of Object.keys(all.instances)) { if ((p === k || p.startsWith(k + '.')) && (!best || k.length > best.length)) { best = k; } }
        return best ? { instance: best, name: p.slice(best.length + 1) } : null;
      },
    };
    const engine = cmuxTrace.createEngine(options ? { models, dump: vcd.provider, options } : { models, dump: vcd.provider });
    if (options) { return { engine, vcd, all }; }
    engines[key] = { engine, vcd, all };
    return engines[key];
  }

  function check(c, variant, step) {
    const bad = [];
    const want = (what, got, exp) => { if (got !== exp) { bad.push(`${what}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`); } };
    if (step.error) { bad.push('error ' + step.error); return bad; }
    const kind = step.driver && step.driver.kind;
    if (c.kind) { want('kind', kind, c.kind); }
    if (c.writer) { want('writer', step.driver && step.driver.writer, c.writer); }
    if (c.from) { want('from', step.driver && step.driver.from, c.from); }
    if (c.proc) { want('proc', step.procKind || (step.driver && step.driver.procKind), c.proc); }
    if (c.file) { want('file', base(step.stmt && step.stmt.loc && step.stmt.loc.file), c.file); }
    if (c.line) { want('line', step.stmt && step.stmt.loc && step.stmt.loc.line, c.line); }
    const squeeze = (x) => String(x).replace(/\s+/g, ' ');
    if (c.rhs && !(step.stmt && squeeze(step.stmt.rhs || '') === squeeze(c.rhs))) { bad.push(`rhs: ${JSON.stringify(step.stmt && step.stmt.rhs)} != ${JSON.stringify(c.rhs)}`); }
    if (c.stmt) { if (!(step.stmt && squeeze(step.stmt.src).includes(squeeze(c.stmt)))) { bad.push(`stmt: ${JSON.stringify(step.stmt && step.stmt.src)} lacks ${JSON.stringify(c.stmt)}`); } }
    if (c.act !== undefined) { want('activation', step.activation && step.activation.time, c.act); }
    if (c.sample !== undefined) { want('sample', step.sample, c.sample); }
    if (c.since !== undefined) { want('since', step.since, c.since); }
    if (c.value !== undefined) { want('value', step.value, c.value); }
    if (c.trust) { want('trust', step.trust, c.trust); }
    if (c.noTrust && step.trust === c.noTrust) { bad.push(`trust is ${step.trust}, which it must not be`); }
    if (c.root) { want('root', step.root, c.root); }
    for (const [k, v] of Object.entries(c.fanin || {})) {
      const f = (step.fanin || []).find((x) => x.path === k || (x.local && x.name === k));
      if (!f) { bad.push(`fan-in lacks ${k} (has ${(step.fanin || []).map((x) => x.path || x.name).join(', ')})`); } else if (v !== '*' && f.value !== v) { bad.push(`fan-in ${k} = ${f.value} != ${v}`); }
    }
    for (const k of c.noFanin || []) {
      if ((step.fanin || []).some((x) => x.path === k || (x.local && x.name === k))) { bad.push(`fan-in has ${k}, which isn't why it has its value`); }
    }
    for (const [k, v] of Object.entries(c.roles || {})) {
      const f = (step.fanin || []).find((x) => (x.path === k || (x.local && x.name === k)) && x.role === v);
      if (!f) { bad.push(`fan-in lacks ${k} as ${v} (roles ${(step.fanin || []).filter((x) => x.path === k || x.name === k).map((x) => x.role).join(', ') || 'none'})`); }
    }
    for (const k of c.xIndex || []) {
      if (!(step.fanin || []).some((x) => x.xIndex && (x.name === k || x.path === k))) { bad.push(`fan-in lacks an x-index read of ${k}`); }
    }
    (c.dec || []).forEach(([src, taken], i) => {
      const d = (step.decisions || [])[i];
      if (!d) { bad.push(`no decision ${i}`); return; }
      if (!String(d.src).includes(src)) { bad.push(`decision ${i} src ${d.src} lacks ${src}`); }
      if (d.taken !== taken) { bad.push(`decision ${i} taken ${JSON.stringify(d.taken)} != ${JSON.stringify(taken)}`); }
    });
    (c.viol || []).forEach((v, i) => { const d = (step.decisions || [])[i]; want(`decision ${i} violation`, d ? (d.violation || null) : 'no decision', v); });
    if (c.dec && (step.decisions || []).length !== c.dec.length) { bad.push(`decisions: ${(step.decisions || []).length} != ${c.dec.length}`); }
    const codes = (step.reasons || []).map((r) => r.code);
    for (const r of c.reasons || []) { if (!codes.includes(r)) { bad.push(`reasons lack ${r} (have ${codes.join(',')})`); } }
    for (const r of c.noReasons || []) { if (codes.includes(r)) { bad.push(`reasons have ${r}`); } }
    // The line a case names is the statement's own line in its file.
    if (c.line && c.stmt && step.stmt && step.stmt.loc) {
      const l = lineOf(base(step.stmt.loc.file), c.stmt.trim());
      if (l !== null && l !== c.line) { bad.push(`case says line ${c.line}, the file has it at ${l}`); }
    }
    return bad;
  }

  async function run() {
    for (const c of TRACE_CASES) {
      for (const variant of c.dumps || TRACE_DUMPS[c.d]) {
        results.cases++;
        let step;
        try {
          step = await engineFor(c.d, variant).engine.active(c.sig, c.t);
        } catch (error) {
          step = { error: String(error && error.stack || error) };
        }
        const bad = check(c, variant, step);
        if (bad.length) {
          results.failures++;
          out.push(`FAIL ${c.d}.${variant} ${c.sig} @${c.t}: ${bad.join('; ')}`);
        } else {
          out.push(`ok   ${c.d}.${variant} ${c.sig} @${c.t}: ${step.driver.kind} ${step.stmt ? step.stmt.src : ''} [${step.trust}]`);
        }
      }
    }
    // The driver highlight's lines (assigningLines): a for loop the model keeps whole (opaque ForLoop) that writes the
    // signal is one of its writes (its range), so the write inside the loop is never left unmarked (CVA6 alu_valid_n).
    {
      results.cases++;
      const what = 'assigningLines i tb_i.dut.lost[2] (two opaque for loops)';
      let got;
      try {
        const ls = await engineFor('i', 'icarus').engine.assigningLines('tb_i.dut.lost[2]');
        got = ls.flatMap((d) => (d.writes || []).map((w) => [w.loc.line, w.loc.endLine || w.loc.line]));
      } catch (error) { got = String(error && error.stack || error); }
      const want = [[26, 26], [27, 27]];
      if (JSON.stringify(got) !== JSON.stringify(want)) { results.failures++; out.push(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
      else { out.push(`ok   ${what}`); }
    }
    // Load trace: the static readers of a signal.
    for (const c of LOAD_CASES) {
      results.cases++;
      const what = `loads ${c.d} ${c.sig}${c.page ? ' page ' + JSON.stringify(c.page) : ''}`;
      let got;
      try {
        const opts = c.page ? { offset: c.page[0], limit: c.page[1] } : {};
        got = await engineFor(c.d, 'icarus').engine.loads(c.sig, opts);
      } catch (error) {
        got = { error: String(error && error.message || error) };
      }
      const bad = [];
      if (got.error) {
        bad.push('error ' + got.error);
      } else {
        const lines = got.entries.map((e) => `${e.kind}/${e.role}/${e.loc ? e.loc.line : '?'}/${(e.targets || []).join(',')}`);
        if (JSON.stringify(lines) !== JSON.stringify(c.want)) { bad.push(`entries ${JSON.stringify(lines)} != ${JSON.stringify(c.want)}`); }
        if (c.page && (got.total !== c.page[2] || got.next !== c.page[3])) { bad.push(`total/next ${got.total}/${got.next} != ${c.page[2]}/${c.page[3]}`); }
        for (const e of got.entries) {
          if (!e.loc || !e.loc.file || !e.src) { bad.push(`entry without loc or src: ${JSON.stringify(e)}`); }
        }
      }
      if (bad.length) { results.failures++; out.push(`FAIL ${what}: ${bad.join('; ')}`); } else { out.push(`ok   ${what}: ${got.entries.length} of ${got.total}`); }
    }
    for (const c of LOAD_AT_CASES) {
      results.cases++;
      const what = `loadsAt ${c.d} ${c.sig} @${c.t}`;
      let got;
      try {
        got = await engineFor(c.d, 'icarus').engine.loadsAt(c.sig, c.t);
      } catch (error) {
        got = { error: String(error && error.message || error) };
      }
      const bad = [];
      if (got.error) {
        bad.push('error ' + got.error);
      } else {
        const lines = got.entries.map((e) => `${e.loc ? e.loc.line : '?'}/${e.role}/${e.active ? e.active.status : '-'}`);
        if (JSON.stringify(lines) !== JSON.stringify(c.want)) { bad.push(`entries ${JSON.stringify(lines)} != ${JSON.stringify(c.want)}`); }
        for (const [line, [path, time]] of Object.entries(c.follow || {})) {
          const e = got.entries.find((x) => x.loc && x.loc.line === Number(line));
          const f = e && e.active && e.active.follow;
          if (!f || f.path !== path || f.time !== time) { bad.push(`follow ${line}: ${JSON.stringify(f)} != ${path}@${time}`); }
        }
        for (const [line, trust] of Object.entries(c.trust || {})) {
          const e = got.entries.find((x) => x.loc && x.loc.line === Number(line));
          if (!e || !e.active || e.active.trust !== trust) { bad.push(`trust ${line}: ${e && e.active && e.active.trust} != ${trust}`); }
        }
      }
      if (bad.length) { results.failures++; out.push(`FAIL ${what}: ${bad.join('; ')}`); } else { out.push(`ok   ${what}`); }
    }
    // The load lists against Verdi's (LOAD_ORACLE_DIFFS).
    {
      const oracle = traceFiles.loadOracle || {};
      const seen = [];
      const counts = { match: 0, upper: 0, through: 0, throughMatch: 0 };
      const keyOurs = (e) => (e.kind === 'portIn' || e.kind === 'portOut' || e.kind === 'modport' ? 'port:' + (e.targets || []).slice().sort().join(',') : base(e.loc && e.loc.file) + ':' + (e.loc && e.loc.line));
      const keyVerdi = (x) => (/Port$/.test(x.type || '') ? 'port:' + x.targets.slice().sort().join(',') : x.file + ':' + x.line);
      // (the model VCS compiled, without __ICARUS__: loads read no dump)
      const oracleEngines = {};
      const oracleEngine = (d) => {
        if (oracleEngines[d]) { return oracleEngines[d]; }
        const all = JSON.parse(traceFiles.models[d]);
        const models = {
          instance: async (p) => all.instances[p],
          writers: async () => [],
          lookup: async (p) => {
            let best = null;
            for (const k of Object.keys(all.instances)) { if ((p === k || p.startsWith(k + '.')) && (!best || k.length > best.length)) { best = k; } }
            return best ? { instance: best, name: p.slice(best.length + 1) } : null;
          },
        };
        const none = { values: async () => new Map(), lastChange: async () => null, prevEdge: async () => null };
        oracleEngines[d] = cmuxTrace.createEngine({ models, dump: none });
        return oracleEngines[d];
      };
      const oursOf = async (d, sig) => ((await oracleEngine(d).loads(sig, { limit: 100000 })).entries || []);
      for (const d of Object.keys(oracle).sort()) {
        const signals = JSON.parse(oracle[d]).signals;
        for (const sig of Object.keys(signals).sort()) {
          results.cases++;
          const o = signals[sig];
          let ours;
          try { ours = await oursOf(d, sig); } catch (error) { results.failures++; out.push(`FAIL load oracle ${d} ${sig}: ${error && error.message || error}`); continue; }
          const ok = new Set(ours.map(keyOurs));
          const direct = o.stop.filter((x) => !x.upper);
          const vk = new Set(direct.map(keyVerdi));
          for (const x of direct) { if (ok.has(keyVerdi(x))) { counts.match++; } else { seen.push(`verdiOnly ${d} ${sig} ${keyVerdi(x)}`); } }
          // Reads through an interface port, in another instance than the interface's own.
          const via = ours.filter((y) => y.via === 'interface');
          const want = INTERFACE_READS[sig];
          const got = [...new Set(via.map((y) => y.instance + ':' + (y.loc && y.loc.line)))].sort();
          if (want && JSON.stringify(got) !== JSON.stringify(want.slice().sort())) { seen.push(`interfaceReads ${d} ${sig} ${JSON.stringify(got)}!=${JSON.stringify(want)}`); }
          if (!want && via.length) { seen.push(`interfaceReads ${d} ${sig} unexpected ${JSON.stringify(got)}`); }
          counts.interfaceRead = (counts.interfaceRead || 0) + via.length;
          for (const y of ours) { if (y.via !== 'interface' && !vk.has(keyOurs(y))) { seen.push(`oursOnly ${d} ${sig} ${keyOurs(y)}`); } }
          // An upper statement (one whose enclosing control reads the signal): a condition, event or
          // opaque statement of ours reading it, in the same file, whose procedure (or own range, outside
          // one) encloses the statement's line.
          const encloses = (y, x) => {
            const r = y.procLoc || y.loc;
            return !!r && base(r.file) === x.file && r.line <= x.line && x.line <= (r.endLine || r.line);
          };
          const ctl = ours.filter((y) => y.role === 'condition' || y.role === 'sensitivity' || y.role === 'opaque');
          for (const x of o.stop.filter((z) => z.upper)) { counts.upper++; if (!ctl.some((y) => encloses(y, x))) { seen.push(`upper ${d} ${sig} ${keyVerdi(x)}`); } }
          // Through ports: ours followed through each port connection, transitively.
          const closure = new Set();
          const todo = [sig];
          const done = new Set();
          while (todo.length) {
            const s0 = todo.pop();
            if (done.has(s0)) { continue; }
            done.add(s0);
            let es = [];
            try { es = await oursOf(d, s0); } catch (error) { es = []; }
            for (const e of es) {
              closure.add(keyOurs(e));
              if (e.kind === 'portIn' || e.kind === 'portOut') { (e.targets || []).forEach((t) => todo.push(t)); }
            }
          }
          for (const x of o.through.filter((z) => !z.upper)) {
            counts.through++;
            if (closure.has(keyVerdi(x))) { counts.throughMatch++; } else { seen.push(`through ${d} ${sig} ${keyVerdi(x)}`); }
          }
        }
      }
      // A through-only difference is fine when it is one of the stop differences (of a signal the ports reach).
      const stopKeys = new Set(LOAD_ORACLE_DIFFS.map((l) => l.split(' ')[3]));
      const left = seen.filter((l) => !(l.startsWith('through ') && stopKeys.has(l.split(' ')[3])));
      const expected = LOAD_ORACLE_DIFFS.map((l) => l.split(' ').slice(0, 4).join(' '));
      const extra = left.filter((l) => !expected.includes(l));
      const gone = expected.filter((l) => !left.includes(l));
      if (Object.keys(oracle).length === 0) { out.push('SKIP load oracle: no oracle files (TRACE_ORACLE_DIR: <design>.json load lists from your own Verdi)'); }
      else if (results.cases++, false) { /* counted */ }
      else if (extra.length || gone.length) { results.failures++; out.push(`FAIL load oracle: ${counts.match} match, ${extra.length} unexplained: ${extra.join('; ')}${gone.length ? '; listed but not seen: ' + gone.join('; ') : ''}`); }
      else { out.push(`ok   load oracle: ${counts.match} match, ${counts.upper} upper, through ${counts.throughMatch}/${counts.through}, ${counts.interfaceRead} interface reads, ${expected.length} listed differences`); }
    }
    // The interface walk follows the interface's connections, not everything under its parent: 600
    // unrelated children of tb_n, ahead of the others, leave its reads listed and the walk uncapped.
    {
      results.cases++;
      const bad = [];
      try {
        const all = JSON.parse(traceFiles.models.n);
        const tb = all.instances.tb_n;
        const fillers = [];
        for (let i = 0; i < 600; i++) {
          const path = `tb_n.u_fill${i}`;
          all.instances[path] = { version: 1, path, module: 'n_fill', parent: 'tb_n', loc: tb.loc, ports: [], params: {}, signals: {}, assigns: [], procs: [], children: [], files: tb.files };
          fillers.push({ path, name: `u_fill${i}`, module: 'n_fill', loc: tb.loc, ports: [] });
        }
        tb.children = fillers.concat(tb.children);
        const models = {
          instance: async (p) => all.instances[p],
          writers: async () => [],
          lookup: async (p) => {
            let best = null;
            for (const k of Object.keys(all.instances)) { if ((p === k || p.startsWith(k + '.')) && (!best || k.length > best.length)) { best = k; } }
            return best ? { instance: best, name: p.slice(best.length + 1) } : null;
          },
        };
        const none = { values: async () => new Map(), lastChange: async () => null, prevEdge: async () => null };
        const got = await cmuxTrace.createEngine({ models, dump: none }).loads('tb_n.bus.data', { limit: 512 });
        const via = [...new Set((got.entries || []).filter((e) => e.via === 'interface').map((e) => e.instance + ':' + (e.loc && e.loc.line)))].sort();
        const want = INTERFACE_READS['tb_n.bus.data'].slice().sort();
        if (JSON.stringify(via) !== JSON.stringify(want)) { bad.push(`interface reads ${JSON.stringify(via)} != ${JSON.stringify(want)}`); }
        const walk = got.limits && got.limits.interfaceWalk;
        if (!walk || walk.capped) { bad.push(`interfaceWalk ${JSON.stringify(walk)}, not uncapped`); }
      } catch (error) { bad.push('error ' + String(error && error.message || error)); }
      if (bad.length) { results.failures++; out.push(`FAIL loads n tb_n.bus.data beside 600 unrelated instances: ${bad.join('; ')}`); } else { out.push('ok   loads n tb_n.bus.data beside 600 unrelated instances: the interface reads listed, the walk not capped'); }
    }
    // An opaque statement's text: `x <=` is an assignment only where a statement starts; inside a
    // condition it is a comparison, a read (`if (pick <= 2'(t))` lists pick).
    {
      results.cases++;
      const bad = [];
      try {
        const loc = [0, 3, 3, 3, 60];
        const sig = (w) => ({ width: w, kind: 'var', msb: w - 1, lsb: 0, loc });
        const opaque = (src) => ({ k: 'opaque', why: 'ForLoop', src, loc });
        const inst = { version: 1, path: 'tb_o', module: 'tb_o', loc, ports: [], params: {}, signals: { pick: sig(2), pop: sig(4), valid: sig(4), q: sig(1), d: sig(1), c: sig(1), sel: sig(2), y: sig(1), wz: sig(1), wc: sig(1), wb: sig(1) },
          assigns: [], children: [], files: ['o.sv'],
          procs: [
            { id: 0, kind: 'AlwaysComb', events: [], body: opaque("for (int t = 0; t < 4; t++) if (pick <= 2'(t)) pop[t] = valid[t];"), loc },
            { id: 1, kind: 'AlwaysFF', events: [], body: opaque('for (int t = 0; t < 4; t++) begin q <= d; if (c) q <= 1\'b0; end'), loc },
            // (a ternary's `:` starts no statement: sel <= 2'(t) there is a comparison)
            { id: 2, kind: 'AlwaysComb', events: [], body: opaque("for (int t = 0; t < 4; t++) y = valid[t] ? 1'b0 : sel <= 2'(t);"), loc },
            // (a `?` in a casez wildcard or a parenthesised case expression is no ternary; a named
            // block's `begin : name` starts a statement: wz, wc and wb are only assigned)
            { id: 3, kind: 'AlwaysFF', events: [], body: opaque("for (int t = 0; t < 4; t++) casez (t) 2'b1?: wz <= 1'b1; default: wz <= 1'b0; endcase"), loc },
            { id: 4, kind: 'AlwaysFF', events: [], body: opaque("for (int t = 0; t < 4; t++) case (valid[t] ? t : 0) 0: wc <= 1'b1; endcase"), loc },
            { id: 5, kind: 'AlwaysFF', events: [], body: opaque("for (int t = 0; t < 4; t++) begin : blk wb <= 1'b1; end"), loc },
          ] };
        const all = { instances: { tb_o: inst } };
        const models = { instance: async (p) => all.instances[p], writers: async () => [], lookup: async (p) => (p.startsWith('tb_o.') ? { instance: 'tb_o', name: p.slice(5) } : null) };
        const none = { values: async () => new Map(), lastChange: async () => null, prevEdge: async () => null };
        const eng = cmuxTrace.createEngine({ models, dump: none });
        const count = async (s) => ((await eng.loads(s)).entries || []).length;
        const got = { pick: await count('tb_o.pick'), q: await count('tb_o.q'), d: await count('tb_o.d'), c: await count('tb_o.c'), pop: await count('tb_o.pop'), sel: await count('tb_o.sel'), y: await count('tb_o.y'), wz: await count('tb_o.wz'), wc: await count('tb_o.wc'), wb: await count('tb_o.wb') };
        const want = { pick: 1, q: 0, d: 1, c: 1, pop: 0, sel: 1, y: 0, wz: 0, wc: 0, wb: 0 };
        if (JSON.stringify(got) !== JSON.stringify(want)) { bad.push(`opaque reads ${JSON.stringify(got)} != ${JSON.stringify(want)}`); }
      } catch (error) { bad.push('error ' + String(error && error.message || error)); }
      if (bad.length) { results.failures++; out.push(`FAIL loads in opaque text, <= as a comparison: ${bad.join('; ')}`); } else { out.push('ok   loads in opaque text: <= inside a condition is a read, at a statement start an assignment'); }
    }
    for (const c of NEXT_CASES) {
      results.cases++;
      const what = `nextOf ${c.d} ${c.sig} @${c.t} :${c.line}${c.back ? ' (no nextChange)' : ''}`;
      const bad = [];
      try {
        const eng = engineFor(c.d, 'icarus');
        const saved = eng.vcd.provider.nextChange;
        if (c.back) { delete eng.vcd.provider.nextChange; }
        try {
          const got = await eng.engine.loadsAt(c.sig, c.t);
          const e = got.entries.find((x) => x.loc && x.loc.line === c.line);
          if (!e) { bad.push('no entry at line ' + c.line); } else {
            const n = await eng.engine.nextOf(e, c.t);
            const g = n && n.time !== null ? [n.path, n.time] : null;
            if (JSON.stringify(g) !== JSON.stringify(c.want)) { bad.push(`next ${JSON.stringify(n)} != ${JSON.stringify(c.want)}`); }
            if (n && n.direction !== 'forward') { bad.push('direction ' + n.direction); }
          }
        } finally { eng.vcd.provider.nextChange = saved; }
      } catch (error) { bad.push('error ' + String(error && error.message || error)); }
      if (bad.length) { results.failures++; out.push(`FAIL ${what}: ${bad.join('; ')}`); } else { out.push(`ok   ${what}`); }
    }
    // changeCount consistency: the engine skips an input's cut when changeCount over (since, t]
    // is 0 and stops at its cap, so a provider's count must equal the changes lastChange walks back
    // over in that window (an undercount would drop a cut silently). Every signal of every fixture
    // dump, windows (0, end], (c, end] and (c - 1, c] for each change c. The checker itself must
    // catch an undercounting provider (a count one short wherever it is above 0).
    {
      const stepsBack = async (dump, p, since, t) => {
        let n = 0, at = await dump.lastChange(p, t);
        while (at !== null && at !== undefined && at > since) { n++; if (n > 100000) { return -1; } at = at > 0 ? await dump.lastChange(p, at - 1) : null; }
        return n;
      };
      const consistency = async (dump, sigs) => {
        const bad = [];
        let windows = 0;
        for (const [p, s] of sigs) {
          const times = s.changes.map((c) => c[0]);
          if (!times.length) { continue; }
          const end = times[times.length - 1];
          const ws = [[0, end]];
          for (const c of times) { ws.push([c, end]); if (c > 0) { ws.push([c - 1, c]); } }
          for (const [from, to] of ws) {
            if (!(to > from)) { continue; }
            windows++;
            const k = await dump.changeCount(p, from, to), n = await stepsBack(dump, p, from, to);
            if (k !== n && bad.length < 4) { bad.push(`${p} (${from}, ${to}]: changeCount ${k}, lastChange steps ${n}`); }
          }
        }
        return { bad, windows };
      };
      let total = 0;
      const where = [];
      for (const d of Object.keys(TRACE_DUMPS)) {
        for (const variant of TRACE_DUMPS[d]) {
          const { vcd } = engineFor(d, variant);
          const r = await consistency(vcd.provider, vcd.sig);
          total += r.windows;
          if (r.bad.length) { where.push(`${d}.${variant}: ${r.bad.join('; ')}`); }
        }
      }
      const what = `changeCount over (since, t] equals the lastChange steps back on every fixture dump (VCD provider, ${total} windows)`;
      if (where.length) { results.failures++; out.push(`FAIL ${what}: ${where.slice(0, 4).join(' | ')}`); } else { out.push(`ok   ${what}`); }
      results.cases++;
      const { vcd } = engineFor('p', TRACE_DUMPS.p[0]);
      const under = Object.assign({}, vcd.provider, { changeCount: async (p, from, to) => { const k = await vcd.provider.changeCount(p, from, to); return k > 0 ? k - 1 : k; } });
      const caught = (await consistency(under, vcd.sig)).bad.length > 0;
      const what2 = 'changeCount consistency: an undercounting provider (one short) is caught';
      if (!caught) { results.failures++; out.push(`FAIL ${what2}`); } else { out.push(`ok   ${what2}`); }
      results.cases++;
    }
    // The replay oracle: every change of every design signal at its change time.
    for (const d of Object.keys(TRACE_DUMPS)) {
      for (const variant of TRACE_DUMPS[d]) {
        const { engine, vcd, all } = engineFor(d, variant);
        const tally = { steps: 0, exact: 0, computed: 0, approximate: 0, inconsistent: 0, unexplained: 0 };
        for (const [inst, m] of Object.entries(all.instances)) {
          for (const name of Object.keys(m.signals)) {
            const p = inst + '.' + name;
            const s = vcd.sig.get(p);
            if (!s) { continue; }
            for (const [t] of s.changes) {
              const step = await engine.active(p, t);
              tally.steps++;
              // Held since 0 at the value it started with (x, or 0 for a 2-state type), with no write
              // missing: nothing drove it yet, which is no missing driver.
              const held = Number(step.since) === 0 && !(step.reasons || []).some((r) => r.code === 'writeNotFound');
              if (step.driver && step.driver.kind === 'none' && held) { tally.startValue = (tally.startValue || 0) + 1; }
              if (step.driver && step.driver.kind === 'none' && !held) { tally.noDriver = (tally.noDriver || 0) + 1; if (tally.noDriver <= 3) { out.push(`ORACLE ${d}.${variant} ${p} @${t}: no driver`); } }
              tally[step.trust] = (tally[step.trust] || 0) + 1;
              // Inconsistent with no reason the engine can name: a modelling bug.
              if (step.trust === 'inconsistent' && (step.reasons || []).some((r) => r.code === 'mismatch')) {
                tally.unexplained++;
                tally.shown = tally.shown || {};
                tally.shown[p] = (tally.shown[p] || 0) + 1;
                if (tally.shown[p] <= 2 && Object.keys(tally.shown).length <= 8) { out.push(`ORACLE ${d}.${variant} ${p} @${t}: predicted ${step.predicted}, dump ${step.value} (${step.stmt && step.stmt.src})`); }
              }
            }
          }
        }
        results.oracle[`${d}.${variant}`] = tally;
        const expectClean = variant === 'plain' || variant === 'icarus' || variant === 'flowctrl';
        const line = `${d}.${variant}: ${tally.steps} steps, exact ${tally.exact}, computed ${tally.computed}, approximate ${tally.approximate}, inconsistent ${tally.inconsistent}, unexplained ${tally.unexplained}`;
        if (tally.noDriver) { results.failures++; out.push(`FAIL oracle ${d}.${variant}: ${tally.noDriver} steps found no driver`); }
        if (expectClean && tally.unexplained) { results.failures++; out.push('FAIL oracle ' + line); } else { out.push('oracle ' + line); }
      }
    }
    // Trace to Root over the engine (the page's step and probe are its active()).
    const xc = (d, path, t, config) => {
      const { engine } = engineFor(d, 'icarus');
      return cmuxTrace.xChain({ path, time: t }, Object.assign({ step: (p, at) => engine.active(p, at) }, config || {}));
    };
    const chainWant = (what, got, exp) => {
      results.cases++;
      if (JSON.stringify(got) === JSON.stringify(exp)) { out.push(`ok   chain ${what}`); return; }
      results.failures++;
      out.push(`FAIL chain ${what}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`);
    };
    // An unreset counter (cnt <= cnt + 1, x since the start): uninitialised storage, not a loop.
    const cnt = await xc('j', 'tb_j.dut.cnt', 30000);
    chainWant('unreset counter', [cnt.end.code, cnt.root, cnt.steps.map((e) => e.signal)], ['uninit', 0, ['tb_j.dut.cnt']]);
    // A step whose value has no x though its probe had (the two disagree): the next candidate.
    const fake = {
      q: { signal: 'q', time: 10, value: 'x', since: 8, driver: { kind: 'proc' }, fanin: [{ path: 'a', value: 'x', time: 9 }, { path: 'b', value: 'x', time: 9 }] },
      a: { signal: 'a', time: 9, value: 'x', since: 2, driver: { kind: 'proc' }, fanin: [] },
      b: { signal: 'b', time: 9, value: 'x', since: 5, driver: { kind: 'none' }, fanin: [] },
    };
    const mismatch = await cmuxTrace.xChain({ path: 'q', time: 10 }, {
      probe: async (p) => fake[p],
      step: async (p) => (p === 'a' ? Object.assign({}, fake.a, { value: '0' }) : fake[p]),
    });
    chainWant('a step with no x is not followed', [mismatch.end.code, mismatch.steps.map((e) => e.signal)], ['uninit', ['q', 'b']]);
    const none = await cmuxTrace.xChain({ path: 'q', time: 10 }, {
      probe: async (p) => fake[p],
      step: async (p) => (p === 'q' ? fake.q : Object.assign({}, fake[p], { value: '0' })),
    });
    chainWant('no candidate with x left', [none.end.code, none.root, none.steps.map((e) => e.signal)], ['failed', -1, ['q']]);
    // cnt <= cnt + in, both x since the start: the input it has not seen is where the x came from.
    const ring = {
      cnt: { signal: 'cnt', time: 10, value: 'x', since: 0, driver: { kind: 'proc' }, fanin: [{ path: 'cnt', value: 'x', time: 9 }, { path: 'in', value: 'x', time: 9 }] },
      in: { signal: 'in', time: 9, value: 'x', since: 0, driver: { kind: 'none' }, fanin: [] },
    };
    const tied = await cmuxTrace.xChain({ path: 'cnt', time: 10 }, { step: async (p) => ring[p] });
    chainWant('a tie in since goes to the candidate not seen', [tied.root, tied.steps.map((e) => e.signal)], [1, ['cnt', 'in']]);
    // Design P: a register holding an x for many cycles after reset. The chain does not walk the
    // hold back one cycle per step (nor stop on it as a loop): it jumps to where the signal last
    // became x (one step, why 'held' with that time), then goes on to what brought the x.
    const xp = (path, t, config) => {
      const { engine } = engineFor('p', 'plain');
      const own = { step: (p, at) => engine.active(p, at) };
      if (typeof engine.xStart === 'function') { own.xStart = (p, at) => engine.xStart(p, at); }
      return cmuxTrace.xChain({ path, time: t }, Object.assign(own, config || {}));
    };
    const held = (c) => [c.end.code, c.root, c.steps.map((e) => [e.signal.replace('tb_p.', ''), e.time, e.why.code, e.why.since === undefined ? null : e.why.since])];
    // sig <= {sig[6:0], sig[7]} ^ flit: the x bit moves every cycle (x to x changes); it came in at 35.
    chainWant('a held x that changes every cycle jumps to where it began', held(await xp('tb_p.dut.sig', 440)),
      ['testbench', 3, [['dut.sig', 440, 'start', null], ['dut.sig', 35, 'held', 35], ['dut.flit', 34, 'only', null], ['flit', 34, 'only', null]]]);
    // sg2 <= nx2, nx2 = v ? {sg2[6:0], sg2[7]} ^ flit : sg2: the hold goes round through the mux.
    chainWant('a hold round through a combinational next value', held(await xp('tb_p.dut.sg2', 440)),
      ['testbench', 5, [['dut.sg2', 440, 'start', null], ['dut.nx2', 434, 'only', null], ['dut.sg2', 35, 'held', 35], ['dut.nx2', 32, 'xSince', 32], ['dut.flit', 32, 'only', null], ['flit', 32, 'only', null]]]);
    // hq <= en ? flit : hq with en low: each edge after 35 copies hq back bit for bit, so the
    // write in effect is the one at 35 (no held jump): flit, then the testbench.
    chainWant('an enable-mux hold with no change', held(await xp('tb_p.dut.hq', 440)),
      ['testbench', 2, [['dut.hq', 440, 'start', null], ['dut.flit', 34, 'only', null], ['flit', 34, 'only', null]]]);
    // The held step is the step at that time, as traced (its own statement, fan-in and trust).
    {
      const c = await xp('tb_p.dut.sig', 440);
      const h = c.steps[1] ? c.steps[1].step : {};
      chainWant('the held step is the step at the start of the x run', [h.since, h.stmt && h.stmt.loc && h.stmt.loc.line, h.trust, (h.fanin || []).filter((f) => /\.(sig|flit)$/.test(f.path)).map((f) => [f.path.replace('tb_p.', ''), f.time, /x/.test(f.value)])],
        [35, 22, 'exact', [['dut.sig', 34, false], ['dut.flit', 34, true]]]);
    }
    // M1 (B): the held jump goes to where the signal last became x (any bit), and is exact only
    // when its x bits are the same all the way from there (the exact-mask run starts there too).
    // Otherwise the step (the chain's entry; the step itself is traced as it is) and the chain are
    // approximate: why.bitsChanged { from: the jump's time, to: the time the run was seen at }.
    const xpm = (path, t) => {
      const { engine } = engineFor('p', 'plain');
      const own = {};
      if (typeof engine.xMaskStart === 'function') { own.maskStart = (p, at, floor) => engine.xMaskStart(p, at, floor); }
      return xp(path, t, own);
    };
    const bitsRow = (c, i) => { const e = c.steps[i] || { why: {} }; return [e.signal && e.signal.replace('tb_p.', ''), e.time, e.why.code, e.trust, e.why.bitsChanged ? [e.why.bitsChanged.from, e.why.bitsChanged.to] : null]; };
    {
      // sig's x bit moves every write: one jump to 35 still, approximate.
      const c = await xpm('tb_p.dut.sig', 440);
      chainWant('a held x whose bits move is approximate', [bitsRow(c, 1), c.approximate, c.steps.length], [['dut.sig', 35, 'held', 'approximate', [35, 434]], true, 4]);
      // hq holds the same x bits from 35, copied back bit for bit at every edge: the write in
      // effect is the one at 35, so no held jump: flit there, exact, with or without the checks.
      const h0 = await xpm('tb_p.dut.hq', 440);
      chainWant('a held x copied back bit for bit is the write that made it', bitsRow(h0, 1), ['dut.flit', 34, 'only', 'exact', null]);
      // The reviewer's r <= (r & mask) | d: r's x (bit 3, from d1 at 35) is cleared at 60 while d2
      // brings bit 5: the x-run starts at 35, but its bits changed at 60: not exact.
      const rStep = (at) => ({ signal: 'r', time: at, value: at >= 35 ? (at >= 60 ? '00x00000' : '0000x000') : '00000000', since: at >= 60 ? 60 : 35, trust: 'exact', driver: { kind: 'proc' },
        fanin: at === 35 ? [{ path: 'd1', value: '0000x000', time: 34, role: 'data' }] : at === 60 ? [{ path: 'r', value: '0000x000', time: 59, role: 'data' }, { path: 'd2', value: '00x00000', time: 59, role: 'data' }] : [{ path: 'r', value: '00x00000', time: at - 1, role: 'data' }] });
      const leaf = (p, t, s0) => ({ signal: p, time: t, value: 'x', since: s0, trust: 'exact', driver: { kind: 'topInput' }, fanin: [] });
      const rc = await cmuxTrace.xChain({ path: 'r', time: 440 }, {
        step: async (p, at) => p === 'r' ? rStep(at) : p === 'd1' ? leaf('d1', at, 34) : leaf('d2', at, 59),
        xStart: async (p, at) => p === 'r' && at >= 35 ? { time: 35, complete: true } : null,
      });
      const rw = rc.steps[1] || { why: {} };
      chainWant('the reviewer\'s replaced x is not exact', [rw.signal, rw.time, rw.why.code, rw.trust, rw.why.bitsChanged ? [rw.why.bitsChanged.from, rw.why.bitsChanged.to] : null, rc.approximate],
        ['r', 35, 'held', 'approximate', [35, 439], true]);
      // The same bits at both ends but not between (maskStart says so): approximate too.
      const back = await cmuxTrace.xChain({ path: 'r', time: 440 }, {
        step: async (p, at) => p === 'r' ? Object.assign(rStep(at), { value: at >= 35 ? '0000x000' : '00000000', fanin: at === 35 ? rStep(35).fanin : [{ path: 'r', value: '0000x000', time: at - 1, role: 'data' }] }) : leaf('d1', at, 34),
        xStart: async (p, at) => p === 'r' && at >= 35 ? { time: 35, complete: true } : null,
        maskStart: async (p, at, floor) => ({ time: 200, complete: true }),
      });
      const bw = back.steps[1] || { why: {} };
      chainWant('bits that changed and came back are not exact', [bw.trust, bw.why.bitsChanged ? [bw.why.bitsChanged.from, bw.why.bitsChanged.to] : null], ['approximate', [35, 439]]);
    }
    // M1 (C): at each change of the x bits inside the run, which input brought them: the statement
    // again with the other inputs' x bits forced to 0 and to 1 (engine.xCause). Still x: the held
    // signal's own, keep jumping; gone: a new x came in there, the jump stops there (exact) and the
    // chain goes on from the input that brought it (why cause). Past maxCauses changes: B's label.
    {
      const xq = (d, path, t, extra) => {
        const { engine } = engineFor(d, 'plain');
        const own = { step: (p, at) => engine.active(p, at) };
        if (typeof engine.xStart === 'function') { own.xStart = (p, at) => engine.xStart(p, at); }
        if (typeof engine.xMaskStart === 'function') { own.maskStart = (p, at, floor) => engine.xMaskStart(p, at, floor); }
        if (typeof engine.xCause === 'function') { own.xCause = (p, at, care) => engine.xCause(p, at, care); }
        if (typeof engine.xInputEdges === 'function') { own.xInputEdges = (p, at, from) => engine.xInputEdges(p, at, from); }
        if (typeof engine.xLink === 'function') { own.xLink = (p, at, input, care) => engine.xLink(p, at, input, care); }
        return cmuxTrace.xChain({ path, time: t }, Object.assign(own, extra || {}));
      };
      const crow = (c) => [c.end.code, c.steps.map((e) => [e.signal.replace(/^tb_[pq]\./, ''), e.time, e.why.code, e.trust, e.why.bitsChanged ? 'bits' : null])];
      // rn: bit 3's x (from d at 35) is cleared at 55, when d brings bit 5's: the jump stops at 55.
      chainWant('a new x inside a held run stops the jump there', crow(await xq('q', 'tb_q.dut.rn', 200)),
        ['testbench', [['dut.rn', 200, 'start', 'exact', null], ['dut.rn', 55, 'held', 'exact', null], ['dut.d', 54, 'cause', 'exact', null], ['d', 54, 'only', 'approximate', null]]]);
      // ms: d2's x lands on the bit ms's own x has at 65 (x ^ x): neither alone makes it (forcing
      // either leaves the other's), so whose it is is not known: B's label, approximate.
      const msc = crow(await xq('q', 'tb_q.dut.ms', 200));
      chainWant('an x into a bit that already had the held x is not provably the held one', [msc[0], msc[1].slice(0, 2)],
        ['testbench', [['dut.ms', 200, 'start', 'exact', null], ['dut.ms', 35, 'held', 'approximate', 'bits']]]);
      // sig: the x only rotates (clean flits after 35): exact, one jump to 35.
      const sg = await xq('p', 'tb_p.dut.sig', 440);
      chainWant('a held x that only moves is exact with its cause', crow(sg).slice(0, 1).concat([crow(sg)[1].slice(0, 2)]),
        ['testbench', [['dut.sig', 440, 'start', 'exact', null], ['dut.sig', 35, 'held', 'exact', null]]]);
      // sg2 <= nx2, nx2 = f(sg2): nx2's x is sg2's own, round the mux: one exact jump still.
      chainWant('a held x round a combinational next value is the held one', crow(await xq('p', 'tb_p.dut.sg2', 440)),
        ['testbench', [['dut.sg2', 440, 'start', 'exact', null], ['dut.nx2', 434, 'only', 'exact', null], ['dut.sg2', 35, 'held', 'exact', null], ['dut.nx2', 32, 'xSince', 'exact', null], ['dut.flit', 32, 'only', 'exact', null], ['flit', 32, 'only', 'approximate', null]]]);
      // Past the cap (8 here): B's approximate label, the jump as far.
      const capped = await xq('p', 'tb_p.dut.sig', 440, { maxCauses: 8 });
      chainWant('past maxCauses the held jump is approximate', crow(capped)[1].slice(0, 2), [['dut.sig', 440, 'start', 'exact', null], ['dut.sig', 35, 'held', 'approximate', 'bits']]);
      // (and says why: too many changes to walk)
      chainWant('past maxCauses the walk says too many changes', (capped.steps[1] || { why: {} }).why.causeSkipped || null, 'changes');
      // engine.xCause itself.
      const { engine } = engineFor('q', 'plain');
      const has = typeof engine.xCause === 'function';
      chainWant('engine.xCause: a new x', has ? await engine.xCause('tb_q.dut.rn', 55) : 'none', { cause: 'new', sources: ['tb_q.dut.d'] });
      chainWant('engine.xCause: an x met by another in its bit is not known', has ? await engine.xCause('tb_q.dut.ms', 65) : 'none', null);
      // Design S (a reviewer's cases). "Self" is proven: forcing the held signal's own x bits
      // removes them; an x made by a literal, or one an undumped input may bring, is not known.
      {
        const srow = (c) => c.steps.map((e) => [e.signal.replace(/^tb_s\./, ''), e.time, e.why.code, e.trust, e.why.bitsChanged ? 'bits' : null]);
        const se = engineFor('s', 'plain').engine;
        const hs = typeof se.xCause === 'function';
        chainWant('S A1: an x the statement\'s literal made is not the held one', hs ? await se.xCause('tb_s.t_lit.q', 55) : 'none', null);
        chainWant('S A1: so the held jump is approximate', srow(await xq('s', 'tb_s.t_lit.q', 200)).slice(0, 2),
          [['t_lit.q', 200, 'start', 'exact', null], ['t_lit.q', 35, 'held', 'approximate', 'bits']]);
        chainWant('S A2: an x an undumped input may bring is not known', hs ? await se.xCause('tb_s.t_nd.q', 55) : 'none', null);
        chainWant('S A2: so the held jump is approximate', srow(await xq('s', 'tb_s.t_nd.q', 200)).slice(0, 2),
          [['t_nd.q', 200, 'start', 'exact', null], ['t_nd.q', 35, 'held', 'approximate', 'bits']]);
        // A3: at 55 q takes o's x into its own x bit, no change in the dump: the activation where an
        // input other than q had x is asked too; o brought it.
        chainWant('S A3: an x replaced with no change stops the jump where it was replaced', srow(await xq('s', 'tb_s.t_rep.q', 200)).slice(0, 3),
          [['t_rep.q', 200, 'start', 'exact', null], ['t_rep.q', 55, 'held', 'exact', null], ['t_rep.o', 54, 'cause', 'exact', null]]);
        // A7: bit 5's x (d at 55) is cleared at 75; the x at 200 is bit 3's: the bits followed back
        // are those still x at 200, so the jump goes on to 35, then d.
        chainWant('S A7: a new x that does not reach the traced time is not its cause', srow(await xq('s', 'tb_s.t_mask.rn', 200)).slice(0, 3),
          [['t_mask.rn', 200, 'start', 'exact', null], ['t_mask.rn', 35, 'held', 'exact', null], ['t_mask.d', 34, 'only', 'exact', null]]);
        // V: q <= sel ? a : b with sel 0 and a = b = 5: the taken arm b, not the older a (read at 84
        // by the last edge that wrote q).
        const v = await cmuxTrace.xChain({ path: 'tb_s.t_mux.q', time: 90 }, { step: (p, at) => se.active(p, at), xStart: (p, at) => se.xStart(p, at) });
        chainWant('S V: a same value on the arm not taken is not where it came from', v.steps.slice(0, 2).map((e) => [e.signal.replace(/^tb_s\./, ''), e.time, e.value.replace(/^0+(?=.)/, ''), e.why.code, e.trust]),
          [['t_mux.q', 90, '101', 'start', 'exact'], ['t_mux.b', 84, '101', 'same', 'exact']]);
      }
      // The reviewer's mock r with an xCause: the jump stops at 60, then d2.
      // (the reads wired bit for bit; no other input with x inside the run)
      const id8 = Array.from({ length: 8 }, (_, i) => [i, i]);
      const rStep = (at) => ({ signal: 'r', time: at, value: at >= 35 ? (at >= 60 ? '00x00000' : '0000x000') : '00000000', since: at >= 60 ? 60 : 35, trust: 'exact', driver: { kind: 'proc' },
        fanin: at === 35 ? [{ path: 'd1', value: '0000x000', time: 34, role: 'data', wires: id8 }] : at === 60 ? [{ path: 'r', value: '0000x000', time: 59, role: 'data' }, { path: 'd2', value: '00x00000', time: 59, role: 'data', wires: id8 }] : [{ path: 'r', value: '00x00000', time: at - 1, role: 'data', wires: id8 }] });
      const leaf = (p, t, s0) => ({ signal: p, time: t, value: 'x', since: s0, trust: 'exact', driver: { kind: 'topInput' }, fanin: [] });
      const rc = await cmuxTrace.xChain({ path: 'r', time: 440 }, {
        xInputEdges: async () => ({ edges: [] }),
        step: async (p, at) => p === 'r' ? rStep(at) : p === 'd1' ? leaf('d1', at, 34) : leaf('d2', at, 59),
        xStart: async (p, at) => p === 'r' && at >= 35 ? { time: 35, complete: true } : null,
        maskStart: async (p, at, floor) => ({ time: at >= 60 ? 60 : 35, complete: true }),
        xCause: async (p, at) => (at === 60 ? { cause: 'new', sources: ['d2'] } : { cause: 'self', sources: [] }),
      });
      chainWant('the reviewer\'s r with its cause: the jump stops at 60, then d2', crow(rc), ['input', [['r', 440, 'start', 'exact', null], ['r', 60, 'held', 'exact', null], ['d2', 59, 'cause', 'exact', null]]]);
    }
    // The cause walk's cost: a pre-check of the run's change count (changeCount over (from, to], one
    // helper window; over maxCauses, the x bits' own count, maskChangeCount, as the bound) and a
    // budget of calls (causeSteps, default 160), never wall time; the clock is a hang guard only
    // (causeHangMs, default 10 s). Skipped: B's label, why.causeSkipped 'changes' | 'budget' |
    // 'timeout'.
    {
      const many = (n) => Array.from({ length: n }, (_, i) => 400 - i * 5);
      const mk = (counts, extra) => {
        const asked = { mask: 0, cause: 0 };
        const rS = (at) => ({ signal: 'r', time: at, value: '0000x000', since: at, trust: 'exact', driver: { kind: 'proc' },
          fanin: at <= 35 ? [{ path: 'd1', value: '0000x000', time: 34, role: 'data' }] : [{ path: 'r', value: '0000x000', time: at - 1, role: 'data', wires: Array.from({ length: 8 }, (_, i) => [i, i]) }] });
        const marks = many(60);
        const cfg = Object.assign({
          xInputEdges: async () => ({ edges: [] }),
          step: async (p, at) => p === 'r' ? rS(at) : { signal: p, time: at, value: 'x', since: 34, trust: 'exact', driver: { kind: 'topInput' }, fanin: [] },
          xStart: async (p, at) => (p === 'r' ? { time: 35, complete: true } : null),
          maskStart: async (p, at, floor) => { asked.mask++; const m = marks.find((x) => x <= at); return { time: m === undefined || m <= floor ? floor : m, complete: true }; },
          xCause: async () => { asked.cause++; return { cause: 'self', sources: [] }; },
          changeCount: async () => counts[0], maskChangeCount: async () => counts[1],
        }, extra || {});
        return { cfg, asked };
      };
      const row = (c) => { const e = c.steps[1] || { why: {} }; return [e.time, e.trust, e.why.causeSkipped || null]; };
      // 1000 changes and 500 of the x bits: no walk at all.
      let k = mk([1000, 500]);
      let c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('over maxCauses changes with no bound: B\'s label, no walk', [row(c), k.asked.mask, k.asked.cause], [[35, 'approximate', 'changes'], 0, 0]);
      // 1000 changes but only 60 of the x bits: walked, all its own: exact.
      k = mk([1000, 60]);
      c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('a bound that fits: walked, exact', [row(c), k.asked.cause], [[35, 'exact', null], 60]);
      // No counts at all (an older dump): walked as before.
      k = mk([undefined, undefined]);
      c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('no counts: walked as before', [row(c), k.asked.cause], [[35, 'exact', null], 60]);
      // Past the budget of calls (causeSteps 10): B's label, budget, at any speed.
      let clock = 0;
      k = mk([60, 60], { causeSteps: 10, now: () => clock, xCause: async () => { clock += 40; return { cause: 'self', sources: [] }; } });
      c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('past the cause budget: B\'s label, budget', row(c), [35, 'approximate', 'budget']);
      // A slow xCause (40 ms each on a fake clock) within the budget: walked, exact, also when the
      // whole walk (60 calls, 2.4 s) takes longer than the hang guard (causeHangMs 1000 here): the
      // guard is per call (a call that does not come back), so slowness alone never changes a
      // label. Only one call past the guard times out.
      clock = 0;
      k = mk([60, 60], { now: () => clock, xCause: async () => { clock += 40; return { cause: 'self', sources: [] }; } });
      c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('a slow walk within the budget is exact', row(c), [35, 'exact', null]);
      clock = 0;
      k = mk([60, 60], { causeHangMs: 1000, now: () => clock, xCause: async () => { clock += 40; return { cause: 'self', sources: [] }; } });
      c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('a slow walk longer than the hang guard, each call within it: exact', row(c), [35, 'exact', null]);
      clock = 0;
      let calls = 0;
      k = mk([60, 60], { causeHangMs: 1000, now: () => clock, xCause: async () => { clock += ++calls === 3 ? 1200 : 40; return { cause: 'self', sources: [] }; } });
      c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('one call past the hang guard: B\'s label, timeout', row(c), [35, 'approximate', 'timeout']);
      // The guard holds around a count call too: one that never comes back in time (a helper
      // derive, bounded only by the helper's own timeout) is given up when the guard fires (timer:
      // the page's setTimeout; injected here, firing at once), with no walk.
      k = mk([0, 0], { changeCount: async () => { for (let i = 0; i < 50; i++) { await null; } return 0; }, timer: () => Promise.resolve() });
      c = await cmuxTrace.xChain({ path: 'r', time: 440 }, k.cfg);
      chainWant('a count past the hang guard: B\'s label, timeout', [row(c), k.asked.cause], [[35, 'approximate', 'timeout'], 0]);
      // The engine's counts over the dump (the VCD provider's changeCount / maskChangeCount).
      const { engine } = engineFor('q', 'plain');
      const has = typeof engine.xChangeCount === 'function' && typeof engine.xMaskChangeCount === 'function';
      chainWant('engine change counts over (from, to]', has ? [await engine.xChangeCount('tb_q.dut.rn', 35, 200), await engine.xMaskChangeCount('tb_q.dut.rn', 35, 200), await engine.xMaskChangeCount('tb_q.dut.ms', 35, 200)] : 'none',
        [1, 1, 16]);
    }
    // Value mode through a conditional: the taken arm's inputs, matched by bit slices (the value's
    // 1 bits came from them), before the select (SERV's dlo <= i_load ? i_dat : {dhi, dlo >> 1}).
    {
      const { engine } = engineFor('r', 'plain');
      const xr = (path, t) => cmuxTrace.xChain({ path, time: t }, { step: (p, at) => engine.active(p, at), xStart: (p, at) => engine.xStart(p, at) });
      const vr = (c) => [c.mode, c.end.code, c.steps.map((e) => [e.signal.replace(/^tb_r\./, ''), e.time, e.value.replace(/^0+(?=.)/, ''), e.why.code])];
      // dlo = 1 at 50: its 1 shifted along dlo (bit 0 from bit 1 at 35, from bit 2 at 25, loaded
      // there from din): one shift jump to 25, exact (every stage a copy), then din, the testbench.
      const vs = (c) => [c.mode, c.end.code, c.steps.map((e) => [e.signal.replace(/^tb_r\./, ''), e.time, e.value.replace(/^0+(?=.)/, ''), e.why.code, e.trust, e.why.stages === undefined ? null : e.why.stages])];
      chainWant('a shifted value jumps to where its bit entered the register', vs(await xr('tb_r.dut.dlo', 50)),
        ['value', 'testbench', [['dut.dlo', 50, '1', 'start', 'exact', null], ['dut.dlo', 25, '100', 'shifted', 'exact', 2], ['dut.din', 24, '100', 'bits', 'exact', null], ['din', 24, '100', 'same', 'approximate', null]]]);
      // The wires of a bitwise operator: an AND bit with a known 1, an OR or XOR bit with a known 0,
      // is the other operand's (either way round; bit 0 first); any other bit (both x or 0 under
      // AND, both x or 1 under OR, an add, and both at the identity: a joint cause, as bit 0 of
      // a | m here) is not wired; a constant at the identity is no cause (L & 4'b0011).
      {
        const E = globalThis.cmuxExpr;
        const env = (vals) => (path) => { const v = vals[path.join('.')]; return v === undefined ? null : { value: E.fromBits(v, v.length), width: v.length }; };
        const ws = (text, vals) => { const r = E.evaluate(E.parse(text).ast, env(vals), { wires: true }); return (r.wires || []).map((x) => (x ? x.name + x.bit : '-')).join(' '); };
        chainWant('wires: an AND with a known 1 is a copy', ws('a & m', { a: '1010', m: '01x1' }), 'a0 m1 a2 m3');
        chainWant('wires: an OR or XOR with a known 0 is a copy', [ws('a | m', { a: '1010', m: '01x0' }), ws('a ^ 4\'b0011', { a: '1010' })], ['- - m2 a3', '- - a2 a3']);
        chainWant('wires: an add is not', ws('a + 4\'b0000', { a: '1010' }), '- - - -');
        chainWant('wires: both operands at the identity: a joint cause, unless one is a constant', [ws('a & m', { a: '0011', m: '0011' }), ws('a & 4\'b0011', { a: '0011' }), ws('a & {m[3:2], 2\'b11}', { a: '0011', m: '1111' })],
          ['- - - -', 'a0 a1 - -', 'a0 a1 a2 a3']);
      }
      // rg <= {rg[2:0], rg[3] | inj}, a ring: rg = 0010 at 80. An OR with a known 0 is a copy of
      // the other bit (cmux-expr wires it): at 65 rg[0] = rg[3] | 0 is rg[3]'s, so the 1 goes
      // round the ring (65, 55, 45, 35) to 25, where rg[3] was 0 and inj, 1, made it: inj at 24.
      chainWant('a ring\'s bit jumps to where an operator made it', vs(await xr('tb_r.dut.rg', 80)),
        ['value', 'testbench', [['dut.rg', 80, '10', 'start', 'exact', null], ['dut.rg', 25, '1', 'shifted', 'exact', 5], ['dut.inj', 24, '1', 'bits', 'exact', null], ['inj', 24, '1', 'same', 'approximate', null]]]);
      // Design X. Exact is earned by the link, not the rule that picked it: the statement wrote
      // the traced bits, the input is wired to them, and its bits there are theirs.
      {
        const xe = engineFor('x', 'plain').engine;
        const xx = (path, t) => cmuxTrace.xChain({ path, time: t }, { step: (p, at) => xe.active(p, at), xStart: (p, at) => xe.xStart(p, at) });
        const xs = (c) => [c.mode, c.end.code, c.steps.map((e) => [e.signal.replace(/^tb_x\./, ''), e.time, e.why.code, e.trust, e.why.stages === undefined ? null : e.why.stages, e.why.bit === undefined ? null : e.why.bit])];
        // so [8:1]: the 1 at so[4] entered at so[1] at 25 from in (offsets from the lsb).
        chainWant('X: a shift register declared [8:1]', xs(await xx('tb_x.dut.so', 50)),
          ['value', 'testbench', [['dut.so', 50, 'start', 'exact', null, null], ['dut.so', 25, 'shifted', 'exact', 2, 2], ['dut.in', 24, 'bits', 'exact', null, null], ['in', 24, 'same', 'approximate', null, null]]]);
        // H3, sp: the part write sp[7:6] <= hi at 55 never touched bit 2, held there: the shifts at
        // 65, 45 and 35 carried it, from in at 25.
        chainWant('X H3: a part write that does not cover the bit is not where it entered', xs(await xx('tb_x.dut.sp', 70)),
          ['value', 'testbench', [['dut.sp', 70, 'start', 'exact', null, null], ['dut.sp', 25, 'shifted', 'exact', 3, 3], ['dut.in', 24, 'bits', 'exact', null, null], ['in', 24, 'same', 'approximate', null, null]]]);
        // M5, cnt <= clr ? 0 : cnt + 1: clr only chose the counting arm (a select at the top, not
        // inside an operand): not where 7 came from; and nothing on the way is wired to it.
        const cn = await xx('tb_x.dut.cnt', 90);
        chainWant('X M5: a counter with a clear does not follow the clear, and is not exact', [cn.steps.some((e) => /clr/.test(e.signal)), cn.steps.slice(1).filter((e) => e.trust === 'exact').map((e) => e.signal)], [false, []]);
        // L4, sm = 00001010 at 60: two 1 bits that entered at different times; the jump follows
        // bit 1 (in2 at 45) and says which bit.
        chainWant('X L4: a shift jump says which bit it followed', xs(await xx('tb_x.dut.sm', 60)).slice(0, 2).concat([xs(await xx('tb_x.dut.sm', 60))[2].slice(0, 3)]),
          ['value', 'testbench', [['dut.sm', 60, 'start', 'exact', null, null], ['dut.sm', 45, 'shifted', 'exact', 1, 1], ['dut.in2', 44, 'bits', 'exact', null, null]]]);
        // An operator's result (y = a + b): the earliest input is picked, but no input is wired to
        // y's bits: approximate.
        const je = engineFor('j', 'icarus').engine;
        const yv = await cmuxTrace.xChain({ path: 'tb_j.dut.y', time: 30000 }, { step: (p, at) => je.active(p, at), xStart: (p, at) => je.xStart(p, at) });
        chainWant('an operator\'s result is not exactly its earliest input', yv.steps.slice(0, 2).map((e) => [e.signal, e.why.code, e.trust]),
          [['tb_j.dut.y', 'start', 'exact'], ['tb_j.dut.b', 'earliest', 'approximate']]);
      }
      // Design W: a bitwise copy is a copy only where the other operand's dumped bit, at that step,
      // is the identity and its own is not. qa <= d & m, d 0000: at 35 m = 1111, every bit of qa is
      // d's (exact); at 45 m[2] is 0 too: qa[2] is a 0 of both (a joint cause), the hop approximate,
      // whichever input the rules pick (d). qo <= e | n, e 1111, the same with n[1] = 1.
      {
        const we = engineFor('w', 'plain').engine;
        const wx = async (path, t) => { const c = await cmuxTrace.xChain({ path, time: t }, { step: (p, at) => we.active(p, at), xStart: (p, at) => we.xStart(p, at) }); const e = c.steps[1] || { why: {} }; return [e.signal && e.signal.replace(/^tb_w\./, ''), e.trust]; };
        chainWant('W: an AND whose other bits are 1 there is a copy', await wx('tb_w.t_and.qa', 40), ['t_and.d', 'exact']);
        chainWant('W: the same AND where the other bit turned 0 is not', await wx('tb_w.t_and.qa', 50), ['t_and.d', 'approximate']);
        chainWant('W: and a copy again when it is back to 1', await wx('tb_w.t_and.qa', 60), ['t_and.d', 'exact']);
        chainWant('W: an OR whose other bits are 0 there is a copy', await wx('tb_w.t_or.qo', 40), ['t_or.e', 'exact']);
        chainWant('W: the same OR where the other bit turned 1 is not', await wx('tb_w.t_or.qo', 50), ['t_or.e', 'approximate']);
      }
      // A reviewer's third round (designs Y, Z), with every hook the page passes.
      {
        const full = (d, options) => {
          const { engine } = engineFor(d, 'plain', options);
          const own = { step: (p, at) => engine.active(p, at), xStart: (p, at) => engine.xStart(p, at), maskStart: (p, at, f) => engine.xMaskStart(p, at, f),
            xCause: (p, at, care) => engine.xCause(p, at, care), xInputEdges: (p, at, f) => engine.xInputEdges(p, at, f), xLink: (p, at, i, care) => engine.xLink(p, at, i, care),
            changeCount: (p, a, b) => engine.xChangeCount(p, a, b), maskChangeCount: (p, a, b) => engine.xMaskChangeCount(p, a, b) };
          return { engine, own, chain: (path, t, extra) => cmuxTrace.xChain({ path, time: t }, extra ? Object.assign({}, own, extra) : own) };
        };
        const tail = (c, pre) => c.steps.slice(1).map((e) => [e.signal.replace(pre, ''), e.trust]);
        const Y = full('y'), Z = full('z');
        // M7, V3: q <= a & b, a 1 from 12, b rising at 42: q's 1 at 45 needs both (a joint cause):
        // the bit is wired to neither, the hop approximate, whichever input is picked.
        const v3 = await Y.chain('tb_y.dut.q', 90);
        chainWant('Y M7: a bit both operands of an AND pass is not a copy of either', v3.steps.slice(1, 2).map((e) => e.trust), ['approximate']);
        // H4, V4: r is 3 from reset (5); ld writes 3 again at 45 (no change in the dump): the value
        // in effect at 64 was written at 45.
        const r64 = await Y.engine.active('tb_y.dut.r', 64);
        chainWant('Y H4: a clean value written again with no change is from the later write', [r64.activation && r64.activation.time, r64.trust], [45, 'exact']);
        // H4, A9: z is x from d at 35; bad writes 'x again at 55 (no change): the x in effect at 90
        // is the literal's, not d's.
        const z90 = await Y.engine.active('tb_y.dut.z', 90);
        chainWant('Y H4: an x written again by a literal is the literal\'s', [z90.activation && z90.activation.time, /'x/.test(String(z90.stmt && z90.stmt.src))], [55, true]);
        const a9 = await Y.chain('tb_y.dut.z', 90);
        chainWant('Y H4: so the chain does not go to d', a9.steps.some((e) => /dut\.d$/.test(e.signal)), false);
        // M6, C1: if (set) f <= 1'b1: set chose the statement; the 1 is a literal: not wired.
        const c1 = await Z.chain('tb_z.dut.f', 80);
        chainWant('Z M6: a condition is not wired to what its statement writes', tail(c1, /^tb_z\./).slice(0, 1), [['dut.set', 'approximate']]);
        const st = await Z.engine.active('tb_z.dut.f', 80);
        chainWant('Z M6: so its fan-in entry has no wires', (st.fanin || []).filter((f) => /set$/.test(String(f.path))).map((f) => [f.role, f.wires === undefined ? null : f.wires]), [['control', null]]);
        const c1b = await Z.chain('tb_z.dut.h', 80);
        chainWant('Z M6: nor a condition on one bit of a vector', tail(c1b, /^tb_z\./).slice(0, 1).map((x) => x[1]), ['approximate']);
        // Design V (a reviewer's fourth round), every hook: d = m = 1011 under an AND, a joint cause in
        // every 1 bit (approximate, though an always-copy wiring would say exact); vo written 0101 again
        // at 45 with n[2] now 1: the write in effect is 1 | 1 in bit 2 (approximate), not the one at 5.
        {
          const V = full('v');
          const second = async (path, t) => { const c = await V.chain(path, t); const e = c.steps[1] || {}; return [e.signal && e.signal.replace(/^tb_v\./, ''), e.trust]; };
          chainWant('V: an AND of two equal operands is a joint cause', (await second('tb_v.t_and.va', 60))[1], 'approximate');
          const vo = await V.engine.active('tb_v.t_or.vo', 60);
          chainWant('V: a same-value rewrite with a new operand is the write in effect', vo.activation && vo.activation.time, 55);
          chainWant('V: so its 1 | 1 bit is not a copy of e', (await second('tb_v.t_or.vo', 60))[1], 'approximate');
        }
      }
      // A reviewer's fifth round (designs U, M), and labels that never depend on wall time.
      {
        const fullU = (d, options) => {
          const { engine } = engineFor(d, 'plain', options);
          const own = { step: (p, at) => engine.active(p, at), xStart: (p, at) => engine.xStart(p, at), maskStart: (p, at, f) => engine.xMaskStart(p, at, f),
            xCause: (p, at, care) => engine.xCause(p, at, care), xInputEdges: (p, at, f) => engine.xInputEdges(p, at, f), xLink: (p, at, i, care) => engine.xLink(p, at, i, care),
            changeCount: (p, a, b) => engine.xChangeCount(p, a, b), maskChangeCount: (p, a, b) => engine.xMaskChangeCount(p, a, b) };
          return { engine, own, chain: (path, t, extra) => cmuxTrace.xChain({ path, time: t }, extra ? Object.assign({}, own, extra) : own) };
        };
        // H5: q is 0 from d at 15; the asynchronous reset, low 42..58, writes 0 again (at 42, and at
        // the edges 45 and 55): the 0 in effect at 90 is the reset's.
        const U = fullU('u');
        const q90 = await U.engine.active('tb_u.dut.q', 90);
        chainWant('U H5: a value written again by an asynchronous reset is the reset\'s', [q90.activation && q90.activation.time, /'0/.test(String(q90.stmt && q90.stmt.src))], [55, true]);
        const u90 = await U.chain('tb_u.dut.q', 90);
        chainWant('U H5: so the chain goes to the reset, not d', [u90.steps.some((e) => /dut\.d$/.test(e.signal)), u90.steps.some((e) => /rst_n$/.test(e.signal))], [false, true]);
        // M9: cfg written once (we at 15) while bus changes every cycle: the condition (we) did not
        // change after 22, so no edge after wrote it, whatever bus did: exact, from 15.
        const M = fullU('m');
        const c2k = await M.engine.active('tb_m.dut.cfg', 2000);
        chainWant('M M9: a write-once register held past many data changes is from its write', [c2k.activation && c2k.activation.time, c2k.trust, (c2k.reasons || []).some((r) => r.code === 'rewrites')], [15, 'exact', false]);
        // H6: a branch condition on a block-local temp (t2 = d ^ f; if (t2 == 0) q <= 0): the temp has
        // no history, so its sources (d) are the condition's inputs: d == f at 45 wrote q's 0 again.
        // Through a chain of temps (t1, then t2) the same. A temp set where the walk can't follow
        // (inside a loop): the step says a rewrite may be missed (rewrites), not exact from 15.
        const O = fullU('o');
        const why = (st) => [st.activation && st.activation.time, st.trust, (st.reasons || []).some((r) => r.code === 'rewrites')];
        chainWant('O H6: a condition on a local temp cuts on the temp\'s sources', why(await O.engine.active('tb_o.dut.q', 90)), [45, 'exact', false]);
        chainWant('O H6: through a chain of temps', why(await O.engine.active('tb_o.dut.q2', 90)), [45, 'exact', false]);
        const q3 = await O.engine.active('tb_o.dut.q3', 90);
        chainWant('O H6: a temp set inside a loop: rewrites may be missed, not exact', [q3.trust !== 'exact', (q3.reasons || []).some((r) => r.code === 'rewrites')], [true, true]);
        // H7: block locals in always blocks are static: one a path reads before every path has
        // assigned it carries the last activation's value. q (prev read before prev = d) and q2 (t3
        // set only when en): the walk can't tell the rewrites (rewrites, not exact). q3 <= acc
        // (acc = d after it): the run at 45 reads the last activation's acc (staticLocal,
        // approximate). The temps of O, assigned before every read, stay exact (above).
        const T = fullU('t');
        const has = (st, code) => (st.reasons || []).some((r) => r.code === code);
        const tq = await T.engine.active('tb_t.dut.q', 90), tq2 = await T.engine.active('tb_t.dut.q2', 90), tq3 = await T.engine.active('tb_t.dut.q3', 50);
        chainWant('T H7: a static local read before it is assigned: rewrites, not exact', [tq.trust !== 'exact', has(tq, 'rewrites')], [true, true]);
        chainWant('T H7: a static local assigned on some paths only: rewrites, not exact', [tq2.trust !== 'exact', has(tq2, 'rewrites')], [true, true]);
        chainWant('T H7: a run that reads a local carried from the last activation is approximate', [tq3.trust, has(tq3, 'staticLocal')], ['approximate', true]);
        // (the per-run rule holds only on a path known exactly) q4: p4 is read before p4 = d only
        // under xs, which is x: the run's path is not known, so it counts as reading the carried
        // local (the static rule for that run): rewrites, not exact.
        const D = fullU('d');
        const dq4 = await D.engine.active('tb_d.dut.q4', 90);
        chainWant('D H7: a carried local read on a branch under an x condition: rewrites, not exact', [dq4.trust !== 'exact', has(dq4, 'rewrites')], [true, true]);
        // q5: t5 set in a loop (opaque), its text naming t5: rewrites; the same when the text
        // names it only through a macro (a backtick: every local counts as named).
        const dq5 = await D.engine.active('tb_d.dut.q5', 90);
        chainWant('D: a loop that names the condition\'s local: rewrites', [dq5.trust !== 'exact', has(dq5, 'rewrites')], [true, true]);
        const { engine: DM } = engineFor('d', 'macro', {});
        const mq5 = await DM.active('tb_d.dut.q5', 90);
        chainWant('D: a loop whose text names the local only through a macro: rewrites', [mq5.trust !== 'exact', has(mq5, 'rewrites')], [true, true]);
        // H8: a static local's initialiser runs once (q: static p = 0, then p = d: the last d is
        // carried; d = 5 sampled at 35 writes q's 1 again at 45): rewrites, not exact. An automatic
        // local is fresh each activation (q2: a, no initialiser): never carried.
        // H9: a condition that calls a function the model doesn't follow (q6: is5(d); q5: f(d),
        // a static function whose local carries): its reads are not known, so the walk can't
        // tell the rewrites (rewrites, not exact).
        const LF = fullU('lf');
        const lq = await LF.engine.active('tb_lf.dut.q', 90), lq2 = await LF.engine.active('tb_lf.dut.q2', 90);
        const lq5 = await LF.engine.active('tb_lf.dut.q5', 90), lq6 = await LF.engine.active('tb_lf.dut.q6', 90);
        chainWant('LF H8: a static local with an initialiser carries: rewrites, not exact', [lq.trust !== 'exact', has(lq, 'rewrites')], [true, true]);
        chainWant('LF H8: an automatic local without one is fresh: not carried', has(lq2, 'staticLocal'), false);
        // A model with no lifetimes (an older sidecar): any local may be static, so it is carried,
        // initialised or not; never a wrong exact.
        const { engine: NL } = engineFor('lf', 'nolife', {});
        const nq = await NL.active('tb_lf.dut.q', 90);
        chainWant('LF H8: no lifetime in the model: an initialised local is carried too (rewrites, not exact)', [nq.trust !== 'exact', has(nq, 'rewrites')], [true, true]);
        chainWant('LF H9: a condition calling a static function: rewrites, not exact', [lq5.trust !== 'exact', has(lq5, 'rewrites')], [true, true]);
        chainWant('LF H9: a condition calling a function: rewrites, not exact', [lq6.trust !== 'exact', has(lq6, 'rewrites')], [true, true]);
        const tq20 = await T.engine.active('tb_t.dut.q', 20);
        chainWant('T H7: a run whose path reads no carried local keeps its label (the reset)', [tq20.trust, has(tq20, 'staticLocal')], ['exact', false]);
        // M8: the same trace under load (each hook call 60 ms later on the chain's clock) labels
        // every step the same as unloaded.
        const P = fullU('p');
        const labels = (c) => c.steps.map((e) => [e.signal, e.time, e.why.code, e.trust, e.why.causeSkipped || null]);
        const quiet = labels(await P.chain('tb_p.dut.sig', 440, { now: () => 0 }));
        let clock = 0;
        const slow = (f) => async (...a) => { clock += 60; return f(...a); };
        const loaded = {};
        for (const [k, f] of Object.entries(P.own)) { loaded[k] = slow(f); }
        loaded.now = () => clock;
        const busy = labels(await cmuxTrace.xChain({ path: 'tb_p.dut.sig', time: 440 }, loaded));
        chainWant('M8: the labels are the same under load', busy, quiet);
        // The cause walk's re-runs are pinned to the activation they check: no rewrite walk there.
        const stats = {};
        const S = fullU('s', { stats });
        await S.engine.active('tb_s.t_rep.q', 55);
        const before = stats.rewriteWalks || 0;
        const k = await S.engine.xCause('tb_s.t_rep.q', 55);
        chainWant('M8: forced re-runs are pinned (no rewrite walk), and asked', [!!k, (stats.rewriteWalks || 0) - before, (stats.pinnedRuns || 0) > 0], [true, 0, true]);
      }
      // L5: wire() on a long chain of ORs is linear: count the evaluations (options.stats).
      {
        const E = globalThis.cmuxExpr;
        const evs = (n) => {
          // (at most MAX_SIGNALS names: four, repeated)
          const names = Array.from({ length: n }, (_, i) => 'v' + (i % 4));
          const vals = { v0: '0000', v1: '0000', v2: '0000', v3: '0000' };
          const stats = { ev: 0 };
          const r = E.evaluate(E.parse(names.join(' | ')).ast, (path) => { const v = vals[path.join('.')]; return v === undefined ? null : { value: E.fromBits(v, 4), width: 4 }; }, { wires: true, stats });
          return [stats.ev, r.error || null];
        };
        const [a, ea] = evs(30), [b, eb] = evs(60);
        chainWant('L5: wires over 60 ORs cost at most about twice 30 ORs\' (linear)', [a > 0, b <= 2.2 * a, ea, eb], [true, true, null, null]);
      }
      // Past shiftStages (1 here): as far as it got, approximate.
      const lim = await cmuxTrace.xChain({ path: 'tb_r.dut.dlo', time: 50 }, { step: (p, at) => engine.active(p, at), xStart: (p, at) => engine.xStart(p, at), shiftStages: 1 });
      chainWant('past shiftStages the shift jump is approximate', vs(lim)[2].slice(0, 2), [['dut.dlo', 50, '1', 'start', 'exact', null], ['dut.dlo', 35, '10', 'shifted', 'approximate', 1]]);
      // M8, shift: slow steps (each 600 ms on a fake clock, the whole jump past shiftHangMs 1000)
      // keep the exact shift jump; only one step past the guard stops it, why.timedOut.
      {
        let clk = 0, n = 0;
        const slowStep = (late) => (p, at) => { n++; clk += late && n === 2 ? 1200 : 600; return engine.active(p, at); };
        const shiftRow = (c) => vs(c)[2].slice(0, 2);
        const want = [['dut.dlo', 50, '1', 'start', 'exact', null], ['dut.dlo', 25, '100', 'shifted', 'exact', 2]];
        const slowShift = await cmuxTrace.xChain({ path: 'tb_r.dut.dlo', time: 50 }, { step: slowStep(false), xStart: (p, at) => engine.xStart(p, at), shiftHangMs: 1000, now: () => clk });
        chainWant('M8: slow shift steps, the whole jump past the hang guard: the same exact jump', shiftRow(slowShift), want);
        clk = 0; n = 0;
        const hung = await cmuxTrace.xChain({ path: 'tb_r.dut.dlo', time: 50 }, { step: slowStep(true), xStart: (p, at) => engine.xStart(p, at), shiftHangMs: 1000, now: () => clk });
        const hop = (hung.steps || [])[1];
        chainWant('M8: one shift step past the hang guard: stopped, timedOut', [hop && hop.trust, hop && hop.why && hop.why.timedOut], ['approximate', true]);
        // The guard's page timers are cleared as each call returns (none left pending after the
        // chain); a step that has a field named like a marker (late) is a step, not a hang.
        const hadST = globalThis.setTimeout, hadCT = globalThis.clearTimeout;
        const pending = new Set();
        let made = 0, seq = 0;
        globalThis.setTimeout = (fn, ms) => { made++; const id = ++seq; pending.add(id); return id; };
        globalThis.clearTimeout = (id) => { pending.delete(id); };
        let timed;
        try {
          timed = await cmuxTrace.xChain({ path: 'tb_r.dut.dlo', time: 50 }, { step: async (p, at) => Object.assign({}, await engine.active(p, at), { late: 1 }), xStart: (p, at) => engine.xStart(p, at) });
        } finally { globalThis.setTimeout = hadST; globalThis.clearTimeout = hadCT; }
        chainWant('M8: the guard timers are cleared as the calls return; a step field named late is no hang', [made > 0, pending.size, shiftRow(timed)], [true, 0, want]);
      }
      // cnt <= cnt + tick: 2 at 110 (since 95). Its own last count (1, since 75) is earlier than
      // tick's (since 92), but a value that differs from the input's is not its origin: the
      // input that isn't the signal itself, tick, then the testbench. (The edge at 105 wrote 2 again
      // from cnt + 0: from cnt held since 95, then tick.)
      chainWant('a counter follows what it counts, not its own last count', vr(await xr('tb_r.dut.cnt', 110)),
        ['value', 'testbench', [['dut.cnt', 110, '10', 'start'], ['dut.cnt', 95, '10', 'held'], ['dut.tick', 94, '1', 'only'], ['tick', 94, '1', 'same']]]);
      // pc <= cp + 2 with cp = pc (blocking): the + makes pc's bits, so neither cp nor pc read
      // through it is wired to them (a temp's wires are the statement's, not the temp's own), and
      // pc's value is not shifted from itself: no shift jump; the temp's source pc, a counter by 2,
      // held back to its reset.
      {
        const st = await engine.active('tb_r.dut.pc', 110);
        const fan = (st.fanin || []).filter((f) => f.role === 'data').map((f) => [f.path.replace(/^tb_r\./, ''), f.wires ? f.wires.length : 0]);
        const pc = await xr('tb_r.dut.pc', 110);
        chainWant('a temp read under an operator is not wired to the value', [st.value, fan, pc.steps.map((e) => [e.signal.replace(/^tb_r\./, ''), e.time, e.why.code])],
          ['0110', [['dut.cp', 0], ['dut.pc', 0]], [['dut.pc', 110, 'start'], ['dut.pc', 75, 'held'], ['dut.pc', 5, 'held'], ['dut.rst_n', 4, 'control'], ['rst_n', 4, 'same']]]);
      }
      // pd <= cd + (inj ? 4 : 2) with cd = pd: its only data input is itself with another value
      // (its last count); the input that isn't itself is the select inj, so the chain takes it.
      chainWant('a count by a select follows the select, not its own last count', vr(await xr('tb_r.dut.pd', 110)),
        ['value', 'testbench', [['dut.pd', 110, '110', 'start'], ['dut.inj', 94, '0', 'only'], ['inj', 94, '0', 'same']]]);
      // The step's fan-in says which input only selects, and which bits each input is wired to.
      const st = await engine.active('tb_r.dut.dlo', 50);
      const fan = (st.fanin || []).filter((f) => f.role === 'data').map((f) => [f.path.replace(/^tb_r\./, ''), !!f.select, f.wires ? f.wires.length : 0, f.wires ? f.wires[0] : null]);
      chainWant('the fan-in marks the select and the wired bits', fan, [['dut.ld', true, 0, null], ['dut.din', false, 0, null], ['dut.dhi', false, 1, [23, 0]], ['dut.dlo', false, 23, [0, 1]]]);
    }
    // engine.xMaskStart(path, time, floor): where the run of the exact x/z bits in effect at time
    // began, not before floor ({ time, complete }; complete false at the xRunChanges cap).
    {
      const m = traceVcd(['$timescale 1ns $end', '$scope module t $end', '$var reg 4 ! a $end', '$var reg 4 " b $end', '$upscope $end', '$enddefinitions $end',
        '#0', 'b0000 !', 'b0000 "', '#10', 'b0x00 !', 'b0x00 "', '#20', 'bx000 !', 'b1x00 "', '#30', 'b0x00 !', 'b1x01 "', '#40'].join('\n'));
      const eng = cmuxTrace.createEngine({ models: { instance: async () => null, lookup: async () => null }, dump: m.provider });
      const has = typeof eng.xMaskStart === 'function';
      chainWant('engine.xMaskStart: x bits that moved and came back start at the last move', has ? await eng.xMaskStart('t.a', 35, 10) : 'none', { time: 30, complete: true });
      chainWant('engine.xMaskStart: other bits changing keep the x bits\' run', has ? await eng.xMaskStart('t.b', 35, 10) : 'none', { time: 10, complete: true });
      chainWant('engine.xMaskStart: not before floor', has ? await eng.xMaskStart('t.b', 35, 20) : 'none', { time: 20, complete: true });
    }
    // engine.xStart: where the x run in effect at a time began, from the dump (null: no x then).
    {
      const { engine } = engineFor('p', 'plain');
      const has = typeof engine.xStart === 'function';
      const got = has ? [await engine.xStart('tb_p.dut.sig', 440), await engine.xStart('tb_p.dut.nx2', 434), await engine.xStart('tb_p.dut.hq', 440), await engine.xStart('tb_p.dut.flit', 440), await engine.xStart('tb_p.dut.sig', 35), await engine.xStart('tb_p.dut.sig', 34)] : 'no xStart';
      chainWant('engine.xStart reads the start of the x run', got,
        [{ time: 35, complete: true }, { time: 32, complete: true }, { time: 35, complete: true }, null, { time: 35, complete: true }, null]);
      // A cap on the changes walked (options.xRunChanges): where it got to, not complete (4 changes:
      // 435, 425, 415, 405).
      const capped = cmuxTrace.createEngine({ models: { instance: async () => null, lookup: async () => null }, dump: engineFor('p', 'plain').vcd.provider, options: { xRunChanges: 4 } });
      chainWant('engine.xStart stops at its cap, incomplete', typeof capped.xStart === 'function' ? await capped.xStart('tb_p.dut.sig', 440) : 'no xStart', { time: 405, complete: false });
    }
    // An incomplete start (the search's cap): the chain jumps as far as it got, says so (limited),
    // and jumps again from there.
    {
      const r = (at) => ({ signal: 'r', time: at, value: 'x', since: at - 5, driver: { kind: 'proc' }, fanin: at > 100 ? [{ path: 'r', value: 'x', time: at - 1, role: 'data' }] : [{ path: 'in', value: 'x', time: at - 1, role: 'data' }] });
      const fakeIn = { signal: 'in', time: 99, value: 'x', since: 90, driver: { kind: 'topInput' }, fanin: [] };
      const c = await cmuxTrace.xChain({ path: 'r', time: 200 }, {
        step: async (p, at) => (p === 'r' ? r(at) : fakeIn),
        xStart: async (p, at) => (at - 60 > 100 ? { time: at - 60, complete: false } : { time: 100, complete: true }),
      });
      chainWant('an incomplete start jumps as far as it got, then again', [c.end.code, c.steps.map((e) => [e.signal, e.time, e.why.code, !!e.why.limited])],
        ['input', [['r', 200, 'start', false], ['r', 139, 'held', true], ['r', 100, 'held', false], ['in', 99, 'only', false]]]);
    }
    // Trace to root on a clean value (no x or z): the chain follows the value back through the data
    // inputs (mode 'value'). An input with the same value first (why 'same': that is where the value
    // came from); else the data input whose value is the oldest (why 'only' / 'earliest'). It ends
    // where a statement makes the value from no data input ('made'), at the testbench, an input, the
    // start value, or a loop; never 'noX' (that was the old answer, a dead end).
    const vrow = (c) => [c.mode, c.end.code, c.root, c.steps.map((e) => [e.signal.replace('tb_p.', ''), e.time, e.why.code])];
    // cv <= ld ? flit : cv took the flit 01 at 25 and holds it (each edge after copies cv back):
    // the flit, then the testbench.
    chainWant('a clean held value goes back to where it came from', vrow(await xp('tb_p.dut.cv', 440)),
      ['value', 'testbench', 2, [['dut.cv', 440, 'start'], ['dut.flit', 24, 'same'], ['flit', 24, 'same']]]);
    // sig = {sig[6:0], sig[7]} ^ flit at 25: 00 rotated, xor 01: the input with the same value, flit.
    chainWant('a clean value follows the input with the same value', vrow(await xp('tb_p.dut.sig', 30)),
      ['value', 'testbench', 2, [['dut.sig', 30, 'start'], ['dut.flit', 24, 'same'], ['flit', 24, 'same']]]);
    // hq <= '0 under reset: no data input; the control inputs are followed (why 'control'): the
    // reset as sampled at the last write of the 0 (the edge at 15; the reset writes it at every
    // edge), through dut's port, to the testbench.
    chainWant('a value with no data input follows its control inputs', vrow(await xp('tb_p.dut.hq', 20)),
      ['value', 'testbench', 2, [['dut.hq', 20, 'start'], ['dut.rst_n', 14, 'control'], ['rst_n', 14, 'same']]]);
    // A statement with neither (a constant): made, that statement the root.
    {
      const k = { signal: 'k', time: 10, value: '1', since: 0, trust: 'exact', driver: { kind: 'assign' }, fanin: [] };
      const c = await cmuxTrace.xChain({ path: 'k', time: 10 }, { step: async () => k });
      chainWant('a value with no input at all is made there', [c.mode, c.end.code, c.root], ['value', 'made', 0]);
    }
    // An x chain says so too.
    chainWant('an x chain is mode x', (await xp('tb_p.dut.hq', 440)).mode, 'x');
    // A dump that starts late (at 1000) with the signal x from its first sample: the x was there
    // when the dump starts (end dumpStart, no root), not uninitialised storage.
    {
      const late = traceVcd(['$timescale 1ns $end', '$scope module t $end', '$var reg 4 ! a $end', '$upscope $end', '$enddefinitions $end', '#1000', 'b0x00 !', '#1100', 'bx000 !', '#1200'].join('\n'));
      const eng = cmuxTrace.createEngine({ models: { instance: async () => null, lookup: async () => null }, dump: Object.assign({}, late.provider, { start: 1000 }) });
      chainWant('xStart at a late dump start says so', await eng.xStart('t.a', 1150), { time: 1000, complete: true, dumpStart: true });
      const r = (at) => ({ signal: 'r', time: at, value: 'x', since: at - 5, driver: { kind: 'proc' }, fanin: [{ path: 'r', value: 'x', time: at - 1, role: 'data' }] });
      const c = await cmuxTrace.xChain({ path: 'r', time: 1500 }, { step: async (p, at) => r(at), xStart: async () => ({ time: 1000, complete: true, dumpStart: true }) });
      chainWant('a held x from the dump start ends dumpStart, no root', [c.end.code, c.root, c.steps.length], ['dumpStart', -1, 1]);
    }
    // xStart failing (a helper error, a refused signal) fails the step: not a loop with a root.
    {
      const r = (at) => ({ signal: 'r', time: at, value: 'x', since: at - 5, driver: { kind: 'proc' }, fanin: [{ path: 'r', value: 'x', time: at - 1, role: 'data' }] });
      const c = await cmuxTrace.xChain({ path: 'r', time: 200 }, { step: async (p, at) => r(at), xStart: async () => { throw new Error('helper error'); } });
      chainWant('an xStart error fails the chain', [c.end.code, c.root], ['failed', -1]);
      // null (no x there after all): not that candidate; with no other, failed too.
      const n = await cmuxTrace.xChain({ path: 'r', time: 200 }, { step: async (p, at) => r(at), xStart: async () => null });
      chainWant('an xStart with no x there is no loop', [n.end.code, n.root], ['failed', -1]);
    }
    // x since the start all the way (an unreset register whose x moves): uninitialised storage.
    {
      const r = (at) => ({ signal: 'r', time: at, value: 'x', since: at - 5, driver: { kind: 'proc' }, fanin: [{ path: 'r', value: 'x', time: at - 1, role: 'data' }] });
      const c = await cmuxTrace.xChain({ path: 'r', time: 200 }, { step: async (p, at) => r(at), xStart: async () => ({ time: 0, complete: true }) });
      chainWant('a held x since the start is uninitialised', [c.end.code, c.root, c.steps.length], ['uninit', 0, 1]);
    }
    return out;
  }
  return run().then((lines) => { globalThis.__traceDone = { lines, results }; }, (error) => { globalThis.__traceDone = { lines: out.concat(['FAIL ' + (error && error.stack || error)]), results: { failures: 1 } }; });
}
