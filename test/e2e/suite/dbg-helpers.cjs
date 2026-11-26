// vscode-port P4: helpers for the waveform debugger's e2e tests (dbg-*.test.cjs). Fixture: fixtures/dbg (dbg_top.sv + dbg.vcd).
// Clock dbg_top.clk rises at 5, 15, ..., 405 ns (41 cycles); reset ends at 12 ns. u0.cnt counts every cycle from 15 ns,
// u1.cnt every other cycle (15, 35, 55 ...); instr is li / jal / add / beqz in turn from 5 ns.
const { vscode, assert, sleep, until, open, fixture, closeAll } = require('./helpers.cjs');
const DT = 'vaporview-waveform';
const SV = () => fixture('dbg/dbg_top.sv');

// Every DAP message the adapter sends (a tracker sees what VS Code sees).
const sent = [];
const received = [];
let tracking = null;
function track() {
  if (tracking) { return; }
  tracking = vscode.debug.registerDebugAdapterTrackerFactory(DT, {
    createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => sent.push(m), onWillReceiveMessage: (m) => received.push(m) }),
  });
}
const stops = () => sent.filter((m) => m.type === 'event' && m.event === 'stopped');

/** Stops every debug session and waits until VS Code reports none (bounded), so no session leaks into other suites. */
async function stopAll() {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  for (let i = 0; i < 25 && vscode.debug.activeDebugSession; i++) {
    const ended = new Promise((r) => { const d = vscode.debug.onDidTerminateDebugSession(() => { d.dispose(); r(); }); setTimeout(() => { d.dispose(); r(); }, 2000); });
    await vscode.debug.stopDebugging();
    await ended;
  }
  if (vscode.debug.activeDebugSession) { throw new Error('a debug session is still running after Stop'); }
}

/** Wraps a test file's tests: each ends with every debug session stopped, pass or fail. */
function suite(tests) {
  const out = {};
  for (const [name, fn] of Object.entries(tests)) {
    out[name] = async (t) => { try { await fn(t); } finally { await stopAll(); await outsideWrites(undefined); } };
  }
  return out;
}

async function session() { return vscode.commands.executeCommand('vaporview.debugger.e2e', { kind: 'session' }); }

/** Opens the fixture and attaches the debugger; resolves at the entry stop. */
/** vaporview.wisp.outsideWrites (read when a file opens): 'none' states nothing outside the simulation wrote the dump's
 *  signals, so the helper computes port copies (wisp-helper 15.10+). */
async function outsideWrites(value) {
  const c = vscode.workspace.getConfiguration('vaporview');
  // Workspace scope (the setting is no longer machine-scoped); each test restores it to unset afterwards.
  if (c.inspect('wisp.outsideWrites')?.workspaceValue !== value) { await c.update('wisp.outsideWrites', value, vscode.ConfigurationTarget.Workspace); }
}

/** `opts.outsideWrites`: 'unset' opens an FSDB/WCZ twin without the setting (no helper-computed port copies; cases). */
async function start(extra = {}, file = 'dbg/dbg.vcd', opts = {}) {
  // FSDB/WCZ (E2E_FORMAT twins, or a file given): through wisp-helper.
  const fmt = require('./helpers.cjs').format;
  // The VCS twins of the fixture are plain simulation dumps (no force/deposit, no outside writes): stated, so their
  // port copies (u1.en, w0, wrap, next ...) carry values, as the VCD's do.
  if (fmt !== 'vcd' && typeof file === 'string') { await closeAll(); await outsideWrites(opts.outsideWrites === 'unset' ? undefined : 'none'); }
  if ((fmt !== 'vcd' || typeof file !== 'string') && !(await require('./wisp-common.cjs').useHelper('dbg on ' + String(file)))) { throw new Error('no wisp-helper (E2E_WISP_HELPER) for ' + String(file)); }
  track();
  await stopAll();
  const uri = String(await open(file));
  sent.length = 0; received.length = 0;
  const before = stops().length;
  const ok = await vscode.debug.startDebugging(undefined, { type: DT, request: 'attach', name: 'e2e waveform', waveform: uri, ...extra }, { suppressSaveBeforeStart: true });
  assert.ok(ok, 'startDebugging');
  await until(async () => stops().length > before, 'entry stop');
  const s = await until(async () => { const x = await session(); return x && x.cycle ? x : null; }, 'session state');
  return { uri, s, dbg: vscode.debug.activeDebugSession };
}

/** Runs `action` and waits for the next stopped event; returns it with the session state. */
async function stopAfter(action, what = 'stop', ms = 20000) {
  const before = stops().length;
  await action();
  const ev = await until(async () => stops()[before], what, ms);
  await sleep(50);
  return { ev, s: await session() };
}

async function marker(uri) {
  const v = await vscode.commands.executeCommand('waveformViewer.getViewerState', { uri });
  return v ? v.markerTime : undefined;
}
/** The viewer's marker reaches `time` (the webview reports it back). */
const markerAt = (uri, time) => until(async () => (await marker(uri)) === time, `viewer marker at ${time}`, 10000, 100);

const custom = (cmd, args) => vscode.debug.activeDebugSession.customRequest(cmd, args);
const e2e = (q) => vscode.commands.executeCommand('vaporview.debugger.e2e', q);

module.exports = { suite, DT, SV, sent, received, stops, stopAll, start, stopAfter, session, marker, markerAt, custom, e2e };
