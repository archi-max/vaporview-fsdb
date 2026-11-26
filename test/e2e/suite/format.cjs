// vscode-port: the dump format a trace suite runs on (FSDB first, then WCZ). Built on helpers.cjs
// E2E_FORMAT = fsdb (default) | wcz | vcd; twins under E2E_FIXTURES_FMT_DIR; a missing twin throws.
//   twinPath(vcd):  helpers' rule: the VCS-run twin (<rel>.vcs.<fmt>) when there is one, else the converted one.
//   sameTwin(vcd):  the twin converted from this VCD (<rel>.<fmt>: vcd2fsdb, then wcz; content-checked against it).
//                   Trace tests whose expected chains come from the VCD's own values use this one: a VCS run of the
//                   same sources is another simulation (other X propagation), so its exact chains differ.
//   openAsIs(file): opens a file as it is (no twin), for the VCD reference arm of a VCD-vs-twin comparison.
// FORMAT is '' under vcd, so callers can test `if (FORMAT)`.
const fs = require('fs'), path = require('path');
const h = require('./helpers.cjs');

const FORMAT = h.format === 'vcd' ? '' : h.format;
const FMT_DIR = process.env.E2E_FIXTURES_FMT_DIR || '';
function sameTwin(vcd) {
  if (!FORMAT) { return vcd; }
  const rel = path.relative(h.root, vcd);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { throw new Error(`E2E_FORMAT=${FORMAT}: no twin for a VCD outside the repo: ${vcd}`); }
  const f = path.join(FMT_DIR, FORMAT, rel.replace(/\.vcd$/i, '.' + FORMAT));
  if (!FMT_DIR || !fs.existsSync(f)) { throw new Error(`E2E_FORMAT=${FORMAT}: converted twin missing: ${f} (E2E_FIXTURES_FMT_DIR=${FMT_DIR || 'unset'}); no VCD fallback`); }
  return f;
}
async function openAsIs(file) {
  await h.activate();
  const uri = h.vscode.Uri.file(file);
  await h.vscode.commands.executeCommand('vaporview.openFile', { uri });
  await h.until(async () => {
    const d = await h.vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
    const list = Array.isArray(d) ? d : (d && d.documents) || [];
    return list.some((u) => String(u) === String(uri));
  }, 'document open');
  return uri;
}
module.exports = { FORMAT, FMT_DIR, twinPath: h.twinPath, sameTwin, openAsIs };
