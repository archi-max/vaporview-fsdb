#!/bin/bash
# vscode-port: make sure target/wasm32-unknown-unknown/release/filehandler.wasm is the reproducible patched
# wellen build (SHA-1 below). Used by `npm run compile-wasm` instead of a plain `cargo build`, whose output
# depends on the builder (it embeds home-directory paths) and is not what ships.
# Skips the build when the installed file already has the right SHA-1. Otherwise runs build-wasm.sh in a cache dir
# (WELLEN_BUILD_DIR, default ~/.cache/vaporview-wellen-build) and installs the result.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WANT=5375b64ce3ef089af7bd3a85554824343ba28467
WASM="$ROOT/target/wasm32-unknown-unknown/release/filehandler.wasm"
got() { shasum "$WASM" 2>/dev/null | cut -d' ' -f1; }
if [ "$(got)" = "$WANT" ]; then
  echo "wellen wasm OK ($WANT)"
  exit 0
fi
mkdir -p "$(dirname "$WASM")"
WORK="${WELLEN_BUILD_DIR:-$HOME/.cache/vaporview-wellen-build}"
mkdir -p "$WORK"
nice -n 10 bash "$ROOT/tools/wellen/build-wasm.sh" "$WORK" --install
if [ "$(got)" != "$WANT" ]; then
  echo "wellen wasm SHA-1 is $(got), expected $WANT" >&2
  exit 1
fi
echo "wellen wasm installed ($WANT)"
