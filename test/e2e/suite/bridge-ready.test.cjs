// vscode-port: the webview's 'ready' (a few hundred ms after an open) must not bump the data generation.
// It did (bridge_host 'ready' -> reloaded()), so a Trace, debugger search or value read started in that gap ended as
// "reloaded". Reads run from the moment the document exists until after the first 'ready'; none may see "reloaded" and
// the generation must not move. A real reload (vaporview.reloadFile) still bumps it. FSDB, then WCZ (E2E_FORMAT).
const fs = require('fs'), path = require('path');
const { vscode, assert, until, open, closeAll, format } = require('./helpers.cjs');
const { cmuxData, pageReady } = require('./bridge-helpers.cjs');

const probe = async (uri, refs, ms) => {
  const r = await vscode.commands.executeCommand('vaporview.e2e.cmuxReadyProbe', String(uri), refs, ms);
  if (!r || r.error) { throw new Error('cmuxReadyProbe: ' + (r && r.error)); }
  return r.result;
};

// Open `uri` fresh (closed first) and read `refs` from before its first 'ready' until `ms` later.
async function straddle(uri, refs, ms) {
  await closeAll();
  const opening = vscode.commands.executeCommand('vaporview.openFile', { uri });
  const p = await probe(uri, refs, ms);
  await opening;
  await pageReady();
  return p;
}

function check(what, p) {
  const s = `${what}: ${JSON.stringify(p)}`;
  assert.strictEqual(p.ready0, 0, 'the reads started before the first ready: ' + s);
  assert.ok(p.ready1 >= 1, 'the first ready landed while reading: ' + s);
  assert.ok(p.readsBeforeReady >= 1 && p.okAfterReady >= 1, 'reads on both sides of the first ready: ' + s);
  assert.deepStrictEqual(p.errors, [], 'no read ended as "reloaded": ' + s);
  assert.strictEqual(p.g1, p.g0, 'the data generation did not move: ' + s);
  console.log(`  ${what}: ${p.readsBeforeReady} reads before ready, ${p.okAfterReady} after, generation ${p.g0} -> ${p.g1}`);
}

module.exports = {
  [`the first 'ready' after an open bumps no generation and no read sees "reloaded" (counter, ${format})`]: async () => {
    const uri = await open('counter.vcd'); // (sets the helper; then reopened fresh below)
    const p = await straddle(uri, ['top.cnt', 'top.instr'], 3000);
    check('counter.' + format, p);
    // a real reload still bumps it
    const g = p.g1;
    await vscode.commands.executeCommand('vaporview.reloadFile', uri);
    await until(async () => { try { return (await cmuxData('valueAt', 'top.cnt', 0)) !== undefined; } catch { return false; } }, 'reloaded', 30000, 200);
    const after = await probe(uri, ['top.cnt'], 50);
    assert.ok(after.g0 > g, `vaporview.reloadFile bumps the generation: ${g} -> ${after.g0}`);
    await closeAll();
  },

  [`the first 'ready' after an open of a real VCS dump (bigsoc25k.${format}): no "reloaded", no generation bump`]: async () => {
    if (format === 'vcd') { console.log('SKIP bridge-ready bigsoc25k: no VCD of this dump (E2E_FORMAT=vcd)'); return; }
    const dir = process.env.E2E_FSDB_DIR || '';
    const file = dir && path.join(dir, 'bigsoc25k.' + format);
    if (!file || !fs.existsSync(file)) { console.log(`SKIP bridge-ready bigsoc25k: no bigsoc25k.${format} (E2E_FSDB_DIR=${dir || 'unset'})`); return; }
    await closeAll();
    const uri = await open(vscode.Uri.file(file));
    await pageReady();
    // the first 4 variables breadth first
    const refs = [];
    const queue = (await until(async () => { const t = await cmuxData('children'); return t && t.length ? t : null; }, 'top scopes')).filter((k) => k.kind === 'scope').map((k) => k.name);
    for (let seen = 0; queue.length && refs.length < 4 && seen < 200; seen++) {
      const scope = queue.shift();
      const kids = (await cmuxData('children', scope)) || [];
      kids.filter((k) => k.kind !== 'scope').slice(0, 4 - refs.length).forEach((k) => refs.push(scope + '.' + k.name));
      kids.filter((k) => k.kind === 'scope').forEach((k) => queue.push(scope + '.' + k.name));
    }
    assert.ok(refs.length >= 1, 'variables in bigsoc25k');
    check('bigsoc25k.' + format + ' ' + refs.join(','), await straddle(uri, refs, 4000));
    await closeAll();
  },
};
