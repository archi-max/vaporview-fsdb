// SPDX-License-Identifier: MIT
// The helper's store and answer code over a WCZ1 container (one translation unit, built by
// ../../build.sh with ../third_party/zstd/zstddec.c, the zstd decompressor). It registers the
// store, window, search and derived-signal exports the helper calls, plus sourceInfo (what this
// source has) and sourceVerify.
#include <napi.h>
#include "store_napi.h"
#include "store.cpp.inc"
#include "deval.h"
#include "derive.cpp.inc"
#include "blocksrc.cpp.inc"
#include "wcz_source.cpp.inc"
#include "known_ids.cpp.inc"

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  storeExports(env, exports);
  deriveExports(env, exports);
  sourceExports(env, exports);
  wczExports(env, exports);
  return exports;
}

NODE_API_MODULE(wcb_reader, Init)
