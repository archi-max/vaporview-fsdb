// Checks src/webview/riscv_disasm.ts against GNU objdump 2.43.1 output for corpus.s
// (see gen_corpus.py, make_expected.sh). Run: node test/riscv/run.cjs
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { disassembleRiscv, formatRiscvBinaryString } from "../../src/webview/riscv_disasm";

const dir = path.join(__dirname);
const corpus = zlib.gunzipSync(fs.readFileSync(path.join(dir, "corpus.txt.gz"))).toString("utf8").trim().split("\n").map((l) => {
  const [n, w] = l.split(" ");
  return { size: Number(n), word: parseInt(w, 16) };
});

const variants: [string, { abiNames: boolean; aliases: boolean }][] = [
  ["default", { abiNames: true, aliases: true }],
  ["numeric", { abiNames: false, aliases: true }],
  ["no-aliases", { abiNames: true, aliases: false }],
  ["numeric_no-aliases", { abiNames: false, aliases: false }],
];

let failures = 0;
let checked = 0;
let unknownAgree = 0;
let skippedRv64 = 0;
for (const [name, opts] of variants) {
  const lines = zlib.gunzipSync(fs.readFileSync(path.join(dir, `expected-${name}.txt.gz`))).toString("utf8").trim().split("\n");
  if (lines.length !== corpus.length) { throw new Error(`${name}: ${lines.length} lines vs ${corpus.length} encodings`); }
  lines.forEach((line, i) => {
    const sp = line.indexOf(" ");
    const addr = parseInt(line.slice(0, sp), 16);
    // objdump appends "<.text+0x..>" to branch targets and prints them without 0x.
    let want = line.slice(sp + 1).replace(/\s+#.*$/, "").replace(/ <[^>]*>$/, "").trim(); // drop "# addr" annotations
    const { word, size } = corpus[i];
    // objdump also decodes RV64-only compressed shift amounts (shamt[5]=1), which are
    // reserved on RV32. We show those as hex on purpose; skip them here.
    if (size === 2 && (word & 0x1000) && (((word & 3) === 2 && (word >> 13) === 0) || ((word & 3) === 1 && (word >> 13) === 4 && ((word >> 10) & 3) < 2))) {
      if (disassembleRiscv(word, opts) !== null) { failures++; console.log(`FAIL ${name} ${word.toString(16)}: RV32-reserved shift decoded`); }
      skippedRv64++;
      return;
    }
    const got = disassembleRiscv(word, { ...opts, pc: addr });
    checked++;
    if (want.startsWith(".insn")) {
      if (got === null) { unknownAgree++; return; }
      failures++;
      if (failures < (Number(process.env.MAXFAIL) || 40)) { console.log(`FAIL ${name} ${word.toString(16).padStart(size * 2, "0")}: objdump unknown, got "${got}"`); }
      return;
    }
    // Targets: objdump prints "j c4"; we print "j 0xc4".
    want = want.replace(/(^|,| )([0-9a-f]+)$/, (m, sep, h) => (/^(j|jal|c\.j|c\.jal|beqz|bnez|c\.beqz|c\.bnez|b\w+)\s/.test(want) ? sep + "0x" + h : m));
    if (got !== want) {
      failures++;
      if (failures < (Number(process.env.MAXFAIL) || 40)) { console.log(`FAIL ${name} ${word.toString(16).padStart(size * 2, "0")}: want "${want}" got "${got}"`); }
    }
  });
}

// Value-format wrapper behaviour.
const fmt: [string, boolean, string][] = [
  ["00000000101000000000000010010011", true, "li ra,10"],
  ["0000000000000000000000000000xxxx", false, "x"],
  ["11111111111111111111111111111111", true, "0xffffffff"],
  ["0100010100000001", true, "li a0,0"],
  ["00000000000000000000000001100011", true, "beqz zero,pc+0"],
  ["11111110101101010110111011100011", true, "bltu a0,a1,pc-4"],
];
for (const [bin, two, want] of fmt) {
  const got = formatRiscvBinaryString(bin, two, {});
  checked++;
  if (got !== want) { failures++; console.log(`FAIL format ${bin}: want "${want}" got "${got}"`); }
}

console.log(`riscv_disasm: ${checked} checks, ${failures} failures (${unknownAgree} encodings both call unknown, ${skippedRv64} RV64-only shifts shown as hex)`);
if (failures) { process.exit(1); }
