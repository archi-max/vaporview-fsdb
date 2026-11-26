// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port (P2, regression fix 11-24): streamed `window {stream: true}` replies through wisp-helper.
//
// cmux's helper (branch helper-stream, fsdb-helper-v2/helper.js) answers a streamed window as partial frames
// {id, partial: true, result: {signals}} + binary, one per worker task of at most STREAM_CHUNK (16) rows, sent as each
// task finishes, then the final frame {id, result: {signals: <the rest>, parts: <partials sent>}}. Every row is sent
// once. wisp-helper 15.7 has no `stream`: it answers the whole window in one reply, so the first rows of a 256-row
// window paint only after the last one is read.
//
// Two paths, same frame contract:
//   - native: the helper says `caps.stream` at open: the request goes as is and the helper's
//     partial frames are forwarded as they come.
//   - split (wisp-helper without caps.stream): the rows are cut into chunks of <= STREAM_CHUNK, each chunk is one
//     helper request, all sent at once (the helper answers them in order, each fanned out over its worker pool), and
//     each chunk's answer goes on as a partial frame in completion order; the last one is the final frame.
// A chunk that fails as a whole (no result) becomes per-row error heads, as a failed row in cmux's stream does, so
// one bad chunk never voids the rows already sent. Cancel stops every chunk.
// No vscode import here: the perf checks (test/perf/) drive this module directly.
import type { HelperReply } from './helper_process';

export const STREAM_CHUNK = 16;

export interface StreamHelper {
  request(req: Record<string, unknown>, onId?: (id: number) => void, onPartial?: (r: HelperReply) => void): Promise<HelperReply>;
}

export interface StreamFrame { line: any; bin: Buffer | null; }

// One streamed window. `send(frame, final)` gets each frame (line without id; the caller sets the viewer's id).
// `onHelperId` gets every helper request id (for cancel). `cancelled()` drops frames once the viewer cancelled.
// `onChunkLine` sees every helper reply line (unverified / refused / per-row errors bookkeeping).
export async function relayStreamedWindow(helper: StreamHelper, req: Record<string, any>, opts: {
  native: boolean;
  chunk?: number;
  send: (frame: StreamFrame, final: boolean) => void;
  onHelperId: (id: number) => void;
  cancelled: () => boolean;
  onChunkLine?: (line: any) => void;
}): Promise<void> {
  const chunk = Math.max(1, opts.chunk ?? STREAM_CHUNK);
  const signals: any[] = Array.isArray(req.signals) ? req.signals : [];
  if (opts.native) {
    let parts = 0;
    const r = await helper.request({...req, stream: true}, opts.onHelperId, (p) => {
      if (opts.cancelled()) {return;}
      opts.onChunkLine?.(p.line);
      parts++;
      opts.send({line: p.line, bin: p.bin}, false);
    });
    if (opts.cancelled()) {return;}
    opts.onChunkLine?.(r.line);
    const line = r.line && r.line.result && !r.line.error ? {...r.line, result: {parts, ...r.line.result}} : r.line;
    opts.send({line, bin: r.bin}, true);
    return;
  }
  const base = {...req};
  delete base.stream;
  const ids = new Set(signals.map((s) => (s && typeof s === 'object' ? s.signalId : s)));
  // One request as before: a window with few rows, or repeated rows (cmux's helper does not stream those either).
  if (signals.length <= chunk || ids.size !== signals.length) {
    const r = await helper.request(base, opts.onHelperId);
    if (opts.cancelled()) {return;}
    opts.onChunkLine?.(r.line);
    const line = r.line && r.line.result && !r.line.error ? {...r.line, result: {...r.line.result, parts: 0}} : r.line;
    opts.send({line, bin: r.bin}, true);
    return;
  }
  const chunks: any[][] = [];
  // vscode-port (perf 11-25): chunk sizes grow (16, 16, 32, 64, ...): the first rows still come back after one small
  // request, and a 256-row window is 5 helper requests instead of 16 (each request re-reads its blocks and pays a round
  // trip; 16 equal chunks cost ~18% over one unstreamed request, the limit is 5%).
  for (let k = 0, size = chunk; k < signals.length; k += size, size = k > chunk ? size * 2 : size) {
    chunks.push(signals.slice(k, k + size));
  }
  let left = chunks.length, parts = 0;
  const t0 = Date.now();
  await Promise.all(chunks.map((list) => helper.request({...base, signals: list}, opts.onHelperId).then((r) => {
    left--;
    if (opts.cancelled()) {return;}
    opts.onChunkLine?.(r.line);
    let line = r.line || {};
    let bin = r.bin;
    if (line.cancelled) {return;}  // (the helper cancelled it: the viewer did)
    if (line.error || !line.result || !Array.isArray(line.result.signals)) {
      const error = String(line.error || 'no result');
      line = {result: {signals: list.map((s) => ({signalId: s && typeof s === 'object' ? s.signalId : s, error, bytes: 0, bucketBytes: 0}))},
        ...(line.code ? {code: line.code} : {})};
      bin = null;
    }
    const out = {...line};
    delete out.binLength;
    if (left > 0) {
      parts++;
      opts.send({line: {...out, partial: true}, bin}, false);
    } else {
      opts.send({line: {...out, result: {...out.result, parts}, relayMs: Date.now() - t0}, bin}, true);
    }
  })));
}

// The reply's bytes as a Uint8Array that covers its whole ArrayBuffer. VS Code's webview postMessage transfers a view's
// whole underlying buffer (with the view's offset), so a slice of a 64 KB pipe chunk or of Node's 8 KB pool would carry
// the rest of that buffer too: copied once here, and only then.
export function exactBytes(b: Buffer): Uint8Array {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) {return new Uint8Array(b.buffer, 0, b.byteLength);}
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
}
