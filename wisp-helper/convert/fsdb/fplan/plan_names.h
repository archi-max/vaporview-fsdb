// SPDX-License-Identifier: MIT
// plan_names.h: the declaration names of a plan as fixed-size tables (one string table, one scope trie, one slot per
// declaration), shared by the planner (Options::emit_names) and the in-place reader (sigread.h). No per-name heap object.
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <random>
#include <string>
#include <string_view>
#include <vector>

namespace plannames {

// Hash seeds: one random value per process (PLAN_NAMES_SEED=<decimal> fixes it, for tests), so a dump cannot choose names
// or a declaration layout whose keys collide in these tables and make an open quadratic. Table order is never output:
// the seed changes probe positions only, never a result.
inline uint64_t mix64(uint64_t x) { x ^= x >> 30; x *= 0xBF58476D1CE4E5B9ull; x ^= x >> 27; x *= 0x94D049BB133111EBull; return x ^ (x >> 31); }
inline uint64_t process_seed() {
  static const uint64_t s = [] {
    if (const char* e = getenv("PLAN_NAMES_SEED")) return mix64(std::strtoull(e, nullptr, 10) + 0x9E3779B97F4A7C15ull);
    std::random_device rd; uint64_t a = (uint64_t(rd()) << 32) ^ rd(); a ^= uint64_t(reinterpret_cast<uintptr_t>(&a)); return mix64(a); }();
  return s; }
// a seeded hash of a byte string (8-byte words through mix64; the seed enters first and with the length)
inline uint64_t hash_bytes(const char* p, size_t n, uint64_t seed) {
  uint64_t h = mix64(seed ^ (n * 0x9E3779B97F4A7C15ull));
  size_t i = 0; for (; i + 8 <= n; i += 8) { uint64_t w; memcpy(&w, p + i, 8); h = mix64(h ^ w); }
  uint64_t t = 0; if (i < n) { memcpy(&t, p + i, n - i); h = mix64(h ^ t ^ (uint64_t(n - i) << 56)); }
  return mix64(h ^ seed); }

struct Map64 {  // open addressing, uint64 key -> uint32 value; UINT64_MAX (the empty mark) is not a valid key
  std::vector<uint64_t> k; std::vector<uint32_t> v; size_t n = 0; bool found = false;
  uint64_t seed = process_seed(); size_t max_probe = 0;  // (max_probe: the longest probe run of an insert, for the tests)
  size_t mix(uint64_t x) const { return size_t(mix64(x ^ seed)); }
  void reserve(size_t want) { if (2 * want > k.size()) { size_t m = 1024; while (m < 2 * want) m *= 2; std::vector<uint64_t> ok; std::vector<uint32_t> ov; ok.swap(k); ov.swap(v);
    k.assign(m, UINT64_MAX); v.assign(m, 0); n = 0; for (size_t i = 0; i < ok.size(); i++) if (ok[i] != UINT64_MAX) find_or_add(ok[i], ov[i]); } }
  uint32_t* find_or_add(uint64_t key, uint32_t val) {
    if (k.empty() || 2 * (n + 1) > k.size()) grow();
    const size_t mask = k.size() - 1; size_t h = mix(key) & mask;
    size_t pr = 0; for (;; h = (h + 1) & mask, pr++) { if (k[h] == key) { found = true; return &v[h]; } if (k[h] == UINT64_MAX) break; }
    if (pr > max_probe) max_probe = pr;
    found = false; k[h] = key; v[h] = val; n++; return &v[h]; }
  bool has(uint64_t key) const { if (k.empty()) return false; const size_t mask = k.size() - 1; size_t h = mix(key) & mask;
    for (;; h = (h + 1) & mask) { if (k[h] == key) return true; if (k[h] == UINT64_MAX) return false; } }
  bool last_found() const { return found; }
  const uint32_t* get(uint64_t key) const { if (k.empty()) return nullptr; const size_t mask = k.size() - 1; size_t h = mix(key) & mask;
    for (;; h = (h + 1) & mask) { if (k[h] == key) return &v[h]; if (k[h] == UINT64_MAX) return nullptr; } }
  void grow() { std::vector<uint64_t> ok; std::vector<uint32_t> ov; ok.swap(k); ov.swap(v); const size_t m = std::max<size_t>(1024, ok.size() * 2);
    k.assign(m, UINT64_MAX); v.assign(m, 0); n = 0; for (size_t i = 0; i < ok.size(); i++) if (ok[i] != UINT64_MAX) find_or_add(ok[i], ov[i]); }
};
// Interned declaration names (sigread::File::open_lazy with compact names, the helper's direct open; filled by the
// planner with Options::emit_names, or from the plan's declaration heads). Every distinct scope
// component and leaf text is kept once (str), every scope path once (a trie: node 0 = the root), and every declaration
// is a slot (scope node, leaf string, declared range), in plan order: var k's slots are off[k] .. off[k + 1] - 1, the var
// first, then its aliases. Fixed-size tables only (tens of bytes per declaration): no per-name heap object.
struct Names {
  std::vector<std::string> str;
  std::vector<uint32_t> par, cs;          // trie node: parent node, component string
  std::vector<uint32_t> depth;            // trie node: components on its path
  std::vector<uint64_t> bytes;            // trie node: summed component bytes on its path
  std::vector<uint64_t> off;              // var k: first slot (size = vars + 1)
  std::vector<uint32_t> node, leaf;       // slot: scope node, leaf string
  std::vector<int64_t> left, right;       // slot: declared range
  std::vector<uint32_t> bits;             // slot: width
  uint64_t first_wide = UINT64_MAX;       // the first slot whose width or range the converter would not read (uint32 / int32)
  explicit Names(uint64_t seed = process_seed()) : seed_(seed) { ntab_.seed = keys_.seed = mix64(seed + 1); par.push_back(UINT32_MAX); cs.push_back(UINT32_MAX); depth.push_back(0); bytes.push_back(0); off.push_back(0); }
  uint32_t intern(const char* p, size_t n) {
    if (stab_.empty() || 2 * (str.size() + 1) > stab_.size()) grow_s();
    const size_t mask = stab_.size() - 1; size_t h = size_t(hash_bytes(p, n, seed_)) & mask, pr = 0;
    for (;; h = (h + 1) & mask, pr++) { const uint32_t k = stab_[h]; if (k == UINT32_MAX) break; if (str[k].size() == n && !memcmp(str[k].data(), p, n)) return k; }
    if (pr > max_probe_s) max_probe_s = pr;
    const uint32_t k = uint32_t(str.size()); str.emplace_back(p, n); stab_[h] = k; return k; }
  uint32_t intern(const std::string& x) { return intern(x.data(), x.size()); }
  uint32_t child(uint32_t parent, uint32_t c) {  // the trie node of path(parent) + str[c]
    const uint64_t key = (uint64_t(parent) << 32) | c; uint32_t* v = ntab_.find_or_add(key, uint32_t(par.size()));
    if (*v == par.size()) { par.push_back(parent); cs.push_back(c); depth.push_back(depth[parent] + 1); bytes.push_back(bytes[parent] + str[c].size()); }
    return *v; }
  uint32_t node_of(const std::vector<std::string>& sc) { uint32_t n = 0; for (auto& c : sc) n = child(n, intern(c)); return n; }
  // the full-name key of slot `slot` (false: the name is already a key); key_slot = the slot that added it (UINT32_MAX: none)
  void reserve_keys(size_t n) { keys_.reserve(n); }
  bool add_key(uint32_t n, uint32_t l, uint32_t slot) { keys_.find_or_add((uint64_t(n) << 32) | l, slot); return !keys_.last_found(); }
  uint32_t key_slot(uint32_t n, uint32_t l) const { const uint32_t* v = keys_.get((uint64_t(n) << 32) | l); return v ? *v : UINT32_MAX; }
  bool has_key(uint32_t n, uint32_t l) const { return keys_.has((uint64_t(n) << 32) | l); }
  std::vector<std::string> path(uint32_t n) const { std::vector<std::string> v; for (; n; n = par[n]) v.push_back(str[cs[n]]); std::reverse(v.begin(), v.end()); return v; }
  std::string full(uint64_t slot) const { std::string s; for (auto& c : path(node[slot])) { s += c; s += '.'; } return s + str[leaf[slot]]; }
  size_t slots() const { return node.size(); }
  size_t max_probe_s = 0;  // the longest probe run of a string insert (tests)
  size_t max_probe_maps() const { return std::max(ntab_.max_probe, keys_.max_probe); }
  void slot(uint32_t n, uint32_t l, int64_t lo, int64_t hi, uint32_t w) { node.push_back(n); leaf.push_back(l); left.push_back(lo); right.push_back(hi); bits.push_back(w); }
 private:
  void grow_s() { const size_t m = std::max<size_t>(1024, stab_.size() * 2); stab_.assign(m, UINT32_MAX); const size_t mask = m - 1;
    for (uint32_t k = 0; k < str.size(); k++) { size_t h = size_t(hash_bytes(str[k].data(), str[k].size(), seed_)) & mask; while (stab_[h] != UINT32_MAX) h = (h + 1) & mask; stab_[h] = k; } }
  std::vector<uint32_t> stab_; Map64 ntab_, keys_; uint64_t seed_;
};

}  // namespace plannames
