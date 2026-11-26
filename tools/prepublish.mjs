#!/usr/bin/env node
// vscode-port: `vscode:prepublish` (vsce runs it before every package). Builds the production bundles.
// The wasm (wellen) is built with cargo only when it is missing: it needs the Rust wasm toolchain, and
// tools/package.sh packages one build of it for every target. VV_PREBUILT=1 (set by tools/package.sh after its own
// build) skips the rebuild so each target packages the same bytes.
import { execSync } from 'node:child_process';
const run = (c) => execSync(c, { stdio: 'inherit' });
if (process.env.VV_PREBUILT === '1') { console.log('prepublish: using the build from tools/package.sh'); process.exit(0); }
// the reproducible wellen build only (tools/wellen/ensure-wasm.sh: no-op when the SHA-1 is right, else rebuild + install)
run('bash tools/wellen/ensure-wasm.sh');
run('npm run check-types');
run('node esbuild.js --production');
