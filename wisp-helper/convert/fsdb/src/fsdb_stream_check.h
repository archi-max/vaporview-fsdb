// SPDX-License-Identifier: MIT
// Per-stream header check shared by the converter (run_plan_threaded) and the read header (sigread.h): a stream whose
// header this decoder does not qualify is refused by name with the returned reason ("" = accepted).
#pragma once
#include "fsdb_values.h"
#include <cstdint>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>
// Test-only red mutants (RUN_PLAN_TEST_*): read only in the test build (RUN_PLAN_TEST_HOOKS, build.mk fsdb/test/); the shipped
// converter is built without it, so these names are not in its binary and setting them has no effect.
#ifndef RUN_PLAN_TEST_ENV
#ifdef RUN_PLAN_TEST_HOOKS
#define RUN_PLAN_TEST_ENV(n) std::getenv(n)
#else
#define RUN_PLAN_TEST_ENV(n) ((const char*)nullptr)
#endif
#endif
namespace fsdbraw {
inline std::string stream_header_refusal(const std::vector<uint8_t>& raw, uint64_t o, uint32_t bits) {
  static const std::set<unsigned> OK = [] { std::set<unsigned> k{WCZ_FSDB_CODECS}; /*single source: fsdb_values.h*/
    if (const char* d = RUN_PLAN_TEST_ENV("RUN_PLAN_TEST_DROP_CODEC")) k.erase(unsigned(std::atoi(d))); /*TEST-ONLY*/ return k; }();
  if (o >= raw.size()) return "bus offset past block";
  unsigned k = raw[o]; if (!OK.count(k)) return "unsupported value encoding";
  if (k == ENC_SCALAR) return bits != 1 ? "scalar VC width" : "";
  if (o + 6 > raw.size()) return "stream header crosses block";
  unsigned fl = raw[o + 1]; uint32_t w = uint32_t(raw[o + 2]) | uint32_t(raw[o + 3]) << 8 | uint32_t(raw[o + 4]) << 16 | uint32_t(raw[o + 5]) << 24;
  if (fl != 0) return "unsupported stream header flags";
  if (w != bits) return "stream width " + std::to_string(w) + " != declared " + std::to_string(bits);
  if (k == ENC_PLANES && bits > WCZ_FSDB_PLANES_MAX_BITS) return "packed-plane stream width " + std::to_string(bits) + " > " + std::to_string(WCZ_FSDB_PLANES_MAX_BITS);
  return "";
}
}  // namespace fsdbraw
