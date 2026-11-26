// vscode-port: a suite that picks a slang design (setTopLevel) puts the previous one back when it ends, so
// later suites start from the design state they found (trace-design's "no design yet" failed after link-p5-values).
// keepDesign(tests): the state is read before the first test and restored after the last, also when tests fail.
// (Not a *.test.cjs file: the runner does not load it as a suite.)
const { vscode } = require('./helpers.cjs');
const status = () => vscode.commands.executeCommand('vaporview.sourceLink.profileStatus');

async function restoreDesign(before) {
  const now = (await status())?.compilation ?? { explore: false };
  if (JSON.stringify(now) === JSON.stringify(before)) { return; }
  const t = before?.target;
  if (t?.kind === 'topLevel') { await vscode.commands.executeCommand('vaporview.sourceLink.setTopLevel', { uri: vscode.Uri.file(t.path).toString() }); }
  else if (t?.kind === 'buildFile') { await vscode.commands.executeCommand('vaporview.sourceLink.useAsBuildFile', vscode.Uri.file(t.path)); }
  else if (before?.explore) { await vscode.commands.executeCommand('vaporview.sourceLink.exploreMode'); }
  else if (now.target?.kind === 'buildFile') { await vscode.commands.executeCommand('vaporview.sourceLink.clearBuildFile'); }
  else { await vscode.commands.executeCommand('vaporview.sourceLink.resetTopLevel'); }
  const after = (await status())?.compilation ?? { explore: false };
  if (JSON.stringify(after) !== JSON.stringify(before ?? { explore: false })) {
    throw new Error(`design not restored: was ${JSON.stringify(before)}, now ${JSON.stringify(after)}`);
  }
}

exports.keepDesign = (tests) => {
  const names = Object.keys(tests);
  let before;
  const out = {};
  names.forEach((name, i) => {
    out[name] = async (t) => {
      if (i === 0) { before = (await status().then((s) => s?.compilation, () => undefined)) ?? { explore: false }; }
      try { return await tests[name](t); }
      finally { if (i === names.length - 1) { await restoreDesign(before); } }
    };
  });
  return out;
};
