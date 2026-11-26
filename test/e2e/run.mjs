// vscode-port: headless e2e runner. Launches a real VS Code with this extension and runs test/e2e/suite/*.test.js.
// Linux: run under xvfb-run (tools/linux-test.sh). macOS: runs a real window.
// Env: VSCODE_VERSION (default 'stable'), E2E_FILTER (substring of test file names).
// E2E_EXTENSIONS_DIR : run with the extensions in that dir enabled (e.g. the slang extension) instead of
// --disable-extensions. E2E_SLANG_ROUTE: the slang route the link tests must see ('extension' | 'own').
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The Mac window is 1440x840: a 1600x1000 content area does not fit a 14-inch display (1512x982 points; macOS clamps
// it to 895 px). Mac baselines (baseline-mac/) are separate from the Linux ones anyway.
const MAC_W = 1440, MAC_H = 840;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-'));
// vscode-port: E2E_VISUAL=1 runs test/visual/*.visual.cjs with fixed settings (theme, zoom, fonts, no
// chat/minimap/tips, solid cursor, no animations) and a pinned VS Code, so screenshots compare across runs.
const visual = process.env.E2E_VISUAL === '1';
if (visual) {
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  const vs = JSON.parse(fs.readFileSync(path.join(root, 'test/visual/settings.json'), 'utf8'));
  // FSDB / WCZ shots (E2E_FORMAT, ) read through wisp-helper: point the extension at the run's helper (a
  // checkout has no packaged bin/ helper). Not visible in any shot.
  if (process.env.E2E_WISP_HELPER) { vs['vaporview.wispHelperPath'] = process.env.E2E_WISP_HELPER; }
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(vs, null, 2));
}
const version = process.env.VSCODE_VERSION || (visual ? fs.readFileSync(path.join(root, 'test/visual/VSCODE_VERSION'), 'utf8').trim() : 'stable');
// vscode-port: VS Code >= 1.147 on macOS names its binary Contents/MacOS/Code, while
// test-electron 2.5.2 still spawns Contents/MacOS/Electron (spawn ... ENOENT). Use the binary that exists.
let vscodeExecutablePath = await downloadAndUnzipVSCode(version);
if (!fs.existsSync(vscodeExecutablePath) && fs.existsSync(path.join(path.dirname(vscodeExecutablePath), 'Code'))) {
  vscodeExecutablePath = path.join(path.dirname(vscodeExecutablePath), 'Code');
}
// vscode-port: E2E_NOSRC=1 opens an empty temp folder (no SystemVerilog sources) as the workspace instead of
// test/e2e/fixtures, for link-nosrc (the link must not start slang-server there). Dumps still open by absolute path.
// E2E_WORKSPACE=<dir under test/e2e/fixtures> : open that folder instead (link-profiles: its own .slang/ profiles).
const workspace = process.env.E2E_NOSRC === '1' ? fs.mkdtempSync(path.join(os.tmpdir(), 'vv-nosrc-'))
  // (an absolute E2E_WORKSPACE, a folder or a .code-workspace file, opens as given: demo-sweep opens the demo)
  : path.isAbsolute(process.env.E2E_WORKSPACE || '') ? process.env.E2E_WORKSPACE
  : path.join(root, 'test/e2e/fixtures', process.env.E2E_WORKSPACE || '');
// vscode-port: E2E_EXT_PATH runs the tests against another build of the extension (an installed one,
// for demo-sweep: its dist carries the same env-guarded e2e hooks); default this checkout.
const extPath = process.env.E2E_EXT_PATH || root;
const launchArgs = [workspace,
  // vscode-port: visual runs without E2E_EXTENSIONS_DIR get an empty extensions dir and NO --disable-extensions.
  // --disable-extensions raises a late "All installed extensions are temporarily disabled" toast (seen again on
  // 9785a6c with the empty dir too), which closes the row menu mid-scenario and keeps shots from settling; with an empty
  // extensions dir there is nothing to disable, so the flag is dropped.
  ...(process.env.E2E_EXTENSIONS_DIR ? [`--extensions-dir=${process.env.E2E_EXTENSIONS_DIR}`]
    : visual ? [`--extensions-dir=${path.join(userData, 'extensions')}`] : ['--disable-extensions']), '--disable-gpu', '--disable-workspace-trust',
  '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`,
  ...(process.env.SCALE_CDP_PORT ? [`--remote-debugging-port=${process.env.SCALE_CDP_PORT}`] : [])]; // webview profiling
const testsEnv = { VAPORVIEW_E2E: '1', E2E_FILTER: process.env.E2E_FILTER || '', E2E_EXCLUDE: process.env.E2E_EXCLUDE || '', E2E_ROOT: root, E2E_VISUAL: visual ? '1' : '', E2E_SLANG_ROUTE: process.env.E2E_SLANG_ROUTE || '',
  // vscode-port: wisp-helper tests
  E2E_FSDB_DIR: process.env.E2E_FSDB_DIR || '', E2E_WISP_HELPER: process.env.E2E_WISP_HELPER || '', E2E_WCZ_TOOLS: process.env.E2E_WCZ_TOOLS || '',
  // vscode-port: fixture format (fsdb | wcz | vcd; default fsdb) and the twins' root (test/e2e/suite/helpers.cjs)
  E2E_FORMAT: process.env.E2E_FORMAT || 'fsdb', E2E_FIXTURES_FMT_DIR: process.env.E2E_FIXTURES_FMT_DIR || '',
  // vscode-port: link-add-perf's big FSDB and its 100 signal paths (internal file on the test host)
  E2E_BIG_FSDB: process.env.E2E_BIG_FSDB || '', E2E_BIG_PATHS: process.env.E2E_BIG_PATHS || '', E2E_NOSRC: process.env.E2E_NOSRC || '',
  // vscode-port: wisp-close-mem's files (internal FSDB on the test host; WCZ generated when unset)
  E2E_CLOSE_MEM_FSDB: process.env.E2E_CLOSE_MEM_FSDB || '', E2E_CLOSE_MEM_WCZ: process.env.E2E_CLOSE_MEM_WCZ || '', E2E_CLOSE_MEM_MAX_MB: process.env.E2E_CLOSE_MEM_MAX_MB || '',
  // vscode-port: scale matrix files + result file
  SCALE_FILES: process.env.SCALE_FILES || '', SCALE_OUT: process.env.SCALE_OUT || '', SCALE_MIN_AVAIL_MB: process.env.SCALE_MIN_AVAIL_MB || '', SCALE_HOLD_S: process.env.SCALE_HOLD_S || '', SCALE_PROF: process.env.SCALE_PROF || '', SCALE_PROF_DIR: process.env.SCALE_PROF_DIR || '', SCALE_CDP_PORT: process.env.SCALE_CDP_PORT || '', SCALE_PROF_SCOPE: process.env.SCALE_PROF_SCOPE || '', SCALE_PROF_N: process.env.SCALE_PROF_N || '', SCALE_HEAPPROF: process.env.SCALE_HEAPPROF || '', SCALE_HEAPSNAP: process.env.SCALE_HEAPSNAP || '', SCALE_SEARCH_N: process.env.SCALE_SEARCH_N || '',
  // vscode-port: demo-sweep (test/e2e/suite/demo-sweep.test.cjs)
  E2E_EXT_ID: process.env.E2E_EXT_ID || '', DEMO_DIR: process.env.DEMO_DIR || '', DEMO_FOLDERS: process.env.DEMO_FOLDERS || '', DEMO_N: process.env.DEMO_N || '', DEMO_SEED: process.env.DEMO_SEED || '', DEMO_OUT: process.env.DEMO_OUT || '', DEMO_FORMATS: process.env.DEMO_FORMATS || '', DEMO_TRUTH_HELPER: process.env.DEMO_TRUTH_HELPER || '', DEMO_OUTSIDE_WRITES: process.env.DEMO_OUTSIDE_WRITES || '', DEMO_TRUTH_OUTSIDE_WRITES: process.env.DEMO_TRUTH_OUTSIDE_WRITES || '', DEMO_CACHE_LABEL: process.env.DEMO_CACHE_LABEL || '', DEMO_HEAP_SNAPSHOT: process.env.DEMO_HEAP_SNAPSHOT || '', DEMO_HEAP_SAMPLING: process.env.DEMO_HEAP_SAMPLING || '', ...(process.env.VAPORVIEW_CMUX_CACHE ? { VAPORVIEW_CMUX_CACHE: process.env.VAPORVIEW_CMUX_CACHE } : {}),
  // vscode-port: demo-big on a big design (E2E_DEMO_BIG: a folder with its dumps + sources)
  E2E_DEMO_BIG: process.env.E2E_DEMO_BIG || '', E2E_DEMO_COMPUTED_BP: process.env.E2E_DEMO_COMPUTED_BP || '', E2E_DEMO_SIG: process.env.E2E_DEMO_SIG || '', E2E_DEMO_SRC: process.env.E2E_DEMO_SRC || '', E2E_DEMO_ARGS: process.env.E2E_DEMO_ARGS || '', E2E_DEMO_UNDUMPED: process.env.E2E_DEMO_UNDUMPED || '' };
// vscode-port: on macOS the visual suite runs VS Code under Playwright's Electron driver instead: it sets
// the window to exactly 1600x1000 and captures the page itself (no Screen Recording / Accessibility permission, which
// an outside capture tool would need). The tests ask for shots through files in E2E_SHOT_DIR (test/visual/shot.cjs).
// (E2E_HIDDEN=1 runs a non-visual suite the same way on macOS: the window stays invisible and unfocused)
const playwright = (visual || process.env.E2E_HIDDEN === '1') && (process.platform === 'darwin' || process.env.E2E_SHOT === 'playwright');
try {
  if (playwright) {
    process.exitCode = await runUnderPlaywright();
    if (process.exitCode) { throw new Error(`VS Code exited with ${process.exitCode}`); }
  } else {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: extPath,
      extensionTestsPath: path.join(root, 'test/e2e/suite/index.cjs'),
      launchArgs,
      extensionTestsEnv: testsEnv,
    });
  }
  console.log('E2E PASS');
} catch (e) {
  console.error('E2E FAIL', e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  fs.rmSync(userData, { recursive: true, force: true });
}

async function runUnderPlaywright() {
  // out-mac holds only this run's shots: a scenario that fails before its shot must not leave an older run's file
  // for the gate to compare (it did: stale VCD shots "passed" in an FSDB run).
  const outMac = path.join(root, 'test/visual/out-mac');
  if (!process.env.E2E_FILTER) { fs.rmSync(outMac, { recursive: true, force: true }); }
  const { _electron } = await import('playwright-core');
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-shot-'));
  const app = await _electron.launch({
    executablePath: vscodeExecutablePath,
    // own empty extensions dir: the user's ~/.vscode/extensions put an auto-update badge on the Extensions icon
    args: [...launchArgs, `--extensionDevelopmentPath=${extPath}`, `--extensionTestsPath=${path.join(root, 'test/e2e/suite/index.cjs')}`],
    env: { ...process.env, ...testsEnv, E2E_SHOT_DIR: shotDir },
    timeout: 120000,
  });
  const proc = app.process();
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code === null ? 1 : code)));
  proc.stdout.on('data', (d) => process.stdout.write(d));
  proc.stderr.on('data', (d) => process.stderr.write(d));
  const page = await app.firstWindow();
  // (evaluate runs in Electron's main process: the size goes in as an argument)
  // The window stays invisible (opacity 0, no Dock icon) and unfocused: test windows must not pop up on the user's
  // screen, and the native title text is dimmer when unfocused, so a focus change alone moved ~1100 px.
  // page.screenshot captures through CDP, so it does not need a visible window.
  const pinMac = () => app.evaluate(({ app: a, BrowserWindow }, [w0, h0]) => {
    try { a.dock && a.dock.hide(); } catch {}
    for (const w of BrowserWindow.getAllWindows()) { if (w.isVisible()) { w.setOpacity(0); w.setPosition(0, 0); w.setContentSize(w0, h0); w.blur(); } }
    try { a.hide(); } catch {}
  }, [MAC_W, MAC_H]);
  await pinMac();
  let done = false;
  const serve = (async () => {
    while (!done) {
      for (const f of fs.readdirSync(shotDir).filter((x) => x.startsWith('req-') && x.endsWith('.json'))) {
        const req = JSON.parse(fs.readFileSync(path.join(shotDir, f), 'utf8'));
        fs.rmSync(path.join(shotDir, f));
        let result = { ok: true };
        try {
          if (req.op === 'pin') { await pinMac(); }
          else if (req.op === 'shot') {
            await pinMac();
            const png = await page.screenshot({ scale: 'css' });
            const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
            if (w !== MAC_W || h !== MAC_H) { throw new Error(`mac shot is ${w}x${h}, expected ${MAC_W}x${MAC_H} (screen too small?)`); }
            result.png = png.toString('base64');
          }
          else if (req.op === 'key') { for (const k of req.keys) { await page.keyboard.press(k); } }
          else if (req.op === 'hover') { await page.mouse.move(req.x, req.y); }
        } catch (err) { result = { ok: false, error: String(err) }; }
        fs.writeFileSync(path.join(shotDir, `done-${req.id}.json.tmp`), JSON.stringify(result));
        fs.renameSync(path.join(shotDir, `done-${req.id}.json.tmp`), path.join(shotDir, `done-${req.id}.json`));
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const code = await exited;
  done = true;
  await serve.catch(() => {});
  fs.rmSync(shotDir, { recursive: true, force: true });
  return code;
}
