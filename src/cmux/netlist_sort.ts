// vscode-port: a scope's netlist children in display order (scopes, then parameters, then signals; by name when
// sorting). Pure, no vscode import, so it can be unit-tested. Builds the result with concat, never push(...spread):
// a scope with ~100K+ children (a dumped memory's words, e.g. CVA6's 2 MiB SRAM at 262,144 words) overflowed the call
// stack ("Maximum call stack size exceeded") in the debugger's inline values.
// SPDX-License-Identifier: GPL-3.0-or-later
export interface SortableItem { name: string; type: string; contextValue?: string }

export function sortScopeChildren<T extends SortableItem>(items: readonly T[], sortByName: boolean): T[] {
  const scopes: T[] = [], parameters: T[] = [], signals: T[] = [];
  for (const item of items) {
    if (item.contextValue === 'netlistScope') { scopes.push(item); }
    else if (item.type === 'Parameter') { parameters.push(item); }
    else { signals.push(item); }
  }
  if (sortByName) {
    const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true });
    scopes.sort(byName); parameters.sort(byName); signals.sort(byName);
  }
  return scopes.concat(parameters, signals);
}
