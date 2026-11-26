// SPDX-License-Identifier: MIT
// wcz_seg.h: reader for the WCZ1 segment layout (spec/SPEC.md, version 1): complete files (fast open through the INDEX),
// incomplete files (recovery by scanning segments) and growing files (follow).
//
// Untrusted input. Every structure is checked against SPEC.md before it is used; after a successful open, every
// accessor is bounds-safe and every decode verifies the block (or chunk) checksum before zstd.
// Checks are lazy: open() reads the header, Trailer, INDEX and dictionary but no DATA, and a signal's index entries
// and blocks are checked on first use. That keeps open cheap on a large file; verify() runs every check eagerly.
#pragma once
#include "wcz_block.h"
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <memory>
#include <string_view>
#include <vector>
#if defined(__unix__) || defined(__APPLE__)
#include <sys/mman.h>
#include <unistd.h>
#endif

namespace wcz {

static const uint32_t FILE_MAGIC = 0x315A4357, SEG_MAGIC = 0x47535A57, END_MAGIC = 0x45535A57, TRL_MAGIC = 0x52545A57;
static const uint32_t FHDR = 64, SEGH = 32, SEGE = 32, TRL = 64, BENT = 64, DENT = 16, SEGX = 40, SIGX = 80, BLKX = 64, SECT = 24;
static const uint32_t SCOPE_SZ = 16, VAR_SZ = 32, SIGD_SZ = 32, ENUM_SZ = 16, EMEM_SZ = 16;
enum { SEG_META = 1, SEG_META_APPEND = 2, SEG_DATA = 3, SEG_LOD = 4, SEG_SEQ = 5, SEG_INDEX = 6, SEG_COMP = 7, SEG_SEGNB = 10 };
// INDEX flags (the u32 after n_doff, SPEC §II.8)
enum { SF_OPTIONAL = 1 };
enum { WRITER_CONVERTER = 1, WRITER_STREAM = 2 };
// Header feature bits this reader implements, per class (SPEC §II.11): compat bit 1, absent-var reasons (vrsn).
// (compat bit 0, NETW, is evaluated by the expansion tools, not by this reader.)
enum { COMPAT_NETW = 1, COMPAT_VRSN = 2 };
static const uint32_t KNOWN_INCOMPAT = 0; static const uint16_t KNOWN_RO_COMPAT = 0, KNOWN_COMPAT = COMPAT_VRSN;
enum { TAG_STRS = 0x53525453, TAG_SCOP = 0x504F4353, TAG_VARS = 0x53524156, TAG_SIGD = 0x44474953, TAG_ENUM = 0x4D554E45, TAG_EMEM = 0x4D454D45 };
// Ancillary META section 'vrsn' (SPEC §II.4.7): why a declared var has no values. 16 B per entry.
enum { TAG_VRSN = 0x6E737276 };
static const uint32_t VRSN_SZ = 16;
static const uint64_t MAX_BODY = 1ull << 40;
static const uint32_t MAX_ITEMS = 1u << 28, MAX_SEG_BLOCKS = 1u << 24, MAX_DOFF_TOTAL = 1u << 24, MAX_STRING_LEN = 65535;
enum { VS_STORED = 0, VS_ABSENT = 1, VS_UNSUPPORTED = 2 };

struct FileHeader { uint16_t version = 1; uint32_t incompat = 0; uint16_t roCompat = 0, compat = 0; uint32_t writer = 0; int8_t tsExp = 0; uint16_t tsMult = 1; uint64_t tBegin = 0, stamp = 0, fileId = 0, bodyOff = FHDR; };
struct ScopeE { uint32_t name, parent; uint8_t kind; };
struct VarE {
  uint32_t name, scope, signal; int32_t msb, lsb; uint8_t state, kind, dir, type, flags; uint32_t enm;
  // abs(msb - lsb) + 1 in 64 bits (up to 2^32: a 32-bit width would wrap to 0)
  uint64_t width() const { int64_t d = (int64_t)msb - lsb; return (uint64_t)(d < 0 ? -d : d) + 1; }
};
struct SigDecl { SigSpec spec; uint32_t blockRows = 16384; };
struct EnumE { uint32_t name, bits, first, count; };
struct EnumMem { uint32_t name; uint64_t value; };
// Appendix C reason codes (SPEC §II.4.7). nullptr for a reserved or private code (shown as "code N").
enum { VR_UNSPECIFIED = 0, VR_NOT_IN_SOURCE = 1, VR_PORT_COPY_NOT_LINKED = 2, VR_UNSUPPORTED_ENCODING = 3, VR_TYPE_NOT_CAPTURED = 4,
       VR_TYPE_NOT_STORABLE = 5, VR_OVER_LIMIT = 6, VR_REFUSED = 7 };
static inline const char *reasonCodeName(uint16_t c) {
  static const char *n[8] = {"unspecified", "not-in-source", "port-copy-not-linked", "unsupported-encoding", "type-not-captured",
                             "type-not-storable", "over-limit", "refused"};
  return c < 8 ? n[c] : nullptr;
}
// A var's absent/unsupported reason (SPEC §II.4.7): code (Appendix C) and an optional string index (or NONE32).
struct VarReason { uint32_t var; uint16_t code; uint32_t text; };
struct Dict {
  std::vector<std::string> strs; std::vector<ScopeE> scopes; std::vector<VarE> vars; std::vector<SigDecl> sigs; std::vector<EnumE> enums; std::vector<EnumMem> mems;
  // vrsn reasons, sorted by var. They are informational: a broken vrsn section never fails the open; every reason is
  // dropped and reasonsErr says why (a whole-file verification reports it).
  std::vector<VarReason> reasons; std::string reasonsErr;
};
struct SegInfo { uint64_t off = 0, bodyLen = 0, tCut = NONE64, xxh = 0; uint16_t type = 0; uint32_t flags = 0, seq = 0; };
struct BlockRef { uint64_t off; uint32_t sig, seg, entry; BlockInfo info; };
struct SigSum { uint64_t n = 0, nNorm = 0, t0 = 0, tLast = 0, hash = 0; bool hashKnown = false; uint8_t codec = 0; uint32_t ref = NONE32, lod = NONE32; };
struct DoffE { uint64_t t; uint32_t kind; };
// LOD (SPEC §II.7): one bucket of a level (cnt = min(changes, 2); flags bit 0 any x/z, bit 1 the value after for
// 1-bit signals), a level's size, a signal's levels, and one chunk's frame in place.
struct LodBucket { uint64_t bucket; uint8_t cnt, flags; };
struct LodLevel { uint32_t nchunk = 0; uint64_t entries = 0; };
struct LodInfo { uint64_t lodBase = 0; uint32_t nlev = 0; std::vector<LodLevel> levels; };
struct LodChunk { uint64_t b0 = 0, xxh = 0; uint32_t n = 0, rsize = 0, csize = 0; const uint8_t *frame = nullptr; };
static const uint32_t MAX_LOD_ENTRIES = 16384, MAX_LOD_LEVELS = 32, MAX_LOD_CHUNKS = 1u << 24, LODSIG = 32, LODLEV = 16, LODENT = 40;

// One flag per item, set from const methods, possibly on several threads at once. The checks they record are
// idempotent, so a race only repeats one. Copies copy the values.
struct CheckFlags {
  std::unique_ptr<std::atomic<uint8_t>[]> f; size_t n = 0;
  CheckFlags() = default;
  CheckFlags(const CheckFlags &o) { *this = o; }
  CheckFlags &operator=(const CheckFlags &o) { if (this != &o) { assign(o.n); for (size_t i = 0; i < n; i++) f[i].store(o.f[i].load(std::memory_order_relaxed), std::memory_order_relaxed); } return *this; }
  CheckFlags(CheckFlags &&) noexcept = default; CheckFlags &operator=(CheckFlags &&) noexcept = default;
  void assign(size_t k) { f.reset(k ? new std::atomic<uint8_t>[k]() : nullptr); n = k; }
  bool get(size_t i) const { return f[i].load(std::memory_order_acquire) != 0; }
  void set(size_t i) const { f[i].store(1, std::memory_order_release); }
};
// The same, one bit per item (for per-block flags).
struct CheckBits {
  std::unique_ptr<std::atomic<uint64_t>[]> f; size_t n = 0;
  CheckBits() = default;
  CheckBits(const CheckBits &o) { *this = o; }
  CheckBits &operator=(const CheckBits &o) { if (this != &o) { assign(o.n); for (size_t i = 0; i < (n + 63) / 64; i++) f[i].store(o.f[i].load(std::memory_order_relaxed), std::memory_order_relaxed); } return *this; }
  CheckBits(CheckBits &&) noexcept = default; CheckBits &operator=(CheckBits &&) noexcept = default;
  void assign(size_t k) { f.reset(k ? new std::atomic<uint64_t>[(k + 63) / 64]() : nullptr); n = k; }
  bool get(size_t i) const { return f[i >> 6].load(std::memory_order_acquire) >> (i & 63) & 1; }
  void set(size_t i) const { f[i >> 6].fetch_or(1ull << (i & 63), std::memory_order_release); }
};

namespace segdetail {
static inline bool fail(std::string &err, const std::string &m) { err = m; return false; }
static inline bool zeros(const uint8_t *p, size_t n) { for (size_t i = 0; i < n; i++) if (p[i]) return false; return true; }
static inline bool utf8ok(const uint8_t *s, size_t n) {
  for (size_t i = 0; i < n;) {
    uint8_t c = s[i];
    if (c < 0x20 || c == 0x7f) return false;
    if (c < 0x80) { i++; continue; }
    int k = (c & 0xE0) == 0xC0 ? 1 : (c & 0xF0) == 0xE0 ? 2 : (c & 0xF8) == 0xF0 ? 3 : -1;
    if (k < 0 || i + (size_t)k >= n) return false;
    uint32_t cp = c & (0x3F >> k);
    for (int j = 1; j <= k; j++) { if ((s[i + j] & 0xC0) != 0x80) return false; cp = (cp << 6) | (s[i + j] & 0x3F); }
    if ((k == 1 && cp < 0x80) || (k == 2 && cp < 0x800) || (k == 3 && (cp < 0x10000 || cp > 0x10FFFF)) || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += k + 1;
  }
  return true;
}
static inline void parseEnt(const uint8_t *q, BlockInfo &e, uint32_t &sig, uint64_t &off, uint64_t &res) {
  sig = ld32(q); e.rows = ld32(q + 4); e.nNorm = ld32(q + 8); e.nchunk = ld16(q + 12); e.mode = q[14]; e.flags = q[15];
  e.t0 = ld64(q + 16); e.tLast = ld64(q + 24); off = ld64(q + 32); e.len = ld32(q + 40); e.rsize = ld32(q + 44); e.xxh = ld64(q + 48); res = ld64(q + 56);
}
// A vrsn section (SPEC §II.4.7), checked against d (this segment's entries already added). A broken one drops every
// reason (this section's and earlier ones) and sets d.reasonsErr; it never fails the parse.
static inline void addReasons(const uint8_t *p, uint32_t count, uint64_t len, Dict &d) {
  if (!d.reasonsErr.empty()) return;  // dropped already: later sections are not used either
  auto bad = [&](const std::string &m) { d.reasons.clear(); d.reasons.shrink_to_fit(); d.reasonsErr = "vrsn: " + m; };
  if ((uint64_t)count * VRSN_SZ != len || count > MAX_ITEMS) return bad("section length is not 16 x count");
  std::vector<VarReason> add; add.reserve(count);
  for (uint32_t i = 0; i < count; i++) {
    const uint8_t *q = p + (uint64_t)VRSN_SZ * i; VarReason r{ld32(q), ld16(q + 4), ld32(q + 8)};
    if (ld16(q + 6) || ld32(q + 12)) return bad("entry " + std::to_string(i) + ": pad not 0");
    if (r.var >= d.vars.size()) return bad("entry " + std::to_string(i) + ": var " + std::to_string(r.var) + " not defined");
    if (d.vars[r.var].state != VS_ABSENT && d.vars[r.var].state != VS_UNSUPPORTED) return bad("var " + std::to_string(r.var) + ": a reason for a stored var");
    if (r.text != NONE32 && r.text >= d.strs.size()) return bad("var " + std::to_string(r.var) + ": text is not a string index");
    if (!add.empty() && r.var <= add.back().var) return bad("entries not in increasing var order");
    add.push_back(r);
  }
  const size_t old = d.reasons.size();
  d.reasons.insert(d.reasons.end(), add.begin(), add.end());
  std::inplace_merge(d.reasons.begin(), d.reasons.begin() + (ptrdiff_t)old, d.reasons.end(), [](const VarReason &a, const VarReason &b) { return a.var < b.var; });
  for (size_t i = 1; i < d.reasons.size(); i++) if (d.reasons[i].var == d.reasons[i - 1].var) return bad("var " + std::to_string(d.reasons[i].var) + " has two reasons");
}
}  // namespace segdetail

// Parses a META / META_APPEND body into d (appending). first = META (STRS, SCOP, VARS, SIGD required).
static inline bool parseMetaBody(const uint8_t *b, uint64_t len, bool first, Dict &d, std::string &err) {
  using namespace segdetail;
  if (len < 8) return fail(err, "meta body too short");
  uint32_t ns = ld32(b); if (ld32(b + 4)) return fail(err, "meta pad not 0");
  if (8 + (uint64_t)SECT * ns > len) return fail(err, "bad meta section count");
  static const uint32_t order[6] = {TAG_STRS, TAG_SCOP, TAG_VARS, TAG_SIGD, TAG_ENUM, TAG_EMEM};
  struct Sec { uint32_t tag, count; uint64_t off, len; } sec[6]; int idx[6] = {-1, -1, -1, -1, -1, -1};
  uint64_t pos = align8(8 + (uint64_t)SECT * ns); int last = -1; bool anc = false; std::vector<uint32_t> ancTags; Sec vrsn{0, 0, 0, NONE64};
  if (!zeros(b + 8 + (uint64_t)SECT * ns, pos - (8 + (uint64_t)SECT * ns))) return fail(err, "meta padding not 0");
  for (uint32_t i = 0; i < ns; i++) {
    const uint8_t *q = b + 8 + (uint64_t)SECT * i; Sec s{ld32(q), ld32(q + 4), ld64(q + 8), ld64(q + 16)};
    int o = -1; for (int k = 0; k < 6; k++) if (order[k] == s.tag) o = k;
    const uint8_t lo = (uint8_t)s.tag;
    // an ancillary tag (low byte a-z, SPEC §II.4.1) is skipped; ancillary sections follow every known one
    if (o >= 0) { if (anc || o <= last) return fail(err, "meta sections unknown, repeated or out of order"); }
    else if (lo >= 0x61 && lo <= 0x7A) { anc = true; ancTags.push_back(s.tag); if (s.tag == TAG_VRSN) vrsn = s; }
    else return fail(err, "meta section tag unknown (not a defined or ancillary tag)");
    if (s.off != pos || s.len > len - pos) return fail(err, "meta section not where the previous one ends");
    uint64_t e = pos + s.len, a = align8(e); if (a > len) return fail(err, "meta section padding past the body");
    if (!zeros(b + e, a - e)) return fail(err, "meta padding not 0");
    pos = a; if (o >= 0) { sec[o] = s; idx[o] = o; last = o; }
  }
  std::sort(ancTags.begin(), ancTags.end());
  if (std::adjacent_find(ancTags.begin(), ancTags.end()) != ancTags.end()) return fail(err, "meta ancillary tag repeated");
  if (pos != len) return fail(err, "meta body has bytes after its last section");
  if (first && (idx[0] < 0 || idx[1] < 0 || idx[2] < 0 || idx[3] < 0)) return fail(err, "META lacks STRS, SCOP, VARS or SIGD");
  Dict n;  // the additions, checked against d + n
  size_t s0 = d.strs.size(), c0 = d.scopes.size(), v0 = d.vars.size(), g0 = d.sigs.size(), e0 = d.enums.size(), m0 = d.mems.size();
  auto S = [&](int k) -> const Sec * { return idx[k] >= 0 ? &sec[idx[k]] : nullptr; };
  if (auto s = S(0)) {
    const uint8_t *p = b + s->off; uint64_t c = s->count;
    if (c > MAX_ITEMS - s0 || 4 * (c + 1) > s->len) return fail(err, "bad string count");
    uint64_t L = ld32(p + 4 * c); if (ld32(p) != 0 || 4 * (c + 1) + L != s->len) return fail(err, "bad string table size");
    const uint8_t *bytes = p + 4 * (c + 1); n.strs.reserve(c);
    for (uint64_t i = 0; i < c; i++) {
      uint32_t a = ld32(p + 4 * i), z = ld32(p + 4 * (i + 1));
      if (z < a || z > L || z - a > MAX_STRING_LEN || !utf8ok(bytes + a, z - a)) return fail(err, "bad string");
      n.strs.emplace_back((const char *)bytes + a, z - a);
    }
  }
  uint64_t nStr = s0 + n.strs.size();
  if (auto s = S(1)) {
    if (s->count > MAX_ITEMS - c0 || (uint64_t)s->count * SCOPE_SZ != s->len) return fail(err, "bad scope table size");
    n.scopes.reserve(s->count);
    for (uint32_t i = 0; i < s->count; i++) {
      const uint8_t *q = b + s->off + (uint64_t)SCOPE_SZ * i; ScopeE x{ld32(q), ld32(q + 4), q[8]};
      if (x.name >= nStr || (x.parent != NONE32 && x.parent >= c0 + i) || x.kind > 13 || !zeros(q + 9, 7)) return fail(err, "bad scope");
      n.scopes.push_back(x);
    }
  }
  if (auto s = S(3)) {
    if (s->count > MAX_ITEMS - g0 || (uint64_t)s->count * SIGD_SZ != s->len) return fail(err, "bad signal table size");
    n.sigs.reserve(s->count);
    for (uint32_t i = 0; i < s->count; i++) {
      const uint8_t *q = b + s->off + (uint64_t)SIGD_SZ * i; SigDecl x;
      x.spec.bits = ld32(q); x.spec.vlen = ld32(q + 4); x.spec.fourState = q[8] != 0; x.spec.vtype = q[9]; x.blockRows = ld32(q + 12); x.spec.keyRows = ld32(q + 16);
      if (q[8] > 1 || ld16(q + 10) || ld32(q + 20) || ld64(q + 24)) return fail(err, "bad signal declaration flags or padding");
      if (!x.spec.valid(err)) return fail(err, "signal " + std::to_string(g0 + i) + ": " + err);
      if (x.blockRows < 1 || x.blockRows > MAX_BLOCK_ROWS_TARGET) return fail(err, "bad block_rows");
      n.sigs.push_back(x);
    }
  }
  if (auto s = S(5)) {
    if (s->count > MAX_ITEMS - m0 || (uint64_t)s->count * EMEM_SZ != s->len) return fail(err, "bad enum member table size");
    for (uint32_t i = 0; i < s->count; i++) { const uint8_t *q = b + s->off + (uint64_t)EMEM_SZ * i; EnumMem x{ld32(q), ld64(q + 8)}; if (x.name >= nStr || ld32(q + 4)) return fail(err, "bad enum member"); n.mems.push_back(x); }
  }
  if (auto s = S(4)) {
    if (s->count > MAX_ITEMS - e0 || (uint64_t)s->count * ENUM_SZ != s->len) return fail(err, "bad enum table size");
    for (uint32_t i = 0; i < s->count; i++) {
      const uint8_t *q = b + s->off + (uint64_t)ENUM_SZ * i; EnumE x{ld32(q), ld32(q + 4), ld32(q + 8), ld32(q + 12)};
      if (x.name >= nStr || x.bits < 1 || x.bits > 64 || x.count < 1 || x.first < m0 || x.first - m0 > n.mems.size() || x.count > n.mems.size() - (x.first - m0)) return fail(err, "bad enum");
      for (uint32_t k = 0; k < x.count; k++) if (x.bits < 64 && (n.mems[x.first - m0 + k].value >> x.bits)) return fail(err, "enum member value wider than the enum");
      n.enums.push_back(x);
    }
  } else if (!n.mems.empty()) return fail(err, "enum members without enums");
  uint64_t nSc = c0 + n.scopes.size(), nSig = g0 + n.sigs.size(), nEn = e0 + n.enums.size();
  if (auto s = S(2)) {
    if (s->count > MAX_ITEMS - v0 || (uint64_t)s->count * VAR_SZ != s->len) return fail(err, "bad var table size");
    n.vars.reserve(s->count);
    for (uint32_t i = 0; i < s->count; i++) {
      const uint8_t *q = b + s->off + (uint64_t)VAR_SZ * i;
      VarE x{ld32(q), ld32(q + 4), ld32(q + 8), (int32_t)ld32(q + 12), (int32_t)ld32(q + 16), q[20], q[21], q[22], q[23], q[24], ld32(q + 28)};
      auto at = [&](const char *m) { return "var " + std::to_string(v0 + i) + ": " + m; };  // only on failure
      if (x.name >= nStr || x.scope >= nSc || x.state > 2 || x.kind > 4 || x.dir > 3 || x.type > 8 || (x.flags & ~1u) || !zeros(q + 25, 3)) return fail(err, at("bad fields"));
      if (x.width() > MAX_BITS) return fail(err, at("too wide"));
      if (x.type == 3) { if (x.enm >= nEn) return fail(err, at("bad enum")); const EnumE &en = x.enm < e0 ? d.enums[x.enm] : n.enums[x.enm - e0]; if (en.bits != x.width()) return fail(err, at("enum width mismatch")); }
      else if (x.enm != NONE32) return fail(err, at("enum on a non-enum var"));
      if (x.state == VS_STORED) {
        if (x.signal >= nSig) return fail(err, at("signal out of range"));
        const SigDecl &g = x.signal < g0 ? d.sigs[x.signal] : n.sigs[x.signal - g0];
        uint8_t want = x.type <= 4 ? VT_BITS : x.type == 5 ? VT_REAL : x.type == 6 ? VT_STRING : 0xFF;
        if (want == 0xFF) return fail(err, at("this type cannot be stored in v1"));
        if (g.spec.vtype != want || (want == VT_BITS && g.spec.bits != x.width())) return fail(err, at("type or width differs from its signal"));
      } else if (x.signal != NONE32) return fail(err, at("a var that is not stored names a signal"));
      n.vars.push_back(x);
    }
  }
  if (d.strs.empty() && d.scopes.empty() && d.vars.empty() && d.sigs.empty() && d.enums.empty() && d.mems.empty()) {
    std::vector<VarReason> keep; keep.swap(d.reasons); std::string ke; ke.swap(d.reasonsErr);
    d = std::move(n); d.reasons.swap(keep); d.reasonsErr.swap(ke);  // the first META: no copy
  } else {
    for (auto &x : n.strs) d.strs.push_back(std::move(x));
    d.scopes.insert(d.scopes.end(), n.scopes.begin(), n.scopes.end()); d.vars.insert(d.vars.end(), n.vars.begin(), n.vars.end());
    d.sigs.insert(d.sigs.end(), n.sigs.begin(), n.sigs.end()); d.enums.insert(d.enums.end(), n.enums.begin(), n.enums.end()); d.mems.insert(d.mems.end(), n.mems.begin(), n.mems.end());
  }
  if (vrsn.len != NONE64) segdetail::addReasons(b + vrsn.off, vrsn.count, vrsn.len, d);
  return true;
}

class SegReader {
 public:
  // Opens an image (e.g. an mmap). A complete file opens through its INDEX (with or without SEGNB); anything else is
  // scanned. The image
  // must stay valid while it is used; follow() takes a new image of the same, grown file.
  bool open(const uint8_t *m, size_t n, std::string &err) {
    uint64_t bud = budget_, rt = trailerRetryNs_; const bool strict = strict_, adv = advise_; const uint8_t pf = prefetch_; const int ffd = footFd_; const uint32_t bra = blockRA_; *this = SegReader(); budget_ = bud; trailerRetryNs_ = rt; strict_ = strict; advise_ = adv; prefetch_ = pf; footFd_ = ffd; blockRA_ = bra; m_ = m; n_ = n;
    if (const char *z = zstdTooOld()) return fail(err, z);
    if (!checkHeader(err)) return false;
    std::string terr;
    if (n >= FHDR + TRL && openComplete(terr)) { adviseMapped(); return true; }
    if (!fatal_.empty()) { err = fatal_; return false; }  // a valid INDEX lists a segment this reader doesn't support
    { auto oab = oaBytes_; *this = SegReader(); oaBytes_ = oab; } budget_ = bud; trailerRetryNs_ = rt; strict_ = strict; advise_ = adv; prefetch_ = pf; footFd_ = ffd; blockRA_ = bra; m_ = m; n_ = n; checkHeader(err);  // not complete: start over and scan
    trailerErr_ = terr;
    scan(err);
    if (!fatal_.empty()) { err = fatal_; return false; }
    if (!metaSeen_) { if (err.empty()) err = "no complete META segment"; return false; }
    scannedComplete();
    err.clear(); return true;
  }
  // Re-scans from the end of the last accepted segment on a new image of the same (grown) file. Returns the
  // number of new segments accepted. Only growth is handled: the bytes already accepted must be unchanged; a file
  // rewritten in place (same size or not) needs open() again.
  uint32_t follow(const uint8_t *m, size_t n, std::string &err) {
    if (complete_) return 0;
    if (!fatal_.empty()) { err = fatal_; return 0; }
    if (n < n_ || ld64(m + 40) != hdr_.fileId) { err = "file shrank or changed identity"; return 0; }
    m_ = m; n_ = n; size_t before = segs_.size(); scan(err);
    if (!fatal_.empty()) { err = fatal_; return (uint32_t)(segs_.size() - before); }
    if (!complete_ && n >= nextOff_ + TRL) tryTrailer();
    if (!complete_ && metaSeen_) scannedComplete();
    return (uint32_t)(segs_.size() - before);
  }

  // ---- state
  const FileHeader &header() const { return hdr_; }
  // An ro_compat feature bit this reader doesn't know is set (SPEC §II.11): reads are served as usual, but nothing may
  // write, append to or continue this file from this reader's view of it.
  bool readOnly() const { return (hdr_.roCompat & ~KNOWN_RO_COMPAT) != 0; }
  // What verify() could not check (CONFORMANCE R-RES-4): "" or "partial: unknown ro_compat bits 0x..".
  std::string verifyPartial() const {
    const uint32_t u = hdr_.roCompat & ~KNOWN_RO_COMPAT; if (!u) return "";
    char b[64]; snprintf(b, sizeof b, "partial: unknown ro_compat bits 0x%x", u); return b;
  }
  // "features: incompat 0x.., ro_compat 0x.., compat 0x.." and, when set, the bits this reader doesn't know.
  std::string features() const {
    auto hx = [](uint64_t v) { char b[24]; snprintf(b, sizeof b, "0x%llx", (unsigned long long)v); return std::string(b); };
    std::string o = "features: incompat " + hx(hdr_.incompat) + ", ro_compat " + hx(hdr_.roCompat) + ", compat " + hx(hdr_.compat), u;
    const uint64_t ui = hdr_.incompat & ~KNOWN_INCOMPAT, ur = hdr_.roCompat & ~KNOWN_RO_COMPAT, uc = hdr_.compat & ~KNOWN_COMPAT;
    if (ui) u += "unknown incompat " + hx(ui);
    if (ur) u += (u.empty() ? "" : ", ") + std::string("unknown ro_compat ") + hx(ur);
    if (uc) u += (u.empty() ? "" : ", ") + std::string("unknown compat ") + hx(uc);
    if (!u.empty()) o += " (" + u + (ur ? "; read-only" : "") + ")";
    return o;
  }
  const Dict &dict() const { return dict_; }
  // Absent-var reasons (SPEC §II.4.7). reasonsError(): empty when the file's reasons are usable (or it has none), else
  // why every reason was dropped. varReason(): false when var has no (usable) reason.
  std::string reasonsError() const {
    if (!dict_.reasonsErr.empty()) return dict_.reasonsErr;
    if (!dict_.reasons.empty() && !(hdr_.compat & COMPAT_VRSN)) return "vrsn: reasons present but compat_features bit 1 is clear";
    return "";
  }
  bool varReason(uint32_t var, uint16_t &code, uint32_t &text) const {
    if (dict_.reasons.empty() || !reasonsError().empty()) return false;
    auto it = std::lower_bound(dict_.reasons.begin(), dict_.reasons.end(), var, [](const VarReason &r, uint32_t v) { return r.var < v; });
    if (it == dict_.reasons.end() || it->var != var) return false;
    code = it->code; text = it->text; return true;
  }
  bool complete() const { return complete_; }
  // Display horizon (SPEC §II.6.3): t_end when complete (also a complete file scanned to its INDEX), else the last
  // claim; NONE64 = nothing displayable.
  uint64_t horizon() const { return complete_ ? tEnd_ : scannedTEnd_ != NONE64 ? scannedTEnd_ : lastClaim_; }
  uint64_t scannedEnd() const { return nextOff_; }
  // (SPEC §II.8.6) a complete file: every signal's last change, as its INDEX summary gives it, is at or before the
  // Trailer's t_end. O(signals) over the INDEX in memory, nothing per block; for opens that must not serve a file
  // whose t_end is before its data. false + err names the first signal past it.
  bool tEndCoversIndex(std::string &err) const {
    if (!complete_ || !gx_) return true;
    for (uint32_t i = 0, N = nSignals(); i < N; i++) { const SigSum g = sigX(i); if (g.n && g.tLast > tEnd_) { err = "signal " + std::to_string(i) + ": block ends after t_end"; return false; } }
    return true;
  }
  const std::string &stopReason() const { return stop_; }
  // Why fast open (Trailer + INDEX) was not used: "" for a complete file, "no trailer", or the first check that
  // failed (CONFORMANCE §4). The file was then scanned.
  const std::string &fastOpenError() const { return trailerErr_; }
  // follow(): how long a Trailer attempt that failed a checksum is not repeated at the same size and bytes
  // (default 1 s), and how many attempts were made.
  void setTrailerRetry(uint64_t ns) { trailerRetryNs_ = ns; }
  uint64_t trailerAttempts() const { return trailerAttempts_; }
  // Set when a complete, checksum-valid segment has a type or flags this reader doesn't support (SPEC §II.3): open()
  // and follow() then fail with it. Unlike a torn or corrupt segment, this does not end the file there.
  const std::string &unsupported() const { return fatal_; }
  const std::vector<SegInfo> &segments() const { return segs_; }
  uint32_t nSignals() const { return (uint32_t)dict_.sigs.size(); }
  // Signals and blocks. A complete file is read in place from its INDEX (nothing per block is copied);
  // each signal's index entries are checked the first time the signal is used (checkSignal); a DATA footer is checked
  // whole the first time a read could be served without a block in it between two of the signal's blocks, or before
  // its first (gapChecked); in strict mode (setStrict) also past its last. A signal that fails has nblk() = 0 and an
  // empty sum(), and decodeBlock / valueAt / verify fail with the reason; a footer check that finds a block of it the
  // INDEX doesn't name fails it from then on. SEGNB's counts must agree with the BlkX entries at open and with each
  // DATA footer when that footer is checked. nblk(), block() and sum() are the INDEX's: by default a block the INDEX
  // leaves out past a signal's last INDEX block is not looked for (SPEC §II.8); strict mode and verify() look.
  SigSum sum(uint32_t i) const { if (!complete_) return sums_[i]; std::string e; return checkSignal(i, e) ? sigX(i) : SigSum(); }
  uint32_t dataOf(uint32_t i) const { if (complete_) { const uint8_t *q = gx_ + (uint64_t)SIGX * i; return q[52] == 1 ? ld32(q + 56) : i; } return sums_[i].codec == 1 ? sums_[i].ref : i; }
  // nblk(i) is 0 after a failed signal check (checkSignal); on b >= nblk(i), call checkSignal(i, err) for the real error.
  uint32_t nblk(uint32_t i) const { uint32_t d = dataOf(i); if (!complete_) return (uint32_t)sblk_[d].size(); std::string e; return checkSignal(i, e) ? ld32(gx_ + (uint64_t)SIGX * d + 48) : 0; }
  BlockRef block(uint32_t i, uint32_t b) const { uint32_t d = dataOf(i); return complete_ ? blkX(ld64(gx_ + (uint64_t)SIGX * d + 40) + b) : blocks_[sblk_[d][b]]; }
  uint64_t nBlocks() const { return complete_ ? nbl_ : blocks_.size(); }
  // Every block, in INDEX (complete) or file (scanned) order. O(blocks) of heap: for tools, not viewers.
  std::vector<BlockRef> allBlocks() const { if (!complete_) return blocks_; std::vector<BlockRef> v; v.reserve(nbl_); for (uint64_t k = 0; k < nbl_; k++) v.push_back(blkX(k)); return v; }
  const std::vector<DoffE> &dumpOff() const { return doff_; }
  // The INDEX rules for signal i's blocks (SPEC §II.8: in its DATA segment, valid entries, in order, after earlier
  // claims, summary equal to its blocks), checked once; REF signals check their target.
  bool checkSignal(uint32_t i, std::string &err) const {
    if (!complete_) {  // scanned: built from checked footers, except a complete file's signals with no blocks found
      if (i < scanBad_.n && scanBad_.get(i)) return segdetail::fail(err, "signal " + std::to_string(i) + (stoppedEarly_ ? ": the scan of this complete file stopped before the INDEX (" + stop_ + ") and found no blocks of it" : ": the scan found no blocks of it, and the INDEX that would say why was not used (" + trailerErr_ + ")"));
      return true;
    }
    if (i >= nSignals()) return segdetail::fail(err, "no such signal");
    uint32_t d = dataOf(i);
    auto omitted = [&] { return segdetail::fail(err, "signal " + std::to_string(d) + ": a DATA footer holds a block of it the INDEX leaves out"); };
    if (footBad_.get(d)) return omitted();  // found later by another footer check: the signal fails from then on
    if (sigOk_.get(d)) return true;
    if (!checkBlocks(d, err)) return false;
    sigOk_.set(d); return true;
  }
  // Before a read of signal i served from its block lo - 1 (lo: its blocks with t0 <= t; 0: none) or of block lo:
  // - complete files: every DATA footer that could hold a block of it between blocks lo - 1 and lo in file order
  //   (from block lo - 1's segment, or the first, to block lo's) is checked once, so a block the INDEX leaves out
  //   there fails the signal (footBad_) instead of the read coming back short; once per BlkX entry (gapOk_). Past the
  //   last block (lo = nb: block lo - 1's segment, or the first, to the last) only in strict mode, once per signal;
  // - a complete file scanned to a stop before its INDEX: a read past the signal's last scanned block fails.
  bool gapChecked(uint32_t i, uint32_t lo, uint32_t nb, std::string &err) const {
    const uint32_t d = dataOf(i);
    if (!complete_) {
      if (stoppedEarly_ && lo >= nb) return segdetail::fail(err, "signal " + std::to_string(i) + ": the scan of this complete file stopped before the INDEX (" + stop_ + "); this read needs blocks past that point");
      return true;
    }
    const uint64_t first = ld64(gx_ + (uint64_t)SIGX * d + 40); const uint8_t *bx = bx_ + (uint64_t)BLKX * first;
    if (lo >= nb ? !strict_ || tailOk_.get(d) : gapOk_.get(first + lo)) return true;
    const uint32_t s0 = lo ? ld32(bx + (uint64_t)BLKX * (lo - 1) + 56) : 0, s1 = lo < nb ? ld32(bx + (uint64_t)BLKX * lo + 56) : (uint32_t)segs_.size() - 1;
    for (uint32_t k = s0; k <= s1 && k < segs_.size(); k++) {
      if (segs_[k].type != SEG_DATA || sigsAt_[k] <= d || footOk_.get(k)) continue;
      if (!footerPacked(k, err, false)) return false;
      footOk_.set(k);
    }
    if (footBad_.get(d)) return segdetail::fail(err, "signal " + std::to_string(d) + ": a DATA footer holds a block of it the INDEX leaves out");
    if (lo >= nb) tailOk_.set(d); else gapOk_.set(first + lo);
    return true;
  }
  // The most bytes one decodeBlock / valueAt call may hold (payload scratch, seek table, decoded rows); a decode that
  // would hold more fails with "decode budget exceeded" before allocating. NO_BUDGET (the default) leaves the §II.10
  // limits. Kept across open().
  void setDecodeBudget(uint64_t bytes) { budget_ = bytes; }
  uint64_t decodeBudget() const { return budget_; }
  // Strict mode (off by default; kept across open()): reads also check the DATA footers past a signal's last INDEX
  // block, once per signal, so a block the INDEX leaves out there fails the signal instead of going unread (SPEC
  // §II.8). The first such read of a static signal then reads every later footer. verify() checks them in either mode.
  void setStrict(bool on) { strict_ = on; }
  bool strict() const { return strict_; }
  // Page-cache advice on the image (on by default; kept across open()). Open advises WILLNEED on the INDEX frame
  // and the META segments before it checks them, so a cold open reads them ahead instead of one fault at a time.
  // After a complete open, each DATA segment's
  // footer range is advised WILLNEED (madvise: read ahead in the background, up to 64 MiB of footers in all), so the
  // lazy footer checks of the first reads find it resident. Cost: those footer bytes are read whether or not the reads
  // need them. The block ranges are advised random (no readahead), so a cold point read faults in its block's pages,
  // not a readahead window; verify() advises them sequential while it runs. Only advice: it changes no result, and does nothing where madvise doesn't exist. For an
  // image that isn't a file mapping it is harmless; turn it off to leave the caller's mapping untouched.
  void setMapAdvice(bool on) { advise_ = on; }
  bool mapAdvice() const { return advise_; }
  // The footer part of that advice alone (on by default; kept across open(); nothing while setMapAdvice is off).
  // Off: open reads no footer, and each is read when a request first needs it; the block advice stays. On suits
  // sessions of many requests; off suits a process that makes one or a few requests on a large file.
  // Modes: FOOTER_PREFETCH_SYNC (the default, = setFooterPrefetch(true)): open() issues the footer advice before it
  // returns. FOOTER_PREFETCH_OFF (= setFooterPrefetch(false)): none. FOOTER_PREFETCH_DEFER: open() issues none, and the
  // caller issues the same advice later with prefetchFooters(), for example from its own thread once it has answered
  // the open. The reader starts no thread.
  enum FooterPrefetchMode : uint8_t { FOOTER_PREFETCH_OFF = 0, FOOTER_PREFETCH_SYNC = 1, FOOTER_PREFETCH_DEFER = 2 };
  void setFooterPrefetch(bool on) { prefetch_ = on ? FOOTER_PREFETCH_SYNC : FOOTER_PREFETCH_OFF; }
  void setFooterPrefetchMode(FooterPrefetchMode m) { prefetch_ = m <= FOOTER_PREFETCH_DEFER ? (uint8_t)m : (uint8_t)FOOTER_PREFETCH_SYNC; }
  bool footerPrefetch() const { return prefetch_ == FOOTER_PREFETCH_SYNC; }
  FooterPrefetchMode footerPrefetchMode() const { return (FooterPrefetchMode)prefetch_; }
  // The footer advice that open() issues in SYNC mode (WILLNEED on each DATA footer, in file order, up to
  // ADVISE_FOOTER_CAP bytes), issued now; returns the number of ranges advised (0 when the file is not complete or
  // setMapAdvice is off). Any mode. It reads only what open() fixed (the segment list, the INDEX, the image), so it may
  // run on another thread while that thread or others read; it must return before the reader is reopened, closed or
  // destroyed, or the image unmapped.
  uint32_t prefetchFooters() const { return adviseFooters(); }
  // Footer reads by pread (off by default; kept across open()). fd is an open descriptor of the file the image maps,
  // at offset 0. With it, a DATA footer check, and the footer entry a read checks, copy that footer and its SegHdr with
  // pread instead of reading them through the image. A session's first reads then don't map the cached pages around
  // each footer into the process. Same bytes, same results, same errors. A pread that fails or comes back short falls
  // back to the image. verify() and the scan still read through the image. -1 turns it off. The reader doesn't own or
  // close fd, and fd must stay open while the reader is used. Safe with concurrent reads (thread-local buffers).
  void setFooterFd(int fd) { footFd_ = fd < 0 ? -1 : fd; }
  int footerFd() const { return footFd_; }
  // Whether DATA segment k's footer has been checked whole (complete files; diagnostics and tests).
  bool footerChecked(uint32_t k) const { return complete_ && k < segs_.size() && footOk_.get(k); }
  // Block read-ahead (kept across open(); nothing while setMapAdvice is off, or for a file opened by scanning, which
  // gets no block advice). Under the random block advice a cold read faults in a block of many pages one page at a
  // time. With minPages > 0, a request first advises WILLNEED on the bytes it decodes when they span at least
  // minPages pages (the system's page size): the whole block for decodeBlock, the chunk's frame for decodeChunk and
  // valueAt (the whole block when it has no keyframes), in 128 KiB calls. Smaller reads are left to fault in. 0 = off. Only advice: it
  // changes no result. blockReadAheads() counts the advice calls made (all copies of this reader together).
  static const uint32_t BLOCK_READ_AHEAD = 2;
  static constexpr uintptr_t READ_AHEAD_STEP = 128 << 10;  // bytes per WILLNEED call (a multiple of the page size)
  void setBlockReadAhead(uint32_t minPages) { blockRA_ = minPages; }
  uint32_t blockReadAhead() const { return blockRA_; }
  uint64_t blockReadAheads() const { return raCount_->load(std::memory_order_relaxed); }
  // bytes the last open() advised WILLNEED ahead of its checks (the INDEX frame and META ranges, page-rounded; 0 with
  // setMapAdvice(false)), kept when a failed fast open falls back to the scan
  uint64_t openAheadBytes() const { return oaBytes_->load(std::memory_order_relaxed); }

  // The checks decodeBlock / decodeChunk run before decoding block b of signal i: the signal (checkSignal), the
  // block range, its BlkX against its footer entry, and the DATA footers in the gap before it (and past it for its
  // last block, in strict mode). A caller that decodes block(i, b) through BlockDecoder itself calls this first.
  bool checkBlock(uint32_t i, uint32_t b, std::string &err) const {
    if (i >= nSignals()) { err = "no such block"; return false; }
    if (!checkSignal(i, err)) return false;
    const uint32_t nb = nblk(i); if (b >= nb) { if (!checkSignal(i, err)) return false; err = "no such block"; return false; }  // 0 blocks: the signal may have failed since
    if (!bound(dataOf(i), block(i, b), err)) return false;  // its own entry first: a BlkX naming another signal's entry says so
    return gapChecked(i, b, nb, err) && (b + 1 != nb || gapChecked(i, nb, nb, err));
  }
  bool decodeBlock(ZSTD_DCtx *zd, uint32_t i, uint32_t b, Rows &out, std::vector<uint8_t> &tmp, std::string &err) const {
    if (!checkBlock(i, b, err)) return false;
    const BlockRef r = block(i, b); readAhead(r.off, r.info.len);
    return BlockDecoder::decodeBlock(zd, dict_.sigs[dataOf(i)].spec, r.info, m_ + r.off, out, tmp, true, err, budget_);
  }
  // The container's block-info check (checkInfo).
  bool infoOk(const SigSpec &s, const BlockInfo &e, std::string &err) const { return BlockDecoder::checkInfo(s, e, err); }
  // Chunk c of block b (c < the block's nchunk; 0 for a block without keyframes): its rows, decoded alone.
  bool decodeChunk(ZSTD_DCtx *zd, uint32_t i, uint32_t b, uint32_t c, Rows &out, std::vector<uint8_t> &tmp, std::string &err) const {
    out.clear(); if (!checkBlock(i, b, err)) return false;
    const BlockRef r = block(i, b); const SigSpec &s = dict_.sigs[dataOf(i)].spec; std::vector<SeekEnt> st;
    if (!infoOk(s, r.info, err) || !BlockDecoder::seekTable(s, r.info, m_ + r.off, st, true, err)) return false;
    if (c >= st.size()) { err = "no such chunk"; return false; }
    readAheadChunk(r, st, c);
    uint64_t vmax; if (!BlockDecoder::charge(s, BlockDecoder::chunkRows(s, r.info, c), st[c].rsize, st.capacity(), budget_, out, vmax, err)) return false;
    return BlockDecoder::decodeChunk(zd, s, r.info, m_ + r.off, st, c, out, tmp, true, err, vmax);
  }
  // Value in effect at t (the last change <= t): out gets the rows of the chunk holding it up to t (pointChunk), not
  // the whole chunk; row is the last of them (-1: no change at or before t).
  bool valueAt(ZSTD_DCtx *zd, uint32_t i, uint64_t t, Rows &out, int64_t &row, std::vector<uint8_t> &tmp, std::string &err) const {
    row = -1; out.clear(); if (i >= nSignals()) { err = "no such signal"; return false; }
    if (!checkSignal(i, err)) return false;
    uint32_t nb = nblk(i); if (!nb) return gapChecked(i, 0, 0, err);
    const uint32_t d = dataOf(i); const uint8_t *bx = complete_ ? bx_ + (uint64_t)BLKX * ld64(gx_ + (uint64_t)SIGX * d + 40) : nullptr;
    auto t0At = [&](uint32_t b) { return bx ? ld64(bx + (uint64_t)BLKX * b + 16) : blocks_[sblk_[d][b]].info.t0; };
    uint32_t lo = 0, hi = nb; while (lo < hi) { uint32_t md = lo + (hi - lo) / 2; if (t0At(md) <= t) lo = md + 1; else hi = md; }
    if (!lo) return gapChecked(i, 0, nb, err);  // before the first block: the footers from the first segment to its block's
    const BlockRef r = block(i, lo - 1); const SigSpec &s = dict_.sigs[dataOf(i)].spec; std::vector<SeekEnt> st;
    if (!bound(dataOf(i), r, err)) return false;
    // CONFORMANCE R-SIG-4 binds a read at a time in a gap: past block lo - 1's t_last (its entry checked against its
    // footer by bound), the footers up to block lo are checked; a read inside the block checks none past it. Past the
    // last block: as gapChecked says (strict mode).
    if ((lo == nb || t > r.info.tLast) && !gapChecked(i, lo, nb, err)) return false;
    if (!infoOk(s, r.info, err) || !BlockDecoder::seekTable(s, r.info, m_ + r.off, st, true, err)) return false;
    uint32_t c = BlockDecoder::chunkFor(st, t); uint64_t vmax; readAheadChunk(r, st, c);
    if (!BlockDecoder::charge(s, BlockDecoder::chunkRows(s, r.info, c), st[c].rsize, st.capacity(), budget_, out, vmax, err)) return false;
    if (!BlockDecoder::pointChunk(zd, s, r.info, m_ + r.off, st, c, t, out, tmp, err, vmax)) return false;
    row = (int64_t)out.n() - 1;  // the chunk's rows up to t
    return true;
  }

  // ---- LOD (SPEC §II.7), complete files only (a scanned file has no LOD, CONFORMANCE §4). Signal i's levels (REF: its
  // target's; nlev = 0 when it has no LodSig), one chunk's frame in place, and a chunk decoded. The LOD segment is
  // checked whole on first use: its seg_xxh64, every LodSig named by its signal's SigX.lod, levels and chunks
  // consecutive, chunk sizes, frames back to back up to the footer. A decode checks the chunk's xxh64 and payload.
  bool lodInfo(uint32_t i, LodInfo &out, std::string &err) const {
    out = LodInfo(); if (i >= nSignals()) return segdetail::fail(err, "no such signal");
    LodAt a; if (!lodAt(i, a, err)) return false;
    if (!a.sig) return true;
    out.lodBase = ld64(a.sig + 16); out.nlev = ld32(a.sig + 4);
    for (uint32_t l = 0; l < out.nlev; l++) { const uint8_t *e = a.lev + (uint64_t)LODLEV * l; out.levels.push_back(LodLevel{ld32(e + 4), ld64(e + 8)}); }
    return true;
  }
  bool lodChunk(uint32_t i, uint32_t level, uint32_t c, LodChunk &out, std::string &err) const {
    out = LodChunk(); if (i >= nSignals()) return segdetail::fail(err, "no such signal");
    LodAt a; if (!lodAt(i, a, err)) return false;
    if (!a.sig) return segdetail::fail(err, "signal " + std::to_string(i) + " has no LOD");
    if (level >= ld32(a.sig + 4)) return segdetail::fail(err, "no such LOD level");
    const uint8_t *e = a.lev + (uint64_t)LODLEV * level; if (c >= ld32(e + 4)) return segdetail::fail(err, "no such LOD chunk");
    const uint8_t *p = a.ent + (uint64_t)LODENT * (ld32(e) + (uint64_t)c);
    out.b0 = ld64(p); out.frame = a.body + ld64(p + 8); out.csize = ld32(p + 16); out.n = ld32(p + 20); out.rsize = ld32(p + 24); out.xxh = ld64(p + 32);
    return true;
  }
  bool decodeLod(ZSTD_DCtx *zd, uint32_t i, uint32_t level, uint32_t c, std::vector<LodBucket> &out, std::vector<uint8_t> &tmp, std::string &err) const {
    out.clear(); if (const char *z = zstdTooOld()) return segdetail::fail(err, z);
    LodChunk k; if (!lodChunk(i, level, c, k, err)) return false;
    if (xxh64(k.frame, k.csize) != k.xxh) return segdetail::fail(err, "LOD chunk checksum mismatch");
    tmp.resize(k.rsize); size_t got = ZSTD_decompressDCtx(zd, tmp.data(), k.rsize, k.frame, k.csize);
    if (ZSTD_isError(got) || got != k.rsize) return segdetail::fail(err, "LOD chunk doesn't decompress to its rsize");
    if (!lodPayload(tmp.data(), k.rsize, k.b0, k.n, out, err)) return false;
    const SigSpec &sp = dict_.sigs[dataOf(i)].spec; const bool xzOk = sp.vtype == VT_BITS && sp.fourState, valOk = sp.vtype == VT_BITS && sp.bits == 1;
    for (const LodBucket &b : out) if (((b.flags & 1) && !xzOk) || ((b.flags & 2) && !valOk)) { out.clear(); return segdetail::fail(err, "LOD flag not allowed for this signal's type"); }
    LodChunk nx; std::string e2;
    if (lodChunk(i, level, c + 1, nx, e2) && out.back().bucket >= nx.b0) { out.clear(); return segdetail::fail(err, "LOD chunk runs into the next chunk's buckets"); }
    LodAt a; lodAt(i, a, e2); const uint64_t w = ld64(a.sig + 16) << (2 * level); const SigSum g = sigAt(lodGx_, dataOf(i));
    if (out.front().bucket < g.t0 / w || out.back().bucket > g.tLast / w) { out.clear(); return segdetail::fail(err, "LOD bucket outside the signal's changes"); }
    return true;
  }
  // An LOD payload: n entries of a varint bucket delta (0 first, then > 0) and a flag byte (bits 0-1 min(changes, 2)
  // = 1 or 2, bit 2 any x/z, bit 3 the value after, bits 4-7 zero), nothing after.
  static bool lodPayload(const uint8_t *buf, size_t len, uint64_t b0, uint32_t n, std::vector<LodBucket> &out, std::string &err) {
    out.clear(); if (!n || n > MAX_LOD_ENTRIES) return segdetail::fail(err, "bad LOD entry count");
    out.resize(n); const uint8_t *p = buf, *end = buf + len; uint64_t b = b0;
    for (uint32_t k = 0; k < n; k++) {
      uint64_t dl; if (!getVar(p, end, dl)) { out.clear(); return segdetail::fail(err, "bad or truncated LOD bucket varint"); }
      if (k == 0 ? dl != 0 : dl == 0) { out.clear(); return segdetail::fail(err, "LOD buckets not strictly increasing"); }
      if (dl > ~0ull - b) { out.clear(); return segdetail::fail(err, "LOD bucket overflow"); }
      b += dl; if (p >= end) { out.clear(); return segdetail::fail(err, "truncated LOD flags"); }
      uint8_t f = *p++; if ((f >> 4) || (f & 3) == 0 || (f & 3) == 3) { out.clear(); return segdetail::fail(err, "bad LOD flag byte"); }
      out[k] = LodBucket{b, (uint8_t)(f & 3), (uint8_t)(f >> 2)};
    }
    if (p != end) { out.clear(); return segdetail::fail(err, "trailing bytes after LOD payload"); }
    return true;
  }

  // Full verification (wcz-dump verify): every segment's checksum, every footer entry equal to the index, every
  // block decoded with its stream hash and nNorm recomputed.
  bool verify(ZSTD_DCtx *zd, std::string &err, uint64_t *changes = nullptr) const {
    VerifyAdvice va(*this);
    if (!complete_ && scannedComplete_) return segdetail::fail(err, "a complete file (valid Trailer) whose INDEX was not used: " + trailerErr_);
    if (!complete_ && ruleStop_) return segdetail::fail(err, "the scan stopped at segment " + std::to_string(segs_.size()) + ", a complete segment that breaks a layout rule: " + stop_);
    for (const SegInfo &s : segs_) {
      const uint8_t *h = m_ + s.off, *e = h + SEGH + s.bodyLen;
      if (ld32(h) != SEG_MAGIC || ld16(h + 4) != s.type || ld32(h + 8) != s.seq || ld64(h + 16) != s.bodyLen || ld64(h + 24) != hdr_.fileId || ld16(h + 6) != SEGH || ld32(h + 12) != s.flags ||
          ld32(e) != END_MAGIC || ld32(e + 4) != s.seq || ld64(e + 8) != s.off || ld64(e + 16) != s.tCut || ld64(e + 24) != s.xxh) return segdetail::fail(err, "segment " + std::to_string(s.seq) + " framing differs from the INDEX");
      if (xxh64(h, SEGH + s.bodyLen + 24) != s.xxh) return segdetail::fail(err, "segment " + std::to_string(s.seq) + " checksum mismatch");
    }
    if (std::string re = reasonsError(); !re.empty()) return segdetail::fail(err, re);  // the open used none of them
    for (uint32_t i = 0; i < nSignals(); i++) if (!checkSignal(i, err)) return false;
    if (complete_) {  // every footer entry is named by exactly one BlkX: each is found, and the counts are equal
      uint64_t fb = 0;
      for (uint32_t k = 0; k < segs_.size(); k++) if (segs_[k].type == SEG_DATA) {
        if (!footerPacked(k, err, true)) return false;
        const uint8_t *body = m_ + segs_[k].off + SEGH; fb += ld32(body + segs_[k].bodyLen - ld64(body + segs_[k].bodyLen - 8));
      }
      for (uint32_t i = 0; i < nSignals(); i++) if (footBad_.get(i)) return segdetail::fail(err, "signal " + std::to_string(i) + ": a DATA footer holds a block of it the INDEX leaves out");
      if (fb != nbl_) return segdetail::fail(err, "the DATA footers hold " + std::to_string(fb) + " blocks, the INDEX " + std::to_string(nbl_));
      size_t di = 0;  // the footers' DoffEnts, in file order, are DoffX entry for entry (t, kind, pad 0)
      for (const SegInfo &s : segs_) if (s.type == SEG_DATA) {
        const uint8_t *body = m_ + s.off + SEGH; const uint64_t fs = s.bodyLen - ld64(body + s.bodyLen - 8); const uint32_t nb = ld32(body + fs), nd = ld32(body + fs + 4);
        for (uint32_t k = 0; k < nd; k++, di++) { const uint8_t *q = body + fs + 8 + (uint64_t)BENT * nb + (uint64_t)DENT * k;
          if (di >= doff_.size() || ld64(q) != doff_[di].t || ld32(q + 8) != doff_[di].kind || ld32(q + 12)) return segdetail::fail(err, "segment " + std::to_string(s.seq) + ": dump-off entries differ from the INDEX DoffX"); }
      }
      if (di != doff_.size()) return segdetail::fail(err, "dump-off entries differ from the INDEX DoffX: the footers hold " + std::to_string(di) + ", the INDEX " + std::to_string(doff_.size()));
    }
    for (uint32_t i = 0; i < nSignals(); i++) for (uint32_t b = 0, nb = dataOf(i) == i ? nblk(i) : 0; b < nb; b++) {
      const BlockRef r = block(i, b);
      const SegInfo &s = segs_[r.seg]; const uint8_t *body = m_ + s.off + SEGH;
      if (s.bodyLen < 16) return segdetail::fail(err, "DATA body too short for a footer");
      uint64_t fl = ld64(body + s.bodyLen - 8);
      if (fl < 16 || fl > s.bodyLen) return segdetail::fail(err, "bad DATA footer length");
      uint64_t fs = s.bodyLen - fl;
      if (r.entry >= ld32(body + fs) || 16 + (uint64_t)BENT * (r.entry + 1ull) > fl) return segdetail::fail(err, "index entry not in its segment's footer");
      BlockInfo e; uint32_t sig; uint64_t off, res; segdetail::parseEnt(body + fs + 8 + (uint64_t)BENT * r.entry, e, sig, off, res);
      if (sig != r.sig || s.off + SEGH + off != r.off || e.rows != r.info.rows || e.nNorm != r.info.nNorm || e.nchunk != r.info.nchunk || e.mode != r.info.mode || e.flags != r.info.flags ||
          e.t0 != r.info.t0 || e.tLast != r.info.tLast || e.len != r.info.len || e.rsize != r.info.rsize || e.xxh != r.info.xxh) return segdetail::fail(err, "index entry differs from its footer entry");
    }
    Rows rows; std::vector<uint8_t> tmp; uint64_t total = 0;
    for (uint32_t i = 0; i < nSignals(); i++) {
      const SigSum g = sum(i); if (g.codec == 1) continue;
      const SigSpec &sp = dict_.sigs[i].spec; uint64_t h = HASH_INIT; NormCounter nc; nc.init(sp); uint64_t n = 0;
      LodInfo li; if (!lodInfo(i, li, err)) return segdetail::fail(err, "signal " + std::to_string(i) + ": " + err);
      LodVerify lv(*this, zd, i, li, sp);
      for (uint32_t b = 0; b < nblk(i); b++) for (uint32_t c = 0, nc0 = block(i, b).info.nchunk; c < nc0; c++) {  // chunk by chunk
        if (!decodeChunk(zd, i, b, c, rows, tmp, err)) return segdetail::fail(err, "signal " + std::to_string(i) + " block " + std::to_string(b) + (nc0 > 1 ? " chunk " + std::to_string(c) : std::string()) + ": " + err);
        for (uint32_t k = 0; k < rows.n(); k++) { h = hmix(h, rows.t[k], rows.val(k, sp.vlen), rows.len(k, sp.vlen)); nc.change(b, rows.t[k], rows.val(k, sp.vlen), rows.len(k, sp.vlen)); if (li.nlev && !lv.row(rows.t[k], rows.val(k, sp.vlen), rows.len(k, sp.vlen))) return segdetail::fail(err, "signal " + std::to_string(i) + ": " + lv.err); }
        n += rows.n();
      }
      if (li.nlev && !lv.finish()) return segdetail::fail(err, "signal " + std::to_string(i) + ": " + lv.err);
      nc.finish();
      if (n != g.n) return segdetail::fail(err, "signal " + std::to_string(i) + ": change count mismatch");
      if (nc.total != g.nNorm) return segdetail::fail(err, "signal " + std::to_string(i) + ": nNorm mismatch");
      for (uint32_t b = 0; b < nblk(i); b++) if ((b < nc.perBlock.size() ? nc.perBlock[b] : 0) != block(i, b).info.nNorm) return segdetail::fail(err, "signal " + std::to_string(i) + ": block nNorm mismatch");
      if (g.hashKnown && h != g.hash) return segdetail::fail(err, "signal " + std::to_string(i) + ": stream hash mismatch");
      total += n;
    }
    if (changes) *changes = total;
    return true;
  }

 private:
  const uint8_t *m_ = nullptr; size_t n_ = 0; FileHeader hdr_; Dict dict_;
  std::vector<SegInfo> segs_; std::vector<DoffE> doff_;
  // scanned files: blocks in file order, per-signal summaries and block lists
  std::vector<BlockRef> blocks_; std::vector<SigSum> sums_; std::vector<std::vector<uint32_t>> sblk_;
  // complete files: the INDEX in place (SigX, BlkX), and per segment the claim before it (for the lazy checks)
  const uint8_t *gx_ = nullptr, *bx_ = nullptr, *segNb_ = nullptr; uint64_t nbl_ = 0; std::vector<uint64_t> claimBefore_; std::vector<uint8_t> anyBefore_;
  CheckFlags sigOk_;  // complete files: codec-0 signals whose blocks have been checked
  uint64_t nextOff_ = FHDR, lastClaim_ = NONE64, maxClaim_ = 0, tEnd_ = 0; bool anyClaim_ = false, metaSeen_ = false, lodSeen_ = false, indexSeen_ = false, complete_ = false, segnbSeen_ = false, ruleStop_ = false;
  uint32_t nextSeq_ = 0; std::string stop_, trailerErr_, fatal_; uint64_t indexOff_ = 0, budget_ = NO_BUDGET;
  CheckFlags footOk_;  // complete files: DATA segments whose footer has been checked (by SegX index)
  std::vector<uint32_t> sigsAt_;  // complete files: signals declared before each segment
  CheckFlags scanBad_;  // scanned complete files: signals with no blocks the INDEX can't account for (reads fail)
  bool scannedComplete_ = false;  // the file has a valid Trailer but was opened by scanning
  uint64_t scannedN_ = 0, scannedKey_ = 0; bool stoppedEarly_ = false;  // the image scannedComplete() last looked at (size, Trailer checksum, counts)
  CheckFlags tailOk_;  // complete files: signals whose footers past their last block were checked (gapChecked, strict)
  CheckBits gapOk_;  // complete files: BlkX entries whose gap from the signal's block before was checked (gapChecked)
  bool strict_ = false;  // setStrict
  bool advise_ = true;  // setMapAdvice
  uint8_t prefetch_ = FOOTER_PREFETCH_SYNC;  // setFooterPrefetch / setFooterPrefetchMode
  int footFd_ = -1;  // setFooterFd
  uint32_t blockRA_ = BLOCK_READ_AHEAD;  // setBlockReadAhead
  std::shared_ptr<std::atomic<uint64_t>> raCount_ = std::make_shared<std::atomic<uint64_t>>(0);  // blockReadAheads
  std::shared_ptr<std::atomic<uint64_t>> oaBytes_ = std::make_shared<std::atomic<uint64_t>>(0);  // openAheadBytes
  // scanned complete files read to the INDEX (scannedComplete): the Trailer's t_end (the horizon) and the INDEX's
  // SigX for the LOD (lodGx_; complete files: gx_)
  uint64_t scannedTEnd_ = NONE64; const uint8_t *lodGx_ = nullptr;
  CheckFlags footBad_;  // complete files: signals with a footer block the INDEX leaves out (from the footers checked)
  struct LodSeg { uint32_t seg, first, n; }; std::vector<LodSeg> lodSegs_; CheckFlags lodOk_;  // complete files: LOD segments (first LodSig number, count), checked
  mutable std::vector<uint64_t> lastT_; mutable std::vector<uint32_t> stamp_; mutable uint32_t epoch_ = 0;  // parseData scratch
  // follow()'s last Trailer attempt: image size, a hash of the Trailer + INDEX SegEnd bytes, when, and whether its
  // failure is final for that size (the checksums held)
  uint64_t trailerTried_ = 0, trailerKey_ = 0, trailerAt_ = 0, trailerRetryNs_ = 1000000000ull, trailerAttempts_ = 0; bool trailerFinal_ = false, sumsOk_ = false;
  static uint64_t nowNs() { return (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

  // verify(): signal i's stored LOD against the buckets of its decoded changes, level by level, as they close.
  struct LodVerify {
    struct Lv { uint64_t cur = 0, cnt = 0; uint8_t fl = 0; bool has = false; uint32_t chunk = 0; size_t at = 0; std::vector<LodBucket> got; };
    const SegReader &r; ZSTD_DCtx *zd; uint32_t i; const LodInfo &li; const SigSpec &sp; std::vector<Lv> lv; std::vector<uint8_t> tmp; std::string err;
    // the normalised stream (SPEC §II.5): the pending change (the last one seen) and the last kept value
    std::vector<uint8_t> pend, kept; uint64_t pt = 0; bool hasPend = false, hasKept = false;
    LodVerify(const SegReader &r_, ZSTD_DCtx *z, uint32_t i_, const LodInfo &l, const SigSpec &s) : r(r_), zd(z), i(i_), li(l), sp(s), lv(l.nlev) {
      if (s.vtype == VT_BITS && s.fourState) { kept.assign(s.vlen, 0); for (uint32_t k = 0; k < s.bits; k++) kept[s.vlen / 2 + k / 8] |= (uint8_t)(1u << (k % 8)); hasKept = true; }
    }
    bool row(uint64_t t, const uint8_t *v, size_t len) {
      if (hasPend && t != pt && !settle()) return false;
      pend.assign(v, v + len); pt = t; hasPend = true; return true;
    }
    bool settle() {
      hasPend = false;
      if (hasKept && pend == kept) return true;
      kept = pend; hasKept = true; return kept1(pt, kept.data());
    }
    bool emit(uint32_t l) {
      Lv &L = lv[l]; if (!L.has) return true;
      while (L.at >= L.got.size()) {
        if (L.chunk >= li.levels[l].nchunk) { err = "LOD level " + std::to_string(l) + " has fewer buckets than the changes"; return false; }
        if (!r.decodeLod(zd, i, l, L.chunk++, L.got, tmp, err)) { err = "LOD level " + std::to_string(l) + ": " + err; return false; }
        L.at = 0;
      }
      const LodBucket &g = L.got[L.at++];
      if (g.bucket != L.cur || g.cnt != (L.cnt < 2 ? L.cnt : 2) || g.flags != L.fl) { err = "LOD level " + std::to_string(l) + " bucket " + std::to_string(L.cur) + " differs from the changes"; return false; }
      return true;
    }
    bool kept1(uint64_t t, const uint8_t *v) {
      bool x = false; if (sp.vtype == VT_BITS && sp.fourState) for (uint32_t j = sp.vlen / 2; j < sp.vlen && !x; j++) x = v[j] != 0;
      const uint64_t b0 = t / li.lodBase;
      for (uint32_t l = 0; l < li.nlev; l++) {
        Lv &L = lv[l]; const uint64_t b = b0 >> (2 * l);
        if (!L.has || b != L.cur) { if (!emit(l)) return false; L.cur = b; L.cnt = 0; L.fl = 0; L.has = true; }
        L.cnt++; if (x) L.fl |= 1;
        if (sp.vtype == VT_BITS && sp.bits == 1) L.fl = (uint8_t)((L.fl & 1) | ((v[0] & 1) << 1));
      }
      return true;
    }
    bool finish() {
      if (hasPend && !settle()) return false;
      for (uint32_t l = 0; l < li.nlev; l++) {
        if (!emit(l)) return false;
        if (lv[l].at != lv[l].got.size() || lv[l].chunk != li.levels[l].nchunk) { err = "LOD level " + std::to_string(l) + " has more buckets than the changes"; return false; }
      }
      return true;
    }
  };
  // Signal i's LodSig (sig = nullptr: none), its LevEnts and LodEnts, and the LOD body, after its segment's check.
  struct LodAt { const uint8_t *sig = nullptr, *lev = nullptr, *ent = nullptr, *body = nullptr; };
  bool lodAt(uint32_t i, LodAt &a, std::string &err) const {
    a = LodAt(); if (!lodGx_) return true;
    const uint32_t g = ld32(lodGx_ + (uint64_t)SIGX * dataOf(i) + 60); if (g == NONE32) return true;
    uint32_t k = 0; while (k + 1 < lodSegs_.size() && lodSegs_[k + 1].first <= g) k++;
    if (k >= lodSegs_.size() || g - lodSegs_[k].first >= lodSegs_[k].n) return fail(err, "SigX.lod names no LodSig");
    if (!lodOk_.get(k)) { if (!lodSegCheck(k, err)) return false; lodOk_.set(k); }
    const SegInfo &s = segs_[lodSegs_[k].seg]; const uint8_t *b = m_ + s.off + SEGH; const uint64_t fs = s.bodyLen - ld64(b + s.bodyLen - 8);
    const uint32_t ns = lodSegs_[k].n; const uint8_t *q = b + fs + 8 + (uint64_t)LODSIG * (g - lodSegs_[k].first);
    // the segment's level total: the last LodSig's first_lev + nlev (lodSegCheck checked the running totals)
    const uint8_t *last = b + fs + 8 + (uint64_t)LODSIG * (ns - 1); const uint64_t levs = (uint64_t)ld32(last + 8) + ld32(last + 4);
    a.sig = q; a.body = b; a.lev = b + fs + 8 + (uint64_t)LODSIG * ns + (uint64_t)LODLEV * ld32(q + 8);
    a.ent = b + fs + 8 + (uint64_t)LODSIG * ns + (uint64_t)LODLEV * levs + (uint64_t)LODENT * ld32(q + 12);
    return true;
  }
  // An LOD segment's checksum and structure (SPEC §II.7), checked whole once.
  bool lodSegCheck(uint32_t k, std::string &err) const {
    using namespace segdetail;
    const LodSeg &L = lodSegs_[k]; const SegInfo &s = segs_[L.seg]; const uint8_t *h = m_ + s.off, *b = h + SEGH;
    if (!segHdrOk(s)) return fail(err, "LOD segment: SegHdr differs from the INDEX");
    if (xxh64(h, SEGH + s.bodyLen + 24) != s.xxh) return fail(err, "LOD segment checksum mismatch");
    const uint64_t len = s.bodyLen, fl = ld64(b + len - 8), fs = len - fl;  // 16 <= fl <= len (open)
    const uint32_t ns = ld32(b + fs); const uint8_t *sg = b + fs + 8;
    if ((fs & 7) || ns != L.n || ld32(b + fs + 4)) return fail(err, "bad LOD footer");
    uint64_t levs = 0, chunks = 0;
    for (uint32_t j = 0; j < ns; j++) {
      const uint8_t *q = sg + (uint64_t)LODSIG * j; const uint32_t sig = ld32(q), nlev = ld32(q + 4); const uint64_t base = ld64(q + 16);
      if (sig >= nSignals() || lodGx_[(uint64_t)SIGX * sig + 52] != 0 || ld32(lodGx_ + (uint64_t)SIGX * sig + 60) != L.first + j) return fail(err, "LodSig " + std::to_string(L.first + j) + " names a signal whose SigX.lod isn't it");
      if (j && sig <= ld32(sg + (uint64_t)LODSIG * (j - 1))) return fail(err, "LodSigs not in signal order");
      if (!nlev || nlev > MAX_LOD_LEVELS || !base || ld64(q + 24) || (nlev > 1 && base > (~0ull >> (2 * (nlev - 1))))) return fail(err, "bad LodSig " + std::to_string(L.first + j));
      if (ld32(q + 8) != levs || ld32(q + 12) != chunks) return fail(err, "LodSig " + std::to_string(L.first + j) + " levels or chunks not after the previous signal's");
      if (8 + (uint64_t)LODSIG * ns + (uint64_t)LODLEV * (levs + nlev) + 8 > fl) return fail(err, "LOD level entries past the footer");
      const uint8_t *lv = sg + (uint64_t)LODSIG * ns + (uint64_t)LODLEV * levs; uint64_t rel = 0;
      uint64_t cap = ld64(lodGx_ + (uint64_t)SIGX * sig + 8);  // a level has at most the normalised changes, and at most the level below's entries
      for (uint32_t l = 0; l < nlev; l++) { const uint8_t *e = lv + (uint64_t)LODLEV * l; if (ld32(e) != rel || !ld32(e + 4)) return fail(err, "LOD levels not consecutive"); rel += ld32(e + 4);
        if (ld64(e + 8) > cap) return fail(err, "LOD level " + std::to_string(l) + " has more entries than " + (l ? "the level below" : "the signal's normalised changes"));
        cap = ld64(e + 8); }
      if (rel > MAX_LOD_CHUNKS) return fail(err, "more than 2^24 LOD chunks for a signal");
      levs += nlev; chunks += rel;
    }
    if (8 + (uint64_t)LODSIG * ns + (uint64_t)LODLEV * levs + (uint64_t)LODENT * chunks + 8 != fl) return fail(err, "LOD footer size doesn't match its counts");
    const uint8_t *lv = sg + (uint64_t)LODSIG * ns, *ce = lv + (uint64_t)LODLEV * levs; uint64_t off = 0, li = 0, ci = 0;
    for (uint32_t j = 0; j < ns; j++) for (uint32_t l = 0, nlev = ld32(sg + (uint64_t)LODSIG * j + 4); l < nlev; l++, li++) {
      const uint8_t *e = lv + (uint64_t)LODLEV * li; uint64_t sum = 0, pb = 0;
      for (uint32_t c = 0, nc = ld32(e + 4); c < nc; c++, ci++) {
        const uint8_t *p = ce + (uint64_t)LODENT * ci; const uint64_t b0 = ld64(p), o = ld64(p + 8); const uint32_t cs = ld32(p + 16), n = ld32(p + 20), rs = ld32(p + 24);
        if (o != off || !cs || cs > fs - off) return fail(err, "LOD frames not back to back");
        if (!n || n > MAX_LOD_ENTRIES || rs < 2ull * n || rs > 11ull * n || ld32(p + 28)) return fail(err, "bad LOD chunk sizes");
        if (c && b0 <= pb) return fail(err, "LOD chunk b0 not increasing");
        sum += n; off += cs; pb = b0;
      }
      if (sum != ld64(e + 8)) return fail(err, "LOD level entry count differs from its chunks");
    }
    if (off > fs || fs - off > 7) return fail(err, "LOD frames don't end at the footer");
    for (uint64_t o = off; o < fs; o++) if (b[o]) return fail(err, "nonzero padding before the LOD footer");
    return true;
  }

  // Complete files (blocks from the INDEX): block r of signal `owner` must be the DATA footer entry its BlkX names,
  // field for field, and that entry must name `owner`. Each footer is checked whole on first use, as the scan
  // checks it (entries packed back to back), so no two entries share block bytes. Without this, a BlkX could point
  // at another signal's block and the INDEX would say what the segments don't.
  bool bound(uint32_t owner, const BlockRef &r, std::string &err) const {
    using namespace segdetail;
    if (!complete_) return true;  // scanned: the blocks came from the footers
    const SegInfo &s = segs_[r.seg]; const uint8_t *body = m_ + s.off + SEGH;
    if (!footOk_.get(r.seg)) { if (!footerPacked(r.seg, err, false)) return false; footOk_.set(r.seg); }
    if (const uint8_t *q = footCopy(s)) body = q;  // setFooterFd
    uint64_t fs = s.bodyLen - ld64(body + s.bodyLen - 8); uint32_t nb = ld32(body + fs);
    if (r.entry >= nb) return fail(err, "index entry not in its segment's footer");
    BlockInfo e; uint32_t sig; uint64_t off, res; parseEnt(body + fs + 8 + (uint64_t)BENT * r.entry, e, sig, off, res);
    if (sig != owner || s.off + SEGH + off != r.off || e.rows != r.info.rows || e.nNorm != r.info.nNorm || e.nchunk != r.info.nchunk || e.mode != r.info.mode || e.flags != r.info.flags ||
        e.t0 != r.info.t0 || e.tLast != r.info.tLast || e.len != r.info.len || e.rsize != r.info.rsize || e.xxh != r.info.xxh) return fail(err, "index entry differs from its footer entry (block not this signal's)");
    if (footBad_.get(owner)) return fail(err, "signal " + std::to_string(owner) + ": a DATA footer holds a block of it the INDEX leaves out");
    return true;
  }
  // A SEGNB body (SPEC §II.8) for n segments, SEGNB the last of them: u32 n, u32 0, n counts, SEGNB's own 0, zero padding.
  static bool segnbBody(const uint8_t *nb, uint64_t len, uint64_t n, std::string &err) {
    if (len < 8 || ld32(nb) != n || ld32(nb + 4) || len != align8(8 + 4 * n)) return fail(err, "bad SEGNB counts");
    if (ld32(nb + 8 + 4 * (n - 1))) return fail(err, "SEGNB's own count is not 0");
    if (!segdetail::zeros(nb + 8 + 4 * n, len - 8 - 4 * n)) return fail(err, "bad SEGNB padding");
    return true;
  }
  // A DATA footer's structure (SPEC §II.6.1): counts, entries packed from the body start, signals declared before this
  // segment, and (with padding) the padding after each block 0. An entry its signal's BlkX doesn't name marks that
  // signal bad (footBad_). The padding is spread across the segment's blocks, so reads (bound) skip it and
  // only verify() checks it; the scan checks it as it reads every block.
  // setFooterFd: pread exactly n bytes at off (retrying EINTR and short reads); false on any failure (the caller then
  // reads the image).
  bool footRead(void *dst, uint64_t n, uint64_t off) const {
#if defined(__unix__) || defined(__APPLE__)
    if (footFd_ < 0 || off > n_ || n > n_ - off) return false;
    uint8_t *d = (uint8_t *)dst;
    while (n) { const ssize_t r = ::pread(footFd_, d, (size_t)n, (off_t)off); if (r < 0 && errno == EINTR) continue; if (r <= 0) return false; d += r; off += (uint64_t)r; n -= (uint64_t)r; }
    return true;
#else
    (void)dst; (void)n; (void)off; return false;
#endif
  }
  // setFooterFd: segment s's DATA footer copied into a thread-local buffer. Returns p with p + x = body byte x for every x
  // in the footer (x >= bodyLen - footer length), or nullptr (no fd, a failed read, or a footer length out of range: the
  // caller reads the image and reports what it finds there).
  const uint8_t *footCopy(const SegInfo &s) const {
    if (footFd_ < 0 || s.bodyLen < 16) return nullptr;
    thread_local std::vector<uint8_t> fb; uint8_t l8[8]; const uint64_t body = s.off + SEGH, len = s.bodyLen;
    if (!footRead(l8, 8, body + len - 8)) return nullptr;
    const uint64_t fl = ld64(l8); if (fl < 16 || fl > len || fl > MAX_FOOTER_COPY) return nullptr;
    fb.resize((size_t)fl); if (!footRead(fb.data(), fl, body + len - fl)) return nullptr;
    // the body's start rebased onto the copy (address arithmetic, not pointer arithmetic outside the buffer);
    // callers only dereference it at body offsets inside the footer
    return reinterpret_cast<const uint8_t *>(reinterpret_cast<uintptr_t>(fb.data()) - (uintptr_t)(len - fl));
  }
  static const uint64_t MAX_FOOTER_COPY = 1ull << 30;
  bool footerPacked(uint32_t seg, std::string &err, bool padding) const {
    using namespace segdetail;
    const SegInfo &s = segs_[seg];
    const uint8_t *b = m_ + s.off + SEGH; uint64_t len = s.bodyLen;
    if (!padding) if (const uint8_t *q = footCopy(s)) b = q;  // setFooterFd; padding (verify) reads the blocks too
    // a footer whose own length or counts are bad names no entry that can be trusted: every signal declared before
    // this segment (any of them may have a block in it) fails from then on
    auto whole = [&](const char *m) { for (uint32_t i = 0; i < sigsAt_[seg] && i < footBad_.n; i++) footBad_.set(i); return fail(err, "segment " + std::to_string(s.seq) + ": " + m); };
    if (!segHdrOk(s)) return whole(unsupportedType(s.type, ld32(m_ + s.off + 12)).empty() ? "SegHdr differs from the INDEX" : "SegHdr differs from the INDEX (unsupported segment flags)");
    if (len < 16) return whole("DATA body too short");
    uint64_t fl = ld64(b + len - 8); if (fl < 16 || fl > len || ((len - fl) & 7)) return whole("bad DATA footer length");
    uint64_t fs = len - fl; uint32_t nb = ld32(b + fs), nd = ld32(b + fs + 4);
    if (nb > MAX_SEG_BLOCKS || nd > MAX_DOFF_TOTAL || 16 + (uint64_t)BENT * nb + (uint64_t)DENT * nd != fl) return whole("DATA footer counts don't match its length");
    // Every entry is checked against the INDEX (named), also after an entry fails: a footer that fails still marks the
    // signals the INDEX leaves out of it. The first failure is the one returned.
    uint64_t pos = 0; bool bad = false;
    auto first = [&](const std::string &m) { if (!bad) { err = m; bad = true; } };
    for (uint32_t k = 0; k < nb; k++) {
      BlockInfo e; uint32_t sig; uint64_t off, res; parseEnt(b + fs + 8 + (uint64_t)BENT * k, e, sig, off, res);
      if (sig < sigsAt_[seg] && off <= fs && !named(sig, seg, k, s.off + SEGH + off)) footBad_.set(sig);  // the INDEX leaves this block out: that signal fails
      if (bad) continue;
      if (res || sig >= sigsAt_[seg] || off != pos || e.len > fs - pos) { first("segment " + std::to_string(s.seq) + " footer: block " + std::to_string(k) + (sig >= sigsAt_[seg] ? " names a signal not declared before it" : " not where the previous one ends")); continue; }
      uint64_t a = align8(pos + e.len); if (a > fs || (padding && !zeros(b + pos + e.len, a - pos - e.len))) { first("segment " + std::to_string(s.seq) + " footer: bad block padding"); continue; }
      pos = a;
    }
    if (bad) return false;
    if (pos != fs) return fail(err, "DATA footer not right after the last block");
    // after the entries: a footer entry the INDEX leaves out has marked its signal (footBad_) either way
    if (segNb_ && nb != ld32(segNb_ + 4ull * seg)) return fail(err, "segment " + std::to_string(s.seq) + " footer: its block count (" + std::to_string(nb) + ") differs from SEGNB's (" + std::to_string(ld32(segNb_ + 4ull * seg)) + ")");
    return true;
  }

  // Whether signal sig's BlkX range holds the entry (seg, k) at absolute offset off (the range ascends by offset).
  bool named(uint32_t sig, uint32_t seg, uint32_t k, uint64_t off) const {
    if (sig >= nSignals()) return false;
    const uint8_t *q = gx_ + (uint64_t)SIGX * sig; if (q[52] == 1) return false;
    uint64_t lo = ld64(q + 40), hi = lo + ld32(q + 48); if (hi > nbl_) return false;
    while (lo < hi) { uint64_t md = lo + (hi - lo) / 2; if (ld64(bx_ + (uint64_t)BLKX * md + 32) < off) lo = md + 1; else hi = md; }
    if (lo >= ld64(q + 40) + ld32(q + 48)) return false;
    const BlockRef r = blkX(lo); return r.off == off && r.sig == sig && r.seg == seg && r.entry == k;
  }

  static bool fail(std::string &err, const std::string &m) { err = m; return false; }
  // A segment's SegHdr against its INDEX entry (SPEC §II.3): magic, type, hdr_size, seq, all 32 flag bits, body_len,
  // file_id. Fast open reads it for the segments it parses; DATA and LOD on first use (footerPacked, lodSegCheck).
  bool segHdrOk(const SegInfo &s) const {
    const uint8_t *h = m_ + s.off; uint8_t hb[SEGH];
    if (footFd_ >= 0 && footRead(hb, SEGH, s.off)) h = hb;  // setFooterFd (the same bytes)
    return ld32(h) == SEG_MAGIC && ld16(h + 4) == s.type && ld16(h + 6) == SEGH && ld32(h + 8) == s.seq && ld32(h + 12) == s.flags && ld64(h + 16) == s.bodyLen && ld64(h + 24) == hdr_.fileId;
  }

  bool checkHeader(std::string &err) {
    if (!m_ || n_ < FHDR) return fail(err, "file too small for a WCZ1 header");
    const uint8_t *p = m_;
    if (ld32(p) != FILE_MAGIC) return fail(err, ld32(p) == 0x32424357 ? "this is a single-signal WCB2 file, not a WCZ1 container" : "not a WCZ1 file");
    if (xxh64(p, 56) != ld64(p + 56)) return fail(err, "header checksum mismatch");
    hdr_.version = ld16(p + 4); hdr_.incompat = ld32(p + 8); hdr_.roCompat = ld16(p + 20); hdr_.compat = ld16(p + 22); hdr_.writer = ld32(p + 12); hdr_.tsExp = (int8_t)p[16]; hdr_.tsMult = ld16(p + 18);
    hdr_.tBegin = ld64(p + 24); hdr_.stamp = ld64(p + 32); hdr_.fileId = ld64(p + 40); hdr_.bodyOff = ld64(p + 48);
    if (hdr_.version != 1 || ld16(p + 6) != FHDR) return fail(err, "unsupported WCZ1 version");
    if (hdr_.incompat & ~KNOWN_INCOMPAT) { char b[96]; snprintf(b, sizeof b, "unsupported incompatible feature bits 0x%x (this reader knows 0x%x)", hdr_.incompat & ~KNOWN_INCOMPAT, KNOWN_INCOMPAT); return fail(err, b); }
    if (hdr_.writer != WRITER_CONVERTER && hdr_.writer != WRITER_STREAM) return fail(err, "unknown writer kind");
    if (hdr_.tsExp < -18 || hdr_.tsExp > 0 || p[17] || !(hdr_.tsMult == 1 || hdr_.tsMult == 10 || hdr_.tsMult == 100)) return fail(err, "bad timescale");
    if (hdr_.fileId == 0 || hdr_.bodyOff != FHDR) return fail(err, "bad file id or body offset");
    nextOff_ = FHDR; return true;
  }

  // Segment framing at o (no body parse). Fills s; false if it is not a complete segment.
  bool frame(uint64_t o, uint32_t seq, SegInfo &s, std::string &err, bool *unsup = nullptr) const {
    if (o > n_ || n_ - o < SEGH + SEGE) return fail(err, "short segment");
    const uint8_t *p = m_ + o;
    if (ld32(p) != SEG_MAGIC || ld16(p + 6) != SEGH) return fail(err, "bad segment magic");
    s.off = o; s.type = ld16(p + 4); s.seq = ld32(p + 8); s.flags = ld32(p + 12); s.bodyLen = ld64(p + 16);
    if (s.seq != seq) return fail(err, "segment sequence gap");
    if ((s.bodyLen & 7) || s.bodyLen > MAX_BODY || ld64(p + 24) != hdr_.fileId) return fail(err, "bad segment length or file id");
    if (s.bodyLen > n_ - o - SEGH - SEGE) return fail(err, "short segment");
    const uint8_t *e = p + SEGH + s.bodyLen;
    if (ld32(e) != END_MAGIC || ld32(e + 4) != s.seq || ld64(e + 8) != o) return fail(err, "bad segment end");
    s.tCut = ld64(e + 16); s.xxh = ld64(e + 24);
    if (xxh64(p, SEGH + s.bodyLen + 24) != s.xxh) return fail(err, "segment checksum mismatch");  // SegHdr + body + SegEnd up to t_cut
    // a complete segment: a type or flag rule it breaks means a writer this reader doesn't support, not a torn file
    if (unsup) { std::string u = unsupportedType(s.type, ld32(p + 12)); if (!u.empty()) { *unsup = true; return fail(err, "segment " + std::to_string(s.seq) + ": " + u); } }
    if (knownType(s.type) && s.type != SEG_DATA && s.tCut != NONE64) return fail(err, "time cut on a segment that is not DATA");  // unknown OPTIONAL types: skipped whole
    return true;
  }
  static bool knownType(uint16_t type) { return (type >= SEG_META && type <= SEG_COMP) || type == SEG_SEGNB; }
  // SPEC §II.3 type and flag rules; "" when the segment is supported (or OPTIONAL, to be skipped).
  static std::string unsupportedType(uint16_t type, uint32_t flags) {
    if (flags & ~(uint32_t)SF_OPTIONAL) return "unsupported segment flags " + std::to_string(flags);
    bool known = knownType(type), opt = flags & SF_OPTIONAL;
    if (known && (type == SEG_SEQ || type == SEG_COMP || type == SEG_SEGNB) != opt) return "segment type " + std::to_string(type) + (opt ? " must not" : " must") + " set OPTIONAL";
    if (!known && !opt) return "unsupported required segment type " + std::to_string(type);
    return "";
  }

  struct DataPart { std::vector<BlockRef> blocks; std::vector<DoffE> doff; };
  // DATA body checks (SPEC §II.6.1-7.3) against the current state; nothing is committed.
  bool parseData(const SegInfo &s, uint32_t segIdx, DataPart &out, std::string &err) const {
    using namespace segdetail;
    const uint8_t *b = m_ + s.off + SEGH; uint64_t len = s.bodyLen;
    if (len < 16) return fail(err, "DATA body too short");
    uint64_t fl = ld64(b + len - 8); if (fl < 16 || fl > len || ((len - fl) & 7)) return fail(err, "bad DATA footer length");
    uint64_t fs = len - fl; uint32_t nb = ld32(b + fs), nd = ld32(b + fs + 4);
    if (nb > MAX_SEG_BLOCKS || nd > MAX_DOFF_TOTAL || 16 + (uint64_t)BENT * nb + (uint64_t)DENT * nd != fl) return fail(err, "DATA footer counts don't match its length");
    // per-signal last time within this segment: reader-wide scratch, valid where stamp == this segment's epoch
    if (stamp_.size() < nSignals()) { stamp_.resize(nSignals(), 0); lastT_.resize(nSignals(), 0); }
    if (++epoch_ == 0) { std::fill(stamp_.begin(), stamp_.end(), 0); epoch_ = 1; }
    auto has = [&](uint32_t i) { return stamp_[i] == epoch_; };
    uint64_t pos = 0;
    for (uint32_t k = 0; k < nb; k++) {
      BlockRef r; uint64_t off, res; parseEnt(b + fs + 8 + (uint64_t)BENT * k, r.info, r.sig, off, res);
      std::string at = "segment " + std::to_string(s.seq) + " block " + std::to_string(k) + ": ";
      if (res) return fail(err, at + "reserved not 0");
      if (r.sig >= nSignals()) return fail(err, at + "undeclared signal");
      if (off != pos || r.info.len > fs - pos) return fail(err, at + "block not where the previous one ends");
      if (!infoOk(dict_.sigs[r.sig].spec, r.info, err)) return fail(err, at + err);
      uint64_t e = pos + r.info.len, a = align8(e); if (a > fs || !zeros(b + e, a - e)) return fail(err, at + "bad block padding");
      pos = a;
      if (anyClaim_ && r.info.t0 <= maxClaim_) return fail(err, at + "block starts at or before an earlier time cut");
      uint64_t prevLast = has(r.sig) ? lastT_[r.sig] : (sblk_[r.sig].empty() ? 0 : blocks_[sblk_[r.sig].back()].info.tLast);
      bool prevAny = has(r.sig) || !sblk_[r.sig].empty();
      if (prevAny && r.info.t0 < prevLast) return fail(err, at + "block starts before the signal's previous block ends");
      stamp_[r.sig] = epoch_; lastT_[r.sig] = r.info.tLast;
      r.off = s.off + SEGH + off; r.seg = segIdx; r.entry = k; out.blocks.push_back(r);
    }
    if (pos != fs) return fail(err, "DATA footer not right after the last block");
    uint32_t expectKind = doff_.empty() ? 0 : 1 - doff_.back().kind; uint64_t prevT = doff_.empty() ? 0 : doff_.back().t;
    for (uint32_t k = 0; k < nd; k++) {
      const uint8_t *q = b + fs + 8 + (uint64_t)BENT * nb + (uint64_t)DENT * k; DoffE d{ld64(q), ld32(q + 8)};
      if (d.kind != expectKind || ld32(q + 12) || d.t < prevT) return fail(err, "bad dump-off entry");
      if (doff_.size() + out.doff.size() >= MAX_DOFF_TOTAL) return fail(err, "too many dump-off entries");
      out.doff.push_back(d); expectKind = 1 - expectKind; prevT = d.t;
    }
    if (s.tCut != NONE64) {
      if (hdr_.writer == WRITER_CONVERTER) return fail(err, "time cut in a converter-written file");
      if (anyClaim_ && s.tCut < lastClaim_) return fail(err, "time cut decreases");
    }
    return true;
  }
  void commitData(const SegInfo &s, DataPart &p) {
    for (auto &r : p.blocks) {
      SigSum &g = sums_[r.sig]; std::vector<uint32_t> &bl = sblk_[r.sig]; if (bl.empty()) g.t0 = r.info.t0;
      g.n += r.info.rows; g.nNorm += r.info.nNorm; g.tLast = r.info.tLast; bl.push_back((uint32_t)blocks_.size()); blocks_.push_back(r);
    }
    doff_.insert(doff_.end(), p.doff.begin(), p.doff.end());
    if (s.tCut != NONE64) { lastClaim_ = s.tCut; maxClaim_ = s.tCut; anyClaim_ = true; }
  }

  // Scans complete segments from nextOff_; stops at the first one that fails (the logical end of the file).
  void scan(std::string &err) {
    while (true) {
      SegInfo s; std::string e;
      if (indexSeen_) { stop_ = "after INDEX"; break; }
      bool unsup = false;
      if (!frame(nextOff_, nextSeq_, s, e, &unsup)) { stop_ = e; if (unsup) fatal_ = e; break; }
      bool ok = true;
      if (nextSeq_ == 0 && s.type != SEG_META) { e = "first segment is not META"; ok = false; }
      else if (nextSeq_ > 0 && s.type == SEG_META) { e = "second META segment"; ok = false; }
      else if (lodSeen_ && (s.type == SEG_DATA || s.type == SEG_META_APPEND)) { e = "DATA or META_APPEND after LOD"; ok = false; }
      else if (segnbSeen_ && s.type != SEG_INDEX) { e = "a segment other than the INDEX after SEGNB"; ok = false; }
      if (ok && (s.type == SEG_META || s.type == SEG_META_APPEND)) {
        // parseMetaBody changes dict_ only when the whole body is valid
        ok = parseMetaBody(m_ + s.off + SEGH, s.bodyLen, s.type == SEG_META, dict_, e);
        if (ok) { sums_.resize(dict_.sigs.size()); sblk_.resize(dict_.sigs.size()); metaSeen_ = true; }
      } else if (ok && s.type == SEG_DATA) {
        DataPart p; ok = parseData(s, (uint32_t)segs_.size(), p, e); if (ok) commitData(s, p);
      } else if (ok && s.type == SEG_LOD) { lodSeen_ = true;  // used only for a complete file read to its INDEX (scannedComplete)
      } else if (ok && s.type == SEG_INDEX) { indexSeen_ = true; indexOff_ = s.off;
      } else if (ok && s.type == SEG_SEGNB) {  // counts: each scanned DATA footer's n_blocks, 0 elsewhere
        const uint8_t *nb = m_ + s.off + SEGH; ok = segnbBody(nb, s.bodyLen, (uint64_t)segs_.size() + 1, e);
        for (size_t k = 0; ok && k < segs_.size(); k++) {
          uint32_t want = 0; if (segs_[k].type == SEG_DATA) { const uint8_t *b = m_ + segs_[k].off + SEGH; want = ld32(b + segs_[k].bodyLen - ld64(b + segs_[k].bodyLen - 8)); }
          if (ld32(nb + 8 + 4 * k) != want) { e = "SEGNB count of segment " + std::to_string(k) + " differs from its footer"; ok = false; }
        }
        if (ok) segnbSeen_ = true; else if (e.find("SEGNB") == std::string::npos) e = "SEGNB: " + e;
      }
      if (!ok) { stop_ = e; ruleStop_ = true; break; }
      segs_.push_back(s); nextOff_ = s.off + SEGH + s.bodyLen + SEGE; nextSeq_++;
    }
    err.clear();
  }
  // Live reading (CONFORMANCE §4): once a Trailer for the INDEX where the scan stands appears, switch to it, through
  // the fast open only (no rescan), and only if its segment list agrees with what was scanned. Tried once per size.
  // A file with a valid Trailer that was scanned (its INDEX refused): the scan builds signals from the DATA footers, so
  // a REF signal (no blocks of its own; only SigX names its target) or a signal whose blocks it didn't find would read
  // as empty. With the INDEX segment intact (its checksum holds), a REF in SigX whose target is codec 0 with the same
  // declaration and summary is served as that target, and a signal SigX declares empty stays empty. Every other
  // signal with no blocks fails its reads (scanBad_); verify() fails on the file.
  void scannedComplete() {
    const uint8_t *t = m_ + n_ - TRL; const uint32_t N = nSignals();
    if (n_ < FHDR + TRL || ld32(t) != TRL_MAGIC || xxh64(t, 56) != ld64(t + 56) || ld64(t + 32) != n_ || ld64(t + 40) != hdr_.fileId) return;
    // once per image: the same size, Trailer, signal count and scanned blocks give the same result
    const uint64_t key = ld64(t + 56) ^ ((uint64_t)N << 32) ^ segs_.size();
    if (scannedComplete_ && scannedN_ == n_ && scannedKey_ == key) return;
    scannedN_ = n_; scannedKey_ = key;
    scannedComplete_ = true; scanBad_.assign(N);
    const uint8_t *gx = nullptr; SegInfo ix; std::string e; const uint64_t io = ld64(t + 8); const uint32_t nseg = ld32(t + 16);
    if (nseg >= 1 && io >= FHDR && io < n_ - TRL && frame(io, nseg - 1, ix, e) && ix.type == SEG_INDEX && ix.xxh == ld64(t + 48) && ix.bodyLen >= 24) {
      const uint8_t *b = m_ + io + SEGH; const uint64_t ns = ld32(b), nsig = ld32(b + 4);
      if (nsig == N && 24 + (uint64_t)SEGX * ns + (uint64_t)SIGX * nsig <= ix.bodyLen) gx = b + 24 + (uint64_t)SEGX * ns;
    }
    // the scan stopped before the INDEX at a segment that can hold blocks (or one it can't frame): blocks past the stop
    // are unknown, so no signal's last scanned block (or, for a signal with none, any read) can be served; reads that
    // end inside the scanned blocks still are. A stop at a segment holding no blocks (LOD, SEGNB) leaves them known.
    stoppedEarly_ = false; uint64_t o = nextOff_;
    for (uint64_t q = nextSeq_; o < io && !stoppedEarly_; q++) {
      SegInfo g; std::string fe;
      if (!frame(o, (uint32_t)q, g, fe) || g.type == SEG_DATA || g.type == SEG_META_APPEND || g.type == SEG_META) stoppedEarly_ = true;
      else o = g.off + SEGH + g.bodyLen + SEGE;
    }
    if (nextOff_ <= io && o != io) stoppedEarly_ = true;  // stopped before the INDEX: the frames past the stop don't end at it
    for (uint32_t i = 0; i < N; i++) {
      if (!sblk_[i].empty()) continue;
      if (stoppedEarly_) { scanBad_.set(i); continue; }
      if (gx) {
        const SigSum g = sigAt(gx, i); const uint8_t *q = gx + (uint64_t)SIGX * i;
        if (g.codec == 0 && !ld32(q + 48) && !g.n) continue;  // declared empty
        if (g.codec == 1 && g.ref < N && g.ref != i && gx[(uint64_t)SIGX * g.ref + 52] == 0 && !sblk_[g.ref].empty()) {
          const SigSpec &a = dict_.sigs[i].spec, &c = dict_.sigs[g.ref].spec; const SigSum &r = sums_[g.ref];
          if (a.vtype == c.vtype && a.bits == c.bits && a.fourState == c.fourState && a.keyRows == c.keyRows && g.n == r.n && g.nNorm == r.nNorm && g.t0 == r.t0 && g.tLast == r.tLast) {
            sums_[i] = r; sums_[i].codec = 1; sums_[i].ref = g.ref; continue;
          }
        }
      }
      scanBad_.set(i);
    }
    // Read to the INDEX (no block can be past the stop): the answers of the fast open where the scan can check them.
    // The horizon is the Trailer's t_end (it is >= every scanned block's t_last). With the INDEX's checksum valid
    // and every codec-0 summary the scan built equal to its SigX (n, nNorm, t0, t_last): the stream hashes and the
    // stored LOD come from it (LOD segments checked on first use, as on the fast open; verify() still fails on the
    // file).
    scannedTEnd_ = NONE64; lodGx_ = nullptr; lodSegs_.clear(); lodOk_.assign(0);
    for (uint32_t i = 0; i < N; i++) if (sums_[i].codec == 0) { sums_[i].hash = 0; sums_[i].hashKnown = false; sums_[i].lod = NONE32; }
    if (stoppedEarly_) return;
    const uint64_t te = ld64(t + 24); bool teOk = te >= hdr_.tBegin;
    for (uint32_t i = 0; i < N && teOk; i++) if (!sblk_[i].empty() && sums_[i].tLast > te) teOk = false;
    if (teOk) scannedTEnd_ = te;
    if (!gx) return;
    for (uint32_t i = 0; i < N; i++) {
      if (sums_[i].codec != 0 || (i < scanBad_.n && scanBad_.get(i))) continue;
      const SigSum g = sigAt(gx, i); const SigSum &r = sums_[i];
      if (g.codec != 0 || g.n != r.n || g.nNorm != r.nNorm || g.t0 != r.t0 || g.tLast != r.tLast) return;  // the INDEX differs: none of it is used
    }
    std::vector<LodSeg> ls; uint64_t nl = 0;
    for (uint32_t k = 0; k < segs_.size(); k++) if (segs_[k].type == SEG_LOD) {
      const SegInfo &g = segs_[k]; const uint8_t *lb = m_ + g.off + SEGH; const uint64_t fl = g.bodyLen >= 16 ? ld64(lb + g.bodyLen - 8) : 0;
      if (fl < 16 || fl > g.bodyLen) return;
      const uint32_t c = ld32(lb + g.bodyLen - fl); if (8 + (uint64_t)32 * c > fl - 8 || nl + c > NONE32) return;
      ls.push_back(LodSeg{k, (uint32_t)nl, c}); nl += c;
    }
    for (uint32_t i = 0; i < N; i++) {
      if (sums_[i].codec != 0 || (i < scanBad_.n && scanBad_.get(i))) continue;
      const SigSum g = sigAt(gx, i); if (g.lod != NONE32 && g.lod >= nl) return;
      sums_[i].hash = g.hash; sums_[i].hashKnown = true; sums_[i].lod = g.lod;
    }
    for (uint32_t i = 0; i < N; i++) if (sums_[i].codec == 1 && sums_[i].ref < N) { sums_[i].hash = sums_[sums_[i].ref].hash; sums_[i].hashKnown = sums_[sums_[i].ref].hashKnown; sums_[i].lod = NONE32; }
    lodSegs_ = std::move(ls); lodOk_.assign(lodSegs_.size()); lodGx_ = gx;
  }
  // A failed attempt is repeated at the same size when the Trailer or INDEX SegEnd bytes change, or, if a checksum
  // failed, after trailerRetry(); a failure after the checksums hold is final for that size.
  void tryTrailer() {
    const uint8_t *t = m_ + n_ - TRL;
    if (ld32(t) != TRL_MAGIC || ld64(t + 8) != (indexSeen_ ? indexOff_ : nextOff_)) return;
    const uint64_t key = xxh64(t - SEGE, TRL + SEGE), now = nowNs();
    if (n_ == trailerTried_ && (trailerFinal_ || (key == trailerKey_ && now - trailerAt_ < trailerRetryNs_))) return;
    trailerTried_ = n_; trailerKey_ = key; trailerAt_ = now; trailerFinal_ = false; trailerAttempts_++;
    std::string e; SegReader c; c.budget_ = budget_; c.strict_ = strict_; c.advise_ = false; c.m_ = m_; c.n_ = n_;
    if (!c.checkHeader(e) || !c.openComplete(e)) { trailerErr_ = e; trailerFinal_ = c.sumsOk_; if (!c.fatal_.empty()) fatal_ = c.fatal_; return; }
    size_t k = std::min(segs_.size(), c.segs_.size());
    for (size_t j = 0; j < k; j++) {
      const SegInfo &a = segs_[j], &b = c.segs_[j];
      if (a.off != b.off || a.type != b.type || a.flags != b.flags || a.seq != b.seq || a.bodyLen != b.bodyLen || a.tCut != b.tCut || a.xxh != b.xxh) { trailerErr_ = "INDEX disagrees with the scanned segment " + std::to_string(j); trailerFinal_ = true; return; }
    }
    c.trailerTried_ = n_; c.trailerKey_ = key; c.trailerAt_ = now; c.trailerRetryNs_ = trailerRetryNs_; c.trailerAttempts_ = trailerAttempts_; *this = std::move(c);
  }

  // ---- the INDEX in place (complete files)
  static SigSum sigAt(const uint8_t *gx, uint32_t i) {
    const uint8_t *q = gx + (uint64_t)SIGX * i; SigSum g;
    g.n = ld64(q); g.nNorm = ld64(q + 8); g.t0 = ld64(q + 16); g.tLast = ld64(q + 24); g.hash = ld64(q + 32); g.hashKnown = true; g.codec = q[52]; g.ref = ld32(q + 56); g.lod = ld32(q + 60);
    return g;
  }
  SigSum sigX(uint32_t i) const { return sigAt(gx_, i); }
  // setMapAdvice. blocks: one madvise over the DATA region, from the first DATA segment's start to the last one's end
  // (one range, so the caller's mapping is split at most at its two ends, however many segments the file has; the
  // header, META before it and the INDEX after it keep normal readahead, and so do up to ADVISE_HOLES segments that
  // are not DATA inside it, at most two more splits each): ADV_RANDOM (no readahead: a cold read faults in its block,
  // not a 128 KiB window around it), ADV_SEQUENTIAL (verify reads every segment whole) or ADV_NORMAL. footers: per
  // DATA segment, from the INDEX (already read, so no DATA page is touched; out-of-range values are clamped), its
  // footer range, from its last INDEX block's end to the segment's end, advised WILLNEED (which changes no mapping
  // flags), in file order, up to ADVISE_FOOTER_CAP bytes in all. The cap stops at the first range that does not
  // fit; that range and every later one are read when first used.
  static const uint64_t ADVISE_FOOTER_CAP = 64ull << 20;
  static const uint32_t ADVISE_HOLES = 64;
  enum { ADV_NORMAL = 0, ADV_RANDOM = 1, ADV_SEQUENTIAL = 2 };
  void adviseMapped() const { adviseRanges(prefetch_ == FOOTER_PREFETCH_SYNC, ADV_RANDOM); }
  void adviseRanges(bool footers, int blocks) const {
#if defined(__unix__) || defined(__APPLE__)
    if (!advise_ || !complete_ || !m_ || !n_) return;
    const uintptr_t pg = (uintptr_t)sysconf(_SC_PAGESIZE), base = (uintptr_t)m_;
    if (!pg || (pg & (pg - 1))) return;
    const int ba = blocks == ADV_RANDOM ? MADV_RANDOM : blocks == ADV_SEQUENTIAL ? MADV_SEQUENTIAL : MADV_NORMAL;
    { uint64_t lo = n_, hi = 0; for (const SegInfo &s : segs_) if (s.type == SEG_DATA) { lo = std::min<uint64_t>(lo, s.off); hi = std::max<uint64_t>(hi, std::min<uint64_t>(s.off + SEGH + s.bodyLen + SEGE, n_)); }
      const uintptr_t a = (base + lo + pg - 1) & ~(pg - 1), b = (base + hi) & ~(pg - 1); if (hi > lo && b > a) (void)madvise((void *)a, b - a, ba);
      // a segment that is not DATA inside that region goes back to normal, for the first ADVISE_HOLES of them
      // (each splits the mapping at most twice more); pages it shares with a DATA segment keep the block advice
      if (ba != MADV_NORMAL) { uint32_t holes = 0;
        for (const SegInfo &s : segs_) { if (s.type == SEG_DATA || s.off <= lo || s.off >= hi) continue; if (holes++ >= ADVISE_HOLES) break;
          const uintptr_t c = (base + s.off + pg - 1) & ~(pg - 1), d = (base + std::min<uint64_t>(s.off + SEGH + s.bodyLen + SEGE, n_)) & ~(pg - 1); if (d > c) (void)madvise((void *)c, d - c, MADV_NORMAL); } } }
    if (footers) (void)adviseFooters();
#else
    (void)footers; (void)blocks;
#endif
  }
  uint32_t adviseFooters() const {
    uint32_t nadv = 0;
#if defined(__unix__) || defined(__APPLE__)
    if (!advise_ || !complete_ || !m_ || !n_ || !bx_) return 0;
    const uintptr_t pg = (uintptr_t)sysconf(_SC_PAGESIZE), base = (uintptr_t)m_;
    if (!pg || (pg & (pg - 1))) return 0;
    const size_t ns = segs_.size(); std::vector<uint64_t> end(ns, 0);
    for (uint64_t k = 0; k < nbl_; k++) { const uint8_t *e = bx_ + (uint64_t)BLKX * k; const uint32_t sg = ld32(e + 56); if (sg < ns) { const uint64_t x = ld64(e + 32) + ld32(e + 40); if (x > end[sg]) end[sg] = x; } }
    uint64_t left = ADVISE_FOOTER_CAP;
    for (size_t k = 0; k < ns && left; k++) {
      const SegInfo &s = segs_[k]; if (s.type != SEG_DATA) continue;
      const uint64_t body = std::min<uint64_t>(s.off + SEGH, n_), segEnd = std::min<uint64_t>(s.off + SEGH + s.bodyLen + SEGE, n_); const uint64_t fs = std::min(std::max(end[k], body), segEnd);
      const uintptr_t a = (base + fs) & ~(pg - 1), b = (base + segEnd + pg - 1) & ~(pg - 1);
      if (b <= a) continue;
      if (b - a <= left) { left -= b - a; (void)madvise((void *)a, b - a, MADV_WILLNEED); nadv++; } else left = 0;
    }
#endif
    return nadv;
  }
  // setBlockReadAhead: WILLNEED on [off, off + len) of the image when it spans at least blockRA_ pages
  void readAhead(uint64_t off, uint64_t len) const {
#if defined(__unix__) || defined(__APPLE__)
    if (!advise_ || !blockRA_ || !complete_ || !m_ || !len || off >= n_) return;
    static const uintptr_t pg = (uintptr_t)sysconf(_SC_PAGESIZE); if (!pg || (pg & (pg - 1))) return;
    len = std::min<uint64_t>(len, n_ - off);
    const uintptr_t a = ((uintptr_t)m_ + off) & ~(pg - 1), b = ((uintptr_t)m_ + off + len + pg - 1) & ~(pg - 1);
    if ((b - a) / pg < blockRA_) return;
    // in steps of READ_AHEAD_STEP: Linux reads ahead at most max(read_ahead_kb, max_sectors_kb) of the device per call
    bool ok = true; for (uintptr_t p = a; p < b; p += READ_AHEAD_STEP) ok &= !madvise((void *)p, std::min<uintptr_t>(READ_AHEAD_STEP, b - p), MADV_WILLNEED);
    if (ok) raCount_->fetch_add(1, std::memory_order_relaxed);
#else
    (void)off; (void)len;
#endif
  }
  // setMapAdvice: WILLNEED on [off, off + len) in READ_AHEAD_STEP calls, for the bytes open reads whole (the INDEX frame,
  // META): read ahead together instead of one fault (one readahead window) at a time
  void openAhead(uint64_t off, uint64_t len) const {
#if defined(__unix__) || defined(__APPLE__)
    if (!advise_ || !m_ || !len || off >= n_) return;
    static const uintptr_t pg = (uintptr_t)sysconf(_SC_PAGESIZE); if (!pg || (pg & (pg - 1))) return;
    len = std::min<uint64_t>(len, n_ - off);
    const uintptr_t a = ((uintptr_t)m_ + off) & ~(pg - 1), b = ((uintptr_t)m_ + off + len + pg - 1) & ~(pg - 1);
    for (uintptr_t p = a; p < b; p += READ_AHEAD_STEP) { const uintptr_t k = std::min<uintptr_t>(READ_AHEAD_STEP, b - p);
      madvise((void *)p, k, MADV_WILLNEED); oaBytes_->fetch_add(k, std::memory_order_relaxed); }  // requested bytes: a range past the mapping is counted, not dropped
#else
    (void)off; (void)len;
#endif
  }
  // the bytes chunk c of block r is decoded from (st: its seek table)
  void readAheadChunk(const BlockRef &r, const std::vector<SeekEnt> &st, uint32_t c) const {
    if (r.info.nchunk <= 1 || c >= st.size()) { readAhead(r.off, r.info.len); return; }
    uint64_t p = (uint64_t)SEEK_SIZE * r.info.nchunk; for (uint32_t k = 0; k < c; k++) p += st[k].csize;
    readAhead(r.off + p, st[c].csize);
  }
  // verify() reads every segment whole: sequential advice on the block ranges while it runs, restored after
  struct VerifyAdvice { const SegReader &r; VerifyAdvice(const SegReader &x) : r(x) { r.adviseRanges(false, ADV_SEQUENTIAL); } ~VerifyAdvice() { r.adviseRanges(false, ADV_RANDOM); } };
  BlockRef blkX(uint64_t k) const {
    BlockRef r; uint64_t off, res; segdetail::parseEnt(bx_ + (uint64_t)BLKX * k, r.info, r.sig, off, res);
    r.seg = (uint32_t)res; r.entry = (uint32_t)(res >> 32); r.off = off; return r;
  }
  // Signal i's BlkX range against SPEC §II.6.1-7.3 and §II.8 (what fast open used to check for every signal).
  bool checkBlocks(uint32_t i, std::string &err) const {
    const SigSum g = sigX(i); const uint8_t *q = gx_ + (uint64_t)SIGX * i; const uint64_t first = ld64(q + 40); const uint32_t nb = ld32(q + 48);
    const SigSpec &spec = dict_.sigs[i].spec; uint64_t n = 0, nn = 0, t0 = 0; BlockRef prev{};
    for (uint32_t k = 0; k < nb; k++) {
      const BlockRef r = blkX(first + k);
      auto bad = [&](const std::string &m) { return fail(err, "signal " + std::to_string(i) + " block " + std::to_string(k) + ": " + m); };
      if (r.sig != i || r.seg >= segs_.size() || segs_[r.seg].type != SEG_DATA) return bad("bad index entry");
      const SegInfo &s = segs_[r.seg];
      if (r.off < s.off + SEGH || r.off - s.off - SEGH > s.bodyLen || r.info.len > s.bodyLen - (r.off - s.off - SEGH) || ((r.off - s.off - SEGH) & 7)) return bad("block outside its segment");
      if (!infoOk(spec, r.info, err)) return bad(err);
      if (anyBefore_[r.seg] && r.info.t0 <= claimBefore_[r.seg]) return bad("block starts at or before an earlier time cut");
      if (k && (r.off <= prev.off || r.info.t0 < prev.info.tLast)) return bad("blocks out of order");
      if (r.info.tLast > tEnd_) return bad("block ends after t_end");
      if (!k) t0 = r.info.t0;
      n += r.info.rows; nn += r.info.nNorm; prev = r;
    }
    if (n != g.n || nn != g.nNorm || (nb && (g.t0 != t0 || g.tLast != prev.info.tLast))) return fail(err, "signal " + std::to_string(i) + ": summary differs from its blocks");
    return true;
  }

  // Fast open through Trailer + INDEX.
  bool openComplete(std::string &err) {
    const uint8_t *t = m_ + n_ - TRL;
    if (ld32(t) != TRL_MAGIC || ld16(t + 4) != 1 || ld16(t + 6) != TRL) return fail(err, "no trailer");
    if (xxh64(t, 56) != ld64(t + 56)) return fail(err, "trailer checksum mismatch");
    uint64_t io = ld64(t + 8); uint32_t nseg = ld32(t + 16); tEnd_ = ld64(t + 24);
    if (ld32(t + 20) || ld64(t + 32) != n_ || ld64(t + 40) != hdr_.fileId) return fail(err, "trailer doesn't match this file");
    if (nseg < 2 || tEnd_ < hdr_.tBegin) return fail(err, "bad trailer fields");
    // the INDEX frame: its checksum reads all of it. Advised only when its SegHdr frames exactly [io, n - TRL)
    // (frame() checks the rest), so a crafted offset can't advise the file.
    if (io <= n_ - TRL && n_ - TRL - io >= SEGH + SEGE && ld32(m_ + io) == SEG_MAGIC && ld64(m_ + io + 16) == n_ - TRL - io - SEGH - SEGE) openAhead(io, n_ - io);
    SegInfo ix; bool unsup = false; if (!frame(io, nseg - 1, ix, err, &unsup)) return fail(err, "INDEX: " + err);
    sumsOk_ = true;  // the Trailer's and the INDEX's checksums hold
    if (ix.type != SEG_INDEX || ix.off + SEGH + ix.bodyLen + SEGE != n_ - TRL || ix.xxh != ld64(t + 48)) return fail(err, "trailer doesn't point at the INDEX");
    const uint8_t *b = m_ + io + SEGH; uint64_t len = ix.bodyLen;
    if (len < 24) return fail(err, "INDEX too short");
    uint32_t ns = ld32(b), nsig = ld32(b + 4), ndo = ld32(b + 16); uint64_t nbl = ld64(b + 8);
    if (ld32(b + 20)) return fail(err, "INDEX pad word not 0");
    if (ns != nseg - 1 || nsig > MAX_ITEMS || nbl > ((uint64_t)1 << 40) || ndo > MAX_DOFF_TOTAL) return fail(err, "bad INDEX counts");
    uint64_t need = 24 + (uint64_t)SEGX * ns + (uint64_t)SIGX * nsig + (uint64_t)BLKX * nbl + (uint64_t)DENT * ndo;
    if (need != len) return fail(err, "INDEX size doesn't match its counts");
    const uint8_t *sx = b + 24, *gx = sx + (uint64_t)SEGX * ns, *bx = gx + (uint64_t)SIGX * nsig, *dx = bx + (uint64_t)BLKX * nbl;
    // the segments open reads whole (META, META_APPEND, SEGNB), read ahead before the loop checks them in order; only
    // while the list is contiguous (the loop's own check), so overlapping entries can't advise the same bytes again
    for (uint64_t ao = FHDR, k = 0; k < ns; k++) { const uint8_t *q = sx + (uint64_t)SEGX * k; const uint16_t ty = ld16(q + 8); const uint64_t so = ld64(q), bl = ld64(q + 16);
      if (so != ao || ld32(q + 12) != k || (bl & 7) || bl > io - ao || io - ao - bl < SEGH + SEGE) break;
      if (ty == SEG_META || ty == SEG_META_APPEND || ty == SEG_SEGNB) openAhead(so, SEGH + bl + SEGE);
      ao = so + SEGH + bl + SEGE; }
    // segments: contiguous from body_off to the INDEX, in order
    const uint8_t *segNb = nullptr;  // SEGNB's counts, when the file has one
    uint64_t o = FHDR, nLodSig = 0; std::vector<uint64_t> claimBefore(ns + 1, 0); std::vector<uint8_t> anyBefore(ns + 1, 0); std::vector<uint32_t> sigsAt(ns + 1, 0); uint64_t mc = 0; bool any = false, lod = false;
    for (uint32_t k = 0; k < ns; k++) {
      const uint8_t *q = sx + (uint64_t)SEGX * k; SegInfo s;
      s.off = ld64(q); s.type = ld16(q + 8); s.flags = ld16(q + 10); s.seq = ld32(q + 12); s.bodyLen = ld64(q + 16); s.tCut = ld64(q + 24); s.xxh = ld64(q + 32);
      if (s.off != o || s.seq != k || (s.bodyLen & 7) || s.bodyLen > io - o || io - o - s.bodyLen < SEGH + SEGE) return fail(err, "INDEX segment list not contiguous");
      if (k == 0 ? s.type != SEG_META : (s.type == SEG_META || s.type == SEG_INDEX)) return fail(err, "INDEX segment types out of order");
      std::string u = unsupportedType(s.type, s.flags); if (!u.empty()) { fatal_ = "segment " + std::to_string(k) + ": " + u; return fail(err, fatal_); }
      if (s.type == SEG_LOD) lod = true; else if (lod && (s.type == SEG_DATA || s.type == SEG_META_APPEND)) return fail(err, "DATA after LOD");
      if (knownType(s.type) && s.type != SEG_DATA && s.tCut != NONE64) return fail(err, "time cut on a segment that is not DATA");
      // The INDEX is covered by its own checksum and every block by its xxh64, so open does not check the other
      // segments' framing; verify() does. META is parsed; DATA segments are not read.
      const uint8_t *h = m_ + s.off;
      if (s.type == SEG_META || s.type == SEG_META_APPEND || s.type == SEG_SEGNB) {  // the segments open reads: their SegHdr too
        std::string u2 = unsupportedType(s.type, ld32(h + 12)); if (!u2.empty()) { fatal_ = "segment " + std::to_string(k) + ": " + u2; return fail(err, fatal_); }
        if (!segHdrOk(s)) return fail(err, "segment " + std::to_string(k) + ": SegHdr differs from the INDEX");
      }
      if (s.type == SEG_META || s.type == SEG_META_APPEND) {
        if (xxh64(h, SEGH + s.bodyLen + 24) != s.xxh) return fail(err, "META checksum mismatch");
        if (!parseMetaBody(h + SEGH, s.bodyLen, s.type == SEG_META, dict_, err)) return false;
      }
      if (s.type == SEG_SEGNB) {  // last before the INDEX; n = n_segments, pad 0, its own count 0, zero padding
        if (k + 1 != ns) return fail(err, "SEGNB is not the last segment before the INDEX");
        if (xxh64(h, SEGH + s.bodyLen + 24) != s.xxh) return fail(err, "SEGNB checksum mismatch");
        const uint8_t *nb = h + SEGH; if (!segnbBody(nb, s.bodyLen, ns, err)) return false;
        segNb = nb + 8;
      }
      if (s.type == SEG_LOD) {  // only the LodSig count is used (SigX.lod must name one); the frames are not read
        const uint8_t *lb = h + SEGH; uint64_t fl = s.bodyLen >= 16 ? ld64(lb + s.bodyLen - 8) : 0;
        if (fl < 16 || fl > s.bodyLen) return fail(err, "bad LOD footer length");
        uint32_t nl = ld32(lb + s.bodyLen - fl); if (8 + (uint64_t)32 * nl > fl - 8) return fail(err, "bad LOD signal count");
        if (nLodSig + nl > NONE32) return fail(err, "too many LodSigs");
        lodSegs_.push_back(LodSeg{k, (uint32_t)nLodSig, nl}); nLodSig += nl;
      }
      claimBefore[k] = mc; anyBefore[k] = any; sigsAt[k] = (uint32_t)dict_.sigs.size();
      if (s.type == SEG_DATA && s.tCut != NONE64) { if (hdr_.writer == WRITER_CONVERTER || (any && s.tCut < mc)) return fail(err, "bad time cut"); mc = s.tCut; any = true; }
      segs_.push_back(s); o = s.off + SEGH + s.bodyLen + SEGE;
    }
    if (o != io) return fail(err, "INDEX segment list doesn't end at the INDEX");
    // Per-segment block counts (SEGNB): they add up to n_blocks (0 for segments other than DATA), and the
    // BlkX entries name distinct footer entries, each (seg, entry) with entry < SegNb[seg]. So each footer entry is
    // named by exactly one BlkX: the INDEX leaves no footer block out. O(blocks) over the INDEX bytes the checksum
    // read, and n_blocks bits held during open. Each footer must hold SegNb[seg] entries when it is checked
    // (footerPacked).
    // A file without SEGNB (written before it) gets no open check: a block the INDEX leaves out is found by the
    // footer checks before a read that could miss it (gapChecked; the signal then fails, footBad_; past a signal's
    // last block in strict mode only), and by verify().
    if (segNb) {
      std::vector<uint64_t> first(ns + 1, 0);
      for (uint32_t k = 0; k < ns; k++) { uint32_t c = ld32(segNb + 4ull * k);
        if (c && segs_[k].type != SEG_DATA) return fail(err, "segment " + std::to_string(k) + ": a SEGNB block count on a segment that is not DATA");
        first[k + 1] = first[k] + c; }
      if (first[ns] != nbl) return fail(err, "the SEGNB block counts add up to " + std::to_string(first[ns]) + ", not n_blocks (" + std::to_string(nbl) + ")");
      std::vector<uint64_t> seen((nbl + 63) / 64, 0);
      for (uint64_t k = 0; k < nbl; k++) {
        const uint8_t *e = bx + (uint64_t)BLKX * k; uint32_t sg = ld32(e + 56), en = ld32(e + 60);
        if (sg >= ns || en >= first[sg + 1] - first[sg]) return fail(err, "a BlkX names an entry past its segment's SEGNB count");
        uint64_t bit = first[sg] + en; if (seen[bit >> 6] >> (bit & 63) & 1) return fail(err, "segment " + std::to_string(sg) + " footer entry " + std::to_string(en) + " is named twice in the INDEX");
        seen[bit >> 6] |= 1ull << (bit & 63);
      }
    }
    if (nsig != dict_.sigs.size()) return fail(err, "INDEX signal count differs from the dictionary");
    // SigX: O(signals) here; each signal's BlkX range is checked on first use (checkSignal)
    uint64_t expectFirst = 0;
    for (uint32_t i = 0; i < nsig; i++) {
      const uint8_t *q = gx + (uint64_t)SIGX * i; SigSum g = sigAt(gx, i);
      uint64_t first = ld64(q + 40); uint32_t nb = ld32(q + 48);
      if (q[53] || ld16(q + 54) || ld64(q + 64) || ld64(q + 72) || g.codec > 1 || (g.lod != NONE32 && g.lod >= nLodSig)) return fail(err, "bad signal index entry");
      if (g.codec == 1) { if (nb || first || g.ref >= nsig || g.ref == i || g.lod != NONE32) return fail(err, "bad REF entry"); continue; }
      if (g.ref != NONE32 || first != expectFirst || nb > nbl - first) return fail(err, "signal index block range wrong");
      if (g.nNorm > g.n || (!nb && (g.n || g.t0 || g.tLast || g.hash != HASH_INIT))) return fail(err, "signal " + std::to_string(i) + ": summary differs from its blocks");
      expectFirst += nb;
    }
    if (expectFirst != nbl) return fail(err, "INDEX has blocks no signal owns");
    for (uint32_t i = 0; i < nsig; i++) if (gx[(uint64_t)SIGX * i + 52] == 1) {
      const SigSum g = sigAt(gx, i), r = sigAt(gx, g.ref); const SigSpec &a = dict_.sigs[i].spec, &bsp = dict_.sigs[g.ref].spec;
      if (r.codec != 0 || a.vtype != bsp.vtype || a.bits != bsp.bits || a.fourState != bsp.fourState || a.keyRows != bsp.keyRows || g.n != r.n || g.nNorm != r.nNorm || g.t0 != r.t0 || g.tLast != r.tLast || g.hash != r.hash)
        return fail(err, "REF signal " + std::to_string(i) + " differs from its target");
    }
    uint32_t kind = 0; uint64_t pt = 0;
    for (uint32_t k = 0; k < ndo; k++) { const uint8_t *q = dx + (uint64_t)DENT * k; DoffE d{ld64(q), ld32(q + 8)}; if (d.kind != kind || ld32(q + 12) || d.t < pt) return fail(err, "bad dump-off index"); doff_.push_back(d); kind = 1 - kind; pt = d.t; }
    footOk_.assign(ns); footBad_.assign(nsig); tailOk_.assign(nsig); gapOk_.assign(nbl); lodOk_.assign(lodSegs_.size()); sigOk_.assign(nsig); gx_ = gx; lodGx_ = gx; bx_ = bx; segNb_ = segNb; nbl_ = nbl; claimBefore_ = std::move(claimBefore); anyBefore_ = std::move(anyBefore); sigsAt_ = std::move(sigsAt);
    complete_ = true; metaSeen_ = true; indexSeen_ = true; indexOff_ = io; nextOff_ = n_; nextSeq_ = nseg;
    return true;
  }
};

}  // namespace wcz
