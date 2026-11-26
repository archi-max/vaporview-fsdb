// vscode-port: Split > By Declared Dimensions, ported from cmux (GPL-3.0)
// Packages/Shared/CmuxSyntaxHighlighting/.../SlangPackedDimensions.swift (the type parser) and
// Resources/vaporview/cmux-commands.js (declaredParts, the width and slice-count checks).
// A dump flattens a packed array to one vector; slang-server's getScope `type` text says where its elements are.
// SPDX-License-Identifier: GPL-3.0-or-later

/** One packed dimension as declared: `[left:right]`. */
export type PackedRange = [left: number, right: number];

const MAX_DIMENSIONS = 8;
const MAX_WIDTH = 1 << 20;
/** Most slices one split adds (cmux MAX_SLICES). */
export const MAX_SLICES = 256;

const count = ([l, r]: PackedRange) => Math.abs(l - r) + 1;
export const packedWidth = (dims: PackedRange[]) => dims.reduce((w, d) => (w > MAX_WIDTH ? w : w * count(d)), 1);

/** `logic[1:0][31:0]` (or `output logic[1:0][31:0]`, `bit`, `reg`, `signed`) -> [1,0], [31,0].
 *  Undefined for one dimension or none, an element type whose width the text doesn't give (a struct, an enum:
 *  `pair_t[1:0]`), an unpacked array (`...$[0:3]`), and anything else. slang resolves parameters and spells out
 *  typedefs of plain vectors, so bounds are numbers. */
export function parsePackedDims(text: string | undefined): PackedRange[] | undefined {
  if (!text) { return undefined; }
  const words = text.trim().split(' ').filter((w) => w.length);
  if (words.length && ['input', 'output', 'inout', 'ref'].includes(words[0])) { words.shift(); }
  const last = words[words.length - 1];
  const bracket = last ? last.indexOf('[') : -1;
  if (!last || bracket < 0) { return undefined; }
  const head = words.slice(0, -1).concat(bracket > 0 ? [last.slice(0, bracket)] : []);
  const base = head.filter((w) => w !== 'signed' && w !== 'unsigned');
  if (base.length !== 1 || !['logic', 'bit', 'reg'].includes(base[0])) { return undefined; }
  const ranges: PackedRange[] = [];
  let rest = last.slice(bracket);
  while (rest.length) {
    const close = rest.indexOf(']');
    if (rest[0] !== '[' || close < 0) { return undefined; }
    const bounds = rest.slice(1, close).split(':');
    if (bounds.length !== 2 || !bounds.every((b) => /^-?\d+$/.test(b))) { return undefined; }
    ranges.push([parseInt(bounds[0], 10), parseInt(bounds[1], 10)]);
    rest = rest.slice(close + 1);
  }
  if (ranges.length < 2 || ranges.length > MAX_DIMENSIONS || packedWidth(ranges) > MAX_WIDTH) { return undefined; }
  return ranges;
}

export interface SlicePart { msb: number; lsb: number; name: string; parts?: SlicePart[] }

/** dims as nested parts of a block of their width, bits from 0: the row splits by its outer dimension, each element by
 *  the next, down to the last (its bits). Elements are listed as declared, left index first (at the top bits). */
export function declaredParts(dims: PackedRange[], name: string): SlicePart[] {
  if (dims.length < 2) { return []; }
  const [left, right] = dims[0];
  const inner = dims.slice(1).reduce((w, d) => w * count(d), 1);
  const parts: SlicePart[] = [];
  const step = left >= right ? -1 : 1;
  for (let k = left; step < 0 ? k >= right : k <= right; k += step) {
    const lsb = Math.abs(k - right) * inner;
    const part: SlicePart = { msb: lsb + inner - 1, lsb, name: name + '[' + k + ']' };
    if (dims.length > 2) { part.parts = declaredParts(dims.slice(1), part.name); }
    parts.push(part);
  }
  return parts;
}

export const countParts = (parts: SlicePart[]): number => parts.reduce((n, p) => n + 1 + countParts(p.parts || []), 0);
