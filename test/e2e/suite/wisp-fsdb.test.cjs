// vscode-port P2 acceptance: FSDB through wisp-helper (no vendor reader), lazy open refusals, declared signals
// without values, and the helper settings. The FSDB fixtures are internal: never in the repo, found through
// E2E_FSDB_DIR (forwarded by tools/linux-test.sh); without it these tests print SKIP. Each FSDB is compared with the
// matching .wcz the converter made from it (same dir).
const fs = require('fs'), os = require('os'), path = require('path');
const { vscode, assert, until, open, closeAll } = require('./helpers.cjs');
const w = require('./wisp-common.cjs');

const has = (name) => w.FSDB_DIR && fs.existsSync(path.join(w.FSDB_DIR, name));
async function ready(what, files) {
  if (!(await w.useHelper(what))) return false;
  for (const f of files) if (!has(f)) { console.log(`SKIP ${what}: no ${f} (E2E_FSDB_DIR=${w.FSDB_DIR || 'unset'})`); return false; }
  return true;
}
const netlist = (uri, depth = 12, max = 5000) => vscode.commands.executeCommand('vaporview.e2e.netlist', String(uri), depth, max);
async function values(uri, time, paths) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time, instancePaths: paths });
  const out = {};
  for (const x of r || []) { let v = x.value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } } out[x.instancePath] = Array.isArray(v) ? v[v.length - 1] : v; }
  return out;
}
function corruptCopy(name, offset) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-wisp-fsdb-'));
  const b = Buffer.from(fs.readFileSync(path.join(w.FSDB_DIR, name)));
  b.writeUInt32LE(0xefbeadde, offset);
  const p = path.join(dir, name.replace(/\.fsdb$/, '-damaged.fsdb'));
  fs.writeFileSync(p, b);
  return { dir, file: vscode.Uri.file(p) };
}

module.exports = {
  'wisp fsdb: FSDB values through wisp-helper equal the converter WCZ (netlist and values)': async () => {
    // *.pl15.wcz: made from the same FSDB by the 15.7 converter (fsdb2wcz.sh) with its defaults, port links on, as
    // wisp-helper reads it. The 11-12 *.wcz carry no port links.
    const pairs = [['cc_cdc_fifo_gray.gate.fsdb', 'cc_cdc_fifo_gray.gate.pl15.wcz'], ['axi_cdc.gate.fsdb', 'axi_cdc.gate.pl15.wcz']];
    if (!(await ready('fsdb values', pairs.flat()))) return;
    for (const [f, z] of pairs) {
      const fu = String(await open(vscode.Uri.file(path.join(w.FSDB_DIR, f))));
      const zu = String(await open(vscode.Uri.file(path.join(w.FSDB_DIR, z))));
      const nf = await netlist(fu), nz = await netlist(zu);
      assert.ok(!nf.error && !nz.error, JSON.stringify([nf.error, nz.error]));
      const key = (v) => `${v.path}|${v.width}|${v.encoding}|${v.unavailable ? 'u' : 'v'}`;
      assert.deepStrictEqual(nf.vars.map(key).sort(), nz.vars.map(key).sort(), f + ': same netlist as the WCZ');
      const ws = await w.wispState(fu);
      assert.strictEqual(ws.source, 'fsdb'); assert.strictEqual(ws.refused, null);
      const paths = nf.vars.filter((v) => !v.unavailable && v.signalId >= 0).map((v) => v.path).slice(0, 300);
      assert.ok(paths.length > 10, f + ': ' + paths.length + ' readable vars');
      // times spread over the dump (timeEnd from the WCZ's metadata, through a value read at a far time)
      let compared = 0;
      for (const t of [0, 1000, 123457, 1000003, 2950001, 5000000]) {
        const a = await values(fu, t, paths), b = await values(zu, t, paths);
        for (const p of paths) { assert.strictEqual(a[p], b[p], `${f} ${p} at ${t}`); compared++; }
      }
      console.log(`  DIAGNOSTIC ${f}: ${nf.vars.length} vars, ${paths.length} compared at 6 times (${compared} values), unverified answers ${ws.unverified}`);
      await closeAll();
    }
  },

  'wisp fsdb: a refused FSDB (open refused) shows the reason': async () => {
    if (!(await ready('fsdb refused', ['refused.trunc4096.fsdb']))) return;
    const uri = vscode.Uri.file(path.join(w.FSDB_DIR, 'refused.trunc4096.fsdb'));
    await vscode.commands.executeCommand('vaporview.openFile', { uri });
    const ws = await until(async () => { const s = await w.wispState(uri); return s && s.messages.length ? s : null; }, 'refusal message');
    assert.ok(/could not be read: wisp-helper refused it/.test(ws.messages[0]) && /out of bounds/.test(ws.messages[0]), ws.messages[0]);
    assert.ok(!/corrupted/i.test(ws.messages[0]), 'never "corrupted": ' + ws.messages[0]);
    assert.ok(/refused/.test(ws.status), ws.status);
    assert.ok(/out of bounds/.test(ws.refused), ws.refused);
    // the tab says why (never a blank tab)
    const page = await until(() => vscode.commands.executeCommand('vaporview.e2e.failedOpen', String(uri)), 'failed-open page');
    assert.ok(/could not be opened/.test(page) && /out of bounds/.test(page), page);
    await closeAll();
  },

  'wisp fsdb: a file over the plan budget opens a tab that says so and names planBudgetMB; the budget reaches the helper': async () => {
    if (!(await ready('plan budget', ['axi_cdc.gate.fsdb']))) return;
    const uri = vscode.Uri.file(path.join(w.FSDB_DIR, 'axi_cdc.gate.fsdb'));
    const tabFor = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input && t.input.uri && String(t.input.uri) === String(uri));
    try {
      // A real refusal: RUN_PLAN_MAX_PLAN_BYTES=1 makes the 15.11 reader refuse any FSDB's plan at open.
      await w.setSetting('wisp.env', { RUN_PLAN_MAX_PLAN_BYTES: '1' });
      await vscode.commands.executeCommand('vaporview.openFile', { uri });
      const ws = await until(async () => { const s = await w.wispState(uri); return s && s.messages.length ? s : null; }, 'plan refusal');
      const m = ws.messages[0];
      assert.ok(/plan byte limit/.test(m), "the helper's text: " + m);
      assert.ok(/vaporview\.wisp\.planBudgetMB/.test(m) && /size limit, not a damaged file/.test(m), 'hint names the setting: ' + m);
      assert.ok(!/corrupted/i.test(m), 'never "corrupted": ' + m);
      assert.ok(/refused/.test(ws.status), ws.status);
      const page = await until(() => vscode.commands.executeCommand('vaporview.e2e.failedOpen', String(uri)), 'failed-open page');
      assert.ok(/plan byte limit/.test(page) && /id="open-setting"/.test(page) && /planBudgetMB/.test(page), 'the tab shows the message and a settings link: ' + page);
      assert.ok(tabFor(), 'the tab stays open with the message (not a blank tab)');
      const docs = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
      const list = Array.isArray(docs) ? docs : (docs && docs.documents) || [];
      assert.ok(!list.some((u) => String(u) === String(uri)), 'a failed open is not an open waveform');
      // Retry (the page's link runs vaporview.wisp.retryOpen): with the cap gone, the same tab position opens the file
      assert.ok(/id="retry-open"/.test(page) && /vaporview\.wisp\.retryOpen/.test(page), 'Retry link: ' + page);
      await w.setSetting('wisp.env', undefined);
      await vscode.commands.executeCommand('vaporview.wisp.retryOpen', String(uri));
      await until(async () => { const d = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
        const l = Array.isArray(d) ? d : (d && d.documents) || []; return l.some((u) => String(u) === String(uri)); }, 'retry opens the file');
      assert.strictEqual(await vscode.commands.executeCommand('vaporview.e2e.failedOpen', String(uri)), null, 'the failed-open page is gone after Retry');
      assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && String(t.input.uri) === String(uri)).length, 1, 'one tab for the file');
      console.log('  DIAGNOSTIC plan refusal: ' + m.slice(0, 160));
      await closeAll();
      // planBudgetMB reaches the helper as RUN_PLAN_BUDGET_MB: auto (40% of RAM, 4096..32768), then an explicit value
      await w.setSetting('wisp.env', undefined);
      const auto = Math.min(32768, Math.max(4096, Math.floor(os.totalmem() * 0.4 / 1048576)));
      for (const [set, want] of [[undefined, auto], ['8192', 8192]]) {
        await w.setSetting('wisp.planBudgetMB', set);
        const u = String(await open(uri));
        const st = await w.wispState(u);
        assert.ok(st.envKeys.includes('RUN_PLAN_BUDGET_MB=' + want), `planBudgetMB ${set || 'auto'}: ${JSON.stringify(st.envKeys)}`);
        assert.ok(!st.refused, 'opens with the budget: ' + st.refused);
        // 15.12: vaporview.wisp.verifyStart default idle:30 -> WISP_VERIFY_START; the check waits for quiet
        assert.ok(st.envKeys.includes('WISP_VERIFY_START=idle:30'), 'verifyStart default: ' + JSON.stringify(st.envKeys));
        const stats = await vscode.commands.executeCommand('vaporview.e2e.wispQuery', u, { cmd: 'stats' });
        const r = (stats && stats.result) || {};
        assert.ok(r.checkStart === 'idle' || /idle/.test(JSON.stringify(r.checkStart)), 'helper reports the idle start: ' + JSON.stringify(stats).slice(0, 400));
        await closeAll();
      }
    } finally {
      await w.setSetting('wisp.env', undefined);
      await w.setSetting('wisp.planBudgetMB', undefined);
      await closeAll();
    }
  },

  'wisp fsdb: lazy open refused after values were shown keeps the view, says why': async () => {
    if (!(await ready('fsdb lazy refusal', ['bigsoc25k.fsdb']))) return;
    // A copy with 4 bytes changed in its value data: the open (declarations, index) succeeds, values answer with
    // verified:false, and the background whole-file check refuses the file (XOR8 checksum mismatch) ~0.8 s later.
    const { dir, file } = corruptCopy('bigsoc25k.fsdb', 5000000);
    await w.setSetting('wisp.verifyStart', 'open');  // the check at open (default idle:30 would wait for 30 s of quiet)
    try {
      const uri = String(await open(file));
      const nl = await netlist(uri, 3, 40);
      const first = nl.vars.filter((v) => !v.unavailable && v.signalId >= 0 && v.encoding === 'BitVector').slice(0, 3);
      assert.ok(first.length > 0, 'readable vars before the refusal');
      await w.add(uri, first.map((v) => v.path));
      const ws = await until(async () => { const s = await w.wispState(uri); return s && s.refused ? s : null; }, 'lazy refusal', 30000);
      assert.ok(/XOR8 checksum mismatch/.test(ws.refused), ws.refused);
      assert.ok(/refused/.test(ws.status) && !/corrupted/i.test(ws.status), ws.status);
      assert.ok(ws.messages.some((m) => /was refused: the reader's whole-file check failed/.test(m) && /XOR8 checksum mismatch/.test(m) && !/corrupted/i.test(m)), JSON.stringify(ws.messages));
      // Everything shown stays: the rows, and the netlist.
      const s = await w.state();
      for (const v of first) assert.ok(s.rows.some((r) => r.name === v.path.split('.').pop()), 'row kept: ' + v.path);
      const again = await netlist(uri, 3, 40);
      assert.ok(again.vars.length >= nl.vars.length, 'netlist kept');
      console.log(`  DIAGNOSTIC lazy refusal: withdrawn ${ws.withdrawn}, unverified ${ws.unverified}, status "${ws.status}"`);
      await closeAll();
    } finally { await w.setSetting('wisp.verifyStart', undefined); fs.rmSync(dir, { recursive: true, force: true }); }
  },

  'wisp fsdb: declared signals without values are listed with the reason and never become rows': async () => {
    if (!(await ready('fsdb unavailable', ['cc_cdc_fifo_gray.gate.fsdb']))) return;
    const uri = String(await open(vscode.Uri.file(path.join(w.FSDB_DIR, 'cc_cdc_fifo_gray.gate.fsdb'))));
    const nl = await netlist(uri);
    const un = nl.vars.filter((v) => v.unavailable);
    assert.ok(un.length > 0, 'the fixture declares vars without values');
    for (const v of un) {
      assert.strictEqual(v.contextValue, 'netlistVarUnavailable', v.path);
      assert.ok(v.unavailable.reason && v.description.includes(v.unavailable.reason), JSON.stringify(v));
    }
    const ok = nl.vars.find((v) => !v.unavailable && v.signalId >= 0);
    await w.add(uri, [ok.path]);
    const before = (await w.state()).rows.length;
    await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: un[0].path });
    const ws = await until(async () => { const s = await w.wispState(uri); return s.messages.some((m) => /No values in this file/.test(m)) ? s : null; }, 'no-values message');
    assert.ok(ws.messages.some((m) => m.includes(un[0].unavailable.reason)), JSON.stringify(ws.messages));
    assert.strictEqual((await w.state()).rows.length, before, 'no row added');
    console.log(`  DIAGNOSTIC ${un.length} vars without values, e.g. ${un[0].path}: ${un[0].unavailable.state}: ${un[0].unavailable.reason}`);
    await closeAll();
  },

  'wisp settings: workers, cache, port links, force log, direct-open mode reach the helper': async () => {
    if (!(await ready('settings', ['bigsoc25k.fsdb']))) return;
    const { dir, file } = corruptCopy('bigsoc25k.fsdb', 5000000);
    try {
      await w.setSetting('wisp.workers', 2);
      await w.setSetting('wisp.cacheMb', 256);
      await w.setSetting('wisp.portLinks', false);
      await w.setSetting('wisp.directOpen', 'full');
      const uri = vscode.Uri.file(path.join(w.FSDB_DIR, 'cc_cdc_fifo_gray.gate.fsdb'));
      await open(uri);
      const ws = await until(async () => { const s = await w.wispState(uri); return s && s.workers ? s : null; }, 'open with settings');
      assert.deepStrictEqual(ws.args, ['--workers', '2', '--cache-mb', '256']);
      assert.strictEqual(ws.workers, 2, 'the helper runs 2 workers');
      assert.ok(ws.envKeys.includes('WISP_PORT_LINKS=0') && ws.envKeys.includes('WISP_DIRECT_OPEN=full'), JSON.stringify(ws.envKeys));
      // checkThreads default 2 caps the whole-file check (WISP_VERIFY_THREADS), unless the environment already sets it.
      if (!process.env.WISP_VERIFY_THREADS) assert.ok(ws.envKeys.includes('WISP_VERIFY_THREADS=2'), JSON.stringify(ws.envKeys));
      await closeAll();
      // Direct-open mode full: the damaged copy is now refused at open (the whole-file check runs before any value).
      await vscode.commands.executeCommand('vaporview.openFile', { uri: file });
      const wr = await until(async () => { const s = await w.wispState(file); return s && s.messages.length ? s : null; }, 'full-open refusal', 60000);
      assert.ok(/XOR8 checksum mismatch/.test(wr.messages[0]) && wr.unverified === 0, JSON.stringify(wr));
      // An unreadable force-log file refuses the FSDB open with the helper's wording.
      await closeAll();
      await w.setSetting('wisp.directOpen', undefined);
      await w.setSetting('wisp.forceLog', '/nonexistent/force.log');
      const u2 = vscode.Uri.file(path.join(w.FSDB_DIR, 'axi_cdc.gate.fsdb'));
      await vscode.commands.executeCommand('vaporview.openFile', { uri: u2 });
      const wf = await until(async () => { const s = await w.wispState(u2); return s && s.messages.length ? s : null; }, 'force-log refusal');
      assert.ok(/force\.log|WISP_FORCE_LOG|force log/i.test(wf.messages[0]), wf.messages[0]);
      assert.ok(wf.envKeys.includes('WISP_FORCE_LOG=/nonexistent/force.log'));
    } finally {
      for (const k of ['wisp.workers', 'wisp.cacheMb', 'wisp.portLinks', 'wisp.directOpen', 'wisp.forceLog']) await w.setSetting(k, undefined);
      await closeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  'wisp fsdb: Search Netlist on an FSDB answers like its converter WCZ; a big design is indexed once': async () => {
    const pairs = [['cc_cdc_fifo_gray.gate.fsdb', 'cc_cdc_fifo_gray.gate.pl15.wcz'], ['axi_cdc.gate.fsdb', 'axi_cdc.gate.pl15.wcz']];
    if (!(await ready('fsdb netlist search', pairs.flat().concat(['bigsoc25k.fsdb'])))) return;
    const search = (uri, q, scopeId) => vscode.commands.executeCommand('vaporview.e2e.searchNetlist', String(uri), q, scopeId);
    const key = (r) => r.searchResults.map((e) => (e.isVar ? 'v ' : 's ') + e.instancePath).sort();
    for (const [fsdb, wcz] of pairs) {
      const uf = await open(vscode.Uri.file(path.join(w.FSDB_DIR, fsdb))), uz = await open(vscode.Uri.file(path.join(w.FSDB_DIR, wcz)));
      for (const q of ['clk', 'rst', 'i_', 'fifo', 'a.b', 'zz_nothing']) {
        const a = await search(uz, q), b = await search(uf, q);
        assert.ok(!a.error && !b.error, JSON.stringify([a.error, b.error]));
        assert.strictEqual(b.totalResults, a.totalResults, `${fsdb} "${q}": ${b.totalResults} vs WCZ ${a.totalResults}`);
        // over 100 hits the shown 100 follow the tree's order (sorted once a scope was expanded): totals only
        if (a.totalResults <= 100) assert.deepStrictEqual(key(b), key(a), `${fsdb} "${q}"`);
      }
      const r = await search(uf, 'clk');
      assert.ok(r.totalResults > 0, `${fsdb}: "clk" found nothing`);
      console.log(`  DIAGNOSTIC search ${fsdb}: "clk" -> ${r.totalResults}`);
      await closeAll();
    }
    // The compact index (11-25) gives the hits the NetlistItem walk gave, in the same order, with the same ranges,
    // for whole-design and scoped searches, on the FSDB and on its WCZ.
    for (const f of [pairs[0][0], pairs[0][1], pairs[1][0]]) {
      const u = String(await open(vscode.Uri.file(path.join(w.FSDB_DIR, f))));
      const qs = ['clk', 'rst', 'i_', 'fifo', 'a.b', 'u', '_', 'zz_nothing', '.', 'CLK', 'tb.'];
      let scoped = 0;
      // Hit order is not compared: the walk's order followed the tree's (sorted once a scope was expanded); the set,
      // each hit's type and range, and the total must match. Over 100 hits only the totals can be compared.
      const same = (a, b, what) => {
        assert.strictEqual(a.totalResults, b.totalResults, what + ' total');
        if (a.totalResults <= 100) {
          const k = (r) => r.searchResults.map((e) => JSON.stringify(e)).sort();
          const ka = k(a), kb = k(b);
          assert.deepStrictEqual(ka, kb, `${what}: index only ${JSON.stringify(ka.filter((x) => !kb.includes(x)).slice(0, 3))}, walk only ${JSON.stringify(kb.filter((x) => !ka.includes(x)).slice(0, 3))}`);
        }
      };
      for (const q of qs) {
        same(await search(u, q), await vscode.commands.executeCommand('vaporview.e2e.searchNetlistRef', u, q), `${f} "${q}": index vs walk`);
      }
      // scoped: inside the first few scopes a search finds
      const scopes = (await search(u, '_')).searchResults.filter((e) => !e.isVar).slice(0, 3);
      for (const sc of scopes) {
        const id = await vscode.commands.executeCommand('vaporview.e2e.scopeNetlistId', u, sc.instancePath);
        if (typeof id !== 'number') continue;
        for (const q of ['c', 'r', '_']) {
          same(await search(u, q, id), await vscode.commands.executeCommand('vaporview.e2e.searchNetlistRef', u, q, id), `${f} "${q}" in ${sc.instancePath}`);
          scoped++;
        }
      }
      console.log(`  DIAGNOSTIC search index = walk on ${f}: ${qs.length} queries, ${scoped} scoped`);
      await closeAll();
    }
    const ub = await open(vscode.Uri.file(path.join(w.FSDB_DIR, 'bigsoc25k.fsdb')));
    const first = await search(ub, 'u_soc');
    const again = await search(ub, 'fifo');
    assert.ok(first.totalResults > 0 && again.totalResults > 0, JSON.stringify([first.totalResults, again.totalResults]));
    assert.ok(first.searchResults.length <= 100 && again.searchResults.length <= 100);
    console.log(`  DIAGNOSTIC search bigsoc25k: "u_soc" ${first.totalResults} in ${first.ms} ms (builds the index), "fifo" ${again.totalResults} in ${again.ms} ms`);
    await closeAll();
  },

  'wisp fsdb: value search on a wide signal straight after its whole load finds the match (format cache still filling)': async () => {
    if (!(await ready('fsdb search during fill', ['bigsoc25k.fsdb']))) return;
    const uri = String(await open(vscode.Uri.file(path.join(w.FSDB_DIR, 'bigsoc25k.fsdb'))));
    const nl = await netlist(uri, 12, 4000);
    const wide = nl.vars.find((v) => !v.unavailable && v.signalId >= 0 && v.encoding === 'BitVector' && v.width >= 256);
    assert.ok(wide, 'a signal of 256 bits or more in bigsoc25k');
    const name = wide.path.split('.').pop();
    // Slow the cache fill (e2e only: each 8 ms slice waits 500 ms), so the search runs while it is incomplete.
    await w.state({ kind: 'formatSlicePause', ms: 500 });
    try {
      await w.add(uri, [wide.path]);
      const st = await until(async () => { const x = await w.state(); const r = x.rows.find((y) => y.name === name); return r && r.loaded ? x : null; }, 'whole load of ' + name, 120000);
      // A value the signal holds later on, with no x/z, as a hex search.
      let T = 0, bits = '';
      for (const f of [0.5, 0.6, 0.7, 0.8, 0.9]) { T = Math.floor(st.timeStop * f); bits = await w.apiValue(uri, T, wide.path); if (/^[01]+$/.test(bits)) break; }
      assert.ok(/^[01]+$/.test(bits), 'a 2-state value of ' + wide.path);
      const hex = BigInt('0b' + bits).toString(16);
      await w.state({ kind: 'select', name });
      await w.state({ kind: 'marker', time: 0 });
      const before = (await w.state()).rows.find((r) => r.name === name);
      assert.strictEqual(before.formatCached, false, 'the format cache is still filling when the search runs');
      await w.state({ kind: 'searchValue', value: hex, direction: 1 });
      const hit = await until(async () => { const x = await w.state(); return x.markerTime > 0 ? x : null; }, 'search hit', 30000);
      assert.ok(hit.markerTime <= T, `first match ${hit.markerTime} is at or before ${T}, where the value is held`);
      assert.strictEqual(await w.apiValue(uri, hit.markerTime, wide.path), bits, 'the value at the hit is the searched one');
      console.log(`  DIAGNOSTIC search during fill: ${wide.path} (${wide.width} bits) hit at ${hit.markerTime} (held at ${T}); cache filled: ${hit.rows.find((r) => r.name === name).formatCached}`);
    } finally {
      await w.state({ kind: 'formatSlicePause', ms: 0 }).catch(() => {});
      await closeAll();
    }
  },

  'wisp fsdb: windowing off, a whole load the helper can only summarise is marked on its row and the user is told once': async () => {
    if (!(await ready('fsdb whole-load summary', ['cc_cdc_fifo_gray.gate.fsdb']))) return;
    await w.setSetting('wisp.windowing', false);
    // e2e only: a whole load asks 1 bucket (exact up to 2 changes), so a signal that toggles more often comes back as a summary.
    globalThis.vvE2EWholeBuckets = 1;
    try {
      const uri = String(await open(vscode.Uri.file(path.join(w.FSDB_DIR, 'cc_cdc_fifo_gray.gate.fsdb'))));
      const nl = await netlist(uri, 12, 400);
      const vars = nl.vars.filter((v) => !v.unavailable && v.signalId >= 0).slice(0, 8);
      assert.ok(vars.length >= 2, 'signals to add');
      await w.add(uri, vars.map((v) => v.path));
      const st = await until(async () => { const x = await w.state(); return x.rows.length && x.rows.every((r) => r.loaded) ? x : null; }, 'whole loads', 60000);
      const summary = st.rows.filter((r) => r.summary);
      assert.ok(summary.length >= 1, 'at least one row is a summary: ' + JSON.stringify(st.rows.map((r) => [r.name, r.summary])));
      for (const r of st.rows) assert.strictEqual(r.summaryBadge, r.summary, `row ${r.name}: the "summary" marker shows exactly on summarised rows`);
      const ws = await w.wispState(uri);
      assert.ok(ws.summarySignals >= summary.length, 'the host counted the summaries');
      const notes = ws.messages.filter((m) => /summary, not exact values/.test(m) && /vaporview\.wisp\.windowing/.test(m));
      assert.strictEqual(notes.length, 1, 'one notification per file, however many rows: ' + JSON.stringify(ws.messages));
      console.log(`  DIAGNOSTIC fsdb whole-load summary: ${summary.length}/${st.rows.length} rows marked, 1 notice`);
    } finally {
      delete globalThis.vvE2EWholeBuckets;
      await w.setSetting('wisp.windowing', undefined);
      await closeAll();
    }
  },

  'wisp fsdb: a workspace .vscode/settings.json outsideWrites "none" reaches the helper (resource scope), FSDB then WCZ': async () => {
    // The user's case: the setting lives in the project's .vscode/settings.json, not in user settings. A machine-scoped
    // setting is ignored there (VS Code drops it), which left dbg.fsdb's port copies without values.
    const fmt = process.env.E2E_FIXTURES_FMT_DIR || '';
    const files = [path.join(fmt, 'fsdb/test/e2e/fixtures/dbg/dbg.vcs.fsdb'), path.join(fmt, 'wcz/test/e2e/fixtures/dbg/dbg.vcs.wcz')];
    if (!(await w.useHelper('outsideWrites workspace'))) return;
    if (!fmt || !files.every((f) => fs.existsSync(f))) { console.log('SKIP outsideWrites workspace: no dbg.vcs twins under ' + fmt); return; }
    const cfg = () => vscode.workspace.getConfiguration('vaporview');
    // A user-level value (another test's leftover, e.g. dbg-helpers' outsideWrites) would mask nothing here (the folder
    // value wins), but it must not decide the result: saved, cleared for the test, and put back after.
    const userBefore = cfg().inspect('wisp.outsideWrites').globalValue;
    const settingsFile = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode', 'settings.json');
    const before = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
    try {
      if (userBefore !== undefined) { await cfg().update('wisp.outsideWrites', undefined, vscode.ConfigurationTarget.Global); }
      assert.strictEqual(cfg().inspect('wisp.outsideWrites').globalValue, undefined, 'no user-level value during the test');
      await cfg().update('wisp.outsideWrites', 'none', vscode.ConfigurationTarget.Workspace);
      assert.ok(/"vaporview\.wisp\.outsideWrites":\s*"none"/.test(fs.readFileSync(settingsFile, 'utf8')), 'written to ' + settingsFile);
      for (const f of files) {
        const uri = String(await open(vscode.Uri.file(f)));
        const ws = await w.wispState(uri);
        assert.strictEqual(ws.outsideWrites, 'none', `${path.basename(f)}: the folder setting reached the open`);
        const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri, time: 34, instancePaths: ['dbg_top.u1.en'] });
        let v = r && r[0] && r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
        v = Array.isArray(v) ? v[v.length - 1] : v;
        assert.strictEqual(String(v), '1', `${path.basename(f)}: dbg_top.u1.en @34 (${JSON.stringify(r)})`);
        console.log(`  DIAGNOSTIC outsideWrites from .vscode/settings.json: ${path.basename(f)} outsideWrites ${ws.outsideWrites}, computed ${JSON.stringify(ws.computed)}, u1.en@34 = ${v}`);
        await closeAll();
      }
    } finally {
      await cfg().update('wisp.outsideWrites', undefined, vscode.ConfigurationTarget.Workspace);
      if (before === null) { try { fs.rmSync(settingsFile); } catch {} } else fs.writeFileSync(settingsFile, before);
      if (userBefore !== undefined) { await cfg().update('wisp.outsideWrites', userBefore, vscode.ConfigurationTarget.Global); }
      await closeAll();
    }
  },

  'wisp fsdb: outsideWrites none computes unlinked port copies; values, edges and counts equal the VCD': async () => {
    const fmt = process.env.E2E_FIXTURES_FMT_DIR || '';
    const repo = path.resolve(__dirname, '../../..');
    const cases = [['dbg/dbg', ['dbg_top.w0', 'dbg_top.w1', 'dbg_top.u1.en']], ['link/fsm', ['tb.y', 'tb.busy']]];
    const fsdbOf = (b) => path.join(fmt, 'fsdb/test/e2e/fixtures', b + '.vcs.fsdb');
    if (!(await w.useHelper('outsideWrites'))) return;
    for (const [b] of cases) if (!fmt || !fs.existsSync(fsdbOf(b))) { console.log(`SKIP outsideWrites: no ${fsdbOf(b)}`); return; }
    const vals = async (uri, t, paths) => {
      const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time: t, instancePaths: paths });
      const out = {};
      // (a value at a change comes as [before, after]; the VCD reader gives [[], v] at time 0): the value in effect
      const last = (v) => (Array.isArray(v) ? last(v[v.length - 1]) : v);
      for (const x of r || []) { let v = x.value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } } let o = String(last(v)); const m = o.match(/"([^"]*)"\]$/); if (m) o = m[1]; out[x.instancePath] = o.toLowerCase(); }
      return out;
    };
    const q = (uri, req) => vscode.commands.executeCommand('vaporview.e2e.wispQuery', String(uri), req);
    try {
      for (const [b, want] of cases) {
        const fsdb = vscode.Uri.file(fsdbOf(b));
        // 1. Not stated (default): the port copies are listed without values, and the reason names the setting.
        await w.setSetting('wisp.outsideWrites', undefined);
        let uri = String(await open(fsdb));
        let nl = await netlist(uri, 12, 2000);
        const copies = nl.vars.filter((v) => v.unavailable && /values not linked/.test(v.unavailable.reason));
        assert.ok(copies.length > 0, b + ': port copies without values by default');
        assert.ok(copies.every((v) => /vaporview\.wisp\.outsideWrites/.test(v.unavailable.reason)), 'the reason points at vaporview.wisp.outsideWrites: ' + copies[0].unavailable.reason);
        for (const p of want) assert.ok(copies.some((v) => v.path === p), `${b}: ${p} is a port copy without values by default`);
        await closeAll();
        // 2. outsideWrites none: every such copy gets a computed id and answers like the VCD.
        await w.setSetting('wisp.outsideWrites', 'none');
        uri = String(await open(fsdb));
        const ws = await w.wispState(uri);
        assert.ok(ws.outsideWrites === 'none' && ws.computed && ws.computed.n > 0, 'computed ids: ' + JSON.stringify(ws.computed));
        nl = await netlist(uri, 12, 2000);
        const byPath = new Map(nl.vars.map((v) => [v.path, v]));
        const paths = copies.map((c) => c.path).filter((p) => { const v = byPath.get(p); return v && !v.unavailable && v.signalId >= ws.computed.first; });
        for (const p of want) assert.ok(paths.includes(p), `${b}: ${p} is computed (${JSON.stringify(byPath.get(p))})`);
        const vcd = vscode.Uri.file(path.join(repo, 'test/e2e/fixtures', b + '.vcd'));
        await vscode.commands.executeCommand('vaporview.openFile', { uri: vcd });
        await until(async () => { const d = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments'); const l = Array.isArray(d) ? d : (d && d.documents) || []; return l.some((u) => String(u) === String(vcd)); }, 'vcd open');
        const st = await w.state();
        const end = Math.floor(st.timeStop);
        const step = Math.max(1, Math.floor(end / 600));
        let diffs = 0, checked = 0;
        const first = {};  // first change time of each copy, from the VCD samples (every step)
        const last = {};
        // first SV posedge / negedge of each 1-bit copy (0->x/z and x/z->1 are posedge; 1->x/z and x/z->0 negedge)
        const svEdge = (f, v) => { const u = (c) => c !== '0' && c !== '1';
          return { pos: (f === '0' && v !== '0') || (u(f) && v === '1'), neg: (f === '1' && v !== '1') || (u(f) && v === '0') }; };
        const firstPos = {}, firstNeg = {}, wentX = {};
        for (let t = 0; t <= end; t += step) {
          const [a, v] = await Promise.all([vals(uri, t, paths), vals(vcd, t, paths)]);
          for (const p of paths) {
            checked++;
            if (a[p] !== v[p]) { if (diffs++ < 5) console.log(`  DIFF ${p} @${t}: fsdb ${a[p]} vcd ${v[p]}`); }
            if (last[p] !== undefined && last[p] !== v[p] && first[p] === undefined) first[p] = t;
            if (last[p] !== undefined && last[p] !== v[p] && String(v[p]).length === 1) {
              const e = svEdge(String(last[p]).toLowerCase(), String(v[p]).toLowerCase());
              if (e.pos && firstPos[p] === undefined) firstPos[p] = t;
              if (e.neg && firstNeg[p] === undefined) firstNeg[p] = t;
            }
            if (/^[xz]$/i.test(String(v[p]))) wentX[p] = true;
            last[p] = v[p];
          }
        }
        assert.strictEqual(diffs, 0, `${b}: computed port copies equal the VCD at ${checked} (signal, time) points`);
        // edge and count on computed ids (answered through windows)
        for (const p of paths.slice(0, 4)) {
          const id = byPath.get(p).signalId;
          const e = await q(uri, { cmd: 'edge', signalId: id, t: 0, dir: 1, kind: 'any' });
          assert.ok(!e.error, p + ' edge: ' + e.error);
          if (step === 1 && first[p] !== undefined) assert.strictEqual(e.result.t, first[p], `${p}: first change from edge = the VCD's`);
        }
        // SV edge kinds on the x-going 1-bit copies (the computed path once matched only "to 1" / "to 0")
        let svChecked = 0;
        for (const p of paths.filter((x) => wentX[x] && (firstPos[x] !== undefined || firstNeg[x] !== undefined))) {
          if (step !== 1) break;
          const id = byPath.get(p).signalId;
          for (const [kind, want] of [['posedge', firstPos[p]], ['negedge', firstNeg[p]], ['edge', Math.min(firstPos[p] ?? Infinity, firstNeg[p] ?? Infinity)]]) {
            const e = await q(uri, { cmd: 'edge', signalId: id, t: 0, dir: 1, kind });
            assert.ok(!e.error, p + ' edge ' + kind + ': ' + e.error);
            assert.strictEqual(e.result.t, want === undefined || want === Infinity ? null : want, `${p}: first ${kind} by SV rules = the VCD's`);
            svChecked++;
          }
        }
        console.log(`  DIAGNOSTIC outsideWrites ${b}: ${svChecked} SV edge answers on x-going copies equal the VCD`);
        for (const p of paths.slice(0, 4)) {
          const id = byPath.get(p).signalId;
          const c = await q(uri, { cmd: 'count', signalIds: [id], exact: false });
          assert.ok(!c.error && c.result.counts[0].count >= 1, p + ' count: ' + JSON.stringify(c));
          const va = await q(uri, { cmd: 'valueAt', signalIds: [id], t: end, prev: true });
          assert.ok(!va.error && va.result.values[0] !== null, p + ' valueAt: ' + JSON.stringify(va));
        }
        console.log(`  DIAGNOSTIC outsideWrites ${b}: ${paths.length} computed copies, ${checked} points equal the VCD (step ${step}), computedAnswers ${(await w.wispState(uri)).computedAnswers}`);
        await closeAll();
      }
    } finally {
      await w.setSetting('wisp.outsideWrites', undefined);
      await closeAll();
    }
  },

  'wisp fsdb: the view ends past the last timestamp as the VCD view does (zoom to fit shows the last change)': async () => {
    const fmt = process.env.E2E_FIXTURES_FMT_DIR || '';
    const repo = path.resolve(__dirname, '../../..');
    const f = ['counter.vcs.fsdb', 'counter.fsdb'].map((n) => path.join(fmt, 'fsdb/test/e2e/fixtures', n)).find((p) => fs.existsSync(p));
    if (!(await w.useHelper('end padding')) || !f) { console.log('SKIP end padding: no counter FSDB twin'); return; }
    try {
      const vcd = vscode.Uri.file(path.join(repo, 'test/e2e/fixtures/counter.vcd'));
      await vscode.commands.executeCommand('vaporview.openFile', { uri: vcd });
      await until(async () => { const s = await w.state(); return s && s.timeStop > 0 ? s : null; }, 'vcd viewport');
      const vEnd = (await w.state()).timeStop;
      await closeAll();
      const uri = String(await open(vscode.Uri.file(f)));
      await until(async () => { const s = await w.state(); return s && s.timeStop > 0 ? s : null; }, 'fsdb viewport');
      const ws = await w.wispState(uri);
      const fEnd = (await w.state()).timeStop;
      // padded past the dump's end as the VCD view is (timeEnd only: the pad is timeEnd/1000, the VCD's the mean step)
      assert.ok(fEnd > fEnd - ws.timePad.pad && ws.timePad.pad >= 1, `view end ${fEnd} is past the last timestamp (${JSON.stringify(ws.timePad)}); VCD ${vEnd}`);
      // the last change (at the dump's last timestamp) is drawn: it lies inside the zoomed-to-fit view, before its end
      const lastT = fEnd - ws.timePad.pad;
      const cnt = (await netlist(uri, 4, 50)).vars.find((x) => /^top\.cnt/.test(x.path) && x.signalId >= 0);
      assert.ok(cnt, 'top.cnt in the counter FSDB');
      await w.add(uri, [cnt.path]);
      await w.state({ kind: 'zoomRange', t0: 0, t1: fEnd });
      const v = await w.markerValue(cnt.path.split('.').pop(), lastT);
      assert.ok(v !== undefined && v !== null, 'a value at the last timestamp ' + lastT);
      assert.ok(lastT < fEnd, 'the last timestamp lies inside the view, not on its edge');
      console.log(`  DIAGNOSTIC end padding: ${JSON.stringify(ws.timePad)}; view end ${fEnd} = VCD ${vEnd}`);
    } finally { await closeAll(); }
  },
};
