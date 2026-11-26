#!/bin/bash
# vscode-port: builds wisp-helper (wisp-helper/ in this repository, MIT) for a Linux VSIX target with a pinned
# glibc floor, from any host (macOS or Linux), using `zig c++` as the cross toolchain:
#   - glibc floor = $WISP_GLIBC (default 2.17), set through zig's target triple (x86_64-linux-gnu.2.17);
#   - the C++ runtime (LLVM libc++/libc++abi/libunwind) is linked statically by zig;
#   - zlib $ZLIB_VERSION is built from its release tarball (sha-pinned) and linked statically.
# So the binary needs only libc.so.6 (+ libm, libpthread/libdl on old glibc) at run time.
#
# Usage: tools/build-wisp-helper-release.sh <arch: x64|arm64> <out dir>
# Env: WISP_SRC (default wisp-helper/ of this repository), WISP_GLIBC, ZIG, ZLIB_TARBALL (offline copy).
# Output: <out>/wisp-helper, <out>/licences/ and <out>/wisp-helper.buildinfo (source tree hash, glibc floor, toolchain).
set -euo pipefail
ARCH=${1:?arch x64|arm64}
OUT=${2:?out dir}
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WISP_SRC=${WISP_SRC:-$HERE/wisp-helper}
[ -f "$WISP_SRC/helper/build.sh" ] || { echo "no wisp-helper source with helper/build.sh at $WISP_SRC (set WISP_SRC)"; exit 2; }
WISP_GLIBC=${WISP_GLIBC:-2.17}
ZIG=${ZIG:-$(command -v zig || echo "$HOME/.local/bin/zig")}
[ -x "$ZIG" ] || { echo "zig not found (set ZIG); it is the cross toolchain for the Linux helper"; exit 2; }
case "$ARCH" in x64) ZT=x86_64-linux-gnu.$WISP_GLIBC ;; arm64) ZT=aarch64-linux-gnu.$WISP_GLIBC ;; *) echo "bad arch $ARCH"; exit 2 ;; esac
ZLIB_VERSION=1.3.1
ZLIB_SHA=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/wisp-helper-build.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT

# 1. sources: a clean copy of wisp-helper/ (never build inside the checkout)
mkdir -p "$WORK/src"
( cd "$WISP_SRC" && COPYFILE_DISABLE=1 tar cf - --exclude build helper include convert LICENSE NOTICE ) | ( cd "$WORK/src" && tar xf - )
TREE=$( (cd "$WORK/src" && find . -type f | LC_ALL=C sort | xargs cat) | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16)

# 2. zlib, static, for the target
if [ -n "${ZLIB_TARBALL:-}" ]; then cp "$ZLIB_TARBALL" "$WORK/zlib.tgz"; else
  curl -fsSL --retry 2 -o "$WORK/zlib.tgz" "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz"; fi
GOT=$( (sha256sum "$WORK/zlib.tgz" 2>/dev/null || shasum -a 256 "$WORK/zlib.tgz") | cut -d' ' -f1)
[ "$GOT" = "$ZLIB_SHA" ] || { echo "zlib checksum mismatch: $GOT"; exit 4; }
tar xzf "$WORK/zlib.tgz" -C "$WORK"
Z="$WORK/zlib-$ZLIB_VERSION"
mkdir -p "$WORK/zinst/lib" "$WORK/zinst/include"
for c in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate inftrees trees uncompr zutil; do
  "$ZIG" cc -target "$ZT" -O2 -fPIC -D_LARGEFILE64_SOURCE=1 -DHAVE_HIDDEN -c "$Z/$c.c" -o "$WORK/zinst/$c.o"
done
"$ZIG" ar rcs "$WORK/zinst/lib/libz.a" "$WORK"/zinst/*.o
cp "$Z/zlib.h" "$Z/zconf.h" "$WORK/zinst/include/"

# 3. the helper, through its own build.sh with zig as CC/CXX (zig links libc++ statically)
# (no debug info; the final link strips symbols: a link is any call without -c)
cat > "$WORK/cxx" <<EOF
#!/bin/sh
S=-s; for a in "\$@"; do [ "\$a" = -c ] && S=; done
exec "$ZIG" c++ -target $ZT -g0 \$S -I"$WORK/zinst/include" -L"$WORK/zinst/lib" "\$@"
EOF
cat > "$WORK/cc" <<EOF
#!/bin/sh
exec "$ZIG" cc -target $ZT -I"$WORK/zinst/include" "\$@"
EOF
chmod +x "$WORK/cxx" "$WORK/cc"
CXX="$WORK/cxx" CC="$WORK/cc" sh "$WORK/src/helper/build.sh" "$WORK/out" > "$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; exit 5; }
cp "$WORK/out/wisp-helper" "$OUT/wisp-helper"
# licence texts from the exact tree that was built (for THIRD-PARTY-NOTICES)
mkdir -p "$OUT/licences"; for f in LICENSE NOTICE helper/NOTICE helper/lib/third_party/zstd/LICENSE; do
  cp "$WORK/src/$f" "$OUT/licences/$(echo "$f" | tr / _)"; done
chmod 755 "$OUT/wisp-helper"
BID=$(sed -n 's/^build id //p' "$WORK/build.log")
cat > "$OUT/wisp-helper.buildinfo" <<EOF
source: wisp-helper/ (files sha256 $TREE)
build-id: $BID
target: $ZT (glibc floor $WISP_GLIBC), libc++ and zlib $ZLIB_VERSION static
toolchain: zig $("$ZIG" version)
EOF
cat "$OUT/wisp-helper.buildinfo"
