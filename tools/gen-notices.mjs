#!/usr/bin/env node
// vscode-port: writes THIRD-PARTY-NOTICES.txt for one VSIX target, generated from what is in it:
//   - npm packages: the inputs of the esbuild bundles (metafiles from VV_METAFILE_DIR) + node_modules folders the
//     .vscodeignore keeps (codicons);
//   - Rust crates compiled into filehandler.wasm: `cargo metadata` (offline), normal dependencies reachable from the
//     filehandler crate for wasm32-unknown-unknown;
//   - native parts of the VSIX target (wisp-helper and its static zlib / LLVM libc++ / zstd; sv-model and slang) from
//     the --native list the packaging script passes, with licence files from their source trees.
// Usage: node tools/gen-notices.mjs --meta <dir> --out <file> [--native <name>=<licence file>[,...]]...
// Fails (exit 1) when a bundled package has no licence text, so nothing ships unattributed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const natives = []; args.forEach((a, i) => { if (a === '--native') natives.push(args[i + 1]); });
const metaDir = opt('--meta'), out = opt('--out');
if (!metaDir || !out) { console.error('usage: gen-notices.mjs --meta <dir> --out <file> [--native name|licence|file]'); process.exit(2); }

const LICENCE_FILES = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
function licenceTexts(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => LICENCE_FILES.test(n) && fs.statSync(path.join(dir, n)).isFile()); } catch { /* none */ }
  return names.sort().map((n) => ({ file: n, text: fs.readFileSync(path.join(dir, n), 'utf8').trim() }));
}
const missing = [];
const sections = [];

// 1. npm packages in the bundles
const pkgs = new Map();
for (const f of fs.readdirSync(metaDir).filter((n) => n.endsWith('.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8'));
  for (const input of Object.keys(meta.inputs)) {
    const idx = input.lastIndexOf('node_modules/');
    if (idx < 0) continue;
    const rest = input.slice(idx + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? rest[0] + '/' + rest[1] : rest[0];
    pkgs.set(input.slice(0, idx) + 'node_modules/' + name, name);
  }
}
// node_modules folders shipped as files (.vscodeignore keeps them)
for (const line of fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n')) {
  const m = /^!node_modules\/((?:@[^/]+\/)?[^/*]+)/.exec(line.trim());
  if (m) pkgs.set('node_modules/' + m[1], m[1]);
}
const npm = [];
for (const [dir, name] of [...pkgs].sort((a, b) => a[1].localeCompare(b[1]))) {
  const pj = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  const lic = typeof pj.license === 'string' ? pj.license : (pj.license && pj.license.type) || 'UNKNOWN';
  let texts = licenceTexts(path.join(root, dir));
  // packages that ship no licence file: the text from tools/licences/npm-<name>.txt (written from package.json's licence)
  const fallback = path.join(root, 'tools/licences', 'npm-' + name.replace('/', '__') + '.txt');
  if (!texts.length && fs.existsSync(fallback)) texts = [{ file: path.basename(fallback), text: fs.readFileSync(fallback, 'utf8').trim() }];
  if (!texts.length) missing.push(`npm ${name}@${pj.version} (${lic})`);
  npm.push({ name: `${name} ${pj.version}`, licence: lic, url: (pj.repository && (pj.repository.url || pj.repository)) || pj.homepage || '', texts });
}
sections.push(['npm packages bundled into dist/ (from the esbuild bundles) or shipped under node_modules/', npm]);

// 2. Rust crates in filehandler.wasm
const crates = [];
if (fs.existsSync(path.join(root, 'target/wasm32-unknown-unknown/release/filehandler.wasm'))) {
  const md = JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown', '--manifest-path', path.join(root, 'Cargo.toml')], { maxBuffer: 64 << 20 }).toString());
  const byId = new Map(md.packages.map((p) => [p.id, p]));
  const nodes = new Map(md.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set(); const stack = [md.resolve.root];
  while (stack.length) {
    const id = stack.pop(); if (seen.has(id)) continue;
    // proc-macro crates (and what only they use) run in the compiler, not in the wasm: not shipped
    if (byId.get(id).targets.some((t) => t.kind.includes('proc-macro'))) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps) {
      if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg); // normal (not dev/build) dependencies
    }
  }
  seen.delete(md.resolve.root);
  for (const id of [...seen].sort()) {
    const p = byId.get(id);
    const texts = licenceTexts(path.dirname(p.manifest_path));
    if (!texts.length && !p.license) missing.push(`crate ${p.name} ${p.version}`);
    crates.push({ name: `${p.name} ${p.version}`, licence: p.license || p.license_file || 'UNKNOWN', url: p.repository || '', texts });
  }
}
sections.push(['Rust crates compiled into target/wasm32-unknown-unknown/release/filehandler.wasm (wellen and its dependencies)', crates]);

// 3. native parts of this target: name|SPDX|licence file[;licence file]
const nat = [];
for (const spec of natives) {
  const [name, licence, files, url] = spec.split('|');
  const texts = (files || '').split(';').filter(Boolean).map((f) => ({ file: path.basename(f), text: fs.readFileSync(f, 'utf8').trim() }));
  if (!texts.length) missing.push(`native ${name}`);
  nat.push({ name, licence, url: url || '', texts });
}
if (nat.length) sections.push(['Native programs in bin/ (statically linked parts listed with the program they are in)', nat]);

if (missing.length) { console.error('gen-notices: no licence text for:\n  ' + missing.join('\n  ')); process.exit(1); }

let s = 'THIRD-PARTY NOTICES\n\nThis extension (a fork of VaporView, GPL-3.0) bundles the third-party software below. Each part is used\n' +
  'under its own licence, reproduced in full. This file is generated by tools/gen-notices.mjs from the packaged\n' +
  'bundles; see NOTICE for the project\'s own copyright and the code adapted into it.\n';
for (const [title, list] of sections) {
  s += `\n${'='.repeat(100)}\n${title} (${list.length})\n${'='.repeat(100)}\n`;
  for (const e of list) {
    s += `\n--- ${e.name} (${e.licence})${e.url ? ' ' + e.url : ''}\n`;
    for (const t of e.texts) s += `\n[${t.file}]\n${t.text}\n`;
  }
}
fs.writeFileSync(out, s);
console.log(`gen-notices: ${npm.length} npm, ${crates.length} crates, ${nat.length} native -> ${out} (${s.length} bytes)`);
