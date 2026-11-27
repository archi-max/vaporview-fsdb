#!/bin/bash
# tools/wellen/wasm-pin.sh [--host | --all]: the pinned SHA-1 of the reproducible wellen wasm for this build host (the
# "Expected SHA-1 ... by build host" lines of build-wasm.sh). Prints nothing when the host has no pin. With --host,
# prints the host triple instead; with --all, every pin as "<triple> <sha1>" lines. The host is rustc's (cargo's crate metadata, and so the mangled symbol hashes in
# the wasm, depend on it); without rustc, the triple of this machine.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = --all ]; then sed -n 's/^#   \([a-z0-9_]*-[a-z0-9_-]*\) \([0-9a-f]\{40\}\).*/\1 \2/p' "$HERE/build-wasm.sh"; exit 0; fi
H=$(rustc -vV 2>/dev/null | sed -n 's/^host: //p' || true)
if [ -z "$H" ]; then case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) H=aarch64-apple-darwin ;; Darwin-x86_64) H=x86_64-apple-darwin ;;
  Linux-x86_64) H=x86_64-unknown-linux-gnu ;; Linux-aarch64) H=aarch64-unknown-linux-gnu ;; *) H=unknown ;; esac; fi
if [ "${1:-}" = --host ]; then echo "$H"; exit 0; fi
sed -n "s/^#   $H \([0-9a-f]\{40\}\).*/\1/p" "$HERE/build-wasm.sh" | head -1
