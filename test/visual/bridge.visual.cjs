// vscode-port: screenshots of the P1/P3 features from vsc/bridge (merged 894d0e4): the Format Values
// context menu with its RISC-V submenu, RISC-V value search by regex (cmux page modules through the bridge), and value
// alias tables loaded from Verdi .alias / .rc / JSON / CSV files. Fixture: counter.vcd + test/e2e/fixtures/cnt_names.*.
const t = require('../e2e/suite/helpers.cjs');
const { vscode, assert, until, open, query, fixture } = t;
const page = async (fn, args) => { const r = await vscode.commands.executeCommand('vaporview.e2e.cmuxEval', String(fn), args); if (!r || r.error) { throw new Error('cmuxEval: ' + (r && r.error)); } return r.result; };
const pageReady = () => until(() => page((cmux) => !!cmux.host.currentBackend && !!cmux.host.doc.metadata), 'page bridge ready', 30000, 300);

async function addRow(uri, p) {
  await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: p });
  const name = p.split('.').pop();
  await until(async () => (await query({ kind: 'texts', selector: '.waveform-label' })).some((s) => s.includes(name)), 'row ' + p);
  for (const a of await query({ kind: 'attrs', selector: '.waveform-label[data-vscode-context]' })) {
    const ctx = JSON.parse(String(a['data-vscode-context']).replace(/%x20/g, ' '));
    if (ctx.signalName === name) { return ctx; }
  }
  throw new Error('no row ' + p);
}
async function marker(uri, time) {
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri, time });
  await until(async () => { const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri }); return v && v.markerTime === time; }, 'marker ' + time, 10000);
}
const values = (re) => until(async () => { const v = (await query({ kind: 'texts', selector: '.value-display-item' })).map((s) => s.trim()); return v.some((x) => re.test(x)) ? v : null; }, 'value ' + re, 10000);

// macOS draws context menus natively, outside the page Playwright captures; the menu shots are Linux only.
const MENU = 'native context menus on macOS are not in the page capture';

module.exports = {
  'format-menu: right-click a row: Format Values > RISC-V submenu': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    await addRow(uri, 'top.cnt');
    const instr = await addRow(uri, 'top.instr');
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri });
    await t.idle();
    await t.pinWindow();
    await vscode.commands.executeCommand('workbench.action.closeSidebar'); // as every shot does (shot.cjs)
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri }); // the view pinned at the settled width (shot.cjs opts.view)
    await t.idle();
    // The webview's own contextmenu event (what a right-click sends): VS Code draws the row menu from data-vscode-context.
    const at = await page((cmux, a) => {
      const el = document.getElementById('label-' + a.rowId);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
      return { x, y };
    }, { rowId: instr.rowId });
    console.log('MENU at ' + JSON.stringify(at));
    if (t.backend !== 'linux') { console.log('SKIP format-menu: ' + MENU); await t.key('Escape'); return; }
    await t.sleep(800);
    await t.screenshot('format-menu-dark', { idle: false, keepNotifications: true, noPin: true, linuxOnly: MENU });
    // Find Format Values, the menu's first item with a submenu chevron, in the captured screen instead of using fixed
    // offsets: link added 'Show Waveform Signal in Source' above it, and other features will add more. Keys don't reach
    // VS Code's custom menu under xvfb without a window manager, so the pointer hovers. The waveform webview's top-left
    // sits at WEBVIEW (fixed layout: 1600x1000 window, side bar closed: activity bar 48 px + editor border).
    const { findChevrons } = require('./shot.cjs');
    const WEBVIEW = { x: 53, y: 88 };
    const cx = WEBVIEW.x + at.x, cy = WEBVIEW.y + at.y;
    const main = findChevrons(await t.grab(), { x0: cx + 100, x1: cx + 700, y0: cy, y1: cy + 750 });
    assert.ok(main && main.ys.length >= 3, 'row menu chevrons: ' + JSON.stringify(main));
    const fy = main.ys[0];
    // Two moves inside the menu: one jump from a parked pointer (title bar, shot.cjs) to the item did not open the
    // submenu in full runs (2 of 2 on 9785a6c/56b4ecd); a move within the menu first does, as for RISC-V below.
    await t.hover(cx + 60, fy + 4);
    await t.sleep(200);
    await t.hover(cx + 80, fy);
    await t.sleep(1200);
    await t.screenshot('format-submenu-dark', { idle: false, keepNotifications: true, noPin: true, linuxOnly: MENU });
    // Then Format Values > RISC-V: the submenu's only chevron row.
    const sub = findChevrons(await t.grab(), { x0: main.x + 40, x1: main.x + 700, y0: fy - 40, y1: fy + 700 });
    assert.ok(sub && sub.ys.length === 1, 'Format Values submenu chevron: ' + JSON.stringify(sub));
    await t.hover(main.x + 40, fy);
    await t.sleep(300);
    await t.hover(sub.x - 120, fy);
    await t.sleep(300);
    await t.hover(sub.x - 120, sub.ys[0]);
    await t.sleep(1200);
    await t.screenshot('format-riscv-dark', { idle: false, keepNotifications: true, noPin: true, linuxOnly: MENU });
    await t.key('Escape', 'Escape', 'Escape');
  },
  'riscv-search: value search by regex over the RISC-V text (^add\\s+a2,) moves the marker to 20 ns': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    const instr = await addRow(uri, 'top.instr');
    await vscode.commands.executeCommand('vaporview.displayAsRiscv', { netlistId: instr.netlistId });
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri });
    await marker(uri, 0);
    await values(/li a0/);
    const at = await page(async (cmux, a) => {
      cmux.host.toWebview({ command: 'setSelectedSignal', netlistId: a.id });
      await new Promise((r) => setTimeout(r, 100));
      document.getElementById('value-equals-button').click();
      const bar = document.getElementById('search-bar');
      bar.value = a.re;
      bar.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
      bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await new Promise((r) => setTimeout(r, 300));
      bar.blur(); // a focused search bar blinks its caret: consecutive captures never match
      return cmux.host.viewerContext.webview.markerTime;
    }, { id: instr.netlistId, re: '^add\\s+a2,' });
    assert.strictEqual(at, 20);
    await values(/add a2,/); // at 20 ns the marker sits on the edge: the column shows 'ret -> add a2,…'
    await t.screenshotThemes('riscv-search', { view: { fit: uri } });
  },
  'alias-table: top.cnt through a Verdi .alias table (THREE at 35 ns), plus the JSON-bound table on a second row': async () => {
    const uri = String(await open('counter.vcd'));
    await pageReady();
    const cnt = await addRow(uri, 'top.cnt');
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri });
    await vscode.commands.executeCommand('vaporview.loadValueAliases', { aliasFile: fixture('cnt_names.alias').fsPath });
    await until(async () => (await page(() => window.vaporviewValueFormats.listFormats().map((f) => f.id))).includes('alias:cnt_alias'), 'alias table');
    await vscode.commands.executeCommand('vaporview.displayAsAliasTable', { netlistId: cnt.netlistId, aliasFormat: 'alias:cnt_alias' });
    await marker(uri, 37);
    await values(/^THREE$/);
    await t.screenshotThemes('alias-table', { view: { fit: uri } });
  },
};
