#!/bin/bash
# vscode-port: make sure target/wasm32-unknown-unknown/release/filehandler.wasm is the reproducible patched
# wellen build. Used by `npm run compile-wasm` instead of a plain `cargo build`, whose output depends on the builder
# (it embeds home-directory paths).
# Skips the build when the installed file already has this build host's pinned SHA-1 (tools/wellen/wasm-pin.sh).
# Otherwise runs build-wasm.sh in a cache dir (WELLEN_BUILD_DIR, default ~/.cache/vaporview-wellen-build) and
# installs the result. A SHA-1 other than the pin is a warning, not a failure: the wasm works the same (only symbol
# hashes differ between build hosts); tools/package.sh is the one that requires the pin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WANT=$(bash "$ROOT/tools/wellen/wasm-pin.sh"); HOSTT=$(bash "$ROOT/tools/wellen/wasm-pin.sh" --host)
WASM="$ROOT/target/wasm32-unknown-unknown/release/filehandler.wasm"
got() { shasum "$WASM" 2>/dev/null | cut -d' ' -f1; }
if [ -n "$WANT" ] && [ "$(got)" = "$WANT" ]; then
  echo "wellen wasm OK ($WANT)"
  exit 0
fi
mkdir -p "$(dirname "$WASM")"
WORK="${WELLEN_BUILD_DIR:-$HOME/.cache/vaporview-wellen-build}"
mkdir -p "$WORK"
nice -n 10 bash "$ROOT/tools/wellen/build-wasm.sh" "$WORK" --install
if [ -z "$WANT" ]; then
  echo "WARNING: wellen wasm installed, SHA-1 $(got); build host $HOSTT has no pinned SHA-1 (see tools/wellen/build-wasm.sh)." >&2
  echo "         The build is usable for development; release packaging needs a pinned host." >&2
elif [ "$(got)" != "$WANT" ]; then
  echo "WARNING: wellen wasm SHA-1 is $(got), not the pinned $WANT for $HOSTT." >&2
  echo "         The build is still usable (the code is the same); tools/package.sh requires the pinned SHA-1." >&2
else
  echo "wellen wasm installed ($WANT, $HOSTT)"
fi
