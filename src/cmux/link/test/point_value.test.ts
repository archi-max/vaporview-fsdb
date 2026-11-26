// vscode-port: inline values from a wisp valueAt reply with result.noValue (no change recorded up to t):
// the helper's text, and the design resolver is never asked.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { wispPointValues, missingValue, answeredByDump } from '../point_value';

const NO_CHANGE_TEXT = 'no value (no change recorded in the dump up to this time)'; // wisp_handler.ts NO_CHANGE_TEXT

test('a valueAt reply: values, errors and noValue[k] map to each asked id', () => {
  const m = wispPointValues([7, 3, 9, 4], {
    values: ['0101', null, null, null],
    errors: [null, null, 'refused: stored history starts after the dump start', null],
    noValue: [null, { reason: 'noChange', text: NO_CHANGE_TEXT }, null, null],
  });
  assert.equal(m.get(7), '0101');
  assert.deepEqual(m.get(3), { kind: 'noChange', reason: NO_CHANGE_TEXT });
  assert.deepEqual(m.get(9), { kind: 'unreadable', reason: 'refused: stored history starts after the dump start' });
  assert.equal(m.get(4), undefined); // not answered: the dump lacks it
});

test('a reply without noValue (older helper) keeps working', () => {
  const m = wispPointValues([1], { values: ['1'] });
  assert.equal(m.get(1), '1');
});

test('noChange: "no value" with the helper text, no resolver call', async () => {
  let calls = 0;
  const bits = wispPointValues([3], { values: [null], noValue: [{ reason: 'noChange', text: NO_CHANGE_TEXT }] }).get(3);
  const r = await missingValue(bits, async () => { calls++; return 'resolved'; });
  assert.deepEqual(r, { dump: { value: 'no value', reason: 'no change recorded in the dump up to this time' } });
  assert.equal(calls, 0);
});

test('unreadable: "not computable: <why>", no resolver call', async () => {
  let calls = 0;
  const r = await missingValue({ kind: 'unreadable', reason: 'refused: x' }, async () => { calls++; return 'resolved'; });
  assert.deepEqual(r, { dump: { value: 'no value', reason: 'not computable: refused: x' } });
  assert.equal(calls, 0);
});

test('a name the dump lacks (and unavailable) goes to the resolver once', async () => {
  for (const bits of [undefined, { kind: 'unavailable' as const, reason: 'absent' }]) {
    let calls = 0;
    const r = await missingValue(bits, async () => { calls++; return 'via en1'; });
    assert.deepEqual(r, { design: 'via en1' });
    assert.equal(calls, 1);
    assert.equal(answeredByDump(bits), undefined);
  }
});
