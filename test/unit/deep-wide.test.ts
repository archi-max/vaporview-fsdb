// vscode-port: big-design inputs that broke the debugger. Wide: a scope with 300,000 children (a dumped
// memory's words; CVA6's SRAM has 262,144) sorted for display without a call-stack overflow. Deep: a 20,000-level
// hierarchy walked by the debugger's allScopes (iterative). Wide: 300,000 sibling scopes walked too.
// Run: node test/riscv/run.cjs ../unit/deep-wide.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import { sortScopeChildren } from '../../src/cmux/netlist_sort';
import { DocumentWaveData } from '../../src/cmux/dap/wave-data';
import { TextInstanceResolver } from '../../src/cmux/dap/instances';
import { pushAll, minOf, maxOf } from '../../src/common/arrays';
import { inferDumpRules } from '../../src/cmux/link/path_mapping';

const N = 300000;
// wide sort (both orders); the old push(...spread) threw RangeError here
const items = [] as Array<{ name: string; type: string; contextValue?: string }>;
for (let i = N - 1; i >= 0; i--) { items.push({ name: `mem[${i}]`, type: 'Wire' }); }
items.push({ name: 'u_sub', type: 'module', contextValue: 'netlistScope' }, { name: 'W', type: 'Parameter' });
for (const sort of [false, true]) {
  const out = sortScopeChildren(items, sort);
  assert.strictEqual(out.length, N + 2);
  assert.strictEqual(out[0].name, 'u_sub'); assert.strictEqual(out[1].name, 'W');
  assert.strictEqual(out[2].name, sort ? 'mem[0]' : `mem[${N - 1}]`);
  assert.strictEqual(out[N + 1].name, sort ? `mem[${N - 1}]` : 'mem[0]');
}

// the no-spread helpers at the same width (the old a.push(...b) / Math.min(...b) threw RangeError here)
const big = Array.from({ length: N }, (_, i) => (i * 7919) % N);
assert.strictEqual(pushAll([-1], big).length, N + 1);
assert.strictEqual(minOf(big), 0); assert.strictEqual(maxOf(big), N - 1);
assert.strictEqual(minOf([]), Infinity); assert.strictEqual(maxOf([]), -Infinity);

// a fake data API: scope path -> children
function fake(children: (p: string[]) => Array<{ kind: 'scope' | 'var'; name: string }>) {
  return {
    generation: 1, metadata: { timeEnd: 10, timeScale: 1, timeUnit: 'ns' },
    async children(scope: string[] = []) { return children(scope).map((c) => ({ ...c, scopePath: scope, width: 1, msb: 0, lsb: 0 })); },
  } as any;
}
(async () => {
  const D = 20000;
  const deep = new DocumentWaveData(fake((p) => (p.length < D ? [{ kind: 'scope', name: 's' + p.length }, { kind: 'var', name: 'clk' }] : [{ kind: 'var', name: 'clk' }])));
  const all = await deep.allScopes();
  assert.strictEqual(all.length, D);
  assert.strictEqual(all[D - 1].length, D);
  const wide = new DocumentWaveData(fake((p) => (p.length === 0 ? [{ kind: 'scope', name: 'top' }] : p.length === 1 ? Array.from({ length: N }, (_, i) => ({ kind: 'scope' as const, name: 'u' + i })) : [{ kind: 'var', name: 'clk' }])));
  const w = await wide.allScopes();
  assert.strictEqual(w.length, N + 1);
  assert.deepStrictEqual(w[1], ['top', 'u0']); assert.deepStrictEqual(w[N], ['top', 'u' + (N - 1)]);
  // instance search over the deep hierarchy (the inline-values path: thisInstance -> allScopes)
  const inst = await new TextInstanceResolver().thisInstance({ name: 'm', ports: ['clk'], declared: [], start: 0, end: 1 } as any, deep);
  assert.deepStrictEqual(inst, ['s0']);
  // thisInstance reads breadth first and stops at the shallowest match: a wide earlier sibling (N scopes under 'mem')
  // is not walked before the core one level down; the answer is cached per dump object, never shared across dumps
  let calls = 0;
  const shape = (p: string[]) => { calls++; return p.length === 0 ? [{ kind: 'scope' as const, name: 'tb' }]
    : p.length === 1 ? [{ kind: 'scope' as const, name: 'mem' }, { kind: 'scope' as const, name: 'core' }]
      : p[1] === 'mem' && p.length === 2 ? Array.from({ length: N }, (_, i) => ({ kind: 'scope' as const, name: 'w' + i }))
        : p[1] === 'core' ? [{ kind: 'var' as const, name: 'clk' }, { kind: 'var' as const, name: 'pc' }] : [{ kind: 'var' as const, name: 'd' }]; };
  const r = new TextInstanceResolver();
  const coreMod = { name: 'core', ports: ['clk', 'pc'], declared: [], start: 0, end: 1 } as any;
  const d1 = new DocumentWaveData(fake(shape));
  assert.deepStrictEqual(await r.thisInstance(coreMod, d1), ['tb', 'core']);
  assert.ok(calls <= 5, 'children calls ' + calls);
  calls = 0; assert.deepStrictEqual(await r.thisInstance(coreMod, d1), ['tb', 'core']); assert.strictEqual(calls, 0, 'cached');
  const d2 = new DocumentWaveData(fake((p) => (p.length === 0 ? [{ kind: 'scope', name: 'top' }] : [{ kind: 'var', name: 'x' }])));
  assert.strictEqual(await r.thisInstance(coreMod, d2), null, 'another dump: not the first dump\'s answer');
  // source link's dump-rule search over a scope with N child scopes (queue.push(...kids) / Math.max(...) before)
const dumpKids = async (p: string[]) => (p.length === 0 ? [{ name: 'tb', isScope: true }]
    : p.length === 1 ? [{ name: 'dut', isScope: true }].concat(Array.from({ length: N }, (_, i) => ({ name: 'u' + i, isScope: true })))
      : p[1] === 'dut' && p.length === 2 ? [{ name: 'clk', isScope: false }, { name: 'rst', isScope: false }, { name: 'core', isScope: true }] : p[1] === 'dut' ? [{ name: 'pc', isScope: false }] : []);
  const rules = await inferDumpRules('top.core.pc', [{ name: 'clk', isScope: false }, { name: 'rst', isScope: false }, { name: 'core', isScope: true }], dumpKids);
  assert.strictEqual(rules.kind, 'found');
  assert.strictEqual((rules as any).rules[0].dumpPrefix, 'tb.dut');
  console.log(`PASS deep-wide: sort ${N} children, allScopes depth ${D} and ${N} siblings`);
})().catch((e) => { console.error('FAIL deep-wide', e); process.exit(1); });
