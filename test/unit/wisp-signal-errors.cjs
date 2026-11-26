// vscode-port: per-signal helper errors -> damaged (red) vs can't-be-read (warning). Run: node test/unit/wisp-signal-errors.cjs
const path = require('path'), os = require('os'), assert = require('assert');
const esbuild = require(path.join(__dirname, '../../node_modules/esbuild'));
const out = path.join(os.tmpdir(), 'vv-signal-errors-' + process.pid + '.cjs');
esbuild.build({ entryPoints: [path.join(__dirname, '../../src/cmux/wisp/signal_errors.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' }).then(() => {
  const { classifySignalError: c, signalErrorStatus: st, computedNoValueText: cnv, signalNoteKind: nk } = require(out);
  for (const e of ['a computed signal answers window requests only', 'code block writes only part of its value', 'stored value not carried in the converted file',
    'too many changes in one window to answer exactly', 'no value at this time', 'a text (string/real) signal has no bit values', 'edge: posedge, negedge and edge need a 1-bit signal',
    'constant used as a value', 'not proven: u81', 'arg ref beyond the record (operand numbering not established)', 'a part without a value at a merge time (fill not established)',
    "computed names need about 3197 MiB for this file's derivation records and planner tables (an estimate), over this request's memory room (462 MiB; the helper's memory bound)"]) { assert.strictEqual(c(e), 'limit', e); }
  for (const e of ['block checksum mismatch', 'corrupt value block at 0x1f00', 'truncated record', 'decompress failed: invalid stored block lengths', 'the file is damaged here', 'unexpected end of file', 'bad block header', 'block 0: segment 1 footer: block 2 not where the previous one ends']) { assert.strictEqual(c(e), 'damaged', e); }
  for (const e of ['unknown signal #12', 'something else went wrong']) { assert.strictEqual(c(e), 'unknown', e); }
  // rule: any per-signal refusal for a COMPUTED signal is a limit unless the bytes failed (the reader's wording may change)
  const five = ['constant used as a value', 'not proven: u81', 'arg ref beyond the record (operand numbering not established)', 'a part without a value at a merge time (fill not established)', 'code block writes only part of its value'];
  for (const e of five.concat(['some new reason the rules give', 'unknown signal #12'])) { assert.strictEqual(c(e, true), 'limit', e); }
  assert.strictEqual(c('some new reason the rules give'), 'unknown');
  assert.strictEqual(c('truncated record', true), 'damaged');
  assert.strictEqual(cnv('not proven: u81'), 'no value (not computable: not proven: u81)');
  assert.strictEqual(cnv('block checksum mismatch'), null);
  assert.strictEqual(cnv("computed names need about 3197 MiB for this file's derivation records and planner tables (an estimate), over this request's memory room (1237 MiB; the helper's memory bound)"), 'no value (computed signals need more memory than vaporview.wisp.planBudgetMB allows)');
  const u = st('h.fsdb', [], new Map([['code block writes only part of its value', 1]]), new Map([['something else went wrong', 2]]));
  assert.deepStrictEqual(u, { level: 'error', text: "$(warning) Waveform: 2 signals can't be read", message: "h.fsdb: 2 signals can't be read: something else went wrong" });
  assert.strictEqual(st('h.fsdb', [], new Map()), null);
  const w = st('h.fsdb', [], new Map([['a computed signal answers window requests only', 3], ['code block writes only part of its value', 1]]));
  assert.strictEqual(w.level, 'warning'); assert.ok(!/damaged/.test(w.message), w.message);
  assert.strictEqual(w.text, "$(info) Waveform: 4 signals can't be read");
  assert.strictEqual(w.message, "h.fsdb: 4 signals can't be read: a computed signal answers window requests only (3); code block writes only part of its value (1)");
  const one = st('h.fsdb', [], new Map([['code block writes only part of its value', 1]]));
  assert.strictEqual(one.message, "h.fsdb: 1 signal can't be read: code block writes only part of its value");
  const d = st('h.fsdb', ['truncated record'], new Map([['x', 1]]));
  assert.strictEqual(d.level, 'error'); assert.ok(/may be damaged/.test(d.message), d.message);
  // expected answers are a neutral note, not "can't be read" (CVA6 debug stop: "337 signals can't be read")
  assert.strictEqual(nk('port copy: values not linked yet'), 'portCopy');
  assert.strictEqual(nk('a computed signal answers window requests only'), 'windowOnly');
  assert.strictEqual(nk('no value at this time'), 'noValueAtTime');
  assert.strictEqual(nk('a text (string/real) signal has no bit values'), 'textBits');
  assert.strictEqual(nk('edge: posedge, negedge and edge need a 1-bit signal'), 'oneBit');
  assert.strictEqual(nk('too many changes in one window to answer exactly'), 'dense');
  for (const e of ['code block writes only part of its value', 'stored value not carried in the converted file', 'not proven: u81', 'truncated record', 'something else went wrong']) { assert.strictEqual(nk(e), null, e); }
  const n1 = st('h.fsdb', [], new Map(), new Map(), new Map([['portCopy', 337]]));
  assert.deepStrictEqual(n1, { level: 'note', text: '$(info) Waveform: 337 port copies have no stored values (vaporview.wisp.outsideWrites)', message: 'h.fsdb: 337 port copies have no stored values (vaporview.wisp.outsideWrites)' });
  const n2 = st('h.fsdb', [], new Map(), new Map(), new Map([['noValueAtTime', 1], ['windowOnly', 2]]));
  assert.deepStrictEqual(n2, { level: 'note', text: '$(info) Waveform: 2 computed signals are read in windows only (+1 more)', message: 'h.fsdb: 2 computed signals are read in windows only; 1 signal has no value at that time' });
  const n3 = st('h.fsdb', [], new Map([['code block writes only part of its value', 2]]), new Map(), new Map([['portCopy', 5]]));
  assert.deepStrictEqual(n3, { level: 'warning', text: "$(info) Waveform: 2 signals can't be read", message: "h.fsdb: 2 signals can't be read: code block writes only part of its value (also: 5 port copies have no stored values (vaporview.wisp.outsideWrites))" });
  require('fs').rmSync(out, { force: true });
  console.log('wisp-signal-errors: PASS');
});
