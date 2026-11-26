#!/bin/bash
# vscode-port: sync this repo to a Linux host (E2E_HOST, an ssh alias) and run the headless e2e suite there under xvfb.
# Usage: tools/linux-test.sh [E2E_FILTER]   (builds first on the Mac: npm run check-types && node esbuild.js; E2E_NO_BUILD=1 skips)
# vscode-port: forwards E2E_FSDB_DIR (your own FSDB fixtures on the box; FSDB tests SKIP without it),
# E2E_WISP_HELPER (default: wisp-helper on PATH) and E2E_WCZ_TOOLS (wcz-from-vcd etc.).
#        tools/linux-test.sh visual [FILTER]  (screenshot scenarios test/visual/*.visual.cjs, then the pixel-diff
#        gate test/visual/diff.mjs on the host; screenshots + diff images come back to test/visual/out/. With
#        UPDATE_BASELINES=1 the new screenshots replace test/visual/baseline/ on the Mac: only after looking at them.)
# Limits on the shared box: nice 19, 4 GB address space is too small for electron, so a 12 GB cap; 15 min timeout
# (E2E_TIMEOUT seconds; the fmt target uses 60 min per format).
# REMOTE_DIR defaults to ~/vaporview-test/<this checkout's dir name>, so parallel worktrees don't collide.
# slang-server 0.3.1 (hudson-trading/slang-server release v0.3.1 = 2ad996f, the Mac's version) is on PATH from
# ~/vaporview-test/tools/slang-server-0.3.1, so the source-link tests run with our own slang-server client. With
# E2E_SLANG_ROUTE=extension they run through the slang VS Code extension 0.3.3 instead (copied to
# ~/vaporview-test/tools/vscode-ext-slang, enabled with --extensions-dir).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$(basename "$HERE")"
REMOTE_DIR="${REMOTE_DIR:-vaporview-test/$NAME}"
HOST="${E2E_HOST:?set E2E_HOST to the ssh alias of a Linux x86-64 host}"
# (left as $HOME/... so the remote shell expands them)
FSDB_DIR="${E2E_FSDB_DIR:-}"
# wisp-helper on the host (default: `wisp-helper` on its PATH) and the wcz tools folder (optional)
WISP_HELPER="${E2E_WISP_HELPER:-wisp-helper}"
WCZ_TOOLS="${E2E_WCZ_TOOLS:-}"
# vscode-port: E2E_FORMAT=fsdb|wcz|vcd (default fsdb): the dumps the tests open are the FSDB / WCZ twins under
# E2E_FIXTURES_FMT_DIR (default ~/vaporview-test/fixtures-fmt on the host; made + content-checked by tools/fmt). A missing twin
# fails the test (test/e2e/suite/helpers.cjs), never a VCD fallback.
#        tools/linux-test.sh fmt [FILTER]   runs the full suite with fsdb, then with wcz, and prints a SUMMARY per format
#        (pass/fail counts + failing test names); full logs in test/e2e/out-fmt/<format>.log. Exit 1 if any format fails.
FORMAT="${E2E_FORMAT:-fsdb}"
FMT_DIR="${E2E_FIXTURES_FMT_DIR:-\$HOME/vaporview-test/fixtures-fmt}"
# vscode-port: link-add-perf's big FSDB (bigsoc 1.7 GB) and its 100 signal paths; the test prints SKIP if missing
BIG_FSDB="${E2E_BIG_FSDB:-\$HOME/vaporview-test/demo/remote-big/bigsoc-big.fsdb}"; BIG_PATHS="${E2E_BIG_PATHS:-\$HOME/vaporview-test/demo/remote-big/add100.txt}"
TRACE_BIG_VCD="${E2E_TRACE_BIG_VCD:-}"   # (the xr design for 1M cycles; trace-wisp's big case SKIPs without it)
if [ "${1:-}" = fmt ]; then
  shift; out="$HERE/test/e2e/out-fmt"; mkdir -p "$out"; frc=0
  for f in fsdb wcz; do
    E2E_FORMAT=$f E2E_TAIL=1000000 E2E_TIMEOUT=${E2E_TIMEOUT:-3600} "$0" "$@" > "$out/$f.log" 2>&1 || frc=1
  done
  sha=$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown); git -C "$HERE" diff --quiet HEAD 2>/dev/null || sha="$sha+dirty"
  for f in fsdb wcz; do
    p=$(grep -c '^PASS ' "$out/$f.log" || true); n=$(grep -c '^FAIL ' "$out/$f.log" || true); k=$(grep -c '^SKIP [^ ]* :: ' "$out/$f.log" || true)
    # (one per test: the runner's "SKIP <file> :: <test>: <reason>"; a test's own "SKIP <reason>" line just before it
    # is not counted again. The in-host E2E SUMMARY wins when the run printed one.)
    sm=$(grep -o 'E2E SUMMARY pass=[0-9]* fail=[0-9]* skip=[0-9]*' "$out/$f.log" | tail -1)
    if [ -n "$sm" ]; then p=$(echo "$sm" | sed 's/.*pass=\([0-9]*\).*/\1/'); n=$(echo "$sm" | sed 's/.*fail=\([0-9]*\).*/\1/'); k=$(echo "$sm" | sed 's/.*skip=\([0-9]*\).*/\1/'); fi
    echo "SUMMARY $f @ $sha (dist built from it): $p passed, $n failed, $k skipped (log test/e2e/out-fmt/$f.log)"
    [ "$p" = 0 ] && [ "$n" = 0 ] && echo "  NO TEST RAN on $f ($k skipped): check E2E_WORKSPACE / the filter"
    grep '^FAIL ' "$out/$f.log" | sed -E 's/^FAIL ([^ ]+ :: [^:]*):.*/  FAIL \1/' || true
    grep -q '^E2E SUMMARY' "$out/$f.log" || echo "  INCOMPLETE: no E2E SUMMARY line (timeout or crash before the last test; see the log)"
  done
  exit $frc
fi
VISUAL=""; if [ "${1:-}" = visual ]; then VISUAL=1; shift; fi
# The wellen wasm must be the reproducible patched build (tools/wellen/build-wasm.sh): other bytes may embed
# builder home paths or lack the split-bit fix, and tests on them prove nothing about what ships.
WASM="$HERE/target/wasm32-unknown-unknown/release/filehandler.wasm"
WANT=5375b64ce3ef089af7bd3a85554824343ba28467
GOT="$(shasum "$WASM" 2>/dev/null | cut -d' ' -f1)"
if [ "$GOT" != "$WANT" ]; then
  echo "E2E FAIL: $WASM SHA-1 is '${GOT:-missing}', expected $WANT (rebuild: tools/wellen/build-wasm.sh <dir> --install)" >&2
  exit 2
fi
# A stale dist/ tests old code: build it from this checkout first (a run on 2026-11-25 tested a webview.js older than
# its sources and failed on a bug those sources had fixed).
if [ -z "${E2E_NO_BUILD:-}" ]; then
  ( cd "$HERE" && npm run -s check-types && node esbuild.js >/dev/null ) || { echo "E2E FAIL: build failed" >&2; exit 2; }
fi
COPYFILE_DISABLE=1 rsync -a --delete --exclude node_modules --include 'target/' --include 'target/wasm32-unknown-unknown/' --include 'target/wasm32-unknown-unknown/release/' --include 'target/wasm32-unknown-unknown/release/filehandler.wasm' --exclude 'target/**' --exclude .git --exclude '*.vsix' \
  --exclude '.vscode-test' --exclude 'test/visual/out' --exclude 'test/e2e/out-fmt' "$HERE/" "$HOST:$REMOTE_DIR/"
rc=0
# The checkout has a .git (repo or worktree): give the copy one too, as a marker only, so root rules that look for the
# nearest .git see the same tree as an installed run on the Mac (link-profiles passed here and failed installed).
if [ -e "$HERE/.git" ]; then ssh -o BatchMode=yes "$HOST" "cd $REMOTE_DIR && { [ -e .git ] || printf 'gitdir: (e2e marker; the source checkout has a .git)\n' > .git; }"; fi
ssh -o BatchMode=yes "$HOST" "cd $REMOTE_DIR && rm -rf \"\${PWD:?}/test/visual/out\" && \
  ( [ -d node_modules/@vscode/test-electron ] && [ package-lock.json -ot node_modules/.package-lock.json ] || nice -n 19 npm ci --no-audit --no-fund --ignore-scripts >/dev/null 2>&1 ) && \
  mkdir -p ../.vscode-test-cache && ln -sfn ../.vscode-test-cache .vscode-test && \
  PATH=\$HOME/vaporview-test/tools/slang-server-0.3.1:\$PATH E2E_SLANG_ROUTE='${E2E_SLANG_ROUTE:-}' \
  E2E_EXTENSIONS_DIR=\$( [ '${E2E_SLANG_ROUTE:-}' = extension ] && echo \$HOME/vaporview-test/tools/vscode-ext-slang ) \
  VAPORVIEW_CMUX_CACHE=\$HOME/vaporview-test/.cache/vaporview-cmux E2E_VISUAL='$VISUAL' E2E_FILTER='${1:-}' E2E_FSDB_DIR=\"$FSDB_DIR\" E2E_WISP_HELPER=\"$WISP_HELPER\" E2E_WCZ_TOOLS=\"$WCZ_TOOLS\" E2E_TRACE_BIG_VCD=\"$TRACE_BIG_VCD\" E2E_NOSRC='${E2E_NOSRC:-}' E2E_WORKSPACE='${E2E_WORKSPACE:-}' E2E_DEMO_BIG=\"${E2E_DEMO_BIG:-}\" E2E_DEMO_UNDUMPED='${E2E_DEMO_UNDUMPED:-}' E2E_DEMO_COMPUTED_BP=\"${E2E_DEMO_COMPUTED_BP:-}\" E2E_EXCLUDE='${E2E_EXCLUDE:-}' E2E_DEMO_LINE_BP='${E2E_DEMO_LINE_BP:-}' E2E_DEMO_LINE_DUMP='${E2E_DEMO_LINE_DUMP:-}' E2E_DEMO_LINE_SLANG='${E2E_DEMO_LINE_SLANG:-}' E2E_FORMAT='$FORMAT' E2E_FIXTURES_FMT_DIR=\"$FMT_DIR\" E2E_BIG_FSDB=\"$BIG_FSDB\" E2E_ADDS_FSDB=\"${E2E_ADDS_FSDB:-}\" E2E_ADDS_WCZ=\"${E2E_ADDS_WCZ:-}\" E2E_BIG_PATHS=\"$BIG_PATHS\" E2E_CLOSE_MEM_FSDB=\"${E2E_CLOSE_MEM_FSDB:-}\" E2E_CLOSE_MEM_WCZ=\"${E2E_CLOSE_MEM_WCZ:-}\" nice -n 19 ${E2E_CORES:+taskset -c $E2E_CORES }timeout -k 15 ${E2E_TIMEOUT:-900} xvfb-run -a -s '-screen 0 1600x1000x24' node test/e2e/run.mjs 2>&1 | grep -v -E 'Gtk-WARNING|dbus|libva|Fontconfig|AgentHost|ChatModelSelection|AccountPolicyGate|^\s*$' | tail -${E2E_TAIL:-80}; exit \${PIPESTATUS[0]}" || rc=$?
if [ -n "$VISUAL" ]; then
  if [ "${UPDATE_BASELINES:-}" != 1 ]; then ssh -o BatchMode=yes "$HOST" "cd $REMOTE_DIR && node test/visual/diff.mjs" || rc=1; fi
  mkdir -p "$HERE/test/visual/out"
  rsync -a --delete "$HOST:$REMOTE_DIR/test/visual/out/" "$HERE/test/visual/out/"
  if [ "${UPDATE_BASELINES:-}" = 1 ] && [ "$rc" = 0 ]; then UPDATE_BASELINES=1 node "$HERE/test/visual/diff.mjs"; fi
fi
exit $rc
