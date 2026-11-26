// SPDX-License-Identifier: MIT
// wcz_base.h: shared primitives for WCZ1 (SPEC.md): little-endian loads/stores, XXH64, strict varints, the stream
// hash, limits and enums.
// Varints are strict (minimal, at most 64 bits) so that every number has exactly one valid encoding: two readers
// can never disagree about what a byte sequence means, and a malformed length is refused before it is used.
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace wcz {

static const uint32_t NONE32 = 0xFFFFFFFFu;
static const uint64_t NONE64 = ~0ull;
static const uint32_t MAX_ROWS = 1u << 20, MAX_BLOCK_ROWS_TARGET = 65536, MAX_BITS = 1u << 20, MAX_STR = 1u << 20;
static const uint64_t MAX_DECODED = 1ull << 28, MAX_RSIZE = 1ull << 28;
static const uint32_t MIN_KEY_ROWS = 16, MAX_CHUNKS = 65535;
enum { VT_BITS = 0, VT_REAL = 1, VT_STRING = 2 };
enum { M_XOR = 0, M_DICT = 1, M_STR = 2
};
enum { F_2ST = 1
};
static const uint32_t SEEK_SIZE = 32;

static inline uint16_t ld16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static inline uint32_t ld32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static inline uint64_t ld64(const uint8_t *p) { return (uint64_t)ld32(p) | ((uint64_t)ld32(p + 4) << 32); }
static inline uint64_t align8(uint64_t x) { return (x + 7) & ~7ull; }
static inline void p8(std::vector<uint8_t> &b, uint8_t v) { b.push_back(v); }
static inline void p16(std::vector<uint8_t> &b, uint16_t v) { b.push_back((uint8_t)v); b.push_back((uint8_t)(v >> 8)); }
static inline void p32(std::vector<uint8_t> &b, uint32_t v) { for (int i = 0; i < 4; i++) b.push_back((uint8_t)(v >> (8 * i))); }
static inline void p64(std::vector<uint8_t> &b, uint64_t v) { for (int i = 0; i < 8; i++) b.push_back((uint8_t)(v >> (8 * i))); }
static inline void st32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i)); }
static inline void st64(uint8_t *p, uint64_t v) { for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i)); }
static inline void pad8(std::vector<uint8_t> &b) { while (b.size() & 7) b.push_back(0); }
static inline void putVar(std::vector<uint8_t> &b, uint64_t v) { while (v >= 0x80) { b.push_back((uint8_t)(v | 0x80)); v >>= 7; } b.push_back((uint8_t)v); }
// ---- XXH64 (seed 0 by default), the reference algorithm ----
namespace detail {
static const uint64_t P1 = 11400714785074694791ull, P2 = 14029467366897019727ull, P3 = 1609587929392839161ull,
                      P4 = 9650029242287828579ull, P5 = 2870177450012600261ull;
static inline uint64_t rotl(uint64_t x, int r) { return (x << r) | (x >> (64 - r)); }
static inline uint64_t round1(uint64_t acc, uint64_t in) { acc += in * P2; acc = rotl(acc, 31); return acc * P1; }
static inline uint64_t merge(uint64_t acc, uint64_t v) { acc ^= round1(0, v); return acc * P1 + P4; }
}  // namespace detail
static inline uint64_t xxh64(const void *data, size_t len, uint64_t seed = 0) {
  using namespace detail;
  const uint8_t *p = (const uint8_t *)data, *end = p + len; uint64_t h;
  if (len >= 32) {
    uint64_t v1 = seed + P1 + P2, v2 = seed + P2, v3 = seed, v4 = seed - P1; const uint8_t *lim = end - 32;
    do { v1 = round1(v1, ld64(p)); v2 = round1(v2, ld64(p + 8)); v3 = round1(v3, ld64(p + 16)); v4 = round1(v4, ld64(p + 24)); p += 32; } while (p <= lim);
    h = rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18);
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else h = seed + P5;
  h += (uint64_t)len;
  while (p + 8 <= end) { h ^= round1(0, ld64(p)); h = rotl(h, 27) * P1 + P4; p += 8; }
  if (p + 4 <= end) { h ^= (uint64_t)ld32(p) * P1; h = rotl(h, 23) * P2 + P3; p += 4; }
  while (p < end) { h ^= (uint64_t)(*p) * P5; h = rotl(h, 11) * P1; p++; }
  h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32; return h;
}

// incremental XXH64: digest() equals xxh64() over the concatenation of every update() so far, for any split
struct Xxh64Stream {
  explicit Xxh64Stream(uint64_t seed = 0) : seed_(seed) { v_[0] = seed + detail::P1 + detail::P2; v_[1] = seed + detail::P2; v_[2] = seed; v_[3] = seed - detail::P1; }
  void update(const void *data, size_t len) {
    const uint8_t *p = (const uint8_t *)data; total_ += len;
    if (bl_ + len < 32) { if (len) memcpy(buf_ + bl_, p, len); bl_ += (uint32_t)len; return; }
    if (bl_) { size_t k = 32 - bl_; memcpy(buf_ + bl_, p, k); stripe(buf_); p += k; len -= k; bl_ = 0; }
    while (len >= 32) { stripe(p); p += 32; len -= 32; }
    if (len) memcpy(buf_, p, len);
    bl_ = (uint32_t)len;
  }
  uint64_t digest() const {
    using namespace detail;
    uint64_t h;
    if (total_ >= 32) {
      h = rotl(v_[0], 1) + rotl(v_[1], 7) + rotl(v_[2], 12) + rotl(v_[3], 18);
      h = merge(h, v_[0]); h = merge(h, v_[1]); h = merge(h, v_[2]); h = merge(h, v_[3]);
    } else h = seed_ + P5;
    h += total_;
    const uint8_t *p = buf_, *end = buf_ + bl_;
    while (p + 8 <= end) { h ^= round1(0, ld64(p)); h = rotl(h, 27) * P1 + P4; p += 8; }
    if (p + 4 <= end) { h ^= (uint64_t)ld32(p) * P1; h = rotl(h, 23) * P2 + P3; p += 4; }
    while (p < end) { h ^= (uint64_t)(*p) * P5; h = rotl(h, 11) * P1; p++; }
    h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32; return h;
  }
 private:
  void stripe(const uint8_t *p) { using namespace detail; v_[0] = round1(v_[0], ld64(p)); v_[1] = round1(v_[1], ld64(p + 8)); v_[2] = round1(v_[2], ld64(p + 16)); v_[3] = round1(v_[3], ld64(p + 24)); }
  uint64_t v_[4], seed_, total_ = 0; uint8_t buf_[32]; uint32_t bl_ = 0;
};

// ---- strict varint: <= 10 bytes, no bits past 64, minimal; never reads at or past `end` ----
static inline bool getVar(const uint8_t *&p, const uint8_t *end, uint64_t &out) {
  uint64_t v = 0;
  for (int i = 0; i < 10; i++) {
    if (p >= end) return false;
    uint8_t c = *p++;
    if (i == 9 && c > 1) return false;
    v |= (uint64_t)(c & 0x7f) << (7 * i);
    if (!(c & 0x80)) { if (i > 0 && c == 0) return false; out = v; return true; }
  }
  return false;
}

// The WCB2 stream hash (wcb.h hmix, WCB2 §II.5), needed to verify a decoded record against its header. n (the value's
// length) is folded into the word seed; value words are read little-endian.
static inline uint64_t hmix(uint64_t h, uint64_t t, const uint8_t *v, size_t n) {
  uint64_t a = 0x9E3779B97F4A7C15ull ^ n; size_t i = 0;
  for (; i + 8 <= n; i += 8) { uint64_t w = ld64(v + i); a ^= w; a *= 0xff51afd7ed558ccdull; a ^= a >> 32; }  // words little-endian on any host
  for (; i < n; i++) { a ^= v[i]; a *= 0x100000001b3ull; }
  h ^= a ^ (t * 0xC2B2AE3D27D4EB4Full); h *= 0x100000001b3ull; h ^= h >> 29; return h;
}
static const uint64_t HASH_INIT = 1469598103934665603ull;
// dst = a XOR b over w bytes, word-wise (8 bytes at a time)
static inline void xorInto(uint8_t *dst, const uint8_t *a, const uint8_t *b, uint32_t w) {
  uint32_t j = 0;
  for (; j + 8 <= w; j += 8) { uint64_t x, y; memcpy(&x, a + j, 8); memcpy(&y, b + j, 8); x ^= y; memcpy(dst + j, &x, 8); }
  for (; j < w; j++) dst[j] = a[j] ^ b[j];
}


}  // namespace wcz
