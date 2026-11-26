// SPDX-License-Identifier: MIT
// scope_intern.h: interned scope paths, one id per (parent id, component).
// A scope's full name is never stored; full(id) builds it on demand. Components live in one char arena
// (8 bytes of offset + length per id, no allocation per scope); the id table is open addressing over uint32 ids.
// Ids are dense, assigned in insertion order; truncate(n) drops every id >= n (rollback).
#pragma once
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace scopeintern {

constexpr uint32_t ROOT = UINT32_MAX;  // parent of a top-level scope
constexpr uint32_t NONE = UINT32_MAX;  // find(): not present

class Tab {
 public:
  // id of (parent, comp); adds it when absent. parent is ROOT or an id already in the table.
  uint32_t get(uint32_t parent, std::string_view comp) {
    uint64_t h = hash(parent, comp);
    size_t s = probe(parent, comp, h);
    if (slot_[s] != EMPTY) return slot_[s];
    if (par_.size() >= UINT32_MAX - 1) throw std::length_error("scope intern: too many scopes");
    if (arena_.size() + comp.size() > UINT32_MAX) throw std::length_error("scope intern: component arena over 4 GiB");
    uint32_t id = uint32_t(par_.size());
    par_.push_back(parent); off_.push_back(uint32_t(arena_.size())); len_.push_back(uint32_t(comp.size()));
    arena_.append(comp.data(), comp.size());
    slot_[s] = id;
    if (++used_ * 4 > slot_.size() * 3) grow();
    return id;
  }
  // id of (parent, comp), or NONE.
  uint32_t find(uint32_t parent, std::string_view comp) const {
    if (slot_.empty()) return NONE;
    size_t s = probe(parent, comp, hash(parent, comp));
    return slot_[s] == EMPTY ? NONE : slot_[s];
  }
  size_t size() const { return par_.size(); }
  uint32_t parent(uint32_t id) const { return par_[id]; }
  std::string_view comp(uint32_t id) const { return std::string_view(arena_.data() + off_[id], len_[id]); }
  // components root first
  void components(uint32_t id, std::vector<std::string_view>& out) const {
    out.clear(); for (uint32_t a = id; a != ROOT; a = par_[a]) out.push_back(comp(a));
    for (size_t i = 0, j = out.size(); i + 1 < j; i++, j--) std::swap(out[i], out[j - 1]);
  }
  size_t depth(uint32_t id) const { size_t d = 0; for (uint32_t a = id; a != ROOT; a = par_[a]) d++; return d; }
  // full name, components joined by sep
  std::string full(uint32_t id, char sep = '.') const {
    size_t n = 0, k = 0; for (uint32_t a = id; a != ROOT; a = par_[a]) { n += len_[a]; k++; }
    std::string o(n + (k ? k - 1 : 0), sep); size_t e = o.size();
    for (uint32_t a = id; a != ROOT; a = par_[a]) { e -= len_[a]; std::memcpy(&o[e], arena_.data() + off_[a], len_[a]); if (e) e--; }
    return o;
  }
  // drop every id >= n
  void truncate(size_t n) {
    if (n >= par_.size()) return;
    for (size_t id = n; id < par_.size(); id++) erase_slot(uint32_t(id));
    arena_.resize(off_[n]); par_.resize(n); off_.resize(n); len_.resize(n);
  }
  size_t bytes() const { return arena_.capacity() + par_.capacity() * 4 + off_.capacity() * 4 + len_.capacity() * 4 + slot_.capacity() * 4; }

 private:
  static constexpr uint32_t EMPTY = UINT32_MAX;
  std::string arena_;
  std::vector<uint32_t> par_, off_, len_, slot_;
  size_t used_ = 0;
  static uint64_t hash(uint32_t parent, std::string_view c) {
    uint64_t h = 1469598103934665603ull ^ (uint64_t(parent) * 0x9e3779b97f4a7c15ull);
    for (unsigned char ch : c) { h ^= ch; h *= 1099511628211ull; }
    return h ^ (h >> 29);
  }
  bool eq(uint32_t id, uint32_t parent, std::string_view c) const {
    return par_[id] == parent && len_[id] == c.size() && std::memcmp(arena_.data() + off_[id], c.data(), c.size()) == 0;
  }
  size_t probe(uint32_t parent, std::string_view c, uint64_t h) const {
    size_t m = slot_.size() - 1, s = size_t(h) & m;
    while (slot_[s] != EMPTY && !eq(slot_[s], parent, c)) s = (s + 1) & m;
    return s;
  }
  size_t probe_id(uint32_t id) const { return probe(par_[id], comp(id), hash(par_[id], comp(id))); }
  void grow() {
    std::vector<uint32_t> old; old.swap(slot_); slot_.assign(old.empty() ? 64 : old.size() * 2, EMPTY);
    for (uint32_t id : old) if (id != EMPTY) slot_[probe_id(id)] = id;
  }
  void erase_slot(uint32_t id) {  // linear-probing delete with back-shift
    size_t m = slot_.size() - 1, s = probe_id(id);
    if (slot_[s] != id) return;
    slot_[s] = EMPTY; used_--;
    for (size_t j = (s + 1) & m; slot_[j] != EMPTY; j = (j + 1) & m) {
      uint32_t x = slot_[j]; slot_[j] = EMPTY; slot_[probe_id(x)] = x;
    }
  }
 public:
  Tab() { slot_.assign(64, EMPTY); }
};

}  // namespace scopeintern
