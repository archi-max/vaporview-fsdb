// SPDX-License-Identifier: MIT
// wcz_block.h: WCZ1 value-change blocks (SPEC.md §II.5, §II.6.4, §II.6.5): the encoder (XOR / DICT / STR payloads,
// optional keyframe chunks, zstd), the strict decoder (whole block, or one chunk for a bounded point read) and
// the normalised-stream counter.
//
// Block bytes are untrusted. decodeBlock / decodeChunk check every rule of §II.6.4–§II.6.5 and never read outside the
// buffer they are given or allocate beyond the §II.10 limits.
// The codec knows nothing about files, so converters and tests can encode and check blocks without building one.
#pragma once
#include "wcz_base.h"
#include <algorithm>
#include <cstdio>
#include <zstd.h>
#ifdef WCZ_HOTPATH_TEST
#include <atomic>
#endif
#include <memory>

namespace wcz {

// A decode budget: the most bytes one decode call may hold (payload scratch, seek table and decoded rows). NO_BUDGET
// leaves only the §II.10 limits.
static const uint64_t NO_BUDGET = ~0ull;

// Per-thread decode counters (tests and benchmarks): payload bytes decompressed, time deltas parsed, rows whose
// values were decoded.
struct DecodeStats { uint64_t rawBytes = 0, timeRows = 0, valueRows = 0; };
static inline DecodeStats &decodeStats() { static thread_local DecodeStats d; return d; }

// What a block needs from its signal's declaration (SIGD).
struct SigSpec {
  uint8_t vtype = VT_BITS; uint32_t bits = 1, vlen = 1; bool fourState = false; uint32_t keyRows = 0;
  static uint32_t vlenFor(uint8_t vtype, uint32_t bits, bool fourState) { return vtype == VT_REAL ? 8 : vtype == VT_STRING ? 0 : (fourState ? 2 : 1) * ((bits + 7) / 8); }
  bool valid(std::string &err) const {
    if (vtype > VT_STRING) { err = "unknown value type"; return false; }
    if (vtype == VT_BITS && (bits < 1 || bits > MAX_BITS)) { err = "bad bit width"; return false; }
    if (vtype == VT_REAL && (bits != 64 || fourState)) { err = "bad real declaration"; return false; }
    if (vtype == VT_STRING && (bits != 0 || fourState)) { err = "bad string declaration"; return false; }
    if (vlen != vlenFor(vtype, bits, fourState)) { err = "bad value length"; return false; }
    if (keyRows != 0 && (keyRows < MIN_KEY_ROWS || keyRows > MAX_BLOCK_ROWS_TARGET)) { err = "bad keyframe interval"; return false; }
    return true;
  }
};

// A run of changes. Fixed-size values: v holds n * vlen bytes. Strings: v holds the bytes, off holds n + 1 offsets.
// WCZ_ROWS_ALLOC: the allocator template of decoded rows' vectors (default std::allocator). A host can define it
// before including this header, e.g. to map large row buffers and give them back to the OS when freed.
#ifndef WCZ_ROWS_ALLOC
#define WCZ_ROWS_ALLOC std::allocator
#endif
struct Rows {
  std::vector<uint64_t, WCZ_ROWS_ALLOC<uint64_t>> t; std::vector<uint8_t, WCZ_ROWS_ALLOC<uint8_t>> v; std::vector<uint64_t, WCZ_ROWS_ALLOC<uint64_t>> off{0};
  uint32_t n() const { return (uint32_t)t.size(); }
  void clear() { t.clear(); v.clear(); off.assign(1, 0); }
  const uint8_t *val(uint32_t i, uint32_t vlen) const { return vlen ? &v[(size_t)i * vlen] : v.data() + off[i]; }
  size_t len(uint32_t i, uint32_t vlen) const { return vlen ? vlen : (size_t)(off[i + 1] - off[i]); }
  void push(uint64_t tt, const uint8_t *p, size_t l) { t.push_back(tt); v.insert(v.end(), p, p + l); off.push_back(v.size()); }
  // fixed-width rows (vlen > 0): off is not used by val/len, so it is not kept
  void pushFixed(uint64_t tt, const uint8_t *p, size_t l) { t.push_back(tt); v.insert(v.end(), p, p + l); }
};

// BlockEnt fields that describe one block (§II.6.1), independent of where it lives.
struct BlockInfo { uint32_t rows = 0, nNorm = 0, rsize = 0, len = 0; uint16_t nchunk = 1; uint8_t mode = 0, flags = 0; uint64_t t0 = 0, tLast = 0, xxh = 0; };
struct SeekEnt { uint32_t row, csize, rsize, pad; uint64_t t, xxh; };

static inline uint32_t expectedChunks(uint32_t rows, uint32_t K) { return (K && rows > K) ? (rows + K - 1) / K : 1; }

// Writer block sizes. A block's pending bytes are its value bytes plus 24 per row (time delta, DICT/STR index and
// length); BLOCK_BYTES is the default byte target, BLOCK_BYTES_MAX keeps every payload candidate within MAX_RSIZE.
static const uint64_t BLOCK_BYTES = 32ull << 20, BLOCK_BYTES_MAX = MAX_RSIZE;
static inline uint64_t pendingBytes(uint32_t rows, uint64_t valueBytes) { return valueBytes + (uint64_t)rows * 24; }
// Whether a signal's pending rows (rows, valueBytes) must become a block before a row of len value bytes. A block at
// its row or byte target closes when time advances; at MAX_ROWS rows, or when the row would take it past
// BLOCK_BYTES_MAX, it closes at the same time (split = true).
// minRows: the byte target applies only from minRows rows on (the dynamic policy's lower clamp; 0 = always).
static inline bool closeBefore(uint32_t rows, uint64_t valueBytes, size_t len, bool timeAdv, uint32_t blockRows, uint64_t blockBytes, bool &split, uint32_t minRows = 0) {
  split = false; if (!rows) return false;
  const uint64_t pb = pendingBytes(rows, valueBytes);
  if ((rows >= blockRows || (rows >= minRows && pb >= blockBytes)) && timeAdv) return true;
  if (rows >= MAX_ROWS || pb + len + 24 > BLOCK_BYTES_MAX) { split = !timeAdv; return true; }
  return false;
}

// ---------------------------------------------------------------- normalised counter (§II.5)
// Fed change by change in stream order; perBlock[b] counts kept changes whose raw change lies in block b.
struct NormCounter {
  bool fourState = false; uint32_t bits = 0, vlen = 0; uint8_t vtype = VT_BITS;
  std::vector<uint8_t> kept, pend, allX; bool hasKept = false, hasPend = false; uint64_t pendT = 0; size_t pendBlock = 0;
  std::vector<uint64_t> perBlock; uint64_t total = 0;
  void init(const SigSpec &s) {
    vtype = s.vtype; bits = s.bits; vlen = s.vlen; fourState = s.fourState; hasKept = hasPend = false; total = 0; perBlock.clear();
    allX.assign(vlen, 0); if (fourState) for (uint32_t i = 0; i < bits; i++) allX[vlen / 2 + (i >> 3)] |= (uint8_t)(1u << (i & 7));
  }
  // Allocation-free on the hot path: pend/kept are swapped rather than copied; perBlock grows once per block.
  void settle() {
    if (!hasPend) return;
    bool same = hasKept ? eq(pend, kept) : (fourState && eq(pend, allX));
    if (!same) { std::swap(kept, pend); hasKept = true; total++; if (perBlock.size() <= pendBlock) perBlock.resize(pendBlock + 1, 0); perBlock[pendBlock]++; }
    hasPend = false;
  }
  void change(size_t block, uint64_t t, const uint8_t *v, size_t len) {
    if (perBlock.size() <= block) perBlock.resize(block + 1, 0);
    if (hasPend && t != pendT) settle();
    pend.resize(len); if (len) memcpy(pend.data(), v, len); pendT = t; pendBlock = block; hasPend = true;
  }
  static bool eq(const std::vector<uint8_t> &a, const std::vector<uint8_t> &b) { return a.size() == b.size() && (a.empty() || !memcmp(a.data(), b.data(), a.size())); }
  void finish() { settle(); }
};

// ---------------------------------------------------------------- encoder
// Speed techniques from wcbfast.h: one per-thread workspace (raw candidates, compressed buffers, the DICT hash
// table, the ZSTD_CCtx) shared by every encoder on the thread; raw-pointer writes; word-wise XOR and x/z checks;
// a finalised hash (slotOf) for the DICT table. For a block without keyframes the output is byte-identical to a
// wcbfast/wcb.h block on the same rows (tested).
// zstd at run time must be 1.4.0 or newer (ZSTD_compress2 and the parameter API). When our zstd calls bind to an
// older copy (a library bundling its own, exporting its symbols), contexts cross between copies: encoding, decoding,
// SegWriter::begin and SegReader::open refuse instead. The message is printed to stderr once per process; nullptr = OK.
static inline const char *zstdTooOld() {
  static const std::string msg = [] {
    const unsigned v = ZSTD_versionNumber(); if (v >= 10400) return std::string();
    char b[512]; snprintf(b, sizeof b, "wcz: zstd %u.%u.%u at run time, 1.4.0 or newer needed: an older zstd (one bundled in another library) is in the process and our zstd calls bind to it; link our zstd statically with hidden symbols (libzstd.a ahead of the other libraries with -Wl,--exclude-libs,ALL, or a copy built with -fvisibility=hidden)", v / 10000, v / 100 % 100, v % 100);
    fprintf(stderr, "%s\n", b); return std::string(b);
  }();
  return msg.empty() ? nullptr : msg.c_str();
}

#ifdef WCZ_HOTPATH_TEST
static std::atomic<uint64_t> testCompress{0}, testChunks{0};  // zstd calls; fixed-width chunks encoded
#endif
namespace encdetail {
// Raw candidate bytes for n rows stored at width w (vlen > 0; w = vlen / 2 for an F_2ST block, else vlen) or n string
// rows of str bytes in all (vlen = 0): times <= 10 B a row, XOR / RAW / BPL rows w B, DICT rows <= w + 1 B or a <= 5 B index.
static inline size_t rawBound(uint32_t n, uint32_t vlen, uint32_t w, size_t str) { return (size_t)n * 10 + (vlen ? (size_t)n * ((size_t)w + 10) : (size_t)n * 20 + str); }
static inline uint8_t *putVarP(uint8_t *p, uint64_t v) { while (v >= 0x80) { *p++ = (uint8_t)(v | 0x80); v >>= 7; } *p++ = (uint8_t)v; return p; }
static inline void xorRow(uint8_t *dst, const uint8_t *a, const uint8_t *b, uint32_t w) {
  uint32_t j = 0;
  for (; j + 8 <= w; j += 8) { uint64_t x, y; memcpy(&x, a + j, 8); memcpy(&y, b + j, 8); x ^= y; memcpy(dst + j, &x, 8); }
  for (; j < w; j++) dst[j] = a[j] ^ b[j];
}
static inline bool anyNonzero(const uint8_t *p, uint32_t n) {
  uint32_t j = 0; uint64_t acc = 0;
  for (; j + 8 <= n; j += 8) { uint64_t x; memcpy(&x, p + j, 8); acc |= x; }
  for (; j < n; j++) acc |= p[j];
  return acc != 0;
}
static inline uint32_t slotOf(uint64_t h, uint32_t cap) { h ^= h >> 33; h *= 0xff51afd7ed558ccdull; h ^= h >> 33; h *= 0xc4ceb9fe1a85ec53ull; h ^= h >> 33; return (uint32_t)h & (cap - 1); }
struct Workspace {
  // raw candidates xb (XOR, STR), db (DICT) and their compressed copies
  std::vector<uint8_t> xb, db, cbx, cbd, zero; std::vector<int32_t> tab; std::vector<uint64_t> tagh; std::vector<uint32_t> dvi;
  ZSTD_CCtx *zc = nullptr; int zl = -1000;
  ~Workspace() { if (zc) ZSTD_freeCCtx(zc); }
  // grows a scratch buffer to exactly n bytes (no geometric growth: the workspace is the high-water of what blocks
  // needed, so a half-width block followed by a full-width one doesn't leave twice the half-width size); contents are
  // not kept (every chunk rebuilds them), so the old buffer is freed before the new one is allocated
  static void growTo(std::vector<uint8_t> &v, size_t n) { if (v.size() >= n) return; if (v.capacity() < n) { std::vector<uint8_t>().swap(v); v.reserve(n); } v.resize(n); }  // the old buffer is freed first
  void ensure(size_t rawMax, uint32_t n, uint32_t vlen, bool extra = false) {
    growTo(xb, rawMax); growTo(db, rawMax);
    size_t cb = ZSTD_compressBound(rawMax); growTo(cbx, cb); growTo(cbd, cb);
    (void)extra;
    if (zero.size() < vlen) zero.assign(vlen, 0);
    uint32_t cap = 1; while (cap < 2 * n) cap <<= 1; if (tab.size() < cap) { tab.assign(cap, -1); tagh.assign(cap, 0); }
    if (!zc) zc = ZSTD_createCCtx();
  }
  std::vector<uint8_t> &rawOf(int m) { return m == M_DICT ? db : xb; }
  std::vector<uint8_t> &cbOf(int m) { return m == M_DICT ? cbd : cbx; }
  size_t z(int level, const uint8_t *src, size_t n, uint8_t *dst, size_t cap) {
    if (level != zl) { ZSTD_CCtx_reset(zc, ZSTD_reset_session_and_parameters); ZSTD_CCtx_setParameter(zc, ZSTD_c_compressionLevel, level); zl = level; }
#ifdef WCZ_HOTPATH_TEST
    testCompress++;
#endif
    return ZSTD_compress2(zc, dst, cap, src, n);
  }
};
static inline Workspace &ws() { static thread_local Workspace w; return w; }
}  // namespace encdetail

class BlockEncoder {
 public:
  // oneCandidate (opt-in, default off): a single-chunk fixed-width block whose candidates are exactly XOR and DICT
  // compresses only the one with the smaller raw payload (ties: XOR), instead of compressing both and keeping the
  // smaller output. A valid block of the same rows either way (decodes to the same values); its bytes, and rarely its
  // size, can differ. Off: byte-identical to the two-candidate encoder.
  explicit BlockEncoder(int level = 3, bool oneCandidate = false) : level_(level), one_(oneCandidate) {}

  // Encodes rows [a, b) of r as one block. Appends the block bytes to out; fills info (nNorm is the caller's).
  bool encode(const SigSpec &s, const Rows &r, uint32_t a, uint32_t b, std::vector<uint8_t> &out, BlockInfo &info, std::string &err) {
    using namespace encdetail;
    if (const char *z = zstdTooOld()) { err = z; return false; }
    if (!s.valid(err)) return false;
    uint32_t rows = b - a; if (b < a || rows == 0 || rows > MAX_ROWS) { err = "bad block row count"; return false; }
    if (r.t.size() < b) { err = "fewer rows than requested"; return false; }
    for (uint32_t i = a + 1; i < b; i++) if (r.t[i] < r.t[i - 1]) { err = "times decrease"; return false; }
    if (s.vlen) {
      if ((uint64_t)rows * s.vlen > MAX_DECODED) { err = "block too large"; return false; }
      if (r.v.size() < (size_t)b * s.vlen) { err = "rows hold fewer value bytes than declared"; return false; }
      if (s.vtype == VT_BITS && (s.bits & 7)) {
        uint8_t mask = (uint8_t)(0xFF << (s.bits & 7)); uint32_t pl = (s.bits + 7) / 8;
        for (uint32_t i = a; i < b; i++) { const uint8_t *c = r.val(i, s.vlen); if ((c[pl - 1] & mask) || (s.fourState && (c[2 * pl - 1] & mask))) { err = "value bits set past the signal width"; return false; } }
      }
    } else {
      if (r.off.size() < (size_t)b + 1) { err = "string offsets missing"; return false; }
      for (uint32_t i = a; i < b; i++) if (r.off[i + 1] < r.off[i] || r.off[i + 1] > r.v.size() || r.len(i, 0) > MAX_STR) { err = "string too long or bad offsets"; return false; }
      if (r.off[b] - r.off[a] > MAX_DECODED) { err = "block too large"; return false; }  // §II.10: the block's STR total
    }
    return encodeWith(s, r, a, b, out, info, err);
  }

 private:
  // rows [a, b) as one block (encode has checked the rows)
  bool encodeWith(const SigSpec &s, const Rows &r, uint32_t a, uint32_t b, std::vector<uint8_t> &out, BlockInfo &info, std::string &err) {
    using namespace encdetail;
    const uint32_t rows = b - a;
    info = BlockInfo(); info.rows = rows; info.t0 = r.t[a]; info.tLast = r.t[b - 1];
    uint32_t nch = expectedChunks(rows, s.keyRows), K = nch > 1 ? s.keyRows : rows;
    if (nch > MAX_CHUNKS) { err = "too many chunks"; return false; }
    info.nchunk = (uint16_t)nch;
    bool two = false;
    if (s.vtype == VT_BITS && s.fourState) { two = true; const uint32_t h = s.vlen / 2; for (uint32_t i = a; i < b && two; i++) if (anyNonzero(r.val(i, s.vlen) + h, h)) two = false; }
    info.flags = (uint8_t)(two ? F_2ST : 0); const uint32_t w = two ? s.vlen / 2 : s.vlen;
    // the candidate modes, in tie-break order
    int cand[4], nc = 0;
    if (s.vtype == VT_STRING) cand[nc++] = M_STR;
    else { cand[nc++] = M_XOR; cand[nc++] = M_DICT; }
    want_ = 0; for (int k = 0; k < nc; k++) want_ |= 1u << cand[k];
    oneNow_ = one_ && nc == 2 && cand[0] == M_XOR && cand[1] == M_DICT;  // applied in the single-chunk path only
    const size_t start = out.size();
    if (nch == 1) {  // fast path: no per-chunk copies
      size_t cs[5] = {0}, rl[5] = {0}; if (!chunk(s, r, a, b, w, cs, rl, err, oneNow_)) return false;
      Workspace &W = ws(); int m = cand[0]; for (int k = 1; k < nc; k++) if (cs[cand[k]] < cs[m]) m = cand[k];
      info.mode = (uint8_t)m;
      const uint8_t *src = W.cbOf(m).data(); out.insert(out.end(), src, src + cs[m]); info.rsize = (uint32_t)rl[m]; info.xxh = xxh64(src, cs[m]);
    } else {
      std::vector<std::vector<uint8_t>> z[5], raw0(5); std::vector<uint32_t> rs[5]; uint64_t sum[5] = {0};
      for (int k = 0; k < nc; k++) { z[cand[k]].resize(nch); rs[cand[k]].resize(nch); }
      for (uint32_t c = 0; c < nch; c++) {
        uint32_t ca = a + c * K, cb = std::min(b, ca + K); size_t cs[5] = {0}, rl[5] = {0};
        if (!chunk(s, r, ca, cb, w, cs, rl, err)) return false;
        Workspace &W = ws();
        for (int k = 0; k < nc; k++) {
          int m = cand[k]; z[m][c].assign(W.cbOf(m).begin(), W.cbOf(m).begin() + cs[m]); rs[m][c] = (uint32_t)rl[m]; sum[m] += cs[m];
        }
      }
      int m = cand[0]; for (int k = 1; k < nc; k++) if (sum[cand[k]] < sum[m]) m = cand[k];
      info.mode = (uint8_t)m;
      auto &pick = z[m]; auto &rsz = rs[m];
      uint64_t tot = 0; for (auto v : rsz) tot += v; if (tot > 0xFFFFFFFFull) { err = "block payload too large"; return false; }
      info.rsize = (uint32_t)tot;
      std::vector<uint8_t> st; st.reserve((size_t)SEEK_SIZE * nch);
      for (uint32_t c = 0; c < nch; c++) { p32(st, c * K); p32(st, (uint32_t)pick[c].size()); p32(st, rsz[c]); p32(st, 0); p64(st, r.t[a + c * K]); p64(st, xxh64(pick[c].data(), pick[c].size())); }
      info.xxh = xxh64(st.data(), st.size()); out.insert(out.end(), st.begin(), st.end());
      for (auto &f : pick) out.insert(out.end(), f.begin(), f.end());
    }
    uint64_t len = out.size() - start; if (len > 0xFFFFFFFFull) { err = "block too large"; return false; }
    info.len = (uint32_t)len; return true;
  }
  // the time header of rows [a, b) at p: varint deltas
  bool putTimes(uint8_t *&p, const Rows &r, uint32_t a, uint32_t b, size_t room, std::string &err) {
    using namespace encdetail;
    uint64_t tp = r.t[a];
    (void)room; (void)err; for (uint32_t i = a; i < b; i++) { p = putVarP(p, r.t[i] - tp); tp = r.t[i]; } return true;
  }

  int level_; bool one_ = false, oneNow_ = false; uint32_t want_ = 0;
  bool wants(int m) const { return want_ >> m & 1; }
  // Builds the raw payload candidates of rows [a, b) that are wanted (XOR -> xb, DICT -> db; STR -> xb) and
  // compresses them. cs[m] / rl[m]: compressed and raw sizes by mode.
  // one: compress only the XOR/DICT candidate with the smaller raw size; the other's cs is set to SIZE_MAX.
  bool chunk(const SigSpec &s, const Rows &r, uint32_t a, uint32_t b, uint32_t w, size_t *cs, size_t *rl, std::string &err, bool one = false) {
    using namespace encdetail;
    const uint32_t n = b - a, vlen = s.vlen;
    const size_t str = vlen ? 0 : (size_t)(r.off[b] - r.off[a]);
    // admission: the full-width bound, as before; the buffers: the width the rows are stored at (w)
    if (rawBound(n, vlen, vlen, str) > MAX_RSIZE + (size_t)n * 20) { err = "chunk payload too large"; return false; }
    const bool extra = false;
    Workspace &W = ws(); W.ensure(rawBound(n, vlen, w, str), n, vlen ? vlen : 1, extra);
    uint8_t *p = W.xb.data();
    if (!putTimes(p, r, a, b, (size_t)n * 10, err)) return false;
    const size_t hd = p - W.xb.data();
    uint32_t cap = 1; while (cap < 2 * n) cap <<= 1;
    auto zip = [&](int m) {
      cs[m] = W.z(level_, W.rawOf(m).data(), rl[m], W.cbOf(m).data(), W.cbOf(m).size());
      if (ZSTD_isError(cs[m])) { err = "zstd compression failed"; return false; }
      return true;
    };
    if (s.vtype == VT_STRING) {
      std::fill(W.tab.begin(), W.tab.begin() + cap, -1); W.dvi.clear(); int32_t nd = 0;
      for (uint32_t i = a; i < b; i++) {
        const uint8_t *v = r.val(i, 0); size_t l = r.len(i, 0); uint64_t hh = hmix(0, 0, v, l); uint32_t sl = slotOf(hh, cap); int32_t found = -1;
        while (W.tab[sl] >= 0) { uint32_t j = W.dvi[W.tab[sl]]; if (W.tagh[sl] == hh && r.len(j, 0) == l && (l == 0 || !memcmp(r.val(j, 0), v, l))) { found = W.tab[sl]; break; } sl = (sl + 1) & (cap - 1); }
        if (found >= 0) p = putVarP(p, (uint64_t)found + 1);
        else { *p++ = 0; p = putVarP(p, l); if (l) memcpy(p, v, l); p += l; W.tab[sl] = nd++; W.tagh[sl] = hh; W.dvi.push_back(i); }
      }
      rl[M_STR] = p - W.xb.data(); if (rl[M_STR] > MAX_RSIZE) { err = "chunk payload too large"; return false; }
      return zip(M_STR);
    }
    const uint8_t *prev = W.zero.data();
    for (uint32_t i = a; i < b; i++) { const uint8_t *v = r.val(i, vlen); xorRow(p, v, prev, w); p += w; prev = v; }
    rl[M_XOR] = p - W.xb.data();
    if (wants(M_DICT)) {
      memcpy(W.db.data(), W.xb.data(), hd); uint8_t *q = W.db.data() + hd;
      std::fill(W.tab.begin(), W.tab.begin() + cap, -1); W.dvi.clear(); int32_t nd = 0; prev = W.zero.data();
      for (uint32_t i = a; i < b; i++) {
        const uint8_t *v = r.val(i, vlen); uint64_t hh = hmix(0, 0, v, w); uint32_t sl = slotOf(hh, cap); int32_t found = -1;
        while (W.tab[sl] >= 0) { if (W.tagh[sl] == hh && !memcmp(r.val(W.dvi[W.tab[sl]], vlen), v, w)) { found = W.tab[sl]; break; } sl = (sl + 1) & (cap - 1); }
        if (found >= 0) q = putVarP(q, (uint64_t)found + 1);
        else { *q++ = 0; xorRow(q, v, prev, w); q += w; W.tab[sl] = nd++; W.tagh[sl] = hh; W.dvi.push_back(i); }
        prev = v;
      }
      rl[M_DICT] = q - W.db.data();
    }
    for (int m : {M_XOR, M_DICT}) if (wants(m) && rl[m] > MAX_RSIZE) { err = "chunk payload too large"; return false; }
    if (!one) { for (int m : {M_XOR, M_DICT}) if (wants(m) && !zip(m)) return false; }
#ifdef WCZ_HOTPATH_TEST
    testChunks++;
#endif
    if (one) { const int m = rl[M_DICT] < rl[M_XOR] ? M_DICT : M_XOR; if (!zip(m)) return false; cs[m == M_DICT ? M_XOR : M_DICT] = SIZE_MAX; }
    return true;
  }
};

// ---------------------------------------------------------------- decoder

struct BlockDecoder {
  static bool fail(std::string &err, const char *m) { err = m; return false; }

  // Structural checks of a block's BlockEnt against its declaration, before touching the bytes.
  static bool checkInfo(const SigSpec &s, const BlockInfo &e, std::string &err) {
    if (e.rows == 0 || e.rows > MAX_ROWS) return fail(err, "bad block row count");
    if (e.nNorm > e.rows) return fail(err, "block nNorm above its rows");
    if (e.nchunk != expectedChunks(e.rows, s.keyRows)) return fail(err, "chunk count doesn't match the keyframe interval");
    if (s.vtype == VT_STRING ? e.mode != M_STR : e.mode > M_DICT) return fail(err, "block mode doesn't match the value type");
    if (e.flags & ~F_2ST) return fail(err, "unknown block flags");
    if ((e.flags & F_2ST) && !(s.vtype == VT_BITS && s.fourState)) return fail(err, "F_2ST on a 2-state signal");
    if (e.tLast < e.t0) return fail(err, "block's last time before its first");
    if (s.vlen && (uint64_t)e.rows * s.vlen > MAX_DECODED) return fail(err, "block too large");
    if ((uint64_t)e.rsize < e.rows) return fail(err, "block payload smaller than its times");
    // a block without keyframes is one chunk: the same payload bound as a seek entry's
    if (e.nchunk == 1 && e.rsize > MAX_RSIZE) return fail(err, "bad chunk payload size");
    uint64_t minLen = e.nchunk > 1 ? (uint64_t)SEEK_SIZE * e.nchunk + e.nchunk : 1;
    if (e.len < minLen) return fail(err, "block shorter than its seek table");
    return true;
  }

  // Parses and checks the seek table (nchunk > 1). The table's checksum must equal e.xxh when verify is set.
  static bool seekTable(const SigSpec &s, const BlockInfo &e, const uint8_t *bytes, std::vector<SeekEnt> &st, bool verify, std::string &err) {
    st.clear();
    if (e.nchunk == 1) { st.push_back(SeekEnt{0, e.len, e.rsize, 0, e.t0, e.xxh}); return true; }
    uint64_t tl = (uint64_t)SEEK_SIZE * e.nchunk;
    if (verify && xxh64(bytes, tl) != e.xxh) return fail(err, "seek table checksum mismatch");
    uint64_t pos = tl, rs = 0; st.resize(e.nchunk);
    for (uint32_t c = 0; c < e.nchunk; c++) {
      const uint8_t *q = bytes + (uint64_t)SEEK_SIZE * c; SeekEnt &k = st[c];
      k = SeekEnt{ld32(q), ld32(q + 4), ld32(q + 8), ld32(q + 12), ld64(q + 16), ld64(q + 24)};
      if (k.row != c * s.keyRows || k.pad) return fail(err, "bad seek entry row");
      if (k.csize == 0 || k.csize > e.len - pos) return fail(err, "chunk frame outside the block");
      uint32_t n = chunkRows(s, e, c);
      if (k.rsize < n || k.rsize > MAX_RSIZE) return fail(err, "bad chunk payload size");
      if (c == 0 ? k.t != e.t0 : k.t < st[c - 1].t) return fail(err, "chunk times out of order");
      if (k.t > e.tLast) return fail(err, "chunk starts after the block's last time");
      pos += k.csize; rs += k.rsize;
    }
    if (pos != e.len) return fail(err, "block bytes don't end at the last chunk frame");
    if (rs != e.rsize) return fail(err, "chunk payload sizes don't add up");
    return true;
  }
  static uint32_t chunkRows(const SigSpec &s, const BlockInfo &e, uint32_t c) {
    if (e.nchunk == 1) return e.rows;
    uint32_t a = c * s.keyRows; return std::min(e.rows, a + s.keyRows) - a;
  }

  // Whether the zstd frames in f[0, csize) can decompress to exactly rsize bytes, from their own block headers, not
  // from a stated Frame_Content_Size (which a hostile frame can set to anything). Each frame's blocks give an upper
  // bound (raw and RLE: their size; compressed: the block maximum, 128 KiB); a stated content size must be within
  // it, the stated sizes (when every frame states one) must add up to rsize, and rsize must be within the bound.
  // Skippable frames hold nothing. The frames must fill csize exactly, each with a window of at most 2^27 (§II.6.4).
  static bool frameHolds(const uint8_t *f, size_t csize, uint64_t rsize, const char **why = nullptr) {
    size_t p = 0; uint64_t bound = 0, stated = 0; bool allStated = true;
    while (p < csize) {
      if (csize - p < 4) return false;
      const uint32_t magic = ld32(f + p); p += 4;
      if ((magic & 0xFFFFFFF0u) == 0x184D2A50u) {  // skippable
        if (csize - p < 4) return false;
        const uint32_t n = ld32(f + p); p += 4;
        if (csize - p < n) return false;
        p += n; continue;
      }
      if (magic != 0xFD2FB528u || p >= csize) return false;
      const uint8_t fhd = f[p++];
      const uint32_t fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, check = (fhd >> 2) & 1, did = fhd & 3;
      if (fhd & 0x08) return false;  // reserved bit
      if (!single) {  // window descriptor: Window_Size <= 2^27 (§II.6.4)
        if (p >= csize) return false;
        const uint32_t wd = f[p++], wlog = 10 + (wd >> 3); if (wlog > 27) return false;
        const uint64_t base = 1ull << wlog, ws = base + (base / 8) * (wd & 7); if (ws > (1ull << 27)) return false;
      }
      static const uint32_t didLen[4] = {0, 1, 2, 4};
      if (csize - p < didLen[did]) return false;
      { uint32_t id = 0; for (uint32_t k = 0; k < didLen[did]; k++) id |= (uint32_t)f[p + k] << (8 * k);
        if (id) { if (why) *why = "zstd frame with a Dictionary_ID"; return false; } }  // §II.6.4: no dictionary
      p += didLen[did];
      const uint32_t fcsLen = fcsFlag == 0 ? (single ? 1 : 0) : fcsFlag == 1 ? 2 : fcsFlag == 2 ? 4 : 8;
      if (csize - p < fcsLen) return false;
      uint64_t fcs = 0; for (uint32_t k = 0; k < fcsLen; k++) fcs |= (uint64_t)f[p + k] << (8 * k);
      if (fcsLen == 2) fcs += 256;
      if (single && fcs > (1ull << 27)) return false;  // a single-segment frame's window is its content size
      p += fcsLen;
      uint64_t fb = 0;
      for (;;) {
        if (csize - p < 3) return false;
        const uint32_t h = (uint32_t)f[p] | (uint32_t)f[p + 1] << 8 | (uint32_t)f[p + 2] << 16; p += 3;
        const uint32_t last = h & 1, type = (h >> 1) & 3, size = h >> 3;
        if (type == 3) return false;
        if (type != 2 && size > (1u << 17)) return false;  // raw / RLE: at most the block maximum (RFC 8878)
        const size_t takes = type == 1 ? 1 : size;
        if (csize - p < takes) return false;
        p += takes;
        fb += type == 2 ? (1u << 17) : size;  // compressed: at most the block maximum (128 KiB)
        if (last) break;
      }
      if (check) { if (csize - p < 4) return false; p += 4; }
      if (fcsLen) { if (fcs > fb) return false; stated += fcs; } else allStated = false;
      bound += fb;
    }
    if (p != csize || rsize > bound) return false;
    return !allStated || stated == rsize;
  }

  // A whole keyframed string block past MAX_DECODED (or the budget) whose chunks are each within their own limit
  // (§II.10): valid, but refused for a whole-block decode.
  static constexpr const char *WHOLE_STR = "string block decodes past the whole-block limit (read it by chunk, or set a larger decode budget)";

  // The scratch buffer (tmp) of chunkBytes / decodeChunk / decodeBlockCounted / pointChunk / strChunksTotal may be any byte
  // vector (a template parameter), so a host can give it an allocator that maps large buffers.
  // chunkBytes: checks chunk c (checksum when verify, frame headers) and decompresses it into tmp[0, rsize).
  template <class Buf>
  static bool chunkBytes(ZSTD_DCtx *zd, const BlockInfo &e, const uint8_t *bytes, const std::vector<SeekEnt> &st, uint32_t c, Buf &tmp, bool verify, std::string &err) {
    if (c >= st.size()) return fail(err, "no such chunk");
    uint64_t off = e.nchunk == 1 ? 0 : (uint64_t)SEEK_SIZE * e.nchunk; for (uint32_t j = 0; j < c; j++) off += st[j].csize;
    const SeekEnt &k = st[c]; const uint8_t *f = bytes + off;
    if (verify && xxh64(f, k.csize) != k.xxh) return fail(err, e.nchunk == 1 ? "block checksum mismatch" : "chunk checksum mismatch");
    // the frame's own block headers bound its output: a chunk that claims more is refused before its buffer is sized
    { const char *why = nullptr; if (!frameHolds(f, k.csize, k.rsize, &why)) return fail(err, why ? why : "chunk doesn't decompress to its payload size"); }
    tmp.resize(k.rsize ? k.rsize : 1);
    size_t got = ZSTD_decompressDCtx(zd, tmp.data(), k.rsize, f, k.csize);
    if (ZSTD_isError(got) || got != k.rsize) return fail(err, "chunk doesn't decompress to its payload size");
    decodeStats().rawBytes += k.rsize;
    return true;
  }

  // Decodes chunk c (0 for a block without keyframes), appending its rows to out. A string chunk may append at most
  // vlimit value bytes (decodeBlock passes what is left of the block's §II.10 limit).
  template <class Buf>
  static bool decodeChunk(ZSTD_DCtx *zd, const SigSpec &s, const BlockInfo &e, const uint8_t *bytes, const std::vector<SeekEnt> &st, uint32_t c,
                          Rows &out, Buf &tmp, bool verify, std::string &err, uint64_t vlimit = MAX_DECODED, uint64_t tq = NONE64, uint64_t tfrom = 0
                          ) {
    if (const char *z = zstdTooOld()) return fail(err, z);
    if (!chunkBytes(zd, e, bytes, st, c, tmp, verify, err)) return false;
    bool last = c + 1 == e.nchunk; uint64_t tMax = last ? e.tLast : st[c + 1].t;
    return decodePayload(tmp.data(), st[c].rsize, s, e.mode, e.flags, chunkRows(s, e, c), st[c].t, tMax, last, out, err, vlimit, tq, tfrom);
  }

  // The string value bytes chunks [c0, c1) decode to, counted without keeping them (one chunk in tmp at a time). A
  // chunk over MAX_DECODED is invalid ("decoded strings above the limit"); chunks within it that add up past `limit`
  // are refused with WHOLE_STR. decodeBlockCounted calls it first for a keyframed string block, so a block past the limit
  // is refused before its values are allocated; a host reading a chunk range can call it the same way.
  template <class Buf>
  static bool strChunksTotal(ZSTD_DCtx *zd, const SigSpec &s, const BlockInfo &e, const uint8_t *bytes, const std::vector<SeekEnt> &st, uint32_t c0, uint32_t c1,
                             Buf &tmp, bool verify, uint64_t limit, uint64_t &total, std::string &err) {
    total = 0;
    if (s.vtype != VT_STRING) return fail(err, "string totals: not a string signal");
    if (const char *z = zstdTooOld()) return fail(err, z);
    for (uint32_t c = c0; c < c1; c++) {
      if (!chunkBytes(zd, e, bytes, st, c, tmp, verify, err)) return false;
      uint64_t n = 0;
      if (!strTotal(tmp.data(), st[c].rsize, chunkRows(s, e, c), MAX_DECODED, n, err)) return false;
      total += n;
      if (total > limit) return fail(err, WHOLE_STR);
    }
    return true;
  }
  // A string payload's decoded value bytes (its n times skipped), with strValues' index, length and limit checks.
  static bool strTotal(const uint8_t *buf, size_t len, uint32_t n, uint64_t limit, uint64_t &total, std::string &err) {
    const uint8_t *p = buf, *end = buf + len; total = 0;
    if (n == 0 || n > MAX_ROWS) return fail(err, "bad chunk row count");
    for (uint32_t k = 0; k < n; k++) { uint64_t dt; if (!getVar(p, end, dt)) return fail(err, "bad or truncated time varint"); }
    std::vector<uint64_t> lit;
    for (uint32_t k = 0; k < n; k++) {
      uint64_t kk, l; if (!getVar(p, end, kk)) return fail(err, "bad or truncated STR index");
      if (kk == 0) {
        if (!getVar(p, end, l)) return fail(err, "bad or truncated STR length");
        if (l > MAX_STR) return fail(err, "string longer than the limit");
        if ((uint64_t)(end - p) < l) return fail(err, "truncated STR literal");
        lit.push_back(l); p += l;
      } else {
        if (kk > lit.size()) return fail(err, "STR index past the literals seen");
        l = lit[kk - 1];
      }
      if (l > limit - total) return fail(err, "decoded strings above the limit");
      total += l;
    }
    return true;
  }

  // Bytes a decode of `rows` rows holds besides string values: times and offsets (16 B per row), fixed-width
  // values, the payload scratch (rs) and the seek table.
  static uint64_t holdFor(const SigSpec &s, uint64_t rows, uint64_t rs, size_t nseek) { return rs + rows * 16 + rows * s.vlen + (uint64_t)nseek * sizeof(SeekEnt); }
  // Under a budget: refuses (before allocating) a decode that would hold more than `budget` bytes, reserves the rows
  // exactly, and returns the bytes left for string values in vmax (without a budget: MAX_DECODED; each chunk's
  // strings stay within MAX_DECODED either way).
  static bool charge(const SigSpec &s, uint64_t rows, uint64_t rs, size_t nseek, uint64_t budget, Rows &out, uint64_t &vmax, std::string &err) {
    vmax = MAX_DECODED;
    if (budget == NO_BUDGET) return true;
    uint64_t need = holdFor(s, rows, rs, nseek);
    if (need > budget) return fail(err, "decode budget exceeded");
    if (!s.vlen) vmax = budget - need;
    out.t.reserve(out.t.size() + rows); if (!s.vlen) out.off.reserve(out.off.size() + rows); if (s.vlen) out.v.reserve(out.v.size() + (size_t)rows * s.vlen);
    return true;
  }

  static bool decodeBlock(ZSTD_DCtx *zd, const SigSpec &s, const BlockInfo &e, const uint8_t *bytes, Rows &out, std::vector<uint8_t> &tmp, bool verify, std::string &err,
                          uint64_t budget = NO_BUDGET
                          ) {
    out.clear(); std::vector<SeekEnt> st;
    if (const char *z = zstdTooOld()) return fail(err, z);
    if (!checkInfo(s, e, err) || !seekTable(s, e, bytes, st, verify, err)) return false;
    uint64_t rs = 0; for (auto &k : st) rs = std::max<uint64_t>(rs, k.rsize);
    uint64_t vmax; if (!charge(s, e.rows, rs, st.capacity(), budget, out, vmax, err)) return false;
    // a whole string block holds its STR total (§II.10: each chunk's is at most MAX_DECODED, the block's may be more):
    // bounded by MAX_DECODED, or by the budget when one is set
    for (uint32_t c = 0; c < e.nchunk; c++) {
      const uint64_t left = vmax - std::min<uint64_t>(vmax, out.v.size());
      if (!decodeChunk(zd, s, e, bytes, st, c, out, tmp, verify, err, left)) {
        if (!s.vlen && left < MAX_DECODED && err == "decoded strings above the limit") err = "string block decodes past the whole-block limit (read it by chunk, or set a larger decode budget)";
        out.clear(); return false;
      }
    }
    return true;
  }
  // decodeBlockCounted: decodeBlock with a scratch of any byte-vector type (Buf) and a string preflight. A keyframed
  // string block's string total is counted first (strChunksTotal), so a block past the limit is refused before its
  // values are allocated, and its value buffer is sized once. The cost: each chunk of such a block is decompressed twice
  // (count, then decode). decodeBlock does neither; it grows the values chunk by chunk up to the limit. Same answers
  // and errors otherwise.
  template <class Buf>
  static bool decodeBlockCounted(ZSTD_DCtx *zd, const SigSpec &s, const BlockInfo &e, const uint8_t *bytes, Rows &out, Buf &tmp, bool verify, std::string &err,
                                 uint64_t budget = NO_BUDGET
                          ) {
    out.clear(); std::vector<SeekEnt> st;
    if (const char *z = zstdTooOld()) return fail(err, z);
    if (!checkInfo(s, e, err) || !seekTable(s, e, bytes, st, verify, err)) return false;
    uint64_t rs = 0; for (auto &k : st) rs = std::max<uint64_t>(rs, k.rsize);
    uint64_t vmax; if (!charge(s, e.rows, rs, st.capacity(), budget, out, vmax, err)) return false;
    // a keyframed string block: its string total is counted first (one chunk decompressed at a time, nothing kept),
    // so a block past the limit is refused before its values are allocated; its value buffer is then sized once
    if (s.vtype == VT_STRING && e.nchunk > 1) {
      uint64_t total = 0;
      if (!strChunksTotal(zd, s, e, bytes, st, 0, e.nchunk, tmp, verify, vmax, total, err)) { out.clear(); return false; }
      out.v.reserve((size_t)total);
    }
    // a whole string block holds its STR total (§II.10: each chunk's is at most MAX_DECODED, the block's may be more):
    // bounded by MAX_DECODED, or by the budget when one is set
    for (uint32_t c = 0; c < e.nchunk; c++) {
      const uint64_t left = vmax - std::min<uint64_t>(vmax, out.v.size());
      if (!decodeChunk(zd, s, e, bytes, st, c, out, tmp, verify, err, left)) {
        if (!s.vlen && left < MAX_DECODED && err == "decoded strings above the limit") err = WHOLE_STR;
        out.clear(); return false;
      }
    }
    return true;
  }

  // decodeBlock with the chunks' payloads given decompressed (raw = every chunk's payload in chunk
  // order). The entry, the seek table and each chunk's checksum over its compressed bytes are checked as in decodeBlock
  // with verify; that each chunk decompresses to its raw slice is NOT checked (the caller checked it). Fixed width only.
  static bool decodeBlockRaw(const SigSpec &s, const BlockInfo &e, const uint8_t *bytes, const uint8_t *raw, size_t rawLen, Rows &out, std::string &err) {
    out.clear(); std::vector<SeekEnt> st;
    if (!s.vlen) return fail(err, "raw decode: fixed-width signals only");
    if (!checkInfo(s, e, err) || !seekTable(s, e, bytes, st, true, err)) return false;
    if (!raw) return fail(err, "raw payload missing");
    uint64_t tot = 0; for (auto &k : st) tot += k.rsize;
#ifndef WCZ_MUTANT_RAW_NOLEN
    if (tot != rawLen) { err = "raw payload is " + std::to_string(rawLen) + " bytes, the block's chunks hold " + std::to_string(tot); return false; }
#else
    if (tot > rawLen) return fail(err, "raw payload too short");  // MUTANT (tests only): a longer raw is accepted
#endif
    uint64_t off = e.nchunk == 1 ? 0 : (uint64_t)SEEK_SIZE * e.nchunk, roff = 0;
    for (uint32_t c = 0; c < e.nchunk; c++) {
      const SeekEnt &k = st[c];
      if (xxh64(bytes + off, k.csize) != k.xxh) { out.clear(); return fail(err, e.nchunk == 1 ? "block checksum mismatch" : "chunk checksum mismatch"); }
      bool last = c + 1 == e.nchunk; uint64_t tMax = last ? e.tLast : st[c + 1].t;
      if (!decodePayload(raw + roff, k.rsize, s, e.mode, e.flags, chunkRows(s, e, c), k.t, tMax, last, out, err)) { out.clear(); return false; }
      off += k.csize; roff += k.rsize;
    }
    return true;
  }

  // Index of the chunk a point read at time t starts from: the last chunk with t_c <= t (or 0).
  static uint32_t chunkFor(const std::vector<SeekEnt> &st, uint64_t t) {
    uint32_t lo = 0, hi = (uint32_t)st.size(); while (lo < hi) { uint32_t m = lo + (hi - lo) / 2; if (st[m].t <= t) lo = m + 1; else hi = m; } return lo ? lo - 1 : 0;
  }

  // Point read in chunk c: appends the chunk's rows with time <= tq (the answer is the last of them). It is
  // decodeChunk keeping only that prefix: the whole payload is decompressed and every row checked, so a point read
  // accepts exactly the chunks decodeChunk accepts; only the values of the rows returned are built.
  // tfrom: of those rows, only the ones from the last row before tfrom (all when none is before it); the values of the
  // rows left out are folded into one slot (XOR, DICT) or named in the payload (STR), never built into out.
  template <class Buf>
  static bool pointChunk(ZSTD_DCtx *zd, const SigSpec &s, const BlockInfo &e, const uint8_t *bytes, const std::vector<SeekEnt> &st, uint32_t c, uint64_t tq,
                         Rows &out, Buf &tmp, std::string &err, uint64_t vlimit = MAX_DECODED, uint64_t tfrom = 0
                         ) {
    return decodeChunk(zd, s, e, bytes, st, c, out, tmp, true, err, vlimit, tq, tfrom);
  }

  // Strict payload decode (§II.6.5). Appends n rows to out. Times start at t0, stay <= tMax; the last must equal tMax
  // when exactLast is set.
  // tq: append only the rows at times <= tq (a prefix; every row is still checked, so the payloads accepted are the
  // same for every tq).
  static bool decodePayload(const uint8_t *buf, size_t len, const SigSpec &s, uint8_t mode, uint8_t flags, uint32_t n, uint64_t t0, uint64_t tMax, bool exactLast,
                            Rows &out, std::string &err, uint64_t vlimit = MAX_DECODED, uint64_t tq = NONE64, uint64_t tfrom = 0
                            ) {
    const uint8_t *p = buf, *end = buf + len; size_t base = out.t.size(); uint64_t t = t0; uint32_t keep = 0, before = 0;
    if (n == 0 || n > MAX_ROWS) return fail(err, "bad chunk row count");
    if (s.vlen && (uint64_t)n * s.vlen > MAX_DECODED) return fail(err, "chunk too large");
    if (t0 > tMax) return fail(err, "chunk starts after its last time");
    // Every time, into out.t (sized once); then the rows kept are the prefix at times <= tq (times never decrease).
    // Runs of 8 one-byte deltas are read a word at a time (each byte < 0x80 is a minimal varint); the rest through
    // getVar. The checks are the same per row: first delta 0, every time <= tMax, varints strict.
    out.t.resize(base + n); uint64_t *ot = out.t.data() + base; uint32_t k = 0;
    { uint64_t dt; if (!getVar(p, end, dt)) { out.t.resize(base); return fail(err, "bad or truncated time varint"); }
      if (dt != 0) { out.t.resize(base); return fail(err, "first time delta is not 0"); }
      ot[k++] = t; }
    while (k < n) {
      uint64_t w8 = 0; const bool w = end - p >= 8; if (w) memcpy(&w8, p, 8);
      if (w && n - k >= 8 && !(w8 & 0x8080808080808080ull)) {
        uint64_t sum = 0; for (int j = 0; j < 8; j++) { sum += p[j]; ot[k + j] = t + sum; }
        if (sum > tMax - t) { out.t.resize(base); return fail(err, "time past the chunk's last time"); }  // times never decrease: the last is the largest
        t += sum; p += 8; k += 8; continue;
      }
      // one varint, inline: 1-3 bytes with one bounds check (10 bytes left), longer ones through getVar
      uint64_t dt;
      if (end - p >= 10 && !(p[0] & 0x80)) { dt = p[0]; p += 1; }
      else if (end - p >= 10 && !(p[1] & 0x80)) { if (!p[1]) { out.t.resize(base); return fail(err, "bad or truncated time varint"); } dt = (p[0] & 0x7Fu) | (uint64_t)p[1] << 7; p += 2; }
      else if (end - p >= 10 && !(p[2] & 0x80)) { if (!p[2]) { out.t.resize(base); return fail(err, "bad or truncated time varint"); } dt = (p[0] & 0x7Fu) | (uint64_t)(p[1] & 0x7F) << 7 | (uint64_t)p[2] << 14; p += 3; }
      else if (!getVar(p, end, dt)) { out.t.resize(base); return fail(err, "bad or truncated time varint"); }
      if (dt > tMax - t) { out.t.resize(base); return fail(err, "time past the chunk's last time"); }
      t += dt; ot[k++] = t;
    }
    keep = (uint32_t)(std::upper_bound(ot, ot + n, tq) - ot); before = (uint32_t)(std::lower_bound(ot, ot + keep, tfrom) - ot);
    out.t.resize(base + keep);
    decodeStats().timeRows += n;
    if (exactLast && t != tMax) { out.t.resize(base); return fail(err, "last time differs from the block's"); }
    const uint32_t drop = before ? before - 1 : 0;  // rows [drop, keep) are returned
    if (drop) out.t.erase(out.t.begin() + base, out.t.begin() + base + drop);
    bool ok = s.vtype == VT_STRING ? strValues(p, end, n, keep, drop, std::min(vlimit, MAX_DECODED), out, err) : fixedValues(p, end, s, mode, flags, n, keep, drop, out, err);
    if (!ok) { out.t.resize(base); return false; }
    decodeStats().valueRows += keep - drop;
    if (p != end) { out.t.resize(base); return fail(err, "trailing bytes after the payload"); }
    return true;
  }

 private:
  // Values of n rows; the first `keep` are appended, the rest are checked only. A row's value is the previous one
  // XOR its stored bytes (XOR, DICT literals) or an earlier literal row's (DICT index), so every value has no bits past
  // the width exactly when no stored bytes do: rows past `keep` check their stored bytes. Rows before `drop` are built
  // into one slot instead of out (DICT literals among them copied aside, for the indices that name them) and checked
  // as appended rows are.
  static bool fixedValues(const uint8_t *&p, const uint8_t *end, const SigSpec &s, uint8_t mode, uint8_t flags, uint32_t n, uint32_t keep, uint32_t drop, Rows &out, std::string &err) {
    const uint32_t vlen = s.vlen, w = (flags & F_2ST) ? vlen / 2 : vlen;
    size_t vb = out.v.size(); out.v.resize(vb + (size_t)(keep - drop) * vlen, 0);
    auto rollback = [&](const char *m) { out.v.resize(vb); return fail(err, m); };
    uint8_t *v = out.v.data() + vb;
    std::vector<uint8_t> slot(drop ? vlen : 0, 0);
    auto rowAt = [&](uint32_t k) -> uint8_t * { return k < drop ? slot.data() : v + (size_t)(k - drop) * vlen; };  // k < keep
    const bool masked = s.vtype == VT_BITS && (s.bits & 7); const uint8_t mask = masked ? (uint8_t)(0xFF << (s.bits & 7)) : 0; const uint32_t pl = (s.bits + 7) / 8;
    auto storedOk = [&](const uint8_t *d) { return !masked || (!(d[pl - 1] & mask) && !(s.fourState && w == vlen && (d[2 * pl - 1] & mask))); };
    auto valueOk = [&](const uint8_t *c) { return !masked || (!(c[pl - 1] & mask) && !(s.fourState && (c[2 * pl - 1] & mask))); };
    if (mode == M_XOR) {
      if ((uint64_t)(end - p) != (uint64_t)n * w) return rollback("XOR payload size mismatch");
      // no rows dropped and a plane of 1, 2, 4 or 8 bytes: the running value in a word
      auto run = [&](auto one) { using U = decltype(one); U acc = 0; uint8_t *c = v;
        for (uint32_t k = 0; k < keep; k++, p += sizeof(U), c += vlen) { U x; memcpy(&x, p, sizeof(U)); acc ^= x; memcpy(c, &acc, sizeof(U)); } };
      if (!drop && w == 1) run(uint8_t()); else if (!drop && w == 2) run(uint16_t()); else if (!drop && w == 4) run(uint32_t()); else if (!drop && w == 8) run(uint64_t());
      else for (uint32_t k = 0; k < keep; k++) {
        uint8_t *c = rowAt(k); if (k) xorInto(c, rowAt(k - 1), p, w); else memcpy(c, p, w); p += w;
        if (k < drop && !valueOk(c)) return rollback("value bits set past the signal width");
      }
      for (uint32_t k = keep; k < n; k++, p += w) if (!storedOk(p)) return rollback("value bits set past the signal width");
    } else if (mode == M_DICT) {
      std::vector<uint32_t> lit;    // per literal: its row (k >= drop) or its offset in aside (k < drop)
      std::vector<uint8_t> litIn;   // per literal: 1 when it is in aside
      std::vector<uint8_t> aside;
      for (uint32_t k = 0; k < n; k++) {
        uint8_t *c = k < keep ? rowAt(k) : nullptr; uint64_t kk;
        if (!getVar(p, end, kk)) return rollback("bad or truncated DICT index");
        if (kk == 0) {
          if ((uint64_t)(end - p) < w) return rollback("truncated DICT literal");
          if (!c) { if (!storedOk(p)) return rollback("value bits set past the signal width"); }
          else if (k) xorInto(c, rowAt(k - 1), p, w); else memcpy(c, p, w);
          p += w;
          if (c && k < drop) { lit.push_back((uint32_t)aside.size()); litIn.push_back(1); aside.insert(aside.end(), c, c + vlen); }
          else { lit.push_back(k); litIn.push_back(0); }
        } else {
          if (kk > lit.size()) return rollback("DICT index past the literals seen");
          if (c) { const size_t q = kk - 1; memcpy(c, litIn[q] ? aside.data() + lit[q] : v + (size_t)(lit[q] - drop) * vlen, w); }
        }
        if (c && k < drop && !valueOk(c)) return rollback("value bits set past the signal width");
      }
    } else return rollback("unknown block mode");
    if (masked) {  // bits past `bits` in each plane's last byte must be 0
      for (uint32_t k = drop; k < keep; k++) if (!valueOk(rowAt(k))) return rollback("value bits set past the signal width");
    }
    return true;  // fixed-width rows: off is not used by val/len (Rows::pushFixed), so it is not kept
  }
  // Strings of n rows; rows [drop, keep) are appended, the rest checked only (indices, lengths, the limit on the
  // total). Every literal is named by its place in the payload, so an index copies its bytes from there whether the
  // literal's row was appended or not.
  static bool strValues(const uint8_t *&p, const uint8_t *end, uint32_t n, uint32_t keep, uint32_t drop, uint64_t limit, Rows &out, std::string &err) {
    size_t vb = out.v.size(), ob = out.off.size(); std::vector<std::pair<const uint8_t *, uint64_t>> lit; uint64_t total = 0;
    auto rollback = [&](const char *m) { out.v.resize(vb); out.off.resize(ob); return fail(err, m); };
    // value bytes grow by doubling, but never past vb + limit (the bytes this chunk may append)
    auto room = [&](uint64_t l) { size_t need = out.v.size() + l; if (need > out.v.capacity()) out.v.reserve(std::max<size_t>(need, std::min<uint64_t>(2 * out.v.capacity(), vb + limit))); };
    for (uint32_t k = 0; k < n; k++) {
      uint64_t kk; if (!getVar(p, end, kk)) return rollback("bad or truncated STR index");
      uint64_t l;
      if (kk == 0) {
        if (!getVar(p, end, l)) return rollback("bad or truncated STR length");
        if (l > MAX_STR) return rollback("string longer than the limit");
        if ((uint64_t)(end - p) < l) return rollback("truncated STR literal");
        if (total + l > limit) return rollback("decoded strings above the limit");
        lit.push_back({p, l});
        if (k >= drop && k < keep) { room(l); out.v.insert(out.v.end(), p, p + l); }
        p += l;
      } else {
        if (kk > lit.size()) return rollback("STR index past the literals seen");
        auto pr = lit[kk - 1]; l = pr.second;
        if (total + l > limit) return rollback("decoded strings above the limit");
        if (l && k >= drop && k < keep) { room(l); out.v.insert(out.v.end(), pr.first, pr.first + l); }
      }
      total += l; if (total > limit) return rollback("decoded strings above the limit");
      if (k >= drop && k < keep) out.off.push_back(out.v.size());
    }
    return true;
  }
};

// Stream hash of one change (§II.8): values hash their bytes; hmix folds the length.
static inline uint64_t hashRows(uint64_t h, const Rows &r, uint32_t vlen) { for (uint32_t i = 0; i < r.n(); i++) h = hmix(h, r.t[i], r.val(i, vlen), r.len(i, vlen)); return h; }

}  // namespace wcz
