#!/bin/bash
# vscode-port: red test for tools/check-vsix.sh. Plants a dump, a vendor-named library, a test file and a
# home path into a copy of a good VSIX; the gate must FAIL on each.  Usage: tools/check-vsix-selftest.sh <good.vsix>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R=$(mktemp -d "${TMPDIR:-/tmp}/check-vsix-red.XXXXXX"); trap 'rm -rf "${R:?}"' EXIT
cp "${1:?good vsix}" "$R/red.vsix"; mkdir -p "$R/extension/test"
echo x > "$R/extension/dump.fsdb"; echo "cd /Users/someone/src" > "$R/extension/notes.txt"; echo y > "$R/extension/test/a.js"; : > "$R/extension/libnffr.so"
(cd "$R" && zip -q red.vsix extension/dump.fsdb extension/notes.txt extension/test/a.js extension/libnffr.so)
out=$("$HERE/check-vsix.sh" "$R/red.vsix" 2>&1); rc=$?
ok=1
for want in 'waveform dump: extension/dump.fsdb' 'vendor name in path: extension/libnffr.so' 'dev/internal file: extension/test/a.js' 'denied name in extension/notes.txt'; do
  grep -qF "FAIL $want" <<< "$out" || { echo "MISSED: $want"; ok=0; }
done
[ $rc -ne 0 ] && [ $ok = 1 ] && echo "PASS check-vsix-selftest (gate failed on all 4 planted problems)" || { echo "FAIL check-vsix-selftest"; exit 1; }
