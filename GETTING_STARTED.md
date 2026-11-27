# Getting started (development build)

This page covers building VaporView FSDB from source and running it in VS Code. For release VSIX files, see
"Building" in the [README](README.md#building).

## Tools

- [VS Code](https://code.visualstudio.com/) (latest)
- [Node](https://nodejs.org/en) 22
- [Rust](https://www.rust-lang.org/) 1.93.1 with the `wasm32-unknown-unknown` target
  (`rustup target add wasm32-unknown-unknown`), and `cargo install wasm-tools`
- For wisp-helper (the FSDB / WCZ reader in `wisp-helper/`): a C++17 compiler with floating-point `std::to_chars`
  (GCC 11+ or a recent clang) and zlib

## Build

```sh
npm ci
npm run compile-wasm      # wellen's VCD / FST / GHW reader -> target/.../filehandler.wasm, and filehandler.ts
npm run check-types
node esbuild.js           # -> dist/
```

`npm run compile-wasm` generates `src/wellen_parser/filehandler.ts` from the `.wit` interface (`npm run
generate:model`) and builds the WebAssembly reader with `tools/wellen/build-wasm.sh`. That build is reproducible:
it remaps paths, so the wasm has the same SHA-1 on every machine of the same kind, and the script checks it against
the pin for your build host (macOS arm64 and Linux x86-64 are pinned; the bytes differ between them only in symbol
hashes). Another SHA-1 is a warning: that wasm works the same, but `tools/package.sh` needs the pinned one.
`npm run compile-wasm-dev` runs a plain `cargo build` instead (faster to iterate on, but its output is not the
shipped file).

## Run

Open the folder in VS Code and use **Run and Debug** (F5). This starts an Extension Development Host with the
extension loaded.

FSDB and WCZ files are read by wisp-helper. Build it and point the extension at it:

```sh
cd wisp-helper && make    # -> build/helper/wisp-helper; `make check` runs its checks
```

Then set `"vaporview.wispHelperPath"` to the built binary in the Extension Development Host's settings. No vendor
library is needed. Upstream VaporView's optional FSDB addon (`fsdb_reader.cpp`, built against vendor reader
libraries) is not part of this repository.
