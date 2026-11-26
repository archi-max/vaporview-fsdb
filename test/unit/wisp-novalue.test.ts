// vscode-port the reader's own "no value (why)" from wisp's query() (result.noValue[i]) reaches the
// debugger's values: a value the dump has no change for up to t is never x (CVA6 FSDB packet_f_opt_ext_subformat[0]).
// Run: node test/riscv/run.cjs ../unit/wisp-novalue.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { helperQueries } from '../../src/cmux/dap/wisp-query';

const TEXT = 'no value (no change recorded in the dump up to this time)';
(async () => {
  const q = helperQueries(async () => ({ line: { result: { values: ['01', null], noValue: [null, { reason: 'noChange', text: TEXT }] } } } as any), 100);
  const v = await q.valuesAt([{ signalId: 1, width: 2 }, { signalId: 2, width: 1 }] as any, 50);
  assert.deepStrictEqual([...v], ['01', undefined]);
  assert.deepStrictEqual(v.noValue, [undefined, TEXT]);
  // an older helper (no noValue): unchanged
  const old = helperQueries(async () => ({ line: { result: { values: ['01', null] } } } as any), 100);
  const w = await old.valuesAt([{ signalId: 1, width: 2 }, { signalId: 2, width: 1 }] as any, 50);
  assert.strictEqual(w.noValue, undefined);
  console.log('PASS wisp-novalue');
})().catch((e) => { console.error(e); process.exit(1); });
