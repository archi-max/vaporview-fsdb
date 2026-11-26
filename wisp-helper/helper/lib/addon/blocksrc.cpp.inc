// SPDX-License-Identifier: MIT
// ---- a block source ----
//
// A source that keeps each signal's raw changes in time-ordered blocks (a WCZ1 container, the
// `mem` test source) gets its load and cold-read exports from here, answered with the
// store's own code (store.cpp.inc, included before this file):
//   cacheLoad        a whole fill: every block, normalized as a walk is (normalizeStore)
//   cacheWindowCold  bit rows: a streaming walk of [t0, t1] (BitWindow: no store fill; the blocks it
//                    decodes still go to the block LRU; its answer is bounded by the signal cap); strings and
//                    reals: a ranged fill of [t0, t1] into a scratch store, then windowOf
//   coldValueAt      a ranged fill of [t, t]: the block holding t, read only up to t
//   coldValueNear    a ranged fill of [t - span, t]
//   searchScan       a ranged fill of [t, bound] (or [bound, t]), then the store's search / edge
//   sourceCount      each signal's normalized change count from the source, without a fill
//
// A ranged fill [t0, t1] holds the last raw change before t0 (the value in effect there, from the
// last block that starts before t0) and every raw change in [t0, t1], normalized: that gives the
// same normalized changes in [t0, t1], the same value at t0 and the same predecessor value as the
// whole signal's store, because the normalized value in effect at any time is its last raw change
// at or before it. Blocks past t1 are never read, and the block that holds t1 is read only up to
// t1 (srcRead's prefix read).
//
// The source (the including file) defines these, anywhere in the translation unit:
//   srcSig(id, sig, err)            the signal's kind, width, value length and normalized count
//   srcNblk(id), srcBlockT0(id, b)  its blocks and each one's first change time (non-decreasing;
//                                   a block may start at the previous block's last time)
//   srcBlockRows(id, b)             block b's raw row count (a search round's budget, by whole blocks)
//   srcRecordedAt(t)                false inside a capture gap (capture epochs: the value there is NOT_RECORDED)
//   srcRead(id, b, from, upto, rows, err)
//                                   block b's raw changes with time <= upto, in order; it may leave
//                                   out those before its last change < from (a keyframe source starts
//                                   at the chunk that holds it), never one at or after it
//                                   A point read may answer from a chunk that a whole read reports as corrupt
//                                   (bytes past the query are covered only by the chunk checksum).
// Row values (SrcRows): a bit vector is vlen bytes, the value plane (position p = bit p % 8 of
// byte p / 8, position 0 the MSB, as the store's planes) then, for 4-state signals, the x/z plane,
// pairs (v, x) 0 = (0, 0) 1 = (1, 0) x = (0, 1) z = (1, 1), bits past the width 0; a real is its
// 8 little-endian IEEE bytes; a string is its bytes (off: n + 1 offsets).

#if defined(__GLIBC__)
#include <malloc.h>
#elif defined(__APPLE__)
#include <malloc/malloc.h>
#endif
#include <mutex>
// ---- returning freed memory ----
// Scratch fills (ranged reads) and evicted stores free large vectors; the allocator keeps them
// (measured: 150-420 MB of "MALLOC_LARGE (empty)" in a WCZ worker). Once g_trimAfter bytes have been
// freed, they go back to the OS: malloc_trim(0) on glibc, malloc_zone_pressure_relief on macOS.
static size_t g_freedSinceTrim = 0, g_trimAfter = 64u << 20;
static uint64_t g_freedTotal = 0, g_trims = 0;
static bool g_streamWindow = true;  // WCB_STREAM_WINDOW=0: bit-row cold windows fill a scratch store as before
static void srcTrim() {
#if defined(__GLIBC__)
  malloc_trim(0);
#elif defined(__APPLE__)
  malloc_zone_pressure_relief(nullptr, 0);
#endif
  g_trims++; g_freedSinceTrim = 0;
}
static std::mutex g_freedMu;  // (srcFreed runs on the core's threads)
static void srcFreed(size_t n) {
  std::lock_guard<std::mutex> lk(g_freedMu);
  g_freedTotal += n; g_freedSinceTrim += n;
  if (g_freedSinceTrim >= g_trimAfter) srcTrim();
}
static void srcDelete(SigStore *s) { if (!s) return; const size_t n = s->bytes(); delete s; srcFreed(n); }

// nNorm: the source's (INDEX) normalized change count, checked against the stream on a whole read (a row that
// disagrees is refused as corrupt: it is the `total` the page's hybrid decision uses); kNormUnknown: not checked.
static const uint64_t kNormUnknown = UINT64_MAX;
// ---- large buffers straight from the OS ----
// Read-path buffers of kBigBytes or more (decode scratch, a block's raw rows, the block LRU's rows) are mmap'd and munmap'd, not
// malloc'd: macOS libmalloc and glibc keep large freed blocks resident (measured on macOS: ~270 MB retained
// after reads of a 64 MB chunk, even after malloc_zone_pressure_relief), so a worker's memory after a large read
// went back to the OS only on a recycle. Elements are default-initialized (no zero pass; every byte is written
// before it's read).
#include <sys/mman.h>
// The threshold: 64 KiB on macOS, whose malloc keeps freed small and medium blocks dirty (an idle worker's footprint
// after a burst and an idle release: 208-214 MB at 1 MiB, 110-111 MB at 64 KiB, same burst CPU, measured on small.wcz);
// 1 MiB elsewhere (glibc's malloc_trim gives them back, and per-buffer mmap costs page faults). WCB_BIG_KB overrides.
#if defined(__APPLE__)
static const size_t kBigDefault = (size_t)64 << 10;
#else
static const size_t kBigDefault = (size_t)1 << 20;
#endif
// WCB_BIG_KB: a plain decimal integer in 4..65536 (KB); anything else is the default, with one warning
static size_t bigBytesParse() {
  const char *v = getenv("WCB_BIG_KB");
  if (!v || !*v) return kBigDefault;
  uint64_t n = 0;
  const char *p = v;
  for (; *p >= '0' && *p <= '9' && n <= 65536; p++) n = n * 10 + (uint64_t)(*p - '0');
  if (*p || n < 4 || n > 65536) {
    fprintf(stderr, "wisp-helper: WCB_BIG_KB=\"%.32s\" is not an integer in 4..65536 (KB): using %zu KB\n", v, kBigDefault >> 10);
    return kBigDefault;
  }
  return (size_t)n << 10;  // (<= 64 MiB)
}
static size_t bigBytes() { static const size_t b = bigBytesParse(); return b; }
#define kBigBytes bigBytes()
template <class T> struct BigAlloc {
  using value_type = T;
  BigAlloc() = default;
  template <class U> BigAlloc(const BigAlloc<U> &) {}
  T *allocate(size_t n) {
    const size_t b = n * sizeof(T);
    if (b < kBigBytes) return static_cast<T *>(::operator new(b));
    static const bool failAll = getenv("WCB_TEST_MMAP_FAIL") != nullptr;  // (test hook: every mmap fails)
    void *p = failAll ? MAP_FAILED : mmap(nullptr, b, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (p == MAP_FAILED) throw std::bad_alloc();
    return static_cast<T *>(p);
  }
  void deallocate(T *p, size_t n) {
    const size_t b = n * sizeof(T);
    if (b < kBigBytes) ::operator delete(p); else munmap(p, b);
  }
  template <class U, class... A> void construct(U *p, A &&...a) { if (sizeof...(A)) ::new ((void *)p) U(std::forward<A>(a)...); else ::new ((void *)p) U; }
  template <class U> bool operator==(const BigAlloc<U> &) const { return true; }
  template <class U> bool operator!=(const BigAlloc<U> &) const { return false; }
};
template <class T> using BigVec = std::vector<T, BigAlloc<T>>;

struct SrcSig { uint8_t kind = kBits; uint32_t bits = 1, vlen = 1; bool fourState = false; uint64_t nNorm = 0, tLast = UINT64_MAX; };  // tLast: the last raw change's time (UINT64_MAX: unknown)
static std::string countError(uint64_t index, uint64_t stream) {
  return "corrupt file: the row's INDEX change count (" + std::to_string(index) + ") differs from its stream's (" + std::to_string(stream) + ")";
}
struct SrcRows {
  BigVec<uint64_t> t;
  BigVec<uint8_t> v;
  BigVec<uint64_t> off{0};
  void clear() { t.clear(); v.clear(); off.assign(1, 0); }
  size_t n() const { return t.size(); }
  const uint8_t *val(size_t i, uint32_t vlen) const { return vlen ? v.data() + i * vlen : v.data() + off[i]; }
  size_t len(size_t i, uint32_t vlen) const { return vlen ? vlen : (size_t)(off[i + 1] - off[i]); }
};
static bool srcSig(int64_t id, SrcSig &g, std::string &err);
static uint32_t srcNblk(int64_t id);
static bool srcStillOk(int64_t id, std::string &err);  // after a block loop: the signal did not fail meanwhile
static uint64_t srcBlockT0(int64_t id, uint32_t b);
static uint32_t srcBlockRows(int64_t id, uint32_t b);
static bool srcRead(int64_t id, uint32_t b, uint64_t from, uint64_t upto, SrcRows &out, std::string &err);
static bool srcRecordedAt(uint64_t t);
static Napi::Object notRecorded(Napi::Env env) { Napi::Object o = Napi::Object::New(env); o.Set("notRecorded", Napi::Boolean::New(env, true)); return o; }

// Raw rows into a new store, under the worker's signal cap (as walkSignal's).
struct StoreFill {
  SigStore *s = new SigStore();
  SrcSig g;
  std::unordered_map<std::string, uint32_t> intern;
  bool hasXz = false;
  explicit StoreFill(const SrcSig &sig) : g(sig) {
    s->kind = sig.kind;
    if (sig.kind == kBits) { s->bits = sig.bits; s->stride = (sig.bits + 7) / 8; }
    else if (sig.kind == kReal) { s->stride = 8; s->bits = 64; }
    else { s->stride = 4; s->bits = 32; }
  }
  ~StoreFill() { delete s; }
  bool over() const {
    if (!g_signalCap) return false;
    if (s->kind == kString) return s->times.size() * 12 + s->strBytes * 2 + intern.size() * 64 > g_signalCap;
    return s->times.size() * (8 + 2 * (size_t)s->stride) > g_signalCap;
  }
  bool add(const SrcRows &r, size_t i, std::string &err) {
    const uint32_t st = s->stride;
    s->times.push_back(r.t[i]);
    if (s->kind == kBits) {
      const uint8_t *p = r.val(i, g.vlen);
      s->val.insert(s->val.end(), p, p + st);
      if (g.fourState) {
        const uint8_t *x = p + st;
        bool any = false;
        for (uint32_t j = 0; j < st; j++) if (x[j]) { any = true; break; }
        if (any && !hasXz) { s->xz.assign((s->times.size() - 1) * st, 0); hasXz = true; }  // the first x/z backfills zeros
        if (hasXz) s->xz.insert(s->xz.end(), x, x + st);
      }
    } else if (s->kind == kReal) {
      const uint8_t *p = r.val(i, 8);
      s->val.insert(s->val.end(), p, p + 8);
    } else {
      const size_t len = r.len(i, 0);
      if (len > kMaxText) { err = "unsupported encoding (a string value over 1 MB)"; return false; }
      auto ins = intern.emplace(std::string((const char *)r.val(i, 0), len), (uint32_t)s->strs.size());
      if (ins.second) { s->strs.push_back(ins.first->first); s->strBytes += len + 1; }
      const uint32_t idx = ins.first->second;
      const uint8_t *q = (const uint8_t *)&idx;
      s->val.insert(s->val.end(), q, q + 4);
    }
    if (over()) { err = capError(g_signalCap); return false; }
    return true;
  }
  SigStore *finish() {
    normalizeStore(s, s->kind == kBits);  // all x before the first change (text: no value equals it)
    s->times.shrink_to_fit();
    s->val.shrink_to_fit();
    s->xz.shrink_to_fit();
    s->strs.shrink_to_fit();
    storeTextStats(s);
    SigStore *out = s;
    s = nullptr;
    return out;
  }
};

static SigStore *srcFillWhole(int64_t id, std::string &err) {
  SrcSig g;
  if (!srcSig(id, g, err)) return nullptr;
  StoreFill f(g);
  SrcRows r;
  const uint32_t nb = srcNblk(id);
  for (uint32_t b = 0; b < nb; b++) {
    if (!srcRead(id, b, 0, UINT64_MAX, r, err)) return nullptr;
    for (size_t i = 0; i < r.n(); i++) if (!f.add(r, i, err)) return nullptr;
    if (bgStop()) { err = "yielded"; return nullptr; }
  }
  if (!srcStillOk(id, err)) return nullptr;
  SigStore *out = f.finish();
  if (g.nNorm != kNormUnknown && out->times.size() != g.nNorm) { err = countError(g.nNorm, out->times.size()); srcDelete(out); return nullptr; }
  return out;
}

// The blocks a ranged fill [t0, ...] starts from: the last block that starts before t0 (it holds
// the value in effect at t0), or the first block.
static uint32_t srcStartBlock(int64_t id, uint64_t t0) {
  uint32_t lo = 0, hi = srcNblk(id);
  while (lo < hi) { const uint32_t m = lo + (hi - lo) / 2; if (srcBlockT0(id, m) < t0) lo = m + 1; else hi = m; }
  return lo ? lo - 1 : 0;
}

static SigStore *srcFillRange(int64_t id, uint64_t t0, uint64_t t1, std::string &err) {
  SrcSig g;
  if (!srcSig(id, g, err)) return nullptr;
  if (t1 < t0) std::swap(t0, t1);
  StoreFill f(g);
  SrcRows r, pred;
  bool havePred = false;
  const uint32_t nb = srcNblk(id);
  for (uint32_t b = srcStartBlock(id, t0); b < nb && srcBlockT0(id, b) <= t1; b++) {
    if (!srcRead(id, b, t0, t1, r, err)) return nullptr;
    for (size_t i = 0; i < r.n(); i++) {
      if (r.t[i] < t0) {  // (only in the first block read)
        pred.clear();
        pred.t.push_back(r.t[i]);
        const uint8_t *p = r.val(i, g.vlen);
        pred.v.assign(p, p + r.len(i, g.vlen));
        pred.off.push_back(pred.v.size());
        havePred = true;
        continue;
      }
      if (havePred) { if (!f.add(pred, 0, err)) return nullptr; havePred = false; }
      if (!f.add(r, i, err)) return nullptr;
    }
    if (bgStop()) { err = "yielded"; return nullptr; }
  }
  if (!srcStillOk(id, err)) return nullptr;  // (a signal failed by another thread reads nblk() = 0: an error, not an empty store)
  if (havePred && !f.add(pred, 0, err)) return nullptr;
  return f.finish();
}

// ---- streaming window of a bit row ----
// cacheWindowCold of a bit vector walks its blocks one at a time instead of filling [t0, t1] into a
// scratch store: a whole-dump window of a wide row used to fill the whole row (a 512-bit row: 284 MB).
// The raw rows are normalized as they arrive, exactly as normalizeStore does it (the last change at a time
// wins, a change to the value in effect is dropped, all x before the first change). Each normalized change
// then goes straight into the window's answer, as windowOf builds it (same records, counts and exact flag).
// What is held: one pending row, the value in effect, the value at t0, and the records sent (at most
// 2 x buckets + 1, as many as the reply).
struct BitWindow {
  uint32_t st, B;
  uint64_t t0, t1;
  bool four;
  std::vector<uint8_t> allX;
  // normalizer
  bool havePend = false, haveKept = false;
  uint64_t pendT = 0;
  std::vector<uint8_t> pend, kept;  // val then xz (2 * st)
  // window
  bool haveAt0 = false;
  std::vector<uint8_t> at0;
  size_t count = 0;
  bool bucketed = false;
  SigStore pick;               // the records' rows (t > t0) in reply order
  std::vector<uint32_t> counts;
  uint32_t cur = 0;            // bucket of the last change (bucket mode)
  int64_t recBucket = -1;      // bucket whose first record was pushed last
  uint32_t inBucket = 0;       // records of that bucket pushed so far (1 or 2)
  BitWindow(const SrcSig &g, uint64_t a, uint64_t b, uint32_t nb) : st((g.bits + 7) / 8), B(nb), t0(a), t1(b), four(g.fourState) {
    allX.assign(st, 0);
    for (uint32_t i = 0; i < g.bits; i++) allX[i >> 3] |= (uint8_t)(1 << (i & 7));
    pend.assign(2 * st, 0); kept.assign(2 * st, 0); at0.assign(2 * st, 0);
    pick.kind = kBits; pick.bits = g.bits; pick.stride = st;
  }
  uint64_t bound(uint32_t k) const {  // bucket k starts at t0 + ceil(span * k / B)
    const unsigned __int128 span = t1 - t0;
    return t0 + (uint64_t)((span * k + B - 1) / B);
  }
  // The answer's own bound: the records held (time + both planes) and sent (time + one char per bit), with the
  // counts (4 B a bucket), count against the worker's signal cap together, as a fill would: a huge bucket count on a dense wide row is refused with
  // the fill's "larger than" error, not allocated.
  bool over = false;
  size_t perRecord() const { return 16 + (size_t)pick.bits + 2 * (size_t)st; }
  // the whole answer, records (one more being added, and the value at t0) and the counts together
  bool overCap(size_t records) const { return g_signalCap && records * perRecord() + (bucketed ? (size_t)B * 4 : 0) > g_signalCap; }
  void pushPick(uint64_t t, const uint8_t *v) {
    if (overCap(pick.times.size() + 2)) { over = true; return; }
    pick.times.push_back(t);
    pick.val.insert(pick.val.end(), v, v + st);
    pick.xz.insert(pick.xz.end(), v + st, v + 2 * st);
  }
  void setLastPick(uint64_t t, const uint8_t *v) {
    const size_t k = pick.times.size() - 1;
    pick.times[k] = t;
    memcpy(&pick.val[k * st], v, st);
    memcpy(&pick.xz[k * st], v + st, st);
  }
  void bucketAdd(uint64_t t, const uint8_t *v) {
    if (over) return;
    while (cur + 1 < B && t >= bound(cur + 1)) cur++;
    counts[cur]++;
    if (t <= t0) return;  // (a change at t0 is counted, but sent as the value at t0)
    if (recBucket != (int64_t)cur) { pushPick(t, v); recBucket = cur; inBucket = 1; }
    else if (inBucket == 1) { pushPick(t, v); inBucket = 2; }
    else setLastPick(t, v);
  }
  // Exact until a window has more than 2 x B changes; then the records so far are replayed into buckets.
  void toBuckets() {
    bucketed = true;
    if (overCap(1)) { over = true; return; }  // (the counts sent, 4 B a bucket, and the value at t0)
    counts.assign(B, 0);
    SigStore held;
    std::swap(held.times, pick.times); std::swap(held.val, pick.val); std::swap(held.xz, pick.xz);
    if (haveAt0Change) { counts[0]++; }
    std::vector<uint8_t> row(2 * st);
    for (size_t k = 0; k < held.times.size(); k++) {
      memcpy(row.data(), &held.val[k * st], st);
      memcpy(row.data() + st, &held.xz[k * st], st);
      bucketAdd(held.times[k], row.data());
    }
  }
  bool haveAt0Change = false;  // a normalized change at exactly t0 (counted in bucket 0)
  void change(uint64_t t, const uint8_t *v) {  // a normalized change, in time order
    if (over) return;  // (refused: the caller answers the cap error)
    if (t <= t0) { memcpy(at0.data(), v, 2 * st); haveAt0 = true; }
    if (t1 <= t0 || t < t0 || t >= t1) return;
    count++;
    if (bucketed) { bucketAdd(t, v); return; }
    if (t == t0) haveAt0Change = true;
    else pushPick(t, v);
    if (count > 2 * (size_t)B) toBuckets();
  }
  void settle() {  // the pending row is the last at its time
    if (!havePend) return;
    havePend = false;
    const uint8_t *p = pend.data();
    const bool same = haveKept ? !memcmp(p, kept.data(), 2 * st)
                               : (!memcmp(p + st, allX.data(), st) && std::all_of(p, p + st, [](uint8_t b) { return b == 0; }));
    if (same) return;
    memcpy(kept.data(), p, 2 * st);
    haveKept = true;
    change(pendT, p);
  }
  void raw(uint64_t t, const uint8_t *v) {  // a raw row (vlen bytes: val, then xz if four-state)
    if (havePend && t != pendT) settle();
    memcpy(pend.data(), v, st);
    if (four) memcpy(pend.data() + st, v + st, st); else memset(pend.data() + st, 0, st);
    pendT = t; havePend = true;
  }
  Napi::Object answer(Napi::Env env) {
    settle();
    const bool exact = !bucketed;
    // the value at t0 first (all x before the first change), then the records
    SigStore one;
    one.kind = kBits; one.bits = pick.bits; one.stride = st;
    one.val.assign(at0.begin(), at0.begin() + st);
    one.xz.assign(at0.begin() + st, at0.end());
    std::vector<uint8_t> rec;
    rec.reserve((pick.times.size() + 1) * (8 + pick.bits));
    uint64_t prev = 0;
    putRecord(&one, rec, prev, t0, haveAt0 ? 0 : -1);
    for (size_t k = 0; k < pick.times.size(); k++) putRecord(&pick, rec, prev, pick.times[k], (ptrdiff_t)k);
    Napi::Object o = Napi::Object::New(env);
    if (bucketed) o.Set("counts", Napi::Buffer<uint8_t>::Copy(env, (uint8_t *)counts.data(), counts.size() * 4));
    o.Set("exact", Napi::Boolean::New(env, exact));
    o.Set("count", Napi::Number::New(env, (double)count));
    o.Set("records", Napi::Buffer<uint8_t>::Copy(env, rec.data(), rec.size()));
    return o;
  }
};

static bool srcWindowBits(int64_t id, const SrcSig &g, uint64_t t0, uint64_t t1, uint32_t B, Napi::Env env, Napi::Object &o, std::string &err) {
  BitWindow w(g, t0, t1, B);
  SrcRows r;
  const uint32_t nb = srcNblk(id);
  for (uint32_t b = srcStartBlock(id, t0); b < nb && srcBlockT0(id, b) <= t1; b++) {
    if (!srcRead(id, b, t0, t1, r, err)) return false;
    for (size_t i = 0; i < r.n(); i++) w.raw(r.t[i], r.val(i, g.vlen));
    if (w.over) { err = capError(g_signalCap); return false; }
    if (bgStop()) { err = "yielded"; return false; }
  }
  if (!srcStillOk(id, err)) return false;
  w.settle();
  if (w.over) { err = capError(g_signalCap); return false; }
  // a window that holds every change (from the first block's start to past the row's last change) counts the row's whole normalized stream: it must be the source's count
  const bool whole = g.tLast != UINT64_MAX && t1 > t0 && t1 > g.tLast && (nb == 0 || t0 <= srcBlockT0(id, 0));
  if (whole && g.nNorm != kNormUnknown && w.count != g.nNorm) { err = countError(g.nNorm, w.count); return false; }
  o = w.answer(env);
  return true;
}

static std::vector<int64_t> argIds(const Napi::Value &v) {
  std::vector<int64_t> ids;
  Napi::Array a = v.As<Napi::Array>();
  for (uint32_t i = 0; i < a.Length(); i++) ids.push_back(argI64(a.Get(i)));
  return ids;
}
static double msSinceSrc(std::chrono::steady_clock::time_point a) { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count(); }

// cacheLoad(ids[], evict = true) -> [{signalId, cached, count, bits, bytes, xz, kind?, loadMs, walkMs} | {signalId, error}]
Napi::Value cacheLoad(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 1) || !wargs::arr(env, info[0])) return env.Undefined();
  const std::vector<int64_t> all = argIds(info[0]);
  Napi::Array result = Napi::Array::New(env);
  for (uint32_t i = 0; i < all.size(); i++) {
    const int64_t id = all[i];
    Napi::Object o = Napi::Object::New(env);
    o.Set("signalId", Napi::Number::New(env, (double)id));
    auto it = g_store.find(id);
    const bool cached = it != g_store.end();
    double ms = 0;
    if (!cached) {
      const auto t = std::chrono::steady_clock::now();
      std::string err;
      SigStore *s = srcFillWhole(id, err);
      ms = msSinceSrc(t);
      if (!s) { o.Set("error", Napi::String::New(env, err)); result.Set(i, o); continue; }
      g_store[id] = s;
      g_bytes += s->bytes();
      it = g_store.find(id);
    }
    SigStore *s = it->second;
    s->lastUsed = ++g_clock;
    o.Set("cached", Napi::Boolean::New(env, cached));
    o.Set("count", Napi::Number::New(env, (double)s->times.size()));
    o.Set("bits", Napi::Number::New(env, s->bits));
    o.Set("bytes", Napi::Number::New(env, (double)s->bytes()));
    o.Set("xz", Napi::Boolean::New(env, !s->xz.empty()));
    if (s->kind != kBits) o.Set("kind", Napi::String::New(env, kindName(s->kind)));
    o.Set("loadMs", Napi::Number::New(env, ms));
    o.Set("walkMs", Napi::Number::New(env, 0));
    result.Set(i, o);
  }
  if (info.Length() < 2 || info[1].ToBoolean().Value()) storeEvict(all);
  return result;
}

// cacheWindowCold(ids[], t0, t1, buckets, textBudget?) -> [{signalId, exact, count, records, counts?, loadMs, walkMs} | {signalId, error}]
Napi::Value cacheWindowCold(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 4) || !wargs::arr(env, info[0])) return env.Undefined();
  const std::vector<int64_t> ids = argIds(info[0]);
  uint64_t t0 = argTime(info[1]), t1 = argTime(info[2]);
  if (t1 < t0) std::swap(t0, t1);
  uint32_t B = info[3].As<Napi::Number>().Uint32Value();
  if (B == 0) B = 1;
  const size_t budget = argBudget(info, 4);
  Napi::Array out = Napi::Array::New(env);
  for (uint32_t k = 0; k < ids.size(); k++) {
    const auto t = std::chrono::steady_clock::now();
    std::string err;
    SrcSig g;
    if (g_streamWindow && srcSig(ids[k], g, err) && g.kind == kBits) {  // a bit row: streamed, nothing filled
      Napi::Object o;
      const bool ok = srcWindowBits(ids[k], g, t0, t1, B, env, o, err);
      if (!ok) o = Napi::Object::New(env);
      o.Set("signalId", Napi::Number::New(env, (double)ids[k]));
      if (!ok) o.Set("error", Napi::String::New(env, err));
      o.Set("loadMs", Napi::Number::New(env, msSinceSrc(t)));
      o.Set("walkMs", Napi::Number::New(env, 0));
      out.Set(k, o);
      continue;
    }
    err.clear();
    SigStore *s = srcFillRange(ids[k], t0, t1, err);
    const double fillMs = msSinceSrc(t);
    Napi::Object o = s ? windowOf(env, s, t0, t1, B, budget) : Napi::Object::New(env);
    o.Set("signalId", Napi::Number::New(env, (double)ids[k]));
    if (!s) o.Set("error", Napi::String::New(env, err));
    o.Set("loadMs", Napi::Number::New(env, fillMs));
    o.Set("walkMs", Napi::Number::New(env, msSinceSrc(t) - fillMs));
    srcDelete(s);
    out.Set(k, o);
  }
  return out;
}

// coldValueAt(ids[], t) -> [string | {error} | {notRecorded}]: as cacheValueAt (all x before the first change);
// inside a capture gap {notRecorded: true}, whatever the rows before it say.
Napi::Value coldValueAt(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 2) || !wargs::arr(env, info[0])) return env.Undefined();
  const std::vector<int64_t> ids = argIds(info[0]);
  const uint64_t t = argTime(info[1]);
  Napi::Array out = Napi::Array::New(env);
  const bool rec = srcRecordedAt(t);
  for (uint32_t k = 0; k < ids.size(); k++) {
    if (!rec) { out.Set(k, notRecorded(env)); continue; }
    std::string err;
    SigStore *s = srcFillRange(ids[k], t, t, err);
    if (!s) { Napi::Object o = Napi::Object::New(env); o.Set("error", Napi::String::New(env, err)); out.Set(k, o); continue; }
    out.Set(k, Napi::String::New(env, valueText(s, (ptrdiff_t)upperIdx(s, t, 0, s->times.size()) - 1)));
    srcDelete(s);
  }
  return out;
}

// coldValueNear(ids[], t, span) -> [{t, value} | {none: true, value} | {error}]: the value at t and
// the last normalized change in [t - span, t] (bit vectors).
Napi::Value coldValueNear(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 3) || !wargs::arr(env, info[0])) return env.Undefined();
  const std::vector<int64_t> ids = argIds(info[0]);
  const uint64_t t = argTime(info[1]), span = argTime(info[2]);
  const uint64_t lo = t > span ? t - span : 0;
  Napi::Array out = Napi::Array::New(env);
  const bool rec = srcRecordedAt(t);  // (in a gap: {notRecorded}, as coldValueAt)
  for (uint32_t k = 0; k < ids.size(); k++) {
    if (!rec) { out.Set(k, notRecorded(env)); continue; }
    Napi::Object o = Napi::Object::New(env);
    out.Set(k, o);
    std::string err;
    SrcSig g;
    if (!srcSig(ids[k], g, err)) { o.Set("error", Napi::String::New(env, err)); continue; }
    if (g.kind != kBits) { o.Set("error", Napi::String::New(env, "unsupported encoding")); continue; }
    SigStore *s = srcFillRange(ids[k], lo, t, err);
    if (!s) { o.Set("error", Napi::String::New(env, err)); continue; }
    const ptrdiff_t at = (ptrdiff_t)upperIdx(s, t, 0, s->times.size()) - 1;
    if (at >= 0 && s->times[at] >= lo) o.Set("t", Napi::Number::New(env, (double)s->times[at]));
    else o.Set("none", Napi::Boolean::New(env, true));
    o.Set("value", Napi::String::New(env, valueText(s, at)));
    srcDelete(s);
  }
  return out;
}

// searchScan(ids[], t, dir, pattern, bound, kind?, start?) -> [{signalId, t | null, scanned} | {signalId, error} | {signalId, yielded}]
// The first match of `pattern` (kind < 0) or edge of `kind` from t in
// direction dir, not past bound, over a ranged fill of just that span; nothing is kept.
// A search round's bound within the signal cap: the fill of [t, bound] (or [bound, t]) is narrowed, by whole
// blocks, to as many raw rows as the cap holds (at least one block past t), so a bursty row's round can't fill
// up to the share. Forward: just before the first block that would go over; backward: just after the last
// block that would (a block starting at the time a same-time group splits keeps that time out of the round).
static uint64_t scanBound(int64_t id, const SrcSig &g, uint64_t t, int dir, uint64_t bound) {
  if (!g_signalCap) return bound;
  const size_t per = 8 + 2 * (size_t)((g.bits + 7) / 8);
  const uint64_t budget = std::max<uint64_t>(1, g_signalCap / per);
  const uint32_t nb = srcNblk(id);
  if (!nb) return bound;
  const uint32_t b0 = srcStartBlock(id, t);
  uint64_t rows = 0;
  if (dir > 0) {
    for (uint32_t b = b0; b < nb && srcBlockT0(id, b) <= bound; b++) {
      rows += srcBlockRows(id, b);
      if (rows > budget && b > b0 && srcBlockT0(id, b) > t + 1) return std::min(bound, srcBlockT0(id, b) - 1);
    }
    return bound;
  }
  // backward (changes before t): from the last block starting before t, newest first
  uint32_t bt = b0;
  while (bt + 1 < nb && srcBlockT0(id, bt + 1) < t) bt++;
  for (uint32_t b = bt;; b--) {
    rows += srcBlockRows(id, b);
    if (rows > budget && b < bt) {
      const uint64_t lim = srcBlockT0(id, b + 1) + 1;  // blocks b + 1 .. bt only
      if (lim < t && lim > bound) return lim;
    }
    if (b == 0 || srcBlockT0(id, b) <= bound) break;
  }
  return bound;
}

Napi::Value searchScan(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 5) || !wargs::arr(env, info[0]) || !wargs::str(env, info[3])) return env.Undefined();
  const std::vector<int64_t> ids = argIds(info[0]);
  const uint64_t t = argTime(info[1]);
  const int dir = info[2].As<Napi::Number>().Int32Value() < 0 ? -1 : 1;
  const std::string pat = info[3].As<Napi::String>().Utf8Value();
  const uint64_t bound = argTime(info[4]);
  const int kind = info.Length() > 5 && info[5].IsNumber() ? info[5].As<Napi::Number>().Int32Value() : -1;
  const uint64_t start = info.Length() > 6 && info[6].IsNumber() ? argTime(info[6]) : 0;
  Napi::Array out = Napi::Array::New(env);
  bool stopped = false;
  for (uint32_t i = 0; i < ids.size(); i++) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("signalId", Napi::Number::New(env, (double)ids[i]));
    out.Set(i, o);
    if (stopped || (stopped = bgStop())) { o.Set("yielded", Napi::Boolean::New(env, true)); continue; }
    std::string err;
    SrcSig g;
    if (!srcSig(ids[i], g, err)) { o.Set("error", Napi::String::New(env, err)); continue; }
    if (g.kind != kBits) { o.Set("error", Napi::String::New(env, std::string("not a bit signal (") + kindName(g.kind) + ")")); continue; }
    if (kind >= 3 && g.bits != 1) { o.Set("error", Napi::String::New(env, "edge: posedge, negedge and edge need a 1-bit signal")); continue; }
    if (dir < 0 && bound > t) { o.Set("t", env.Null()); o.Set("scanned", Napi::Number::New(env, 0)); continue; }
    const uint64_t lim = scanBound(ids[i], g, t, dir, bound);  // (what the signal cap holds, by whole blocks)
    SigStore *s = dir > 0 ? srcFillRange(ids[i], t, std::max(t, lim), err) : srcFillRange(ids[i], lim, t, err);
    if (!s) {
      if (err == "yielded") { stopped = true; o.Set("yielded", Napi::Boolean::New(env, true)); }
      else o.Set("error", Napi::String::New(env, err));
      continue;
    }
    uint64_t hit = 0;
    const bool found = kind >= 0 ? storeEdge(s, t, dir, kind, start, lim, hit) : storeSearch(s, t, dir, pat, lim, hit);
    // changes compared: those between t and the hit (or the bound)
    const size_t n = s->times.size();
    size_t scanned;
    if (dir > 0) { const size_t a = upperIdx(s, t, 0, n), b = found ? upperIdx(s, hit, 0, n) : n; scanned = b > a ? b - a : 0; }
    else { const size_t b = std::lower_bound(s->times.begin(), s->times.end(), t) - s->times.begin();
           const size_t a = found ? std::lower_bound(s->times.begin(), s->times.end(), hit) - s->times.begin() : std::lower_bound(s->times.begin(), s->times.end(), lim) - s->times.begin();
           scanned = b > a ? b - a : 0; }
    o.Set("t", found ? Napi::Number::New(env, (double)hit) : env.Null());
    o.Set("scanned", Napi::Number::New(env, (double)scanned));
    if (lim != bound) o.Set("bound", Napi::Number::New(env, (double)lim));  // narrowed: the next round resumes here
    srcDelete(s);
  }
  return out;
}

// sourceCount(ids[]) -> [{signalId, count, bits, xz, kind?} | {signalId, error}]: the normalized change
// count the source knows without a fill (a container's signal table).
Napi::Value sourceCount(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 1) || !wargs::arr(env, info[0])) return env.Undefined();
  const std::vector<int64_t> ids = argIds(info[0]);
  Napi::Array out = Napi::Array::New(env);
  for (uint32_t i = 0; i < ids.size(); i++) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("signalId", Napi::Number::New(env, (double)ids[i]));
    std::string err;
    SrcSig g;
    if (!srcSig(ids[i], g, err)) o.Set("error", Napi::String::New(env, err));
    else {
      o.Set("count", Napi::Number::New(env, (double)g.nNorm));
      o.Set("bits", Napi::Number::New(env, g.kind == kBits ? g.bits : 1));
      o.Set("xz", Napi::Boolean::New(env, g.fourState));  // (declared 4-state: may hold x or z)
      if (g.kind != kBits) o.Set("kind", Napi::String::New(env, kindName(g.kind)));
    }
    out.Set(i, o);
  }
  return out;
}

// What a block source has, for the coordinator and workers (`caps`): none of the optional
// features (var-tree read, extra kinds, warm readers, the store cache, split walks, clock
// descriptors, alias verification); counts known at open.
static Napi::Object sourceCaps(Napi::Env env) {
  Napi::Object c = Napi::Object::New(env);
  for (const char *k : {"varTree", "kinds", "warm", "storeCache", "split", "clock", "aliases", "v1Signals"}) c.Set(k, Napi::Boolean::New(env, false));
  c.Set("counts", Napi::Boolean::New(env, true));
  return c;
}

// sourceTrimAfterMB(mb) -> the previous value: return freed memory after this many MB (0 = every free)
Napi::Value sourceTrimAfterMB(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const double prev = (double)g_trimAfter / (1u << 20);
  if (info.Length() > 0 && info[0].IsNumber()) g_trimAfter = (size_t)(std::max(0.0, info[0].As<Napi::Number>().DoubleValue()) * (1u << 20));
  return Napi::Number::New(env, prev);
}
static Napi::Object srcMemory(Napi::Env env) {
  Napi::Object m = Napi::Object::New(env);
  m.Set("freed", Napi::Number::New(env, (double)g_freedTotal));
  m.Set("trims", Napi::Number::New(env, (double)g_trims));
  m.Set("trimAfter", Napi::Number::New(env, (double)g_trimAfter));
  return m;
}

static Napi::Value knownSignals(const Napi::CallbackInfo &info);  // known_ids.cpp.inc
static void sourceExports(Napi::Env env, Napi::Object exports) {
  g_onFree = srcFreed;
  if (const char *e = getenv("WCB_STREAM_WINDOW")) g_streamWindow = atoi(e) != 0;
  if (const char *e = getenv("WCB_TRIM_MB")) g_trimAfter = (size_t)(std::max(0.0, atof(e)) * (1u << 20));
  const std::pair<const char *, Napi::Value (*)(const Napi::CallbackInfo &)> fns[] = {
    {"cacheLoad", cacheLoad}, {"cacheWindowCold", cacheWindowCold}, {"coldValueAt", coldValueAt}, {"coldValueNear", coldValueNear},
    {"searchScan", searchScan}, {"sourceCount", sourceCount}, {"sourceTrimAfterMB", sourceTrimAfterMB},
    {"knownSignals", knownSignals}};
  for (auto &f : fns) exports.Set(Napi::String::New(env, f.first), Napi::Function::New(env, f.second));
}
