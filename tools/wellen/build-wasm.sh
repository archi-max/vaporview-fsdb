#!/bin/bash
# vscode-port: adapted from cmux (GPL-3.0) scripts/waveform-viewer-checks/wellen/build-wasm.sh @ 45a845a1ab4.
# Rebuilds target/wasm32-unknown-unknown/release/filehandler.wasm from this repository's Cargo.toml, Cargo.lock and
# src/wellen_parser as committed (HEAD; the same files as VaporView's tag 1.6.1-beta) with
# wellen 0.25.7 + tools/wellen/wellen-0.25.7-split-bit-start.patch. Paths are remapped (the work dir to
# /build, CARGO_HOME to /cargo), so the output is the same from any directory and any user.
# Usage: tools/wellen/build-wasm.sh <work dir> [--unpatched] [--install]
#   --install copies the result to target/wasm32-unknown-unknown/release/filehandler.wasm (where esbuild.js and
#   the VSIX take it from).
# Expected SHA-1 of the patched build, by build host (rustc's host triple: cargo's crate metadata, and so the mangled
# symbol hashes in the wasm, depend on it; the code is the same). tools/wellen/wasm-pin.sh reads these lines:
#   aarch64-apple-darwin 5375b64ce3ef089af7bd3a85554824343ba28467 (the build the release VSIXes ship)
#   x86_64-unknown-linux-gnu d54dc3926f45d5ec6ffdae1f7e070d74b770511e
# Needs: Rust 1.93.1 with the wasm32-unknown-unknown target; wellen 0.25.7 and the crates in Cargo.lock in
# cargo's registry (or network). Prints the wasm's path and SHA-1. Run it under nice.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VV="$ROOT"; WORK="${1:?work dir}"; MODE=""; INSTALL=""
for a in "${@:2}"; do case "$a" in --unpatched) MODE="$a" ;; --install) INSTALL=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
case "$WORK" in /*) ;; *) WORK="$PWD/$WORK" ;; esac
rm -rf "${WORK:?}/vaporview" "${WORK:?}/target"; mkdir -p "$WORK/vaporview"
WORK="$(cd "$WORK" && pwd -P)"
# The committed inputs (not the working tree), so local edits never reach the pinned build; outside a git checkout
# (a source archive), the files as they are.
if git -C "$VV" rev-parse --verify -q HEAD >/dev/null 2>&1; then
  git -C "$VV" archive HEAD Cargo.toml Cargo.lock src/wellen_parser/filehandler.wit src/wellen_parser/lib.rs src/wellen_parser/libsurfer.rs | tar -x -C "$WORK/vaporview"
else
  (cd "$VV" && tar cf - Cargo.toml Cargo.lock src/wellen_parser/filehandler.wit src/wellen_parser/lib.rs src/wellen_parser/libsurfer.rs) | tar -x -C "$WORK/vaporview"
fi
# Every crate vendored (cargo's directory source in place of crates.io), wellen patched in place there: the
# package keeps its crates.io identity, so nothing in the build depends on where the work dir is. (A path
# dependency's package id carries its absolute path into the crate hashes, and so into the code.)
(cd "$WORK/vaporview" && cargo vendor --locked --versioned-dirs vendor > /dev/null)
mkdir -p "$WORK/vaporview/.cargo"
printf '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n' > "$WORK/vaporview/.cargo/config.toml"
if [ "$MODE" != "--unpatched" ]; then
  (cd "$WORK/vaporview/vendor/wellen-0.25.7" && patch -p1 < "$HERE/wellen-0.25.7-split-bit-start.patch")
  # The patched files no longer match the vendored checksums; the package checksum (Cargo.lock's) stays.
  python3 - "$WORK/vaporview/vendor/wellen-0.25.7/.cargo-checksum.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["files"] = {}; json.dump(d, open(p, "w"))
PY
fi
export RUSTFLAGS="--remap-path-prefix=$WORK=/build --remap-path-prefix=$CARGO_HOME=/cargo"
(cd "$WORK/vaporview" && CARGO_TARGET_DIR="$WORK/target" cargo build -j 4 --locked --offline --target wasm32-unknown-unknown --release)
OUTWASM="$WORK/target/wasm32-unknown-unknown/release/filehandler.wasm"
echo "$OUTWASM"
shasum "$OUTWASM"
if [ -n "$INSTALL" ]; then
  [ "$MODE" = "--unpatched" ] && { echo "refusing to install an unpatched build" >&2; exit 1; }
  mkdir -p "$ROOT/target/wasm32-unknown-unknown/release"
  cp "$OUTWASM" "$ROOT/target/wasm32-unknown-unknown/release/filehandler.wasm"
  echo "installed into target/wasm32-unknown-unknown/release/filehandler.wasm"
fi
