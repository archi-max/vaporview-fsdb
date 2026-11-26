// Unit tests for src/webview/value_alias.ts. Run: node test/riscv/run.cjs alias.test.ts
// The alias files below are written for these tests (not copied from any manual).
import { parseAliasFile, formatWithTable, lookupAlias, normalizeSignalPath, type ValueTable, type AliasTable } from "../../src/webview/value_alias";

let failures = 0, checks = 0;
function eq(label: string, got: unknown, want: unknown) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.log(`FAIL ${label}: want ${w} got ${g}`); }
}
function tableMap(tables: ValueTable[]) { return new Map(tables.map((t) => [t.name, t])); }
const bin = (v: number, w: number) => v.toString(2).padStart(w, "0");

// Flat file: entries without a block go to a table named after the file.
{
  const f = parseAliasFile(`# opcode names
LOAD 03
STORE 23
OP_IMM 13
"BRANCH op" 7'b1100011
MASKED 8'b1?1?0000
RANGE 8'h40~8'h4f ID_GREEN5
`, "opcodes.alias");
  const t = tableMap(f.tables);
  eq("flat tables", [...t.keys()], ["opcodes"]);
  eq("bare hex", formatWithTable(t, "opcodes", bin(0x23, 7)), "STORE");
  eq("bare hex 13", formatWithTable(t, "opcodes", bin(0x13, 7)), "OP_IMM");
  eq("quoted name", formatWithTable(t, "opcodes", "1100011"), "BRANCH op");
  eq("wildcard", formatWithTable(t, "opcodes", "10110000"), "MASKED");
  eq("wildcard miss", formatWithTable(t, "opcodes", "10110001"), "b1");
  eq("range", formatWithTable(t, "opcodes", bin(0x47, 8)), "RANGE");
  eq("color kept", (f.tables[0] as any).entries[5].color, "ID_GREEN5");
  eq("unmatched hex", formatWithTable(t, "opcodes", bin(0x99, 8)), "99");
  eq("x value shows hex nibbles", formatWithTable(t, "opcodes", "1x"), "x");
  eq("x/z nibbles", formatWithTable(t, "opcodes", "0001xxxx00z1"), "1xz");
  eq("warnings", f.warnings, []);
}

// Blocks, others, old-style block, slices (incl. reversed and radix), curAliasTable, condAlias.
{
  const f = parseAliasFile(`
ALIAS fsm
  IDLE   2'd0
  RUN    2'd1
  "WAIT X" 2'd2
  OTHER  others
ENDALIAS
alias wide
  LOW-HALF 4'h0~4'h7
endalias
# older style, no end keyword
flag
  OFF 'h0
  ON  'h1
SLICE ctl
  7:6 fsm
  5:2 wide
  1
  0 flag
ENDSLICE
slice rev
  0:3 wide
endslice
slice radix
  7:4 Binary
  3:0 decimal
endslice
condAlias pick
  /top/a fsm
endcondAlias
curAliasTable ctl
`, "ctl.alias");
  const t = tableMap(f.tables);
  eq("block names", [...t.keys()], ["fsm", "wide", "flag", "ctl", "rev", "radix"]);
  eq("default table", f.defaultTable, "ctl");
  eq("condAlias warned", f.warnings.length, 1);
  eq("fsm", formatWithTable(t, "fsm", "10"), "WAIT X");
  eq("others", formatWithTable(t, "fsm", "11"), "OTHER");
  // 8'b01_0011_1_1 -> fsm(01)=RUN, wide(0011)=LOW-HALF, bit1=1 (hex), flag(1)=ON
  eq("slice", formatWithTable(t, "ctl", "01001111"), "RUN LOW-HALF 1 ON");
  // 8'b11_1000_0_0 -> OTHER, 1000 not in wide -> 8, 0, OFF
  eq("slice miss", formatWithTable(t, "ctl", "11100000"), "OTHER 8 0 OFF");
  eq("slice x", formatWithTable(t, "ctl", "x1001111"), "* LOW-HALF 1 ON");
  // bits 3..0 = 1110, reversed 0111 = 7 -> LOW-HALF
  eq("reversed slice", formatWithTable(t, "rev", "00001110"), "LOW-HALF");
  eq("radix slice", formatWithTable(t, "radix", "10101100"), "1010 12");
}

// Verdi resource-file forms: aliasmapname/nalias, slicemapname/nslice, aliasname + addSignal.
{
  const f = parseAliasFile(`aliasmapname ack
nalias NAK 0 NULL
nalias ACK 1 NULL
slicemapname bus_s
nslice 7:4 Hexadecimal
nslice 3:0 ack
aliasname bus_s
addSignal -h 15 -UNSIGNED -HEX /tb/dut/bus[7:0]
`, "session.rc");
  const t = tableMap(f.tables);
  eq("rc tables", [...t.keys()], ["ack", "bus_s"]);
  eq("rc binding", f.bindings, [{ signal: "tb.dut.bus", table: "bus_s" }]);
  eq("rc slice", formatWithTable(t, "bus_s", "10100001"), "a ACK");
}

// JSON
{
  const f = parseAliasFile(JSON.stringify({
    tables: { state: { "0": "IDLE", "1": "FETCH", "0x2": "DECODE", "3~5": "EXEC", "others": "?" },
              list: [{ value: "4'b1??1", name: "ODDHIGH", color: "#f80" }] },
    signals: { "top.cpu.state": "state", "/top/cpu/st2[2:0]": "state" },
  }), "maps.json");
  const t = tableMap(f.tables);
  eq("json tables", [...t.keys()], ["state", "list"]);
  eq("json dec", formatWithTable(t, "state", "001"), "FETCH");
  eq("json 0x", formatWithTable(t, "state", "010"), "DECODE");
  eq("json range", formatWithTable(t, "state", "100"), "EXEC");
  eq("json others", formatWithTable(t, "state", "111"), "?");
  eq("json list", formatWithTable(t, "list", "1011"), "ODDHIGH");
  eq("json bindings", f.bindings, [{ signal: "top.cpu.state", table: "state" }, { signal: "top.cpu.st2", table: "state" }]);
  const g = parseAliasFile(JSON.stringify({ op: { "51": "OP", "19": "OP_IMM" } }), "short.json");
  eq("json shorthand", formatWithTable(tableMap(g.tables), "op", bin(51, 7)), "OP");
}

// CSV
{
  const a = parseAliasFile(`10,TEN\n"0x0b","ELEVEN, quoted"\n`, "simple.csv");
  const ta = tableMap(a.tables);
  eq("csv 2col", formatWithTable(ta, "simple", bin(10, 8)), "TEN");
  eq("csv quoted", formatWithTable(ta, "simple", bin(11, 8)), "ELEVEN, quoted");
  const b = parseAliasFile(`signal,value,name,color\ntop.u.state,0,IDLE,\ntop.u.state,1,BUSY,#0f0\n/top/u/mode,2'b1?,HI,\n`, "sig.csv");
  eq("csv signal tables", b.tables.map((x) => x.name), ["top.u.state", "top.u.mode"]);
  eq("csv bindings", b.bindings, [{ signal: "top.u.state", table: "top.u.state" }, { signal: "top.u.mode", table: "top.u.mode" }]);
  eq("csv signal lookup", formatWithTable(tableMap(b.tables), "top.u.mode", "10"), "HI");
  const c = parseAliasFile(`opc,0x33,OP\nopc,0x13,OP_IMM\nfn3,0,ADD\n`, "three.csv");
  eq("csv 3col", formatWithTable(tableMap(c.tables), "opc", bin(0x13, 7)), "OP_IMM");
}

// Regressions from review a396e12.
{
  // M1: names with &, < and > come back as plain text (escaping happens at the HTML sink).
  const f = parseAliasFile(`alias t\n"R&W" 1\n"A<B>" 2\nendalias\n`, "m1.alias");
  eq("M1 raw text", formatWithTable(tableMap(f.tables), "t", "01"), "R&W");
  eq("M1 raw text 2", formatWithTable(tableMap(f.tables), "t", "10"), "A<B>");

  // M2: absurd widths and digit counts are rejected quickly with a warning.
  const t0 = Date.now();
  const g = parseAliasFile(`alias t\nA 100000000'h0\nB 1073741824'h0\nC 0~${"f".repeat(100000)}\nD 4096'h1\nendalias\n`, "m2.alias");
  eq("M2 rejected", g.warnings.length, 3);
  eq("M2 4096 bits ok", (g.tables[0] as AliasTable).entries.map((e) => e.name), ["D"]);
  eq("M2 fast", Date.now() - t0 < 200, true);

  // M4: a missing value inside a block warns instead of starting a new table; keyword
  // names with another shape stay entries.
  const h = parseAliasFile(`alias st\n IDLE 0\n RUN\n DONE 2\n alias 3\n slice 4\nendalias\n`, "m4.alias");
  eq("M4 one table", h.tables.map((x) => x.name), ["st"]);
  eq("M4 DONE kept", formatWithTable(tableMap(h.tables), "st", "10"), "DONE");
  eq("M4 keyword-named entries", (h.tables[0] as AliasTable).entries.map((e) => e.name), ["IDLE", "DONE", "alias", "slice"]);
  eq("M4 warning", h.warnings.some((w) => w.includes("RUN")), true);
  // Old-style bare blocks still chain.
  const h2 = parseAliasFile(`a1\n X 0\na2\n Y 0\n`, "old.alias");
  eq("M4 bare blocks", h2.tables.map((x) => x.name), ["a1", "a2"]);

  // L3: path normalisation is linear.
  const t1 = Date.now();
  normalizeSignalPath("[".repeat(80000));
  eq("L3 fast", Date.now() - t1 < 100, true);
  eq("L3 strips range", normalizeSignalPath("/top/u/sig[31:0]"), "top.u.sig");

  // L4: trailing comments.
  const c = parseAliasFile(`IDLE 0 # reset state\nRUN 1 ID_RED5 // running\n"#1" 2\n`, "l4.alias");
  eq("L4 entries", (c.tables[0] as AliasTable).entries.map((e) => e.name + ":" + (e.color ?? "")), ["IDLE:", "RUN:ID_RED5", "#1:"]);
  eq("L4 no warnings", c.warnings, []);

  // L5: bad JSON shapes become warnings, never exceptions.
  for (const bad of ["null", "[1]", "{", '{"slices":{"s":[null]}}', '{"tables":5}', '{"t":7}', '{"signals":[1]}']) {
    let threw = false;
    let warned = false;
    try { warned = parseAliasFile(bad, "x.json").warnings.length > 0; } catch { threw = true; }
    eq(`L5 ${bad}`, [threw, warned], [false, true]);
  }

  // L6: bad bareRadix warns and falls back.
  const r = parseAliasFile(`ONE 1\n`, "r.alias", { bareRadix: "foo" as any });
  eq("L6 warns", r.warnings.length, 1);
  eq("L6 fallback", formatWithTable(tableMap(r.tables), "r", "1"), "ONE");

  // L8: 3-column CSV with a color, line numbers in warnings.
  const v = parseAliasFile(`# header comment\n1,ONE,#ff0000\n\n2,TWO,#00f\nbad,X\n`, "l8.csv");
  eq("L8 color column", (v.tables[0] as AliasTable).entries.map((e) => e.name + ":" + e.color), ["ONE:#ff0000", "TWO:#00f"]);
  eq("L8 line number", v.warnings, ['line 5: cannot parse value "bad"']);

  // L9: compiled lookup keeps file order across exact, wildcard and range entries.
  const o = parseAliasFile(`alias t\nWILD 4'b1??0\nEXACT 4'b1010\nRANGE 4'h8~4'hf\nLATE 4'b1100\nREST others\nendalias\n`, "o.alias");
  const ot = o.tables[0] as AliasTable;
  eq("L9 wildcard before exact", lookupAlias(ot, "1010")?.name, "WILD");
  eq("L9 range before later exact", lookupAlias(ot, "1101")?.name, "RANGE");
  eq("L9 exact with leading zeros", lookupAlias(ot, "000001010")?.name, "WILD");
  eq("L9 others", lookupAlias(ot, "0001")?.name, "REST");
  eq("L9 x not others", lookupAlias(ot, "000x"), undefined);

  // rc files: other commands are ignored, aliasname binds only the next signal.
  const rc = parseAliasFile(`viewPort 0 0 1 1\naliasmapname st\nnalias A 0 NULL\naliasname st\naddSignal -h 15 /t/a[1:0]\naddSignal -h 15 /t/b\n`, "x.rc");
  eq("rc quiet", rc.warnings, []);
  eq("rc one binding", rc.bindings, [{ signal: "t.a", table: "st" }]);
}

// Regressions from review dc84742.
{
  // N2: resource-file lines mixed into an alias file keep both kinds of table.
  const m = parseAliasFile(`alias t\n A 1\nendalias\naliasmapname u\nnalias B 2 NULL\nslicemapname s\nnslice 3:2 u\nnslice 1:0 t\naliasname s\naddSignal -h 15 /top/st[3:0]\nC 3\n`, "mixed.alias");
  eq("N2 tables", m.tables.map((x) => x.name), ["t", "u", "s", "mixed"]);
  eq("N2 alias kept", formatWithTable(tableMap(m.tables), "t", "1"), "A");
  eq("N2 rc slice", formatWithTable(tableMap(m.tables), "s", "1001"), "B A");
  eq("N2 binding", m.bindings, [{ signal: "top.st", table: "s" }]);
  eq("N2 rc block ends at next line", formatWithTable(tableMap(m.tables), "mixed", "11"), "C");
  eq("N2 no warnings", m.warnings, []);

  // N3: 3-column CSV: only a #color after a parseable value is value,name,color.
  const c = parseAliasFile(`t,1,NULL\nst,3,ID_X\n4,FOUR,#0f0\n`, "n3.csv");
  eq("N3 tables", c.tables.map((x) => x.name), ["t", "st", "n3"]);
  eq("N3 NULL is a name", formatWithTable(tableMap(c.tables), "t", "1"), "NULL");
  eq("N3 color", (c.tables[2] as AliasTable).entries[0].color, "#0f0");

  // N4: a final #rgb token in a Verdi file is a color; "#word ..." is a comment.
  const v = parseAliasFile(`IDLE 0 #f00\nRUN 1 #add more text\nWAIT 2 # note\n`, "n4.alias");
  eq("N4 entries", (v.tables[0] as AliasTable).entries.map((e) => e.name + ":" + (e.color ?? "")), ["IDLE:#f00", "RUN:", "WAIT:"]);
  eq("N4 no warnings", v.warnings, []);
}

console.log(`value_alias: ${checks} checks, ${failures} failures`);
if (failures) { process.exit(1); }
