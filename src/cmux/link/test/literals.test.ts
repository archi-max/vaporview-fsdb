// vscode-port: inline hex literals spell x and z per digit with SystemVerilog's %h rule (all x → x,
// some x → X; z / Z alike).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { hexLiteral } from '../literals';

test('0/1 bits: plain hex, sized', () => {
  assert.equal(hexLiteral('00000010'), "8'h02");
  assert.equal(hexLiteral('101'), "3'h5");
  assert.equal(hexLiteral('1'), '1'); // one bit bare 
});

test('all x / all z: every digit spelled', () => {
  assert.equal(hexLiteral('xxxxxxxx'), "8'hxx");
  assert.equal(hexLiteral('zzzzzzzz'), "8'hzz");
  assert.equal(hexLiteral('XXXX'), "4'hx");
});

test('mixed digits: a digit with some x is X (x before z), with some z only Z; other digits keep theirs', () => {
  assert.equal(hexLiteral('0001zzzz'), "8'h1z");
  assert.equal(hexLiteral('xxxx0011'), "8'hx3");
  assert.equal(hexLiteral('x0z1'), "4'hX");
  assert.equal(hexLiteral('1x0000'), "6'hX0");
  assert.equal(hexLiteral('0000x000'), "8'h0X");
  assert.equal(hexLiteral('0000z000'), "8'h0Z");
});

test('wide values keep width\'radix (CVA6 boot_addr_i was reported as bare hex)', () => {
  assert.equal(hexLiteral('0'.repeat(47) + '1' + '0'.repeat(16)), "64'h0000000000010000");
  assert.equal(hexLiteral('1' + '0'.repeat(127)), "128'h80000000000000000000000000000000");
});
