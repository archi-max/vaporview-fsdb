// vscode-port: what a per-signal error in a helper reply (result.errors[i], result.signals[i].error) means
// for the user. Only a read that failed on the file's bytes is "damaged" (red status + error message). Every other
// answer the helper gives for a signal it does not read (a computed signal it answers in windows only, a code block
// that writes part of a value, a value the converted file does not carry, too many changes for one window, ...) is a
// limit, not damage: a warning that says what it is, never red.
export type SignalErrorClass = 'damaged' | 'limit' | 'unknown';

// The helper's answers for a signal it does not read that are limits, not damage (15.12; wording as it sends them).
// Anything else (e.g. "block 0: segment 1 footer: block 2 not where the previous one ends", a flipped-bytes WCZ) is a
// failed read of the file and stays "damaged": an unknown message is never downgraded.
const LIMIT = new RegExp([
  'computed signal answers window requests only',
  'code block writes only part of its value',
  'stored value not carried in the converted file',
  'too many changes in one window',
  'no value at this time',
  'text \\(string/real\\) signal has no bit values',
  'need a 1-bit signal',
  'not computable',
  'not supported',
  'values not linked',
  'memory room',
  'memory bound',
  // the computed route's per-name reasons (outsideWrites none, seen on CVA6): what the rules cannot derive yet
  'constant used as a value',
  'not proven',
  'not established',
  'beyond the record',
  'without a value at a merge',
].join('|'), 'i');

// A failed read of the file's bytes, as the helper words it (a WCZ whose footer does not line up: "block 0: segment 1
// footer: block 2 not where the previous one ends"; checksums, decompression, truncation).
const BYTES = /\bblock\b|\bsegment\b|footer|header|checksum|\bcrc\b|corrupt|damag|truncat|decompress|inflate|unexpected end|short read|i\/o error/i;

// computed: the error is for a signal the helper computes (outsideWrites none). Every per-signal refusal on that path is
// a known limit of the rules (the reader's wording can change), unless it is a failed read of the bytes.
export function classifySignalError(e: string, computed = false): SignalErrorClass {
  const s = String(e);
  if (LIMIT.test(s)) {return 'limit';}
  if (BYTES.test(s)) {return 'damaged';}
  return computed ? 'limit' : 'unknown';
}

// What a computed signal's row and the value API say for a per-signal refusal (null: a byte failure, said as such).
export function computedNoValueText(e: string): string | null {
  if (/computed names need about \d+ MiB .*memory room/i.test(String(e))) {return 'no value (computed signals need more memory than vaporview.wisp.planBudgetMB allows)';}
  return classifySignalError(e, true) === 'damaged' ? null : `no value (not computable: ${String(e)})`;
}

// vscode-port: answers that are expected, not failures: the signal is fine, it just has nothing to give
// this request (a port copy the dump does not store, a computed signal read in windows, no value at that time, a text
// signal asked for bits, a window too dense at this zoom). They are said as a neutral note, never counted in "N signals
// can't be read" (a CVA6 debug stop said "337 signals can't be read" for answers like these).
export type SignalNoteKind = 'portCopy' | 'windowOnly' | 'noValueAtTime' | 'textBits' | 'oneBit' | 'dense';
const NOTES: Array<[SignalNoteKind, RegExp, (n: number) => string]> = [
  ['portCopy', /values not linked|port cop(y|ies)/i, (n) => `${n} port ${n === 1 ? 'copy has' : 'copies have'} no stored values (vaporview.wisp.outsideWrites)`],
  ['windowOnly', /computed signal answers window requests only/i, (n) => `${n} computed ${n === 1 ? 'signal is' : 'signals are'} read in windows only`],
  ['noValueAtTime', /no value at this time/i, (n) => `${n} ${n === 1 ? 'signal has' : 'signals have'} no value at that time`],
  ['textBits', /text \(string\/real\) signal has no bit values/i, (n) => `${n} text ${n === 1 ? 'signal has' : 'signals have'} no bit values`],
  ['oneBit', /need a 1-bit signal/i, (n) => `${n} ${n === 1 ? 'signal is' : 'signals are'} not 1-bit (edge search)`],
  ['dense', /too many changes in one window/i, (n) => `${n} ${n === 1 ? 'signal is' : 'signals are'} too dense at this zoom`],
];
export function signalNoteKind(e: string): SignalNoteKind | null {
  for (const [k, re] of NOTES) {if (re.test(String(e))) {return k;}}
  return null;
}
function noteTexts(notes: Map<string, number>): string[] {
  return NOTES.filter(([k]) => (notes.get(k) || 0) > 0).map(([k, , t]) => t(notes.get(k)!));
}

// The status bar text and the message for what one file's replies said so far: damage (red, "may be damaged"), else an
// unknown failure (red, says only that the signals can't be read and why), else limits (a warning).
// notes: SignalNoteKind -> distinct signals (expected answers; level 'note' when there is nothing else).
export function signalErrorStatus(file: string, damaged: string[], limits: Map<string, number>, unknown: Map<string, number> = new Map(), notes: Map<string, number> = new Map()): {level: 'error' | 'warning' | 'note'; text: string; message: string} | null {
  const nt = noteTexts(notes);
  const also = nt.length ? ` (also: ${nt.join('; ')})` : '';
  if (damaged.length) {
    return {level: 'error', text: '$(warning) Waveform: unreadable signals', message: `${file}: some signals cannot be read (the file may be damaged): ${damaged[0]}${also}`};
  }
  const say = (m: Map<string, number>) => {
    const n = [...m.values()].reduce((a, b) => a + b, 0);
    const reasons = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([r, k]) => (m.size > 1 ? `${r} (${k})` : r));
    return {n, sig: n === 1 ? 'signal' : 'signals', reasons: reasons.join('; ')};
  };
  if (unknown.size) {
    const u = say(unknown);
    return {level: 'error', text: `$(warning) Waveform: ${u.n} ${u.sig} can't be read`, message: `${file}: ${u.n} ${u.sig} can't be read: ${u.reasons}${also}`};
  }
  if (!limits.size) {
    if (!nt.length) {return null;}
    return {level: 'note', text: `$(info) Waveform: ${nt[0]}${nt.length > 1 ? ` (+${nt.length - 1} more)` : ''}`, message: `${file}: ${nt.join('; ')}`};
  }
  const l = say(limits);
  return {level: 'warning', text: `$(info) Waveform: ${l.n} ${l.sig} can't be read`, message: `${file}: ${l.n} ${l.sig} can't be read: ${l.reasons}${also}`};
}
