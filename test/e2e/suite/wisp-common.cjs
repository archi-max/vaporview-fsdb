// vscode-port: shared setup for the wisp-helper (FSDB / WCZ) e2e tests.
// Env (forwarded by tools/linux-test.sh): E2E_WISP_HELPER (the helper binary), E2E_WCZ_TOOLS (dir with
// wcz-from-vcd), E2E_FSDB_DIR (internal FSDB fixtures; never in the repo).
const fs = require('fs');
const { vscode, until, query, sleep } = require('./helpers.cjs');

const HELPER = process.env.E2E_WISP_HELPER || '';
const TOOLS = process.env.E2E_WCZ_TOOLS || '';
const FSDB_DIR = process.env.E2E_FSDB_DIR || '';

function helperAvailable() { try { fs.accessSync(HELPER, fs.constants.X_OK); return true; } catch { return false; } }

// Returns false (and prints a SKIP line) when the helper is not on this machine.
async function useHelper(what) {
  if (!HELPER || !helperAvailable()) { console.log(`SKIP ${what}: no wisp-helper (E2E_WISP_HELPER=${HELPER || 'unset'})`); return false; }
  const c = vscode.workspace.getConfiguration('vaporview');
  if (c.get('wispHelperPath') !== HELPER) await c.update('wispHelperPath', HELPER, vscode.ConfigurationTarget.Global);
  return true;
}

// Settings that describe a dump (resource scope) are written where users put them: the folder's .vscode/settings.json
// (Workspace target). Machine settings can only be user-level (Global).
const PER_DUMP = new Set(['wisp.outsideWrites', 'wisp.portLinks', 'wisp.simulatedLink']);
async function setSetting(key, value) {
  await vscode.workspace.getConfiguration('vaporview').update(key, value, PER_DUMP.has(key) ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}

const state = (q) => query(Object.assign({ kind: 'state' }, q || {}));
const wispState = (uri) => vscode.commands.executeCommand('vaporview.e2e.wispState', String(uri));

async function add(uri, paths) {
  for (const p of paths) await vscode.commands.executeCommand('waveformViewer.addVariable', { uri: String(uri), instancePath: p });
  await until(async () => { const s = await state(); return paths.every((p) => s.rows.some((r) => r.name === p.split('.').pop())) ? s : null; }, 'rows ' + paths.join(','));
}

async function apiValue(uri, time, p) {
  const r = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', { uri: String(uri), time, instancePaths: [p] });
  if (!r || !r.length) return undefined;
  let v = r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return Array.isArray(v) ? v[v.length - 1] : v;
}

// The viewer's value at the marker for a row (the raw value; [old, new] at a change: the new one).
async function markerValue(name, time) {
  await query({ kind: 'marker', time });
  const s = await until(async () => {
    const st = await state();
    const row = st.rows.find((r) => r.name === name);
    return st.markerTime === time && row && Array.isArray(row.value) && row.value.length ? st : null;
  }, `value of ${name} at ${time}`);
  const v = s.rows.find((r) => r.name === name).value;
  return v[v.length - 1];
}

module.exports = { HELPER, TOOLS, FSDB_DIR, useHelper, setSetting, state, wispState, add, apiValue, markerValue, sleep };
