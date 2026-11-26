#!/bin/bash
# vscode-port: run the e2e suite against an INSTALLED VSIX on the Linux test host under xvfb
# (test/e2e/run-installed.mjs: fresh --extensions-dir and --user-data-dir, no dev folder).
# Usage: tools/linux-test-installed.sh <file.vsix> [also-install.vsix ...]   (env E2E_FILTER, E2E_HOST, E2E_SV_MODEL_BUILD_OK)
# Same limits as tools/linux-test.sh: nice 19, 15 min timeout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$(basename "$HERE")-installed"
REMOTE_DIR="${REMOTE_DIR:-vaporview-test/$NAME}"
HOST="${E2E_HOST:?set E2E_HOST to the ssh alias of a Linux x86-64 host}"
[ $# -ge 1 ] || { echo "usage: $0 <file.vsix> [also.vsix ...]"; exit 2; }
ssh -o BatchMode=yes "$HOST" "mkdir -p $REMOTE_DIR/vsix"
# only what the runner needs: the suite + fixtures, package files (for @vscode/test-electron), the VSIXes
COPYFILE_DISABLE=1 rsync -a --delete "$HERE/test" "$HERE/package.json" "$HERE/package-lock.json" "$HOST:$REMOTE_DIR/"
# vscode-port: link-extras checks the UI strings file of the source tree (media/cmux/strings.js, tools/import-cmux-modules.sh)
ssh -o BatchMode=yes "$HOST" "mkdir -p $REMOTE_DIR/media/cmux $REMOTE_DIR/tools" && COPYFILE_DISABLE=1 rsync -a "$HERE/media/cmux/strings.js" "$HOST:$REMOTE_DIR/media/cmux/" && COPYFILE_DISABLE=1 rsync -a "$HERE/tools/import-cmux-modules.sh" "$HOST:$REMOTE_DIR/tools/"
ARGS=""
for v in "$@"; do rsync -a "$v" "$HOST:$REMOTE_DIR/vsix/"; ARGS="$ARGS vsix/$(basename "$v")"; done
ssh -o BatchMode=yes "$HOST" "cd $REMOTE_DIR && \
  ( [ -d node_modules/@vscode/test-electron ] && [ package-lock.json -ot node_modules/.package-lock.json ] || nice -n 19 npm ci --no-audit --no-fund --ignore-scripts >/dev/null 2>&1 ) && \
  mkdir -p ../.vscode-test-cache && ln -sfn ../.vscode-test-cache .vscode-test && \
  PATH=\$HOME/vaporview-test/tools/slang-server-0.3.1:\$PATH E2E_FILTER='${E2E_FILTER:-}' E2E_SV_MODEL_BUILD_OK='${E2E_SV_MODEL_BUILD_OK:-}' E2E_WCZ='${E2E_WCZ:-}' E2E_FSDB='${E2E_FSDB:-}' E2E_FORMAT='${E2E_FORMAT:-fsdb}' E2E_FIXTURES_FMT_DIR=\"${E2E_FIXTURES_FMT_DIR:-\$HOME/vaporview-test/fixtures-fmt}\" E2E_FSDB_WINDOWED='${E2E_FSDB_WINDOWED:-}' E2E_WCZ_WINDOWED='${E2E_WCZ_WINDOWED:-}' E2E_LONGTASKS_OPTIONAL='${E2E_LONGTASKS_OPTIONAL:-}' E2E_DISABLE='${E2E_DISABLE:-}' E2E_DEMO_BIG=\"${E2E_DEMO_BIG:-}\" nice -n 19 timeout -k 15 ${E2E_TIMEOUT:-900} xvfb-run -a -s '-screen 0 1600x1000x24' node test/e2e/run-installed.mjs $ARGS 2>&1 | grep -v -E 'Gtk-WARNING|dbus|libva|Fontconfig|AgentHost|ChatModelSelection|AccountPolicyGate|^\s*$'"
