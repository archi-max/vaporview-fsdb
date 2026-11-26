// vscode-port P4: text breakpoints' judging (cmux-debugger-text.js), in a worker thread with a watchdog so a pattern
// that backtracks without end cannot freeze the extension host. Each distinct value is judged once and memoized.
import * as path from 'path';
import { Worker } from 'worker_threads';
import { createRequire } from 'module';

export type TextSpec = { format: string; pattern: string; caseSensitive?: boolean; anyRegisterNames?: boolean };

const WATCHDOG_MS = 2000;
const BATCH = 50000;
const MAX_DISTINCT = 4000000;

let formatsPath = '';
export function setFormatsPath(extensionPath: string) { formatsPath = path.join(extensionPath, 'dist', 'cmux-formats.js'); }

let formatsModule: any = null;
/** The bundled formatters + cmux-textmatch.js (dist/cmux-formats.js), loaded on first use. */
export function textMatch(): any {
  if (!formatsModule) {
    // A run-time require: the bundle is a separate file (see esbuild.js formatsConfig).
    formatsModule = createRequire(formatsPath)(formatsPath);
  }
  return formatsModule.textMatch;
}

const WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const T = require(workerData.formatsPath).textMatch;
parentPort.on('message', (m) => {
  try { parentPort.postMessage({ id: m.id, mask: Array.from(T.judge(m.spec, m.values)) }); }
  catch (e) { parentPort.postMessage({ id: m.id, error: String(e) }); }
});`;

let worker: Worker | null = null;
let nextJob = 1;
const pending = new Map<number, { resolve: (r: { mask?: number[]; error?: string }) => void; timer: NodeJS.Timeout }>();

function startWorker(): Worker {
  if (worker) { return worker; }
  const w = new Worker(WORKER_CODE, { eval: true, workerData: { formatsPath } });
  w.on('message', (m: any) => {
    const job = pending.get(m.id);
    if (!job) { return; }
    pending.delete(m.id);
    clearTimeout(job.timer);
    job.resolve(m.error ? { error: m.error } : { mask: m.mask });
  });
  w.on('error', () => stopWorker('error'));
  w.unref();
  worker = w;
  return w;
}

function stopWorker(why: string) {
  if (worker) { void worker.terminate(); }
  worker = null;
  for (const [id, job] of pending) { clearTimeout(job.timer); job.resolve({ error: why }); pending.delete(id); }
}

export function disposeTextJudge() { stopWorker('closed'); memo.clear(); }

function judgeBatch(spec: TextSpec, values: string[], watchdogMs: number): Promise<{ mask?: number[]; error?: string }> {
  const w = startWorker();
  const id = nextJob++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => stopWorker('slow'), watchdogMs);
    pending.set(id, { resolve, timer });
    w.postMessage({ id, spec, values });
  });
}

const memo = new Map<string, Map<string, boolean>>();

/** bits -> matched for `values` under `spec`; a string (why) when it cannot judge (bad spec, slow, too many values). */
export async function verdicts(memoKey: string, spec: TextSpec, values: string[], watchdogMs = WATCHDOG_MS): Promise<Map<string, boolean> | string> {
  const error = textMatch().check(spec);
  if (error) { return error; }
  const key = memoKey + '\u0000' + JSON.stringify([spec.format, spec.pattern, !!spec.caseSensitive, spec.anyRegisterNames !== false]);
  let m = memo.get(key);
  if (!m) { m = new Map(); memo.set(key, m); if (memo.size > 64) { memo.delete(memo.keys().next().value as string); } }
  // One pass, as cmux's verdicts (no filtered copy of every value).
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const b of values) { if (!m.has(b) && !seen.has(b)) { seen.add(b); unknown.push(b); } }
  if (unknown.length + m.size > MAX_DISTINCT) { return 'tooManyValues'; }
  for (let k = 0; k < unknown.length; k += BATCH) {
    const batch = unknown.slice(k, k + BATCH);
    const r = await judgeBatch(spec, batch, watchdogMs);
    if (r.error || !r.mask) { return r.error === 'slow' ? 'slow' : (r.error || 'error'); }
    batch.forEach((b, j) => m!.set(b, r.mask![j] === 1));
  }
  return m;
}

export function textOf(spec: TextSpec, bits: string): string {
  try { return String(textMatch().textOf(spec, bits)); } catch { return bits; }
}
