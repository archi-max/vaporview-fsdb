#!/bin/bash
# vscode-port: builds the release VSIXes of whatever is on this checkout, repeatably.
#   tools/package.sh [--targets "linux-x64 universal"] [--no-sv-model] [--out dir]
#
# Per run:
#   1. production bundles (check-types + esbuild --production), with esbuild metafiles for the notices;
#   2. wisp-helper (MIT) from wisp-helper/ in this repository: linux-x64 with tools/build-wisp-helper-release.sh (zig,
#      glibc floor 2.17, static libc++/zlib), macOS arm64 + x64 with tools/build-wisp-helper-darwin.sh (on a Mac);
#   3. the sv-model sidecar prebuilt for linux-x64 (tools/build-sv-model-release.sh, run on $SVM_HOST over ssh when this
#      host is not Linux x86_64; SVM_HOST is an ssh alias you set); other targets build it on first use;
#   4. THIRD-PARTY-NOTICES.txt per target (tools/gen-notices.mjs), from the bundles + that target's native parts;
#   5. vsce package (pinned @vscode/vsce 4.1.0, installed in the cache) per target -> <out>/<name>-<version>-<target>.vsix;
#   6. tools/check-vsix.sh on every VSIX (the run fails if any check fails).
# Native builds are cached in $VV_PACKAGE_CACHE (default ~/.cache/vaporview-wisp-package) by a key of their inputs, so a
# rerun after a merge rebuilds only what changed. "universal" = no --target: macOS / Windows (macOS helpers; on Windows FSDB/WCZ need a
# Linux host, locally or through Remote-SSH) and the fallback for any platform without its own VSIX.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
TARGETS="linux-x64 universal"
SVM=1; OUT="$HERE/dist-vsix"
while [ $# -gt 0 ]; do
  case "$1" in
    --targets) TARGETS="$2"; shift 2 ;;
    --no-sv-model) SVM=0; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
CACHE=${VV_PACKAGE_CACHE:-$HOME/.cache/vaporview-wisp-package}
SVM_HOST=${SVM_HOST:-}
VSCE_VERSION=4.1.0
sha() { (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16; }
say() { printf '\n== %s\n' "$*"; }
mkdir -p "$CACHE" "$OUT"

say "preflight"
for f in target/wasm32-unknown-unknown/release/filehandler.wasm src/wellen_parser/filehandler.ts node_modules/.package-lock.json LICENSE NOTICE README.md CHANGELOG.md; do
  [ -e "$f" ] || { echo "missing $f (run npm ci, then npm run compile-wasm)"; exit 2; }
done
# the wellen wasm must be the reproducible build (tools/wellen/build-wasm.sh remaps paths; another build carries the
# builder's home paths), pinned per build host (tools/wellen/wasm-pin.sh; the release VSIXes are built on
# aarch64-apple-darwin); any other wasm is rebuilt (needs Rust + the wasm target).
WASM=target/wasm32-unknown-unknown/release/filehandler.wasm
WASM_SHA1=$(bash tools/wellen/wasm-pin.sh); WASM_HOST=$(bash tools/wellen/wasm-pin.sh --host)
[ -n "$WASM_SHA1" ] || { echo "no pinned wellen wasm SHA-1 for build host $WASM_HOST (pinned hosts: $(sed -n 's/^#   \([a-z0-9_-]*\) [0-9a-f]\{40\}.*/\1/p' tools/wellen/build-wasm.sh | tr '\n' ' '); see tools/wellen/build-wasm.sh)"; exit 2; }
if [ "$(shasum "$WASM" | cut -d' ' -f1)" != "$WASM_SHA1" ]; then
  say "filehandler.wasm is not the reproducible build for $WASM_HOST ($WASM_SHA1): rebuilding"
  nice -n 10 tools/wellen/build-wasm.sh "$CACHE/wasm-build" --install | tail -2
  G=$(shasum "$WASM" | cut -d' ' -f1)
  [ "$G" = "$WASM_SHA1" ] || { echo "wasm rebuild gave SHA-1 $G, not the pinned $WASM_SHA1 for $WASM_HOST"; exit 2; }
fi
NAME=$(node -p "require('./package.json').name"); VERSION=$(node -p "require('./package.json').version")
# every VSIX traces to a commit: BUILD-INFO.txt (in the VSIX) names this checkout's commit and whether the tree had
# uncommitted changes
HEAD_SHA=$(git rev-parse HEAD)
DIRTY=$( (git status --porcelain --untracked-files=no | grep -v -E ' (dist-vsix|bin)/' || true) | wc -l | tr -d ' ')
echo "$NAME $VERSION"
echo "built from commit $HEAD_SHA ($(git rev-parse --abbrev-ref HEAD)); uncommitted changes: $DIRTY files; targets: $TARGETS"

say "bundles"
META="$CACHE/meta"; rm -rf "${META:?}"; mkdir -p "$META"
npm run -s check-types
VV_METAFILE_DIR="$META" node esbuild.js --production 2>&1 | grep -E 'error|Error|finished' || true
[ -s dist/extension.js ] && [ -s dist/webview.js ] || { echo "bundles missing"; exit 3; }

if [ ! -x "$CACHE/vsce/node_modules/.bin/vsce" ] || [ "$("$CACHE/vsce/node_modules/.bin/vsce" --version)" != "$VSCE_VERSION" ]; then
  say "vsce $VSCE_VERSION"
  mkdir -p "$CACHE/vsce" && (cd "$CACHE/vsce" && npm install --no-audit --no-fund --ignore-scripts "@vscode/vsce@$VSCE_VERSION" >/dev/null)
fi
VSCE="$CACHE/vsce/node_modules/.bin/vsce"

# wisp-helper for one platform (linux-x64, darwin-arm64, darwin-x64), cached by its sources + build script
helper_dir() {
  local p=$1 script key d
  case "$p" in linux-*) script=tools/build-wisp-helper-release.sh ;; darwin-*) script=tools/build-wisp-helper-darwin.sh ;; esac
  key=$( { (cd wisp-helper && find helper include convert LICENSE NOTICE -type f | LC_ALL=C sort | xargs cat); echo "$p"; cat "$script"; } | sha)
  d="$CACHE/wisp-helper/$p-$key"
  if [ ! -x "$d/wisp-helper" ]; then
    say "wisp-helper $p (build, key $key)" >&2
    rm -rf "${d:?}"; "$script" "${p#*-}" "$d" >&2 || return 1
  fi
  echo "$d"
}
# sv-model prebuilt (linux-x64), cached by its sources + build script
svmodel_x64() {
  local key d
  key=$(cat media/cmux/sv-model/{CMakeLists.txt,build.sh,sv-model.sh,sv_model.cpp} tools/build-sv-model-release.sh | sha)
  d="$CACHE/sv-model/x64-$key"
  if [ ! -d "$d" ] || [ -z "$(ls "$d" 2>/dev/null)" ]; then
    say "sv-model linux-x64 (build, key $key)" >&2
    rm -rf "${d:?}"; mkdir -p "$d"
    if [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ]; then
      tools/build-sv-model-release.sh "$d" >&2
    else
      [ -n "$SVM_HOST" ] || { echo "not on Linux x86_64: set SVM_HOST (ssh alias of a Linux x86_64 host) to build the sv-model" >&2; return 1; }
      local R="vaporview-build/svm-release"
      ssh -o BatchMode=yes "$SVM_HOST" "mkdir -p $R/media/cmux $R/tools && rm -rf $R/out" >&2
      COPYFILE_DISABLE=1 rsync -a --delete media/cmux/sv-model "$SVM_HOST:$R/media/cmux/" >&2
      rsync -a tools/build-sv-model-release.sh "$SVM_HOST:$R/tools/" >&2
      ssh -o BatchMode=yes "$SVM_HOST" "mkdir -p $R/tools/licences" >&2; rsync -a tools/licences/ "$SVM_HOST:$R/tools/licences/" >&2
      ssh -o BatchMode=yes "$SVM_HOST" "cd $R && ulimit -v 16000000 && ZIG=\${ZIG:-zig} timeout -k 10 2400 tools/build-sv-model-release.sh \$PWD/out" >&2
      rsync -a "$SVM_HOST:$R/out/" "$d/" >&2
      ls "$d"/*/licences/regex-* >/dev/null 2>&1 || { rm -rf "${d:?}"; echo "sv-model release build incomplete" >&2; return 1; }
    fi
  fi
  echo "$d"
}

# sv-model prebuilt for macOS (arm64 native, x64 cross), for the universal VSIX; needs a Mac host. Cached like the others.
svmodel_darwin() {  # svmodel_darwin arm64|x64
  local key d
  key=$(cat media/cmux/sv-model/{CMakeLists.txt,build.sh,sv-model.sh,sv_model.cpp} tools/build-sv-model-darwin.sh | sha)
  d="$CACHE/sv-model/darwin-$1-$key"
  if [ ! -d "$d" ] || ! ls "$d"/*/licences/regex-* >/dev/null 2>&1; then
    say "sv-model darwin-$1 (build, key $key)" >&2
    rm -rf "${d:?}"; tools/build-sv-model-darwin.sh "$1" "$d" >&2 || return 1
  fi
  echo "$d"
}
svmodel_notices() {  # svmodel_notices <licences dir> <where>
  NATIVE+=(--native "slang 12.1 (in cmux-sv-model, $2)|MIT|$(ls "$1"/slang-*)|https://github.com/MikePopoloski/slang")
  NATIVE+=(--native "fmt 12.2.0 (in cmux-sv-model, $2)|MIT|$(ls "$1"/fmt-*)|https://github.com/fmtlib/fmt")
  NATIVE+=(--native "Boost.Regex 1.91.0 (in cmux-sv-model, $2)|BSL-1.0|$(ls "$1"/regex-*)|https://github.com/MikePopoloski/regex")
  NATIVE+=(--native "toml++ 3.4.0 (in cmux-sv-model, $2)|MIT|$(ls "$1"/toml-*)|https://github.com/marzer/tomlplusplus")
}
LINUX_NATIVE=""
VSIXES=()
for T in $TARGETS; do
  say "target $T"
  rm -rf "${HERE:?}/bin"
  NATIVE=()
  case "$T" in
    linux-x64|linux-arm64)
      A=${T#linux-}
      H=$(helper_dir "$T") || exit 5
      mkdir -p "bin/$T"
      install -m 0755 "$H/wisp-helper" "bin/$T/wisp-helper"
      cp "$H/wisp-helper.buildinfo" "bin/$T/"
      NATIVE+=(--native "wisp-helper (wisp-helper/ in the source repository, $(sed -n 's/^build-id: /build-id /p' "$H/wisp-helper.buildinfo"))|MIT|$H/licences/LICENSE;$H/licences/NOTICE;$H/licences/helper_NOTICE")
      NATIVE+=(--native "zstd decompressor 1.5.7 (in wisp-helper)|BSD-3-Clause|$H/licences/helper_lib_third_party_zstd_LICENSE")
      ZLIB_LIC="$CACHE/zlib-LICENSE"
      [ -s "$ZLIB_LIC" ] || curl -fsSL -o "$ZLIB_LIC" https://raw.githubusercontent.com/madler/zlib/v1.3.1/LICENSE
      NATIVE+=(--native "zlib 1.3.1 (static, in wisp-helper)|Zlib|$ZLIB_LIC|https://zlib.net")
      ZIGLIB="$(dirname "$(readlink -f "$(command -v zig || echo "$HOME/.local/bin/zig")")")/lib"
      NATIVE+=(--native "LLVM libc++, libc++abi, libunwind (static, in the native programs; zig $(zig version 2>/dev/null || echo 0.16.0))|Apache-2.0 WITH LLVM-exception|$ZIGLIB/libcxx/LICENSE.TXT|https://llvm.org")
      if [ $SVM = 1 ] && [ "$T" = linux-x64 ]; then
        S=$(svmodel_x64) || exit 5
        mkdir -p "bin/$T/sv-model"; cp -R "$S"/. "bin/$T/sv-model/"
        chmod 0755 bin/$T/sv-model/*/cmux-sv-model bin/$T/sv-model/*/sv-model.sh
        svmodel_notices "$(ls -d "$S"/*/licences)" "linux-x64"
      fi
      TFLAG=(--target "$T") ;;
    universal)
      TFLAG=()
      # macOS prebuilt sv-model (no first-use build on a Mac); Windows has none (driver tracing says it is not supported yet)
      if [ $SVM = 1 ] && [ "$(uname -s)" = Darwin ]; then
        for A in arm64 x64; do
          S=$(svmodel_darwin $A) || exit 5
          mkdir -p "bin/darwin-$A/sv-model"; cp -R "$S"/. "bin/darwin-$A/sv-model/"
          chmod 0755 bin/darwin-$A/sv-model/*/cmux-sv-model bin/darwin-$A/sv-model/*/sv-model.sh
        done
        svmodel_notices "$(ls -d "$S"/*/licences)" "macOS"
        if [ "${MAC_HELPER:-1}" = 1 ]; then
          for A in arm64 x64; do
            H=$(helper_dir "darwin-$A") || exit 5
            install -m 0755 "$H/wisp-helper" "bin/darwin-$A/wisp-helper"; cp "$H/wisp-helper.buildinfo" "bin/darwin-$A/"
          done
          NATIVE+=(--native "wisp-helper for macOS (wisp-helper/ in the source repository, $(sed -n 's/^build-id: /build-id /p' "$H/wisp-helper.buildinfo"))|MIT|$H/licences/LICENSE;$H/licences/NOTICE;$H/licences/helper_NOTICE")
          NATIVE+=(--native "zstd decompressor 1.5.7 (in wisp-helper for macOS)|BSD-3-Clause|$H/licences/helper_lib_third_party_zstd_LICENSE")
        fi
      elif [ $SVM = 1 ]; then echo "NOTE: not on a Mac: the universal VSIX has no macOS sv-model (first-use build there)"; fi ;;
    *) TFLAG=(--target "$T") ;;
  esac
  { echo "$NAME $VERSION ($T)"; echo "commit: $HEAD_SHA"; echo "uncommitted changes: $DIRTY files";
    echo "wellen wasm SHA-1: $(shasum "$WASM" | cut -d' ' -f1)"
    for b in bin/*/wisp-helper.buildinfo; do [ -f "$b" ] && sed "s#^#wisp-helper $(basename "$(dirname "$b")") #" "$b"; done
    for b in bin/*/sv-model/*/buildinfo; do [ -f "$b" ] && sed "s#^#sv-model $(basename "$(dirname "$(dirname "$(dirname "$b")")")") #" "$b"; done
    echo "packaged: $(date -u +%Y-%m-%dT%H:%MZ) with @vscode/vsce $VSCE_VERSION"
    [ -z "${BUILD_LABEL:-}" ] || echo "label: $BUILD_LABEL"; } > BUILD-INFO.txt
  node tools/gen-notices.mjs --meta "$META" --out THIRD-PARTY-NOTICES.txt ${NATIVE[@]+"${NATIVE[@]}"}
  F="$OUT/$NAME-$VERSION-$T.vsix"
  rm -f "$F"
  # vscode-port: README images stay relative, so the details page loads them from the installed
  # extension (the repository is private; rewritten github.com/raw links would not load)
  VV_PREBUILT=1 "$VSCE" package ${TFLAG[@]+"${TFLAG[@]}"} --no-dependencies --pre-release --no-rewrite-relative-links -o "$F" 2>&1 | grep -vE '^\s*$' | tail -4
  VSIXES+=("$F")
done
rm -rf "${HERE:?}/bin" BUILD-INFO.txt

say "check-vsix"
tools/check-vsix.sh "${VSIXES[@]}" > "$OUT/check-vsix.log" 2>&1 && RC=0 || RC=$?
grep -E '^(PASS|FAIL|native|wasm|---)' "$OUT/check-vsix.log"
echo "(full file lists: $OUT/check-vsix.log)"
( cd "$OUT" && for f in "${VSIXES[@]}"; do b=$(basename "$f"); (sha256sum "$b" 2>/dev/null || shasum -a 256 "$b"); done ) > "$OUT/SHA256SUMS.txt"
for f in "${VSIXES[@]}"; do printf '%10s bytes  %s\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done
echo "built from commit $HEAD_SHA, uncommitted changes: $DIRTY files" | tee "$OUT/BUILT-FROM.txt"
exit $RC
