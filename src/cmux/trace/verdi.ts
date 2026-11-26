// vscode-port: the Verdi cross-check. Port of cmux's WaveformTraceVerdi.swift (cmux branch tracex-wcz
// 44516d52d6a, GPL-3.0 with VaporView), local instead of over SSH: one warm `verdi -nogui -play serve.tcl` session
// per FSDB answers the active driver at a time (srcActiveTrace), and the step's statement is checked against it.
// Our engine still answers the step itself (branch, fan-in, trust); Verdi's answer is shown next to it.
//
// Nothing of Verdi ships: media/cmux/verdi-trace/ holds cmux's own launcher and Tcl script, which run the user's
// installed Verdi (vaporview.trace.verdiHome, else PATH, else VERDI_HOME) with the KDB next to the FSDB. It starts
// only on request, after a licence notice (it takes a licence seat while it runs), and ends with the window or after
// 30 min without a request (the launcher's idle limit).
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class VerdiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface VerdiOptions {
  scripts: string;          // media/cmux/verdi-trace
  fsdb: string;
  daidir?: string;
  verdiHome?: string;       // the user's install: its bin/ goes first on PATH
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  log?: (s: string) => void;
}

export class VerdiSession {
  private proc: ChildProcess | null = null;
  private scratch = '';
  private buf = '';
  private next = 1;
  private pending = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly ready: Promise<Json>;
  info: Json = null;

  constructor(readonly opts: VerdiOptions) {
    this.ready = this.start();
  }

  private start(): Promise<Json> {
    const o = this.opts;
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporview-verdi-'));
    fs.copyFileSync(path.join(o.scripts, 'serve.tcl'), path.join(this.scratch, 'serve.tcl'));
    fs.copyFileSync(path.join(o.scripts, 'verdi-trace.sh'), path.join(this.scratch, 'verdi-trace.sh'));
    const env = Object.assign({}, process.env);
    if (o.verdiHome) { env.VERDI_HOME = o.verdiHome; env.PATH = path.join(o.verdiHome, 'bin') + path.delimiter + (env.PATH || ''); }
    const args = [path.join(this.scratch, 'verdi-trace.sh'), this.scratch, o.fsdb];
    if (o.daidir) { args.push(o.daidir); }
    const proc = spawn('bash', args, { cwd: this.scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let stderr = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new VerdiError('slowStart', 'Verdi did not start in time')); this.stop(); }, o.startTimeoutMs ?? 180000);
      this.pending.set(0, { resolve, reject, timer });
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (d: string) => this.onData(d));
      proc.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-2000); if (o.log) { o.log(String(d)); } });
      proc.on('exit', () => {
        const err = new VerdiError('exited', 'the Verdi session ended' + (stderr.trim() ? ': ' + stderr.trim().split('\n').pop() : ''));
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
        this.proc = null;
      });
      proc.stdin!.on('error', () => { /* ended */ });
    }).then((ready: Json) => {
      if (!ready || ready.ready !== true) { throw new VerdiError(String(ready && ready.error || 'start'), String(ready && ready.message || 'Verdi did not start')); }
      return ready;
    });
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) { continue; }
      let m: Json;
      try { m = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(Number(m.id));
      if (p) { this.pending.delete(Number(m.id)); clearTimeout(p.timer); p.resolve(m); }
    }
  }

  async request(req: Json): Promise<Json> {
    await this.ready;
    const proc = this.proc;
    if (!proc) { throw new VerdiError('exited', 'the Verdi session ended'); }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new VerdiError('timeout', 'Verdi did not answer in time')); }, this.opts.requestTimeoutMs ?? 120000);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin!.write(JSON.stringify(Object.assign({}, req, { id })) + '\n');
    });
  }

  get alive() { return !!this.proc; }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.stdin!.end(); } catch { /* gone */ } setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 2000).unref(); }
    const scratch = this.scratch;
    // (the launcher removes its scratch folder at exit; this is the fallback)
    if (scratch && scratch.startsWith(os.tmpdir())) { setTimeout(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } }, 5000).unref(); }
  }
}

/** The units check of cmux (VerdiTraceLaunch.unitsMatch): Verdi's times are in its window unit; ours are the file's. */
export function unitsMatch(info: Json) {
  const f = String(info && info.fileUnit || ''), w = String(info && info.windowUnit || '');
  return !f || !w || f.toLowerCase() === w.toLowerCase();
}

/** Verdi's answer against our step's statement: agrees (same file and line), or differs (Verdi's location shown). */
export function compare(step: Json, answer: Json): Json {
  if (!answer || answer.ok !== true) {
    return { verdict: 'unavailable', code: String(answer && answer.error || 'failed'), message: String(answer && answer.message || '') };
  }
  const loc = step && step.stmt && step.stmt.loc;
  const verdi = { file: String(answer.file), line: Number(answer.line), scope: String(answer.scope || '') };
  const same = !!loc && path.resolve(String(loc.file)) === path.resolve(verdi.file) && Number(loc.line) === verdi.line;
  return { verdict: same ? 'agrees' : 'differs', verdi };
}

/** The Verdi installation a cross-check would run, found the way the session starts it: the vaporview.trace.verdiHome
 *  setting (its bin/verdi), else verdi on PATH, else VERDI_HOME (its bin/verdi). Null when there is none: the panel then
 *  shows no cross-check at all. */
export function findVerdi(verdiHome: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  if (verdiHome) { return isFile(path.join(verdiHome, 'bin', 'verdi')) ? verdiHome : null; }
  for (const d of String(env.PATH || '').split(path.delimiter)) { if (d && isFile(path.join(d, 'verdi'))) { return path.join(d, 'verdi'); } }
  if (env.VERDI_HOME && isFile(path.join(env.VERDI_HOME, 'bin', 'verdi'))) { return env.VERDI_HOME; }
  return null;
}
