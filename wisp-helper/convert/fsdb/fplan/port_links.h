// SPDX-License-Identifier: MIT
// port_links.h: FSDB port-copy links from the file alone, fail closed.
// Port copies are declared ids with no value index. The writer keeps how each one is driven in two places:
//   section+0xf0 : two-stage lz0 tables. t0: port-copy id -> (x, val); t1: stored-owner id -> (x, val).
//   header 0x538 : magic "!Ce\x87", version string, 3 zlib streams. z1+z2 hold the derivation records
//                  <dst val> <op> <args...> in the same (x=0) val space, the op descriptor table and the bcid text.
// Layout notes: the 0x538 derivation-record layout. Only the x=0 IDENTITY form is emitted: a whole-value path of
// 1-arg ops whose descriptor code is exactly c0 or 95c0, ending at exactly one stored owner. Everything else stays refused.
// Any structural surprise (unknown version, bounds, decode size, leftover bytes, unknown op, record count != header)
// means NO links for the whole file plus a reason; the converter then refuses the port copies as before.
#pragma once
#include "fsdb_codecs.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>
#include <zlib.h>

namespace portlinks {

struct TRec { uint64_t k; uint32_t x; uint64_t v; };
struct Op { uint32_t nargs; std::string code; };  // code: raw descriptor bytes
struct Result {
  std::unordered_map<uint64_t, uint64_t> link;     // port-copy id -> stored-owner id (x=0 IDENTITY only)
  std::string why;                                  // empty = decoded; else the reason no link was emitted
  bool present = false;                             // file has the 0xf0 / 0x538 structures at all
  std::string vkey;                                 // 0x538 version key (the writer's version text), reported as a structural feature
  uint64_t t0 = 0, t1 = 0, nrec = 0, nT = 0, nB = 0;
  uint64_t identity = 0, held_unproven = 0, refused_multi = 0, refused_nopath = 0, x_nonzero = 0;
  // DIAGNOSTIC: one entry per port copy not linked at decode: {port-copy id, status, candidate owner id or 0}.
  // status: no_path | multi_owner | held_unproven | x_nonzero_refused. Read only by the planner's link dump.
  struct Refused { uint64_t pc; const char* status; uint64_t cand; };
  std::vector<Refused> refused;
};

inline uint64_t rd(const uint8_t* p, unsigned k) { uint64_t v = 0; for (unsigned i = k; i-- > 0;) v = (v << 8) | p[i]; return v; }

// one section+0xf0 chunk after stage 2: records <tag> <k> <x> <v>, tag 11xxxxxx with widths in bits 0-1 / 2-3 / 4-5.
inline bool parse_trecs(const fsdbraw::Bytes& b, std::vector<TRec>& out, std::string& why) {
  static const unsigned W[4] = {1, 2, 4, 8}; size_t i = 0;
  while (i < b.size()) {
    unsigned t = b[i];
    if ((t & 0xc0) != 0xc0 || (t >> 6) != 3) { why = "0xf0 table: bad record tag"; return false; }
    unsigned wa = W[t & 3], wb = W[(t >> 2) & 3], wc = W[(t >> 4) & 3];
    if (i + 1 + wa + wb + wc > b.size()) { why = "0xf0 table: record past chunk end"; return false; }
    out.push_back({rd(&b[i + 1], wa), uint32_t(rd(&b[i + 1 + wa], wb)), rd(&b[i + 1 + wa + wb], wc)}); i += 1 + wa + wb + wc;
  }
  return true;
}

inline bool f0_tables(const uint8_t* b, size_t n, uint64_t section, std::vector<TRec>& t0, std::vector<TRec>& t1, std::string& why) {
  uint64_t p = rd(b + section + 0xf0, 8);
  if (p == 0 || p >= n) { why = p ? "0xf0 pointer out of bounds" : "no 0xf0 table"; return false; }
  const uint8_t mark[4] = {0x21, 0x43, 0x65, 0x87};  // u32 0x87654321
  size_t end = n; for (size_t q = p; q + 4 <= n; q++) if (!memcmp(b + q, mark, 4)) { end = q; break; }
  if (end == n) { why = "0xf0 table: no end marker"; return false; }
  std::vector<std::vector<TRec>> chunks; size_t pos = p;
  while (pos + 4 < end && chunks.size() < 64) {
    bool found = false;
    for (size_t d = 0; d < 16 && !found; d++) {
      size_t q = pos + d; if (q + 4 > end) break;
      // any chunk n >= 1 that lz0 consumes exactly (13 and 28 B seen)
      uint64_t m = rd(b + q, 4); if (m < 2 || m - 1 > end - q - 4) continue; size_t ln = size_t(m - 1);
      try {
        auto s1 = fsdbraw::lz0(b + q + 4, ln, size_t(1) << 26); if (s1.consumed != ln) continue;
        auto s2 = fsdbraw::lz0(s1.bytes.data(), s1.bytes.size(), size_t(1) << 28);
        if (s2.consumed != s1.bytes.size()) { why = "0xf0 table: stage-2 leftover bytes"; return false; }
        std::vector<TRec> rr; if (!parse_trecs(s2.bytes, rr, why)) return false;
        chunks.push_back(std::move(rr)); pos = q + 4 + ln; found = true;
      } catch (const std::exception&) { continue; }
    }
    if (!found) break;
  }
  if (chunks.size() < 2) { why = "0xf0 table: expected 2 chunks, found " + std::to_string(chunks.size()); return false; }
  t0 = std::move(chunks[0]); t1 = std::move(chunks[1]); return true;
}

// next complete zlib stream starting at or after i (78 01 header); out = inflated bytes, i = first byte after it.
inline bool next_zlib(const uint8_t* b, size_t n, size_t& i, std::string& out) {
  for (size_t j = i; j + 2 <= n; j++) {
    if (b[j] != 0x78 || b[j + 1] != 0x01) continue;
    z_stream s{}; if (inflateInit(&s) != Z_OK) return false;
    s.next_in = const_cast<Bytef*>(b + j); s.avail_in = uInt(std::min<size_t>(n - j, size_t(1) << 30));
    std::string o; char buf[1 << 16]; int rc;
    do { s.next_out = (Bytef*)buf; s.avail_out = sizeof buf; rc = inflate(&s, Z_NO_FLUSH); o.append(buf, sizeof buf - s.avail_out);
    } while (rc == Z_OK && o.size() < (size_t(1) << 30));
    size_t used = s.total_in; inflateEnd(&s);
    if (rc == Z_STREAM_END) { out.swap(o); i = j + used; return true; }
  }
  return false;
}

inline std::string key_of(uint32_t x) {
  uint32_t t = x >> 30, v = x & 0x3fffffff;
  if ((v >> 28) == 1) return "B" + std::to_string(v & 0x0fffffff);
  static const char* TG[4] = {"P", "T", "Q", "C"}; return TG[t] + std::to_string(v);
}

inline Result decode(const uint8_t* b, size_t n, uint64_t section) {
  Result R; std::vector<TRec> T0, T1;
  if (n < 0x540) { R.why = "file too short"; return R; }
  uint64_t p538 = rd(b + 0x538, 8);
  if (!p538) { R.why = "no 0x538 derivation block (no port-copy links in this file)"; return R; }  // pointer 0 = empty result, not an error
  R.present = true;
  if (!f0_tables(b, n, section, T0, T1, R.why)) return R;
  R.t0 = T0.size(); R.t1 = T1.size();
  if (p538 + 8 > n || memcmp(b + p538, "!Ce\x87", 4)) { R.why = "0x538: bad magic or pointer"; return R; }
  uint64_t vl = rd(b + p538 + 4, 4); if (vl == 0 || vl > 256 || p538 + 8 + vl > n) { R.why = "0x538: bad version string"; return R; }
  std::string ver((const char*)b + p538 + 8, strnlen((const char*)b + p538 + 8, size_t(vl)));
  auto d2 = ver.find('-', 2); std::string vkey = ver.substr(0, d2);
  R.vkey = vkey;  // no version gate: the strict structure checks decide
  // z0 (paths/layout), then z1, z2, ... = one byte stream S: after z1, keep reading while the next u32
  // (the chunk's compressed size) is followed by 78 01 and that zlib stream ends exactly after the stated size.
  size_t i = size_t(p538 + 8 + vl); std::string z0, s;
  if (!next_zlib(b, n, i, z0)) { R.why = "0x538: zlib stream 0 missing or damaged"; return R; }
  { std::string c; if (!next_zlib(b, n, i, c)) { R.why = "0x538: zlib stream 1 missing or damaged"; return R; } s = c;
    while (i + 6 <= n && b[i + 4] == 0x78 && b[i + 5] == 0x01) {
      uint64_t csz = rd(b + i, 4); size_t j = i + 4, k = j;
      if (!next_zlib(b, n, k, c) || k - j != csz) break;  // not a framed continuation chunk: S ends here
      s += c; i = k; if (s.size() > (size_t(1) << 30)) { R.why = "0x538: S above 1 GiB"; return R; } } }
  size_t bc = s.find("bcid");
  if (bc == std::string::npos) bc = s.size();  // nB 0 = no bcid text; the descriptor search runs to the end of S
  std::string txt = s.substr(bc);
  // bcid arities: tokens = id + args (CALL_ARG_VAL 2..max) -> arity = max index (1 if none)
  std::map<uint32_t, uint32_t> barity; uint64_t nbt = 0;
  for (size_t q = 0; (q = txt.find("bcid ", q)) != std::string::npos; q += 5) {
    size_t a = q + 5; uint64_t id = 0, k2 = 0; size_t e = a; while (e < txt.size() && isdigit((unsigned char)txt[e])) id = id * 10 + (txt[e++] - '0');
    if (e == a || e >= txt.size() || txt[e] != ' ') continue; size_t f = ++e; while (e < txt.size() && isdigit((unsigned char)txt[e])) k2 = k2 * 10 + (txt[e++] - '0');
    if (e == f || e >= txt.size() || txt[e] != ' ') continue; nbt++;
    size_t nl = txt.find('\n', e); size_t ret = txt.find(" RET", e); if (ret == std::string::npos || (nl != std::string::npos && ret > nl)) continue;
    uint32_t mx = 0; std::string body = txt.substr(e, ret - e);
    for (size_t c = 0; (c = body.find("CALL_ARG_VAL,", c)) != std::string::npos; c += 13) { uint32_t v = 0; size_t g = c + 13; while (g < body.size() && isdigit((unsigned char)body[g])) v = v * 10 + (body[g++] - '0'); mx = std::max(mx, v); }
    barity[uint32_t(id)] = mx ? mx : 1;
  }
  const uint8_t* S = (const uint8_t*)s.data();
  // descriptor table: Q<nT> u32 nB, then nT entries {00 u16 nargs u16 len code | c0 u32 nargs u32 len code}
  auto table = [&](size_t o, uint64_t cnt, std::vector<Op>& out, size_t lim) -> size_t {
    size_t q = o;
    for (uint64_t k = 0; k < cnt; k++) {
      if (q >= lim) return 0; uint32_t na, cl; size_t h;
      if (S[q] == 0) { if (q + 5 > lim) return 0; na = uint32_t(rd(S + q + 1, 2)); cl = uint32_t(rd(S + q + 3, 2)); h = 5; }
      else if (S[q] == 0xc0) { if (q + 9 > lim) return 0; na = uint32_t(rd(S + q + 1, 4)); cl = uint32_t(rd(S + q + 5, 4)); h = 9; }
      else return 0;
      if (q + h + cl > s.size()) return 0;
      out.push_back({na, std::string((const char*)S + q + h, cl)}); q += h + cl;
    }
    return q;
  };
  // nB need not equal the text's bcid count (veer 2742 vs 2733). A candidate Q<nT> u32 nB is accepted only if all nT
  // T entries AND all nB B entries parse; candidates with nB == the text count are tried first.
  std::vector<Op> T; size_t desc = std::string::npos;
  for (int pass = 0; pass < 2 && desc == std::string::npos; pass++)
    for (size_t o = 0; o + 8 < bc; o++) {
      if (S[o + 3] != 0x80) continue;
      uint64_t nB = rd(S + o + 4, 4), nT = rd(S + o, 4) & 0x3fffffff;
      if (!(nT > 0 && nT < 1000000) || nB > 10000000 || (pass == 0) != (nB == nbt)) continue;
      std::vector<Op> t; size_t te = table(o + 8, nT, t, bc); if (!te || t.size() != nT) continue;
      std::vector<Op> bb; if (nB && (!table(te, nB, bb, s.size()) || bb.size() != nB)) continue;
      T = std::move(t); desc = o; R.nT = nT; R.nB = nB; break;
    }
  if (desc == std::string::npos) { R.why = "0x538: op descriptor table not found"; return R; }
  // val space bound + op classes
  // val-range rule: S starts u32 NV, u32 K, declared before the record stream; every plain val
  // token is < NV + K (dsts < NV; NV..NV+K-1 only as args). No margin; STRICT count == header + exact end stays the gate.
  if (s.size() < 8) { R.why = "0x538: S shorter than its NV/K header"; return R; }
  const uint64_t NV = rd(S, 4), K = rd(S + 4, 4);
  const uint64_t VM = NV + K, OPMAX = T.size();  // a plain token is an op iff n < nT (no fixed cap)
  auto plain = [&](uint32_t x) { return x < VM; };
  auto isop = [&](uint32_t x) { uint32_t t = x >> 30, v = x & 0x3fffffff; return t > 0 || (v >> 28) == 1 || v < OPMAX; };
  auto arity = [&](uint32_t op, int& a) -> bool {  // STRICT: arity only from the file (Q<n> = 1 grammar rule)
    uint32_t t = op >> 30, v = op & 0x3fffffff;
    if ((v >> 28) == 1) { auto it = barity.find(v & 0x0fffffff); if (it == barity.end()) return false; a = int(it->second); return true; }
    if (t == 2) { a = 1; return true; }
    if (t == 0 || t == 1) { if (v >= T.size()) return false; a = int(T[v].nargs); if (t == 0 && a == 0) return false; return true; }
    return false;
  };
  struct Rec { uint32_t d; uint32_t op; std::vector<uint32_t> a; };
  std::vector<Rec> recs; bool ok = false; size_t al_used = 0, k_used = 0;
  for (size_t al = 0; al < 4 && !ok; al++) {
    size_t nw = (bc > al ? (bc - al) / 4 : 0); auto w = [&](size_t k) { return uint32_t(rd(S + al + 4 * k, 4)); };
    for (size_t k = 0; k + 8 < nw && !ok; k++) {
      uint32_t h = w(k);
      if (!(h > 0 && h < 4 * VM && plain(w(k + 1)) && isop(w(k + 2)) && (w(k + 2) >> 30) <= 2)) continue;
      std::vector<Rec> rr; size_t q = k + 1;
      while (q + 1 < nw) {
        uint32_t d = w(q), op = w(q + 1); int a = 0;
        if (!plain(d) || !isop(op) || !arity(op, a)) break;
        if (q + 2 + a > nw) break;
        uint32_t v = op & 0x3fffffff; const bool bcop = (v >> 28) == 1;
        // a bcid record repeats its id first; the repeat may carry a tag (veer B2685 T2685), so compare its low 30 bits
        bool good = true; for (int j = (bcop ? 1 : 0); j < a; j++) if (!plain(w(q + 2 + j))) { good = false; break; }
        if (good && bcop && !(a >= 1 && (w(q + 2) & 0x3fffffff) == (v & 0x0fffffff))) good = false;
        if (!good) break;
        Rec r{d, op, {}}; for (int j = 0; j < a; j++) r.a.push_back(w(q + 2 + j));
        rr.push_back(std::move(r)); q += 2 + a; if (rr.size() > h) break;
      }
      if (rr.size() == h && al + 4 * q == desc) { recs = std::move(rr); ok = true; al_used = al; k_used = q; }  // count == header AND ends at the descriptor table
    }
  }
  if (!ok) { R.why = "0x538: STRICT record parse found no stream whose record count equals its header"; return R; }
  if (al_used + 4 * k_used != desc) { R.why = "0x538: record stream does not end at the descriptor table"; return R; }
  R.nrec = recs.size();
  // edges: whole-value 1-arg records from single-piece dsts; IDENTITY = code exactly c0 or 95c0 (accepted only
  // under the planner's own-stream guard); Q1 held (unproven)
  std::unordered_map<uint32_t, uint32_t> dcount; for (auto& r : recs) dcount[r.d]++;
  struct Edge { uint32_t to; bool identity; };
  std::unordered_map<uint32_t, std::vector<Edge>> E;
  for (auto& r : recs) {
    if (r.a.size() != 1 || dcount[r.d] > 1) continue;
    uint32_t t = r.op >> 30, v = r.op & 0x3fffffff; bool bc_ = (v >> 28) == 1;
    std::string code = (!bc_ && (t == 0 || t == 1) && v < T.size()) ? T[v].code : std::string();
    if (code == std::string("\xc0", 1) || code == std::string("\x95\xc0", 2)) E[r.d].push_back({r.a[0], true});
    else if (!bc_ && t == 2 && v == 1) E[r.d].push_back({r.a[0], false});
  }
  std::unordered_map<uint64_t, std::set<uint64_t>> v2own; for (auto& t : T1) if (t.x == 0) v2own[t.v].insert(t.k);
  std::map<uint64_t, std::set<uint64_t>> d0; for (auto& t : T0) { if (t.x == 0) d0[t.k].insert(t.v); else { R.x_nonzero++; R.refused.push_back({t.k, "x_nonzero_refused", t.v}); } }
  for (auto& pc : d0) {
    std::set<uint64_t> owners; bool all_id = true;
    for (uint64_t v0 : pc.second) {
      std::set<uint64_t> seen{v0}; std::vector<std::pair<uint64_t, bool>> st{{v0, true}};
      while (!st.empty()) {
        auto [u, cls] = st.back(); st.pop_back();
        auto it = E.find(uint32_t(u)); if (it == E.end()) continue;
        for (auto& e : it->second) {
          if (seen.count(e.to)) continue; seen.insert(e.to); bool c2 = cls && e.identity;
          auto o = v2own.find(e.to);
          if (o != v2own.end()) { owners.insert(o->second.begin(), o->second.end()); if (!c2) all_id = false; }
          else st.push_back({e.to, c2});
        }
      }
    }
    if (owners.size() != 1) { (owners.empty() ? R.refused_nopath : R.refused_multi)++;
      R.refused.push_back({pc.first, owners.empty() ? "no_path" : "multi_owner", owners.empty() ? 0 : *owners.begin()}); continue; }
    if (!all_id) { R.held_unproven++; R.refused.push_back({pc.first, "held_unproven", *owners.begin()}); continue; }
    R.link[pc.first] = *owners.begin(); R.identity++;
  }
  return R;
}

}  // namespace portlinks
