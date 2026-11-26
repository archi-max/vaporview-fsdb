// vscode-port: the helper's memory bound follows vaporview.wisp.planBudgetMB; wisp.env and the environment win.
// Run: node test/unit/wisp-memory-env.cjs
const path = require('path'), os = require('os'), assert = require('assert');
const esbuild = require(path.join(__dirname, '../../node_modules/esbuild'));
const out = path.join(os.tmpdir(), 'vv-memory-env-' + process.pid + '.cjs');
let cfg = {};
globalThis.__vvCfg = (k) => cfg[k];
const stub = { name: 'vscode-stub', setup(b) {
  b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { workspace: { getConfiguration: () => ({ get: (k) => globalThis.__vvCfg(k) }) } };', loader: 'js' }));
} };
esbuild.build({ entryPoints: [path.join(__dirname, '../../src/cmux/wisp/locate.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error', plugins: [stub] }).then(() => {
  const { helperLaunch, planBudgetMB, workerBoundMB } = require(out);
  delete process.env.WISP_WORKER_RSS_MB; delete process.env.RUN_PLAN_BUDGET_MB;
  const auto = planBudgetMB('auto', os.totalmem());
  const ram40 = Math.floor(os.totalmem() * 0.4 / 1048576);
  let e = helperLaunch().env;
  // auto is also capped at 8 GiB (the plan budget itself is not)
  assert.strictEqual(e.WISP_WORKER_RSS_MB, String(Math.min(8192, Math.max(1024, Math.min(auto, ram40))))); assert.strictEqual(e.RUN_PLAN_BUDGET_MB, String(auto));
  assert.ok(auto >= 4096, String(auto));
  cfg = { 'wisp.planBudgetMB': '5000' }; e = helperLaunch().env;
  assert.strictEqual(e.WISP_WORKER_RSS_MB, String(Math.max(1024, Math.min(5000, ram40))));
  // the load-refusal line (2 x the bound) stays at or under 80% of RAM; never under the helper's 1024 default
  const G = 1024 ** 3;
  for (const ram of [8, 16, 64, 256]) {
    const b = planBudgetMB('auto', ram * G), wb = workerBoundMB(b, ram * G, true);
    assert.ok(2 * wb <= Math.max(2048, 0.8 * ram * 1024), `${ram} GiB: worker ${wb}`);
  }
  assert.strictEqual(workerBoundMB(planBudgetMB('auto', 8 * G), 8 * G, true), 3276);
  // the 62 GiB host of the 10 GB FSDB: 25 GiB before (a ~19 GB computed build ran 32.7 s), 8 GiB now
  assert.strictEqual(workerBoundMB(planBudgetMB('auto', 62 * G), 62 * G, true), 8192);
  assert.strictEqual(workerBoundMB(planBudgetMB('auto', 256 * G), 256 * G, true), 8192);
  // a number the user sets is not capped (only by 40% of RAM)
  assert.strictEqual(workerBoundMB(planBudgetMB('20000', 62 * G), 62 * G, false), 20000);
  cfg = { 'wisp.planBudgetMB': '20000' }; e = helperLaunch().env;
  assert.strictEqual(e.WISP_WORKER_RSS_MB, String(Math.max(1024, Math.min(20000, ram40))));
  cfg = {};
  assert.strictEqual(workerBoundMB(64, 64 * G), 1024);
  assert.strictEqual(workerBoundMB(null, 64 * G), null);
  cfg = { 'wisp.planBudgetMB': 'off' }; e = helperLaunch().env;
  assert.strictEqual(e.WISP_WORKER_RSS_MB, undefined); assert.strictEqual(e.RUN_PLAN_BUDGET_MB, undefined);
  cfg = { 'wisp.planBudgetMB': '5000', 'wisp.env': { WISP_WORKER_RSS_MB: '1500' } }; e = helperLaunch().env;
  assert.strictEqual(e.WISP_WORKER_RSS_MB, '1500');
  cfg = {}; process.env.WISP_WORKER_RSS_MB = '1234'; e = helperLaunch().env;
  assert.strictEqual(e.WISP_WORKER_RSS_MB, '1234');
  delete process.env.WISP_WORKER_RSS_MB;
  require('fs').rmSync(out, { force: true });
  console.log('wisp-memory-env: PASS');
});
