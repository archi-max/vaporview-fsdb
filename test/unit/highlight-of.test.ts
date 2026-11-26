// vscode-port: what the driver highlight marks. Run: node test/riscv/run.cjs ../unit/highlight-of.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { highlightOf } from '../../src/cmux/trace/highlight_of';

const F = '/d/issue_read_operands.sv';
// (CVA6 shape: always_comb at 730-800 writes alu_valid_n = '0 at 738 and alu_valid_n[i] = 1'b1 at 755, inside a for
// loop at 748-760)
const lines = [{ kind: 'proc', loc: { file: F, line: 730, endLine: 800 }, writes: [{ src: "alu_valid_n = '0;", loc: { file: F, line: 738 } }, { src: "alu_valid_n[i] = 1'b1;", loc: { file: F, line: 755 } }] }];
const loopStep = { stmt: { loc: { file: F, line: 748, endLine: 760 } }, wrote: true };
const brief = (h: any) => h && { all: h.all.map((r: any) => [r.line, r.endLine]), active: h.active && [h.active.line, h.active.endLine] };

// The loop as the step's statement: the active line is the one write inside it, not the whole loop.
assert.deepStrictEqual(brief(highlightOf('tb.alu_valid_n', lines, loopStep, 100, 'ns')), { all: [[738, 738], [755, 755]], active: [755, 755] });
// No marker (time null, a restored session): the dim lines only, no active line (so no "at 0" note).
assert.deepStrictEqual(brief(highlightOf('tb.alu_valid_n', lines, loopStep, null, 'ns')), { all: [[738, 738], [755, 755]], active: null });
// The plain statement as the step's: that line.
assert.deepStrictEqual(brief(highlightOf('tb.alu_valid_n', lines, { stmt: { loc: { file: F, line: 738 } }, wrote: true }, 5, 'ns')).active, [738, 738]);
// Two writes inside the statement: the step does not say which ran, the statement's range stays.
const two = [{ kind: 'proc', loc: { file: F, line: 730, endLine: 800 }, writes: [{ loc: { file: F, line: 752 } }, { loc: { file: F, line: 755 } }] }];
assert.deepStrictEqual(brief(highlightOf('tb.alu_valid_n', two, loopStep, 100, 'ns')).active, [748, 760]);
// Only inferred, or did not write: no active line.
assert.strictEqual(highlightOf('tb.alu_valid_n', lines, Object.assign({}, loopStep, { inferred: true }), 100, 'ns')!.active, null);
// sv-model (the loop kept whole, CVA6 alu_valid_n): the loop is one write of the procedure, its range (748-760),
// beside 738 and the flush write at 790; the step names the loop: the loop's range is the active line, never nothing.
const opaque = [{ kind: 'proc', loc: { file: F, line: 737, endLine: 800 }, writes: [{ loc: { file: F, line: 738 } }, { loc: { file: F, line: 748, endLine: 760 } }, { loc: { file: F, line: 790 } }] }];
assert.deepStrictEqual(brief(highlightOf('tb.alu_valid_n', opaque, loopStep, 13410, 'ns')), { all: [[738, 738], [748, 760], [790, 790]], active: [748, 760] });
// A marker and no line to make active: the reason, never silently dim lines only (CVA6: a step that failed).
assert.strictEqual(highlightOf('tb.alu_valid_n', opaque, { error: 'failed', message: 'read timed out' }, 13410, 'ns')!.unknown, 'read timed out');
assert.strictEqual(highlightOf('tb.alu_valid_n', opaque, null, 13410, 'ns')!.unknown, 'no step');
// (no marker, or an answer that names no write (held, inferred): no note)
assert.strictEqual(highlightOf('tb.alu_valid_n', opaque, null, null, 'ns')!.unknown, undefined);
assert.strictEqual(highlightOf('tb.alu_valid_n', opaque, Object.assign({}, loopStep, { inferred: true }), 100, 'ns')!.unknown, undefined);
assert.strictEqual(highlightOf('tb.alu_valid_n', opaque, { stmt: { loc: { file: F, line: 737, endLine: 800 } }, wrote: false }, 100, 'ns')!.unknown, undefined);
console.log('highlight-of: ok');
