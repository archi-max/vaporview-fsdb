// vscode-port: e2e helpers for the cmux bridge tests (test-only commands, VAPORVIEW_E2E=1).
const { vscode, until } = require('./helpers.cjs');

// Every call races a 30 s deadline, so a stalled read fails the test instead of the whole run's time limit.
function deadline(p, what, ms = 30000) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('stalled: ' + what)), ms); })]).finally(() => clearTimeout(t));
}
async function cmuxData(method, ...args) {
  const r = await deadline(vscode.commands.executeCommand('vaporview.e2e.cmuxData', method, ...args), 'cmuxData ' + method);
  if (!r || r.error) { throw new Error('cmuxData ' + method + ': ' + (r && r.error)); }
  return r.result;
}
async function page(fn, args) {
  const r = await deadline(vscode.commands.executeCommand('vaporview.e2e.cmuxEval', String(fn), args), 'cmuxEval');
  if (!r || r.error) { throw new Error('cmuxEval: ' + (r && r.error)); }
  return r.result;
}
// The page bridge has the dump once VaporView posted 'initialized' and the 'opened' RPC answered.
const pageReady = () => until(() => page((cmux) => !!cmux.host.currentBackend && !!cmux.host.doc.metadata), 'page bridge ready', 30000, 300);

module.exports = { cmuxData, page, pageReady };
