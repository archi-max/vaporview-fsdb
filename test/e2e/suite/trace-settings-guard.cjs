// vscode-port: a trace suite that sets vaporview.trace.* (designArgs, designRoot, prepare, xprop; wisp.outsideWrites) puts
// back what it found when it ends, also when tests fail, so later suites start from the settings they had (trace-wisp
// left a Global designArgs a.f/p.f that broke wisp-values in a full run). Global and Workspace values. As keepDesign:
// read before the first test, restored after the last (tests in a suite may rely on the design an earlier one set).
// keepTraceSettings(tests) wraps a suite's tests. (Not a *.test.cjs file: the runner does not load it as a suite.)
const { vscode } = require('./helpers.cjs');
const KEYS = ['trace.designArgs', 'trace.designRoot', 'trace.prepare', 'trace.xprop', 'wisp.outsideWrites'];
const T = vscode.ConfigurationTarget;

function snapshot() {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  return KEYS.map((k) => { const i = cfg.inspect(k) || {}; return [k, i.globalValue, i.workspaceValue]; });
}
async function restore(snap) {
  const cfg = vscode.workspace.getConfiguration('vaporview');
  for (const [k, g, w] of snap) {
    const i = cfg.inspect(k) || {};
    if (JSON.stringify(i.globalValue) !== JSON.stringify(g)) { await cfg.update(k, g, T.Global); }
    if (vscode.workspace.workspaceFolders && JSON.stringify(i.workspaceValue) !== JSON.stringify(w)) { await cfg.update(k, w, T.Workspace); }
  }
  const after = snapshot();
  if (JSON.stringify(after) !== JSON.stringify(snap)) { throw new Error(`trace settings not restored: was ${JSON.stringify(snap)}, now ${JSON.stringify(after)}`); }
}

exports.keepTraceSettings = (tests) => {
  const names = Object.keys(tests);
  let snap = null;
  const out = {};
  names.forEach((name, i) => {
    out[name] = async (t) => {
      if (i === 0 || snap === null) { snap = snapshot(); }
      try { return await tests[name](t); }
      finally { if (i === names.length - 1) { const s = snap; snap = null; await restore(s); } }
    };
  });
  return out;
};
