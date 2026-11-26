// vscode-port: pixel-diff gate for the visual suite. No dependencies: a small PNG reader/writer on zlib.
// For every test/visual/out/<name>.png: compare with test/visual/baseline/<name>.png. A pixel differs when any channel
// differs by more than `channel` (0-255); the scenario fails when differing pixels exceed `maxRatio` of the image, or the
// sizes differ, or the baseline is missing. Failures write test/visual/out/<name>.diff.png (differences in red over a
// faded copy of the new image). Tolerances: test/visual/tolerance.json ("default" + per-name overrides).
// UPDATE_BASELINES=1 copies out/*.png (not *.diff.png) over the baselines: only after looking at the new images.
// BASELINE_ONLY=<regex> limits the update to matching names. tolerance.json "hold": name regexes whose screenshots are
// reviewed but not yet approved (waiting on an owner's fix): reported as HOLD, not compared, not failed.
// Usage: node test/visual/diff.mjs [--require name,name]   Exit 1 on any FAIL.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// VISUAL_SET=mac: the macOS Playwright captures (out-mac/ vs baseline-mac/), kept apart from the Linux set.
const mac = process.env.VISUAL_SET === 'mac';
const outDir = path.join(here, mac ? 'out-mac' : 'out');
const baseDir = path.join(here, mac ? 'baseline-mac' : 'baseline');

export function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) { throw new Error('not a PNG'); }
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, palette = null; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') { palette = data; }
    else if (type === 'IDAT') { idat.push(data); }
    else if (type === 'IEND') { break; }
    off += 12 + len;
  }
  if (depth !== 8 || interlace) { throw new Error(`unsupported PNG depth ${depth} interlace ${interlace}`); }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch; const px = Buffer.alloc(w * h * ch); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0; let v = line[i];
      if (f === 1) { v += a; } else if (f === 2) { v += b; } else if (f === 3) { v += (a + b) >> 1; }
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r, g, b, al = 255;
    if (ctype === 2 || ctype === 6) { r = px[i * ch]; g = px[i * ch + 1]; b = px[i * ch + 2]; if (ctype === 6) { al = px[i * ch + 3]; } }
    else if (ctype === 3) { const k = px[i]; r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; }
    else { r = g = b = px[i * ch]; if (ctype === 4) { al = px[i * ch + 1]; } }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = al;
  }
  return { w, h, rgba };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) { c = crcTable[(c ^ x) & 255] ^ (c >>> 8); } return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]);
}
export function writePng({ w, h, rgba }) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const inMask = (masks, x, y) => masks.some((m) => x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1);
export function compare(a, b, channel, masks = []) {
  if (a.w !== b.w || a.h !== b.h) { return { sizeMismatch: true, diff: a.w * a.h, ratio: 1 }; }
  const n = a.w * a.h; let diff = 0; const img = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (masks.length && inMask(masks, i % a.w, Math.floor(i / a.w))) { img[o] = 120; img[o + 1] = 160; img[o + 2] = 255; img[o + 3] = 255; continue; } // masked: blue
    const d = Math.max(Math.abs(a.rgba[o] - b.rgba[o]), Math.abs(a.rgba[o + 1] - b.rgba[o + 1]), Math.abs(a.rgba[o + 2] - b.rgba[o + 2]));
    if (d > channel) { diff++; img[o] = 255; img[o + 1] = 0; img[o + 2] = 0; }
    else { const g = (b.rgba[o] + b.rgba[o + 1] + b.rgba[o + 2]) / 3; const v = Math.round(255 - (255 - g) * 0.25); img[o] = img[o + 1] = img[o + 2] = v; }
    img[o + 3] = 255;
  }
  return { diff, ratio: diff / n, image: { w: a.w, h: a.h, rgba: img } };
}

function main() {
  const tol = JSON.parse(fs.readFileSync(path.join(here, 'tolerance.json'), 'utf8'));
  const req = process.argv.includes('--require') ? process.argv[process.argv.indexOf('--require') + 1].split(',') : [];
  const shots = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png') && !f.endsWith('.diff.png')).sort() : [];
  if (process.env.UPDATE_BASELINES === '1') {
    fs.mkdirSync(baseDir, { recursive: true });
    const only = process.env.BASELINE_ONLY ? new RegExp(process.env.BASELINE_ONLY) : null;
    for (const f of shots.filter((x) => !only || only.test(x.replace(/\.png$/, '')))) { fs.copyFileSync(path.join(outDir, f), path.join(baseDir, f)); console.log(`BASELINE UPDATED ${f}`); }
    return;
  }
  let fail = 0, pass = 0;
  const names = new Set(shots.map((f) => f.replace(/\.png$/, '')));
  for (const r of req) { if (!names.has(r)) { fail++; console.log(`VISUAL FAIL ${r}: no screenshot`); } }
  for (const f of fs.existsSync(baseDir) ? fs.readdirSync(baseDir).filter((x) => x.endsWith('.png')) : []) {
    if (!names.has(f.replace(/\.png$/, ''))) { fail++; console.log(`VISUAL FAIL ${f.replace(/\.png$/, '')}: baseline has no new screenshot`); }
  }
  const hold = (tol.hold || []).map((r) => new RegExp(r));
  // Shots of another format than the baselines' (fsdb) show its file name: mask only where the name is drawn.
  const fmtFile = path.join(outDir, '.format');
  const fmt = fs.existsSync(fmtFile) ? fs.readFileSync(fmtFile, 'utf8').trim() : 'fsdb';
  const nm = fmt !== 'fsdb' ? ((tol.nameMasks || {})[mac ? 'mac' : 'linux'] || {}) : {};
  if (fmt !== 'fsdb') { console.log(`VISUAL FORMAT ${fmt}: file-name masks applied (title bar, editor tabs, dbg-break call stack)`); }
  for (const f of shots) {
    const name = f.replace(/\.png$/, '');
    if (hold.some((r) => r.test(name)) && !fs.existsSync(path.join(baseDir, f))) { console.log(`VISUAL HOLD ${name}: reviewed, baseline held until its owner's fix merges`); continue; }
    const t = Object.assign({}, tol.default, tol[name] || {});
    const bp = path.join(baseDir, f);
    if (!fs.existsSync(bp)) { fail++; console.log(`VISUAL FAIL ${name}: no baseline (look at out/${f}, then UPDATE_BASELINES=1)`); continue; }
    const r = compare(readPng(fs.readFileSync(path.join(outDir, f))), readPng(fs.readFileSync(bp)), t.channel, [...(nm['*'] || []), ...(nm[name] || [])]);
    const pct = (r.ratio * 100).toFixed(3);
    if (r.sizeMismatch || r.ratio > t.maxRatio) {
      fail++;
      if (r.image) { fs.writeFileSync(path.join(outDir, name + '.diff.png'), writePng(r.image)); }
      console.log(`VISUAL FAIL ${name}: ${r.sizeMismatch ? 'size differs' : `${r.diff} px (${pct}%) > ${(t.maxRatio * 100).toFixed(3)}%`} -> out/${name}.diff.png`);
    } else { pass++; console.log(`VISUAL PASS ${name}: ${r.diff} px (${pct}%) <= ${(t.maxRatio * 100).toFixed(3)}%`); }
  }
  console.log(`VISUAL SUMMARY pass=${pass} fail=${fail}`);
  if (fail || !pass) { process.exitCode = 1; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { main(); }
