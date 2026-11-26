// Unit tests for src/webview/value_search.ts (exact value search). Run: node test/riscv/run.cjs search.test.ts
import { matchBinaryExact, signedSearchBits } from "../../src/webview/value_search";

let failures = 0, checks = 0;
function eq(label: string, got: unknown, want: unknown) {
  checks++;
  if (got !== want) { failures++; console.log(`FAIL ${label}: want ${want} got ${got}`); }
}
const bin = (v: number, w: number) => v.toString(2).padStart(w, "0");
const hex = (s: string) => s.split("").map((c) => /[xz]/i.test(c) ? "...." : parseInt(c, 16).toString(2).padStart(4, "0")).join("");

// A value equals the search, as Verdi searches: hex 5 is 0x05, not "contains 0101".
eq("hex 5 = 0x05", matchBinaryExact(hex("5"), bin(0x05, 8)), true);
eq("hex 5 != 0x15", matchBinaryExact(hex("5"), bin(0x15, 8)), false);
eq("hex 5 != 0x50", matchBinaryExact(hex("5"), bin(0x50, 8)), false);
eq("hex 5 != 0x55", matchBinaryExact(hex("5"), bin(0x55, 8)), false);
eq("hex 15 = 0x15", matchBinaryExact(hex("15"), bin(0x15, 8)), true);
eq("dec 21 = 21", matchBinaryExact((21).toString(2), bin(21, 16)), true);
eq("dec 5 != 21", matchBinaryExact((5).toString(2), bin(21, 16)), false);
eq("dec 1 != 3", matchBinaryExact("1", bin(3, 8)), false);
eq("1-bit 1", matchBinaryExact("1", "1"), true);
eq("1-bit 0 != 1", matchBinaryExact("0", "1"), false);
// Longer than the signal: extra high zeros are fine, extra high ones don't fit.
eq("hex 05 on 4 bits = 5", matchBinaryExact(hex("05"), bin(5, 4)), true);
eq("hex 15 on 4 bits != 5", matchBinaryExact(hex("15"), bin(5, 4)), false);
// Wildcards and regexes still work, anchored to the whole value.
eq("hex x on 4 bits", matchBinaryExact(hex("x"), bin(9, 4)), true);
eq("hex 1x = 0x1a", matchBinaryExact(hex("1x"), bin(0x1a, 8)), true);
eq("hex 1x != 0x2a", matchBinaryExact(hex("1x"), bin(0x2a, 8)), false);
eq("hex x != 0x15 (high nibble set)", matchBinaryExact(hex("x"), bin(0x15, 8)), false);
eq("binary 1.1 = 101", matchBinaryExact("1.1", bin(5, 8)), true);
eq("binary 1.1 = 111", matchBinaryExact("1.1", bin(7, 8)), true);
eq("binary 1.1 != 1101", matchBinaryExact("1.1", bin(13, 8)), false);
eq("dont-care .* matches all", matchBinaryExact(".*", bin(0x15, 8)), true);
eq("regex .*0101.* is a substring search", matchBinaryExact(".*0101.*", bin(0x15, 8)), true);
eq("regex .*0101.* misses", matchBinaryExact(".*0101.*", bin(0x33, 8)), false);
eq("regex 0101.* is a prefix", matchBinaryExact("0101.*", "01010000"), true);
eq("bad regex is no match", matchBinaryExact("(", "0101"), false);
// x/z values are literal, any case.
eq("binary x literal", matchBinaryExact("1x", "001x"), true);
eq("binary x literal, upper", matchBinaryExact("1x", "001X"), true);
eq("binary x != 1", matchBinaryExact("1x", "0011"), false);
// Signed: the parsed form is minimal two's complement, sign-extended.
eq("signed -3 = 11111101", matchBinaryExact("101", bin(0xfd, 8), true), true);
eq("signed -3 != 00000101", matchBinaryExact("101", bin(0x05, 8), true), false);
eq("signed +5 = 00000101", matchBinaryExact("0101", bin(0x05, 8), true), true);
eq("signed +5 != 11111101", matchBinaryExact("0101", bin(0xfd, 8), true), false);
eq("signed -1 = 1111", matchBinaryExact("11", "1111", true), true);
eq("signed +5 on 4 bits", matchBinaryExact("0101", "0101", true), true);
eq("signed -3 on 2 bits doesn't fit", matchBinaryExact("101", "01", true), false);
eq("signed -1 on 1 bit", matchBinaryExact("11", "1", true), true);
// The signed format's parsed form: +5 keeps its sign bit, so it isn't -3's "101".
eq("signed parse +5", signedSearchBits("5"), "0101");
eq("signed parse -3", signedSearchBits("-3"), "101");
eq("signed parse -4", signedSearchBits("-4"), "1100");
eq("signed parse 0", signedSearchBits("0"), "0");
eq("signed parse -1", signedSearchBits("-1"), "11");
eq("signed parse 1,000", signedSearchBits("1,000"), "0" + (1000).toString(2));
eq("signed parse x", signedSearchBits("1x"), ".*");
eq("signed 5 never matches -3", matchBinaryExact(signedSearchBits("5"), bin(0xfd, 8), true), false);
eq("signed -3 never matches 5", matchBinaryExact(signedSearchBits("-3"), bin(0x05, 8), true), false);
eq("unsigned 101 != 11111101", matchBinaryExact("101", bin(0xfd, 8)), false);

console.log(`search: ${checks - failures}/${checks} passed`);
if (failures) { process.exit(1); }
