// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: where wisp-helper is, and the arguments / environment the settings give it.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const BUILD_HINT =
  'Install the VSIX for your platform (it bundles wisp-helper), or set "vaporview.wispHelperPath" to a ' +
  'wisp-helper binary from the release, or build it from wisp-helper/ in the source repository.';

function executable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

// The helper to run: the setting, else the one packaged with the extension (bin/<platform>-<arch>/), else
// `wisp-helper` on PATH. Returns {path} or {error} (a message that says how to get one).
export function locateHelper(extensionPath: string | undefined): {path?: string; error?: string; tried: string[]} {
  const tried: string[] = [];
  const configured = String(vscode.workspace.getConfiguration('vaporview').get('wispHelperPath') || '').trim();
  if (configured) {
    const p = configured.startsWith('~') ? path.join(process.env.HOME || '', configured.slice(1)) : configured;
    tried.push(p);
    if (executable(p)) {return {path: p, tried};}
    return {error: `vaporview.wispHelperPath is set to "${configured}", but no executable is there. ${BUILD_HINT}`, tried};
  }
  if (extensionPath) {
    const packaged = path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`, 'wisp-helper');
    tried.push(packaged);
    if (executable(packaged)) {return {path: packaged, tried};}
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) {continue;}
    const p = path.join(dir, 'wisp-helper');
    if (executable(p)) {tried.push(p); return {path: p, tried};}
  }
  tried.push('wisp-helper on PATH');
  const platformNote = missingHelperNote(process.platform, process.arch);
  return {error: `No wisp-helper found to read FSDB / WCZ files.${platformNote} ${BUILD_HINT}`, tried};
}

// vaporview.wisp.planBudgetMB -> RUN_PLAN_BUDGET_MB (MiB; the helper accepts 64..32768). "auto" (default) =
// clamp(total RAM x 0.4, 4096, 32768); a number is clamped to 64..32768; "off" or 0 leaves the helper's default.
export function planBudgetMB(setting: unknown, totalBytes: number): number | null {
  const v = setting === undefined || setting === null || setting === '' ? 'auto' : String(setting).trim().toLowerCase();
  if (v === 'off' || v === '0') {return null;}
  if (v === 'auto') {return Math.min(32768, Math.max(4096, Math.floor(totalBytes * 0.4 / 1048576)));}
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(32768, Math.max(64, n)) : null;
}

// vscode-port: the helper's inner memory bound (WISP_WORKER_RSS_MB) from the plan budget. The helper refuses loads
// over twice it, so it is kept at 40% of this host's RAM at most (the line at 80%), and never under the helper's own
// default of 1024. null (planBudgetMB off): the helper's default.
// vscode-port: under auto it is also at most 8 GiB. On a 10 GB FSDB the computed signals' first build is
// estimated at ~19 GB; with a 25 GB bound it ran (32.7 s, the dump pushed out of the page cache) where the helper's
// default refused it in 2 ms. At 8 GiB such a build is refused at once with the labelled "no value (computed signals
// need more memory ...)", and a 1.5 GB dump (~3.2 GB build) still computes. A number set by the user is not capped.
export const AUTO_WORKER_CAP_MB = 8192;
export function workerBoundMB(budget: number | null, totalBytes: number, auto = false): number | null {
  if (!budget) {return null;}
  const b = Math.max(1024, Math.min(budget, Math.floor(totalBytes * 0.4 / 1048576)));
  return auto ? Math.min(b, AUTO_WORKER_CAP_MB) : b;
}

// Command-line arguments and environment from the vaporview.wisp.* settings.
// uri: the file being opened, so its folder's resource-scoped settings (wisp.portLinks) apply; machine-scoped ones read
// the same either way.
export function helperLaunch(uri?: vscode.Uri): {args: string[]; env: NodeJS.ProcessEnv} {
  const c = vscode.workspace.getConfiguration('vaporview', uri);
  const args: string[] = [];
  const env: NodeJS.ProcessEnv = {...process.env};
  const workers = Number(c.get('wisp.workers') || 0);
  if (workers > 0) {args.push('--workers', String(Math.min(8, Math.max(1, Math.floor(workers)))));}
  const cacheMb = Number(c.get('wisp.cacheMb') || 0);
  if (cacheMb > 0) {args.push('--cache-mb', String(Math.floor(cacheMb)));}
  const portLinks = c.get<boolean>('wisp.portLinks');
  if (portLinks === false) {env.WISP_PORT_LINKS = '0';}
  const forceLog = String(c.get('wisp.forceLog') || '').trim();
  if (forceLog) {env.WISP_FORCE_LOG = forceLog;}
  // The background whole-file check uses every CPU by default (~4 cores busy for minutes on a 10 GB file);
  // vaporview.wisp.checkThreads (default 2) caps it. An explicit WISP_VERIFY_THREADS in wisp.env still wins.
  const checkThreads = Number(c.get('wisp.checkThreads') ?? 2);
  if (checkThreads > 0 && !process.env.WISP_VERIFY_THREADS) {env.WISP_VERIFY_THREADS = String(Math.min(16, Math.floor(checkThreads)));}
  // vscode-port: the FSDB reader's plan-size cap. auto = 40% of this host's RAM, 4-32 GiB. An explicit
  // RUN_PLAN_BUDGET_MB in the environment or in wisp.env still wins.
  const budget = planBudgetMB(c.get('wisp.planBudgetMB'), os.totalmem());
  if (budget && !process.env.RUN_PLAN_BUDGET_MB) {env.RUN_PLAN_BUDGET_MB = String(budget);}
  // vscode-port: the helper's memory bound follows the same budget. Its default inner bound (about 1 GB, or the
  // RSS right after the open) leaves a computed signal's first request (outsideWrites none) a room of 2 x bound - RSS;
  // on CVA6 that was 462 MiB after a debug stop's first reads, against ~3.2 GiB needed, and the refusal lasts the whole
  // open. WISP_WORKER_RSS_MB = the plan budget; an explicit one in the environment or in wisp.env still wins.
  const pb = c.get('wisp.planBudgetMB');
  const isAuto = pb === undefined || pb === null || pb === '' || String(pb).trim().toLowerCase() === 'auto';
  const worker = workerBoundMB(budget, os.totalmem(), isAuto);
  if (worker && !process.env.WISP_WORKER_RSS_MB) {env.WISP_WORKER_RSS_MB = String(worker);}
  // vscode-port (15.12): when the lazy FSDB open's whole-file check starts (WISP_VERIFY_START). Default idle:30: after
  // 30 s without a request, so the check does not compete with the first reads. An explicit env / wisp.env value wins.
  const verifyStart = String(c.get('wisp.verifyStart') ?? 'idle:30').trim();
  if (/^(open|request|off|idle:\d{1,5})$/.test(verifyStart) && !process.env.WISP_VERIFY_START) {env.WISP_VERIFY_START = verifyStart;}
  const directOpen = String(c.get('wisp.directOpen') || 'lazy');
  if (directOpen === 'full') {env.WISP_DIRECT_OPEN = 'full';}
  const extra = c.get<Record<string, unknown>>('wisp.env') || {};
  for (const [k, v] of Object.entries(extra)) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k) && v !== null && v !== undefined) {env[k] = String(v);}
  }
  return {args, env};
}

// vscode-port: what a user without a helper should do, per platform. The platform VSIX ships the helper for Linux and
// macOS (bin/<platform>-<arch>/wisp-helper); Windows has none, so there the file is opened on a Linux host.
export function missingHelperNote(platform: string, arch: string): string {
  if (platform === 'linux' || platform === 'darwin') {
    return ` This extension's package should include bin/${platform}-${arch}/wisp-helper: reinstall the VSIX for this platform, or set vaporview.wispHelperPath to a wisp-helper you built.`;
  }
  return ` There is no wisp-helper for ${platform}: open the file through Remote-SSH (or WSL) on a Linux or macOS host.`;
}
