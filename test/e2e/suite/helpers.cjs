// vscode-port: helpers for e2e tests. NOTE: waveformViewer.* commands take `uri` as a STRING (String(uri)). Everything goes through public commands plus the test-only
// 'vaporview.e2e.query' (reads the webview DOM: kinds 'texts' | 'count' | 'attrs').
const vscode = require('vscode');
const path = require('path');
const assert = require('assert');
const root = process.env.E2E_ROOT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Each fn() call races the remaining deadline, so a call that never settles fails at `ms`, not at the run's limit.
async function until(fn, what, ms = 20000, step = 200) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) {
    let t;
    const left = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('call still pending at the deadline')), Math.max(1, end - Date.now())); });
    try { last = await Promise.race([Promise.resolve().then(fn), left]); if (last) return last; } catch (e) { last = e; } finally { clearTimeout(t); }
    await sleep(step);
  }
  throw new Error(`timeout waiting for ${what}; last=${JSON.stringify(last && last.message ? last.message : last)}`);
}
// vscode-port: E2E_FORMAT=fsdb|wcz|vcd (default fsdb). With fsdb/wcz every dump the tests open, x.vcd in this repo,
// is replaced by its twin <E2E_FIXTURES_FMT_DIR>/<format>/<same relative path>.vcs.<format> or .<format> (made by
// tools/fmt: a VCS run or vcd2fsdb, then wcz-from-fsdb, each content-checked against the VCD). A missing twin, an unset
// E2E_FIXTURES_FMT_DIR or a VCD outside the repo (written by the test at run time) is an error: never a silent VCD fallback.
const fs = require('fs');
const format = String(process.env.E2E_FORMAT || 'fsdb').toLowerCase();
if (!['fsdb', 'wcz', 'vcd'].includes(format)) { throw new Error(`E2E_FORMAT must be fsdb, wcz or vcd, not '${format}'`); }
const fmtDir = process.env.E2E_FIXTURES_FMT_DIR || '';
function twinPath(fsPath) {
  if (format === 'vcd' || !/\.vcd$/i.test(fsPath)) { return fsPath; }
  const rel = path.relative(root, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { throw new Error(`E2E_FORMAT=${format}: no ${format} twin for a VCD outside the repo (written at test time?): ${fsPath}; no VCD fallback`); }
  if (!fmtDir) { throw new Error(`E2E_FORMAT=${format}: E2E_FIXTURES_FMT_DIR is not set (needed for the twin of ${rel}); no VCD fallback`); }
  // Prefer the twin from a VCS run of the fixture's own sources ($fsdbDumpvars, as users dump: <rel>.vcs.fsdb, and the WCZ
  // made from it, <rel>.vcs.wcz); else the one converted from the VCD (vcd2fsdb: <rel>.fsdb, then <rel>.wcz).
  const base = path.join(fmtDir, format, rel.replace(/\.vcd$/i, ''));
  for (const t of [base + '.vcs.' + format, base + '.' + format]) { if (fs.existsSync(t)) { return t; } }
  throw new Error(`E2E_FORMAT=${format}: twin missing: ${base}.vcs.${format} / .${format} (for ${rel}); no VCD fallback`);
}
const twin = (uri) => (uri.scheme === 'file' ? vscode.Uri.file(twinPath(uri.fsPath)) : uri);
const fixture = (name) => twin(vscode.Uri.file(path.join(root, 'test/e2e/fixtures', name)));
async function activate() {
  // vscode-port: E2E_EXT_ID = an installed VSIX under test (test/e2e/run-installed.mjs); else the dev folder
  const id = process.env.E2E_EXT_ID;
  const ext = id ? vscode.extensions.getExtension(id)
    : vscode.extensions.all.find((e) => e.packageJSON && e.packageJSON.name === require(path.join(root, 'package.json')).name && e.extensionPath === root);
  if (!ext) throw new Error('extension under test not found');
  if (!ext.isActive) await ext.activate();
  return ext;
}
async function open(name) {
  await activate();
  const uri = typeof name === 'string' ? fixture(name) : twin(name); // the format twin
  // FSDB / WCZ need wisp-helper (vaporview.wispHelperPath); E2E_WISP_HELPER must name an executable one.
  if (uri.scheme === 'file' && /\.(fsdb|wcz)$/i.test(uri.fsPath)) {
    const h = process.env.E2E_WISP_HELPER || '';
    try { fs.accessSync(h, fs.constants.X_OK); } catch { throw new Error(`opening ${uri.fsPath} needs wisp-helper: E2E_WISP_HELPER='${h}' is not an executable file`); }
    const c = vscode.workspace.getConfiguration('vaporview');
    // vscode-port: an installed VSIX (E2E_EXT_ID) finds its bundled helper itself, so wispHelperPath stays
    // unset there (E2E_WISP_HELPER is that bundled helper, checked above); dev runs point the setting at E2E_WISP_HELPER
    if (!process.env.E2E_EXT_ID && c.get('wispHelperPath') !== h) { await c.update('wispHelperPath', h, vscode.ConfigurationTarget.Global); }
  }
  if (uri.scheme === 'file' && !require('fs').existsSync(uri.fsPath)) throw new Error('fixture missing: ' + uri.fsPath + ' (committed? check .gitignore)');
  await vscode.commands.executeCommand('vaporview.openFile', { uri });
  await until(async () => {
    const d = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
    const list = Array.isArray(d) ? d : (d && d.documents) || []; // upstream returns string[] (API_DOCS says {documents})
    return list.some((u) => String(u) === String(uri));
  }, 'document open');
  return uri;
}
async function query(q) {
  const r = await vscode.commands.executeCommand('vaporview.e2e.query', q);
  if (!r || r.error) throw new Error('e2e.query: ' + (r && r.error));
  return r.result;
}
const texts = (selector) => query({ kind: 'texts', selector });
async function closeAll() { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await sleep(300); }
module.exports = { activate, vscode, assert, sleep, until, fixture, open, query, texts, closeAll, root, format, twin, twinPath };
// vscode-port: t.screenshot(name), t.screenshotThemes(name), t.theme('dark'|'light'), t.idle(), t.key(k).
Object.assign(module.exports, require('../../visual/shot.cjs').create(module.exports));
