// vscode-port: e2e against an INSTALLED VSIX on a clean profile (the release acceptance bar).
// Installs the VSIX with `code --install-extension` into a fresh --extensions-dir and --user-data-dir, then runs the
// same suite (test/e2e/suite) inside that VS Code. The dev folder is NOT loaded: the development path is an empty stub
// extension, and the suite finds the extension under test by id (E2E_EXT_ID).
// Usage: node test/e2e/run-installed.mjs <file.vsix> [also-install.vsix ...]
// Env: VSCODE_VERSION (default stable), E2E_FILTER, E2E_DISABLE (ids started disabled), E2E_WCZ (a WCZ for the helper check), E2E_KEEP=1 (keep the profile dirs and print them),
//      E2E_SV_MODEL_CACHE (default: a fresh empty dir; the run fails if anything was built into it, i.e. the prebuilt
//      sv-model of a platform VSIX was not used. E2E_SV_MODEL_BUILD_OK=1 allows a build: the universal VSIX).
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [vsix, ...also] = process.argv.slice(2).map((p) => path.resolve(p));
if (!vsix || !fs.existsSync(vsix)) { console.error('usage: run-installed.mjs <file.vsix> [also.vsix ...]'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-installed-'));
const extDir = path.join(tmp, 'extensions'), userData = path.join(tmp, 'user-data'), stub = path.join(tmp, 'stub');
const svCache = process.env.E2E_SV_MODEL_CACHE || path.join(tmp, 'sv-model-cache');
fs.mkdirSync(stub, { recursive: true }); fs.mkdirSync(svCache, { recursive: true });
// the stub "development" extension: no code, no contributions (runTests needs a development path)
fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: 'e2e-installed-stub', publisher: 'e2e', version: '0.0.0', engines: { vscode: '*' } }));

let rc = 1;
try {
  let exe = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
  // VS Code >= 1.147 on macOS names its binary Contents/MacOS/Code; test-electron 2.5.2 returns .../Electron (as run.mjs)
  if (!fs.existsSync(exe) && fs.existsSync(path.join(path.dirname(exe), 'Code'))) exe = path.join(path.dirname(exe), 'Code');
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
  const idOf = (v) => { // publisher.name from a VSIX's own manifest
    const r = spawnSync('unzip', ['-p', v, 'extension/package.json']);
    const pj = JSON.parse(r.stdout.toString()); return `${pj.publisher}.${pj.name}`;
  };
  const id = idOf(vsix);
  const alsoIds = also.map(idOf);
  for (const v of [vsix, ...also]) {
    const r = spawnSync(cli, [...cliArgs, '--extensions-dir', extDir, '--user-data-dir', userData, '--install-extension', v, '--force'], { encoding: 'utf8' });
    console.log(`install ${path.basename(v)}: exit ${r.status} ${(r.stdout + r.stderr).trim().split('\n').slice(-1)[0]}`);
    if (r.status !== 0) throw new Error('install failed: ' + r.stderr);
  }
  const list = spawnSync(cli, [...cliArgs, '--extensions-dir', extDir, '--user-data-dir', userData, '--list-extensions', '--show-versions'], { encoding: 'utf8' });
  console.log('installed:', list.stdout.trim().split('\n').join(', '));
  // what was installed is the VSIX (no dev folder): print its folder and the native programs' modes
  const installedDir = fs.readdirSync(extDir).find((d) => d.toLowerCase().startsWith(id.toLowerCase() + '-'));
  console.log('extension folder:', installedDir);
  const bin = path.join(extDir, installedDir, 'bin');
  if (fs.existsSync(bin)) {
    for (const f of spawnSync('find', [bin, '-type', 'f'], { encoding: 'utf8' }).stdout.trim().split('\n')) {
      const st = fs.statSync(f); console.log(`  ${path.relative(extDir, f)} mode ${(st.mode & 0o777).toString(8)}`);
    }
  }
  // vscode-port: the suite's FSDB / WCZ tests use the helper bundled in the installed VSIX (never a dev build)
  const bundledHelper = path.join(bin, `${process.platform}-${process.arch}`, 'wisp-helper');
  if (!fs.existsSync(bundledHelper)) { throw new Error(`installed VSIX has no bundled wisp-helper at ${bundledHelper}`); }
  const opts = {
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: stub,
    extensionTestsPath: path.join(root, 'test/e2e/suite/index.cjs'),
    // vscode-port: E2E_WORKSPACE=<dir under test/e2e/fixtures, or an absolute path> opens that folder (link-profiles)
    launchArgs: [path.resolve(root, 'test/e2e/fixtures', process.env.E2E_WORKSPACE || ''), `--extensions-dir=${extDir}`, '--disable-gpu', '--disable-workspace-trust',
      '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`,
      // E2E_DISABLE: extension ids to start disabled (e.g. upstream VaporView installed next to ours)
      ...(process.env.E2E_DISABLE || '').split(',').filter(Boolean).map((x) => `--disable-extension=${x}`)],
    extensionTestsEnv: { VAPORVIEW_E2E: '1', E2E_FILTER: process.env.E2E_FILTER || '', E2E_EXCLUDE: process.env.E2E_EXCLUDE || '', E2E_ROOT: root, E2E_EXT_ID: id,
      VAPORVIEW_CMUX_CACHE: svCache, E2E_ALSO_IDS: alsoIds.join(','), E2E_DISABLE: process.env.E2E_DISABLE || '', E2E_WCZ: process.env.E2E_WCZ || '', E2E_FSDB: process.env.E2E_FSDB || '', E2E_FORMAT: process.env.E2E_FORMAT || 'fsdb', E2E_WISP_HELPER: bundledHelper, E2E_FIXTURES_FMT_DIR: process.env.E2E_FIXTURES_FMT_DIR || '', E2E_DEMO_FILES: process.env.E2E_DEMO_FILES || '', E2E_FSDB_WINDOWED: process.env.E2E_FSDB_WINDOWED || '', E2E_WCZ_WINDOWED: process.env.E2E_WCZ_WINDOWED || '', E2E_LONGTASKS_OPTIONAL: process.env.E2E_LONGTASKS_OPTIONAL || '',
      // vscode-port: the big demo design folder (suite/demo-big.test.cjs)
      E2E_DEMO_BIG: process.env.E2E_DEMO_BIG || '', E2E_DEMO_UNDUMPED: process.env.E2E_DEMO_UNDUMPED || '',
      // vscode-port: demo folder for suite/demo-trace.test.cjs
      E2E_DEMO_TRACE: process.env.E2E_DEMO_TRACE || '',
      // vscode-port: demo folder for suite/demo-scope.test.cjs (wisp settings from folder settings)
      E2E_DEMO_SCOPE: process.env.E2E_DEMO_SCOPE || '',
      // vscode-port: the shipped c-debugger demo folder for suite/demo-dbg.test.cjs
      E2E_DEMO_DBG: process.env.E2E_DEMO_DBG || '' },
  };
  // vscode-port: E2E_HIDDEN=1 on macOS runs VS Code under Playwright's Electron driver with every window
  // invisible (opacity 0, no Dock icon, hidden app) and unfocused, as test/e2e/run.mjs does: no window on the user's screen.
  if (process.env.E2E_HIDDEN === '1' && process.platform === 'darwin') { await runHidden(opts); } else { await runTests(opts); }
  const built = fs.existsSync(path.join(svCache, 'sv-model')) ? fs.readdirSync(path.join(svCache, 'sv-model')) : [];
  if (built.length && process.env.E2E_SV_MODEL_BUILD_OK !== '1') throw new Error(`sv-model was built on first use (${built.join(',')}): the prebuilt was not used`);
  console.log(`sv-model first-use builds during the run: ${built.length ? built.join(',') : 'none'}`);
  console.log(`E2E INSTALLED PASS ${id} from ${path.basename(vsix)}`);
  rc = 0;
} catch (e) {
  console.error('E2E INSTALLED FAIL', e && e.message ? e.message : e);
} finally {
  if (process.env.E2E_KEEP === '1') console.log('kept', tmp); else fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = rc;
}

async function runHidden(o) {
  const { _electron } = await import('playwright-core');
  const app = await _electron.launch({
    executablePath: o.vscodeExecutablePath,
    args: [...o.launchArgs, `--extensionDevelopmentPath=${o.extensionDevelopmentPath}`, `--extensionTestsPath=${o.extensionTestsPath}`],
    env: { ...process.env, ...o.extensionTestsEnv },
    timeout: 120000,
  });
  const proc = app.process();
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code === null ? 1 : code)));
  proc.stdout.on('data', (d) => process.stdout.write(d));
  proc.stderr.on('data', (d) => process.stderr.write(d));
  const hide = () => app.evaluate(({ app: a, BrowserWindow }) => {
    try { a.dock && a.dock.hide(); } catch {}
    for (const w of BrowserWindow.getAllWindows()) { if (w.getOpacity() !== 0) { w.setOpacity(0); w.blur(); } }
    try { a.hide(); } catch {}
  }).catch(() => {});
  let done = false;
  const keep = (async () => { while (!done) { await hide(); await new Promise((r) => setTimeout(r, 250)); } })();
  const code = await exited;
  done = true; await keep;
  if (code) { throw new Error(`Test run failed with code ${code}`); }
}
