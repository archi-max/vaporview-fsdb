#!/bin/bash
# vscode-port: builds wisp-helper (wisp-helper/ in this repository, MIT) PREBUILT for macOS, with Apple clang and the SDK's zlib (system /usr/lib/libz), deployment target
# $WISP_MACOS_MIN (default 13.3: Apple libc++ has floating-point std::to_chars from macOS 13.3). arm64 natively, x64 with -arch x86_64. The linker ad-hoc signs the binary.
# Usage: tools/build-wisp-helper-darwin.sh <arm64|x64> <out dir>      -> <out>/wisp-helper + wisp-helper.buildinfo
# Env: WISP_SRC (default wisp-helper/ of this repository), WISP_MACOS_MIN.
set -euo pipefail
ARCH=${1:?arm64|x64}; OUT=${2:?out dir}
HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(uname -s)" = Darwin ] || { echo "run on macOS"; exit 2; }
case "$ARCH" in arm64) CA=arm64 ;; x64) CA=x86_64 ;; *) echo "bad arch $ARCH"; exit 2 ;; esac
WISP_SRC=${WISP_SRC:-$HERE/wisp-helper}
[ -f "$WISP_SRC/helper/build.sh" ] || { echo "no wisp-helper source at $WISP_SRC"; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/wisp-helper-darwin.XXXXXX"); trap 'rm -rf "${WORK:?}"' EXIT
mkdir -p "$WORK/src"
( cd "$WISP_SRC" && COPYFILE_DISABLE=1 tar cf - --exclude build helper include convert LICENSE NOTICE ) | ( cd "$WORK/src" && tar xf - )
TREE=$( (cd "$WORK/src" && find . -type f | LC_ALL=C sort | xargs cat) | shasum -a 256 | cut -c1-16)
export MACOSX_DEPLOYMENT_TARGET=${WISP_MACOS_MIN:-13.3}
CXX="clang++ -arch $CA" CC="clang -arch $CA" nice -n 15 sh "$WORK/src/helper/build.sh" "$WORK/out" > "$WORK/build.log" 2>&1 \
  || { tail -40 "$WORK/build.log"; exit 5; }
strip -x "$WORK/out/wisp-helper" 2>/dev/null || true
codesign -s - -f "$WORK/out/wisp-helper" >/dev/null 2>&1   # re-sign after strip (arm64 needs a valid signature)
lipo -archs "$WORK/out/wisp-helper" | grep -qx "$CA" || { echo "wrong arch"; exit 6; }
install -m 0755 "$WORK/out/wisp-helper" "$OUT/wisp-helper"
mkdir -p "$OUT/licences"; for f in LICENSE NOTICE helper/NOTICE helper/lib/third_party/zstd/LICENSE; do
  cp "$WORK/src/$f" "$OUT/licences/$(echo "$f" | tr / _)"; done
BID=$(sed -n 's/^build id //p' "$WORK/build.log")
cat > "$OUT/wisp-helper.buildinfo" <<EOF
source: wisp-helper/ (files sha256 $TREE)
build-id: $BID
target: macOS $CA, minimum macOS $MACOSX_DEPLOYMENT_TARGET ($(otool -l "$OUT/wisp-helper" | awk '/minos/{print "minos " $2; exit}')), system libc++ and libz
toolchain: $(clang++ --version | head -1)
EOF
cat "$OUT/wisp-helper.buildinfo"
