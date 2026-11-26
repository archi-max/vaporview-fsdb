#!/bin/bash
# vscode-port: builds the cmux-sv-model sidecar (driver tracing's design model, on slang, MIT) for a Linux
# VSIX with a pinned glibc floor and no C++ runtime dependency, by running the shipped media/cmux/sv-model/build.sh
# (same sources, same pinned slang 12.1 tarballs and checksums) with `zig c++` as the compiler:
#   - glibc floor $SV_GLIBC (default 2.17) through zig's target triple; LLVM libc++ linked statically by zig.
# Runs ON a Linux x86_64 host (build.sh runs the built program as its last check), under nice with 4 jobs.
# Usage: tools/build-sv-model-release.sh <out dir>        (writes <out>/<sources hash>-x86_64/{cmux-sv-model,sv-model.sh,...})
# Env: ZIG (zig 0.16), SV_GLIBC, CMUX_SV_MODEL_TARBALLS (offline tarballs, as build.sh).
set -euo pipefail
OUT=${1:?out dir}
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/media/cmux/sv-model"
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || { echo "run on a Linux x86_64 host"; exit 2; }
ZIG=${ZIG:-$(command -v zig || true)}
[ -x "$ZIG" ] || { echo "zig not found (set ZIG)"; exit 2; }
SV_GLIBC=${SV_GLIBC:-2.17}
ZT=x86_64-linux-gnu.$SV_GLIBC
# the install folder name the extension looks for: sha256 of the sources, as src/cmux/trace/sidecar.ts installDir()
HASH=$(cat "$SRC/CMakeLists.txt" "$SRC/build.sh" "$SRC/sv-model.sh" "$SRC/sv_model.cpp" | sha256sum | cut -c1-16)
DEST="$OUT/$HASH-x86_64"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sv-model-release.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT
cat > "$WORK/c++" <<EOF
#!/bin/sh
S=-s; for a in "\$@"; do [ "\$a" = -c ] && S=; done
exec "$ZIG" c++ -target $ZT -g0 \$S "\$@"
EOF
cat > "$WORK/cc" <<EOF
#!/bin/sh
exec "$ZIG" cc -target $ZT -g0 "\$@"
EOF
chmod +x "$WORK/c++" "$WORK/cc"
mkdir -p "$OUT"
rm -rf "${DEST:?}"
# the four pinned tarballs (URLs and checksums from build.sh, which checks them again), kept for their licence files
TB=${CMUX_SV_MODEL_TARBALLS:-$WORK/tarballs}; mkdir -p "$TB"
for n in SLANG:slang FMT:fmt REGEX:regex TOML:toml; do
  v=${n%%:*}; f=${n#*:}
  url=$(sed -n "s/^${v}_URL=//p" "$SRC/build.sh"); sha=$(sed -n "s/^${v}_SHA=//p" "$SRC/build.sh")
  [ -f "$TB/$f.tar.gz" ] || curl -fsSL --retry 2 -o "$TB/$f.tar.gz" "$url"
  echo "$sha  $TB/$f.tar.gz" | sha256sum -c --quiet || { echo "checksum mismatch: $f"; exit 4; }
done
export CMUX_SV_MODEL_TARBALLS="$TB"
S=$(date +%s)
CXX="$WORK/c++" CC="$WORK/cc" CMUX_SV_MODEL_JOBS=${CMUX_SV_MODEL_JOBS:-4} nice -n 19 sh "$SRC/build.sh" "$SRC" "$DEST" 2> "$WORK/build.err" \
  || { grep -v 'progress' "$WORK/build.err" | tail -30; exit 5; }
# licence files of what is compiled in (slang, fmt, Boost.Regex, toml++), for THIRD-PARTY-NOTICES
mkdir -p "$DEST/licences"
for f in slang fmt regex toml; do
  mkdir -p "$WORK/lic-$f" && tar xzf "$TB/$f.tar.gz" -C "$WORK/lic-$f" --strip-components=1 --wildcards '*/LICENSE*' '*/LICENCE*' '*/COPYING*' 2>/dev/null || true
  l=$(cd "$WORK/lic-$f" && find . -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' \) | sed 's#^\./##' | sort | head -1)
  if [ -z "$l" ] && [ $f = regex ]; then cp "$HERE/tools/licences/BSL-1.0.txt" "$DEST/licences/regex-BSL-1.0.txt"; continue; fi
  [ -n "$l" ] || { echo "no licence file in $f tarball"; exit 6; }
  cp "$WORK/lic-$f/$l" "$DEST/licences/$f-$l"
done
cat > "$DEST/buildinfo" <<EOF
sources: media/cmux/sv-model sha256 prefix $HASH
slang: $(sed -n 's/^slang=//p' "$DEST/installed")
target: $ZT (glibc floor $SV_GLIBC), libc++ static
toolchain: zig $("$ZIG" version)
build wall: $(( $(date +%s) - S )) s
EOF
cat "$DEST/buildinfo"
