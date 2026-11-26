#!/bin/bash
# vscode-port: builds the cmux-sv-model sidecar (driver tracing's design model, on slang, MIT) prebuilt
# for macOS, with the shipped media/cmux/sv-model/build.sh (same sources, same pinned slang 12.1 tarballs + checksums),
# Apple clang, deployment target $SV_MACOS_MIN (default 11.0). Runs on a Mac; arm64 natively, x64 as a cross build
# (CMAKE_OSX_ARCHITECTURES=x86_64; build.sh's final run check goes through Rosetta 2).
# Links only the system libc++ / libSystem. The linker ad-hoc signs the binary (arm64 needs a signature to run).
# Usage: tools/build-sv-model-darwin.sh <arm64|x64> <out dir>   -> <out>/<sources hash>-<arm64|x86_64>/...
set -euo pipefail
ARCH=${1:?arm64|x64}; OUT=${2:?out dir}
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/media/cmux/sv-model"
[ "$(uname -s)" = Darwin ] || { echo "run on macOS"; exit 2; }
case "$ARCH" in arm64) CA=arm64; DA=arm64 ;; x64) CA=x86_64; DA=x86_64 ;; *) echo "bad arch $ARCH"; exit 2 ;; esac
[ $CA = x86_64 ] && { arch -x86_64 /usr/bin/true 2>/dev/null || { echo "x64 build needs Rosetta 2 for build.sh's run check"; exit 2; }; }
HASH=$(cat "$SRC/CMakeLists.txt" "$SRC/build.sh" "$SRC/sv-model.sh" "$SRC/sv_model.cpp" | shasum -a 256 | cut -c1-16)
DEST="$OUT/$HASH-$DA"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sv-model-darwin.XXXXXX"); trap 'rm -rf "${WORK:?}"' EXIT
mkdir -p "$OUT"; rm -rf "${DEST:?}"
TB=${CMUX_SV_MODEL_TARBALLS:-$WORK/tarballs}; mkdir -p "$TB"
for n in SLANG:slang FMT:fmt REGEX:regex TOML:toml; do
  v=${n%%:*}; f=${n#*:}
  url=$(sed -n "s/^${v}_URL=//p" "$SRC/build.sh"); sha=$(sed -n "s/^${v}_SHA=//p" "$SRC/build.sh")
  [ -f "$TB/$f.tar.gz" ] || curl -fsSL --retry 2 -o "$TB/$f.tar.gz" "$url"
  [ "$(shasum -a 256 "$TB/$f.tar.gz" | cut -d' ' -f1)" = "$sha" ] || { echo "checksum mismatch: $f"; exit 4; }
done
S=$(date +%s)
CMUX_SV_MODEL_TARBALLS="$TB" CMAKE_OSX_ARCHITECTURES=$CA MACOSX_DEPLOYMENT_TARGET=${SV_MACOS_MIN:-11.0} CXX=${CXX:-clang++} \
  CMUX_SV_MODEL_JOBS=${CMUX_SV_MODEL_JOBS:-4} nice -n 15 sh "$SRC/build.sh" "$SRC" "$DEST" 2> "$WORK/build.err" \
  || { grep -v progress "$WORK/build.err" | tail -30; exit 5; }
lipo -archs "$DEST/cmux-sv-model" | grep -qx "$CA" || { echo "wrong architecture: $(lipo -archs "$DEST/cmux-sv-model")"; exit 6; }
codesign -v "$DEST/cmux-sv-model" 2>/dev/null || codesign -s - -f "$DEST/cmux-sv-model"
mkdir -p "$DEST/licences"
for f in slang fmt regex toml; do
  mkdir -p "$WORK/lic-$f"; tar xzf "$TB/$f.tar.gz" -C "$WORK/lic-$f" --strip-components=1 '*/LICENSE*' 2>/dev/null || true
  l=$(cd "$WORK/lic-$f" && find . -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' \) | sed 's#^\./##' | sort | head -1)
  if [ -z "$l" ] && [ $f = regex ]; then cp "$HERE/tools/licences/BSL-1.0.txt" "$DEST/licences/regex-BSL-1.0.txt"; continue; fi
  [ -n "$l" ] || { echo "no licence file in $f tarball"; exit 6; }
  cp "$WORK/lic-$f/$l" "$DEST/licences/$f-$l"
done
cat > "$DEST/buildinfo" <<EOF
sources: media/cmux/sv-model sha256 prefix $HASH
slang: $(sed -n 's/^slang=//p' "$DEST/installed")
target: macOS $CA, minimum macOS ${SV_MACOS_MIN:-11.0} ($(otool -l "$DEST/cmux-sv-model" | awk '/minos/{print "minos " $2; exit}')), system libc++
toolchain: $(${CXX:-clang++} --version | head -1)
build wall: $(( $(date +%s) - S )) s
EOF
cat "$DEST/buildinfo"
