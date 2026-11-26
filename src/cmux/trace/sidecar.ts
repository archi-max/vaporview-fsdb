// vscode-port: the cmux-sv-model sidecar (driver tracing's design model, built on slang) for the
// extension host. Port of cmux's SVModelSidecar + SVDesignSession (Packages/Shared/CmuxSyntaxHighlighting,
// branch tracex-wcz 44516d52d6a), GPL-3.0 with VaporView.
//
// Protocol (media/cmux/sv-model/sv_model.cpp): JSON lines on stdin/stdout, a ready line {"id":0,"ready":true}
// first, then one reply per request matched by id; {"ok":false,"error","message"} fails a request.
// The program is built from the bundled sources (media/cmux/sv-model, build.sh) into
// <cache>/sv-model/<sources hash>-<arch> the first time it is needed, on the machine the extension host runs on
// (a Remote-SSH host for a remote folder), under nice with at most 4 jobs. Progress lines of build.sh
// ("cmux-sv-model-build: stage|progress ...") are reported to the caller.
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface BuildProgress { stage: string; percent?: number; message?: string }

export class SidecarError extends Error {
  constructor(public code: string, message: string, public detail = '') { super(message); }
}

const SOURCES = ['CMakeLists.txt', 'build.sh', 'sv-model.sh', 'sv_model.cpp'];
const READY_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 40 * 60_000;

/** The folder the sidecar for these sources is installed in (named by their hash, like cmux). */
export function installDir(sourceDir: string, cacheRoot?: string): string {
  const h = crypto.createHash('sha256');
  for (const f of SOURCES) { h.update(fs.readFileSync(path.join(sourceDir, f))); }
  const root = cacheRoot || process.env.VAPORVIEW_CMUX_CACHE || path.join(os.homedir(), '.cache', 'vaporview-cmux');
  return path.join(root, 'sv-model', h.digest('hex').slice(0, 16) + '-' + os.arch().replace('x64', 'x86_64'));
}

const BUILD_MESSAGES: Record<number, string> = {
  20: 'CMake 3.20 or later was not found (set CMUX_CMAKE).',
  21: 'No C++20 compiler was found (GCC 11+ or Clang 16+).',
  22: 'Python 3 was not found (slang\'s build needs it).',
  23: 'Downloading slang or one of its dependencies failed (offline? put the tarballs in $CMUX_SV_MODEL_TARBALLS).',
  24: 'A downloaded source tarball has the wrong checksum.',
  25: 'Configuring the design model build failed.',
  26: 'Compiling the design model failed.',
  27: 'The built design model does not run.',
  28: 'Installing the design model failed.',
};

/** Builds the sidecar into `dest` with build.sh. Resolves when installed. */
export function buildSidecar(sourceDir: string, dest: string, onProgress: (p: BuildProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    onProgress({ stage: 'fetch' });
    const env = Object.assign({}, process.env, {
      PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin',
      CMUX_SV_MODEL_JOBS: process.env.CMUX_SV_MODEL_JOBS || '4',
    });
    const child = cp.spawn('nice', ['-n', '10', 'sh', path.join(sourceDir, 'build.sh'), sourceDir, dest], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    let buf = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, BUILD_TIMEOUT_MS);
    child.stderr.on('data', (d: Buffer) => {
      buf += d.toString();
      tail = (tail + d.toString()).slice(-4000);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^cmux-sv-model-build: (stage|progress) (\S+)/.exec(line);
        if (m && m[1] === 'stage') { onProgress({ stage: m[2] }); }
        if (m && m[1] === 'progress') { onProgress({ stage: 'compile', percent: Number(m[2]) }); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(new SidecarError('setupFailed', String(e))); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) { onProgress({ stage: 'install' }); resolve(); return; }
      reject(new SidecarError('setupFailed', BUILD_MESSAGES[code ?? -1] || `The design model build failed (exit ${code}).`, tail.split('\n').slice(-12).join('\n')));
    });
  });
}

interface Pending { resolve: (r: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; load: boolean }

/** One running cmux-sv-model. Each load's reply makes a design generation (a new fingerprint, a new generation). */
export class SvModelSidecar {
  private child: cp.ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = '';
  private fingerprint: string | null = null;
  public generation = 0;
  public lastLoad: Json = null;
  private lastLoadRequest: Json = null;

  constructor(private readonly sourceDir: string, private readonly onProgress: (p: BuildProgress) => void = () => {}, private readonly cacheRoot?: string) {}

  // vscode-port: a platform VSIX may ship the sidecar prebuilt for exactly these sources, at
  // <extension>/bin/<platform>-<arch>/sv-model/<hash>-<arch>/ (tools/package.sh); then nothing is built on first use.
  // Any other sources hash (or no prebuilt) builds into the cache as before.
  get dir() {
    const cached = installDir(this.sourceDir, this.cacheRoot);
    const packaged = path.join(this.sourceDir, '..', '..', '..', 'bin', `${process.platform}-${process.arch}`, 'sv-model', path.basename(cached));
    if (!this.cacheRoot && !process.env.VAPORVIEW_SV_MODEL_NO_PREBUILT && fs.existsSync(path.join(packaged, 'cmux-sv-model')) && fs.existsSync(path.join(packaged, 'sv-model.sh'))) { return packaged; }
    return cached;
  }
  /** (e2e: peak memory) the sidecar's shell process, while it runs. */
  get pid(): number | undefined { return this.child ? this.child.pid : undefined; }
  installed(): boolean { return fs.existsSync(path.join(this.dir, 'cmux-sv-model')) && fs.existsSync(path.join(this.dir, 'sv-model.sh')); }

  private async ensureRunning(): Promise<void> {
    if (this.child) { return; }
    if (!this.starting) {
      this.starting = (async () => {
        // vscode-port: no prebuilt for Windows and build.sh needs a POSIX shell: say so, don't fail obscurely
        if (!this.installed() && process.platform === 'win32') {
          throw new SidecarError('setupFailed', 'Driver tracing is not supported on Windows yet. Open the design through Remote-SSH or WSL (Linux), or use a Mac or Linux machine.');
        }
        if (!this.installed()) { await buildSidecar(this.sourceDir, this.dir, this.onProgress); this.onProgress({ stage: 'load' }); }
        await this.launch();
        // A restarted sidecar gets the last design again first (its answers name a generation).
        if (this.lastLoadRequest) { await this.send(this.lastLoadRequest, true); }
      })().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  private launch(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = cp.spawn('sh', [path.join(this.dir, 'sv-model.sh')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let ready = false;
      let out = '';
      const timer = setTimeout(() => { if (!ready) { child.kill(); reject(new SidecarError('exited', 'The design model did not start in time.')); } }, READY_TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        let i;
        while ((i = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, i); out = out.slice(i + 1);
          const at = line.indexOf('{');
          if (at < 0) { continue; }
          let obj: Json;
          try { obj = JSON.parse(line.slice(at)); } catch { continue; }
          if (!ready) {
            if (obj.ready === true) { ready = true; clearTimeout(timer); this.child = child; resolve(); }
            continue;
          }
          this.onReply(obj);
        }
      });
      child.stderr.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
      child.on('error', (e) => { clearTimeout(timer); reject(new SidecarError('exited', String(e))); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!ready) { reject(new SidecarError(code === 87 ? 'notInstalled' : 'exited', `The design model exited (${code}): ${this.stderrTail.slice(-400)}`)); }
        if (this.child === child) { this.child = null; }
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new SidecarError('exited', 'The design model exited.')); }
        this.pending.clear();
      });
    });
  }

  private onReply(obj: Json) {
    const id = Number(obj.id);
    const p = this.pending.get(id);
    if (!p) { return; }
    this.pending.delete(id);
    clearTimeout(p.timer);
    const ok = obj.ok !== false;
    if (p.load) {
      const fp = ok && typeof obj.fingerprint === 'string' ? obj.fingerprint : null;
      if (fp === null || fp !== this.fingerprint) { this.generation++; }
      this.fingerprint = fp;
      this.lastLoad = obj;
    }
    obj.__design = this.generation;
    if (ok) { p.resolve(obj); } else { p.reject(new SidecarError(String(obj.error || 'failed'), String(obj.message || obj.error || 'failed'))); }
  }

  private send(object: Json, load: boolean): Promise<Json> {
    const child = this.child;
    if (!child) { return Promise.reject(new SidecarError('exited', 'The design model is not running.')); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new SidecarError('timeout', 'The design model did not answer in time.')); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, load });
      child.stdin.write(JSON.stringify(Object.assign({}, object, { id })) + '\n');
    });
  }

  async request(object: Json): Promise<Json> {
    await this.ensureRunning();
    const load = object.cmd === 'load';
    if (load) { this.lastLoadRequest = object; }
    return this.send(object, load);
  }

  stop() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 2000); }
  }
}

/** One design loaded in a sidecar, its answers kept per generation (SVDesignSession). */
export class DesignSession {
  private keptGeneration = 0;
  private models = new Map<string, Promise<Json | null>>();
  private hierarchyKept: { tops: string[]; instances: string[] } | null = null;
  constructor(public readonly sidecar: SvModelSidecar, public readonly args: string[], public readonly cwd: string) {}

  get generation() { return this.sidecar.generation; }
  get loadMessages(): string[] { return (this.sidecar.lastLoad && this.sidecar.lastLoad.messages) || []; }

  async load(): Promise<{ generation: number; tops: string[]; messages: string[] }> {
    const r = await this.sidecar.request({ cmd: 'load', args: this.args, cwd: this.cwd });
    if (!r.fingerprint) { throw new SidecarError('noProvenance', 'The design model could not say which sources it read.'); }
    this.take(r.__design);
    return { generation: r.__design, tops: r.tops || [], messages: r.messages || [] };
  }

  /** Loads again when a source changed on disk; true when it did. */
  async refresh(): Promise<boolean> {
    const r = await this.sidecar.request({ cmd: 'stale' });
    if (r.changed === true) { await this.load(); return true; }
    return false;
  }

  private take(generation: number) {
    if (generation > this.keptGeneration) { this.keptGeneration = generation; this.models.clear(); this.kept.clear(); this.hierarchyKept = null; }
  }

  async request(object: Json, generation: number): Promise<Json> {
    const r = await this.sidecar.request(object);
    this.take(r.__design);
    if (r.__design !== generation) { throw new SidecarError('designChanged', 'The design changed (a source was edited); trace again.'); }
    return r;
  }

  model(p: string, generation: number): Promise<Json | null> {
    if (generation !== this.keptGeneration) { this.take(generation); }
    let m = this.models.get(p);
    if (!m) {
      m = this.request({ cmd: 'instance', path: p }, generation).then((r) => r.model || null, (e: SidecarError) => {
        this.models.delete(p);
        if (e && e.code === 'noInstance') { return null; }
        throw e;
      });
      if (this.models.size >= 64) { this.models.clear(); }
      this.models.set(p, m);
    }
    return m;
  }

  // Lookups and writers, kept per design load like cmux's page kept its sessions' model answers (sessionModels): a
  // trace asks the same few paths many times, each a sidecar round trip otherwise.
  private kept = new Map<string, Promise<Json>>();
  private keep<T>(key: string, generation: number, ask: () => Promise<T>): Promise<T> {
    if (generation !== this.keptGeneration) { this.take(generation); }
    let k = this.kept.get(key) as Promise<T> | undefined;
    if (!k) {
      k = ask().catch((e) => { this.kept.delete(key); throw e; });
      if (this.kept.size >= 4096) { this.kept.clear(); }
      this.kept.set(key, k as Promise<Json>);
    }
    return k;
  }

  lookup(p: string, generation: number): Promise<{ instance: string; name: string } | null> {
    return this.keep('lookup:' + p, generation, () => this.lookupNow(p, generation));
  }

  writers(p: string, generation: number): Promise<string[]> {
    return this.keep('writers:' + p, generation, () => this.writersNow(p, generation));
  }

  private async lookupNow(p: string, generation: number): Promise<{ instance: string; name: string } | null> {
    try {
      const r = await this.request({ cmd: 'lookup', path: p }, generation);
      return typeof r.instance === 'string' && typeof r.name === 'string' ? { instance: r.instance, name: r.name } : null;
    } catch (e) {
      if (e instanceof SidecarError && e.code === 'noInstance') { return null; }
      throw e;
    }
  }

  private async writersNow(p: string, generation: number): Promise<string[]> {
    const r = await this.request({ cmd: 'writers', path: p }, generation);
    return Array.isArray(r.writers) ? r.writers : [];
  }

  async hierarchy(generation: number): Promise<{ tops: string[]; instances: string[] }> {
    if (this.hierarchyKept && generation === this.keptGeneration) { return this.hierarchyKept; }
    const r = await this.request({ cmd: 'instances' }, generation);
    this.hierarchyKept = { tops: r.tops || [], instances: r.instances || [] };
    return this.hierarchyKept;
  }
}
