// SPDX-License-Identifier: MIT
// sigread: read one dump file's stored signals directly, without converting it (header-only; build with the planner
// fplan/fplan.cpp and -I fplan -I src). It uses the converter's own planner and value decoder, with the converter's rules:
//   - open() plans the file exactly as the converter does (port links and the full-scope declaration ON by default, as the
//     wrapper fsdb2wcz.sh; LinkOptions turns them off; no derived prefix, allow-partial) and decodes no value;
//   - a name the converter refuses is never readable here, with the converter's reason text: the planner's refusals at open,
//     and the per-stream rules (stream header check, late start) on first use of a stream (or for every stream: scan());
//   - only stored records are delivered; nothing is synthesised at the dump start or anywhere else.
// Bit (logic) signals: vars() + changes() (codes) or changes_planes() (the decoder's planes, as the converter stores them).
// Real and string signals: typed() + typed_changes(), decoded at open by the planner's typed path (the converter's
// rows). Event names stay refused, as in the converter.
//
// Values: changes() hands one code per bit, MSB first (declared left bit first), codes 0,1,2,3 = '0','1','x','z'
// (the same order and letters `wcz-dump values` prints for the converter's WCZ of the same file). Example: a 4-bit
// [3:0] value 4'b10xz is {1,0,2,3}. The raw decoder planes (value plane, then unknown plane, declared MSB at bit 0 of
// byte 0) are converted by codes_from_planes(); tests/test_sigread.sh checks the order against the converter's rows.
#pragma once
#include "fplan.h"
#include "fsdb_codecs.h"
#include "fsdb_values.h"
#include "fsdb_stream.h"
#include "fsdb_stream_check.h"
#include "fsdb_plan_check.h"
#include "plan_cap.h"
#include "plan_names.h"
#include <set>
#include <stdexcept>
#include <thread>
#include <atomic>
#include <tuple>
#include <algorithm>
#include <string_view>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <cstring>
#include <vector>

namespace sigread {

struct Alias { int64_t left = 0, right = 0; std::vector<std::string> scope; std::string name; };
// id -> var index (one table, no per-id node); at() throws std::out_of_range on an unknown id, as a map's at()
struct IdIndex {
  static constexpr size_t none = SIZE_MAX;
  void set(uint64_t id, size_t k) { if (id == UINT64_MAX) { max_ = k; return; } *m_.find_or_add(id, 0) = uint32_t(k); }
  size_t find(uint64_t id) const { if (id == UINT64_MAX) return max_; const uint32_t* v = m_.get(id); return v ? *v : none; }
  size_t at(uint64_t id) const { const size_t k = find(id); if (k == none) throw std::out_of_range("IdIndex::at"); return k; }
  void reserve(size_t n) { m_.reserve(n); }
  void clear() { m_ = plannames::Map64(); max_ = none; }
 private: plannames::Map64 m_; size_t max_ = none;
};
struct Var { uint64_t id = 0; uint32_t bits = 0; int64_t left = 0, right = 0; std::vector<std::string> scope; std::string name; std::vector<Alias> aliases; };
// A refused declaration. Planner refusals carry the planner's full declaration record (scope path components, leaf name,
// bits, declared range, value kind), in planner order, as the converter's --undeclared rows use them. A per-stream refusal
// found later (scan() / first use) carries the var's own declaration fields. stream = true for a per-stream refusal, also
// when it became a planner refusal through the converter_refusals re-plan.
struct Refusal { uint64_t id = 0; std::string full_name; std::string reason;
  std::vector<std::string> scope; std::string name; int64_t bits = 0, left = 0, right = 0;
  bool is_string = false; int nonbit = 0;  // nonbit: 1 real, 2 event (planner kinds)
  bool stream = false;
  uint32_t node = UINT32_MAX;  // compact open: the scope as a node of File::names() (scope then empty; UINT32_MAX = none / not compact)
};
// One stored record of a var's stream, as planned (read only; no decode). exact (bus record 'B'): begin/end = times of its
// first/last change. Inline records: begin = the period start, end = 0. count = changes in the record.
struct Record { uint64_t begin = 0, end = 0; uint64_t count = 0; char kind = 0; bool exact = false; };
// Typed::kind: 5 = real, value = 8 bytes, binary64 little endian (WCZ VT_REAL layout); 6 = string, value = the text bytes
struct Typed { int kind = 0; std::vector<std::pair<std::vector<std::string>, std::string>> names;  // (scope, leaf) of every declaration
  std::vector<std::pair<uint64_t, std::string>> rows; };

// one code per bit, MSB first, from the decoder's planes (len = 2 * ceil(bits/8): value plane, then unknown plane)
inline void codes_from_planes(const uint8_t* planes, size_t len, uint32_t bits, std::vector<uint8_t>& out) {
  const size_t bytes = (size_t(bits) + 7) / 8; out.resize(bits);
  if (len < 2 * bytes) { out.assign(bits, 2); return; }
  for (uint32_t j = 0; j < bits; j++) {
    const unsigned v = (planes[j / 8] >> (j % 8)) & 1u, u = (planes[bytes + j / 8] >> (j % 8)) & 1u;
    out[j] = uint8_t(u ? (v ? 3 : 2) : v);  // (v,u): (0,0) '0', (1,0) '1', (0,1) 'x', (1,1) 'z'
  }
}

namespace detail {
inline std::string unhex(const std::string& h) { std::string o; for (size_t i = 0; i + 1 < h.size(); i += 2) o.push_back(char(std::stoul(h.substr(i, 2), nullptr, 16))); return o; }
inline std::vector<std::string> words(const std::string& s) { std::vector<std::string> w; size_t a = 0; while (a < s.size()) { size_t b = s.find(' ', a); if (b == std::string::npos) b = s.size(); if (b > a) w.push_back(s.substr(a, b - a)); a = b + 1; } return w; }
// "bits left right nparts <scope hex...> <name hex>"
// the converter reads a head's width as a uint32 and its range as two int32 (run_plan_threaded: "invalid plan integer")
inline bool conv_ints(uint64_t bits, int64_t l, int64_t r) { return bits <= UINT32_MAX && l >= INT32_MIN && l <= INT32_MAX && r >= INT32_MIN && r <= INT32_MAX; }
// wide (optional): set when the width or range is outside what the converter reads (the width is then truncated here)
inline bool head(const std::string& h, uint32_t& bits, int64_t& l, int64_t& r, std::vector<std::string>& scope, std::string& name, bool* wide = nullptr) {
  auto w = words(h); if (w.size() < 5) return false; const unsigned long long b = std::stoull(w[0]); bits = uint32_t(b); l = std::stoll(w[1]); r = std::stoll(w[2]);
  if (wide) *wide = w[0][0] == '-' || !conv_ints(b, l, r);
  size_t n = std::stoul(w[3]); if (w.size() != 4 + n + 1) return false; scope.clear(); for (size_t i = 0; i < n; i++) scope.push_back(unhex(w[4 + i])); name = unhex(w.back()); return true; }
struct Stop {};
// planners without the unreferenced-ID list (older release lines) have none: the same header builds on both
template <class R> auto unref_of(const R& r, int) -> decltype(r.unref_ids, std::vector<uint64_t>()) { return r.unref_ids; }
template <class R> std::vector<uint64_t> unref_of(const R&, long) { return {}; }
}  // namespace detail

namespace detail {
// The converter's plan byte cap (run_plan_threaded's set_plan_limit, plan_cap.h): max(1 GiB, input size / 2,
// RUN_PLAN_BUDGET_MB in its range), or RUN_PLAN_MAX_PLAN_BYTES when set (a malformed value is refused with the
// converter's message). The same verdict and text as the converter for the same environment.
inline bool plan_bytes_ok(uint64_t text_bytes, uint64_t file_size, std::string& err, uint64_t& cap) {  // cap: also the name byte limit, as in the converter
  plancap::Src src = plancap::Src::DEFAULT; std::string e;
  cap = plancap::cap(file_size, getenv("RUN_PLAN_MAX_PLAN_BYTES"), "RUN_PLAN_MAX_PLAN_BYTES", getenv("RUN_PLAN_BUDGET_MB"), e, &src);
  if (!cap) { err = e; return false; }
  if (text_bytes > cap) { err = plancap::refusal("plan byte limit", 0, cap, src, "RUN_PLAN_MAX_PLAN_BYTES"); return false; }
  return true; }
}  // namespace detail

// The converter's plan consistency checks (src/fsdb_plan_check.h, the same functions run_plan_threaded applies to the
// plan it reads), in its order, over a plan built in process for a file of file_size bytes. false + err = the
// converter's message: the converter refuses the whole file on it, so open() does too. The plan byte cap is the
// converter's (detail::plan_bytes_ok: the default, RUN_PLAN_BUDGET_MB and RUN_PLAN_MAX_PLAN_BYTES as run_plan_threaded reads them).
inline bool check_plan_sets(const fplan::StructPlan& sp, uint64_t file_size, std::string& err);
// The same checks, verdicts and messages as check_plan_sets (the converter's order), with flat
// containers: hash sets for ids and names, a hash set + one sort for the windows, one sort of the bus-record starts.
// SIGREAD_PLAN_CHECK=sets runs the original form.
using plannames::Map64;
using plannames::Names;
namespace detail {
// A declaration head ("bits left right nparts <scope hex...> <name hex>") read into Names: the same fields head() gives,
// with the scope path as a trie node and the leaf as an interned string. A head of the plain form (decimal fields, every
// hex token of even length) is read in place; any other is read by head() itself, so its result or exception is head()'s.
// prev = the previous head's scope text and node (consecutive declarations mostly share their scope).
struct HeadCache { std::vector<std::string> tok; std::vector<uint32_t> node; };  // the previous head's scope tokens (hex) and the node after each
inline bool num_tok(const char* a, const char* b, bool sign, int64_t& out) {
  bool neg = false; if (sign && a < b && *a == '-') { neg = true; a++; } if (a == b || b - a > 18) return false;
  int64_t v = 0; for (; a < b; a++) { if (*a < '0' || *a > '9') return false; v = v * 10 + (*a - '0'); } out = neg ? -v : v; return true; }
inline int hexv(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
inline bool unhex_into(const char* a, const char* b, std::string& o) {
  if ((b - a) % 2) return false; o.clear();
  for (; a < b; a += 2) { const int x = hexv(a[0]), y = hexv(a[1]); if (x < 0 || y < 0) return false; o.push_back(char(x * 16 + y)); } return true; }
inline bool head_names(const std::string& h, Names& N, HeadCache& hc, uint32_t& bits, int64_t& l, int64_t& r, uint32_t& node, uint32_t& leaf, bool& wide) {
  wide = false;
  const char* p = h.data(); const char* e = p + h.size(); const char* t[4][2]; int nt = 0; const char* q = p;
  auto next = [&](const char*& a, const char*& b) { while (q < e && *q == ' ') q++; if (q == e) return false; a = q; while (q < e && *q != ' ') q++; b = q; return true; };
  bool plain = true; int64_t nb = 0, np = 0;
  for (; nt < 4 && plain; nt++) if (!next(t[nt][0], t[nt][1])) plain = false;
  if (plain) plain = num_tok(t[0][0], t[0][1], false, nb) && num_tok(t[1][0], t[1][1], true, l) && num_tok(t[2][0], t[2][1], true, r) && num_tok(t[3][0], t[3][1], false, np);
  if (plain) {  // the scope tokens, then exactly one leaf token
    while (q < e && *q == ' ') q++;
    const char* s0 = q; const char* last_a = nullptr; const char* last_b = nullptr; int64_t cnt = 0; const char* a; const char* b;
    while (next(a, b)) { cnt++; last_a = a; last_b = b; }
    if (cnt != np + 1) {  // head() refuses this count (false), unless its numbers would differ from these: then let it decide
      std::vector<std::string> sc; std::string nm; return head(h, bits, l, r, sc, nm, &wide) && ((node = N.node_of(sc)), (leaf = N.intern(nm)), true); }
    bits = uint32_t(nb); wide = !conv_ints(uint64_t(nb), l, r); std::string buf;
    {  // the scope tokens: the previous head's nodes while its tokens repeat, then one child step per new component
      uint32_t n = 0; size_t j = 0; q = s0; const char* end = last_a; bool same = true, good = true;
      while (q < end) {
        if (!next(a, b) || b > end) break;
        const std::string_view tk(a, size_t(b - a));
        if (same && j < hc.tok.size() && tk == hc.tok[j]) { n = hc.node[j]; j++; continue; }
        same = false; if (!unhex_into(a, b, buf)) { good = false; break; }
        n = N.child(n, N.intern(buf));
        if (j < hc.tok.size()) { hc.tok[j].assign(tk); hc.node[j] = n; } else { hc.tok.emplace_back(tk); hc.node.push_back(n); }
        j++;
      }
      if (!good) { hc.tok.clear(); hc.node.clear(); std::vector<std::string> sc; std::string nm; if (!head(h, bits, l, r, sc, nm, &wide)) return false; node = N.node_of(sc); leaf = N.intern(nm); return true; }
      hc.tok.resize(j); hc.node.resize(j); node = n;
    }
    if (!unhex_into(last_a, last_b, buf)) { std::vector<std::string> sc; std::string nm; if (!head(h, bits, l, r, sc, nm, &wide)) return false; node = N.node_of(sc); leaf = N.intern(nm); return true; }
    leaf = N.intern(buf); return true;
  }
  std::vector<std::string> sc; std::string nm; if (!head(h, bits, l, r, sc, nm, &wide)) return false; node = N.node_of(sc); leaf = N.intern(nm); return true;
}
}  // namespace detail

struct WinTab {  // the explicit stream windows, sorted by (period, start): built once by check_plan, looked up by decode
  struct W { uint32_t p; uint64_t s, e; bool operator<(const W& o) const { return p != o.p ? p < o.p : s < o.s; } };
  std::vector<W> v;
  const W* find(uint32_t p, uint64_t s) const { W k{p, s, 0}; auto it = std::lower_bound(v.begin(), v.end(), k); return it != v.end() && it->p == p && it->s == s ? &*it : nullptr; }
  void clear() { v.clear(); v.shrink_to_fit(); }
};
struct PairHash { size_t operator()(const std::pair<uint32_t, uint64_t>& k) const { return std::hash<uint64_t>()(k.second * 0x9E3779B97F4A7C15ull ^ k.first); } };
// names != nullptr (or SIGREAD_PLAN_CHECK=names, for the tests): the declarations are read into a Names table (each head
// once; the duplicate check on (scope node, leaf) keys) and the table is kept for the caller. Same checks, same order,
// same messages as without it.
inline bool check_plan(const fplan::StructPlan& sp, uint64_t file_size, std::string& err, WinTab* out = nullptr, Names* names_out = nullptr) {
  Names names_local; Names* NT = names_out;
  if (!NT) if (const char* e = getenv("SIGREAD_PLAN_CHECK")) if (!strcmp(e, "names")) NT = &names_local;
  if (const char* e = getenv("SIGREAD_PLAN_CHECK")) if (!strcmp(e, "sets")) {
    if (!check_plan_sets(sp, file_size, err)) return false;
    if (out) { out->v.clear(); for (auto& w : sp.windows) out->v.push_back({w.period, w.start, w.end}); std::sort(out->v.begin(), out->v.end()); }
    return true; }
  const char* m = nullptr; auto fail = [&](const char* x) { if (x) { err = x; return true; } return false; };
  uint64_t cap = 0; if (!detail::plan_bytes_ok(sp.text_bytes, file_size, err, cap)) return false;
  if (sp.size != file_size) { err = "source size changed"; return false; }
  const uint64_t nt = sp.periods.size();
  if (fail(fsdbplan::window_count(sp.windows.size())) || fail(fsdbplan::file_times(sp.scale, sp.tmin, sp.tmax)) ||
      fail(fsdbplan::counts(sp.bus.size(), sp.index_blk.size(), nt, sp.vars.size()))) return false;
  for (auto& b : sp.bus) if (fail(fsdbplan::block(b, nt, file_size))) return false;
  for (auto& b : sp.index_blk) if (fail(fsdbplan::block(b, nt, file_size))) return false;
  uint64_t deltas = 0; for (auto& p : sp.periods) { deltas += p.delta.size(); if (fail(fsdbplan::period(p, sp.tmin, sp.tmax, p.delta.size(), deltas))) return false; }
  if (fail(fsdbplan::file_bounds(sp.tmin, sp.tmax, sp.periods))) return false;  // (the converter's order: after the periods)
  // The window half runs on its own thread while this thread checks the declarations and
  // records. Verdict order is kept: the converter checks every window before any declaration, so a window verdict
  // wins over a declaration verdict; windows_present (last) needs both halves.
  WinTab tab; std::string werr; bool wok = true;
  std::thread wth([&] { wok = [&]() -> bool {
  auto wfail = [&](const char* x) { if (x) { werr = x; return true; } return false; };
  // windows, in the converter's order of verdicts: at index j it checks window(j), then "duplicate" if (period, start)
  // was seen before j. So: fw = the first failing window(); fd = the smallest j that repeats an earlier key; the
  // first of the two is the verdict. One sort of (period, start, j) gives both fd and the overlap order.
  const size_t NW = sp.windows.size(); size_t fw = NW;
  for (size_t j = 0; j < NW; j++) { auto& w = sp.windows[j]; if (fsdbplan::window(w.period, w.start, w.end, sp.bus, nt)) { fw = j; break; } }
  struct WI { uint32_t p; uint64_t s; uint64_t j; };
  std::vector<WI> wi(NW); for (size_t j = 0; j < NW; j++) wi[j] = {sp.windows[j].period, sp.windows[j].start, j};
  std::sort(wi.begin(), wi.end(), [](const WI& a, const WI& b) { return a.p != b.p ? a.p < b.p : a.s != b.s ? a.s < b.s : a.j < b.j; });
  size_t fd = NW; for (size_t k = 1; k < NW; k++) if (wi[k].p == wi[k - 1].p && wi[k].s == wi[k - 1].s && wi[k].j < fd) fd = wi[k].j;
  if (fd < fw) { werr = fsdbplan::duplicate_window(); return false; }
  if (fw < NW) { auto& w = sp.windows[fw]; wfail(fsdbplan::window(w.period, w.start, w.end, sp.bus, nt)); return false; }
  { uint32_t prior = UINT32_MAX; uint64_t prior_end = 0;  // fsdbplan::windows_overlap over the (period, start) order
    for (auto& e : wi) { if (e.p == prior && !(e.s >= prior_end)) { werr = "overlapping stream windows"; return false; } prior = e.p; prior_end = sp.windows[e.j].end; } }
  tab.v.resize(NW); for (size_t k = 0; k < NW; k++) tab.v[k] = {wi[k].p, wi[k].s, sp.windows[wi[k].j].end};
  { std::vector<WI>().swap(wi); }
  return true; }(); });
  std::vector<std::pair<uint32_t, uint64_t>> starts;
  const bool vok = NT ? [&]() -> bool {
  // the names: given by the planner (Options::emit_names: one slot per declaration, the heads not rendered) or read here
  // from the heads into the same table
  Names& N = *NT; const bool given = N.off.size() == sp.vars.size() + 1 && N.slots() == N.off.back();
  if (!given) N = Names();
  Map64 ids; ids.reserve(sp.vars.size()); bool idMax = false;  // (UINT64_MAX is Map64's empty mark: kept aside)
  auto freshId = [&](uint64_t id) { if (id == UINT64_MAX) { const bool f = !idMax; idMax = true; return f; } ids.find_or_add(id, 0); return !ids.last_found(); };
  N.reserve_keys(given ? N.slots() : sp.vars.size() * 2);
  uint64_t nr = 0, scopes = 0, aliases = 0, name_bytes = 0; detail::HeadCache hc;
  std::vector<const char*> bad(1, nullptr);  // per trie node: the first name_part verdict on its path (nullptr = none)
  auto parts = [&](uint32_t node, uint32_t leaf) {  // the per-component checks of the form below, from the node's path totals
    for (size_t x = bad.size(); x < N.par.size(); x++) bad.push_back(bad[N.par[x]] ? bad[N.par[x]] : fsdbplan::name_part(N.str[N.cs[x]].size()));
    const size_t nl = N.str[leaf].size();
    if (!bad[node] && name_bytes + N.bytes[node] <= cap) { name_bytes += N.bytes[node]; }
    else for (auto& c : N.path(node)) { if ((m = fsdbplan::name_part(c.size()))) return false; if ((name_bytes += c.size()) > cap) { m = "aggregate name byte limit"; return false; } }
    if ((m = fsdbplan::name_part(nl))) return false; if ((name_bytes += nl) > cap) { m = "aggregate name byte limit"; return false; }
    return true; };
  if (!given) N.off.reserve(sp.vars.size() + 1);
  for (size_t k = 0; k < sp.vars.size(); k++) {
    const auto& v = sp.vars[k];
    uint32_t bits = 0, node = 0, leaf = 0; int64_t l = 0, r = 0; uint64_t s0 = 0;
    bool wide = false;
    if (given) { s0 = N.off[k]; bits = N.bits[s0]; l = N.left[s0]; r = N.right[s0]; node = N.node[s0]; leaf = N.leaf[s0]; wide = s0 == N.first_wide; }
    else if (!detail::head_names(v.head, N, hc, bits, l, r, node, leaf, wide)) { err = "plan: bad declaration head"; return false; }
    if (wide) { err = "invalid plan integer"; return false; }  // (the converter's reading of this head)
    const bool fresh = v.id && freshId(v.id);
    if (fail(fsdbplan::variable(v.id, fresh, bits, l, r, N.depth[node])) || fail(fsdbplan::scope_total(scopes += N.depth[node]))) return false;
    if (!parts(node, leaf)) { err = m; return false; }
    if (!N.add_key(node, leaf, uint32_t(given ? s0 : N.slots()))) { err = fsdbplan::duplicate_declaration(); return false; }
    if (!given) N.slot(node, leaf, l, r, bits);
    nr += v.recs.size(); if (fail(fsdbplan::record_total(nr))) return false;
    for (auto& rc : v.recs) { if (fail(fsdbplan::record_kind(rc.kind)) || fail(fsdbplan::record(rc, bits, sp.bus, sp.index_blk, sp.periods))) return false;
      if (rc.kind == 'B') starts.emplace_back(rc.period, uint64_t(rc.block) * 65536 + rc.offset); }
    const uint64_t na = given ? N.off[k + 1] - s0 - 1 : v.aliases.size();
    if (fail(fsdbplan::alias_total(aliases += na))) return false;
    for (uint64_t q = 0; q < na; q++) {
      uint32_t ab = 0, an = 0, al_leaf = 0; int64_t al = 0, ar = 0;
      bool awide = false;
      if (given) { const uint64_t sq = s0 + 1 + q; ab = N.bits[sq]; al = N.left[sq]; ar = N.right[sq]; an = N.node[sq]; al_leaf = N.leaf[sq]; awide = sq == N.first_wide; }
      else if (!detail::head_names(v.aliases[q], N, hc, ab, al, ar, an, al_leaf, awide)) { err = "plan: bad alias head"; return false; }
      if (awide) { err = "invalid plan integer"; return false; }
      if (fail(fsdbplan::alias(ab, bits, al, ar, N.depth[an])) || fail(fsdbplan::scope_total(scopes += N.depth[an]))) return false;
      if (!parts(an, al_leaf)) { err = m; return false; }
      if (!N.add_key(an, al_leaf, uint32_t(given ? s0 + 1 + q : N.slots()))) { err = fsdbplan::duplicate_declaration(); return false; }
      if (!given) N.slot(an, al_leaf, al, ar, ab);
    }
    if (!given) N.off.push_back(N.slots());
  }
  return true; }() : [&]() -> bool {
  std::unordered_set<uint64_t> ids; ids.reserve(sp.vars.size() * 2);
  std::unordered_set<std::string> names; names.reserve(sp.vars.size() * 4);
  uint64_t nr = 0, scopes = 0, aliases = 0, name_bytes = 0;
  auto parts = [&](const std::vector<std::string>& sc, const std::string& nm) {
    for (auto& c : sc) { if ((m = fsdbplan::name_part(c.size()))) return false; if ((name_bytes += c.size()) > cap) { m = "aggregate name byte limit"; return false; } }
    if ((m = fsdbplan::name_part(nm.size()))) return false; if ((name_bytes += nm.size()) > cap) { m = "aggregate name byte limit"; return false; }
    return true; };
  auto key = [](const std::vector<std::string>& sc, const std::string& nm) {  // length-prefixed parts: equal iff the vectors are equal
    std::string k; for (auto& c : sc) { k += std::to_string(c.size()); k += ':'; k += c; } k += std::to_string(nm.size()); k += ':'; k += nm; return k; };
  for (auto& v : sp.vars) {
    uint32_t bits = 0; int64_t l = 0, r = 0; std::vector<std::string> sc; std::string nm;
    bool wide = false; if (!detail::head(v.head, bits, l, r, sc, nm, &wide)) { err = "plan: bad declaration head"; return false; }
    if (wide) { err = "invalid plan integer"; return false; }
    const bool fresh = v.id && ids.insert(v.id).second;
    if (fail(fsdbplan::variable(v.id, fresh, bits, l, r, sc.size())) || fail(fsdbplan::scope_total(scopes += sc.size()))) return false;
    if (!parts(sc, nm)) { err = m; return false; }
    if (!names.insert(key(sc, nm)).second) { err = fsdbplan::duplicate_declaration(); return false; }
    nr += v.recs.size(); if (fail(fsdbplan::record_total(nr))) return false;
    for (auto& rc : v.recs) { if (fail(fsdbplan::record_kind(rc.kind)) || fail(fsdbplan::record(rc, bits, sp.bus, sp.index_blk, sp.periods))) return false;
      if (rc.kind == 'B') starts.emplace_back(rc.period, uint64_t(rc.block) * 65536 + rc.offset); }
    if (fail(fsdbplan::alias_total(aliases += v.aliases.size()))) return false;
    for (auto& a : v.aliases) {
      uint32_t ab = 0; int64_t al = 0, ar = 0; std::vector<std::string> asc; std::string an;
      bool awide = false; if (!detail::head(a, ab, al, ar, asc, an, &awide)) { err = "plan: bad alias head"; return false; }
      if (awide) { err = "invalid plan integer"; return false; }
      if (fail(fsdbplan::alias(ab, bits, al, ar, asc.size())) || fail(fsdbplan::scope_total(scopes += asc.size()))) return false;
      if (!parts(asc, an)) { err = m; return false; }
      if (!names.insert(key(asc, an)).second) { err = fsdbplan::duplicate_declaration(); return false; }
    }
  }
  return true; }();
  wth.join();
  if (!wok) { err = werr; return false; }
  if (!vok) return false;
  if (fail(fsdbplan::bus_adjacency(sp.bus, nt))) return false;
  {  // fsdbplan::windows_present, the lookups split over threads (one message for any miss)
    const size_t T = std::min<size_t>(8, std::max<unsigned>(1, std::thread::hardware_concurrency())), N = starts.size(); std::atomic<bool> miss{false};
    std::vector<std::thread> th; for (size_t t = 0; t < T; t++) th.emplace_back([&, t] { for (size_t k = N * t / T; k < N * (t + 1) / T && !miss.load(std::memory_order_relaxed); k++) if (!tab.find(starts[k].first, starts[k].second)) miss = true; });
    for (auto& x : th) x.join();
    if (miss) { err = "selected stream missing explicit window"; return false; } }
  if (out) *out = std::move(tab);
  return true;
}
inline bool check_plan_sets(const fplan::StructPlan& sp, uint64_t file_size, std::string& err) {
  const char* m = nullptr; auto fail = [&](const char* x) { if (x) { err = x; return true; } return false; };
  uint64_t cap = 0; if (!detail::plan_bytes_ok(sp.text_bytes, file_size, err, cap)) return false;
  if (sp.size != file_size) { err = "source size changed"; return false; }
  const uint64_t nt = sp.periods.size();
  if (fail(fsdbplan::window_count(sp.windows.size())) || fail(fsdbplan::file_times(sp.scale, sp.tmin, sp.tmax)) ||
      fail(fsdbplan::counts(sp.bus.size(), sp.index_blk.size(), nt, sp.vars.size()))) return false;
  for (auto& b : sp.bus) if (fail(fsdbplan::block(b, nt, file_size))) return false;
  for (auto& b : sp.index_blk) if (fail(fsdbplan::block(b, nt, file_size))) return false;
  uint64_t deltas = 0; for (auto& p : sp.periods) { deltas += p.delta.size(); if (fail(fsdbplan::period(p, sp.tmin, sp.tmax, p.delta.size(), deltas))) return false; }
  if (fail(fsdbplan::file_bounds(sp.tmin, sp.tmax, sp.periods))) return false;
  std::map<std::pair<uint32_t, uint64_t>, uint64_t> ends;
  for (auto& w : sp.windows) { if (fail(fsdbplan::window(w.period, w.start, w.end, sp.bus, nt))) return false;
    if (!ends.emplace(std::make_pair(w.period, w.start), w.end).second) { err = fsdbplan::duplicate_window(); return false; } }
  if (fail(fsdbplan::windows_overlap(ends))) return false;
  std::set<uint64_t> ids; std::set<std::vector<std::string>> names; std::map<uint32_t, std::set<uint64_t>> starts;
  uint64_t nr = 0, scopes = 0, aliases = 0, name_bytes = 0;
  auto parts = [&](const std::vector<std::string>& sc, const std::string& nm) {
    for (auto& c : sc) { if ((m = fsdbplan::name_part(c.size()))) return false; if ((name_bytes += c.size()) > cap) { m = "aggregate name byte limit"; return false; } }
    if ((m = fsdbplan::name_part(nm.size()))) return false; if ((name_bytes += nm.size()) > cap) { m = "aggregate name byte limit"; return false; }
    return true; };
  for (auto& v : sp.vars) {
    uint32_t bits = 0; int64_t l = 0, r = 0; std::vector<std::string> sc; std::string nm;
    bool wide = false; if (!detail::head(v.head, bits, l, r, sc, nm, &wide)) { err = "plan: bad declaration head"; return false; }
    if (wide) { err = "invalid plan integer"; return false; }
    const bool fresh = v.id && ids.insert(v.id).second;
    if (fail(fsdbplan::variable(v.id, fresh, bits, l, r, sc.size())) || fail(fsdbplan::scope_total(scopes += sc.size()))) return false;
    if (!parts(sc, nm)) { err = m; return false; }
    { auto key = sc; key.push_back(nm); if (!names.insert(key).second) { err = fsdbplan::duplicate_declaration(); return false; } }
    nr += v.recs.size(); if (fail(fsdbplan::record_total(nr))) return false;
    for (auto& rc : v.recs) { if (fail(fsdbplan::record_kind(rc.kind)) || fail(fsdbplan::record(rc, bits, sp.bus, sp.index_blk, sp.periods))) return false;
      if (rc.kind == 'B') starts[rc.period].insert(uint64_t(rc.block) * 65536 + rc.offset); }
    if (fail(fsdbplan::alias_total(aliases += v.aliases.size()))) return false;
    for (auto& a : v.aliases) {
      uint32_t ab = 0; int64_t al = 0, ar = 0; std::vector<std::string> asc; std::string an;
      bool awide = false; if (!detail::head(a, ab, al, ar, asc, an, &awide)) { err = "plan: bad alias head"; return false; }
      if (awide) { err = "invalid plan integer"; return false; }
      if (fail(fsdbplan::alias(ab, bits, al, ar, asc.size())) || fail(fsdbplan::scope_total(scopes += asc.size()))) return false;
      if (!parts(asc, an)) { err = m; return false; }
      auto key = asc; key.push_back(an); if (!names.insert(key).second) { err = fsdbplan::duplicate_declaration(); return false; }
    }
  }
  if (fail(fsdbplan::bus_adjacency(sp.bus, nt)) || fail(fsdbplan::windows_present(starts, ends))) return false;
  return true;
}

// Port-link options for open(), the same switches as the wrapper's: FSDB2WCZ_PORT_LINKS (port_links),
// FSDB2WCZ_FULL_SCOPE (full_scope) and FSDB2WCZ_FORCE_LOG (force_log). The defaults are the wrapper's defaults (links ON
// with the full-scope declaration, no force log). full_scope and force_log apply only with port_links.
struct LinkOptions { bool port_links = true; bool full_scope = true; std::string force_log; };

class File {
 public:
  using Change = std::function<void(uint64_t t, const uint8_t* codes, uint32_t bits)>;
  using Planes = std::function<void(uint64_t t, const uint8_t* planes, size_t len)>;  // value plane, then unknown plane
  using TypedChange = std::function<void(uint64_t t, const std::string& value)>;
  File(const File&) = delete; File& operator=(const File&) = delete;
  ~File() { if (map_ && map_ != MAP_FAILED) munmap(map_, n_); }

  // cache_bytes: decoded-block cache shared by all threads of this File (0 = 64 MiB). nullptr + err on rejection.
  // converter_refusals = true: open as the converter's two attempts do. Plan, apply the per-stream rules to every stream
  // (scan()), and if any stream is refused, plan again with those streams excluded (Options::exclude_streams, id ->
  // reason, the converter's re-plan). vars() and refusals() then equal the converted file's declarations and refused rows,
  // in the same order, and every refusal is a planner refusal with its full record. Costs one scan at open.
  static std::unique_ptr<File> open(const std::string& path, std::string& err, size_t cache_bytes = 0, int threads = 0,
                                    bool converter_refusals = false, const LinkOptions& lo = {}) {
    std::unique_ptr<File> f(new File()); f->cap_ = cache_bytes ? cache_bytes : (size_t(64) << 20); f->threads_ = threads; f->lo_ = lo;
    int fd = ::open(path.c_str(), O_RDONLY); if (fd < 0) { err = "cannot open " + path; return nullptr; }
    struct stat st{}; if (fstat(fd, &st) || st.st_size <= 0) { ::close(fd); err = "cannot stat " + path; return nullptr; }
    f->n_ = size_t(st.st_size); f->map_ = mmap(nullptr, f->n_, PROT_READ, MAP_PRIVATE, fd, 0); ::close(fd);
    if (f->map_ == MAP_FAILED) { err = "cannot map " + path; return nullptr; }
    // the plan step reads the file front to back: readahead for it, then normal (random) access for block reads
    madvise(f->map_, f->n_, MADV_SEQUENTIAL); madvise(f->map_, f->n_, MADV_WILLNEED);
    if (!f->plan({}, err)) return nullptr;
    madvise(f->map_, f->n_, MADV_NORMAL);
    if (converter_refusals) {
      err.clear(); f->scan(err); if (!err.empty()) return nullptr;  // a damaged stream: no file
      std::map<uint64_t, std::string> ex; std::unordered_map<uint64_t, std::string> keep;
      { std::lock_guard<std::mutex> g(f->mu_); for (auto& kv : f->late_) { if (kv.second.empty()) keep.emplace(kv.first, ""); else ex.emplace(kv.first, kv.second); } }
      if (!ex.empty()) {
        if (!f->plan(ex, err)) return nullptr;
        std::lock_guard<std::mutex> g(f->mu_); f->late_.clear();
        for (auto& kv : keep) if (f->index_.find(kv.first) != IdIndex::none) f->late_.emplace(kv.first, "");  // streams already checked and accepted
      }
    }
    return f;
  }

  // The lazy open for in-place readers: the plan only (no whole-file CRC, no whole-file read-ahead), no
  // refusal scan. Per-stream rules apply on each stream's first use (record_planes / stream_refusal: "refused: <reason>",
  // the converter's text); file-level refusals the planner finds (header, index, dump-off, plan checks) still refuse at open.
  // compact = true: the declarations are kept as a Names table only (names()); vars() then carry id, bits and range with
  // empty scope, name and aliases, and the plan's declaration heads are released after the checks.
  static std::unique_ptr<File> open_lazy(const std::string& path, std::string& err, size_t cache_bytes = 0, int threads = 0,
                                         const LinkOptions& lo = {}, bool compact = false) {
    std::unique_ptr<File> f(new File()); f->cap_ = cache_bytes ? cache_bytes : (size_t(64) << 20); f->threads_ = threads; f->crc_ = false; f->lo_ = lo; f->compact_ = compact;
    int fd = ::open(path.c_str(), O_RDONLY); if (fd < 0) { err = "cannot open " + path; return nullptr; }
    struct stat st{}; if (fstat(fd, &st) || st.st_size <= 0) { ::close(fd); err = "cannot stat " + path; return nullptr; }
    f->n_ = size_t(st.st_size); f->map_ = mmap(nullptr, f->n_, PROT_READ, MAP_PRIVATE, fd, 0); ::close(fd);
    if (f->map_ == MAP_FAILED) { err = "cannot map " + path; return nullptr; }
    if (!f->plan({}, err)) return nullptr;
    return f;
  }

  // the converter's plan consistency checks on this file's plan (open() already ran them and refuses on failure)
  bool plan_check(std::string& err) const { return check_plan(sp_, n_, err); }
  const std::vector<Var>& vars() const { return vars_; }
  // empties the decoded-block cache (blocks decode again on their next use); -> the bytes it held
  size_t drop_cache() { std::lock_guard<std::mutex> g(mu_); const size_t b = cached_; cache_.clear(); cached_ = 0; return b; }
  // the compact open's name table (nullptr otherwise) and var k's full name in either form
  const Names* names() const { return compact_ ? &names_ : nullptr; }
  Names* names_mut() { return compact_ ? &names_ : nullptr; }  // (a reader may add its own paths and strings; the slots stay)
  std::string var_full(size_t k) const { return compact_ ? names_.full(names_.off[k]) : full(vars_[k]); }
  // value-carrying native IDs that no declaration references (+fsdbfile layout); the converter declares each one as
  // $unreferenced_value_ids.id_<ID> without values
  const std::vector<uint64_t>& unreferenced_ids() const { return unref_; }
  // the planned records of id's stream, in order (empty for an unknown or refused id). No decode, no per-stream check:
  // a stream refused on first use still lists its records here.
  std::vector<Record> records(uint64_t id) const {
    std::vector<Record> out; const size_t ix = index_.find(id); if (ix == IdIndex::none) return out;
    for (auto& r : sp_.vars[ix].recs) out.push_back({rec_begin(r), r.kind == 'B' ? r.end : 0, r.count, r.kind, r.kind == 'B'});
    return out; }
  // the same records appended to out (one table for many ids)
  void records_into(uint64_t id, std::vector<Record>& out) const {
    const size_t ix = index_.find(id); if (ix == IdIndex::none) return;
    for (auto& r : sp_.vars[ix].recs) out.push_back({rec_begin(r), r.kind == 'B' ? r.end : 0, r.count, r.kind, r.kind == 'B'}); }
  // every stored change of record k of id (records() order) with t <= upto, as planes (see changes_planes). Applies the
  // per-stream rules first: a refused id fails with "refused: <reason>".
  bool record_planes(uint64_t id, size_t k, uint64_t upto, const Planes& cb, std::string& err) {
    std::string why; if (!check(id, why, err)) return false; if (!why.empty()) { err = "refused: " + why; return false; }
    const size_t ix = index_.at(id); const auto& recs = sp_.vars[ix].recs; if (k >= recs.size()) { err = "record index out of range"; return false; }
    try { decode(vars_[ix], recs[k], [&](uint64_t t, const uint8_t* p, size_t len) { if (t > upto) throw detail::Stop{}; cb(t, p, len); }); }
    catch (const detail::Stop&) {} catch (const std::exception& e) { err = e.what(); return false; }
    return true; }
  // planner refusals (at open) + per-stream refusals found so far (first use, or scan())
  std::vector<Refusal> refusals() const {
    std::lock_guard<std::mutex> g(mu_); auto r = refused_; std::map<uint64_t, std::string> lt(late_.begin(), late_.end());
    for (auto& kv : lt) if (!kv.second.empty()) { const size_t k = index_.at(kv.first); const Var& v = vars_[k]; Refusal x; x.id = kv.first; x.full_name = var_full(k); x.reason = kv.second;
      if (compact_) { x.node = names_.node[names_.off[k]]; x.name = names_.str[names_.leaf[names_.off[k]]]; } else { x.scope = v.scope; x.name = v.name; }
      x.bits = v.bits; x.left = v.left; x.right = v.right; x.stream = true; r.push_back(std::move(x)); }
    return r; }
  const std::string& label() const { return label_; }
  const std::vector<Typed>& typed() const { return typed_; }
  // rows of typed()[k] with t in [t0, t1], preceded by the last row before t0 when there is no row at t0
  bool typed_changes(size_t k, uint64_t t0, uint64_t t1, const TypedChange& cb, std::string& err) const {
    if (k >= typed_.size()) { err = "typed index out of range"; return false; }
    const auto& r = typed_[k].rows; size_t a = 0; while (a < r.size() && r[a].first < t0) a++;
    if (a > 0 && (a == r.size() || r[a].first > t0)) cb(r[a - 1].first, r[a - 1].second);
    for (size_t i = a; i < r.size() && r[i].first <= t1; i++) cb(r[i].first, r[i].second);
    return true; }
  uint64_t tBegin() const { return sp_.tmin; }
  uint64_t tEnd() const { return sp_.tmax; }
  int timescaleExp() const { return sp_.scale; }

  // apply the per-stream rules to every stream now (the converter's refusal scan); returns the number refused
  // The converter's refusal scan order (run_plan_threaded, RUN_PLAN_REFUSALS path), on `threads` threads (0 = the open()
  // value, then the hardware count): (1) every bus record's stream header, in (bus block, var, record) order, each block
  // decompressed once per thread; a var's refusal = its refusing bus record with the lowest (block, record); (2) for
  // vars with none, the first refusing inline bus record in record order; (3) for vars with neither, late start (first
  // stored change after the dump start). Same rows, precedence and texts as the per-stream check (stream_refusal());
  // tests/test_sigread_api.sh SCANORDER compares the two. Streams already checked keep their result.
  // only != nullptr: the same scan over those ids only (the others are left as they are: checked on first use)
  size_t scan(std::string& err, int threads = 0, const std::unordered_set<uint64_t>* only = nullptr) {
    err.clear();
    const unsigned T = threads > 0 ? unsigned(threads) : threads_ > 0 ? unsigned(threads_) : std::max(1u, std::thread::hardware_concurrency());
    const size_t NV = vars_.size(); std::vector<char> done(NV, 0); std::vector<std::string> why(NV);
    { std::lock_guard<std::mutex> g(mu_); for (size_t k = 0; k < NV; k++) if (late_.count(vars_[k].id) || (only && !only->count(vars_[k].id))) done[k] = 1; }
    auto run = [&](size_t n, auto&& body) {  // body(t, lo, hi) on T threads over [0, n); first error wins (thread order)
      std::vector<std::string> terr(T); std::vector<std::thread> th; const unsigned U = unsigned(std::min<size_t>(T, std::max<size_t>(n, 1)));
      for (unsigned t = 0; t < U; t++) th.emplace_back([&, t] { try { body(t, n * t / U, n * (t + 1) / U); } catch (const std::exception& e) { terr[t] = e.what(); } });
      for (auto& x : th) x.join(); for (auto& e : terr) if (!e.empty()) { err = e; return false; } return true; };
    // (1) bus record headers, block-ordered
    struct Hit { uint32_t block, k, rec; uint32_t off; };
    std::vector<Hit> all;
    for (size_t k = 0; k < NV; k++) if (!done[k]) { const auto& rs = sp_.vars[k].recs; for (size_t j = 0; j < rs.size(); j++) if (rs[j].kind == 'B') all.push_back({rs[j].block, uint32_t(k), uint32_t(j), rs[j].offset}); }
    std::sort(all.begin(), all.end(), [](const Hit& a, const Hit& b) { return std::tie(a.block, a.k, a.rec) < std::tie(b.block, b.k, b.rec); });
    std::vector<std::map<uint32_t, std::tuple<uint32_t, uint32_t, std::string>>> part(T);
    if (!run(all.size(), [&](unsigned t, size_t lo, size_t hi) {
          uint32_t cur = UINT32_MAX; std::shared_ptr<const std::vector<uint8_t>> b;
          for (size_t i = lo; i < hi; i++) { const Hit& h = all[i]; if (part[t].count(h.k)) continue;
            if (h.block != cur) { b = raw_block(false, h.block); cur = h.block; }
            std::string w = fsdbraw::stream_header_refusal(*b, h.off, vars_[h.k].bits);
            if (!w.empty()) part[t].emplace(h.k, std::make_tuple(h.block, h.rec, std::move(w))); } })) return 0;
    std::map<uint32_t, std::tuple<uint32_t, uint32_t, std::string>> best;
    for (auto& pt : part) for (auto& e : pt) { auto it = best.find(e.first);
      if (it == best.end() || std::make_pair(std::get<0>(e.second), std::get<1>(e.second)) < std::make_pair(std::get<0>(it->second), std::get<1>(it->second))) best[e.first] = e.second; }
    for (auto& e : best) why[e.first] = std::get<2>(e.second);
    // (2) inline bus records for vars with no bus refusal, ordered like (1) by (index block, var, record) so each index
    // block is decompressed once per thread (no shared cache); a var's refusal = its refusing inline record with the lowest
    // record number, as in record order. A block that fails to decode counts at each of its records: it is reported only
    // when no refusing record of that var comes before it.
    std::vector<uint32_t> rest; for (size_t k = 0; k < NV; k++) if (!done[k] && !best.count(uint32_t(k))) rest.push_back(uint32_t(k));
    {
      std::vector<Hit> ih;
      for (auto k : rest) { const auto& rs = sp_.vars[k].recs; for (size_t j = 0; j < rs.size(); j++) if (rs[j].kind == 'I') ih.push_back({rs[j].index_blk, k, uint32_t(j), rs[j].vc}); }
      std::sort(ih.begin(), ih.end(), [](const Hit& a, const Hit& b) { return std::tie(a.block, a.k, a.rec) < std::tie(b.block, b.k, b.rec); });
      struct First { uint32_t rec; bool error; std::string text; };
      std::vector<std::map<uint32_t, First>> ip(T);
      if (!run(ih.size(), [&](unsigned t, size_t lo, size_t hi) {
            uint32_t cur = UINT32_MAX; std::shared_ptr<const std::vector<uint8_t>> b; std::string berr;
            for (size_t i = lo; i < hi; i++) { const Hit& h = ih[i]; auto it = ip[t].find(h.k); if (it != ip[t].end() && it->second.rec < h.rec) continue;
              if (h.block != cur) { cur = h.block; b.reset(); berr.clear(); try { b = raw_block(true, h.block); } catch (const std::exception& e) { berr = e.what(); } }
              if (!b) { ip[t][h.k] = {h.rec, true, berr}; continue; }
              std::string w = fsdbraw::stream_header_refusal(*b, h.off, vars_[h.k].bits);
              if (!w.empty()) ip[t][h.k] = {h.rec, false, std::move(w)}; } })) return 0;
      std::map<uint32_t, First> first;
      for (auto& pt : ip) for (auto& e : pt) { auto it = first.find(e.first); if (it == first.end() || e.second.rec < it->second.rec) first[e.first] = std::move(e.second); }
      for (auto& e : first) { if (e.second.error) { err = e.second.text; return 0; } why[e.first] = std::move(e.second.text); }
    }
    // (3) late start for vars with neither; ordered by the block of their first record so a thread reuses blocks
    std::vector<uint32_t> late; for (auto k : rest) if (why[k].empty() && !sp_.vars[k].recs.empty()) late.push_back(k);
    auto key = [&](uint32_t k) { const auto& r = sp_.vars[k].recs[0]; return std::make_tuple(r.kind == 'B' ? 0 : 1, r.kind == 'B' ? r.block : r.index_blk, k); };
    std::sort(late.begin(), late.end(), [&](uint32_t a, uint32_t b) { return key(a) < key(b); });
    if (!run(late.size(), [&](unsigned, size_t lo, size_t hi) {
          std::map<std::pair<bool, uint32_t>, std::shared_ptr<const std::vector<uint8_t>>> mine;  // this thread's blocks (small, recent)
          auto get = [&](bool idx, uint32_t i) { auto it = mine.find({idx, i}); if (it != mine.end()) return it->second;
            if (mine.size() >= 8) mine.erase(mine.begin()); auto d = raw_block(idx, i); mine.emplace(std::make_pair(idx, i), d); return d; };
          for (size_t i = lo; i < hi; i++) { const uint32_t k = late[i]; uint64_t first = UINT64_MAX;
            try { decode_with(get, vars_[k], sp_.vars[k].recs[0], [&](uint64_t t, const uint8_t*, size_t) { first = t; throw detail::Stop{}; }); } catch (const detail::Stop&) {}
            if (first != UINT64_MAX && first > sp_.tmin) why[k] = "stored history starts after the dump start (first stored change after the dump start)"; } })) return 0;
    size_t n = 0; std::lock_guard<std::mutex> g(mu_);
    for (size_t k = 0; k < NV; k++) if (!done[k]) { late_[vars_[k].id] = why[k]; if (!why[k].empty()) n++; }
    return n; }
  // the per-stream rules for one stream, as on its first use (one stream at a time); why = "" when accepted
  bool stream_refusal(uint64_t id, std::string& why, std::string& err) { return check(id, why, err); }

  // Every stored change of id with t in [t0, t1], preceded by the last stored change before t0 when there is no change at
  // t0. Whole records are decoded. false + err when the stream is refused (reason text) or the file is damaged.
  bool changes(uint64_t id, uint64_t t0, uint64_t t1, const Change& cb, std::string& err) {
    const size_t ix = index_.find(id); if (ix == IdIndex::none) { err = "unknown or refused id " + std::to_string(id); return false; }
    const uint32_t bits = vars_[ix].bits; std::vector<uint8_t> codes;
    return changes_planes(id, t0, t1, [&](uint64_t t, const uint8_t* p, size_t len) { codes_from_planes(p, len, bits, codes); cb(t, codes.data(), bits); }, err); }
  // the same rows as changes(), as the decoder's planes (2 * ceil(bits/8) bytes: value plane, then unknown plane; declared
  // MSB at bit 0 of byte 0). The pointer is valid only during the call.
  // checked = false: without the per-stream rules (the caller applies them later, e.g. scan() over the ids it read, and
  // drops the rows of a refused stream); each record is still decoded with the converter's checks.
  bool changes_planes(uint64_t id, uint64_t t0, uint64_t t1, const Planes& cb, std::string& err, bool checked = true) {
    if (checked) { std::string why; if (!check(id, why, err)) return false; if (!why.empty()) { err = "refused: " + why; return false; } }
    else if (index_.find(id) == IdIndex::none) { err = "unknown or refused id " + std::to_string(id); return false; }
    const Var& v = vars_[index_.at(id)]; const auto& recs = sp_.vars[index_.at(id)].recs;
    size_t k0 = 0; for (size_t k = 0; k < recs.size(); k++) if (rec_begin(recs[k]) <= t0) k0 = k;
    if (k0 > 0 && recs[k0].kind != 'B') k0--;  // an inline record knows only its period start: the change before t0 may be in the previous record
    bool have_prev = false, at_t0 = false; uint64_t tp = 0; std::vector<uint8_t> prev;
    try {
      for (size_t k = k0; k < recs.size(); k++) {
        if (rec_begin(recs[k]) > t1) break;
        decode(v, recs[k], [&](uint64_t t, const uint8_t* p, size_t len) {
          if (t < t0) { prev.assign(p, p + len); tp = t; have_prev = true; return; }
          if (t > t1) throw detail::Stop{};
          if (!at_t0) { at_t0 = true; if (t > t0 && have_prev) cb(tp, prev.data(), prev.size()); }
          cb(t, p, len); });
      }
    } catch (const detail::Stop&) {
    } catch (const std::exception& e) { err = e.what(); return false; }
    if (!at_t0 && have_prev) cb(tp, prev.data(), prev.size());
    return true;
  }

 private:
  File() = default;
  int threads_ = 0; bool crc_ = true; LinkOptions lo_; std::vector<uint64_t> unref_;
  // (re)plan with the converter's options; ex = streams to exclude (id -> reason), as the converter's second attempt
  bool plan(const std::map<uint64_t, std::string>& ex, std::string& err) {
    fplan::Options o; o.allow_partial = true; o.threads = threads_; o.emit_text = false; o.emit_struct = true; o.typed = true;  // the converter's settings
    o.port_links = lo_.port_links; o.full_scope = lo_.port_links && lo_.full_scope; if (lo_.port_links) o.force_log = lo_.force_log;  // the wrapper's link switches (fsdb2wcz.sh plarg)
    o.crc = crc_; o.index_willneed = !crc_;  // (the lazy open: no whole-file CRC; ask for the index blocks only)
    o.exclude_streams = ex;
    if (compact_) { o.emit_names = true; o.refusal_scope_ids = true; }  // the names as the planner's table; refusal scopes as its nodes
    fplan::Result res; if (!fplan::build((const uint8_t*)map_, n_, o, res, err)) return false;
    WinTab tab; Names& nt = res.names; if (!check_plan(res.sp, n_, err, &tab, compact_ ? &nt : nullptr)) return false;  // the converter refuses the whole file on these
    sp_ = std::move(res.sp); label_ = res.summary_json; unref_ = detail::unref_of(res, 0);
    refused_.clear(); vars_.clear(); index_.clear(); ends_.clear(); typed_.clear();
    { std::lock_guard<std::mutex> g(mu_); cache_.clear(); cached_ = 0; }
    for (auto& r : res.refusals) { Refusal x; x.id = r.ident; x.full_name = r.full_name; x.reason = r.reason; x.scope = r.scope; x.name = r.name; x.node = r.names_node;
      x.bits = r.bits; x.left = r.left; x.right = r.right; x.is_string = r.is_string; x.nonbit = r.nonbit; x.stream = r.excluded; refused_.push_back(std::move(x)); }
    if (compact_) {  // the names are in the table check_plan built: one fixed-size Var per var, the heads released
      names_ = std::move(nt); vars_.reserve(sp_.vars.size()); index_.reserve(sp_.vars.size());
      for (size_t k = 0; k < sp_.vars.size(); k++) {
        auto& pv = sp_.vars[k]; const uint64_t s0 = names_.off[k]; Var v; v.id = pv.id; v.bits = names_.bits[s0]; v.left = names_.left[s0]; v.right = names_.right[s0];
        index_.set(v.id, k); vars_.push_back(std::move(v)); std::string().swap(pv.head); std::vector<std::string>().swap(pv.aliases);
      }
    } else
    for (size_t k = 0; k < sp_.vars.size(); k++) {
      const auto& pv = sp_.vars[k]; Var v; v.id = pv.id;
      if (!detail::head(pv.head, v.bits, v.left, v.right, v.scope, v.name)) { err = "plan: bad declaration head"; return false; }
      for (auto& a : pv.aliases) { Alias x; uint32_t b = 0; if (!detail::head(a, b, x.left, x.right, x.scope, x.name)) { err = "plan: bad alias head"; return false; } v.aliases.push_back(std::move(x)); }
      index_.set(v.id, k); vars_.push_back(std::move(v));
    }
    ends_ = std::move(tab);  // (the sorted table check_plan built)
    const bool ok = parse_typed(res.typed, err);
    return ok;
  }
  void* map_ = nullptr; size_t n_ = 0, cap_ = 0, cached_ = 0; bool compact_ = false; Names names_;
  fplan::StructPlan sp_; std::string label_;
  std::vector<Var> vars_; IdIndex index_; std::vector<Refusal> refused_;  // index_: id -> vars_ index (a repeated id: the last var)
  WinTab ends_;
  mutable std::mutex mu_; std::map<std::pair<bool, uint32_t>, std::shared_ptr<const std::vector<uint8_t>>> cache_;
  std::unordered_map<uint64_t, std::string> late_;  // id -> "" (checked, accepted) or the refusal reason
  std::vector<Typed> typed_;
  // FSTYPED1: "V kind nd nr", nd x "D depth <scope hex...> <leaf hex>", nr x "r t <hex>" (real: 16 hex digits, big-endian
  // binary64; string: text hex or "-"); the side file adds "E"
  bool parse_typed(const std::string& tx, std::string& err) {
    if (tx.empty()) return true;
    std::vector<std::string> L; { size_t a = 0; while (a < tx.size()) { size_t b = tx.find('\n', a); if (b == std::string::npos) b = tx.size(); L.push_back(tx.substr(a, b - a)); a = b + 1; } }
    size_t i = 0; if (L.empty() || L[i++] != "FSTYPED1") { err = "typed: bad header"; return false; }
    try {
      while (i < L.size() && L[i] != "E") {
        auto f = detail::words(L[i++]); if (f.size() != 4 || f[0] != "V") { err = "typed: expected V line"; return false; }
        Typed T; T.kind = std::stoi(f[1]); size_t nd = std::stoul(f[2]), nr = std::stoul(f[3]);
        if ((T.kind != 5 && T.kind != 6) || i + nd + nr > L.size()) { err = "typed: bad V line"; return false; }
        for (size_t k = 0; k < nd; k++) { auto g = detail::words(L[i++]); if (g.size() < 4 || g[0] != "D") { err = "typed: expected D line"; return false; }
          size_t depth = std::stoul(g[1]); if (g.size() != depth + 3) { err = "typed: D line depth"; return false; }
          std::vector<std::string> sc; for (size_t c = 0; c < depth; c++) sc.push_back(detail::unhex(g[2 + c])); T.names.push_back({sc, detail::unhex(g[2 + depth])}); }
        for (size_t k = 0; k < nr; k++) { auto g = detail::words(L[i++]); if (g.size() != 3 || g[0] != "r") { err = "typed: expected r line"; return false; }
          std::string v = g[2] == "-" ? std::string() : detail::unhex(g[2]);
          if (T.kind == 5) { if (v.size() != 8) { err = "typed: real value width"; return false; } std::reverse(v.begin(), v.end()); }  // to little endian
          T.rows.push_back({std::stoull(g[1]), v}); }
        typed_.push_back(std::move(T));
      }
    } catch (const std::exception& e) { err = std::string("typed: ") + e.what(); return false; }
    // the planner's in-memory text has no "E" line (fplan_main adds it when writing the side file)
    return true; }

  static std::string full(const Var& v) { std::string s; for (auto& c : v.scope) { s += c; s += '.'; } return s + v.name; }
  uint64_t rec_begin(const fplan::PlanRec& r) const { return r.kind == 'B' ? r.begin : sp_.periods[r.period].begin; }
  // one block decompressed and checked, not cached (the scan's threads keep their own)
  std::shared_ptr<const std::vector<uint8_t>> raw_block(bool idx, uint32_t i) const {
    const auto& v = idx ? sp_.index_blk : sp_.bus; if (i >= v.size()) throw std::runtime_error("block index outside plan");
    const auto& b = v[i]; if (b.off < 4096 || !b.size || b.off + b.size > n_) throw std::runtime_error("invalid physical block");
    std::vector<uint8_t> raw = fsdbraw::decode_stages((const uint8_t*)map_ + b.off, b.size, idx ? std::vector<unsigned>{1, 1} : std::vector<unsigned>{2, 0}, true, 2 * 1024 * 1024);
    raw.shrink_to_fit();  // exactly its bytes: the cache counts size(), and the decoder's vector had spare capacity
    auto d = std::make_shared<const std::vector<uint8_t>>(std::move(raw));
    if (d->empty() || d->size() > 65536) throw std::runtime_error("decoded block length");
    return d; }
  std::shared_ptr<const std::vector<uint8_t>> block(bool idx, uint32_t i) {
    { std::lock_guard<std::mutex> g(mu_); auto it = cache_.find({idx, i}); if (it != cache_.end()) return it->second; }
    auto d = raw_block(idx, i);
    std::lock_guard<std::mutex> g(mu_);
    while (cached_ + d->size() > cap_ && !cache_.empty()) { cached_ -= cache_.begin()->second->size(); cache_.erase(cache_.begin()); }
    cached_ += d->size(); cache_.emplace(std::make_pair(idx, i), d); return d;
  }
  // one record, decoded and checked as the converter does (time range, order, counts)
  template <class Fn> void decode(const Var& v, const fplan::PlanRec& r, Fn&& fn) { decode_with([&](bool idx, uint32_t i) { return block(idx, i); }, v, r, fn); }
  // the same, with blocks from get(idx, i)
  template <class Get, class Fn> void decode_with(Get&& get, const Var& v, const fplan::PlanRec& r, Fn&& fn) {
    const auto& per = sp_.periods.at(r.period); bool have = false; uint64_t previous = 0;
    auto cbk = [&](uint64_t t, const uint8_t* p, size_t len) {
      if (!(t >= sp_.tmin && t <= sp_.tmax && t >= per.begin && t <= per.end && (!have || t >= previous))) throw std::runtime_error("value timestamp outside range");
      have = true; previous = t; fn(t, p, len); };
    fsdbraw::ValueStats st;
    if (r.kind == 'B') {
      uint64_t start = uint64_t(r.block) * 65536 + r.offset; const WinTab::W* e = ends_.find(r.period, start); if (!e) throw std::runtime_error("stream window missing from plan");
      fsdbraw::BlockStream s([&](uint32_t bi) { return get(false, bi); }, [&](uint32_t bi) { if (bi >= sp_.bus.size()) throw std::runtime_error("stream block outside plan"); return sp_.bus[bi].period; },
                             r.block, r.offset, uint32_t(e->e / 65536), size_t(e->e % 65536), r.period);
      st = fsdbraw::decode_values_reader(s, v.bits, per.delta, cbk, r.count, per.direct);
      if (st.count == r.count && !(st.first == r.begin && st.last == r.end)) throw std::runtime_error("native record range mismatch");
    } else {
      auto b = get(true, r.index_blk); if (r.vc >= b->size()) throw std::runtime_error("inline stream offset");
      st = fsdbraw::decode_values(b->data() + r.vc, b->size() - r.vc, v.bits, per.delta, cbk, r.count, per.direct);
    }
    if (st.count != r.count) throw std::runtime_error("native record count mismatch");
  }
  // per-stream rules of the converter: stream header check on bus/inline-bus records, then late start (first stored
  // change after the header's stored dump start). why = "" when accepted. false only on a damaged file (err).
  bool check(uint64_t id, std::string& why, std::string& err) {
    const size_t ix = index_.find(id); if (ix == IdIndex::none) { err = "unknown or refused id " + std::to_string(id); return false; }
    { std::lock_guard<std::mutex> g(mu_); auto it = late_.find(id); if (it != late_.end()) { why = it->second; return true; } }
    const Var& v = vars_[ix]; const auto& recs = sp_.vars[ix].recs; why.clear();
    try {
      // the converter's precedence: a refusing bus record ('B') wins, the one with the lowest (bus block, record index);
      // only with none, the first refusing inline bus record ('I') in record order
      bool have = false; std::pair<uint64_t, size_t> at{0, 0};
      for (size_t j = 0; j < recs.size(); j++) if (recs[j].kind == 'B') {
        std::string w = fsdbraw::stream_header_refusal(*block(false, recs[j].block), recs[j].offset, v.bits);
        if (!w.empty() && (!have || std::make_pair(uint64_t(recs[j].block), j) < at)) { have = true; at = {recs[j].block, j}; why = w; } }
      if (!have) for (auto& r : recs) if (r.kind == 'I') {
        std::string w = fsdbraw::stream_header_refusal(*block(true, r.index_blk), r.vc, v.bits);
        if (!w.empty()) { why = w; break; } }
      if (why.empty() && !recs.empty()) {
        uint64_t first = UINT64_MAX;
        try { decode(v, recs[0], [&](uint64_t t, const uint8_t*, size_t) { first = t; throw detail::Stop{}; }); } catch (const detail::Stop&) {}
        if (first != UINT64_MAX && first > sp_.tmin) why = "stored history starts after the dump start (first stored change after the dump start)";
      }
    } catch (const std::exception& e) { err = e.what(); return false; }
    std::lock_guard<std::mutex> g(mu_); late_[id] = why; return true;
  }
};

}  // namespace sigread
