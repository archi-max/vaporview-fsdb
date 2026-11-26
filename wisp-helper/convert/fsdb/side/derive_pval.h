// SPDX-License-Identifier: MIT
// derive_pval.h (file-only route): the packed 4-state value the evaluator computes on (class PV), and its operators.
// A value of width w is two bit planes in words: plane a holds 1 for '1' or 'z', plane b holds 1 for 'x' or 'z' (the
// planes of class Hist), with numeric bit order (bit 0 = the least significant bit = the last text position). Bits at
// or above w are always 0. Every operator gives exactly the value the text operator of the same name gives (the text
// form: a string MSB first over 0 1 x z); where the text operators zip two operands of different widths (the shorter
// one bounds the result, over the leading text positions), these take the same leading (most significant) bits.
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace dblk {

class PV {
  uint32_t w_ = 0;
  uint64_t in_[2] = {0, 0};          // w <= 64: plane a = in_[0], plane b = in_[1]
  std::vector<uint64_t> big_;        // w > 64: plane a = words [0, n), plane b = words [n, 2n)
public:
  PV() = default;
  explicit PV(size_t w) { resize(w); }
  static size_t words(size_t w) { return (w + 63) / 64; }
  size_t width() const { return w_; }
  size_t size() const { return w_; }
  size_t nw() const { return words(w_); }
  bool small() const { return w_ <= 64; }
  uint64_t *A() { return small() ? &in_[0] : big_.data(); }
  uint64_t *B() { return small() ? &in_[1] : big_.data() + nw(); }
  const uint64_t *A() const { return small() ? &in_[0] : big_.data(); }
  const uint64_t *B() const { return small() ? &in_[1] : big_.data() + nw(); }
  // width w, every bit 0
  void resize(size_t w) {
    w_ = (uint32_t)w; in_[0] = in_[1] = 0;
    if (w > 64) big_.assign(2 * words(w), 0); else if (!big_.empty()) big_.clear();
  }
  uint64_t topMask() const { const unsigned r = w_ & 63; return r ? (~uint64_t(0) >> (64 - r)) : ~uint64_t(0); }
  // clear the bits at or above w in both planes (after a word operation)
  void trim() { if (!w_) return; const size_t n = nw(); const uint64_t m = topMask(); A()[n - 1] &= m; B()[n - 1] &= m; }
  int bitA(size_t j) const { return (int)((A()[j >> 6] >> (j & 63)) & 1); }
  int bitB(size_t j) const { return (int)((B()[j >> 6] >> (j & 63)) & 1); }
  void setBit(size_t j, int a, int b) {
    const uint64_t m = uint64_t(1) << (j & 63); uint64_t &x = A()[j >> 6], &y = B()[j >> 6];
    x = a ? (x | m) : (x & ~m); y = b ? (y | m) : (y & ~m);
  }
  // the text character at text position p (0 = most significant)
  char chr(size_t p) const { const size_t j = w_ - 1 - p; const int a = bitA(j), b = bitB(j); return b ? (a ? 'z' : 'x') : (a ? '1' : '0'); }
  bool operator==(const PV &o) const {
    if (w_ != o.w_) return false; const size_t n = nw();
    for (size_t k = 0; k < n; k++) if (A()[k] != o.A()[k] || B()[k] != o.B()[k]) return false;
    return true;
  }
  bool operator!=(const PV &o) const { return !(*this == o); }
  // ---- text form
  // false: a character other than 0 1 x z (the value is left at width s.size(), its planes undefined)
  bool fromText(const std::string &s) {
    resize(s.size()); const size_t w = s.size(); uint64_t *a = A(), *b = B();
    for (size_t p = 0; p < w; p++) {
      const char c = s[p]; const size_t j = w - 1 - p; const uint64_t m = uint64_t(1) << (j & 63);
      if (c == '1') a[j >> 6] |= m; else if (c == 'x') b[j >> 6] |= m; else if (c == 'z') { a[j >> 6] |= m; b[j >> 6] |= m; } else if (c != '0') return false;
    }
    return true;
  }
  std::string text() const { std::string s(w_, '0'); for (size_t p = 0; p < w_; p++) s[p] = chr(p); return s; }
  void text(std::string &s) const { s.resize(w_); for (size_t p = 0; p < w_; p++) s[p] = chr(p); }
};

namespace pvd {
inline uint64_t rev64(uint64_t x) {
  x = ((x >> 1) & 0x5555555555555555ull) | ((x & 0x5555555555555555ull) << 1);
  x = ((x >> 2) & 0x3333333333333333ull) | ((x & 0x3333333333333333ull) << 2);
  x = ((x >> 4) & 0x0F0F0F0F0F0F0F0Full) | ((x & 0x0F0F0F0F0F0F0F0Full) << 4);
  return __builtin_bswap64(x);
}
// 64 bits of a little-endian bit stream of nbits bits (bit i = byte i >> 3, bit i & 7) starting at bit s (s may be
// negative; bits outside [0, nbits) read 0)
inline uint64_t loadBytes(const uint8_t *p, size_t nbytes, long long s) {
  uint64_t r = 0;
  if (s >= 0) {
    const size_t b0 = (size_t)s >> 3; const unsigned sh = (unsigned)(s & 7);
    uint8_t t[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0}; const size_t k = b0 < nbytes ? std::min<size_t>(9, nbytes - b0) : 0; if (k) memcpy(t, p + b0, k);
    uint64_t lo; memcpy(&lo, t, 8); r = lo >> sh; if (sh) r |= (uint64_t)t[8] << (64 - sh);
  } else if (s > -64) { const uint64_t v = loadBytes(p, nbytes, 0); r = v << (unsigned)(-s); }
  return r;
}
// the same over a word array (bit i = word i >> 6, bit i & 63)
inline uint64_t loadWords(const uint64_t *p, size_t nw, long long s) {
  if (s <= -64) return 0;
  if (s < 0) return nw ? p[0] << (unsigned)(-s) : 0;
  const size_t k = (size_t)s >> 6; const unsigned sh = (unsigned)(s & 63);
  const uint64_t lo = k < nw ? p[k] : 0; if (!sh) return lo;
  const uint64_t hi = k + 1 < nw ? p[k + 1] : 0; return (lo >> sh) | (hi << (64 - sh));
}
// bits [lo, lo + n) of a word array (n <= 64)
inline uint64_t field(const uint64_t *p, size_t nw, size_t lo, size_t n) { uint64_t v = loadWords(p, nw, (long long)lo); return n >= 64 ? v : (v & ((uint64_t(1) << n) - 1)); }
}  // namespace pvd

// ---- class Hist planes (text order: text position q is bit q & 7 of byte q >> 3; pl = (w + 7) / 8 bytes per plane)
inline void pvFromPlanes(PV &v, size_t w, const uint8_t *p) {
  v.resize(w); const size_t pl = (w + 7) / 8, n = v.nw(); uint64_t *a = v.A(), *b = v.B();
  for (size_t k = 0; k < n; k++) {   // numeric word k = text positions [w - 64k - 64, w - 64k), reversed
    const long long s = (long long)w - 64 * (long long)k - 64;
    a[k] = pvd::rev64(pvd::loadBytes(p, pl, s)); b[k] = pvd::rev64(pvd::loadBytes(p + pl, pl, s));
  }
  v.trim();
}
inline void pvToPlanes(const PV &v, uint8_t *p) {   // p: 2 * ((w + 7) / 8) bytes
  const size_t w = v.width(), pl = (w + 7) / 8, n = v.nw(), tw = (w + 63) / 64;
  for (int pln = 0; pln < 2; pln++) {
    const uint64_t *src = pln ? v.B() : v.A(); uint8_t *dst = p + pln * pl;
    for (size_t m = 0; m < tw; m++) {   // text word m = numeric bits [w - 64m - 64, w - 64m), reversed
      const long long s = (long long)w - 64 * (long long)m - 64;
      uint64_t t = pvd::rev64(pvd::loadWords(src, n, s));
      if (64 * m + 64 > w) { const size_t keep = w - 64 * m; t &= keep >= 64 ? ~uint64_t(0) : ((uint64_t(1) << keep) - 1); }
      const size_t off = 8 * m, k = std::min<size_t>(8, pl - off); memcpy(dst + off, &t, k);
    }
  }
}

// ---- operators (each the text operator of the same name; see derive_eval.h)
namespace pvo {
inline uint64_t mask(size_t n) { return n >= 64 ? ~uint64_t(0) : ((uint64_t(1) << n) - 1); }
// the n most significant bits of v (its first n text positions) as a value of width n (n <= v.width())
inline void top(const PV &v, size_t n, PV &r) {
  r.resize(n); const size_t sh = v.width() - n, nw = v.nw(), rn = r.nw();
  for (size_t k = 0; k < rn; k++) { const size_t lo = sh + 64 * k, cnt = std::min<size_t>(64, n - 64 * k);
    r.A()[k] = pvd::field(v.A(), nw, lo, cnt); r.B()[k] = pvd::field(v.B(), nw, lo, cnt); }
}
// bits [lo, lo + n) of v as a value of width n (bits at or above v.width() read 0)
inline void bits(const PV &v, size_t lo, size_t n, PV &r) {
  r.resize(n); const size_t nw = v.nw(), rn = r.nw();
  for (size_t k = 0; k < rn; k++) { const size_t cnt = std::min<size_t>(64, n - 64 * k);
    r.A()[k] = pvd::field(v.A(), nw, lo + 64 * k, cnt); r.B()[k] = pvd::field(v.B(), nw, lo + 64 * k, cnt); }
}
// r |= v << at (r wide enough; v's bits land at [at, at + v.width()))
inline void place(PV &r, const PV &v, size_t at) {
  const size_t vn = v.nw(), rn = r.nw();
  for (size_t k = 0; k < vn; k++) {
    const uint64_t a = v.A()[k], b = v.B()[k]; const size_t j = at + 64 * k, q = j >> 6; const unsigned sh = (unsigned)(j & 63);
    if (q < rn) { r.A()[q] |= a << sh; r.B()[q] |= b << sh; }
    if (sh && q + 1 < rn) { r.A()[q + 1] |= a >> (64 - sh); r.B()[q + 1] |= b >> (64 - sh); }
  }
}
// bits [at, at + v.width()) of r set to v (both planes; r wide enough)
inline void setField(PV &r, size_t at, const PV &v) {
  const size_t n = v.width(); size_t j = 0;
  while (j < n) {
    const size_t q = (at + j) >> 6, sh = (at + j) & 63, cnt = std::min<size_t>(64 - sh, n - j);
    const uint64_t m = mask(cnt) << sh, fa = pvd::field(v.A(), v.nw(), j, cnt) << sh, fb = pvd::field(v.B(), v.nw(), j, cnt) << sh;
    r.A()[q] = (r.A()[q] & ~m) | fa; r.B()[q] = (r.B()[q] & ~m) | fb; j += cnt;
  }
}
inline bool known(const PV &v) { const size_t n = v.nw(); for (size_t k = 0; k < n; k++) if (v.B()[k]) return false; return true; }
inline bool hasZ(const PV &v) { const size_t n = v.nw(); for (size_t k = 0; k < n; k++) if (v.A()[k] & v.B()[k]) return true; return false; }
inline PV pX(size_t w) { PV r(w); const size_t n = r.nw(); for (size_t k = 0; k < n; k++) r.B()[k] = ~uint64_t(0); r.trim(); return r; }
inline PV zeros(size_t w) { return PV(w); }
inline PV one(char c) { PV r(1); r.setBit(0, c == '1' || c == 'z', c == 'x' || c == 'z'); return r; }
// fit: the last w text positions (low bits) or '0'-padded in front
inline PV fit(const PV &v, size_t w) {
  if (v.width() == w) return v;
  PV r; if (v.width() >= w) { bits(v, 0, w, r); return r; }
  r.resize(w); const size_t n = v.nw(); for (size_t k = 0; k < n; k++) { r.A()[k] = v.A()[k]; r.B()[k] = v.B()[k]; } return r;
}
inline PV b_not(const PV &a) {
  PV r(a.width()); const size_t n = a.nw();
  for (size_t k = 0; k < n; k++) { const uint64_t x = a.A()[k], y = a.B()[k]; r.A()[k] = ~x & ~y; r.B()[k] = y; }
  r.trim(); return r;
}
// the zipped pair: the leading n = min(widths) positions of each
struct Zip { PV a, b; const PV *pa, *pb; size_t n;
  Zip(const PV &x, const PV &y) { n = std::min(x.width(), y.width()); pa = &x; pb = &y;
    if (x.width() != n) { top(x, n, a); pa = &a; } if (y.width() != n) { top(y, n, b); pb = &b; } } };
inline PV b_and(const PV &x, const PV &y) {
  Zip z(x, y); PV r(z.n); const size_t n = r.nw();
  for (size_t k = 0; k < n; k++) { const uint64_t a1 = z.pa->A()[k], b1 = z.pa->B()[k], a2 = z.pb->A()[k], b2 = z.pb->B()[k];
    const uint64_t k0 = (~a1 & ~b1) | (~a2 & ~b2), k1 = (a1 & ~b1) & (a2 & ~b2); r.A()[k] = k1; r.B()[k] = ~(k0 | k1); }
  r.trim(); return r;
}
inline PV b_or(const PV &x, const PV &y) {
  Zip z(x, y); PV r(z.n); const size_t n = r.nw();
  for (size_t k = 0; k < n; k++) { const uint64_t a1 = z.pa->A()[k], b1 = z.pa->B()[k], a2 = z.pb->A()[k], b2 = z.pb->B()[k];
    const uint64_t k1 = (a1 & ~b1) | (a2 & ~b2), k0 = (~a1 & ~b1) & (~a2 & ~b2); r.A()[k] = k1; r.B()[k] = ~(k0 | k1); }
  r.trim(); return r;
}
inline PV b_xor(const PV &x, const PV &y) {
  Zip z(x, y); PV r(z.n); const size_t n = r.nw();
  for (size_t k = 0; k < n; k++) { const uint64_t a1 = z.pa->A()[k], b1 = z.pa->B()[k], a2 = z.pb->A()[k], b2 = z.pb->B()[k];
    const uint64_t kn = ~b1 & ~b2; r.A()[k] = (a1 ^ a2) & kn; r.B()[k] = ~kn; }
  r.trim(); return r;
}
inline PV b_xnor(const PV &x, const PV &y) { return b_not(b_xor(x, y)); }
inline PV l_eq(const PV &x, const PV &y) {
  { Zip z(x, y); const size_t n = PV::words(z.n);
    for (size_t k = 0; k < n; k++) { const uint64_t a1 = z.pa->A()[k], b1 = z.pa->B()[k], a2 = z.pb->A()[k], b2 = z.pb->B()[k];
      if ((a1 ^ a2) & ~b1 & ~b2) return one('0'); } }
  return one(known(x) && known(y) ? '1' : 'x');
}
inline PV c_eq(const PV &x, const PV &y) { return one(x == y ? '1' : '0'); }
inline char truth(const PV &v) {
  const size_t n = v.nw(); bool all0 = true;
  for (size_t k = 0; k < n; k++) { const uint64_t a = v.A()[k], b = v.B()[k]; if (a & ~b) return '1'; if (b) all0 = false; }
  return all0 ? '0' : 'x';
}
inline PV cond(const PV &c, const PV &x, const PV &y) {
  const char t = truth(c); if (t == '1') return x; if (t == '0') return y;
  Zip z(x, y); PV r(z.n); const size_t n = r.nw();
  for (size_t k = 0; k < n; k++) { const uint64_t a1 = z.pa->A()[k], b1 = z.pa->B()[k], a2 = z.pb->A()[k], b2 = z.pb->B()[k];
    const uint64_t e = ~b1 & ~b2 & ~(a1 ^ a2); r.A()[k] = a1 & e; r.B()[k] = ~e; }
  r.trim(); return r;
}
inline PV red_xor(const PV &v) {
  if (!known(v)) return one('x'); const size_t n = v.nw(); unsigned c = 0;
  for (size_t k = 0; k < n; k++) c += (unsigned)__builtin_popcountll(v.A()[k]);
  return one((c & 1) ? '1' : '0');
}
inline PV inv1(const PV &r) {
  if (r.width() == 1 && !r.bitB(0)) return one(r.bitA(0) ? '0' : '1');
  return one('x');
}
// kind 0 = resolved net, 1 = wired AND, 2 = wired OR (resolve in derive_eval.h)
inline PV resolve(const std::vector<const PV *> &vs, int kind) {
  size_t n = SIZE_MAX; for (auto *p : vs) n = std::min(n, p->width()); if (vs.empty()) n = 0;
  PV r(n); const size_t nw = r.nw(); std::vector<PV> tops(vs.size()); std::vector<const PV *> ps(vs.size());
  for (size_t i = 0; i < vs.size(); i++) { if (vs[i]->width() == n) ps[i] = vs[i]; else { top(*vs[i], n, tops[i]); ps[i] = &tops[i]; } }
  for (size_t k = 0; k < nw; k++) {
    uint64_t h0 = 0, h1 = 0, hx = 0, any = 0;
    for (auto *p : ps) { const uint64_t a = p->A()[k], b = p->B()[k]; h0 |= ~a & ~b; h1 |= a & ~b; hx |= ~a & b; any |= ~(a & b); }
    uint64_t o0, o1;   // result 0 / 1; neither = x; !any = z
    if (kind == 1) { o0 = h0; o1 = ~h0 & h1 & ~hx; }
    else if (kind == 2) { o1 = h1; o0 = ~h1 & h0 & ~hx; }
    else { o0 = h0 & ~h1 & ~hx; o1 = h1 & ~h0 & ~hx; }
    o0 &= any; o1 &= any; const uint64_t z = ~any, x = any & ~o0 & ~o1;
    r.A()[k] = o1 | z; r.B()[k] = x | z;
  }
  r.trim(); return r;
}
inline int pbitof(long long c, size_t j) { return j < 63 ? (int)((c >> j) & 1) : (c < 0); }
inline PV pbits_of(long long c, size_t W) {
  PV r(W); const size_t n = r.nw();
  for (size_t k = 0; k < n; k++) r.A()[k] = k == 0 ? (uint64_t)c : (c < 0 ? ~uint64_t(0) : 0);
  if (W > 63) for (size_t j = 63; j < std::min<size_t>(W, 64); j++) r.setBit(j, c < 0, 0);   // bit 63 is the sign as above
  r.trim(); return r;
}
static const uint64_t SAT = uint64_t(1) << 62;
inline uint64_t uval(const PV &v) {   // counts the '1' positions only; any at or above bit 62 -> SAT
  const size_t n = v.nw(); uint64_t r = 0;
  for (size_t k = 0; k < n; k++) { const uint64_t one1 = v.A()[k] & ~v.B()[k]; if (!one1) continue;
    if (k > 0 || (one1 >> 62)) return SAT; r = one1; }
  return r;
}
// unsigned compare of the '1' patterns (known values): the highest set bit first
inline int ucmp(const PV &x, const PV &y) {
  const size_t n = std::max(x.nw(), y.nw());
  for (size_t k = n; k-- > 0;) {
    const uint64_t a = k < x.nw() ? (x.A()[k] & ~x.B()[k]) : 0, b = k < y.nw() ? (y.A()[k] & ~y.B()[k]) : 0;
    if (a != b) return a < b ? -1 : 1;
  }
  return 0;
}
// signed compare, each at its own width (known values)
inline int scmp(const PV &x, const PV &y) {
  const bool na = x.width() && x.chr(0) == '1', nb = y.width() && y.chr(0) == '1'; if (na != nb) return na ? -1 : 1;
  const size_t W = std::max(x.width(), y.width());
  auto ext = [&](const PV &v) { PV r = fit(v, W); if (na) for (size_t j = v.width(); j < W; j++) r.setBit(j, 1, 0); return r; };
  const PV X1 = ext(x), Y1 = ext(y);
  for (size_t k = PV::words(W); k-- > 0;) {   // the text compare of equal-length strings: '0' < '1' < 'x' < 'z' (known: 0 / 1 only)
    const uint64_t a = X1.A()[k], b = Y1.A()[k];
    if (a != b) return a < b ? -1 : 1;
  }
  return 0;
}
inline PV addw(const PV &x, const PV &y, size_t W, bool sub) {   // (x + y) or (x - y) mod 2^W over the '1' positions
  const PV A = fit(x, W), B = fit(y, W); PV r(W); const size_t n = r.nw(); unsigned __int128 carry = sub ? 1 : 0;
  for (size_t k = 0; k < n; k++) {
    const uint64_t a = A.A()[k] & ~A.B()[k]; uint64_t b = B.A()[k] & ~B.B()[k]; if (sub) b = ~b;
    const unsigned __int128 s = (unsigned __int128)a + b + carry; r.A()[k] = (uint64_t)s; carry = s >> 64;
  }
  r.trim(); return r;
}
// concatenation of text forms: parts[0] is the most significant
inline PV concat(const std::vector<const PV *> &parts) {
  size_t W = 0; for (auto *p : parts) W += p->width(); PV r(W); size_t at = W;
  for (auto *p : parts) { at -= p->width(); place(r, *p, at); }
  return r;
}
inline PV repeat(const PV &v, size_t rep) {
  PV r(v.width() * rep); for (size_t q = 0; q < rep; q++) place(r, v, q * v.width()); return r;
}
// (v >> k), the top k positions filled with the character fc ('0' for a logical shift)
inline PV shr_fill(const PV &v, size_t k, char fc) {
  const size_t w = v.width(); PV r; if (k >= w) r.resize(w); else { bits(v, k, w - k, r); PV t(w); place(t, r, 0); r = std::move(t); }
  const int fa = fc == '1' || fc == 'z', fb = fc == 'x' || fc == 'z';
  if (fa || fb) for (size_t j = (k >= w ? 0 : w - k); j < w; j++) r.setBit(j, fa, fb);
  return r;
}
// (v << k) at width w (the low k bits 0; bits past w dropped)
inline PV shl(const PV &v, size_t k, size_t w) {
  PV r(w); if (k >= w) return r; PV lo; bits(v, 0, std::min(v.width(), w - k), lo); place(r, lo, k); return r;
}
}  // namespace pvo

}  // namespace dblk
