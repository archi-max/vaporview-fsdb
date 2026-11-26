// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: one wisp-helper process per open waveform file (FSDB / WCZ), the native reader from
// wisp-helper/ in this repository (MIT). Adapted from an earlier web viewer prototype (ReplyParser,
// FsdbHelper) and the process lifecycle of cmux Sources/Panels/WaveformFSDBHelper.swift (request ids,
// cancel, timeouts).
//
// Protocol (helper/README.md): one JSON request per line on stdin; replies as JSON lines on fd 3, a reply
// with `binLength` is followed by that many raw bytes on the same descriptor. Replies can come in any order
// (every request carries an id). Lines without a request id are events: `{"id":0,"ready":true,...}` at start,
// and `{"event":"fileRefused",...}` when the lazy FSDB open's background check refuses the file.
import { spawn, type ChildProcess } from 'child_process';

export interface HelperReply { line: any; bin: Buffer | null; }

// Splits the helper's reply stream into { line, bin }. Linear in the reply size: chunks are kept in a
// list and joined once per JSON line or binary body.
export class ReplyParser {
  private parts: Buffer[] = [];
  private have = 0;
  private scanned = 0;
  private want: {line: any; n: number} | null = null;
  constructor(private onReply: (r: HelperReply) => void) {}

  private take(n: number): Buffer {
    const first = this.parts[0];
    let out: Buffer;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) {this.parts.shift();} else {this.parts[0] = first.subarray(n);}
    } else {
      out = Buffer.allocUnsafe(n);
      let o = 0;
      while (o < n) {
        const p = this.parts[0], k = Math.min(p.length, n - o);
        p.copy(out, o, 0, k); o += k;
        if (k === p.length) {this.parts.shift();} else {this.parts[0] = p.subarray(k);}
      }
    }
    this.have -= n;
    return out;
  }

  private newline(): number {
    let base = 0;
    for (const p of this.parts) {
      if (base + p.length > this.scanned) {
        const i = p.indexOf(10, Math.max(0, this.scanned - base));
        if (i >= 0) {return base + i;}
      }
      base += p.length;
    }
    this.scanned = base;
    return -1;
  }

  push(chunk: Buffer) {
    if (!chunk.length) {return;}
    this.parts.push(chunk); this.have += chunk.length;
    for (;;) {
      if (this.want) {
        if (this.have < this.want.n) {return;}
        const bin = this.take(this.want.n);  // (no copy: take() returns a slice of the chunk, or one joined buffer)
        const line = this.want.line;
        this.want = null;
        this.onReply({line, bin});
        continue;
      }
      const nl = this.have ? this.newline() : -1;
      if (nl < 0) {return;}
      const text = this.take(nl + 1).subarray(0, nl).toString('utf8');
      this.scanned = 0;
      let line: any;
      try { line = JSON.parse(text); } catch { continue; }
      const n = Number(line.binLength) || 0;
      if (n > 0) {this.want = {line, n};} else {this.onReply({line, bin: null});}
    }
  }
}

export interface HelperOptions {
  helperPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  onEvent: (event: any) => void;       // fileRefused and any other id-less line with `event`
  timeoutMs?: number;                  // per request (open: at least 10 min)
}

interface Pending {
  resolve: (r: HelperReply) => void;
  timer: NodeJS.Timeout;
  cmd: string;
  onPartial?: (r: HelperReply) => void;  // window {stream: true}: the helper's partial frames, as they come
}

export class WispHelperProcess {
  private proc: ChildProcess | undefined;
  private next = 1;
  private pending = new Map<number, Pending>();
  private stderrTail = '';
  public dead: string | null = null;
  public pid: number | undefined;
  public readonly timeoutMs: number;

  constructor(private opts: HelperOptions) {
    this.timeoutMs = opts.timeoutMs ?? 120000;
  }

  start() {
    if (this.proc || this.dead) {return;}
    const proc = spawn(this.opts.helperPath, this.opts.args, {stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: this.opts.env});
    this.proc = proc;
    this.pid = proc.pid;
    const parser = new ReplyParser((r) => this.reply(r));
    (proc.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => parser.push(d));
    proc.stdout!.on('data', (d: Buffer) => this.opts.log('wisp-helper stdout: ' + String(d).trimEnd()));
    proc.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      this.opts.log('wisp-helper: ' + String(d).trimEnd());
    });
    proc.stdin!.on('error', (e: any) => this.fail(`wisp-helper stopped (${e.code || e.message})`));
    proc.on('error', (e: any) => this.fail(`wisp-helper could not start: ${e.message || e}`));
    proc.on('close', (code, signal) => {
      const tail = this.stderrTail.trim().split('\n').slice(-2).join(' | ');
      this.fail(`wisp-helper stopped (exit ${code ?? signal})${tail ? ': ' + tail : ''}`);
    });
  }

  private fail(message: string) {
    if (!this.dead) {this.dead = message; this.opts.log(message);}
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({line: {error: message}, bin: null}); }
    this.pending.clear();
  }

  private reply(r: HelperReply) {
    const line = r.line;
    if (!line) {return;}
    if (line.event !== undefined) { try { this.opts.onEvent(line); } catch (e) { this.opts.log('event handler: ' + e); } return; }
    if (line.id === 0 || line.id === undefined || line.id === -1) {
      if (line.error) {this.opts.log('wisp-helper: ' + line.error);}
      return;
    }
    const p = this.pending.get(line.id);
    if (!p) {return;}  // the answer to something cancelled or timed out
    if (line.partial) {  // a streamed window's partial frame: the request stays pending until the final one
      if (p.onPartial) { try { p.onPartial(r); } catch (e) { this.opts.log('partial: ' + e); } }
      return;
    }
    this.pending.delete(line.id);
    clearTimeout(p.timer);
    p.resolve(r);
  }

  // Sends one request; resolves with its reply (errors are replies with `error`, never rejections).
  // onId gets the helper's id for the request, so it can be cancelled.
  request(req: Record<string, unknown>, onId?: (id: number) => void, onPartial?: (r: HelperReply) => void): Promise<HelperReply> {
    if (this.dead) {return Promise.resolve({line: {error: this.dead}, bin: null});}
    this.start();
    if (this.dead) {return Promise.resolve({line: {error: this.dead}, bin: null});}
    const id = this.next++;
    const cmd = String(req.cmd);
    if (onId) {onId(id);}
    return new Promise((resolve) => {
      const limit = cmd === 'open' || cmd === 'verify' ? Math.max(this.timeoutMs, 600000) : this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Tell the helper too: a request nobody waits for should not keep its workers busy.
        this.write({id: this.next++, cmd: 'cancel', target: id});
        resolve({line: {error: `wisp-helper did not answer ${cmd} in ${Math.round(limit / 1000)} s`}, bin: null});
      }, limit);
      this.pending.set(id, {resolve, timer, cmd, onPartial});
      this.write({...req, id});
    });
  }

  cancel(helperId: number) {
    const p = this.pending.get(helperId);
    if (!p) {return;}
    p.onPartial = undefined;  // (a cancelled request's partials stop here, whatever the helper still sends)
    this.write({id: this.next++, cmd: 'cancel', target: helperId});
  }

  private write(obj: Record<string, unknown>) {
    try { this.proc?.stdin?.write(JSON.stringify(obj) + '\n'); } catch (e) { this.fail('wisp-helper stopped: ' + e); }
  }

  close() {
    const p = this.proc;
    if (!p) {return;}
    try { p.stdin!.write('{"id":999999999,"cmd":"close"}\n'); p.stdin!.end(); } catch { /* already gone */ }
    const t = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* gone */ } }, 3000);
    t.unref();
    this.fail('closed');
  }
}
