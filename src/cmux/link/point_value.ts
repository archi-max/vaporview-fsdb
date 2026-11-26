// vscode-port: point values for inline values, without vscode (unit-tested in test/point_value.test.ts).
// SPDX-License-Identifier: GPL-3.0-or-later

/** A path's value at a time: bits; undefined where the dump has no such signal; `unreadable` (the read failed or the
 *  converter refuses it); `unavailable` (the tree marks it); `noChange` (wisp result.noValue: in the dump, nothing
 *  recorded at or before the time; `reason` is the helper's text, "no value (no change recorded ...)"). */
export type PointValue = string | { kind: 'unreadable' | 'unavailable' | 'noChange'; reason: string } | undefined;

/** One wisp valueAt reply (`{values, errors, noValue}`, index k = asked[k]) as each asked id's PointValue. */
export function wispPointValues(asked: number[], result: { values?: unknown[]; errors?: unknown[]; noValue?: unknown[] }): Map<number, PointValue> {
  const values = result.values ?? [], errors = result.errors ?? [], noValue = (result.noValue ?? []) as any[];
  const byId = new Map<number, PointValue>();
  asked.forEach((id, k) => {
    if (errors[k]) { byId.set(id, { kind: 'unreadable', reason: String(errors[k]) }); }
    else if (noValue[k]?.reason === 'noChange') { byId.set(id, { kind: 'noChange', reason: String(noValue[k].text) }); }
    else if (values[k] !== null && values[k] !== undefined) { byId.set(id, String(values[k])); }
  });
  return byId;
}

/** "no value (x)" -> "x" (the hover reason). */
export const innerReason = (text: string) => text.replace(/^no value \((.*)\)$/, '$1');

/** A value that is not bits, when the dump itself answers it: noChange shows the helper's text, unreadable "not
 *  computable: <why>". undefined: the caller asks the design (the port resolver). */
export function answeredByDump(bits: PointValue, clean: (s: string) => string = (s) => s): { value: 'no value'; reason: string } | undefined {
  if (bits === undefined || typeof bits === 'string') { return undefined; }
  if (bits.kind === 'noChange') { return { value: 'no value', reason: innerReason(clean(bits.reason)) }; }
  if (bits.kind === 'unreadable') { return { value: 'no value', reason: `not computable: ${clean(bits.reason) || 'read failed'}` }; }
  return undefined;
}

/** The inline value of a name whose point value is not bits: the dump's answer if it has one (no resolver call), else
 *  `resolve()`'s. */
export async function missingValue<T>(bits: PointValue, resolve: () => Promise<T>, clean?: (s: string) => string): Promise<{ dump: { value: 'no value'; reason: string } } | { design: T }> {
  const d = answeredByDump(bits, clean);
  return d ? { dump: d } : { design: await resolve() };
}
