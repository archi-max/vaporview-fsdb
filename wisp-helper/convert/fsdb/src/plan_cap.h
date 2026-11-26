// SPDX-License-Identifier: MIT
// Plan text cap shared by the planner (fplan) and the converter (run_plan_threaded).
// The plan lists the input's value blocks, periods and windows, so its size grows with the FSDB. A fixed cap refused large
// inputs at default settings, so the default now scales with the input: max(1 GiB, input bytes / 2). Plans measured so far are
// well under a fifth of the input size (about 0.2x on a 10 GB input), so the default is more than twice the largest plan seen, while still
// bounding the memory a corrupt file can make the planner or converter allocate. A decimal byte count in the environment
// variable (FPLAN_MAX_PLAN_BYTES or RUN_PLAN_MAX_PLAN_BYTES) replaces the default; a malformed value is an error.
// Big dumps: RUN_PLAN_BUDGET_MB (the converter's memory budget, the one documented setting for them) also raises the
// default to at least the budget, in both the planner and the converter: max(1 GiB, input size / 2, budget). A budget the
// converter would not accept (outside 64..32768 MiB, read as strtoull reads it) does not change the cap. The largest cap
// without an explicit byte count is therefore max(input size / 2, 32 GiB); a plan over its cap is refused before it is
// written or read, never allocated (both sides stream the plan text).
#pragma once
#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <string>

namespace plancap {
constexpr uint64_t FLOOR = uint64_t(1) << 30;
constexpr uint64_t BUDGET_MIN_MB = 64, BUDGET_MAX_MB = 32768;  // the converter's RUN_PLAN_BUDGET_MB range (src/fsdb_plan_check.h)
inline uint64_t default_cap(uint64_t input_bytes) { return std::max<uint64_t>(FLOOR, input_bytes / 2); }
// RUN_PLAN_BUDGET_MB value -> bytes, 0 when unset or outside the converter's range
inline uint64_t budget_bytes(const char* budget) {
  if (!budget) return 0;
  const uint64_t mb = std::strtoull(budget, nullptr, 10);
  return mb >= BUDGET_MIN_MB && mb <= BUDGET_MAX_MB ? mb << 20 : 0;
}
enum class Src { DEFAULT, ENV, BUDGET };  // where a cap came from (refusal text)
// Cap for an input of input_bytes. env = the byte-count variable's value, budget = RUN_PLAN_BUDGET_MB's (nullptr = unset).
// On a malformed byte count returns 0 and sets err. src (optional) gets where the cap came from.
inline uint64_t cap(uint64_t input_bytes, const char* env, const char* var, const char* budget, std::string& err, Src* src = nullptr) {
  if (!env) {
    const uint64_t d = default_cap(input_bytes), b = budget_bytes(budget);
    if (src) *src = b > d ? Src::BUDGET : Src::DEFAULT;
    return std::max(d, b);
  }
  if (src) *src = Src::ENV;
  char* end = nullptr; errno = 0;
  unsigned long long v = std::strtoull(env, &end, 10);
  if (!(*env >= '0' && *env <= '9') || *end || errno || v == 0) {
    err = std::string(var) + " must be a positive decimal byte count, got '" + env + "'";
    return 0;
  }
  return v;
}
// the cap without RUN_PLAN_BUDGET_MB (the rule before it was added)
inline uint64_t cap(uint64_t input_bytes, const char* env, const char* var, std::string& err) { return cap(input_bytes, env, var, nullptr, err); }
// Refusal text: the size needed, the cap, where the cap came from, and how to raise it.
inline std::string refusal(const char* what, uint64_t need, uint64_t cap_bytes, Src src, const char* var) {
  std::string s = std::string(what) + " (";
  if (need) s += "plan needs " + std::to_string(need) + " bytes, ";
  s += "cap " + std::to_string(cap_bytes) + " bytes";
  s += src == Src::ENV ? std::string(" from ") + var
     : src == Src::BUDGET ? std::string(" = RUN_PLAN_BUDGET_MB (larger than the default max(1 GiB, input size / 2))")
                          : std::string(" = default max(1 GiB, input size / 2)");
  return s + "; " + var + (src == Src::BUDGET ? " or a larger RUN_PLAN_BUDGET_MB raises it)" : " raises it)");
}
inline std::string refusal(const char* what, uint64_t need, uint64_t cap_bytes, bool from_env, const char* var) {
  return refusal(what, need, cap_bytes, from_env ? Src::ENV : Src::DEFAULT, var);
}
}  // namespace plancap
