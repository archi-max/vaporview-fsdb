// SPDX-License-Identifier: MIT
// derive_eval.h (file-only route): the value graph (main values, handles, per-instance locals, template choice)
// and the evaluator of stored recipes on settled 4-state values. Same method and the same refusal texts as the
// reference evaluator it was ported from (checked against it by canon hash per name; not shipped). Values are strings MSB first over 0 1 x z; histories keep them
// packed (2 bits per bit, class Hist) and give them back as text.
#pragma once
#include <cctype>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <new>
#include "derive_parse.h"
#include "derive_pval.h"
#include <algorithm>
#include <functional>
#include <set>
#include <fstream>
#include <unordered_map>
#include <unordered_set>

namespace dblk {

struct Refuse : std::runtime_error { using std::runtime_error::runtime_error; };
using Val = std::string;
// A settled history: times with packed 4-state values. A value of width w takes two bit planes of (w + 7) / 8 bytes, the
// side file's own layout: text position p (MSB first) is bit p & 7 of byte p >> 3; the first plane holds 1 for '1' or 'z',
// the second plane 1 for 'x' or 'z'. That is 2 bits per value bit instead of one byte per bit, with no per-value header.
// All values of a history normally have one width; a history whose values differ in width keeps a width and an offset per
// value. Values are packed when stored and read back as text, so every operation on values sees the same text as before.
class Hist {
  struct Buf {   // a growable byte buffer on malloc / realloc (large buffers grow in place where the system allows)
    uint8_t *p = nullptr; size_t n = 0, cap = 0;
    Buf() = default; Buf(const Buf &o) { if (o.n) { reserve(o.n); memcpy(p, o.p, o.n); n = o.n; } }
    Buf(Buf &&o) noexcept : p(o.p), n(o.n), cap(o.cap) { o.p = nullptr; o.n = o.cap = 0; }
    Buf &operator=(Buf o) noexcept { std::swap(p, o.p); std::swap(n, o.n); std::swap(cap, o.cap); return *this; }
    ~Buf() { std::free(p); }
    void reserve(size_t c) { if (c <= cap) return; size_t g = std::max(c, cap + cap / 2 + 64); void *q = std::realloc(p, g); if (!q) throw std::bad_alloc(); p = (uint8_t *)q; cap = g; }
    uint8_t *grow(size_t k) { reserve(n + k); uint8_t *r = p + n; n += k; return r; }
    void shrink() { if (cap == n) return; if (!n) { std::free(p); p = nullptr; cap = 0; return; } void *q = std::realloc(p, n); if (q) { p = (uint8_t *)q; cap = n; } }
  };
  Buf t_, d_, w_, o_;   // times (uint64 each), planes; per-value widths (uint32) and offsets (uint64) only when widths differ
  size_t n_ = 0; uint32_t w0_ = 0; bool sorted_ = true, strict_ = true;   // times never decrease / always increase
  static size_t nb(size_t w) { return 2 * ((w + 7) / 8); }
  bool uni() const { return w_.n == 0; }
  size_t off(size_t i) const { if (uni()) return i * nb(w0_); uint64_t o; memcpy(&o, o_.p + 8 * i, 8); return (size_t)o; }
  void prepare(size_t w) {   // every allocation a new value of width w needs, made before anything changes (a failed one leaves the history as it was)
    d_.reserve(d_.n + nb(w)); t_.reserve(t_.n + 8);
    if (n_ && (!uni() || w != w0_)) { w_.reserve(4 * (n_ + 1)); o_.reserve(8 * (n_ + 1)); }
  }
  void place(uint64_t t, size_t w) {   // a new last value of width w at time t (its planes already written past the end of d_)
    if (n_ && t < time(n_ - 1)) sorted_ = false;
    if (n_ && t <= time(n_ - 1)) strict_ = false;
    if (!n_) { w_.n = o_.n = 0; w0_ = (uint32_t)w; }
    else if (uni() && w != w0_) { const size_t s = nb(w0_); for (size_t i = 0; i < n_; i++) { uint32_t x = w0_; uint64_t o = i * s; memcpy(w_.grow(4), &x, 4); memcpy(o_.grow(8), &o, 8); } }
    if (!uni()) { uint32_t x = (uint32_t)w; uint64_t o = d_.n; memcpy(w_.grow(4), &x, 4); memcpy(o_.grow(8), &o, 8); }
    memcpy(t_.grow(8), &t, 8); n_++;
  }
public:
  static uint64_t rowBytes(size_t w) { return 8 + nb(w); }   // one row of width w as stored (time + both planes)
  static void pack(const Val &v, uint8_t *p) {   // p: nb(v.size()) bytes
    const size_t w = v.size(), pl = (w + 7) / 8; memset(p, 0, 2 * pl);
    for (size_t q = 0; q < w; q++) {
      const char c = v[q]; const uint8_t m = (uint8_t)(1u << (q & 7));
      if (c == '1' || c == 'z') p[q >> 3] |= m;
      if (c == 'x' || c == 'z') p[pl + (q >> 3)] |= m; else if (c != '0' && c != '1') throw Refuse("value not 0 1 x z (a real or string variable)");
    }
  }
  static void checkText(const Val &v) { std::vector<uint8_t> b(2 * ((v.size() + 7) / 8)); pack(v, b.data()); }   // the text refusal of a value not 0 1 x z
  size_t size() const { return n_; }
  bool empty() const { return n_ == 0; }
  bool sorted() const { return sorted_; }
  bool strictlyIncreasing() const { return strict_; }
  bool allOfWidth(size_t w) const { return uni() && (n_ == 0 || w0_ == w); }
  uint64_t time(size_t i) const { uint64_t t; memcpy(&t, t_.p + 8 * i, 8); return t; }
  size_t width(size_t i) const { if (uni()) return w0_; uint32_t w; memcpy(&w, w_.p + 4 * i, 4); return w; }
  const uint8_t *planes(size_t i) const { return d_.p + off(i); }
  void get(size_t i, Val &v) const {
    const size_t w = width(i), pl = (w + 7) / 8; const uint8_t *p = planes(i); v.resize(w);
    for (size_t q = 0; q < w; q++) { const int a = (p[q >> 3] >> (q & 7)) & 1, b = (p[pl + (q >> 3)] >> (q & 7)) & 1; v[q] = b ? (a ? 'z' : 'x') : (a ? '1' : '0'); }
  }
  Val val(size_t i) const { Val v; get(i, v); return v; }
  // the packed value (class PV, derive_pval.h) of row i, and a new last row from one: the same planes as the text path
  void getP(size_t i, PV &v) const { pvFromPlanes(v, width(i), planes(i)); }
  void pushP(uint64_t t, const PV &v) { const size_t w = v.width(); prepare(w); pvToPlanes(v, d_.p + d_.n); place(t, w); d_.n += nb(w); }
  // a new last row of width w from planes in this layout (pb == nullptr: no x/z plane); bits past w in the last byte are cleared
  void pushPlanes(uint64_t t, size_t w, const uint8_t *pa, const uint8_t *pb) { prepare(w); putPlanes(d_.p + d_.n, w, pa, pb); place(t, w); d_.n += nb(w); }
  // replace the last row by one given as planes (as setLast)
  void setLastPlanes(size_t w, const uint8_t *pa, const uint8_t *pb) {
    const uint64_t t = time(n_ - 1); prepare(w); uint8_t *tail = d_.p + d_.n; putPlanes(tail, w, pa, pb);
    popLast(); memmove(d_.p + d_.n, tail, nb(w)); place(t, w); d_.n += nb(w);
  }
  static void putPlanes(uint8_t *d, size_t w, const uint8_t *pa, const uint8_t *pb) {
    const size_t pl = (w + 7) / 8; if (!pl) return; memcpy(d, pa, pl); if (pb) memcpy(d + pl, pb, pl); else memset(d + pl, 0, pl);
    if (w & 7) { const uint8_t m = (uint8_t)((1u << (w & 7)) - 1); d[pl - 1] &= m; d[2 * pl - 1] &= m; }
  }
  // row j of o at time t (its planes copied)
  void pushAt(uint64_t t, const Hist &o, size_t j) { const size_t w = o.width(j); prepare(w); memcpy(d_.p + d_.n, o.planes(j), nb(w)); place(t, w); d_.n += nb(w); }
  bool same(size_t i, const Hist &o, size_t j) const { const size_t w = width(i); return w == o.width(j) && memcmp(planes(i), o.planes(j), nb(w)) == 0; }
  void push(uint64_t t, const Val &v) { const size_t w = v.size(); prepare(w); pack(v, d_.p + d_.n); place(t, w); d_.n += nb(w); }
  void push(const Hist &o, size_t j) { const size_t w = o.width(j); prepare(w); memcpy(d_.p + d_.n, o.planes(j), nb(w)); place(o.time(j), w); d_.n += nb(w); }
  void prepend(uint64_t t, const Val &v) {   // a new first value (in place when it has the width of the others; else rebuilt)
    if (!n_ || !uni() || v.size() != w0_) { Hist c; c.push(t, v); c.append(*this); swap(c); return; }
    const size_t k = nb(w0_); d_.reserve(d_.n + k); t_.reserve(t_.n + 8);
    memmove(d_.p + k, d_.p, d_.n); pack(v, d_.p); d_.n += k; memmove(t_.p + 8, t_.p, t_.n); memcpy(t_.p, &t, 8); t_.n += 8; n_++;
    if (n_ > 1 && time(1) < t) sorted_ = false;
    if (n_ > 1 && time(1) <= t) strict_ = false;
  }
  void append(const Hist &o) { if (&o == this) { Hist c(o); append(c); return; } for (size_t j = 0; j < o.size(); j++) push(o, j); }
  void popLast() { const size_t i = n_ - 1; d_.n = off(i); t_.n -= 8; if (!uni()) { w_.n -= 4; o_.n -= 8; } n_--; if (!n_) { w_.n = o_.n = 0; sorted_ = strict_ = true; } }
  void setLast(const Val &v) {   // replace the last value: everything that can fail (memory, a value not 0 1 x z) happens before the pop
    const uint64_t t = time(n_ - 1); const size_t w = v.size(); prepare(w); uint8_t *tail = d_.p + d_.n; pack(v, tail);
    popLast(); memmove(d_.p + d_.n, tail, nb(w)); place(t, w); d_.n += nb(w);
  }
  uint64_t bytes() const { return sizeof(Hist) + t_.cap + d_.cap + w_.cap + o_.cap; }
  void shrink() { t_.shrink(); d_.shrink(); w_.shrink(); o_.shrink(); }   // gives back the growth reserve of a finished history
  void swap(Hist &o) noexcept { std::swap(t_, o.t_); std::swap(d_, o.d_); std::swap(w_, o.w_); std::swap(o_, o.o_); std::swap(n_, o.n_); std::swap(w0_, o.w0_); std::swap(sorted_, o.sorted_); std::swap(strict_, o.strict_); }
};
using Words = std::set<std::string>;
struct NodeId { uint64_t x, v; bool operator<(const NodeId &o) const { return x != o.x ? x < o.x : v < o.v; } bool operator==(const NodeId &o) const { return x == o.x && v == o.v; } };
struct NodeHash { size_t operator()(const NodeId &n) const { return std::hash<uint64_t>()(n.x * 1000003u ^ n.v); } };
static inline std::string nstr(const NodeId &n) { return "(" + std::to_string(n.x) + ", " + std::to_string(n.v) + ")"; }

// ---- 4-state bit ops (zip semantics: the shorter operand bounds the result)
inline Val X(size_t w) { return Val(w, 'x'); }
inline Val fit(const Val &v, size_t w) { return v.size() >= w ? v.substr(v.size() - w) : Val(w - v.size(), '0') + v; }
inline bool known(const Val &v) { for (char c : v) if (c != '0' && c != '1') return false; return true; }
inline Val b_not(const Val &a) { Val r(a.size(), 'x'); for (size_t i = 0; i < a.size(); i++) r[i] = a[i] == '0' ? '1' : a[i] == '1' ? '0' : 'x'; return r; }
inline Val b_and(const Val &a, const Val &b) { size_t n = std::min(a.size(), b.size()); Val r(n, 'x'); for (size_t i = 0; i < n; i++) r[i] = (a[i] == '0' || b[i] == '0') ? '0' : (a[i] == '1' && b[i] == '1') ? '1' : 'x'; return r; }
inline Val b_or(const Val &a, const Val &b) { size_t n = std::min(a.size(), b.size()); Val r(n, 'x'); for (size_t i = 0; i < n; i++) r[i] = (a[i] == '1' || b[i] == '1') ? '1' : (a[i] == '0' && b[i] == '0') ? '0' : 'x'; return r; }
inline Val b_xor(const Val &a, const Val &b) { size_t n = std::min(a.size(), b.size()); Val r(n, 'x'); for (size_t i = 0; i < n; i++) { bool ka = a[i] == '0' || a[i] == '1', kb = b[i] == '0' || b[i] == '1'; r[i] = (ka && kb) ? (a[i] != b[i] ? '1' : '0') : 'x'; } return r; }
inline Val b_xnor(const Val &a, const Val &b) { return b_not(b_xor(a, b)); }
inline Val l_eq(const Val &a, const Val &b) {
  size_t n = std::min(a.size(), b.size());
  for (size_t i = 0; i < n; i++) if ((a[i] == '0' || a[i] == '1') && (b[i] == '0' || b[i] == '1') && a[i] != b[i]) return "0";
  return known(a) && known(b) ? "1" : "x";
}
inline Val c_eq(const Val &a, const Val &b) { return a == b ? "1" : "0"; }
inline char truth(const Val &v) { bool all0 = true; for (char c : v) { if (c == '1') return '1'; if (c != '0') all0 = false; } return all0 ? '0' : 'x'; }
inline Val cond(const Val &c, const Val &a, const Val &b) {
  char t = truth(c); if (t == '1') return a; if (t == '0') return b;
  size_t n = std::min(a.size(), b.size()); Val r(n, 'x'); for (size_t i = 0; i < n; i++) if (a[i] == b[i] && (a[i] == '0' || a[i] == '1')) r[i] = a[i]; return r;
}
inline Val red_xor(const Val &v) { if (!known(v)) return "x"; size_t k = 0; for (char c : v) k += c == '1'; return (k & 1) ? "1" : "0"; }
inline Val inv1(const Val &r) { return r == "0" ? "1" : r == "1" ? "0" : "x"; }
inline Val resolve(const std::vector<const Val *> &vs, int kind) {
  size_t n = SIZE_MAX; for (auto *p : vs) n = std::min(n, p->size()); if (vs.empty()) n = 0; Val out(n, 'x');
  for (size_t i = 0; i < n; i++) {
    bool h0 = false, h1 = false, hx = false, any = false;
    for (auto *p : vs) { char c = (*p)[i]; if (c == 'z') continue; any = true; if (c == '0') h0 = true; else if (c == '1') h1 = true; else hx = true; }
    if (!any) { out[i] = 'z'; continue; }
    if (kind == 1) { out[i] = h0 ? '0' : (h1 && !hx) ? '1' : 'x'; continue; }
    if (kind == 2) { out[i] = h1 ? '1' : (h0 && !hx) ? '0' : 'x'; continue; }
    int nk = (int)h0 + (int)h1 + (int)hx; out[i] = nk == 1 ? (h0 ? '0' : h1 ? '1' : 'x') : 'x';
  }
  return out;
}
// bit j of a two's complement integer (sign-extended beyond 63)
inline int bitof(long long c, size_t j) { return j < 63 ? (int)((c >> j) & 1) : (c < 0); }
inline Val bits_of(long long c, size_t W) { Val r(W, '0'); for (size_t j = 0; j < W; j++) if (bitof(c, j)) r[W - 1 - j] = '1'; return r; }
// unsigned value of a known bit string, saturated (any 1 at or above bit 62 -> SAT)
static const uint64_t SAT = uint64_t(1) << 62;
inline uint64_t uval(const Val &v) { uint64_t r = 0; size_t n = v.size(); for (size_t i = 0; i < n; i++) if (v[i] == '1') { size_t j = n - 1 - i; if (j >= 62) return SAT; r |= uint64_t(1) << j; } return r; }
inline int ucmp(const Val &a, const Val &b) {   // unsigned compare of known bit strings of any length
  size_t i = a.find('1'), j = b.find('1'); size_t la = i == Val::npos ? 0 : a.size() - i, lb = j == Val::npos ? 0 : b.size() - j;
  if (la != lb) return la < lb ? -1 : 1; if (!la) return 0; int c = a.compare(i, la, b, j, lb); return c < 0 ? -1 : c > 0;
}
inline int scmp(const Val &a, const Val &b) {   // signed (two's complement, each at its own width)
  bool na = !a.empty() && a[0] == '1', nb = !b.empty() && b[0] == '1'; if (na != nb) return na ? -1 : 1;
  size_t n = std::max(a.size(), b.size()); char fa = na ? '1' : '0';
  Val A = Val(n - a.size(), fa) + a, B = Val(n - b.size(), fa) + b; int c = A.compare(B); return c < 0 ? -1 : c > 0;
}
inline Val addw(const Val &a, const Val &b, size_t W, bool sub) {   // (a + b) or (a - b) mod 2^W
  Val A = fit(a, W), B = fit(b, W); if (sub) { for (auto &c : B) c = c == '1' ? '0' : '1'; }
  Val r(W, '0'); int carry = sub ? 1 : 0;
  for (size_t k = 0; k < W; k++) { size_t i = W - 1 - k; int s = (A[i] == '1') + (B[i] == '1') + carry; r[i] = (s & 1) ? '1' : '0'; carry = s >> 1; }
  return r;
}

// ---- the decoded file plus the names of the stored values (planner id list)
struct FileData {
  Block B; std::vector<NodeP> codes; std::vector<std::string> codeErr; std::vector<Prog> progs; std::vector<bool> progOk;
  std::map<uint64_t, std::pair<uint64_t, uint64_t>> h2loc; std::map<std::pair<uint64_t, uint64_t>, std::pair<uint64_t, uint64_t>> ext;
  std::set<uint64_t> hdup; std::set<std::pair<uint64_t, uint64_t>> xdup;   // --tuples-end: keys listed more than once (no tuple read for them)
  size_t tuplesBad = 0;   // --tuples-end: keys on an instance with no stored-table entry (then no tuple is read)
  std::vector<uint64_t> idOrder; std::unordered_map<uint64_t, std::vector<std::string>> idn; std::unordered_map<uint64_t, int64_t> idw;
  std::map<std::pair<uint64_t, uint64_t>, std::vector<uint64_t>> st_at;
  std::unordered_map<uint64_t, std::vector<const Rec *>> byd;
};

inline std::string strip_name(std::string n) {
  std::string o; for (char c : n) if (c != '\\' && c != ' ') o += c;
  static const std::regex RG("\\[-?[0-9]+:-?[0-9]+\\]$"); return std::regex_replace(o, RG, "");
}

// the planner id list (FSIDS1 rows: fplan --ids, or the same text in memory)
inline void load(FileData &F, std::istream &in) {
  for (auto &t : F.B.T) {
    try { F.codes.push_back(parse_code(t.body)); F.codeErr.push_back(""); } catch (const ParseError &e) { F.codes.push_back(nullptr); F.codeErr.push_back(e.what()); }
  }
  for (auto &b : F.B.B) { try { F.progs.push_back(parse_block(b.body)); F.progOk.push_back(true); } catch (const ParseError &) { F.progs.emplace_back(); F.progOk.push_back(false); } }
  auto &tu = F.B.tuples;
  if (!tuples_end) { for (auto &q : tu) { if (q[0] == 0) F.h2loc[q[1]] = {q[2], q[3]}; else F.ext[{q[0], q[1]}] = {q[2], q[3]}; } }
  else {   // a key listed twice is not read at all (refused by name where it is needed), whatever its targets
    for (auto &q : tu) {
      std::pair<uint64_t, uint64_t> t{q[2], q[3]};
      if (q[0] == 0) { if (F.hdup.count(q[1]) || !F.h2loc.emplace(q[1], t).second) F.hdup.insert(q[1]); }
      else { std::pair<uint64_t, uint64_t> k{q[0], q[1]}; if (F.xdup.count(k) || !F.ext.emplace(k, t).second) F.xdup.insert(k); } }
    for (auto v : F.hdup) F.h2loc.erase(v);
    for (auto &k : F.xdup) F.ext.erase(k);
    // the table must agree with the stored tables: every instance a key names has a stored-table entry. One that does not
    // means the table was not read right (for example out of phase): no tuple is read at all (all refused by name).
    std::set<uint64_t> xs; for (auto &t : F.B.t0) xs.insert(t.x); for (auto &t : F.B.t1) xs.insert(t.x);
    for (auto &q : tu) if (q[0] != 0 && !xs.count(q[0])) F.tuplesBad++;
    if (F.tuplesBad) { F.h2loc.clear(); F.ext.clear(); }
  }
  std::string l;
  while (std::getline(in, l)) {
    if (l.empty() || l[0] == '#') continue;
    std::vector<std::string> c; { std::string cur; for (char ch : l) { if (ch == '\t') { c.push_back(cur); cur.clear(); } else cur += ch; } c.push_back(cur); }
    if (c.size() < 8) continue;
    uint64_t k = std::stoull(c[1]); if (!F.idn.count(k)) F.idOrder.push_back(k);
    F.idn[k].push_back(c[7]); if (!F.idw.count(k)) F.idw[k] = std::stoll(c[4]);
  }
  for (auto &t : F.B.t1) F.st_at[{t.x, t.v}].push_back(t.k);
  for (auto &r : F.B.recs) F.byd[r.dst].push_back(&r);
}
inline void load(FileData &F, const std::string &idsPath) { std::ifstream in(idsPath); load(F, in); }

struct Graph {
  const FileData &F; std::map<uint64_t, const Tpl *> x2t; std::map<uint64_t, std::string> xwhy; std::map<uint64_t, std::string> xsel;
  std::map<const Tpl *, std::unordered_map<uint64_t, std::vector<const Rec *>>> tbyd;
  bool red_template = false;
  // No-index recipe rule (opt-in, --noindex-recipe): a node listed in the stored table ONLY for one ID that has no value
  // index of its own (the converter carries no stream for it) is defined by its destination record(s), as any other node.
  // A node whose stored-table owner is a different ID, or several IDs, keeps the stored definition (unchanged).
  const std::unordered_set<uint64_t> *noIndex = nullptr;
  // Third-table rule (opt-in, --third-table): a node with no record whose ONLY third-table ID has the node's width is read
  // as that ID's stored history (the ID must be carried; refused by name otherwise). Several IDs or a width difference: refused.
  std::map<std::pair<uint64_t, uint64_t>, std::vector<uint64_t>> t2at; bool useT2 = false;
  std::unordered_map<uint64_t, int64_t> carrierW;   // --carriers: widths of internal carrier IDs (not-listed items), never names
  std::unordered_set<uint64_t> redWidthShift;        // planted (test builds): declared width + 1 for these IDs
  int64_t idWidth(uint64_t k) const {   // declared width of an ID: the name list, else the carrier list; -1 unknown
    auto w = F.idw.find(k); int64_t iw = w != F.idw.end() ? w->second : -1;
    if (w == F.idw.end()) { auto c = carrierW.find(k); if (c != carrierW.end()) iw = c->second; }
    return redWidthShift.count(k) && iw >= 0 ? iw + 1 : iw; }
  bool refuseTpl = false;   // --refuse-template-locals: every instance-local node (template picked by capacity) is refused, and so is every name that depends on one
  bool red_noindex_any = false, red_t2_first = false, red_t2_anywidth = false;   // planted errors (test builds only)
  explicit Graph(const FileData &f, bool redTemplate = false) : F(f), red_template(redTemplate) {
    std::map<uint64_t, std::set<uint64_t>> locs; std::map<uint64_t, std::map<uint64_t, int64_t>> xw;
    auto scan = [&](const std::vector<Trip> &tt) { for (auto &t : tt) if (t.x) { locs[t.x].insert(t.v); auto it = F.idw.find(t.k); if (it != F.idw.end()) xw[t.x][t.v] = it->second; } };
    scan(F.B.t0); scan(F.B.t1);
    for (auto &h : F.h2loc) locs[h.second.first].insert(h.second.second);
    for (auto &e : locs) {
      uint64_t x = e.first, m = *e.second.rbegin(); std::vector<const Tpl *> cands;
      for (auto &t : F.B.tpl) if ((uint64_t)t.N + t.K > m) cands.push_back(&t);
      std::stable_sort(cands.begin(), cands.end(), [](const Tpl *a, const Tpl *b) { return a->N < b->N; });
      if (cands.size() > 1) {
        std::vector<const Tpl *> ok; auto dw = xw.find(x);
        if (dw != xw.end() && !dw->second.empty())
          for (auto *t : cands) { bool all = true; for (auto &vw : dw->second) if (!(vw.first >= t->N || (int64_t)t->W[vw.first] == vw.second)) { all = false; break; } if (all) ok.push_back(t); }
        xwhy[x] = "by capacity " + std::to_string(cands.size()) + " candidates, by local widths " + std::to_string(ok.size());
        x2t[x] = ok.size() == 1 ? ok[0] : nullptr; if (ok.size() == 1) xsel[x] = "TEMPLATE_BY_WIDTH";
        if (ok.size() == 1 && red_template) for (auto *t : cands) if (t != ok[0]) { x2t[x] = t; break; }   // planted: the other candidate
        continue;
      }
      // one candidate by capacity: it must also agree with every known local width, as when there are several; else no template
      if (cands.size() == 1) { auto dw = xw.find(x); bool all = true;
        if (dw != xw.end()) for (auto &vw : dw->second) if (!(vw.first >= cands[0]->N || (int64_t)cands[0]->W[vw.first] == vw.second)) { all = false; break; }
        if (!all) { xwhy[x] = "by capacity 1 candidates, by local widths 0"; x2t[x] = nullptr; continue; } }
      x2t[x] = cands.empty() ? nullptr : cands[0];
    }
    for (auto &t : F.B.tpl) { auto &d = tbyd[&t]; for (auto &r : t.recs) d[r.dst].push_back(&r); }
  }
  const Tpl *tplOf(uint64_t x) const { auto it = x2t.find(x); return it == x2t.end() ? nullptr : it->second; }
  int64_t width(const NodeId &n) const {
    if (n.x == 0) return n.v < F.B.NV ? (int64_t)F.B.W[n.v] : -1;
    auto *t = tplOf(n.x); return t && n.v < t->N ? (int64_t)t->W[n.v] : -1;
  }
  int typebyte(const NodeId &n) const {
    if (n.x == 0) return n.v < F.B.NV ? F.B.types[n.v] : -1;
    auto *t = tplOf(n.x); return t && n.v < t->N ? t->types[n.v] : -1;
  }
  struct Def { enum K { STORED, RECS, ALIAS, NONE } k; std::vector<uint64_t> ids; std::vector<const Rec *> recs; NodeId alias{0, 0}; std::string why; };
  Def define(const NodeId &n) const {
    Def d; auto st = F.st_at.find({n.x, n.v});
    if (st != F.st_at.end() && !st->second.empty()) {
      bool self = noIndex && (red_noindex_any || (st->second.size() == 1 && noIndex->count(st->second[0])));
      if (!self) { d.k = Def::STORED; d.ids = st->second; return d; }
      Def r = defineRecs(n);
      if (r.k == Def::RECS) { r.why = "NOINDEX_RECIPE"; return r; }
      d.k = Def::NONE; d.why = "no-index stored node without a recipe (" + r.why + ")"; return d;
    }
    return defineRecs(n);
  }
  Def defineRecs(const NodeId &n) const {
    Def d;
    if (n.x == 0) {
      if (n.v >= F.B.NV) { auto h = F.h2loc.find(n.v); if (h != F.h2loc.end()) { d.k = Def::ALIAS; d.alias = {h->second.first, h->second.second}; } else { d.k = Def::NONE; d.why = !F.B.tuples_why.empty() ? "tuple table not located: " + F.B.tuples_why : F.tuplesBad ? "tuple table not consistent with the stored tables" : F.hdup.count(n.v) ? "handle tuple key not unique" : "handle without tuple"; } return d; }
      auto r = F.byd.find(n.v); if (r != F.byd.end() && !r->second.empty()) { d.k = Def::RECS; d.recs = r->second; } else if (!third(n, d)) { d.k = Def::NONE; d.why = "no record"; } return d;
    }
    if (refuseTpl) { d.k = Def::NONE; d.why = "template choice not unique (template binding not proven: instance-local node)"; return d; }
    auto *t = tplOf(n.x);
    if (!t) { d.k = Def::NONE; auto w = xwhy.find(n.x); d.why = w != xwhy.end() ? "template choice not unique (" + w->second + ")" : "no template for instance"; return d; }
    if (n.v >= t->N) { auto e = F.ext.find({n.x, n.v}); if (e != F.ext.end()) { d.k = Def::ALIAS; d.alias = {e->second.first, e->second.second}; } else { d.k = Def::NONE; d.why = !F.B.tuples_why.empty() ? "tuple table not located: " + F.B.tuples_why : F.tuplesBad ? "tuple table not consistent with the stored tables" : F.xdup.count({n.x, n.v}) ? "external local tuple key not unique" : "external local without tuple"; } return d; }
    auto &bd = tbyd.at(t); auto r = bd.find(n.v); if (r != bd.end() && !r->second.empty()) { d.k = Def::RECS; d.recs = r->second; } else if (!third(n, d)) { d.k = Def::NONE; d.why = "no local record"; } return d;
  }
  bool third(const NodeId &n, Def &d) const {
    if (!useT2) return false; auto q = t2at.find({n.x, n.v}); if (q == t2at.end()) return false;
    if (q->second.size() != 1 && !red_t2_first) { d.k = Def::NONE; d.why = "third table: " + std::to_string(q->second.size()) + " ids at the node"; return true; }
    int64_t iw = idWidth(q->second[0]);
    if (!red_t2_anywidth && iw != width(n)) { d.k = Def::NONE; d.why = "third table: width differs from the node"; return true; }
    d.k = Def::STORED; d.ids = {q->second[0]}; d.why = "THIRD_TABLE"; return true; }
  std::vector<NodeId> args_of(uint64_t x, const Rec &r) const {
    std::vector<NodeId> o; for (size_t i = (r.key.k == 'B' ? 1 : 0); i < r.args.size(); i++) o.push_back({x, r.args[i]}); return o;
  }
};

// stored histories: name -> settled history, or nullptr when the name is not carried
using StoredFn = std::function<std::shared_ptr<const Hist>(const std::string &)>;

// Leaf source: where the evaluator's stored (leaf) histories come from. The converted stored-only file (WczStored,
// wcz_stored.h) is one source; a reader serving a requested window is another. Every source gives the same thing for a
// name: its settled history, or nullptr when the name is not carried. dropCache frees the source's own cache between
// top-level names (the evaluator's memory bound); cacheBytes is what that cache holds now.
struct LeafSource {
  virtual ~LeafSource() = default;
  virtual std::shared_ptr<const Hist> hist(const std::string &name) = 0;
  virtual void dropCache() {}
  virtual uint64_t cachedBytes() const { return 0; }
};
inline StoredFn storedFn(LeafSource &s) { return [&s](const std::string &n) { return s.hist(n); }; }

// candidate meanings and planted errors (test-only); defaults = the proven meanings
struct Sem {
  bool q3_invert = true, ub9_xor = true, concat_pos = true;   // proven meanings (Q3 = invert, b9 = reduction XOR, concat literal-first)
  bool strict = false;
  bool admit81 = false, admit94 = false;
  bool zops = false;                                          // opt-in --z-ops: a z input is evaluated by the ops' 4-state rules (z into logic -> x);
                                                              // a name whose result still holds a z (z through a copy, select or ?:) stays refused
  bool admit_newneg = false;                                  // negative offsets from NEWLY readable entries (corrected cut): refused unless opted in
                                                              // (not proven: refused by default; --admit-newneg)
  bool admit_negoff = true;                                   // part-select range offset < 0: admitted = our own reading (by-name corpus evidence, M8);
                                                              // --refuse-negoff = strict run; admission rules for 0x81/0x94 are opt-in (--admit 81,94; not proven: refused by default)
  bool pwrite_cw = false;                                     // producer: explicit destination width for part-write values (last one set wins); refusals: nonzero block constants, z reaching an instruction
#ifdef WCZ_DERIVE_TEST_REDS                                   // planted errors by name: test builds only (fixtures, corpus reds)
  std::map<std::string, int> red;
  int r(const char *k) const { auto it = red.find(k); return it == red.end() ? 0 : it->second; }
  int rop(const std::string &op) const { return r(("RED_" + op).c_str()); }   // the planted error named after an instruction word
#else                                                         // shipped build: no planted error can be switched on
  static constexpr int r(const char *) { return 0; }
  static constexpr int rop(const std::string &) { return 0; }
#endif
};

struct Eval {
  const FileData &F; const Graph &G; StoredFn stored; Sem sem; const Words *allow = nullptr;
  struct Memo { bool ok; std::shared_ptr<const Hist> h; std::string why; };
  std::unordered_map<NodeId, Memo, NodeHash> memo; std::unordered_map<NodeId, Words, NodeHash> used;
  // force taint (--outside-writes=forcelog:<log>): the word "FORCED:<target>" starts at a computed node whose value id the force
  // log lists (its computed value cannot show the force) and, with --strict-forced, also at a stored value the log lists; it
  // travels up through used[] like any rule word, so every name computed from it carries it. Never an allow word.
  const std::unordered_map<uint64_t, std::string> *forcedStored = nullptr;   // value id -> target text (--strict-forced only)
  std::unordered_map<NodeId, std::string, NodeHash> forcedNode;               // computed node of a listed value id -> target text
  int64_t cw = -1; Words ctxw; uint64_t memoBytes = 0;
  // per-history memory cap (bytes; 0 = none): a history whose rows would pass it is refused by name while it is being built,
  // before the memory is taken. Counted per history (the packed row size, Hist::rowBytes, as histBytes), so the same names are refused
  // whatever the worker count or cache budget.
  uint64_t histCap = 0;
  std::string capWhy() const { return "history over the per-history memory cap (" + (histCap % (1u << 20) ? std::to_string(histCap >> 10) + " KiB" : std::to_string(histCap >> 20) + " MiB") + ", --max-history-mb)"; }
  struct RowCap { const Eval &e; uint64_t b = 0; void add(size_t w) { b += Hist::rowBytes(w); if (e.histCap && b > e.histCap) throw Refuse(e.capWhy()); } };
  static uint64_t histBytes(const Hist &h) { return h.bytes(); }
  // between top-level names only (no reference into the memo is held then): drop every computed history
  void dropMemo() { memo.clear(); memoBytes = 0; }
  Eval(const FileData &f, const Graph &g, StoredFn s, Sem m = Sem()) : F(f), G(g), stored(std::move(s)), sem(std::move(m)) {}

  // Part-write target (review): the ONLY admitted forms are bsel(a0, #k) and psel(a0, #m, #o): base = operand slot 0 read
  // as the destination value itself (it is never evaluated), index / range = pool constants. Anything else is refused by name:
  // another base, a nested base, or a dynamic (non-constant) selector. Planted: PW_BASE_ANY accepts any base, PW_DYN_ZERO reads a
  // dynamic index as bit 0 (both must change the fixture result; tests/test_fixtures.cpp).
  std::vector<int64_t> pw_target(const Node *sel) const {
    std::vector<int64_t> bits; int off = sem.r("PWRITE_OFF");
    if (!(sel->kind == Node::BSEL || sel->kind == Node::PSEL)) throw Refuse("part write target is not a bit or part select");
    const Node *base = sel->kids[0].get();
    if (!(base->kind == Node::ARG && base->v == 0) && !sem.r("PW_BASE_ANY")) throw Refuse("part write target base is not the destination slot a0");
    auto idx = [&](const Node *k, CK ck) -> long long {
      if (k->kind == Node::CONST) return pool_c(k->v, ck);
      if (sem.r("PW_DYN_ZERO")) return 0;
      throw Refuse("part write target has a dynamic selector (not established)");
    };
    if (sel->kind == Node::BSEL) bits.push_back(idx(sel->kids[1].get(), C_IDX) + off);
    else {
      if (sel->kids[1]->kind != Node::CONST || sel->kids[2]->kind != Node::CONST) { if (!sem.r("PW_DYN_ZERO")) throw Refuse("part write target has a dynamic selector (not established)"); bits.push_back(off); return bits; }
      auto r = psel_range(*sel->kids[1], *sel->kids[2], -1);   // destination width checked by the caller (exact cover + range)
      for (int64_t b = r.first + off; b >= r.second + off; b--) bits.push_back(b);
    }
    return bits;
  }
  // Constant contract (new cut). A first-table entry has two planes: unknown (must be 0) and value,
  // plus a width from the section's width table. IDX = a selector index: width 32, unknown plane 0, value >= 0. SIGNED = the
  // range offset of a part select (our proven psel reading; may be negative): width 32, unknown plane 0. VAL = a concatenated
  // constant: unknown plane 0 and the table width must equal the width the context gives. Refused: absent entry (sentinel),
  // an alternate-table entry (storage / strength class, never an integer; width 1 alone admits nothing), any nonzero unknown
  // plane, a width other than the one the use needs. Wider constants are not read through these paths (their planes are kept
  // whole; no rule uses them yet). With no width table (planted old cut, POOL_OLD_CUT) the earlier reading applies.
  enum CK { C_IDX, C_SIGNED, C_VAL };
  long long pool_c(uint32_t k, CK kind, long long wantW = 32) const {
    if (F.B.poolWidth.empty()) return pool_int(k);
    auto it = F.B.pool.find(k); if (it == F.B.pool.end()) throw Refuse("constant " + std::to_string(k) + " not in pool");
    std::string K = "constant " + std::to_string(k);
    if (F.B.poolAlt.count(k)) throw Refuse(K + " is an alternate-table entry (not an integer)");
    if (it->second.size() != 8) throw Refuse(K + " is not a one-word two-plane entry (planes kept whole; no rule reads it)");
    if (u32(it->second.data()) != 0) throw Refuse(K + " has a nonzero unknown plane");
    auto w = F.B.poolWidth.find(k); if (w == F.B.poolWidth.end()) throw Refuse(K + " has no width");
    long long need = kind == C_VAL ? wantW : 32;
    if ((long long)w->second != need) throw Refuse(K + " width " + std::to_string(w->second) + " vs " + std::to_string(need) + " needed");
    long long v = i32(it->second.data() + 4);   // value plane
    if (kind == C_IDX && v < 0) throw Refuse(K + " is negative on the index path");
    if (kind == C_SIGNED && v < 0) {
      if (!sem.admit_negoff) throw Refuse(K + " is a negative range offset (strict run: no contract yet)");
      if (F.B.poolNew.count(k) && !sem.admit_newneg) throw Refuse(K + " is a negative range offset newly readable by the corrected cut (not proven)");
      if (sem.r("RED_NEGOFF_UNSIGNED")) v = (long long)u32(it->second.data() + 4);   // planted: the same word read unsigned
    }
    return v;
  }
  // Part-select range (signed endpoint-delta contract): b = first constant (a bit coordinate, index path),
  // d = second constant (signed 32-bit endpoint delta). d < 0: bits b .. b+d (low b+d, width 1-d); d >= 0: bits b+d .. b (low b,
  // width d+1). Guards (64-bit arithmetic, no wrap): d != INT32_MIN; low >= 0; every bit < the container width cw (the selected
  // operand, or the destination of a part write); cw < 0 = not known here (checked by the caller). Planted: RED_PSEL_WRONG
  // reads (b, d) as low b, width 1-d (a wrong select); RED_NEGOFF_UNSIGNED (in pool_c) reads d unsigned.
  std::pair<long long, long long> psel_range(const Node &bn, const Node &dn, long long cw) const {
    if (bn.kind != Node::CONST || dn.kind != Node::CONST) throw Refuse("variable part select");
    long long b = pool_c(bn.v, C_IDX), d = pool_c(dn.v, C_SIGNED);
    if (d == (long long)INT32_MIN) throw Refuse("part select range delta INT32_MIN");
    long long hi = d < 0 ? b : b + d, lo = d < 0 ? b + d : b;
    if (sem.r("RED_PSEL_WRONG") && d < 0) { lo = b; hi = b - d; }
    if (lo < 0) throw Refuse("part select range below bit 0");
    if (cw >= 0 && hi >= cw) throw Refuse("part select range outside its container (" + std::to_string(hi) + " vs width " + std::to_string(cw) + ")");
    return {hi, lo};
  }
  long long pool_int(uint32_t k) const {   // earlier reading (planted old cut / no width table only)
    auto it = F.B.pool.find(k); if (it == F.B.pool.end()) throw Refuse("constant " + std::to_string(k) + " not in pool");
    int32_t lo = i32(it->second.data());
    if (it->second.size() == 8 && u32(it->second.data() + 4) != 0) throw Refuse("constant " + std::to_string(k) + " has nonzero upper word");
    return lo;
  }
  const Hist &hist(const NodeId &n) {
    auto it = memo.find(n);
    if (it != memo.end()) { if (!it->second.ok) throw Refuse(it->second.why); return *it->second.h; }
    // a re-entered node is a logic loop; the text names no node, so the refusal list does not depend on which node of the
    // loop was entered first (thread count, work order and memory budget change that order)
    memo[n] = {false, nullptr, "cycle: a logic loop in the derivation records"};
    try { auto h = hist_(n); { auto fn = forcedNode.find(n); if (fn != forcedNode.end()) used[n].insert("FORCED:" + fn->second); } auto &m = memo[n]; m.ok = true; if (h.use_count() == 1) memoBytes += histBytes(*h); m.h = std::move(h); m.why.clear(); return *m.h; }
    catch (const Refuse &e) { auto &m = memo[n]; m.ok = false; m.why = e.what(); throw; }
  }
  void checkAllow(const Words &w) const {
    if (!allow) return; std::string bad; for (auto &x : w) if (x.compare(0, 7, "FORCED:") != 0 && !allow->count(x)) bad += (bad.empty() ? "" : ",") + x;
    if (!bad.empty()) throw Refuse("not proven: " + bad);
  }
  std::shared_ptr<const Hist> hist_(const NodeId &n) {
    auto d = G.define(n); int64_t w = G.width(n);
    if (d.k == Graph::Def::STORED) {
      for (auto k : d.ids) {
        auto in = F.idn.find(k); if (in == F.idn.end()) continue;
        for (auto &nm : in->second) {
          auto h = stored(strip_name(nm));
          if (h && histCap && histBytes(*h) > histCap) throw Refuse(capWhy());
          if (h) { used[n] = {}; if (forcedStored) { auto fs = forcedStored->find(k); if (fs != forcedStored->end()) used[n].insert("FORCED:" + fs->second); } if (!h->empty() && h->time(0) == 0) return h; auto o = std::make_shared<Hist>(); o->push(0, X(!h->empty() ? h->width(0) : (size_t)std::max<int64_t>(w, 0))); o->append(*h); return o; }
        }
      }
      throw Refuse("stored value not carried in the converted file");
    }
    if (d.k == Graph::Def::NONE) throw Refuse("input unavailable: " + d.why);
    if (d.k == Graph::Def::ALIAS) {
      NodeId p = d.alias; if (sem.r("TUPLE_RED") && p.x != 0) p.v += 1;
      hist(p); Words u = used[p]; u.insert("TUPLE"); used[n] = u; return memo[p].h;
    }
    if (w < 0) throw Refuse("no width");
    if (d.recs.size() > 1) { auto h = std::make_shared<Hist>(multi(n, d.recs, (size_t)w)); h->shrink(); return h; }
    Words wd; std::shared_ptr<const Hist> same; Hist r = apply(n, *d.recs[0], (size_t)w, wd, &same); used[n] = wd;
    if (same) return same;   // a plain copy: the operand's own history
    auto h = std::make_shared<Hist>(std::move(r)); h->shrink(); return h;
  }
  // settled merge: at every change time of any input, the value of each input (nullptr before its first change). The value
  // passed is the last one at or before that time, unpacked (class PV) once per input change. Inputs in time order (all of
  // them, as written by this evaluator and the stored reader) are merged as they are read; otherwise the times are
  // collected and sorted first. Both give the same times and the same values.
  template <class Fn> void merge(const std::vector<const Hist *> &hs, Fn fn) {
    const size_t n = hs.size(); std::vector<size_t> idx(n, 0); std::vector<PV> buf(n); std::vector<const PV *> cur(n, nullptr);
    auto step = [&](uint64_t t) {
      for (size_t i = 0; i < n; i++) { auto &h = *hs[i]; size_t k = idx[i]; while (k < h.size() && h.time(k) <= t) k++;
        if (k != idx[i]) { h.getP(k - 1, buf[i]); cur[i] = &buf[i]; idx[i] = k; } }
      fn(t, cur);
    };
    bool sorted = true; for (auto *h : hs) if (!h->sorted()) sorted = false;
    if (sorted) {
      for (;;) { bool any = false; uint64_t t = 0;
        for (size_t i = 0; i < n; i++) if (idx[i] < hs[i]->size()) { const uint64_t ti = hs[i]->time(idx[i]); if (!any || ti < t) t = ti; any = true; }
        if (!any) break; step(t); }
      return;
    }
    std::vector<uint64_t> times; for (auto *h : hs) for (size_t j = 0; j < h->size(); j++) times.push_back(h->time(j));
    std::sort(times.begin(), times.end()); times.erase(std::unique(times.begin(), times.end()), times.end());
    for (uint64_t t : times) step(t);
  }
  static void nodewords(const Node &t, const Node *parent, Words &acc) {
    if (t.kind == Node::CONST) { if (parent && parent->kind == Node::CONCAT) acc.insert("OCONST"); return; }
    acc.insert(t.kind == Node::ARG ? "COPY" : t.kind == Node::LIT ? "LIT" : opname(t));
    for (auto &k : t.kids) nodewords(*k, &t, acc);
  }
  static std::string opname(const Node &t) {
    char b[8];
    switch (t.kind) { case Node::UN: snprintf(b, sizeof b, "u%02x", t.v); return b; case Node::BIN: snprintf(b, sizeof b, "b%02x", t.v); return b;
      case Node::BSEL: return "bsel"; case Node::PSEL: return "psel"; case Node::PWRITE: return "pwrite"; case Node::CONCAT: return "concat";
      case Node::ARG: return "arg"; case Node::LIT: return "lit"; case Node::CONST: return "const"; }
    return "?";
  }
  // share (optional): when the record is a plain copy of its one operand at the same width (a bare operand, under copy
  // words u95 only), the result has exactly the operand's times and values; it is then given back here as the operand's own
  // history instead of a rebuilt one (same words, same refusals). Not with planted errors (test builds).
  Hist apply(const NodeId &n, const Rec &rec, size_t w, Words &words, std::shared_ptr<const Hist> *share = nullptr) {
    uint64_t x = n.x; auto args = G.args_of(x, rec); std::vector<const Hist *> hs;
    for (auto &m : args) hs.push_back(&hist(m));
    std::vector<size_t> aw; for (auto *h : hs) { if (h->empty()) throw Refuse("input with no history"); aw.push_back(h->width(0)); }
    for (auto &m : args) { auto &u = used[m]; words.insert(u.begin(), u.end()); }
    { auto xs = G.xsel.find(x); if (xs != G.xsel.end()) words.insert(xs->second); }
    std::function<PV(const std::vector<const PV *> &)> f; char kk = rec.key.k;
    if (kk == 'Q') {
      std::string q = "Q" + std::to_string(rec.key.id);
      if (rec.key.id == 1) f = [this](const std::vector<const PV *> &v) { return sem.r("RED_Q1") ? pvo::b_not(*v.at(0)) : *v.at(0); };
      else if (rec.key.id == 3 && sem.q3_invert) f = [this](const std::vector<const PV *> &v) { return sem.r("Q3_COPY") ? *v.at(0) : pvo::b_not(*v.at(0)); };
      else throw Refuse("second-kind record " + q + " (meaning unknown)");
      words.insert(q);
    } else if (kk == 'B') {
      if (rec.key.id >= F.progs.size() || !F.progOk[rec.key.id]) throw Refuse("code block " + std::to_string(rec.key.id) + " not parsed");
      const Prog &prog = F.progs[rec.key.id]; for (auto &i : prog.words) words.insert(i.op);
      if (prog.hasOut && prog.msb - prog.lsb + 1 != (int64_t)w) throw Refuse("code block writes only part of its value");
      std::vector<uint8_t> opc = opcodes(prog);   // each word's instruction, decoded once per record (not per value)
      f = [this, &prog, opc, aw, w](const std::vector<const PV *> &v) { return run_block(prog, opc, v, aw, w); };
    } else {
      if (rec.key.id >= F.codes.size()) throw Refuse("op-table node UNPARSED not established");
      const Node *tree = F.codes[rec.key.id].get();
      if (!tree) { words.insert("UNPARSED"); f = [](const std::vector<const PV *> &) -> PV { throw Refuse("op-table node UNPARSED not established"); }; }
      else {
        nodewords(*tree, nullptr, words);
        f = [this, tree, aw, w](const std::vector<const PV *> &v) {
          const Node *tt = tree; while (tt->kind == Node::UN && (tt->v == 0x95 || tt->v == 0x94)) tt = tt->kids[0].get();
          cw = tt->kind == Node::CONCAT ? (int64_t)w : -1; return ex(*tree, v, aw).first;
        };
      }
    }
    checkAllow(words);
    Hist out; ctxw.clear(); RowCap rc{*this};
    // strict: a z on any input of an instruction is refused (no z-bearing case is proven); a plain copy passes it on
    bool copyOnly = false;
    bool planted = false;
#ifdef WCZ_DERIVE_TEST_REDS
    planted = !sem.red.empty();
#endif
    if ((kk == 'P' || kk == 'T') && rec.key.id < F.codes.size() && F.codes[rec.key.id]) { const Node *tt = F.codes[rec.key.id].get(); while (tt->kind == Node::UN && tt->v == 0x95) tt = tt->kids[0].get(); copyOnly = tt->kind == Node::ARG || (sem.r("TRY_8186") && tt->kind == Node::UN && tt->v == 0x81 && tt->kids[0]->kind == Node::ARG);   // test flag: a buffer of one operand normalises z
      if (!ispw(F.codes[rec.key.id].get()) && admitted(F.codes[rec.key.id].get(), w, aw, false)) copyOnly = true; }   // admitted 0x81/0x94 forms take z by rule
    const bool caseEq = words.count("EQU") || words.count("NEQU");   // === / !== see z and x apart: z-ops does not cover them
    if (share && !planted && (kk == 'P' || kk == 'T') && hs.size() == 1 && rec.key.id < F.codes.size() && F.codes[rec.key.id]) {
      const Node *tt = strip95(F.codes[rec.key.id].get());
      if (tt->kind == Node::ARG && tt->v == 0 && hs[0]->allOfWidth(w) && hs[0]->strictlyIncreasing()) {
        auto it = memo.find(args[0]);
        if (it != memo.end() && it->second.ok && it->second.h.get() == hs[0]) { cw = -1; *share = it->second.h; return out; }   // cw as the copy's own evaluation leaves it
      }
    }
    std::vector<PV> zt; std::vector<const PV *> zv;
    merge(hs, [&](uint64_t t, const std::vector<const PV *> &vals) {
      bool zin = false;
      if (sem.strict && !copyOnly) for (auto *p : vals) if (p && pvo::hasZ(*p)) zin = true;
      if (zin && !sem.zops) throw Refuse("z input reaching an instruction (not proven)");
      if (zin && caseEq && !sem.r("RED_ZCASE_OFF")) throw Refuse("z-ops: z input reaching a case equality (not proven)");
      PV r = f(zin ? zsub(vals, zt, zv) : vals);
      if (zin && pvo::hasZ(r) && !sem.r("RED_ZKEEP_OFF")) throw Refuse("z-ops: z reaches the result through a copy-like op (not proven)");
      if (r.size() != w) {
        if (kk == 'P' || kk == 'T' || kk == 'Q') { r = pvo::fit(r, w); words.insert("RESIZE"); }
        else throw Refuse("result width " + std::to_string(r.size()) + " vs value width " + std::to_string(w));
      }
      rc.add(r.size()); out.pushP(t, r);
    });
    words.insert(ctxw.begin(), ctxw.end()); ctxw.clear();
    checkAllow(words);
    return out;
  }
  // ---- admission rules. 0x81 = per-bit buffer: 0/1 kept, x and z become x. 0x94 = fixed-width
  // normalisation: 0/1 kept, x and z become 0. Both only with operand width == result width > 0, over a bound operand.
  //   0x81: whole vector u81(aK), or scalarised u81(bsel(aK,#c)) as the value of a bit part write (the multi-record path then
  //         checks the target select and the exact cover). 0x94: u94(aK), or u94 over one bit/part select of aK whose bounds are
  //         constants inside aK and whose width equals the destination width; the result is that select's own bits.
  //   Refused: 0x81/0x94 anywhere else in an expression, any other operand (arithmetic / coercion), widening or narrowing without
  //   a select, unbound operands, non-constant or out-of-range selects, constants without an established slot size.
  //   Signedness is never taken from the state-type byte. u95 copies around the operand are looked through (u95 = copy, proven).
  static const Node *strip95(const Node *t) { while (t && t->kind == Node::UN && t->v == 0x95 && !t->kids.empty()) t = t->kids[0].get(); return t; }
  static int countUn(const Node &t, unsigned v) { int c = (t.kind == Node::UN && t.v == v) ? 1 : 0; for (auto &k : t.kids) c += countUn(*k, v); return c; }
  size_t admSel(const Node &o, const std::vector<size_t> &aw) const {   // width of a validated select / bound operand
    if (o.kind == Node::ARG) { if (o.v >= aw.size()) throw Refuse("admission: unbound operand"); return aw[o.v]; }
    const Node *b = strip95(o.kids[0].get());
    if (b->kind != Node::ARG) throw Refuse("admission: select over an expression (not admitted)");
    if (b->v >= aw.size()) throw Refuse("admission: unbound operand");
    long long wa = (long long)aw[b->v];
    if (o.kind == Node::BSEL) {
      if (o.kids[1]->kind != Node::CONST) throw Refuse("admission: variable bit select");
      long long i = pool_c(o.kids[1]->v, C_IDX); if (i < 0 || i >= wa) throw Refuse("admission: bit select outside its operand"); return 1;
    }
    if (o.kids[1]->kind != Node::CONST || o.kids[2]->kind != Node::CONST) throw Refuse("admission: variable part select");
    try { auto r = psel_range(*o.kids[1], *o.kids[2], wa); return (size_t)(r.first - r.second + 1); }
    catch (const Refuse &e) { std::string m = e.what(); if (m.find("part select range") == 0) throw Refuse("admission: part select outside its operand: " + m); throw; }
  }
  // true: val is an admitted 0x81/0x94 form for destination width dw. false: no 0x81/0x94 under an enabled rule. Refuse otherwise.
  bool admitted(const Node *val, size_t dw, const std::vector<size_t> &aw, bool inPw) const {
    int n81 = sem.admit81 ? countUn(*val, 0x81) : 0, n94 = sem.admit94 ? countUn(*val, 0x94) : 0;
    if (!n81 && !n94) return false;
    const Node *t = strip95(val);
    if (t->kind != Node::UN || (t->v != 0x81 && t->v != 0x94) || countUn(*val, 0x81) + countUn(*val, 0x94) != 1)
      throw Refuse("admission: 0x81/0x94 inside a larger expression (not admitted)");
    const Node *o = strip95(t->kids[0].get()); bool sel = o->kind == Node::BSEL || o->kind == Node::PSEL;
    if (o->kind != Node::ARG && !sel) throw Refuse("admission: operand is an arithmetic or coercion expression (not admitted)");
    if (t->v == 0x81 && o->kind == Node::PSEL) throw Refuse("admission: 0x81 over a part select (not admitted)");
    if (t->v == 0x81 && o->kind == Node::BSEL && !inPw) throw Refuse("admission: scalarised 0x81 outside a part-write assembly");
    size_t ow = admSel(*o, aw);
    if (ow == 0 || ow != dw) throw Refuse(std::string("admission: ") + (t->v == 0x94 && dw > ow ? "widening 0x94" : "operand / result width differ") + " (" + std::to_string(ow) + " vs " + std::to_string(dw) + ")");
    return true;
  }
  static bool ispw(const Node *t) { return t && (t->kind == Node::PWRITE || (t->kind == Node::UN && t->v == 0x95 && t->kids[0]->kind == Node::PWRITE)); }
  Hist multi(const NodeId &n, const std::vector<const Rec *> &recs, size_t w) {
    uint64_t x = n.x; std::vector<const Node *> trees;
    for (auto *r : recs) trees.push_back((r->key.k == 'P' || r->key.k == 'T') && r->key.id < F.codes.size() ? F.codes[r->key.id].get() : nullptr);
    auto isB = [&](size_t j) { auto *r = recs[j]; return r->key.k == 'B' && r->key.id < F.progs.size() && F.progOk[r->key.id] && F.progs[r->key.id].hasOut; };
    // an UNPARSED op-table code counts as a present tree (only its head is looked at)
    auto present = [&](size_t j) { auto *r = recs[j]; return (r->key.k == 'P' || r->key.k == 'T'); };
    bool allpw = true, allu95np = true;
    for (size_t j = 0; j < recs.size(); j++) {
      if (!(ispw(trees[j]) || isB(j))) allpw = false;
      if (!(present(j) && trees[j] && trees[j]->kind == Node::UN && trees[j]->v == 0x95 && !ispw(trees[j]))) allu95np = false;
    }
    if (allpw && !allu95np) {
      struct Part { std::vector<int64_t> bits; Hist h; }; std::vector<Part> parts; Words words;
      for (size_t j = 0; j < recs.size(); j++) {
        const Rec &r = *recs[j];
        if (r.key.k == 'B') {
          const Prog &P = F.progs[r.key.id]; int64_t m = P.msb, l = P.lsb; if (sem.r("MB_POS")) { m++; l++; }
          Part p; for (int64_t b = m; b >= l; b--) p.bits.push_back(b);
          Words wk; p.h = apply(n, r, (size_t)(m - l + 1), wk); words.insert(wk.begin(), wk.end()); words.insert("OUTRANGE"); parts.push_back(std::move(p)); continue;
        }
        const Node *pw = trees[j]->kind == Node::PWRITE ? trees[j] : trees[j]->kids[0].get(); const Node *sel = pw->kids[0].get();
        Part p; p.bits = pw_target(sel);
        for (auto b : p.bits) if (b < 0 || b >= (int64_t)w) throw Refuse("part write target outside the destination");
        if (sem.r("PWRITE_REV")) std::reverse(p.bits.begin(), p.bits.end());
        auto args = G.args_of(x, r); std::vector<const Hist *> hs; for (auto &m : args) hs.push_back(&hist(m));
        std::vector<size_t> aw; for (auto *h : hs) { if (h->empty()) throw Refuse("input with no history"); aw.push_back(h->width(0)); }
        nodewords(*pw->kids[1], pw, words); words.insert("PWRITE"); for (auto &m : args) { auto &u = used[m]; words.insert(u.begin(), u.end()); }
        const Node *val = pw->kids[1].get();
        const bool pwCaseEq = words.count("EQU") || words.count("NEQU");   // same rule as the main path: === / !== see z and x apart
        if (sem.pwrite_cw) cw = (int64_t)p.bits.size();   // a constant inside a concat in the written value takes the target width (not a stale one)
        // strict z rule on this path too: a z on an input of the written value is refused unless the
        // value is a plain copy (or, under the TRY_8186 test flag only, a buffer u81 of one operand / one constant bit of it)
        bool vcopy = val->kind == Node::ARG || (sem.r("TRY_8186") && val->kind == Node::UN && val->v == 0x81 &&
                     (val->kids[0]->kind == Node::ARG || (val->kids[0]->kind == Node::BSEL && val->kids[0]->kids[0]->kind == Node::ARG && val->kids[0]->kids[1]->kind == Node::CONST)));
        if (admitted(val, p.bits.size(), aw, true)) vcopy = true;   // admitted 0x81/0x94 value of a part write takes z by rule
        RowCap prc{*this};
        std::vector<PV> zt; std::vector<const PV *> zv;
        if (!hs.empty()) merge(hs, [&](uint64_t t, const std::vector<const PV *> &v) {
          bool zin = false;
          if (sem.strict && !vcopy && !sem.r("ZRULE_PW_OFF")) for (auto *q : v) if (q && pvo::hasZ(*q)) zin = true;
          if (zin && !sem.zops) throw Refuse("z input reaching an instruction (not proven)");
          if (zin && pwCaseEq && !sem.r("RED_ZCASE_OFF")) throw Refuse("z-ops: z input reaching a case equality (not proven)");
          PV pv = ex(*val, zin ? zsub(v, zt, zv) : v, aw).first;
          if (zin && pvo::hasZ(pv) && !sem.r("RED_ZKEEP_OFF")) throw Refuse("z-ops: z reaches the result through a copy-like op (not proven)");
          prc.add(p.bits.size()); p.h.pushP(t, pv); });
        else p.h.pushP(0, ex(*val, std::vector<const PV *>(), std::vector<size_t>()).first);
        if (!p.h.empty() && p.h.width(0) != p.bits.size()) throw Refuse("part write value width vs target");
        parts.push_back(std::move(p));
      }
      checkAllow(words);
      std::vector<int64_t> cover; for (auto &p : parts) cover.insert(cover.end(), p.bits.begin(), p.bits.end()); std::sort(cover.begin(), cover.end());
      bool exact = cover.size() == w; for (size_t i = 0; exact && i < w; i++) if (cover[i] != (int64_t)i) exact = false;
      if (!exact) throw Refuse("parts do not cover the width exactly");
      if (sem.r("PART_SWAP") || sem.r("PART_SWAP_B")) {   // planted, cover-preserving: two equal-size parts trade positions
        bool needB = sem.r("PART_SWAP_B") != 0; bool done = false;
        for (size_t i = 0; i < parts.size() && !done; i++) for (size_t j = i + 1; j < parts.size() && !done; j++)
          if (parts[i].bits.size() == parts[j].bits.size() && (!needB || isB(i) || isB(j))) { std::swap(parts[i].bits, parts[j].bits); done = true; }
      }
      std::vector<const Hist *> hs; for (auto &p : parts) hs.push_back(&p.h); Hist out; RowCap rc{*this};
      // a part whose target bits run down one by one (hi .. lo) and whose values have that width is placed as one field
      std::vector<char> run(parts.size(), 0);
      for (size_t i = 0; i < parts.size(); i++) { auto &b = parts[i].bits; bool ok = !b.empty(); for (size_t q = 1; ok && q < b.size(); q++) ok = b[q] == b[0] - (int64_t)q; run[i] = ok; }
      PV acc, fld;
      merge(hs, [&](uint64_t t, const std::vector<const PV *> &v) {
        rc.add((size_t)w); acc = pvo::pX(w);
        for (size_t i = 0; i < parts.size(); i++) { if (!v[i]) { if (sem.r("RED_XFILL")) continue; throw Refuse("a part without a value at a merge time (fill not established)"); }
          const auto &b = parts[i].bits; const PV &pv = *v[i]; const size_t L = pv.width(), nb = std::min(b.size(), L);
          if (run[i] && L == b.size()) { pvo::setField(acc, (size_t)b.back(), pv); continue; }
          for (size_t q = 0; q < nb; q++) { const size_t j = L - 1 - q; acc.setBit((size_t)b[q], pv.bitA(j), pv.bitB(j)); } }   // text position q of the part -> target bit b[q]
        out.pushP(t, acc);
      });
      used[n] = words; return out;
    }
    bool allu95 = true; for (auto *t : trees) if (!(t && t->kind == Node::UN && t->v == 0x95)) allu95 = false;
    if (allu95) {
      std::vector<Hist> hs; Words words;
      for (size_t j = 0; j < recs.size(); j++) { Words wk; hs.push_back(apply(n, *recs[j], w, wk)); words.insert(wk.begin(), wk.end()); }
      checkAllow(words);
      int ty = G.typebyte(n); int kind = ty < 0 ? -1 : (ty >> 3) & 0x1f;
      if (kind < 0 || kind > 2) { char b[8]; snprintf(b, sizeof b, "%02x", ty); throw Refuse(std::string("several drivers on a net of unknown kind (type byte ") + (ty < 0 ? "None" : b) + ")"); }
      if (sem.r("RESOLVE_KIND_RED")) kind = kind == 0 ? 1 : kind == 1 ? 2 : 0;
      static const char *RK[3] = {"RESOLVE", "RESOLVE_WAND", "RESOLVE_WOR"}; words.insert(RK[kind]);
      std::vector<const Hist *> hp; for (auto &h : hs) hp.push_back(&h); Hist out; RowCap rc{*this};
      merge(hp, [&](uint64_t t, const std::vector<const PV *> &v) {
        for (auto *p : v) if (!p) throw Refuse("driver without a value at a merge time");
        rc.add((size_t)w);
        out.pushP(t, (sem.r("RESOLVE_RED") || (kind == 0 && sem.r("RED_RESOLVE"))) ? *v[0] : pvo::resolve(v, kind));
      });
      used[n] = words; return out;
    }
    throw Refuse("several records on one value of mixed kinds");
  }
  // z-ops inputs: identity, except the planted reds (test builds): RED_Z0 reads z as 0, RED_ZX reads z as x. Two more planted
  // reds switch a z-ops check off on both paths: RED_ZCASE_OFF (case equality), RED_ZKEEP_OFF (a z left on the result).
  const std::vector<const PV *> &zsub(const std::vector<const PV *> &v, std::vector<PV> &tmp, std::vector<const PV *> &out) const {
    if (!sem.r("RED_Z0") && !sem.r("RED_ZX")) return v;
    const bool z0 = sem.r("RED_Z0") != 0; tmp.clear(); tmp.reserve(v.size()); out.clear();
    for (auto *p : v) { if (!p) { out.push_back(nullptr); continue; } tmp.push_back(*p); PV &q = tmp.back();
      for (size_t k = 0; k < q.nw(); k++) { const uint64_t z = q.A()[k] & q.B()[k]; q.A()[k] &= ~z; if (z0) q.B()[k] &= ~z; }   // z -> 0 (RED_Z0) or x (RED_ZX)
      out.push_back(&tmp.back()); }
    return out;
  }
  // ---- op-table expressions -> (value, width)
  // text form (tests): the same evaluation on text operands, the result given back as text
  std::pair<Val, size_t> ex(const Node &t, const std::vector<const Val *> &v, const std::vector<size_t> &aw) {
    std::vector<PV> pv(v.size()); std::vector<const PV *> pp(v.size(), nullptr);
    for (size_t i = 0; i < v.size(); i++) if (v[i]) { if (!pv[i].fromText(*v[i])) Hist::checkText(*v[i]); pp[i] = &pv[i]; }
    auto r = ex(t, pp, aw); return {r.first.text(), r.second};
  }
  std::pair<PV, size_t> ex(const Node &t, const std::vector<const PV *> &v, const std::vector<size_t> &aw) {
    using namespace pvo;
    switch (t.kind) {
      case Node::ARG: if (t.v >= v.size() || !v[t.v]) throw Refuse("arg ref beyond the record (operand numbering not established)"); return {sem.r("RED_COPY") ? b_not(*v[t.v]) : *v[t.v], aw[t.v]};
      case Node::LIT: return {one(char('0' + (t.v ^ (unsigned)sem.r("LIT_RED")))), 1};
      case Node::CONST: throw Refuse("constant used as a value");
      case Node::UN: {
        if (t.v == 0x95) { auto a = ex(*t.kids[0], v, aw);   // review item 3: one evaluation (ex has no side effects; the first result was discarded)
                            if (sem.r("RED_u95")) a.first = b_not(a.first); return a; }
        if (t.v == 0x82) { auto a = ex(*t.kids[0], v, aw); return {sem.r("RED_u82") ? a.first : b_not(a.first), a.second}; }
        if (t.v == 0xb9 && sem.ub9_xor) { auto a = ex(*t.kids[0], v, aw); PV r = (sem.r("UB9_XNOR") || sem.r("RED_ub9")) ? b_not(red_xor(a.first)) : red_xor(a.first); const size_t rw = r.size(); return {std::move(r), rw}; }
        if (t.v == 0x81 && sem.r("TRY_8186")) {   // not proven (test flag only): full-width buffer, z -> x
          auto a = ex(*t.kids[0], v, aw); PV r = a.first;
          if (sem.r("U81_IDENT")) return a;                                   // planted: plain identity (z passes)
          if (sem.r("U81_LOGIC")) return {fit(one(truth(r)), a.second), a.second};   // planted: logical value
          for (size_t k = 0; k < r.nw(); k++) r.A()[k] &= ~r.B()[k]; return {r, a.second};
        }
        if (t.v == 0x81 && sem.admit81) {   // admitted (shape checked by admitted()): per-bit buffer, x and z -> x
          auto a = ex(*t.kids[0], v, aw); if (sem.r("RED_A81_IDENT")) return a;
          PV r = a.first; const bool to0 = sem.r("RED_A81_XZ0") != 0;
          for (size_t k = 0; k < r.nw(); k++) { r.A()[k] &= ~r.B()[k]; if (to0) r.B()[k] = 0; } return {r, a.second};
        }
        if (t.v == 0x94 && sem.admit94) {   // admitted (shape checked by admitted()): fixed width, x and z -> 0
          auto a = ex(*t.kids[0], v, aw); const Node *o = strip95(t.kids[0].get());
          if (sem.r("RED_A94_SEL") && (o->kind == Node::BSEL || o->kind == Node::PSEL)) {   // planted: "keeps the low bits" of the operand
            auto b = ex(*o->kids[0], v, aw); bits(b.first, 0, std::min(b.first.size(), a.second), a.first); }
          PV r = a.first; const bool tox = sem.r("RED_A94_XZX") != 0;
          for (size_t k = 0; k < r.nw(); k++) { if (tox) r.A()[k] &= ~r.B()[k]; else { r.A()[k] &= ~r.B()[k]; r.B()[k] = 0; } } return {r, a.second};
        }
        char b[8]; snprintf(b, sizeof b, "u%02x", t.v); throw Refuse(std::string("op ") + b + " meaning not established");
      }
      case Node::BIN: {
        auto a = ex(*t.kids[0], v, aw); auto b = ex(*t.kids[1], v, aw); char nm[8]; snprintf(nm, sizeof nm, "b%02x", t.v);
        if (a.second != b.second) throw Refuse(std::string(nm) + " on different widths " + std::to_string(a.second) + "/" + std::to_string(b.second));
        if (t.v == 0x83) return {sem.r("RED_b83") ? b_or(a.first, b.first) : b_and(a.first, b.first), a.second};
        if (t.v == 0x84) return {sem.r("RED_b84") ? b_and(a.first, b.first) : b_or(a.first, b.first), a.second};
        if (t.v == 0x85) return {sem.r("RED_b85") ? b_xnor(a.first, b.first) : b_xor(a.first, b.first), a.second};
        if (t.v == 0x86 && sem.r("TRY_8186")) {   // not proven (test flag only): per-bit XNOR, unknown in -> x
          const PV &p = a.first, &q = b.first;
          if (sem.r("B86_CASEEQ")) { const size_t n = p.size(); PV r(n); for (size_t i = 0; i < n; i++) if (p.chr(i) == q.chr(i)) r.setBit(n - 1 - i, 1, 0); return {r, a.second}; }
          if (sem.r("B86_NAND")) return {b_not(b_and(p, q)), a.second};
          if (sem.r("B86_NOR")) return {b_not(b_or(p, q)), a.second};
          if (sem.r("B86_ANDNOT")) return {b_and(p, b_not(q)), a.second};
          return {b_xnor(p, q), a.second};
        }
        throw Refuse("op b86 meaning not established");
      }
      case Node::BSEL: {
        auto a = ex(*t.kids[0], v, aw); if (t.kids[1]->kind != Node::CONST) throw Refuse("variable bit select");
        long long i = pool_c(t.kids[1]->v, C_IDX) + sem.r("BSEL_OFF"); long long wa = (long long)a.second;
        if (!(0 <= i && i < wa) && !sem.r("RED_XFILL")) throw Refuse("a bit outside the operand width (fill not established)");   // was x: CVA6 '0-default bits came out x (sim-ref 12:16Z)
        return {(0 <= i && i < wa) ? one(a.first.chr((size_t)(wa - 1 - i))) : one('x'), 1};
      }
      case Node::PSEL: {
        auto a = ex(*t.kids[0], v, aw);
        long long wa = (long long)a.second;
        auto rg = psel_range(*t.kids[1], *t.kids[2], sem.strict ? wa : -1); long long hi = rg.first + sem.r("PSEL_OFF"), lo = rg.second + sem.r("PSEL_OFF");
        if ((lo < 0 || hi >= wa) && !sem.r("RED_XFILL")) throw Refuse("a bit outside the operand width (fill not established)");
        PV r; const size_t rw = (size_t)(hi - lo + 1);
        if (lo >= 0 && hi < wa && (size_t)wa == a.first.size()) bits(a.first, (size_t)lo, rw, r);   // text positions wa-1-hi .. wa-1-lo = bits lo .. hi
        else { r = pX(rw); for (long long i = hi; i >= lo; i--) if (0 <= i && i < wa) { const char c = a.first.chr((size_t)(wa - 1 - i)); r.setBit((size_t)(i - lo), c == '1' || c == 'z', c == 'x' || c == 'z'); } }
        return {r, rw};
      }
      case Node::CONCAT: {
        if (t.v != 1) throw Refuse("concatenate with repeat " + std::to_string(t.v));
        // kids as (node, rewritten arg index): constants are counted among the operand positions (literal-first reading)
        struct K { const Node *n; bool rw; int64_t arg; }; std::vector<K> kids; size_t nc = 0; const Node *cn = nullptr;
        for (auto &c : t.kids) if (c->kind == Node::CONST) { nc++; cn = c.get(); }
        int seen = 0;
        for (auto &c : t.kids) {
          K k{c.get(), false, 0};
          if (c->kind == Node::CONST) { seen++; kids.push_back(k); continue; }
          if (sem.concat_pos && !sem.r("RED_CONCAT_POS_pos") && nc && c->kind == Node::ARG) { k.rw = true; k.arg = (int64_t)c->v - seen; ctxw.insert("CONCAT_POS_pos"); }
          kids.push_back(k);
        }
        auto exk = [&](const K &k) -> std::pair<PV, size_t> {
          if (k.rw) {
            int64_t i = k.arg; if (i < 0 || (size_t)i >= v.size() || !v[i]) throw Refuse("arg ref beyond the record (operand numbering not established)"); return {*v[i], aw[i]};
          }
          return ex(*k.n, v, aw);
        };
        std::vector<std::pair<PV, size_t>> parts;
        if (nc) {
          if (nc != 1 || cw < 0) throw Refuse("constant used as a value");
          std::vector<std::pair<PV, size_t>> rest; size_t sw = 0;
          for (auto &k : kids) if (k.n->kind != Node::CONST) { rest.push_back(exk(k)); sw += rest.back().second; }
          long long cwid = cw - (long long)sw, cv = pool_c(cn->v, C_VAL, cwid) + sem.r("OCONST_OFF") + sem.r("RED_OCONST");
          if (cwid <= 0 || cwid > 32 || cv < 0) throw Refuse("constant in concatenate not representable");
          size_t ri = 0; for (auto &k : kids) { if (k.n->kind == Node::CONST) parts.push_back({pbits_of(cv, (size_t)cwid), (size_t)cwid}); else parts.push_back(rest[ri++]); }
        } else for (auto &k : kids) parts.push_back(exk(k));
        if (sem.r("CONCAT_LSB_FIRST") || sem.r("RED_concat")) std::reverse(parts.begin(), parts.end());
        std::vector<const PV *> pp; size_t sw = 0; for (auto &p : parts) { pp.push_back(&p.first); sw += p.second; } return {concat(pp), sw};
      }
      default: throw Refuse("op-table node " + opname(t) + " not established");
    }
  }
  // ---- code blocks: stack machine
  // each word's instruction as a number (decoded once per record; 0 = not implemented: refused by name when reached)
  enum Op : uint8_t { O_NONE = 0, O_WIDTH, O_CALL_ARG_VAL, O_OPT_CONST, O_OPT_CONST_4ST, O_NOT, O_AND, O_OR, O_XOR, O_XNOR, O_M_EQU, O_EQU, O_M_NEQU, O_NEQU,
    O_MITECOND, O_SLICE, O_LNOT, O_LOGAND, O_LOGOR, O_XOR_REDUCE, O_XNOR_REDUCE, O_F2S, O_CONST, O_CONCATENATE, O_MULTI_CONCATENATE, O_PAD,
    O_SM_LT, O_SM_GE, O_SM_GT, O_SM_LE, O_SHIFT_R, O_SASHIFT_R, O_SHIFT_L, O_ADD, O_SUBTRACT, O_M_GT, O_M_LT, O_M_GE, O_M_LE };
  static uint8_t opcode(const std::string &op) {
    static const std::unordered_map<std::string, uint8_t> M = {
      {"WIDTH", O_WIDTH}, {"CALL_ARG_VAL", O_CALL_ARG_VAL}, {"OPT_CONST", O_OPT_CONST}, {"OPT_CONST_4ST", O_OPT_CONST_4ST}, {"NOT", O_NOT},
      {"AND", O_AND}, {"OR", O_OR}, {"XOR", O_XOR}, {"XNOR", O_XNOR}, {"M_EQU", O_M_EQU}, {"EQU", O_EQU}, {"M_NEQU", O_M_NEQU}, {"NEQU", O_NEQU},
      {"MITECONDNOINSTR", O_MITECOND}, {"SLICE", O_SLICE}, {"LNOT", O_LNOT}, {"LOGAND", O_LOGAND}, {"LOGOR", O_LOGOR},
      {"XOR_REDUCE", O_XOR_REDUCE}, {"XNOR_REDUCE", O_XNOR_REDUCE}, {"FOURTOTWOSTATE", O_F2S}, {"CONST", O_CONST},
      {"CONCATENATE", O_CONCATENATE}, {"MULTI_CONCATENATE", O_MULTI_CONCATENATE}, {"PAD", O_PAD},
      {"SM_LT", O_SM_LT}, {"SM_GE", O_SM_GE}, {"SM_GT", O_SM_GT}, {"SM_LE", O_SM_LE}, {"SHIFT_R", O_SHIFT_R}, {"SASHIFT_R", O_SASHIFT_R},
      {"SHIFT_L", O_SHIFT_L}, {"ADD", O_ADD}, {"SUBTRACT", O_SUBTRACT}, {"M_GT", O_M_GT}, {"M_LT", O_M_LT}, {"M_GE", O_M_GE}, {"M_LE", O_M_LE}};
    auto it = M.find(op); return it == M.end() ? (uint8_t)O_NONE : it->second;
  }
  static std::vector<uint8_t> opcodes(const Prog &prog) { std::vector<uint8_t> c; c.reserve(prog.words.size()); for (auto &w : prog.words) c.push_back(opcode(w.op)); return c; }
  Val run_block(const Prog &prog, const std::vector<const Val *> &v, const std::vector<size_t> &aw, size_t wout) {   // text form (tests)
    std::vector<PV> pv(v.size()); std::vector<const PV *> pp(v.size(), nullptr);
    for (size_t i = 0; i < v.size(); i++) if (v[i]) { if (!pv[i].fromText(*v[i])) Hist::checkText(*v[i]); pp[i] = &pv[i]; }
    return run_block(prog, opcodes(prog), pp, aw, wout).text();
  }
  PV run_block(const Prog &prog, const std::vector<uint8_t> &opc, const std::vector<const PV *> &v, const std::vector<size_t> &aw, size_t wout) {
    using namespace pvo;
    (void)aw; (void)wout; long long W = -1; std::vector<PV> st;
    auto pop = [&]() { if (st.empty()) throw Refuse("code block stack underflow"); PV a = std::move(st.back()); st.pop_back(); return a; };
    auto needW = [&]() { if (W < 0) throw Refuse("code block word before WIDTH"); return (size_t)W; };
    for (size_t wi = 0; wi < prog.words.size(); wi++) {
      const Word &ins = prog.words[wi]; const std::string &op = ins.op; const uint8_t oc = opc[wi];
      auto A = [&](size_t i) -> long long { if (i >= ins.a.size()) throw Refuse("code-block word " + op + " arguments"); return ins.a[i]; };
      switch (oc) {
      case O_WIDTH: W = A(0); continue;
      case O_CALL_ARG_VAL: {
        long long i = A(0) - 2 + sem.r("ARGIDX_RED");
        if (i < 0 || i >= (long long)v.size() || !v[i]) throw Refuse("CALL_ARG_VAL index outside the record");
        if (sem.r("ARGSWAP") && v.size() >= 2 && (i == 0 || i == 1)) i = 1 - i;
        st.push_back(W > 0 ? (sem.r("RED_WIDTH") && W > 1 ? fit(fit(*v[i], (size_t)W - 1), (size_t)W) : fit(*v[i], (size_t)W)) : *v[i]); continue;   // planted WIDTH: one bit short, zero-filled
      }
      case O_OPT_CONST: { long long c = A(0) + sem.r("OPT_CONST_OFF") + sem.r("RED_OPT_CONST"); st.push_back(pbits_of(c, needW())); continue; }
      case O_OPT_CONST_4ST: {
        long long a = A(0), b = A(1), aval = b, bval = a; if (sem.r("CONST4_AB") || sem.r("RED_OPT_CONST_4ST")) { aval = a; bval = b; }
        size_t w = needW(); PV r(w);
        for (size_t j = 0; j < w; j++) { int p = pbitof(aval, j), q = pbitof(bval, j); r.setBit(j, p ^ q, q); }   // p q: 1 0 -> 1, 1 1 -> x, 0 1 -> z, 0 0 -> 0
        st.push_back(std::move(r)); continue;
      }
      case O_NOT: { PV a = pop(); st.push_back(sem.r("RED_NOT") ? a : b_not(a)); continue; }
      case O_AND: case O_OR: case O_XOR: case O_XNOR: {
        PV b = pop(), a = pop(); if (a.size() != b.size()) throw Refuse(op + " on different widths");
        uint8_t o2 = oc; if (sem.rop(op)) o2 = oc == O_AND ? O_OR : oc == O_OR ? O_AND : oc == O_XOR ? O_XNOR : O_XOR;
        st.push_back(o2 == O_AND ? b_and(a, b) : o2 == O_OR ? b_or(a, b) : o2 == O_XOR ? b_xor(a, b) : b_xnor(a, b)); continue;
      }
      case O_M_EQU: case O_EQU: case O_M_NEQU: case O_NEQU: {
        PV b = pop(), a = pop(); if (a.size() != b.size()) throw Refuse(op + " on different widths");
        PV r = oc == O_M_EQU ? l_eq(a, b) : oc == O_EQU ? c_eq(a, b) : oc == O_M_NEQU ? inv1(l_eq(a, b)) : inv1(c_eq(a, b));
        st.push_back(sem.rop(op) ? inv1(r) : r); continue;
      }
      case O_MITECOND: {
        PV c3 = pop(), c2 = pop(), c1 = pop();
        if (sem.r("COND_SWAP") || sem.r("RED_MITECONDNOINSTR")) st.push_back(cond(c1, c3, c2)); else st.push_back(cond(c1, c2, c3)); continue;
      }
      case O_SLICE: {
        PV i = pop(), a = pop(); size_t w = needW();
        if (!known(i)) { st.push_back(pX(w)); continue; }
        long long k = (long long)uval(i) + sem.r("SLICE_OFF") + sem.r("RED_SLICE"), wa = (long long)a.size();
        if ((k < 0 || k + (long long)w > wa) && !sem.r("RED_XFILL")) throw Refuse("a bit outside the operand width (fill not established)");
        PV r; if (k >= 0 && k + (long long)w <= wa) bits(a, (size_t)k, w, r);   // text positions wa-1-(k+w-1) .. wa-1-k = bits k .. k+w-1
        else { r = pX(w); for (long long j = k + (long long)w - 1; j >= k; j--) if (0 <= j && j < wa) r.setBit((size_t)(j - k), a.bitA((size_t)j), a.bitB((size_t)j)); }
        st.push_back(std::move(r)); continue;
      }
      case O_LNOT: { char t = truth(pop()); if (sem.r("RED_LNOT")) { st.push_back(one(t)); continue; } st.push_back(one(t == '1' ? '0' : t == '0' ? '1' : 'x')); continue; }
      case O_LOGAND: case O_LOGOR: {
        PV b = one(truth(pop())), a = one(truth(pop())); bool isand = oc == O_LOGAND; if (sem.r("LOG_SWAP") || sem.rop(op)) isand = !isand;
        st.push_back(isand ? b_and(a, b) : b_or(a, b)); continue;
      }
      case O_XOR_REDUCE: st.push_back(red_xor(pop())); continue;
      case O_XNOR_REDUCE: st.push_back(b_not(red_xor(pop()))); continue;
      case O_F2S: { PV a = pop(); if (!sem.r("F2S_RED")) for (size_t k = 0; k < a.nw(); k++) { a.A()[k] &= ~a.B()[k]; a.B()[k] = 0; } st.push_back(std::move(a)); continue; }
      case O_CONST: {
        long long n = A(0); if (n < 0 || A(1) != 0 || (long long)ins.a.size() - 2 < n) throw Refuse("CONST form not established");
        std::vector<long long> ws(ins.a.begin() + 2, ins.a.begin() + 2 + n); size_t w = needW();
        if (n == 0) { st.push_back(PV(w)); continue; }
        bool nz = false; for (auto q : ws) if (q) nz = true;
        if (nz && sem.strict) throw Refuse("nonzero block constant (word order not established)");
        auto wbit = [&](int which, size_t j) -> int {   // which 0 = bval (even words), 1 = aval (odd words)
          size_t word = j / 32; if ((long long)word >= n / 2) return 0; return (int)(((uint64_t)(ws[2 * word + which] & 0xffffffffLL) >> (j % 32)) & 1);
        };
        bool swap = sem.r("CONST_HALF_SWAP") || sem.r("RED_CONST"); PV r(w);
        for (size_t j = 0; j < w; j++) { int a = wbit(swap ? 0 : 1, j), b = wbit(swap ? 1 : 0, j); r.setBit(j, a ^ b, b); }   // a b: 1 0 -> 1, 1 1 -> x, 0 1 -> z, 0 0 -> 0
        st.push_back(std::move(r)); continue;
      }
      case O_CONCATENATE: {
        long long n = A(0); if (n <= 0 || (size_t)n > st.size()) n = (long long)st.size();
        std::vector<PV> parts(std::make_move_iterator(st.end() - n), std::make_move_iterator(st.end())); st.resize(st.size() - n);
        if (sem.r("BCAT_LSB_FIRST") || sem.r("RED_CONCATENATE")) std::reverse(parts.begin(), parts.end());
        std::vector<const PV *> pp; for (auto &p : parts) pp.push_back(&p); PV r = concat(pp);
        if ((long long)r.size() != W) throw Refuse("CONCATENATE width " + std::to_string(r.size()) + " vs " + std::to_string(W));
        st.push_back(std::move(r)); continue;
      }
      case O_MULTI_CONCATENATE: {
        long long n = A(0), rep = A(1); if (n <= 0 || (size_t)n > st.size()) n = (long long)st.size();
        std::vector<const PV *> pp; for (auto it = st.end() - n; it != st.end(); ++it) pp.push_back(&*it); PV onev = concat(pp); st.resize(st.size() - n);
        PV r = repeat(onev, rep > 0 ? (size_t)rep : 0); if (sem.r("MCAT_RED") || sem.r("RED_MULTI_CONCATENATE")) r = fit(onev, r.size());
        st.push_back(std::move(r)); continue;
      }
      case O_PAD: {
        PV a = pop(); size_t w = needW();
        if (!sem.r("PAD_RED") && !sem.r("RED_PAD")) st.push_back(fit(a, w));
        else if (a.size() < w) { PV r = fit(a, w); const char c = a.size() ? a.chr(0) : '0'; for (size_t j = a.size(); j < w; j++) r.setBit(j, c == '1' || c == 'z', c == 'x' || c == 'z'); st.push_back(std::move(r)); }
        else st.push_back(fit(a, w));
        continue;
      }
      case O_SM_LT: case O_SM_GE: case O_SM_GT: case O_SM_LE: {
        PV b = pop(), a = pop(); if (!(known(a) && known(b))) { st.push_back(one('x')); continue; }
        int c = sem.rop(op) ? ucmp(a, b) : scmp(a, b); bool r = oc == O_SM_GT ? c > 0 : oc == O_SM_LT ? c < 0 : oc == O_SM_GE ? c >= 0 : c <= 0; st.push_back(one(r ? '1' : '0')); continue;
      }
      case O_SHIFT_R: case O_SASHIFT_R: {
        PV b = pop(), a = pop(); size_t w = needW(); if (!known(b)) { st.push_back(pX(w)); continue; }
        uint64_t k = uval(b); a = fit(a, w); bool arith = oc == O_SASHIFT_R; if (sem.rop(op)) arith = !arith; char fc = arith ? (w ? a.chr(0) : '\0') : '0'; size_t kk = (size_t)std::min<uint64_t>(k, w);
        st.push_back(shr_fill(a, kk, fc)); continue;
      }
      case O_SHIFT_L: if (!sem.r("RED_SHL_XALL")) {   // as SHIFT_R: x only for an unknown shift amount; the shifted value's x bits move with it
        PV b = pop(), a = pop(); size_t w = needW(); if (!known(b)) { st.push_back(pX(w)); continue; }
        uint64_t k = uval(b) + (uint64_t)sem.r("RED_SHIFT_L"); if (k >= 4096) { st.push_back(PV(w)); continue; }
        st.push_back(shl(a, (size_t)k, w)); continue;
      }
      [[fallthrough]];   // the planted RED_SHL_XALL takes the path below (as before)
      case O_ADD: case O_SUBTRACT: case O_M_GT: case O_M_LT: case O_M_GE: case O_M_LE: {
        PV b = pop(), a = pop();
        if (op[0] == 'M') { if (!(known(a) && known(b))) { st.push_back(one('x')); continue; } int c = ucmp(a, b); if (sem.rop(op)) c = -c;
          bool r = oc == O_M_GT ? c > 0 : oc == O_M_LT ? c < 0 : oc == O_M_GE ? c >= 0 : c <= 0; st.push_back(one(r ? '1' : '0')); continue; }
        size_t w = needW(); if (!(known(a) && known(b))) { st.push_back(pX(w)); continue; }
        if (oc == O_ADD) { st.push_back(addw(a, b, w, sem.r("RED_ADD") != 0)); continue; }
        if (oc == O_SUBTRACT) { st.push_back(addw(a, b, w, sem.r("RED_SUBTRACT") == 0)); continue; }
        uint64_t k = uval(b) + (uint64_t)sem.r("RED_SHIFT_L"); if (k >= 4096) { st.push_back(PV(w)); continue; }
        st.push_back(shl(a, (size_t)k, w)); continue;
      }
      default: break;
      }
      throw Refuse("code-block word " + op + " not implemented");
    }
    if (st.size() != 1) throw Refuse("code block left " + std::to_string(st.size()) + " stack items");
    return st[0];
  }
};

// canon form of a history at width w (same-time collapse, x at 0 if it starts later, repeats dropped) + its sha256 hex
struct Sha256 {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  unsigned char buf[64]; size_t nbuf = 0; uint64_t total = 0;
  static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
  void block(const unsigned char *p) {
    static const uint32_t k[64] = {
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
      0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
      0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
      0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = uint32_t(p[4*i]) << 24 | uint32_t(p[4*i+1]) << 16 | uint32_t(p[4*i+2]) << 8 | p[4*i+3];
    for (int i = 16; i < 64; i++) { uint32_t s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >> 3), s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >> 10); w[i] = w[i-16] + s0 + w[i-7] + s1; }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) { uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]; uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c)); hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2; }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  void add(const void *data, size_t n) {
    const unsigned char *p = static_cast<const unsigned char *>(data); total += n;
    if (nbuf) { size_t t = 64 - nbuf < n ? 64 - nbuf : n; memcpy(buf + nbuf, p, t); nbuf += t; p += t; n -= t; if (nbuf == 64) { block(buf); nbuf = 0; } }
    for (; n >= 64; p += 64, n -= 64) block(p);
    if (n) { memcpy(buf, p, n); nbuf = n; }
  }
  std::string hex() {
    uint64_t bits = total * 8; unsigned char pad = 0x80; add(&pad, 1); unsigned char z = 0; while (nbuf != 56) add(&z, 1);
    unsigned char len[8]; for (int i = 0; i < 8; i++) len[i] = (unsigned char)(bits >> (56 - 8 * i)); add(len, 8);
    static const char *x = "0123456789abcdef"; std::string o; for (uint32_t v : h) for (int i = 28; i >= 0; i -= 4) o.push_back(x[(v >> i) & 15]); return o;
  }
};
inline Hist canon(const Hist &rows, size_t w, std::string *hash = nullptr) {
  Hist o;
  if (rows.empty() || rows.time(0) != 0) o.push(0, X(w));
  for (size_t i = 0; i < rows.size(); i++) {
    if (i + 1 < rows.size() && rows.time(i + 1) == rows.time(i)) continue;   // same-time collapse: the last value at a time
    if (!o.empty() && o.same(o.size() - 1, rows, i)) continue;               // repeats dropped
    o.push(rows, i);
  }
  o.shrink();
  if (hash) { Sha256 s; Val v; for (size_t i = 0; i < o.size(); i++) { o.get(i, v); std::string l = std::to_string(o.time(i)) + " " + v + "\n"; s.add(l.data(), l.size()); } *hash = s.hex(); }
  return o;
}

// ---- window evaluation: the values of a computed name over a requested window [t0, t1] only.
// The evaluator is a settled merge: a result at time t depends only on each input's last value at or before t (every
// instruction maps the input values at one time to the result at that time; merge, apply, multi and the program
// interpreter stamp results with the merge time and keep no other state). So a window needs, per stored input, only its
// value at t0 (or the fact that it has none yet) and its rows in (t0, t1]. The window is evaluated rebased (t0 -> 0), so
// the evaluator's rule for time 0 (a stored input reads x until its first row) holds at the window start as at the dump
// start. Every rule word a name uses must be on the window-safe list (window-safe-words.txt; a FORCED marker never is), or
// the name is refused by name. Refusals are the ones met on the window's own values: a name that the whole-history run
// refuses for a value outside the window can be computed in that window.
inline size_t rowsAtOrBefore(const Hist &h, uint64_t t) {   // number of rows with time <= t (h in time order)
  size_t lo = 0, hi = h.size(); while (lo < hi) { size_t m = lo + (hi - lo) / 2; if (h.time(m) <= t) lo = m + 1; else hi = m; } return lo;
}
// h cut to [t0, t1] and rebased: a first row at 0 with the last value at or before t0 (none if h has no row by then), then
// the rows in (t0, t1] at t - t0. keepState=false drops the first row (a planted error in the tests only).
inline Hist windowCut(const Hist &h, uint64_t t0, uint64_t t1, bool keepState = true) {
  if (!h.sorted()) throw Refuse("window: an input history is not in time order");
  Hist o; if (t1 < t0) return o;
  const size_t k = rowsAtOrBefore(h, t0), e = rowsAtOrBefore(h, t1);
  if (k > 0 && keepState) o.pushAt(0, h, k - 1);
  for (size_t j = k; j < e; j++) o.pushAt(h.time(j) - t0, h, j);
  o.shrink(); return o;
}
// a leaf source over another one, cut to a window (rebased); its own cache of cut histories
struct WindowSource final : LeafSource {
  LeafSource &base; uint64_t t0, t1; bool keepState = true;
  std::unordered_map<std::string, std::shared_ptr<const Hist>> cut; uint64_t bytes = 0;
  WindowSource(LeafSource &b, uint64_t a, uint64_t z) : base(b), t0(a), t1(z) {}
  std::shared_ptr<const Hist> hist(const std::string &name) override {
    auto c = cut.find(name); if (c != cut.end()) return c->second;
    auto f = base.hist(name); if (!f) return nullptr;
    auto h = std::make_shared<Hist>(windowCut(*f, t0, t1, keepState)); bytes += h->bytes(); cut.emplace(name, h); return h;
  }
  void dropCache() override { cut.clear(); bytes = 0; base.dropCache(); }
  uint64_t cachedBytes() const override { return bytes + base.cachedBytes(); }
};
// the words of a word list file (one or more per line, '#' starts a comment); readWordsText: the same from the file's text
inline void wordsOfLine(Words &w, std::string s) { auto h = s.find('#'); if (h != std::string::npos) s.resize(h);
  size_t i = 0; while (i < s.size()) { while (i < s.size() && isspace((unsigned char)s[i])) i++; size_t j = i; while (j < s.size() && !isspace((unsigned char)s[j])) j++; if (j > i) w.insert(s.substr(i, j - i)); i = j; } }
inline Words readWords(const std::string &path) {
  Words w; FILE *f = fopen(path.c_str(), "r"); if (!f) throw std::runtime_error("cannot read " + path);
  char line[4096]; while (fgets(line, sizeof line, f)) wordsOfLine(w, line);
  fclose(f); return w;
}
inline Words readWordsText(const std::string &text) { Words w; size_t a = 0; while (a < text.size()) { size_t b = text.find('\n', a); if (b == std::string::npos) b = text.size(); wordsOfLine(w, text.substr(a, b - a)); a = b + 1; } return w; }
// the words of a computed node that are not window-safe ("" when every one is); a FORCED marker never is
inline std::string notWindowSafe(const Words &used, const Words &safe) {
  std::string bad; for (auto &x : used) if (x.compare(0, 7, "FORCED:") == 0 || !safe.count(x)) bad += (bad.empty() ? "" : ",") + x; return bad;
}
// node n of an evaluator over a WindowSource (window start t0): its settled rows over the window at their own times
// (t0 first), or a refusal. bits = the declared width.
inline Hist windowHist(Eval &E, const NodeId &n, size_t bits, uint64_t t0, const Words &safe) {
  const Hist &h = E.hist(n); if (h.empty()) throw Refuse("empty history");
  if (h.width(0) != bits) throw Refuse("width " + std::to_string(h.width(0)) + " vs declared " + std::to_string(bits));
  { std::string bad = notWindowSafe(E.used[n], safe); if (!bad.empty()) throw Refuse("not window-safe: " + bad); }
  Hist c = canon(h, bits), o; for (size_t i = 0; i < c.size(); i++) o.pushAt(c.time(i) + t0, c, i);
  o.shrink(); return o;
}

}  // namespace dblk
