// vscode-port (shared by the debugger's inline values and the source link's, so the two never differ): a value
// as quiet inline text, with its width and radix like SystemVerilog's literals: 8'h12, 8'd18, 8'b0001_0010 without
// separators, 8'o22; one bit as 0 / 1 / x / z. x and z follow SystemVerilog's %h / %o rule: a digit whose bits are ALL
// x shows x (z: z), a digit with SOME x bits shows X (some z: Z); 0000x000 is 8'h0X, xxxxxxxx is 8'hxx. A decimal value
// with any x or z bit is x (all x), X (some x), z / Z alike, as %d prints it.
// SPDX-License-Identifier: GPL-3.0-or-later

/** `bits` one character per bit, most significant first (shorter: extended by its top x/z, else 0). */
export function formatInlineValue(bitsIn: string, width: number, radix = 'hexadecimal'): string {
  const w = Math.max(1, width | 0);
  let bits = String(bitsIn).toLowerCase();
  if (bits.length < w) { const pad = bits[0] === 'x' || bits[0] === 'z' ? bits[0] : '0'; bits = pad.repeat(w - bits.length) + bits; }
  if (bits.length > w) { bits = bits.slice(bits.length - w); }
  if (w === 1) { return /[01xz]/.test(bits) ? bits : '?'; }
  const unknown = (g: string): string | null => {
    if (!/[xz]/.test(g)) { return null; }
    if (/^x+$/.test(g)) { return 'x'; }
    if (/^z+$/.test(g)) { return 'z'; }
    return /x/.test(g) ? 'X' : 'Z';
  };
  const group = (n: number) => {
    const out: string[] = [];
    for (let e = bits.length; e > 0; e -= n) {
      const g = bits.slice(Math.max(0, e - n), e);
      const u = unknown(g);
      out.unshift(u ?? (/[^01]/.test(g) ? '?' : parseInt(g, 2).toString(n === 4 ? 16 : 8)));
    }
    return out.join('');
  };
  switch (radix) {
    case 'binary': return `${w}'b${bits}`;
    case 'octal': return `${w}'o${group(3)}`;
    case 'decimal': case 'signed': {
      const u = unknown(bits);
      if (u) { return `${w}'d${u}`; }
      if (/[^01]/.test(bits)) { return `${w}'d?`; }
      let n = BigInt('0b' + bits);
      if (radix === 'signed' && bits[0] === '1') { n -= 1n << BigInt(w); return `-${w}'sd${(-n).toString()}`; }
      return `${w}'${radix === 'signed' ? 'sd' : 'd'}${n.toString()}`;
    }
    default: return `${w}'h${group(4)}`;
  }
}

/** vscode-port: "no value" is never bare in quiet text. A short tag (one of four,
 *  from the full reason); the full reason goes in the hover. `reason`: the reader's / resolver's text, e.g. "no value
 *  (port copy: values not linked yet)", "no value (not in the dump)", "computed names need about 3197 MiB ... memory
 *  room ...", "no value (not computable: no single driver)". */
export function noValueTag(reason: string): 'port copy' | 'not in dump' | 'memory' | 'not computable' {
  const r = String(reason || '').toLowerCase();
  if (/port copy/.test(r)) { return 'port copy'; }
  if (/memory (room|bound)|\bmib\b/.test(r)) { return 'memory'; }
  if (/not in (the )?dump|not dumped|notdumped|no change recorded|no value at this time/.test(r)) { return 'not in dump'; }
  return 'not computable';
}
/** "addr_i = no value (port copy)". */
export function noValueInline(name: string, reason: string): string {
  return `${name} = no value (${noValueTag(reason)})`;
}
/** One quiet-text entry that is a no value ("name = no value (tag)"). */
export const NO_VALUE_ENTRY = /^[\w$.[\]]+ = no value \((port copy|not in dump|memory|not computable)\)$/;
