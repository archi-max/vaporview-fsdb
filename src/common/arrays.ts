// vscode-port: array helpers that never spread an array into call arguments. `a.push(...b)` and `Math.min(...b)`
// pass every element as an argument and throw RangeError ("Maximum call stack size exceeded") past ~100K elements;
// on FSDB/WCZ these arrays grow with design width (a scope's children, a memory's words, a search's hits).
// SPDX-License-Identifier: GPL-3.0-or-later

/** Appends every item of `src` to `dst` (any length); returns `dst`. */
export function pushAll<T>(dst: T[], src: readonly T[]): T[] {
  for (let i = 0; i < src.length; i++) { dst.push(src[i]); }
  return dst;
}

/** The smallest number in `xs` (Infinity when empty, like Math.min()). */
export function minOf(xs: readonly number[]): number {
  let m = Infinity;
  for (let i = 0; i < xs.length; i++) { if (xs[i] < m) { m = xs[i]; } }
  return m;
}

/** The largest number in `xs` (-Infinity when empty, like Math.max()). */
export function maxOf(xs: readonly number[]): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) { if (xs[i] > m) { m = xs[i]; } }
  return m;
}
