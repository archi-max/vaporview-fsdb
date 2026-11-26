// SPDX-License-Identifier: MIT
// Plan consistency checks shared by the converter (run_plan_threaded, on the plan it reads) and the read header
// (sigread.h, on the plan it builds in process): one definition of each rule and its message. Each function returns
// nullptr when the item passes, else the converter's message for it. The callers apply them in the converter's order
// (header, blocks, periods, windows, variables with their records and aliases, then the cross-item checks), so the first
// failure gives the same text on both paths. Templates take any struct with the plan's field names (off/size/period for
// blocks; begin/end/direct for periods; kind/period/count/index_blk/vc/block/offset/begin/end for records).
#pragma once
#include <cstdint>
#include <cstdlib>
#include <map>
#include <set>
#include <utility>
#include <vector>

namespace fsdbplan {

constexpr uint64_t MAX_RECORDS = 64000000, MAX_BLOCKS = 16000000, MAX_WINDOWS = 64000000;
constexpr uint32_t MAX_PERIODS = 1000000, MAX_VARS = 64000000, MAX_PERIOD_DELTAS = 1000000, MAX_DEPTH = 512;
constexpr uint64_t MAX_TOTAL_DELTAS = (256ull << 20) / sizeof(uint64_t), MAX_ALIASES = 256000000;
constexpr uint32_t MAX_VAR_BITS = 1u << 20;      // = the WCZ writer's MAX_BITS (the converter asserts it)
constexpr size_t MAX_NAME_BYTES = 1u << 20;      // one scope component or leaf (2 MiB of hex in the plan text)
#ifndef RUN_PLAN_MAX_SCOPES   // test builds only (red case); default sized for tens of millions of signals at deep hierarchy
#define RUN_PLAN_MAX_SCOPES 8000000000ull   // a count only (the sum of name-path depths); nothing is sized by it
#endif
constexpr uint64_t MAX_SCOPE_COMPONENTS = RUN_PLAN_MAX_SCOPES;

inline const char* window_count(uint64_t nw) { return nw <= MAX_WINDOWS ? nullptr : "window count limit"; }
inline const char* file_times(int64_t exp, uint64_t tmin, uint64_t tmax) { return exp >= -18 && exp <= 3 && tmin <= tmax ? nullptr : "invalid file times"; }
inline const char* counts(uint64_t nb, uint64_t nc, uint64_t nt, uint64_t nv) {
  return nb <= MAX_BLOCKS && nc <= MAX_BLOCKS && nt && nt <= MAX_PERIODS && nv && nv <= MAX_VARS ? nullptr : "plan count limit"; }
// a bus (B) or index (C) block: its period, then its physical range inside the file
template <class B> const char* block(const B& b, uint64_t nt, uint64_t file_size) {
  if (!(b.period < nt)) return "block period outside plan";
  if (!(b.off <= file_size && b.size <= file_size - b.off)) return "physical FSDB bounds";
  return nullptr; }
// a period with n time-dictionary entries; total = running sum of n over the periods so far, this one included
template <class P> const char* period(const P& s, uint64_t tmin, uint64_t tmax, uint64_t n, uint64_t total) {
  if (!(tmin <= s.begin && s.begin <= s.end && s.end <= tmax && (s.direct ? n == 0 : n > 0) && n <= MAX_PERIOD_DELTAS)) return "invalid period/dictionary";
  if (!(total <= MAX_TOTAL_DELTAS)) return "aggregate dictionary limit";
  return nullptr; }
// the file's time bounds (header begin / end) must be the earliest stored period begin and the latest stored period end:
// a header end past the stored data would otherwise be served as the file's end and written as the WCZ t_end
template <class PS> const char* file_bounds(uint64_t tmin, uint64_t tmax, const PS& periods) {
  uint64_t b = UINT64_MAX, e = 0; for (auto& p : periods) { if (p.begin < b) b = p.begin; if (p.end > e) e = p.end; }
  return !periods.empty() && b == tmin && e == tmax ? nullptr : "file time bounds do not match the stored periods"; }
// an explicit stream window [start, end) in byte positions of the period's bus blocks (block * 65536 + offset)
template <class B> const char* window(uint32_t period, uint64_t start, uint64_t end, const std::vector<B>& bus, uint64_t nt) {
  return period < nt && start < end && start / 65536 < bus.size() && (end - 1) / 65536 < bus.size() && bus[start / 65536].period == period &&
         bus[(end - 1) / 65536].period == period ? nullptr : "invalid explicit stream window"; }
inline const char* duplicate_window() { return "duplicate stream window"; }
// windows by (period, start) -> end: no two in one period overlap
inline const char* windows_overlap(const std::map<std::pair<uint32_t, uint64_t>, uint64_t>& w) {
  uint32_t prior = UINT32_MAX; uint64_t prior_end = 0;
  for (auto& e : w) { if (e.first.first == prior && !(e.first.second >= prior_end)) return "overlapping stream windows"; prior = e.first.first; prior_end = e.second; }
  return nullptr; }
// a variable's declaration; fresh_id = its id was not seen before
inline const char* variable(uint64_t id, bool fresh_id, uint64_t bits, int64_t left, int64_t right, uint64_t depth) {
  return id && fresh_id && bits && bits <= MAX_VAR_BITS && uint64_t(std::llabs(left - right)) + 1 == bits && depth && depth <= MAX_DEPTH ? nullptr : "invalid variable"; }
// RUN_PLAN_BUDGET_MB: a MiB count (read as strtoull reads it) in 64..32768; bytes gets the value in bytes when it passes
constexpr uint64_t MIN_BUDGET_MB = 64, MAX_BUDGET_MB = 32768;
inline const char* budget_mb(const char* s, uint64_t& bytes) {
  const uint64_t mb = std::strtoull(s, nullptr, 10);
  if (mb < MIN_BUDGET_MB || mb > MAX_BUDGET_MB) return "RUN_PLAN_BUDGET_MB must be 64..32768";
  bytes = mb << 20; return nullptr;
}
inline const char* scope_total(uint64_t total) { return total <= MAX_SCOPE_COMPONENTS ? nullptr : "aggregate scope count limit"; }
inline const char* name_part(size_t bytes) { return bytes == 0 ? "invalid plan string" : bytes > MAX_NAME_BYTES ? "plan token limit" : nullptr; }
inline const char* duplicate_declaration() { return "duplicate declaration"; }
inline const char* record_total(uint64_t total) { return total <= MAX_RECORDS ? nullptr : "record count limit"; }
inline const char* record_kind(char k) { return k == 'S' || k == 'I' || k == 'B' ? nullptr : "unsupported record kind"; }
// one record of a variable with `bits` bits
template <class R, class B, class P> const char* record(const R& r, uint64_t bits, const std::vector<B>& bus, const std::vector<B>& index_blk, const std::vector<P>& periods) {
  if (!(r.period < periods.size() && r.count && r.count <= UINT32_MAX)) return "invalid record";
  if (r.kind == 'B') {
    if (!(r.block < bus.size() && bus[r.block].period == r.period && r.offset < 65536 && r.index_blk == 0 && r.vc == 0 &&
          periods[r.period].begin <= r.begin && r.begin <= r.end && r.end <= periods[r.period].end)) return "invalid bus record";
  } else if (!(r.index_blk < index_blk.size() && index_blk[r.index_blk].period == r.period && r.block == 0 && r.offset == 0 && r.begin == 0 &&
               r.end == 0 && (r.kind != 'S' || bits == 1))) return "invalid inline record";
  return nullptr; }
inline const char* alias_total(uint64_t total) { return total <= MAX_ALIASES ? nullptr : "alias count limit"; }
inline const char* alias(uint64_t bits, uint64_t var_bits, int64_t left, int64_t right, uint64_t depth) {
  return bits == var_bits && uint64_t(std::llabs(left - right)) + 1 == bits && depth && depth <= MAX_DEPTH ? nullptr : "invalid alias declaration"; }
// bus blocks of one period are consecutive in the block list
template <class B> const char* bus_adjacency(const std::vector<B>& bus, uint64_t nt) {
  std::vector<uint64_t> last(nt, UINT64_MAX);
  for (uint64_t i = 0; i < bus.size(); i++) { auto p = bus[i].period; if (p >= nt) return "block period outside plan";
    if (last[p] != UINT64_MAX && i != last[p] + 1) return "nonadjacent period bus blocks"; last[p] = i; }
  return nullptr; }
// every bus record start (period, block * 65536 + offset) has an explicit window
inline const char* windows_present(const std::map<uint32_t, std::set<uint64_t>>& starts, const std::map<std::pair<uint32_t, uint64_t>, uint64_t>& ends) {
  for (auto& e : starts) for (auto s : e.second) if (!ends.count({e.first, s})) return "selected stream missing explicit window";
  return nullptr; }

}  // namespace fsdbplan
