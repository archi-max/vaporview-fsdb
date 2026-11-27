#!/bin/bash
# vscode-port: run by `npm run generate:model` (and so `npm run compile-wasm`) after wit2ts. wit2ts exits 0 even when
# it fails (for example when wasm-tools is not installed), leaving no src/wellen_parser/filehandler.ts; packaging and
# the extension build then fail later with a less clear message. This fails here instead.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TS="$ROOT/src/wellen_parser/filehandler.ts"; WIT="$ROOT/src/wellen_parser/filehandler.wit"
if [ ! -s "$TS" ] || [ "$TS" -ot "$WIT" ]; then
  echo "ERROR: wit2ts did not write src/wellen_parser/filehandler.ts (missing, empty, or older than filehandler.wit)." >&2
  if ! command -v wasm-tools >/dev/null 2>&1; then
    echo "       wasm-tools is not on PATH, the likely cause: run \`cargo install wasm-tools\` (see GETTING_STARTED.md), then retry." >&2
  else
    echo "       wasm-tools is $(command -v wasm-tools) ($(wasm-tools --version 2>&1)); see the wit2ts error above." >&2
  fi
  exit 1
fi
