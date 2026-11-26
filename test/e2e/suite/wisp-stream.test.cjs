// vscode-port P2 regression fix (11-24): a window over more than 16 rows is streamed. The viewer asks
// {stream: true}; the extension answers with partial frames ({id, partial: true, result}) before the final one,
// either from the helper itself (caps.stream, patched wisp-helper) or by splitting the rows into chunks of <= 16
// (wisp-helper 15.7). The rows painted from partial frames must hold the right values.
//   top.s<k>  8 bits, k = 0..23, at t = 10 * i: (i + k) & 0xff   (20,000 changes each)
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { vscode, assert, until, open, query } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const N = 24, STEP = 10, T_END = 200000;
const bin8 = (v) => (v & 0xff).toString(2).padStart(8, '0');
const valAt = (k, t) => bin8(Math.floor(t / STEP) + k);
const ids = Array.from({ length: N }, (_, k) => String.fromCharCode(33 + k));

module.exports = {
  'wisp stream: a 24-row window arrives as partial frames, values right': async () => {
    if (!(await w.useHelper('stream'))) return;
    if (!w.TOOLS || !fs.existsSync(path.join(w.TOOLS, 'wcz-from-vcd'))) { console.log('SKIP stream: no wcz-from-vcd'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-wisp-stream-'));
    try {
      const vcd = path.join(dir, 'rows.vcd'), wcz = path.join(dir, 'rows.wcz');
      const out = ['$timescale 1ns $end', '$scope module top $end'];
      ids.forEach((c, k) => out.push(`$var wire 8 ${c} s${k} [7:0] $end`));
      out.push('$upscope $end', '$enddefinitions $end');
      for (let t = 0; t < T_END; t += STEP) {
        out.push('#' + t);
        ids.forEach((c, k) => out.push('b' + valAt(k, t) + ' ' + c));
      }
      out.push('#' + T_END);
      fs.writeFileSync(vcd, out.join('\n') + '\n');
      execFileSync(path.join(w.TOOLS, 'wcz-from-vcd'), [vcd, wcz], { stdio: 'pipe', timeout: 300000 });
      // Only visible rows are asked for. Earlier suites leave the panel (debug console, trace) or side bars open, which
      // left 16 or fewer of the 24 rows on screen in the full suite: close them so all 24 rows are visible.
      for (const c of ['workbench.action.closePanel', 'workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar']) {
        await vscode.commands.executeCommand(c).then(() => {}, () => {});
      }
      const uri = String(await open(vscode.Uri.file(wcz)));
      // Hybrid off: rows of 20k changes are under the whole-load limit, and once their counts arrive they load whole
      // with no windows. Whether the 24-row window went out first was timing (it failed after the full suite).
      const hq = await query({ kind: 'hybrid', on: false });
      assert.deepStrictEqual(hq, { hybrid: false }, 'hybrid off reached the viewer');
      await w.add(uri, ids.map((_, k) => 'top.s' + k));
      // A view no window covers yet, so one request names all 24 rows. (The adds' own requests follow how the adds
      // were batched: in the full suite they came in two batches of <= 16 rows, and the view opened already fitted,
      // so zoom-to-fit asked for nothing new.)
      await query({ kind: 'zoomRange', t0: 0, t1: T_END / 2 });
      let s;
      try {
        s = await until(async () => {
          const st = await w.state();
          return st.windowing.stats.partials > 0 && st.windowing.stats.fullMs.length > 0 ? st : null;
        }, 'partial frames in the viewer', 60000);
      } catch (e) { // say why: the windowing state, the relay counters and the settings that change how windows go
        const st = await w.state().catch((x) => ({ err: String(x) }));
        const ws = await w.wispState(uri);
        const cfg = vscode.workspace.getConfiguration('vaporview');
        const keys = ['wisp.windowing', 'wisp.remoteMode', 'wisp.simulatedLink', 'wisp.env'];
        const shown = await query({ kind: 'rects', selector: 'body' }).then((r) => r && r[0] && { w: r[0].w, h: r[0].h }, () => null);
        throw new Error(e.message + ' DIAG ' + JSON.stringify({ viewer: shown, rows: (st.rows || []).length,
          windowing: st.windowing && { enabled: st.windowing.enabled, stats: st.windowing.stats, signals: (st.windowing.signals || []).slice(0, 4) },
          wisp: ws && { windows: ws.windows, relayed: ws.relayed, streamedWindows: ws.streamedWindows, partialFrames: ws.partialFrames, nativeStream: ws.nativeStream, signalErrors: ws.signalErrors.slice(0, 3) },
          settings: Object.fromEntries(keys.map((k) => [k, cfg.inspect(k) && cfg.inspect(k).globalValue])) }).slice(0, 4000));
      }
      const ws = await w.wispState(uri);
      assert.ok(ws.streamedWindows > 0 && ws.partialFrames > 0, JSON.stringify(ws));
      console.log('  DIAGNOSTIC stream', JSON.stringify({ native: ws.nativeStream, streamedWindows: ws.streamedWindows, partialFrames: ws.partialFrames,
        firstPartMs: s.windowing.stats.firstPartMs, fullMs: s.windowing.stats.fullMs }));
      // first frame before the whole batch
      assert.ok(s.windowing.stats.firstPartMs[0] <= s.windowing.stats.fullMs[0], 'first frame not after the final one');
      for (const k of [0, 7, 15, 16, 23]) {
        for (const t of [5, 12345, 199995]) assert.strictEqual(await w.markerValue('s' + k, t), valAt(k, t), `s${k} at ${t}`);
      }
      const st = await w.state();
      assert.ok(st.windowing.signals.every((x) => !x.fails), JSON.stringify(st.windowing.signals.filter((x) => x.fails)));
      assert.strictEqual(ws.signalErrors.length, 0);
      // Cancel mid-stream: a zoom right after a zoom-to-fit drops the old batch; the view keeps working.
      await query({ kind: 'zoomRange', t0: 100000, t1: 100400 });
      await vscode.commands.executeCommand('vaporview.zoomToFit');
      assert.strictEqual(await w.markerValue('s3', 150003), valAt(3, 150003));
    } finally { await query({ kind: 'hybrid', on: true }).catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
  },
};
