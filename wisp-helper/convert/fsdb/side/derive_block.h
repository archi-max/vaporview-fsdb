// SPDX-License-Identifier: MIT
// derive_block.h (file-only route): read the derivation block of a dump from its bytes: the port-copy and
// stored tables, the record stream, the op table, the code-block table, the local templates, the tail tuples and the
// constant pool. Same method and results as the reference decoder it was ported from (not shipped).
#pragma once
#include <cstdint>
#include <array>
#include <cstring>
#include <algorithm>
#include <map>
#include <set>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>
#include <zlib.h>

namespace dblk {

static inline uint32_t u32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static inline int32_t i32(const uint8_t *p) { int32_t v; memcpy(&v, p, 4); return v; }
static inline uint64_t u64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }
#ifdef WCZ_DERIVE_TEST_REDS
inline bool pool_old_cut = false;   // planted red: the earlier constant-section cut, test builds only
#else
constexpr bool pool_old_cut = false;
#endif
// Opt-in (derive_side --tuples-end): take the tail tuple table from the block directory (tuple_span() below) instead of the
// last template's parsed end. Default off: the table is read from the last template's end, as before.
inline bool tuples_end = false;
#ifdef WCZ_DERIVE_TEST_REDS
inline int tuples_red = 0;   // planted reds (test builds only): 1 = table start 4 bytes late (phase), 2 = append a quad with a duplicate key
#else
constexpr int tuples_red = 0;
#endif
using Bytes = std::vector<uint8_t>;

// ---- the LZ decoder of the two-stage tables
inline Bytes lz0(const uint8_t *src, size_t n) {
  size_t pos = 0; Bytes out; bool after = false;
  auto b = [&]() -> uint8_t { if (pos >= n) throw std::runtime_error("lz0: input ends"); return src[pos++]; };
  auto lit = [&](size_t k) { if (pos + k > n) throw std::runtime_error("lz0: literal past input"); out.insert(out.end(), src + pos, src + pos + k); pos += k; };
  auto match = [&](size_t d, size_t k) { if (d > out.size()) throw std::runtime_error("lz0: distance"); size_t s = out.size(); for (size_t i = 0; i < k; i++) out.push_back(out[s - d + i]); };
  for (;;) {
    uint8_t t = b();
    if (t <= 31) {
      if (after) { size_t d = 1 + t + ((size_t)b() << 5); match(d, 3); lit(1); after = true; continue; }
      size_t k = t; bool lng = false;
      if (!k) { uint8_t e = b(); lng = e >= 248; k = e <= 248 ? 32 + e : (size_t)256 << (e - 248); }
      lit(k); after = !lng; continue;
    }
    if (t > 63) { size_t d = 1 + (t & 31) + ((size_t)b() << 5); match(d, (t >> 5) + 1); after = false; continue; }
    size_t length = t & 31;
    if (!length) { size_t z = 0; for (;;) { uint8_t v = b(); if (v) { length = z + 31 + v; break; } z += 255; } }
    uint8_t low = b(), high = b(); size_t d = (low & 63) + ((size_t)high << 6);
    if (!d) return out;
    match(d, length + 3); size_t tail = low >> 6; lit(tail); after = tail != 0;
  }
}

struct Key { char k; uint32_t id; };                  // P / T / Q / C op-table kinds, B code block
struct Rec { uint32_t dst; Key key; std::vector<uint32_t> args; };
struct Entry { uint32_t na; Bytes body; };
struct Tpl { size_t off; uint32_t N, K; std::vector<uint32_t> W; Bytes types; std::vector<Rec> recs; size_t nrec_pos, end; };
struct Trip { uint64_t k, x, v; };

struct Block {
  bool present = false; std::string none, ver;
  uint32_t NV = 0, K = 0;
  std::vector<Trip> t0, t1, t2;   // t2: the third f0 table (ID -> node), kept as a separate fact, never merged into t1
  size_t nchunks = 0;
  std::vector<uint32_t> W; Bytes types;
  std::vector<Rec> recs; std::vector<Entry> T, B;
  std::vector<Tpl> tpl; std::vector<std::array<uint32_t, 4>> tuples; size_t tuples_gap = 0;   // gap: bytes between the last template's end and the table (--tuples-end)
  std::string tuples_why;   // --tuples-end: why no tuple was read (table not located or not well formed); empty = read
  std::map<uint32_t, Bytes> pool;
  std::map<uint32_t, uint32_t> poolWidth;   // (new cut only)
  std::set<uint32_t> poolNew;               // first-table entries the earlier cut could not read (its 8 bytes had a nonzero 2nd word): newly readable
  std::set<uint32_t> poolAlt;               // entries named by the second (alternate) table: a storage / strength class, not integers   // per-entry width table of the constant section (not used by any rule yet)
  std::map<uint32_t, uint32_t> barity;
  Bytes S, z0;
};

// inflate one zlib stream at j (fed in 1 MiB slices); -> consumed bytes, or 0 if it is not a complete stream
inline size_t inflate_at(const uint8_t *raw, size_t len, size_t j, Bytes &out) {
  z_stream zs{}; if (inflateInit(&zs) != Z_OK) return 0; out.clear(); uint8_t buf[1 << 16]; size_t q = j; int rc = Z_OK;
  while (rc != Z_STREAM_END && q < len) {
    size_t sl = std::min<size_t>(1 << 20, len - q); zs.next_in = const_cast<uint8_t *>(raw + q); zs.avail_in = (uInt)sl;
    while (zs.avail_in) {
      zs.next_out = buf; zs.avail_out = sizeof buf; rc = inflate(&zs, Z_NO_FLUSH);
      out.insert(out.end(), buf, buf + (sizeof buf - zs.avail_out));
      if (rc == Z_STREAM_END) break;
      if (rc != Z_OK && rc != Z_BUF_ERROR) { inflateEnd(&zs); return 0; }
      if (rc == Z_BUF_ERROR && zs.avail_out) break;
      if (out.size() > (size_t(1) << 31)) { inflateEnd(&zs); return 0; }
    }
    q += sl - zs.avail_in;
    if (rc != Z_STREAM_END && zs.avail_in) { inflateEnd(&zs); return 0; }
  }
  inflateEnd(&zs); return rc == Z_STREAM_END ? q - j : 0;
}

inline std::vector<Trip> trecs(const Bytes &b) {
  static const int Wd[4] = {1, 2, 4, 8}; std::vector<Trip> out; size_t i = 0;
  auto le = [&](size_t o, int w) { uint64_t v = 0; for (int k = 0; k < w; k++) v |= (uint64_t)b.at(o + k) << (8 * k); return v; };
  while (i < b.size()) {
    uint8_t t = b[i]; if (t >> 6 != 3) throw std::runtime_error("table: bad tag");
    int wa = Wd[t & 3], wb = Wd[(t >> 2) & 3], wc = Wd[(t >> 4) & 3];
    out.push_back({le(i + 1, wa), le(i + 1 + wa, wb), le(i + 1 + wa + wb, wc)}); i += 1 + wa + wb + wc;
  }
  return out;
}

// writer release part of the block version string ("<release>-<build stamp>"): equal to the proven release, else the
// whole file is refused (other writer versions are not proven)
inline bool release_is(const std::string &ver, const std::string &proven) { return ver == proven || (ver.size() > proven.size() && ver.compare(0, proven.size(), proven) == 0 && ver[proven.size()] == '-'); }

// --tuples-end: where the tail tuple table is. The derivation block holds two outer blocks after its version text: at h0 a
// format word 0x300 and flags 0x27 (64-bit lengths), then per outer block a u64 length and its bytes. The second outer block
// (the one whose frames make S) ends with a directory: its last u32 is a count N, and the N 24-byte entries before it are
// (u64 frame position relative to the block start, u32 offset in that frame's bytes, u32 length low, u32 type | length
// high << 26 in bits 6-7, u32 key). The entries must cover S exactly once (no gap, no overlap, every frame position known).
// The tuple table is the one type-6 entry with key 0: it must end at the end of S and hold whole 16-byte entries.
// Returns "" and the table's offset/length in S, or why it was not located (then no tuple is read).
inline std::string tuple_span(const uint8_t *raw, size_t len, size_t h0, const std::vector<std::pair<size_t, size_t>> &frames, size_t SL,
                              size_t &T0, size_t &TL) {
  if (h0 > len || len - h0 < 16 || u32(raw + h0) != 0x300 || u32(raw + h0 + 4) != 0x27) return "outer block header is not the 64-bit layout";
  const size_t o0 = h0 + 8; const uint64_t l0 = u64(raw + o0); if (l0 > len - o0 - 8) return "first outer block length past the file end";
  const size_t o1 = o0 + 8 + (size_t)l0; if (o1 > len || len - o1 < 8) return "second outer block header past the file end";
  const uint64_t l1 = u64(raw + o1); const size_t s1 = o1 + 8; if (l1 > len - s1 || l1 < 4) return "second outer block length past the file end";
  const size_t e1 = s1 + (size_t)l1; const uint32_t n = u32(raw + e1 - 4);
  if (n == 0 || (uint64_t)n * 24 > l1 - 4) return "block directory count does not fit the block";
  const size_t d = e1 - 4 - (size_t)n * 24;
  std::map<size_t, size_t> fb; for (auto &f : frames) fb[f.first] = f.second;
  std::vector<std::pair<uint64_t, uint64_t>> spans; int n6 = 0;
  for (uint32_t k = 0; k < n; k++) {
    const uint8_t *e = raw + d + 24 * (size_t)k; const uint64_t off = u64(e); const uint32_t packed = u32(e + 8), lo = u32(e + 12), tw = u32(e + 16), key = u32(e + 20);
    const uint64_t L = ((uint64_t)(tw & 0xc0) << 26) | lo; const unsigned type = tw & 0x3f;
    auto f = fb.find(s1 + (size_t)off); if (off > l1 || f == fb.end()) return "block directory entry " + std::to_string(k) + " names no frame of the block";
    const uint64_t st = (uint64_t)f->second + packed; spans.push_back({st, L});
    if (type == 6) { n6++; if (key != 0) return "type-6 directory entry with key " + std::to_string(key); T0 = (size_t)st; TL = (size_t)L; }
  }
  std::sort(spans.begin(), spans.end()); uint64_t at = 0;
  for (auto &p : spans) { if (p.first != at) return "block directory entries do not cover the stream exactly (at " + std::to_string(at) + ")"; at += p.second; }
  if (at != SL) return "block directory entries do not cover the stream exactly (end " + std::to_string(at) + " of " + std::to_string(SL) + ")";
  if (n6 != 1) return std::to_string(n6) + " type-6 directory entries";
  if (T0 + TL != SL || TL % 16) return "type-6 entry does not end the stream in whole 16-byte entries";
  return "";
}
// --tuples-end: read the quads of [T0, SL). Every quad must be well formed (every word below 2^28; a key on instance 0 names a
// handle, NV <= local < NV + K; a target on instance 0 names a value below NV + K), else no quad is read.
inline std::string tuple_quads(const uint8_t *s, size_t SL, size_t T0, uint32_t NV, uint32_t K, std::vector<std::array<uint32_t, 4>> &out) {
  out.clear(); if (T0 > SL || (SL - T0) % 16) return "tuple table is not whole 16-byte entries";
  const uint64_t VM = (uint64_t)NV + K;
  for (size_t q = T0; q < SL; q += 16) {
    uint32_t a = u32(s + q), b = u32(s + q + 4), c = u32(s + q + 8), d = u32(s + q + 12);
    if (((a | b | c | d) >> 28) || (a == 0 && !(b >= NV && b < VM)) || (c == 0 && d >= VM)) { out.clear(); return "tuple entry at stream offset " + std::to_string(q) + " is not well formed"; }
    out.push_back({a, b, c, d});
  }
  return "";
}
inline Block read(const uint8_t *raw, size_t len) {
  Block R; if (len < 0x540) throw std::runtime_error("file too short");
  const size_t sec = (size_t)raw[0x3c] * 256; if (sec != 1024) throw std::runtime_error("header section size is not 1024");
  const uint64_t p538 = u64(raw + 0x538);
  if (!p538) { R.none = "no 0x538 derivation block"; return R; }
  R.present = true;
  // ---- section+0xf0 tables: chunks of u32 length + lz0(lz0(...))
  uint64_t p = u64(raw + sec + 0xf0); size_t end = len;
  { const uint8_t mk[4] = {0x21, 0x43, 0x65, 0x87}; for (size_t q = p; q + 4 <= len; q++) if (!memcmp(raw + q, mk, 4)) { end = q; break; } }
  std::vector<Bytes> chunks; size_t pos = p;
  while (pos + 4 < end && chunks.size() < 64) {
    bool found = false;
    for (int d = 0; d < 16 && !found; d++) {
      size_t q = pos + d; if (q + 4 > end) break; int64_t n = (int64_t)u32(raw + q) - 1;
      if (!(1 <= n && n <= (int64_t)(end - q - 4))) continue;
      try { Bytes s1 = lz0(raw + q + 4, (size_t)n); Bytes s2 = lz0(s1.data(), s1.size()); chunks.push_back(std::move(s2)); pos = q + 4 + n; found = true; }
      catch (const std::exception &) {}
    }
    if (!found) break;
  }
  if (chunks.size() < 2) throw std::runtime_error("port-copy / stored tables not found");
  R.t0 = trecs(chunks[0]); R.t1 = trecs(chunks[1]); R.nchunks = chunks.size();
  if (chunks.size() > 2) { try { R.t2 = trecs(chunks[2]); } catch (const std::exception &) { R.t2.clear(); } }
  // ---- derivation streams
  if (p538 + 8 > len || memcmp(raw + p538, "!Ce\x87", 4)) throw std::runtime_error("derivation block magic");
  uint32_t vl = u32(raw + p538 + 4); { const char *v = (const char *)raw + p538 + 8; R.ver.assign(v, strnlen(v, vl)); }
  std::vector<Bytes> outs; std::vector<size_t> fpos; size_t i = p538 + 8 + vl;   // fpos: file position of each frame's length word
  while (outs.size() < 2) {
    size_t j = i; Bytes o; size_t c = 0;
    for (;;) {
      const uint8_t *f = (const uint8_t *)memmem(raw + j, len - j, "\x78\x01", 2); if (!f) throw std::runtime_error("no framed zlib stream");
      j = f - raw; if (j < 4) throw std::runtime_error("no framed zlib stream");
      c = inflate_at(raw, len, j, o); if (c && u32(raw + j - 4) == c) break; j++;
    }
    outs.push_back(std::move(o)); fpos.push_back(j - 4); i = j + c;
  }
  while (i + 6 <= len && raw[i + 4] == 0x78 && raw[i + 5] == 0x01) {
    uint32_t n = u32(raw + i); Bytes o; size_t c = inflate_at(raw, len, i + 4, o); if (!c || c != n) break;
    outs.push_back(std::move(o)); fpos.push_back(i); i += 4 + n;
  }
  R.z0 = outs[0]; for (size_t k = 1; k < outs.size(); k++) R.S.insert(R.S.end(), outs[k].begin(), outs[k].end());
  const Bytes &S = R.S; const uint8_t *s = S.data(); const size_t SL = S.size();
  R.NV = u32(s); R.K = u32(s + 4); const uint64_t VM = (uint64_t)R.NV + R.K;
  size_t bc = SL; { const uint8_t *f = (const uint8_t *)memmem(s, SL, "bcid", 4); if (f) bc = f - s; }
  const std::string TXT(S.begin() + bc, S.end());
  size_t NBT = 0; { static const std::regex r("bcid \\d+ \\d+ "); NBT = std::distance(std::sregex_iterator(TXT.begin(), TXT.end(), r), std::sregex_iterator()); }
  auto table = [&](size_t o, size_t n, size_t lim, std::vector<Entry> &out) -> std::pair<bool, size_t> {
    out.clear(); size_t q = o;
    for (size_t k = 0; k < n; k++) {
      if (q >= lim) return {false, q};
      uint32_t na, cl; size_t h;
      if (s[q] == 0) { if (q + 5 > SL) return {false, q}; uint16_t a, b; memcpy(&a, s + q + 1, 2); memcpy(&b, s + q + 3, 2); na = a; cl = b; h = 5; }
      else if (s[q] == 0xc0) { if (q + 9 > SL) return {false, q}; na = u32(s + q + 1); cl = u32(s + q + 5); h = 9; }
      else return {false, q};
      if (q + h + cl > SL) return {false, q};
      out.push_back({na, Bytes(s + q + h, s + q + h + cl)}); q += h + cl;
    }
    return {true, q};
  };
  int64_t desc = -1; size_t be = 0;
  for (int pas = 0; pas < 2 && desc < 0; pas++)
    for (size_t o = 0; o + 8 < bc; o++) {
      if (s[o + 3] != 0x80) continue;
      uint32_t nT = u32(s + o) & 0x3fffffff, nB = u32(s + o + 4);
      if (!(0 < nT && nT < 1000000) || nB > 10000000 || ((pas == 0) != (nB == NBT))) continue;
      auto rt = table(o + 8, nT, bc, R.T); if (!rt.first || R.T.size() != nT) continue;
      if (nB) { auto rb = table(rt.second, nB, SL, R.B); if (!rb.first || R.B.size() != nB) continue; be = rb.second; } else { R.B.clear(); be = rt.second; }
      desc = (int64_t)o; break;
    }
  if (desc < 0) throw std::runtime_error("op table not found");
  { static const std::regex r("bcid (\\d+) (\\d+) ([^\\n]*?) RET"); static const std::regex a("CALL_ARG_VAL,(\\d+)");
    for (auto it = std::sregex_iterator(TXT.begin(), TXT.end(), r); it != std::sregex_iterator(); ++it) {
      uint32_t id = std::stoul((*it)[1]); std::string body = (*it)[3]; uint32_t mx = 0; bool any = false;
      for (auto jt = std::sregex_iterator(body.begin(), body.end(), a); jt != std::sregex_iterator(); ++jt) { mx = std::max<uint32_t>(mx, std::stoul((*jt)[1])); any = true; }
      R.barity[id] = any ? mx : 1;
    } }
  auto key = [](uint32_t x) -> Key { uint32_t t = x >> 30, v = x & 0x3fffffff; if (v >> 28 == 1) return {'B', v & 0x0fffffff}; return {"PTQC"[t], v}; };
  auto arity = [&](const Key &k) -> int64_t {
    if (k.k == 'B') { auto it = R.barity.find(k.id); return it == R.barity.end() ? -1 : it->second; }
    if (k.k == 'Q') return 1;
    if ((k.k == 'P' || k.k == 'T') && k.id < R.T.size()) { uint32_t a = R.T[k.id].na; if (k.k == 'P' && a == 0) return -1; return a; }
    return -1;
  };
  auto parse_stream = [&](size_t off, size_t n, std::vector<Rec> &out) -> int64_t {
    size_t o = off; out.clear();
    for (size_t k = 0; k < n; k++) {
      if (o + 8 > SL) return -1;
      Rec r; r.dst = u32(s + o); r.key = key(u32(s + o + 4)); o += 8; int64_t a = arity(r.key);
      if (a < 0 || o + 4 * (size_t)a > SL) return -1;
      for (int64_t q = 0; q < a; q++) r.args.push_back(u32(s + o + 4 * q)); o += 4 * a; out.push_back(std::move(r));
    }
    return (int64_t)o;
  };
  // width list (tag 3 = n one-bit values; any other word = one value of width w & 0x3fffffff)
  auto widths = [&](size_t off, size_t n_expect, size_t lim, std::vector<uint32_t> &W) -> int64_t {
    W.clear(); size_t o = off;
    while (W.size() < n_expect && o + 4 <= lim) { uint32_t w = u32(s + o); o += 4; if (w >> 30 == 3) W.insert(W.end(), w & 0x3fffffff, 1); else W.push_back(w & 0x3fffffff); }
    return W.size() == n_expect ? (int64_t)o : -1;
  };
  bool okrec = false;
  { int64_t o = widths(8, R.NV, SL, R.W);
    if (o >= 0 && (size_t)o + R.NV + 4 <= SL) {
      size_t q = o + R.NV; uint32_t h = u32(s + q); int64_t e = parse_stream(q + 4, h, R.recs);
      if (e == desc) { okrec = true; for (auto &r : R.recs) if (r.dst >= R.NV) okrec = false; }
      if (okrec) R.types.assign(s + q - R.NV, s + q);
    } }
  if (!okrec) throw std::runtime_error("record stream not at its direct place (no slow search fallback)");
  // ---- local templates after the last code-block text
  size_t E0s = be; { for (size_t q = SL; q >= 4; q--) if (!memcmp(s + q - 4, "RET\n", 4)) { E0s = q; break; } }
  auto typeb = [](uint8_t b) { return b >= 1 && b < 0xc0; };
  auto parse_loc = [&](size_t q, std::vector<Rec> &out) -> int64_t {
    uint32_t n = u32(s + q); if (!(0 < n && n < 100000)) return -1;
    int64_t e = parse_stream(q + 4, n, out); if (e < 0) return -1;
    for (auto &r : out) { if (r.dst >> 28) return -1; for (size_t a = (r.key.k == 'B' ? 1 : 0); a < r.args.size(); a++) if (r.args[a] >> 28) return -1; }
    return e;
  };
  for (size_t off = E0s; off + 12 < SL; off++) {
    if (!R.tpl.empty() && off < R.tpl.back().end) continue;
    uint32_t N = u32(s + off); if (!(2 <= N && N < 4096)) continue;
    size_t qmax = std::min<size_t>(SL - 4, off + 8 + N + 4 * (N + 2));
    for (size_t q = off + 8 + N; q <= qmax; q++) {
      if ((q - N - off) % 4 || (s[q - N - 1] != 0 && s[q - N - 1] != 0xc0)) continue;
      bool all = true; for (size_t k = q - N; k < q; k++) if (!typeb(s[k])) { all = false; break; }
      if (!all) continue;
      std::vector<Rec> rr; int64_t e = parse_loc(q, rr);
      if (e >= 0 && !rr.empty()) {
        Tpl t; t.off = off; t.N = N; t.K = u32(s + off + 4); t.types.assign(s + q - N, s + q); t.recs = std::move(rr); t.nrec_pos = q; t.end = (size_t)e;
        if (widths(off + 8, N, q - N, t.W) != (int64_t)(q - N)) throw std::runtime_error("template width list");
        R.tpl.push_back(std::move(t)); break;
      }
    }
  }
  size_t tail = R.tpl.empty() ? E0s : R.tpl.back().end;
  if (!tuples_end) { for (size_t q = tail; q + 16 <= tail + ((SL - tail) / 16) * 16; q += 16) R.tuples.push_back({u32(s + q), u32(s + q + 4), u32(s + q + 8), u32(s + q + 12)}); }
  else {
    std::vector<std::pair<size_t, size_t>> frames; size_t base = 0;   // (frame position, offset of its bytes in S) for S's frames
    for (size_t k = 1; k < outs.size(); k++) { frames.push_back({fpos[k], base}); base += outs[k].size(); }
    size_t T0 = 0, TL = 0; R.tuples_why = tuple_span(raw, len, p538 + 8 + vl, frames, SL, T0, TL);
    if (R.tuples_why.empty()) { if (tuples_red == 1) T0 += 4; R.tuples_why = tuple_quads(s, SL, T0, R.NV, R.K, R.tuples); }
    if (R.tuples_why.empty()) { R.tuples_gap = T0 >= tail ? T0 - tail : 0; if (tuples_red == 2 && !R.tuples.empty()) { auto q = R.tuples.back(); q[3] ^= 1; R.tuples.push_back(q); } }
    else R.tuples.clear();
  }
  // ---- constant section in stream 0 (corrected layout): u32 176, N,
  // first table N i32 (8-byte entries), second table N i32 (4-byte entries), u32 S payload size, payload, N u32 widths; the
  // section must end exactly at the stream end. An 8-byte entry is (first word, value word); kept as value word + first word,
  // so a nonzero first word still reads as a nonzero upper word and stays refused. pool_old_cut = planted red (earlier cut).
  if (!pool_old_cut) { const Bytes &z = R.z0; const uint8_t *zp = z.data(); size_t zl = z.size();
    // located by these checks alone (no marker word): exact end, one table per entry, first-table entry = 2 x ceil(w/32)
    // words (two planes), second-table entry = 4 bytes, entries cover the payload exactly; exactly one position must fit.
    auto rd = [&](size_t o) { return u32(zp + o); }; auto ri = [&](size_t o) { return i32(zp + o); };
    size_t ii = 4; for (int k = 0; k < 2; k++) { uint32_t L = rd(ii); ii += 4 + L; }
    struct E { bool alt; int64_t off, len; uint32_t w; }; struct C { size_t base; std::vector<E> e; }; std::vector<C> fits;
    for (size_t p = ii; p + 8 < zl; p++) {
      uint32_t N = rd(p); if (N == 0 || N > (1u << 22) || p + 8 + 8 * (size_t)N > zl) continue;
      uint32_t S = rd(p + 4 + 8 * (size_t)N); size_t base = p + 8 + 8 * (size_t)N;
      if (base + (size_t)S + 4 * (size_t)N != zl) continue;
      C c{base, {}}; bool ok = true;
      for (uint32_t k = 0; k < N && ok; k++) {
        int32_t a = ri(p + 4 + 4 * k), b = ri(p + 4 + 4 * (size_t)N + 4 * k); uint32_t w = rd(base + S + 4 * (size_t)k);
        if ((a == -1) == (b == -1) || w == 0) ok = false;
        else c.e.push_back(a != -1 ? E{false, a, 8 * (((int64_t)w + 31) / 32), w} : E{true, b, 4, w});
      }
      if (!ok) continue;
      std::vector<std::pair<int64_t, int64_t>> x; for (auto &e : c.e) x.push_back({e.off, e.len}); std::sort(x.begin(), x.end());
      int64_t q = 0; for (auto &y : x) { if (y.first != q) { ok = false; break; } q += y.second; }
      if (ok && q == (int64_t)S) fits.push_back(std::move(c));
    }
    if (fits.size() == 1) {
      auto &c = fits[0];
      for (uint32_t k = 0; k < c.e.size(); k++) {   // raw bytes in section order; first-table: unknown plane words, then value plane words
        auto &e = c.e[k]; R.pool[k] = Bytes(zp + c.base + e.off, zp + c.base + e.off + e.len); R.poolWidth[k] = e.w; if (e.alt) R.poolAlt.insert(k);
        if (!e.alt && c.base + e.off + 12 <= zl && u32(zp + c.base + e.off + 8) != 0) R.poolNew.insert(k);
      }
    }
  } else
  // ---- (planted red only) earlier cut: constant pool in stream 0 (u32 176, N, T1 = N i32 offsets of 8-byte constants, T2 = N+1 of 4-byte, u32 0, data)
  { const Bytes &z = R.z0; const uint8_t *zp = z.data(); size_t zl = z.size();
    auto rd = [&](size_t o) { return u32(zp + o); }; auto ri = [&](size_t o) { return i32(zp + o); };
    size_t ii = 4; for (int k = 0; k < 2; k++) { uint32_t L = rd(ii); ii += 4 + L; }
    struct C { size_t o, outerEnd, ds; uint32_t N; }; std::vector<C> cands;
    for (size_t o = ii; o + 8 < zl; o++) {
      if (rd(o) != 176) continue; uint32_t N = rd(o + 4); if (N == 0 || N > (1u << 22)) continue;
      size_t t1 = o + 8, t2 = t1 + 4 * (size_t)N, pad = t2 + 4 * ((size_t)N + 1), ds = pad + 4;
      if (ds > zl || rd(pad) != 0) continue;
      int64_t dl = zl - ds, l1 = -1, l2 = -1, e1 = 0; bool good = true;
      for (uint32_t k = 0; k < N && good; k++) { int32_t x = ri(t1 + 4 * k); if (x == -1) continue; if (x < 0 || x % 8 || x <= l1 || x + 8 > dl) good = false; else { l1 = x; e1 = x + 8; } }
      for (uint32_t k = 0; k <= N && good; k++) { int32_t x = ri(t2 + 4 * k); if (x == -1) continue; if (x < 0 || x <= l2 || x < e1 || x + 4 > dl) good = false; else l2 = x; }
      if (good) cands.push_back({o, pad + 4, ds, N});
    }
    std::vector<C> outer; for (auto &a : cands) { bool in = false; for (auto &b : cands) if (&b != &a && b.o < a.o && a.o < b.outerEnd) in = true; if (!in) outer.push_back(a); }
    if (outer.size() == 1) {
      auto &c = outer[0]; size_t t1 = c.o + 8, t2 = t1 + 4 * (size_t)c.N;
      for (uint32_t k = 0; k <= c.N; k++) {
        int32_t a = k < c.N ? ri(t1 + 4 * k) : -1, b = ri(t2 + 4 * k);
        if (a != -1 && b != -1) throw std::runtime_error("constant pool: both offsets set");
        if (a != -1) R.pool[k] = Bytes(zp + c.ds + a, zp + c.ds + a + 8); else if (b != -1) R.pool[k] = Bytes(zp + c.ds + b, zp + c.ds + b + 4);
      }
    } }
  return R;
}

}  // namespace dblk
