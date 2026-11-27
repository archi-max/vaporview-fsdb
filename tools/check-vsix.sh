#!/bin/bash
# vscode-port: release gate for a built VSIX. Unzips it and FAILS on:
#   1. vendor files: Synopsys / Verdi / VCS binaries or libraries, any shared library (.so/.dylib/.dll), node addons
#      (.node, e.g. upstream's FSDB addon), anything naming a vendor FSDB reader library;
#   2. waveform dumps (FSDB, WCZ, WCB, VCD, FST, GHW, VVZ ...): none ship (no fixtures at all);
#   3. denied names or paths in any file, text or binary: home paths, plus the patterns in $CHECK_VSIX_DENYLIST;
#   4. dev-only files: tests, tools, sources, source maps, CI configs;
#   5. a native program in bin/ that needs more than libc (NEEDED other than libc/libm/libpthread/libdl/ld-linux),
#      or a glibc symbol version above the floor (CHECK_GLIBC_MAX, default 2.17); needs objdump or llvm-objdump.
#   7. a missing or stale prebuilt trace sidecar (sv-model) for linux-x64 / darwin-arm64 / darwin-x64 (see below).
# Prints the VSIX size and file list. Exit 0 = PASS.
# Usage: tools/check-vsix.sh <file.vsix> [more.vsix ...]
set -uo pipefail
GLIBC_MAX=${CHECK_GLIBC_MAX:-2.17}
OBJDUMP=$(command -v objdump || command -v llvm-objdump || ls /opt/homebrew/opt/llvm/bin/llvm-objdump 2>/dev/null || true)
# private-name patterns (extended regex, case-insensitive), one per line in the file $CHECK_VSIX_DENYLIST (kept outside
# the repository: host names, account ids, home paths of the people who build releases). Unset: home paths only.
DENY='/Users/[a-z]'
if [ -n "${CHECK_VSIX_DENYLIST:-}" ]; then
  [ -s "$CHECK_VSIX_DENYLIST" ] || { echo "FAIL CHECK_VSIX_DENYLIST=$CHECK_VSIX_DENYLIST is missing or empty"; exit 1; }
  DENY="$DENY|$(grep -v -e '^#' -e '^$' "$CHECK_VSIX_DENYLIST" | paste -sd'|' -)"
fi
VENDOR_NAME='synopsys|verdi|novas|libnffr|libnsys|ffrAPI|fsdbreader|libsscore|vcs_home|vcs-mx'
DUMPS='\.(fsdb|wcz|wcb|vcd|fst|ghw|vvz|evcd|lxt|lxt2|vzt|trn|shm)(\.gz|\.zst)?$'
DEVFILES='^wisp-helper/|(^|/)(test/|tests/|tools/|src/|\.vscode/|\.vscode-test|\.github/|CLAUDE\.md)|\.map$|\.tsbuildinfo$|(^|/)\.env'
rc_all=0
for VSIX in "$@"; do
  fail=0
  bad() { echo "FAIL $1"; fail=1; }
  [ -f "$VSIX" ] || { echo "FAIL no such file $VSIX"; rc_all=1; continue; }
  W=$(mktemp -d "${TMPDIR:-/tmp}/check-vsix.XXXXXX")
  unzip -q "$VSIX" -d "$W" || { echo "FAIL cannot unzip $VSIX"; rc_all=1; continue; }
  LIST=$(cd "$W" && find . -type f | sed 's#^\./##' | sort)
  # 1. vendor files
  while IFS= read -r f; do
    case "$f" in *.so|*.so.*|*.dylib|*.dll|*.node|*.a|*.o) bad "shared/native library or addon: $f" ;; esac
    # (our own scripts that drive the user's Verdi on request live in media/cmux/verdi-trace/: allowed by name;
    #  their contents still go through every check below)
    case "$f" in extension/media/cmux/verdi-trace/*) ;; *) echo "$f" | grep -qiE "$VENDOR_NAME" && bad "vendor name in path: $f" ;; esac
    # 2. dumps
    echo "$f" | grep -qiE "$DUMPS" && bad "waveform dump: $f"
    # 4. dev-only files (paths inside extension/)
    p=${f#extension/}
    case "$p" in node_modules/@vscode/codicons/*) continue ;; esac
    echo "$p" | grep -qE "$DEVFILES" && bad "dev/internal file: $f"
    case "$p" in node_modules/*) bad "unbundled node_modules file: $f" ;; esac
  done <<< "$LIST"
  # 3. internal names in contents (text and binary): grep -a over every file, then strings for a short context
  while IFS= read -r f; do
    hit=$(LC_ALL=C grep -a -o -i -E "$DENY" "$W/$f" 2>/dev/null | sort -u | head -3 | tr '\n' ' ')
    [ -n "$hit" ] && bad "denied name in $f: $hit"
    hit=$(LC_ALL=C grep -a -o -i -E "$VENDOR_NAME" "$W/$f" 2>/dev/null | sort -u | head -3 | tr '\n' ' ')
    # vendor words are allowed in text that explains the Verdi features and the FSDB setting descriptions, not in binaries
    if [ -n "$hit" ] && file "$W/$f" | grep -qE 'ELF|Mach-O|PE32'; then bad "vendor name inside binary $f: $hit"; fi
  done <<< "$LIST"
  # 6. the wellen wasm is the reproducible build of a pinned build host (tools/wellen/wasm-pin.sh --all; the VSIX may
  #    have been built on another host than the one checking it)
  PINS=$(bash "$(dirname "$0")/wellen/wasm-pin.sh" --all 2>/dev/null)
  GOT_WASM=$(shasum "$W/extension/target/wasm32-unknown-unknown/release/filehandler.wasm" 2>/dev/null | cut -d' ' -f1)
  PIN_HOST=$(awk -v s="${GOT_WASM:-none}" '$2 == s {print $1; exit}' <<< "$PINS")
  if [ -z "$PIN_HOST" ]; then bad "filehandler.wasm SHA-1 ${GOT_WASM:-missing} is not a pinned reproducible build ($(tr '\n' ' ' <<< "$PINS"))"; else echo "wasm SHA-1 $GOT_WASM (reproducible build, $PIN_HOST)"; fi
  # 5. native programs: dependencies and glibc floor
  while IFS= read -r f; do
    file "$W/$f" | grep -q ELF || continue
    [ -n "$OBJDUMP" ] || { bad "no objdump to check $f"; continue; }
    needed=$("$OBJDUMP" -p "$W/$f" 2>/dev/null | awk '/NEEDED/{print $2}' | tr '\n' ' ')
    for n in $needed; do case "$n" in libc.so.6|libm.so.6|libpthread.so.0|libdl.so.2|librt.so.1|ld-linux-x86-64.so.2|ld-linux-aarch64.so.1) ;; *) bad "$f needs $n" ;; esac; done
    maxg=$("$OBJDUMP" -T "$W/$f" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' | sed 's/GLIBC_//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
    if [ -n "$maxg" ] && [ "$(printf '%s\n%s\n' "$maxg" "$GLIBC_MAX" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" != "$GLIBC_MAX" ]; then bad "$f needs GLIBC_$maxg > floor $GLIBC_MAX"; fi
    echo "native $f: NEEDED $needed; max GLIBC_${maxg:-none} (floor $GLIBC_MAX)"
  done <<< "$LIST"
  # 5b. macOS programs: only system libraries (/usr/lib, /System), a code signature (ad-hoc is enough), no quarantine
  while IFS= read -r f; do
    file "$W/$f" | grep -q Mach-O || continue
    command -v otool >/dev/null || { echo "note: no otool, $f not checked"; continue; }
    deps=$(otool -L "$W/$f" | tail -n +2 | awk '{print $1}' | tr '\n' ' ')
    for n in $deps; do case "$n" in /usr/lib/*|/System/*) ;; *) bad "$f links $n" ;; esac; done
    codesign -v "$W/$f" 2>/dev/null || bad "$f has no valid code signature (arm64 macOS will not run it)"
    echo "native $f: $(lipo -archs "$W/$f") links $deps; $(otool -l "$W/$f" | awk '/minos/{print "minos " $2; exit}')"
  done <<< "$LIST"
  # 7. the trace sidecar (cmux-sv-model) ships prebuilt for linux-x64, darwin-arm64 and darwin-x64: for every one of these
  #    platforms with a bin/<platform>/ folder, bin/<platform>/sv-model/<hash>-<arch>/ must hold cmux-sv-model + sv-model.sh,
  #    where <hash> is what the extension computes from the shipped media/cmux/sv-model sources (src/cmux/trace/sidecar.ts
  #    installDir: sha256 over CMakeLists.txt, build.sh, sv-model.sh, sv_model.cpp, first 16 hex). Else the first Trace
  #    on a user's machine compiles it (minutes, and fails without a toolchain).
  SVD="$W/extension/media/cmux/sv-model"
  if [ -d "$SVD" ]; then
    SVH=$(cat "$SVD"/CMakeLists.txt "$SVD"/build.sh "$SVD"/sv-model.sh "$SVD"/sv_model.cpp | shasum -a 256 | cut -c1-16)
    for P in linux-x64 darwin-arm64 darwin-x64; do
      [ -d "$W/extension/bin/$P" ] || continue
      A=${P#*-}; [ "$A" = x64 ] && A=x86_64
      S="$W/extension/bin/$P/sv-model/$SVH-$A"
      if [ -x "$S/cmux-sv-model" ] && [ -f "$S/sv-model.sh" ]; then echo "sv-model $P: prebuilt $SVH-$A ($(sed -n 's/^slang: /slang /p' "$S/buildinfo" 2>/dev/null))"
      else bad "bin/$P has no prebuilt sv-model for the shipped sources ($SVH-$A; found: $(ls "$W/extension/bin/$P/sv-model" 2>/dev/null | tr '\n' ' '))"; fi
    done
  else bad "no media/cmux/sv-model sources in the VSIX"; fi
  SIZE=$(wc -c < "$VSIX" | tr -d ' ')
  echo "--- $VSIX: $SIZE bytes ($(( (SIZE + 524288) / 1048576 )) MiB), $(echo "$LIST" | wc -l | tr -d ' ') files"
  (cd "$W" && find . -type f -exec ls -l {} + | awk '{printf "%10d  %s\n", $5, substr($9,3)}' | sort -k2)
  rm -rf "${W:?}"
  if [ $fail = 0 ]; then echo "PASS check-vsix $(basename "$VSIX")"; else echo "FAIL check-vsix $(basename "$VSIX")"; rc_all=1; fi
done
exit $rc_all
