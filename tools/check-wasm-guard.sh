#!/bin/bash
# vscode-port: red/green check that the build entry points never leave a non-reproducible wellen wasm:
#   1. `node tools/prepublish.mjs` (what vsce runs) and `npm run package` keep the reproducible wasm byte-identical;
#   2. with a different wasm planted (a copy with bytes appended), prepublish replaces it with the reproducible build.
# The original file is restored on exit. Needs Rust + the wasm target only if step 2 has to rebuild (cached build dir).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; cd "$HERE"
WASM=target/wasm32-unknown-unknown/release/filehandler.wasm
WANT=$(bash tools/wellen/wasm-pin.sh)   # this build host's pin
[ -n "$WANT" ] || { echo "FAIL no pinned wasm SHA-1 for build host $(bash tools/wellen/wasm-pin.sh --host)"; exit 1; }
BAK=$(mktemp "${TMPDIR:-/tmp}/wasm-guard.XXXXXX"); cp "$WASM" "$BAK"
trap 'cp "$BAK" "$WASM"; rm -f "$BAK"' EXIT
sha() { shasum "$WASM" | cut -d' ' -f1; }
[ "$(sha)" = "$WANT" ] || { echo "FAIL start: wasm is $(sha), not $WANT (run tools/wellen/ensure-wasm.sh)"; exit 1; }
node tools/prepublish.mjs > /dev/null
[ "$(sha)" = "$WANT" ] || { echo "FAIL prepublish changed the wasm to $(sha)"; exit 1; }
echo "PASS prepublish keeps the reproducible wasm ($WANT)"
npm run -s package > /dev/null
[ "$(sha)" = "$WANT" ] || { echo "FAIL npm run package changed the wasm to $(sha)"; exit 1; }
echo "PASS npm run package keeps the reproducible wasm"
printf 'planted' >> "$WASM"
[ "$(sha)" != "$WANT" ] || { echo "FAIL could not plant a different wasm"; exit 1; }
node tools/prepublish.mjs > /dev/null 2>&1
[ "$(sha)" = "$WANT" ] || { echo "FAIL prepublish left a planted wasm ($(sha))"; exit 1; }
echo "PASS prepublish replaces a planted wasm with the reproducible build"
