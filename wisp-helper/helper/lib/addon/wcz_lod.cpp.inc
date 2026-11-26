// SPDX-License-Identifier: MIT
// ---- WCZ1 LOD segments (SPEC §II.7): stored overview levels, read for coarse windows ----
//
// lodWindow(ids[], t0, t1, buckets[, gaps]) -> [{signalId, lod: true, level, width, count (an estimate), flags: Buffer} |
//   {signalId, lodError} | {signalId} (no LOD answer: not a bit row, no stored LOD, the window is finer than
//   level 0, or the window may hold <= 2 x buckets changes, which the exact path answers exactly: LOD answers only
//   when the changes of the LOD buckets wholly inside the window, each counted once, are over 2 x buckets)]
// gaps: optional [a, b) time ranges (capture gaps: the points whose changes the viewer never saw). An LOD bucket that
//   meets one is left out of that count, and its parts in every output bucket are counted from the normalised rows
//   outside the gaps (never bit 6), so a bucket that only partly overlaps a gap doesn't count the gap's changes.
// flags: one byte per output bucket:
//   bits 0-1  min(changes, 2) of the LOD buckets that overlap it (an LOD bucket that straddles an edge counts in both)
//   bit 2     any x/z
//   bit 3     1-bit rows: the value-plane bit in effect at the bucket's end
//   bit 4     1-bit rows: bit 3 is approximate (the bucket ends inside an LOD bucket that holds a change, or no level
//             is known yet)
//   bit 5     1-bit rows: no change yet at the bucket's end (exact: no LOD bucket up to its end holds one; never
//             with bit 4)
//   bit 6     bits 0-2 include an LOD bucket that also spans a neighbouring output bucket (so they may count its
//             changes); without bit 6, bits 0-2 are exact. Never on the first or last output bucket: there the parts of
//             LOD buckets that cross an edge (the window's or the neighbour's) are counted from the normalised rows, so
//             the first and last buckets are exact. An LOD bucket is first clipped to the signal's first and last raw
//             change (a bucket with no change outside the window needs no rows).
// count: the sum of bits 0-1, an estimate (a straddling LOD bucket counts in both buckets; LOD counts the changes
// its writer counted), not a bound.
// Level: the coarsest whose bucket width is <= the window's (t1 - t0) / buckets. Blocks are read only for the parts of
// the first and last output buckets above and of the LOD buckets that meet a gap, less the gaps (srcFillRange): at
// most 4 + 5 x G fills per signal, G the gaps meeting the window (2 parts per edge bucket; 2 buckets per gap holding a
// gap end and rows outside it, each in at most 2 output buckets; 1 more per gap that splits a part).
// The stored LOD comes through the reader (wcz_seg.h SegReader::lodInfo / lodChunk / decodeLod): an LOD segment is
// checked whole before its first use (seg_xxh64, its LodSigs named by their signals' SigX.lod and in signal order,
// levels and chunks consecutive, entry counts, frames back to back, zero padding before the footer), and each chunk
// on decode (xxh64, strict payload, flags its signal's type allows: x/z only on four-state bit vectors, the value
// after only on 1-bit ones, buckets inside the signal's changes and before the next chunk's). Complete files only (a
// scanned file has no LOD). A signal whose LOD fails answers lodError once checked; the caller then uses the exact
// path.
namespace wczlod {
// a signal's levels (from lodInfo) and, per level, its chunks' first buckets (from lodChunk, on the level's first use)
struct Sig { int state = 0; uint64_t base = 0; std::vector<uint32_t> nch; std::vector<std::vector<uint64_t>> b0; std::string err; };
static uint64_t g_nsig = 0;  // signals with stored LOD (SigX.lod set)
static std::unordered_map<uint32_t, Sig> g_sig;
static std::vector<uint8_t> g_buf;
static std::vector<wcz::LodBucket> g_bk;
static uint64_t g_windows = 0, g_chunks = 0, g_entries = 0, g_errors = 0, g_edgeReads = 0;

static void reset() { g_nsig = 0; g_sig.clear(); std::vector<uint8_t>().swap(g_buf); std::vector<wcz::LodBucket>().swap(g_bk); }

// After a complete file's open: the signals with stored LOD (O(signals); no LOD byte is read).
static void init() {
  using namespace wczsrc;
  reset();
  if (!g_f.open || !g_f.rd.complete()) return;
  for (uint32_t i = 0; i < g_f.rd.nSignals(); i++) if (g_f.rd.dataOf(i) == i && g_f.rd.sum(i).lod != wcz::NONE32) g_nsig++;
}

static bool bad(Sig &s, const std::string &e) { s.state = 2; s.err = "LOD: " + e; g_errors++; return false; }
// Data signal i's stored LOD (nullptr with an empty err: none), checked once.
static Sig *sigFor(uint32_t i, std::string &err) {
  using namespace wczsrc;
  if (g_f.rd.sum(i).lod == wcz::NONE32) return nullptr;
  Sig &s = g_sig[i];
  if (s.state == 1) return &s;
  if (s.state == 2) { err = s.err; return nullptr; }
  if (s.state == 3) return nullptr;
  wcz::LodInfo li; std::string e;
  if (!g_f.rd.lodInfo(i, li, e)) { bad(s, e); err = s.err; return nullptr; }
  if (!li.nlev) { s.state = 3; return nullptr; }  // (not complete: no LOD)
  s.base = li.lodBase;
  for (const auto &l : li.levels) s.nch.push_back(l.nchunk);
  s.b0.assign(li.nlev, {});
  s.state = 1;
  return &s;
}
// Level l's chunk first buckets, read once.
static bool levelB0(Sig &s, uint32_t i, uint32_t l, std::string &err) {
  if (!s.b0[l].empty()) return true;
  std::vector<uint64_t> v(s.nch[l]);
  for (uint32_t c = 0; c < s.nch[l]; c++) { wcz::LodChunk k; std::string e; if (!wczsrc::g_f.rd.lodChunk(i, l, c, k, e)) { bad(s, e); err = s.err; return false; } v[c] = k.b0; }
  s.b0[l] = std::move(v);
  return true;
}

struct Ent { uint64_t b; uint8_t f; };  // f as stored: bits 0-1 min(changes, 2), bit 2 any x/z, bit 3 the value after
// Chunk c of level l, decoded and checked by the reader.
static bool chunk(Sig &s, uint32_t i, uint32_t l, uint32_t c, std::vector<Ent> &out, std::string &err) {
  using namespace wczsrc;
  out.clear();
  if (!ensureCtx(err)) return false;
  std::string e;
  if (!g_f.rd.decodeLod(g_zd, i, l, c, g_bk, g_buf, e)) { bad(s, e); err = s.err; return false; }
  out.reserve(g_bk.size());
  for (const wcz::LodBucket &x : g_bk) out.push_back({x.bucket, (uint8_t)(x.cnt | ((x.flags & 1) << 2) | ((x.flags & 2) << 2))});
  g_chunks++; g_entries += g_bk.size();
  return true;
}

using u128 = unsigned __int128;
// The LOD answer for data signal i over [t0, t1) in nb buckets; false + empty err = no LOD answer here.
// gaps: sorted, disjoint [a, b) ranges whose LOD buckets the gate leaves out.
// Normalised changes of signal id in [r0, r1) (srcFillRange: the value before r0 first, so they are the stream's):
// their count (up to 2) and whether one holds x/z, added to cnt / xz.
static bool exactPart(int64_t id, uint64_t r0, uint64_t r1, uint8_t &cnt, uint8_t &xz, std::string &err) {
  if (r1 <= r0) return true;
  SigStore *st = srcFillRange(id, r0, r1 - 1, err);
  if (!st) { if (err.empty()) err = "LOD: edge rows unreadable"; return false; }
  const uint32_t w = st->stride;
  for (size_t k = 0; k < st->times.size(); k++) {
    if (st->times[k] < r0 || st->times[k] >= r1) continue;
    cnt = (uint8_t)std::min(2, cnt + 1);
    if (!st->xz.empty()) for (uint32_t j = 0; j < w; j++) if (st->xz[k * w + j]) { xz = 1; break; }
  }
  srcDelete(st);
  g_edgeReads++;
  return true;
}
static bool window(int64_t id, uint32_t i, uint64_t t0, uint64_t t1, uint32_t nb, bool oneBit, uint32_t &level, uint64_t &width,
                   uint64_t &count, std::vector<uint8_t> &flags, std::string &err,
                   const std::vector<std::pair<uint64_t, uint64_t>> &gaps) {
  Sig *s = sigFor(i, err);
  if (!s) return false;
  const uint64_t span = t1 - t0;
  if (s->base > span / nb) return false;  // finer than level 0
  uint32_t L = 0;
  while (L + 1 < s->nch.size() && (s->base << (2 * (L + 1))) <= span / nb) L++;
  const uint64_t w = s->base << (2 * L), B0 = t0 / w;
  if (!levelB0(*s, i, L, err)) return false;
  const std::vector<uint64_t> &cb = s->b0[L];
  // the last chunk with b0 <= B0 (or the first)
  uint32_t lo = 0, hi = (uint32_t)cb.size();
  while (hi - lo > 1) { const uint32_t m = (lo + hi) / 2; if (cb[m] <= B0) lo = m; else hi = m; }
  int cur = -1;  // the value-plane bit in effect (-1: no change yet)
  std::vector<Ent> es;
  if (oneBit && lo > 0 && cb[lo] >= B0) {  // the carry into t0 is the previous chunk's last entry
    if (!chunk(*s, i, L, lo - 1, es, err)) return false;
    cur = (es.back().f >> 3) & 1;
  }
  std::vector<uint8_t> cnt(nb, 0), xz(nb, 0);
  std::vector<int8_t> endv(nb, -1);
  std::vector<uint8_t> approx(nb, 0), strad(nb, 0);
  const auto obOf = [&](uint64_t t) { return (uint32_t)std::min<u128>(nb - 1, (u128)(t - t0) * nb / span); };
  // output bucket o covers [colAt(o), colAt(o + 1)): the first t with obOf(t) == o
  const auto colAt = [&](uint32_t o) { return o >= nb ? t1 : t0 + (uint64_t)(((u128)o * span + nb - 1) / nb); };
  const u128 sT0 = wczsrc::g_f.rd.sum(i).t0, sT1 = (u128)wczsrc::g_f.rd.sum(i).tLast + 1;  // (the raw changes: [sT0, sT1))
  struct Part { uint32_t o; uint64_t r0, r1; };
  std::vector<Part> rowParts;  // output bucket o's parts counted from the rows: [r0, r1), outside every gap
  bool done = false;
  uint64_t low = 0;  // changes of the LOD buckets wholly inside the window and outside gaps, each counted once
  size_t gi = 0;     // the first gap that ends after the current LOD bucket starts
  for (uint32_t c = lo; c < cb.size() && !done; c++) {
    if (!chunk(*s, i, L, c, es, err)) return false;
    for (const Ent &x : es) {
      const u128 a = (u128)x.b * w, z = a + w;  // [a, z)
      if (a >= t1) { done = true; break; }
      const int v = (x.f >> 3) & 1;
      if (z <= t0) { cur = v; continue; }
      while (gi < gaps.size() && gaps[gi].second <= a) gi++;
      const bool inGap = gi < gaps.size() && (u128)gaps[gi].first < z;
      if (a >= t0 && z <= t1 && !inGap) low += x.f & 3;  // (an LOD bucket wholly inside the window, counted once)
      const u128 ca = std::max(a, sT0), cz = std::min(z, sT1);  // (its changes are in [ca, cz))
      if (cz <= t0) { cur = v; continue; }
      if (ca >= t1) continue;
      const uint64_t lo_t = (uint64_t)std::max<u128>(ca, t0), hi_t = (uint64_t)std::min<u128>(cz, t1) - 1;
      const uint32_t o0 = obOf(lo_t), o1 = obOf(hi_t);
      const bool edgeCross = ca < t0 || cz > t1;  // (it crosses the window's start or end)
      // gaps meeting its changes' span [lo_t, hi_t]: from gi on (sorted, disjoint; gaps before gi end at or before a)
      size_t gm = gi;
      while (gm < gaps.size() && gaps[gm].second <= lo_t) gm++;
      const bool meetsGap = gm < gaps.size() && gaps[gm].first <= hi_t;
      // [p, q) of output bucket o, less the gaps, appended to rowParts (merged with o's previous part when adjacent)
      const auto toRows = [&](uint32_t o, uint64_t p, uint64_t q) {
        for (size_t g = gm; p < q; g++) {
          const uint64_t z = g < gaps.size() && gaps[g].first < q ? std::max(p, gaps[g].first) : q;
          if (z > p) {
            if (!rowParts.empty() && rowParts.back().o == o && rowParts.back().r1 == p) rowParts.back().r1 = z;
            else rowParts.push_back({o, p, z});
          }
          if (z >= q) break;
          p = std::max(p, gaps[g].second);
        }
      };
      for (uint32_t o = o0; o <= o1; o++) {
        const int e = o == 0 ? 0 : o == nb - 1 ? 1 : -1;
        if (meetsGap || (e >= 0 && (o0 < o1 || edgeCross))) {  // from the rows: a gap's bucket, or a part in the first or last output bucket
          toRows(o, std::max<uint64_t>(lo_t, colAt(o)), std::min<uint64_t>(hi_t + 1, colAt(o + 1)));
        } else {
          cnt[o] = (uint8_t)std::min(2, cnt[o] + (x.f & 3));
          if (x.f & 4) xz[o] = 1;
          if (o0 < o1) strad[o] = 1;
        }
        if (o < o1) approx[o] = 1;
      }
      if (cz <= t1) { endv[o1] = (int8_t)v; approx[o1] = 0; }  // the value after its last change holds to o1's end (until a later entry)
      else approx[o1] = 1;
    }
  }
  // the exact path answers a window of <= 2 x buckets changes exactly: LOD only when it holds more for sure
  if (low <= 2ull * nb) return false;
  for (const Part &r : rowParts) if (!exactPart(id, r.r0, r.r1, cnt[r.o], xz[r.o], err)) return false;
  flags.assign(nb, 0);
  count = 0;
  bool seen = cur >= 0;
  for (uint32_t o = 0; o < nb; o++) {
    uint8_t f = cnt[o] | (xz[o] ? 4 : 0) | (strad[o] ? 64 : 0);
    count += cnt[o];
    if (oneBit) {
      if (endv[o] >= 0) cur = endv[o];
      if (cnt[o]) seen = true;  // (a stored change at or before this bucket's end, though maybe not its level)
      if (cur < 0 && !seen) f |= 32;  // no change yet: exact (no LOD bucket up to here holds one)
      else { if (cur >= 0) f |= (uint8_t)(cur << 3); if (approx[o] || cur < 0) f |= 16; }
    }
    flags[o] = f;
  }
  level = L; width = w;
  g_windows++;
  return true;
}
}  // namespace wczlod

static Napi::Value wczLodWindow(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 4) || !wargs::arr(env, info[0])) return env.Undefined();
  const std::vector<int64_t> ids = argIds(info[0]);
  const double d0 = info[1].ToNumber().DoubleValue(), d1 = info[2].ToNumber().DoubleValue(), db = info[3].ToNumber().DoubleValue();
  Napi::Array out = Napi::Array::New(env);
  const bool okRange = d0 >= 0 && d1 > d0 && db >= 1 && d1 <= 9007199254740991.0 && db <= (double)(1u << 24);
  const uint64_t t0 = okRange ? (uint64_t)d0 : 0, t1 = okRange ? (uint64_t)d1 : 0;
  const uint32_t nb = okRange ? (uint32_t)db : 1;
  // gaps (optional): [a, b) pairs, sorted and merged here; anything malformed means no LOD answer at all
  std::vector<std::pair<uint64_t, uint64_t>> gaps;
  bool okGaps = true;
  if (info.Length() > 4 && !info[4].IsUndefined() && !info[4].IsNull()) {
    if (!info[4].IsArray()) okGaps = false;
    else {
      Napi::Array ga = info[4].As<Napi::Array>();
      for (uint32_t k = 0; k < ga.Length() && okGaps; k++) {
        Napi::Value e = ga.Get(k);
        if (!e.IsArray() || e.As<Napi::Array>().Length() != 2) { okGaps = false; break; }
        const double a = e.As<Napi::Array>().Get(0u).ToNumber().DoubleValue(), b = e.As<Napi::Array>().Get(1u).ToNumber().DoubleValue();
        if (!(a >= 0 && b >= a && b <= 9007199254740991.0)) { okGaps = false; break; }
        if (b > a) gaps.emplace_back((uint64_t)a, (uint64_t)b);
      }
      std::sort(gaps.begin(), gaps.end());
      size_t m = 0;
      for (size_t k = 0; k < gaps.size(); k++) {
        if (m && gaps[k].first <= gaps[m - 1].second) gaps[m - 1].second = std::max(gaps[m - 1].second, gaps[k].second);
        else gaps[m++] = gaps[k];
      }
      gaps.resize(m);
    }
  }
  for (uint32_t k = 0; k < ids.size(); k++) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("signalId", Napi::Number::New(env, (double)ids[k]));
    out.Set(k, o);
    uint32_t i;
    std::string err;
    if (!okRange || !okGaps || !sigOf(ids[k], i, err)) continue;
    const uint32_t di = g_f.rd.dataOf(i);
    const wcz::SigSpec &sp = g_f.rd.dict().sigs[di].spec;
    if (sp.vtype != wcz::VT_BITS || g_f.rd.sum(i).nNorm <= 2ull * nb) continue;
    uint32_t level = 0; uint64_t width = 0, count = 0;
    std::vector<uint8_t> flags;
    if (!wczlod::window(ids[k], di, t0, t1, nb, sp.bits == 1, level, width, count, flags, err, gaps)) {
      if (!err.empty()) o.Set("lodError", Napi::String::New(env, err));
      continue;
    }
    o.Set("lod", Napi::Boolean::New(env, true));
    o.Set("level", Napi::Number::New(env, level));
    o.Set("width", Napi::Number::New(env, (double)width));
    o.Set("count", Napi::Number::New(env, (double)count));
    o.Set("flags", Napi::Buffer<uint8_t>::Copy(env, flags.data(), flags.size()));
  }
  return out;
}
static Napi::Object lodInfo(Napi::Env env) {
  Napi::Object l = Napi::Object::New(env);
  l.Set("signals", Napi::Number::New(env, (double)wczlod::g_nsig));
  l.Set("windows", Napi::Number::New(env, (double)wczlod::g_windows));
  l.Set("chunks", Napi::Number::New(env, (double)wczlod::g_chunks));
  l.Set("entries", Napi::Number::New(env, (double)wczlod::g_entries));
  l.Set("errors", Napi::Number::New(env, (double)wczlod::g_errors));
  l.Set("edgeReads", Napi::Number::New(env, (double)wczlod::g_edgeReads));
  return l;
}
