// vscode-port the shared inline value formatter (debugger + source link). Run: node test/riscv/run.cjs ../unit/value-format.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { formatInlineValue as f } from '../../src/cmux/shared/value_format';

assert.strictEqual(f('00010010', 8), "8'h12");
assert.strictEqual(f('00010011', 8), "8'h13");
assert.strictEqual(f('1', 1), '1');
assert.strictEqual(f('0', 1), '0');
assert.strictEqual(f('x', 1), 'x');
assert.strictEqual(f('z', 1), 'z');
assert.strictEqual(f('xxxxxxxx', 8), "8'hxx");
assert.strictEqual(f('x', 8), "8'hxx"); // (extended by its top x)
assert.strictEqual(f('0000x000', 8), "8'h0X"); // some x in a digit: X (SystemVerilog %h)
assert.strictEqual(f('0000z000', 8), "8'h0Z");
assert.strictEqual(f('zzzz0001', 8), "8'hz1");
assert.strictEqual(f('0101', 4), "4'h5");
assert.strictEqual(f('101', 3), "3'h5");
assert.strictEqual(f('10010', 5), "5'h12");
assert.strictEqual(f('00010010', 8, 'decimal'), "8'd18");
assert.strictEqual(f('0001x010', 8, 'decimal'), "8'dX");
assert.strictEqual(f('xxxxxxxx', 8, 'decimal'), "8'dx");
assert.strictEqual(f('11111110', 8, 'signed'), "-8'sd2");
assert.strictEqual(f('00000010', 8, 'signed'), "8'sd2");
assert.strictEqual(f('00010010', 8, 'binary'), "8'b00010010");
assert.strictEqual(f('00010010', 8, 'octal'), "8'o022");
assert.strictEqual(f('0'.repeat(63) + '1', 64), "64'h0000000000000001");
// CVA6 FSDB: a wide value keeps width'radix (boot_addr_i was shown 0000000000010000)
assert.strictEqual(f('0'.repeat(47) + '1' + '0'.repeat(16), 64), "64'h0000000000010000");
assert.strictEqual(f('1'.repeat(128), 128), "128'h" + 'f'.repeat(32));
assert.strictEqual(f('0'.repeat(47) + '1' + '0'.repeat(16), 64, 'decimal'), "64'd65536");
// quiet text never says a bare "no value": a short tag (at most two words), the full reason in the hover
{
  const { noValueTag, noValueInline, NO_VALUE_ENTRY } = require('../../src/cmux/shared/value_format');
  assert.strictEqual(noValueTag('no value (port copy: values not linked yet)'), 'port copy');
  assert.strictEqual(noValueTag('no value (not in the dump)'), 'not in dump');
  assert.strictEqual(noValueTag('no value (not computable: no single driver)'), 'not computable');
  assert.strictEqual(noValueTag("no value (not computable: computed names need about 3197 MiB for this file's derivation records and planner tables (an estimate), over this request's memory room (461 MiB; the helper's memory bound))"), 'memory');
  assert.strictEqual(noValueTag('no change recorded in the dump up to this time'), 'not in dump');
  assert.strictEqual(noValueTag(''), 'not computable');
  for (const r of ['port copy', 'x', 'no value (not in the dump)', '3197 MiB memory room']) { assert.ok(['port copy', 'not in dump', 'memory', 'not computable'].includes(noValueTag(r)), r); } // (the lead's four tags)
  assert.strictEqual(noValueInline('addr_i', 'no value (port copy: values not linked yet)'), 'addr_i = no value (port copy)');
  assert.ok(NO_VALUE_ENTRY.test('addr_i = no value (port copy)') && !NO_VALUE_ENTRY.test('addr_i = no value') && !NO_VALUE_ENTRY.test("addr_i = 8'h00"));
}
console.log('PASS value-format');
