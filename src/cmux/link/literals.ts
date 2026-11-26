// vscode-port: Verilog literals for inline values, without vscode (unit-tested in test/literals.test.ts).
// one formatter with the debugger, src/cmux/shared/value_format.ts (width'radix, SystemVerilog's x / X digit
// rule, one bit bare).
// SPDX-License-Identifier: GPL-3.0-or-later
import { formatInlineValue } from '../shared/value_format';

/** `bits` (most significant first) as a sized hex literal: `3'h5`, all-x 8 bits `8'hxx`, `8'h1z`, a digit with some x
 *  `X` (`8'h0X`); one bit bare (0 / 1 / x / z). */
export function hexLiteral(bits: string): string {
  return formatInlineValue(bits, bits.length, 'hexadecimal');
}
