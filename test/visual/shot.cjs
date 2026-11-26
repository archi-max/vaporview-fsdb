// vscode-port: screenshots of the real VS Code window for the visual suite.
// Two backends. Linux + xvfb (tools/linux-test.sh visual): xdotool + ImageMagick on the X display. macOS (or
// E2E_SHOT=playwright): test/e2e/run.mjs runs VS Code under Playwright's Electron driver and serves shot / key / hover
// requests that arrive as files in E2E_SHOT_DIR; output goes to test/visual/out-mac/ (baselines: baseline-mac/).
// The window is pinned to 0,0 1600x1000 on a 1600x1000x24 screen (xdotool), the waveform webview must report idle
// (no data / window requests pending, two animation frames painted), and a frame is kept only when two captures in a
// row are byte-identical. Output: test/visual/out/<name>.png (gitignored); test/visual/diff.mjs gates it.
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, buffer) => cp.execFileSync(cmd, args, { encoding: buffer ? null : 'utf8', timeout: 20000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

function windows() {
  try { return run('xdotool', ['search', '--onlyvisible', '--name', 'Visual Studio Code']).split('\n').filter(Boolean); } catch { return []; }
}
function pinWindow() {
  for (const id of windows()) {
    try { run('xdotool', ['windowmove', id, '0', '0']); run('xdotool', ['windowsize', id, String(W), String(H)]); } catch {}
  }
}
// Keys go to the focused window (XTEST); --window would use XSendEvent, which Electron ignores.
// No windowfocus first: a focus change closes an open context menu.
function key(...ks) { for (const k of ks) { run('xdotool', ['key', '--delay', '120', k]); } }
/** Move the pointer to screen x,y (the window is pinned at 0,0). */
function hover(x, y) { run('xdotool', ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]); }
function capture() { return run('import', ['-silent', '-window', 'root', 'png:-'], true); }

// Playwright channel (E2E_SHOT_DIR): one request file per op, answered by a done file.
const shotDir = process.env.E2E_SHOT_DIR || '';
let reqId = 0;
async function request(op) {
  const id = `${process.pid}-${++reqId}`;
  const tmp = path.join(shotDir, `req-${id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, op)));
  fs.renameSync(tmp, path.join(shotDir, `req-${id}.json`));
  const done = path.join(shotDir, `done-${id}.json`);
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (fs.existsSync(done)) {
      const r = JSON.parse(fs.readFileSync(done, 'utf8')); fs.rmSync(done);
      if (!r.ok) { throw new Error('shot channel: ' + r.error); }
      return r;
    }
    await sleep(50);
  }
  throw new Error('shot channel: no answer to ' + op.op);
}
const PW_KEYS = { Down: 'ArrowDown', Up: 'ArrowUp', Left: 'ArrowLeft', Right: 'ArrowRight', Return: 'Enter' };
const backend = shotDir ? {
  name: 'mac', out: 'out-mac',
  pin: () => request({ op: 'pin' }),
  key: async (...ks) => { await request({ op: 'key', keys: ks.map((k) => PW_KEYS[k] || k) }); },
  hover: async (x, y) => { await request({ op: 'hover', x, y }); },
  capture: async () => Buffer.from((await request({ op: 'shot' })).png, 'base64'),
} : {
  name: 'linux', out: 'out',
  pin: async () => pinWindow(),
  key: async (...ks) => key(...ks),
  hover: async (x, y) => hover(x, y),
  capture: async () => capture(),
};

function create(t) {
  const outDir = path.join(t.root, 'test/visual', backend.out);
  async function idle(ms = 20000) {
    const end = Date.now() + ms; let last = null;
    while (Date.now() < end) {
      try { last = await t.query({ kind: 'idle' }); if (last && last.idle) { return last; } }
      catch (e) { if (/no active waveform panel/.test(String(e && e.message))) { return { idle: true, noPanel: true }; } last = String(e); }
      await sleep(200);
    }
    throw new Error('webview not idle: ' + JSON.stringify(last));
  }
  // The first shot of a Mac session rendered in a navy default theme although settings.json says Dark Modern (the
  // setting was read, so theme() saw nothing to change). Once per session the theme is switched away and back, which
  // makes VS Code load and apply Dark Modern before any capture.
  let themeForced = false;
  async function forceTheme() {
    if (themeForced) { return; }
    themeForced = true;
    const cfg = t.vscode.workspace.getConfiguration('workbench');
    const want = cfg.get('colorTheme') || THEMES.dark;
    await cfg.update('colorTheme', want === THEMES.light ? THEMES.dark : THEMES.light, t.vscode.ConfigurationTarget.Global); await sleep(800);
    await cfg.update('colorTheme', want, t.vscode.ConfigurationTarget.Global); await sleep(800);
  }
  async function screenshot(name, opts = {}) {
    await forceTheme();
    if (backend.name === 'linux' && process.platform !== 'linux') { throw new Error('visual screenshots need Linux + xvfb (tools/linux-test.sh visual) or the macOS Playwright route (E2E_VISUAL=1 node test/e2e/run.mjs)'); }
    if (opts.linuxOnly && backend.name !== 'linux') { console.log(`SKIP SHOT ${name}: Linux only (${opts.linuxOnly})`); return null; }
    if (!opts.noPin) { await backend.pin(); } // a resize (even a no-op one) closes open menus
    if (!opts.keepNotifications) { await t.vscode.commands.executeCommand('notifications.clearAll'); }
    // The side bar lists the workspace files, which change whenever a fixture is added: keep it out of every shot.
    // (opts.sidebar: a shot of a side bar view whose content doesn't depend on the workspace, e.g. Run and Debug)
    if (!opts.noPin && !opts.sidebar) { await t.vscode.commands.executeCommand('workbench.action.closeSidebar'); }
    await sleep(opts.settle || 600);
    // opts.view [t0, t1] (ns): the waveform's time range, set after the window pin and side bar changes. The opening
    // zoom fits the width the webview had when it first laid out, which depends on what earlier scenarios left open
    // (dbg-step drew 25/100/150 ns rulers in a full run, 0/25/50/100 in a filtered one), so waveform shots pin it.
    // opts.view { fit: uri }: zoom to fit the whole file at the settled width (shots whose content is the whole file).
    if (Array.isArray(opts.view)) { await t.query({ kind: 'zoomRange', t0: opts.view[0], t1: opts.view[1] }); await sleep(600); }
    else if (opts.view && opts.view.fit) { await t.vscode.commands.executeCommand('vaporview.zoomToFit', { uri: opts.view.fit }); await sleep(600); }
    // A shot that did not place the pointer itself parks it on the empty title bar: a pointer left over a button by an
    // earlier step shows a tooltip (dbg-break showed "Start Debugging (F5)"). Hover/menu shots pass idle: false or noPin.
    // Two moves: a workbench hover shown on focus (dbg: "Start Debugging (F5)") goes only on a pointer motion, and a
    // pointer already parked at the spot by the previous shot makes no motion.
    if (opts.idle !== false && !opts.noPin && !opts.keepPointer) { await backend.hover(W - 320, 14); await sleep(100); await backend.hover(W - 300, 12); }
    if (opts.idle !== false) { await idle(); }
    let prev = null, prevHash = '', png = null;
    for (let i = 0; i < 20; i++) {
      // again right before each capture: some toasts arrive late after startup ("All installed extensions are
      // temporarily disabled" landed in the first Mac shot after the clear above)
      if (!opts.keepNotifications) { await t.vscode.commands.executeCommand('notifications.clearAll'); await sleep(150); }
      png = await backend.capture();
      const h = crypto.createHash('sha1').update(png).digest('hex');
      if (h === prevHash) { break; }
      prev = png; prevHash = h; png = null;
      await sleep(250);
    }
    if (!png) {
      // keep the last two differing frames: what moved is the first question when a shot never settles
      fs.mkdirSync(outDir, { recursive: true });
      if (prev) { fs.writeFileSync(path.join(outDir, name + '.unsettled.png'), prev); }
      throw new Error(`screen never settled for ${name} (last frame: ${backend.out}/${name}.unsettled.png)`);
    }
    void prev;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, name + '.png'), png);
    fs.writeFileSync(path.join(outDir, '.format'), String(process.env.E2E_FORMAT || 'fsdb').toLowerCase() + '\n'); // diff.mjs: name masks off FSDB
    console.log(`SHOT ${name}`);
    return path.join(outDir, name + '.png');
  }
  // VS Code 1.147 theme ids (the old 'Default Dark Modern' ids are legacy aliases that vscode-shiki-bridge can't resolve).
  const THEMES = { dark: 'Dark Modern', light: 'Light Modern' };
  async function theme(which) {
    const cfg = t.vscode.workspace.getConfiguration('workbench');
    if (cfg.get('colorTheme') !== THEMES[which]) { await cfg.update('colorTheme', THEMES[which], t.vscode.ConfigurationTarget.Global); await sleep(800); }
  }
  /** One screenshot per theme: <name>-dark, <name>-light; leaves the dark theme on. */
  async function screenshotThemes(name, opts) {
    try { for (const k of ['dark', 'light']) { await theme(k); await screenshot(`${name}-${k}`, opts); } }
    finally { await theme('dark'); }
  }
  /** The current screen, decoded ({ w, h, rgba }). */
  async function grab() {
    const { readPng } = await import(path.join(__dirname, 'diff.mjs'));
    return readPng(await backend.capture());
  }
  return { screenshot, screenshotThemes, theme, idle, grab, key: backend.key, hover: backend.hover, pinWindow: backend.pin, backend: backend.name };
}
/**
 * Submenu chevrons (">") of an open dark-theme menu inside box {x0, x1, y0, y1}: the column with the most lone glyphs
 * (at most 9 px wide, 6-15 px tall, dark space on both sides), which menu labels and shortcuts never have. Returns the
 * chevron x and the centre y of each chevron, top to bottom ({ x, ys }), or null. Menu scenarios use it instead of
 * fixed offsets, since every merged feature that adds a menu entry moves the items below it.
 */
function findChevrons(img, box) {
  const lum = (x, y) => { const o = (y * img.w + x) * 4; return (img.rgba[o] + img.rgba[o + 1] + img.rgba[o + 2]) / 3; };
  const bright = (x, y) => x >= 0 && x < img.w && y >= 0 && y < img.h && lum(x, y) > 90; // chevrons are thin grey glyphs (luminance 90-150), labels ~200
  const darkBand = (xa, xb, ya, yb) => { for (let y = ya; y <= yb; y++) { for (let x = xa; x <= xb; x++) { if (bright(x, y)) { return false; } } } return true; };
  let best = null;
  for (let x = box.x0; x <= box.x1; x++) {
    const runs = []; let start = -1;
    for (let y = box.y0; y <= box.y1 + 1; y++) {
      const b = y <= box.y1 && bright(x, y);
      if (b && start < 0) { start = y; }
      if (!b && start >= 0) { runs.push([start, y - 1]); start = -1; }
    }
    const merged = [];
    // a chevron's leftmost column is two arms a few px apart: one glyph is at most 14 px tall
    for (const r of runs) { const m = merged[merged.length - 1]; if (m && r[1] - m[0] <= 14) { m[1] = r[1]; } else { merged.push([...r]); } }
    // A glyph: its ink within 12 px either side is at most 9 px wide (a lone ">", not the end of a label like "...d)"),
    // with nothing in the 16 px beyond. Other content in the box (the waveform row above the menu) doesn't count.
    const lone = ([a, b]) => {
      let lo = 1e9, hi = -1;
      for (let y = a; y <= b; y++) { for (let xx = x - 12; xx <= x + 12; xx++) { if (bright(xx, y)) { lo = Math.min(lo, xx); hi = Math.max(hi, xx); } } }
      return hi - lo <= 9 && darkBand(lo - 16, lo - 3, a, b) && darkBand(hi + 3, hi + 16, a, b);
    };
    const glyphs = merged.filter(([a, b]) => b - a >= 5 && b - a <= 14 && lone([a, b]));
    if (glyphs.length && (!best || glyphs.length > best.runs.length)) { best = { x, runs: glyphs }; }
  }
  return best ? { x: best.x, ys: best.runs.map(([a, b]) => Math.round((a + b) / 2)) } : null;
}
module.exports = { create, findChevrons, W, H };
