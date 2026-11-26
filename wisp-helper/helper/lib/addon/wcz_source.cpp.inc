// SPDX-License-Identifier: MIT
// ---- the WCZ1 source (wcb_reader.node): a WCZ1 container read through the block source ----
//
// A WCZ1 file (third_party/wcz: the container's reference reader, MIT) is mapped read-only and
// opened through its INDEX; every block and chunk is checked against its checksum before zstd
// (third_party/zstd, the decompressor only). Then:
//   - the hierarchy calls of the viewer addon interface (openFile, readMetadata, readScopes,
//     getScopeChildren, readVars, unload), from the dictionary: tree.js and the coordinator use
//     them as they are;
//   - blocksrc.cpp.inc's hooks over the signal index: srcSig (counts from the INDEX, no walk),
//     srcNblk / srcBlockT0, and srcRead, which decodes a block whole, or only the chunks and the
//     prefix of the last one that a read up to `upto` needs (prefix decode: the times, then the
//     values of the rows at or before `upto`; nothing past them is decompressed);
//   - a decoded-block LRU (whole blocks read by fills and windows; WCB_BLOCK_LRU_MB, 256 MB by
//     default), so pans and zoom-backs over the same blocks decode once.
// Signal ids are SIGD index + 1 (0 is not an id); a var's netlistId is the scope count + its
// VARS index. REF signals (aliases the converter stored once) read their target's blocks.
// Only complete files: one without a trailer (a live or interrupted capture) is refused here.

#define ZSTD_STATIC_LINKING_ONLY
#include <thread>
#define WCZ_ROWS_ALLOC BigAlloc  // (blocksrc.cpp.inc: large decoded rows mmap'd, given back with munmap)
#include <zstd.h>
#include "wcz_seg.h"
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <atomic>
#include <functional>
#include <list>
#include <mutex>
#include <memory>
#include <unordered_set>
#include <map>
#include "direct_source.cpp.inc"

namespace wczsrc {

struct File {
  int fd = -1;
  const uint8_t *map = nullptr;
  size_t size = 0;
  wcz::SegReader rd;
  bool open = false;
  bool direct = false;  // an FSDB file read in place (dsrc): the dictionary and values come from it, rd is not used
  // hierarchy: scopes other than array scopes (kind 10) are listed as scopes; array scopes come
  // inline in their parent's readVars (ARRAY_BEGIN / ARRAY_END)
  std::vector<uint32_t> top;
  std::vector<std::vector<uint32_t>> kids, arrays, vars;
  std::vector<std::vector<uint32_t>> skipped;  // (per scope, the vars not stored, in declaration order)
  uint32_t skippedVars = 0;
  // capture gaps from the dump-off entries (the capture writer's gap records): not recorded in from < t < to,
  // or from < t with no on entry (toEnd)
  struct Gap { uint64_t from = 0, to = 0; bool toEnd = false; };
  std::vector<Gap> gaps;
};
static File g_f;
static const wcz::Dict &dictOf() { return g_f.direct ? dsrc::g_dict : g_f.rd.dict(); }
static uint32_t nSigs() { return g_f.direct ? dsrc::nSignals() : g_f.rd.nSignals(); }
// a not-stored var's reason text: the file's (or, read directly, the converter's) named reason; else the reason code's
// name; "" when the file gives none
static std::string reasonOf(uint32_t v) {
  uint16_t code = 0; uint32_t text = wcz::NONE32; const wcz::Dict &d = dictOf();
  if (g_f.direct) {
    auto it = std::lower_bound(d.reasons.begin(), d.reasons.end(), v, [](const wcz::VarReason &r, uint32_t x) { return r.var < x; });
    if (it == d.reasons.end() || it->var != v) return "";
    code = it->code; text = it->text;
  } else if (!g_f.rd.varReason(v, code, text)) return "";
  if (text != wcz::NONE32 && text < d.strs.size() && !d.strs[text].empty()) return d.strs[text];
  const char *n = wcz::reasonCodeName(code);
  return n ? n : "code " + std::to_string(code);
}

static thread_local ZSTD_DCtx *g_zd = nullptr;      // one-shot decodes (whole blocks and chunks); (per thread)
static thread_local BigVec<uint8_t> g_tmp;  // (per thread)
// The decode scratch (g_tmp: whole blocks, chunks and point reads) grows to the largest payload read, up to
// MAX_RSIZE. A read that grew it past kScratchKeep gives it back after the read (and closeFile gives it back), so
// one large or hostile chunk doesn't pin up to 256 MB per worker; sourceInfo().memory.scratch counts what is held.
static const size_t kScratchKeep = 4u << 20;
static void scratchRelease(size_t keep) {
  size_t n = 0;
  if (g_tmp.capacity() > keep) { n += g_tmp.capacity(); BigVec<uint8_t>().swap(g_tmp); }
  if (n) srcFreed(n);
}
static size_t scratchBytes() { return g_tmp.capacity(); }
static std::atomic<size_t> g_scratchPeak{0};  // the largest decode scratch held (sourceInfo().memory.scratchPeak)
static void notePeak() { size_t c = scratchBytes(), p = g_scratchPeak.load(); while (c > p && !g_scratchPeak.compare_exchange_weak(p, c)) {} }  // (atomic)

// ---- decoded-block LRU: whole blocks, keyed by (data signal, block) ----
struct Cached { uint64_t key; wcz::Rows rows; size_t bytes; };
static std::list<Cached> g_lru;
static std::unordered_map<uint64_t, std::list<Cached>::iterator> g_lruIdx;
static size_t g_lruBytes = 0, g_lruCap = 256u << 20;
static std::mutex g_lruMu;  // (the LRU and its hit/miss counters, shared by the core's threads)
static uint64_t g_lruHits = 0, g_lruMisses = 0;
static std::atomic<uint64_t> g_prefixReads{0}, g_wholeReads{0};
// point path (the last chunk of a read, up to the query): time deltas walked, rows whose values were built, rows
// handed back
static std::atomic<uint64_t> g_prefixTimeRows{0}, g_prefixValueRows{0}, g_prefixRowsOut{0};
static bool g_prefixOn = true;  // WCB_PREFIX=0: the last chunk of a read is decoded whole too (A/B)
static void lruClear() { std::lock_guard<std::mutex> lk(g_lruMu); g_lru.clear(); g_lruIdx.clear(); g_lruBytes = 0; }
static const wcz::Rows *lruGet(uint64_t key) {
  auto it = g_lruIdx.find(key);
  if (it == g_lruIdx.end()) { g_lruMisses++; return nullptr; }
  g_lru.splice(g_lru.begin(), g_lru, it->second);
  g_lruHits++;
  return &it->second->rows;
}
static void lruPut(uint64_t key, wcz::Rows &&r) {  // (takes the rows: a whole decode is kept, not copied)
  const size_t bytes = r.t.capacity() * 8 + r.v.capacity() + r.off.capacity() * 8 + 64;
  if (!g_lruCap || bytes > g_lruCap / 4) return;  // (one block never takes over the cache)
  std::unique_lock<std::mutex> lk(g_lruMu);
  auto old = g_lruIdx.find(key);
  if (old != g_lruIdx.end()) { g_lruBytes -= old->second->bytes; g_lru.erase(old->second); g_lruIdx.erase(old); }
  g_lru.push_front(Cached{key, std::move(r), bytes});
  g_lruIdx[key] = g_lru.begin();
  g_lruBytes += bytes;
  size_t freed = 0;
  while (g_lruBytes > g_lruCap && !g_lru.empty()) {
    g_lruBytes -= g_lru.back().bytes;
    freed += g_lru.back().bytes;
    g_lruIdx.erase(g_lru.back().key);
    g_lru.pop_back();
  }
  lk.unlock();
  if (freed) srcFreed(freed);
}

// WISP_FOOTER_PREFETCH=defer: the reader's footer advice is issued by this thread once the reader has opened, so the
// open reply does not wait for it (the reader's FOOTER_PREFETCH_DEFER + prefetchFooters()). Joined before the file
// is closed or unmapped, and at exit. sourceInfo(1) (the helper's stats) joins it first, so footerRangesDeferred is
// the count the thread advised, never the -1 it starts at. WISP_TEST_FOOTER_DELAY_MS (the helper's own tests only)
// holds the thread before its advice.
static struct FooterThread { std::thread t; std::atomic<int64_t> ranges{-1};
  void join() { if (t.joinable()) t.join(); } ~FooterThread() { join(); } } g_foot;
static void closeFile() {
  g_foot.join();
  lruClear();
  scratchRelease(0);
  if (g_f.map) munmap((void *)g_f.map, g_f.size);
  if (g_f.fd >= 0) close(g_f.fd);
  dsrc::close();
  g_f = File();
}

static bool ensureCtx(std::string &err) {
  if (!g_zd) g_zd = ZSTD_createDCtx();
  if (!g_zd) { err = "zstd: out of memory"; return false; }
  return true;
}

// ---- point read in one chunk ----
// The chunk's rows up to `upto`, as BlockDecoder::pointChunk reads them (reference 055be1a): the whole payload is
// decompressed and every row checked, so a point read accepts exactly the chunks a whole decode accepts; values are
// built only for the rows srcReadIn keeps: those at or before `upto`, from the last one before `from` (tfrom; the rows
// before it are checked and folded, not built).
static bool prefixChunk(const wcz::SigSpec &s, const wcz::BlockInfo &e, const uint8_t *bytes, const std::vector<wcz::SeekEnt> &st,
                        uint32_t c, uint64_t from, uint64_t upto, wcz::Rows &out, std::string &err, uint64_t vlimit = wcz::MAX_DECODED) {
  using namespace wcz;
  const DecodeStats d0 = decodeStats();
  const size_t base = out.t.size();
  if (!BlockDecoder::pointChunk(g_zd, s, e, bytes, st, c, upto, out, g_tmp, err, vlimit, from)) return false;
  const DecodeStats &d1 = decodeStats();
  g_prefixTimeRows += d1.timeRows - d0.timeRows;
  g_prefixValueRows += d1.valueRows - d0.valueRows;
  size_t k0 = std::lower_bound(out.t.begin() + base, out.t.end(), from) - out.t.begin();
  if (k0 > base) k0--;
  g_prefixReads++;
  g_prefixRowsOut += out.t.size() - k0;
  return true;
}

static bool sigOf(int64_t id, uint32_t &i, std::string &err) {
  if (!g_f.open) { err = "no file open"; return false; }
  if (id < 1 || id > (int64_t)nSigs()) { err = "unknown signal"; return false; }
  i = (uint32_t)(id - 1);
  return true;
}

// Rows [k0, k1) of r appended to out.
static void copyRows(const wcz::Rows &r, uint32_t vlen, size_t k0, size_t k1, SrcRows &out) {
  for (size_t k = k0; k < k1; k++) {
    out.t.push_back(r.t[k]);
    const uint8_t *p = r.val((uint32_t)k, vlen);
    out.v.insert(out.v.end(), p, p + r.len((uint32_t)k, vlen));
    out.off.push_back(out.v.size());
  }
}

}  // namespace wczsrc

// ---- the block-source hooks (blocksrc.cpp.inc) ----
static bool srcSig(int64_t id, SrcSig &g, std::string &err) {
  using namespace wczsrc;
  uint32_t i;
  if (!sigOf(id, i, err)) return false;
  if (g_f.direct) return dsrc::sig(i, g, err);
  if (!g_f.rd.checkSignal(i, err)) return false;  // (its INDEX entries, checked on first use)
  const wcz::SigSpec &s = g_f.rd.dict().sigs[g_f.rd.dataOf(i)].spec;
  g.kind = s.vtype == wcz::VT_REAL ? kReal : s.vtype == wcz::VT_STRING ? kString : kBits;
  g.bits = s.vtype == wcz::VT_BITS ? s.bits : s.vtype == wcz::VT_REAL ? 64 : 32;
  g.vlen = s.vlen;
  g.fourState = s.fourState;
  g.nNorm = g_f.rd.sum(i).nNorm;
  g.tLast = g_f.rd.sum(i).n ? g_f.rd.sum(i).tLast : UINT64_MAX;
  return true;
}
static uint32_t srcNblk(int64_t id) {
  using namespace wczsrc;
  uint32_t i;
  std::string err;
  if (!sigOf(id, i, err)) return 0;
  return g_f.direct ? dsrc::nblk(i) : g_f.rd.nblk(i);
}
// (race fix) a signal can fail after its first check: another thread's footer check fails its whole segment, and
// nblk() then reads 0 (wcz_seg.h: "on b >= nblk(i), call checkSignal(i, err) for the real error"). Every block loop
// calls this after it ends, so an early end is an error, never an empty or short store.
static bool srcStillOk(int64_t id, std::string &err) {
  using namespace wczsrc;
  uint32_t i;
  if (!sigOf(id, i, err)) return false;
  if (g_f.direct) { SrcSig g; return dsrc::sig(i, g, err); }
  return g_f.rd.checkSignal(i, err);
}
static uint64_t srcBlockT0(int64_t id, uint32_t b) {
  using namespace wczsrc;
  uint32_t i;
  std::string err;
  if (!sigOf(id, i, err)) return UINT64_MAX;
  if (g_f.direct) return dsrc::blockT0(i, b);
  return b < g_f.rd.nblk(i) ? g_f.rd.block(i, b).info.t0 : UINT64_MAX;
}
static bool srcRecordedAt(uint64_t t) {
  for (const auto &x : wczsrc::g_f.gaps) if (t > x.from && (x.toEnd || t < x.to)) return false;
  return true;
}
static uint32_t srcBlockRows(int64_t id, uint32_t b) {
  using namespace wczsrc;
  uint32_t i;
  std::string err;
  if (!sigOf(id, i, err)) return 0;
  if (g_f.direct) return dsrc::blockRows(i, b);
  return b < g_f.rd.nblk(i) ? g_f.rd.block(i, b).info.rows : 0;
}
static bool srcReadIn(int64_t id, uint32_t b, uint64_t from, uint64_t upto, SrcRows &out, std::string &err);
// a failed large allocation (BigAlloc's mmap) is an error, not a terminated worker
static bool srcRead(int64_t id, uint32_t b, uint64_t from, uint64_t upto, SrcRows &out, std::string &err) {
  try { return srcReadIn(id, b, from, upto, out, err); }
  catch (const std::bad_alloc &) { out.clear(); err = "out of memory"; return false; }
}
// Block read-ahead for the helper's own block reads (it decodes with BlockDecoder, not through the reader's decodeBlock,
// so it gives the same advice itself): the reader advises the DATA region random, so without this a cold block faults
// in one page at a time. Before a block is decoded, the bytes about to be decoded (the whole block, or the frames of
// chunks c0..c1) are advised WILLNEED in READ_AHEAD_STEP calls when they span at least the reader's blockReadAhead()
// pages, and only while its map advice is on (the same settings as the reader's own read path). Advice only.
static std::atomic<uint64_t> g_blockReads{0}, g_blockAdvised{0};
static void blockReadAhead(const wcz::BlockRef &r, const std::vector<wcz::SeekEnt> &st, bool whole, uint32_t c0, uint32_t c1) {
  using namespace wczsrc;
  using namespace wcz;
  g_blockReads.fetch_add(1, std::memory_order_relaxed);
  const uint32_t minPages = g_f.rd.blockReadAhead();
  if (!g_f.rd.mapAdvice() || !minPages) return;
  uint64_t off = r.off, len = r.info.len;
  if (!whole && r.info.nchunk > 1 && c1 < st.size() && c0 <= c1) {
    uint64_t p = (uint64_t)SEEK_SIZE * r.info.nchunk; for (uint32_t k = 0; k < c0; k++) p += st[k].csize;
    uint64_t q = 0; for (uint32_t k = c0; k <= c1; k++) q += st[k].csize;
    off = r.off + p; len = q;
  }
  if (!len || off >= g_f.size) return;
  len = std::min<uint64_t>(len, g_f.size - off);
  static const uintptr_t pg = (uintptr_t)sysconf(_SC_PAGESIZE);
  if (!pg || (pg & (pg - 1))) return;
  const uintptr_t a = ((uintptr_t)g_f.map + off) & ~(pg - 1), b = ((uintptr_t)g_f.map + off + len + pg - 1) & ~(pg - 1);
  if ((b - a) / pg < minPages) return;
  for (uintptr_t q = a; q < b; q += wcz::SegReader::READ_AHEAD_STEP) (void)madvise((void *)q, std::min<uintptr_t>(wcz::SegReader::READ_AHEAD_STEP, b - q), MADV_WILLNEED);
  g_blockAdvised.fetch_add(1, std::memory_order_relaxed);
}

static bool srcReadIn(int64_t id, uint32_t b, uint64_t from, uint64_t upto, SrcRows &out, std::string &err) {
  using namespace wczsrc;
  using namespace wcz;
  out.clear();
  struct Release { ~Release() { wczsrc::notePeak(); wczsrc::scratchRelease(wczsrc::kScratchKeep); } } release;  // (also on every error return)
  uint32_t i;
  if (!sigOf(id, i, err)) return false;
  if (g_f.direct) return dsrc::read(i, b, from, upto, out, err);
  // (nblk is 0 once a concurrent footer check fails the signal: report that check's text, not "no such block")
  if (b >= g_f.rd.nblk(i)) { std::string ce; err = g_f.rd.checkSignal(i, ce) ? "no such block" : ce; return false; }
  if (!ensureCtx(err)) return false;
  const uint32_t di = g_f.rd.dataOf(i);
  const BlockRef &r = g_f.rd.block(i, b);
  const SigSpec &s = g_f.rd.dict().sigs[di].spec;
  if (r.info.t0 > upto) return true;
  const uint64_t key = ((uint64_t)di << 32) | b;
  auto rowsOf = [&](const Rows &rows) {  // the rows from the last one before `from` up to `upto`
    size_t k0 = std::lower_bound(rows.t.begin(), rows.t.end(), from) - rows.t.begin();
    if (k0) k0--;
    const size_t k1 = std::upper_bound(rows.t.begin(), rows.t.end(), upto) - rows.t.begin();
    copyRows(rows, s.vlen, k0, k1, out);
  };
  { std::lock_guard<std::mutex> lk(g_lruMu); if (const Rows *c = lruGet(key)) { rowsOf(*c); return true; } }  // (copied under the lock)
  std::string e;
  if (!g_f.rd.checkBlock(i, b, e)) { err = "block " + std::to_string(b) + ": " + e; return false; }  // (the reader's pre-decode checks: its footer entry, for this signal, and the INDEX gap before it)
  // the gap after it too: a read past this block's last row answers "no change until block b + 1", which holds only
  // when no footer holds a block of this signal between the two (checkBlock(b + 1) checks the gap before b + 1)
  if (b + 1 < g_f.rd.nblk(i) && !g_f.rd.checkBlock(i, b + 1, e)) { err = "block " + std::to_string(b + 1) + ": " + e; return false; }
  if (!BlockDecoder::checkInfo(s, r.info, e)) { err = "block " + std::to_string(b) + ": " + e; return false; }
  if (r.info.nchunk == 1 && r.info.rsize > MAX_RSIZE) { err = "block " + std::to_string(b) + ": bad chunk payload size"; return false; }
  std::vector<SeekEnt> st;
  const uint8_t *bytes = g_f.map + r.off;
  if (!BlockDecoder::seekTable(s, r.info, bytes, st, true, e)) { err = "block " + std::to_string(b) + ": " + e; return false; }
  // first chunk: the last one starting before `from` (it holds the last change before it)
  uint32_t c0 = 0;
  while (c0 + 1 < st.size() && st[c0 + 1].t < from) c0++;
  const uint32_t c1 = BlockDecoder::chunkFor(st, upto);
  const bool whole = c0 == 0 && upto >= r.info.tLast;
  blockReadAhead(r, st, whole, c0, c1);
  Rows rows;
  if (whole) {  // the whole block: decoded once, kept in the LRU
    if (!BlockDecoder::decodeBlockCounted(g_zd, s, r.info, bytes, rows, g_tmp, true, e)) { err = "block " + std::to_string(b) + ": " + e; return false; }
    g_wholeReads++;
    rowsOf(rows);
    lruPut(key, std::move(rows));
    return true;
  }
  if (s.vtype == VT_STRING && c1 > c0) {
    // a string read over several chunks: their string total first (one chunk decompressed at a time, nothing kept),
    // so a read past the limit is refused before its values are allocated (the last chunk counts whole)
    uint64_t total = 0;
    if (!BlockDecoder::strChunksTotal(g_zd, s, r.info, bytes, st, c0, c1 + 1, g_tmp, true, MAX_DECODED, total, e)) {
      if (e == BlockDecoder::WHOLE_STR) e = "string rows decode past the limit for one read (2^28 bytes): read a shorter range";
      err = "block " + std::to_string(b) + ": " + e;
      return false;
    }
  }
  for (uint32_t c = c0; c <= c1; c++) {
    const uint64_t tMax = c + 1 < r.info.nchunk ? st[c + 1].t : r.info.tLast;
    const uint64_t left = MAX_DECODED - std::min<uint64_t>(MAX_DECODED, rows.v.size());  // (one read's string rows: within 2^28 across its chunks)
    const bool ok = upto >= tMax || !g_prefixOn ? BlockDecoder::decodeChunk(g_zd, s, r.info, bytes, st, c, rows, g_tmp, true, e, left)
                                 : prefixChunk(s, r.info, bytes, st, c, from, upto, rows, e, left);
    if (!ok) { err = "block " + std::to_string(b) + ": " + e; return false; }
  }
  rowsOf(rows);
  return true;
}

// ---- hierarchy (the viewer addon interface calls, from the dictionary) ----
namespace wczsrc {
static const char *scopeType(uint8_t k) {
  switch (k) {
    case 0: case 6: case 7: case 12: return "module";
    case 1: return "task";
    case 2: return "function";
    case 3: case 5: return "begin";
    case 4: return "fork";
    default: return "unknown_scope_type";
  }
}
static Napi::Object scopeObject(Napi::Env env, uint32_t s) {
  const wcz::Dict &d = dictOf();
  Napi::Object o = Napi::Object::New(env);
  o.Set("name", Napi::String::New(env, d.strs[d.scopes[s].name]));
  o.Set("type", Napi::String::New(env, scopeType(d.scopes[s].kind)));
  o.Set("netlistId", Napi::Number::New(env, s));
  o.Set("scopeOffsetIdx", Napi::Number::New(env, s));
  return o;
}
static const uint32_t kScopesPerPage = 1024;
}  // namespace wczsrc
#include "wcz_lod.cpp.inc"

// openFile(file, outsideWrites?): maps and opens a complete WCZ1 file (the name is the reader's; any WCZ1 file), or an
// FSDB file in place; outsideWrites "none" (FSDB only): its computed names get signals (window_compute.cpp.inc).
static void wczOpen(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 1) || !wargs::str(env, info[0])) return;
  const std::string file = info[0].As<Napi::String>().Utf8Value();
  const bool outsideNone = info.Length() > 1 && info[1].IsString() && info[1].As<Napi::String>().Utf8Value() == "none";
  closeFile();
  for (auto &kv : g_store) delete kv.second;  // (the previous file's stores: as cacheFree())
  g_store.clear();
  g_bytes = 0; g_blockReads = 0; g_blockAdvised = 0;  // (per open)
  if (const char *pe = getenv("WCB_PREFIX")) g_prefixOn = atoi(pe) != 0;
  if (const char *mb = getenv("WCB_BLOCK_LRU_MB")) g_lruCap = (size_t)std::max(0.0, atof(mb)) << 20;
  auto bad = [&](const std::string &m) { closeFile(); Napi::TypeError::New(env, m).ThrowAsJavaScriptException(); };
  const int fd = ::open(file.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) { bad(errno == ENOENT ? "wcz open: no such file" : "wcz open: the file cannot be read"); return; }
  g_f.fd = fd;
  struct stat sb;
  if (fstat(fd, &sb) != 0) { bad("wcz open: the file cannot be read"); return; }
  if (S_ISDIR(sb.st_mode)) { bad("Is directory, not a WCZ1 file."); return; }
  if (!S_ISREG(sb.st_mode) || sb.st_size < 8) { bad("not a WCZ1 file (too small)"); return; }  // (an FSDB header needs 8 bytes)
  void *m = mmap(nullptr, (size_t)sb.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (m == MAP_FAILED) { bad("could not map the file"); return; }
  g_f.map = (const uint8_t *)m;
  g_f.size = (size_t)sb.st_size;
  std::string err;
  if (dsrc::isPlanFile(g_f.map, g_f.size)) {  // read in place: the plan and the dictionary only, no values
    munmap((void *)g_f.map, g_f.size); g_f.map = nullptr; g_f.size = 0;
    if (!dsrc::open(file, err, outsideNone)) { bad(err); return; }
    g_f.direct = true;
  } else if (g_f.size < wcz::FHDR) { bad("not a WCZ1 file (too small)"); return; }  // (checked after the FSDB header: a short FSDB file goes to the direct path)
  else {
    // WISP_FOOTER_PREFETCH=0: the reader does not read every DATA footer ahead after open (each is read when a request
    // first needs it). =defer: the same advice as the default, issued from g_foot after open instead of inside it.
    // Default on, inside open (the reader's default, SYNC). Options for the pool-slot comparison; they change no result.
    const char *fpe = getenv("WISP_FOOTER_PREFETCH"); const bool fpDefer = fpe && !strcmp(fpe, "defer");
    g_f.rd.setFooterPrefetchMode(fpDefer ? wcz::SegReader::FOOTER_PREFETCH_DEFER : fpe && !strcmp(fpe, "0") ? wcz::SegReader::FOOTER_PREFETCH_OFF : wcz::SegReader::FOOTER_PREFETCH_SYNC);
    // WISP_BLOCK_READAHEAD=0: no WILLNEED before a block is decoded (default on: the reader's setBlockReadAhead
    // default, which the helper's own block reads below follow too)
    { const char *br = getenv("WISP_BLOCK_READAHEAD"); g_f.rd.setBlockReadAhead(br && !strcmp(br, "0") ? 0 : wcz::SegReader::BLOCK_READ_AHEAD); }
    { const char *ff = getenv("WISP_FOOTER_FD"); g_f.rd.setFooterFd(ff && !strcmp(ff, "0") ? -1 : g_f.fd); }  // footers by pread, not through the mapping (WISP_FOOTER_FD=0: the mapping)
    if (!g_f.rd.open(g_f.map, g_f.size, err)) { bad("WCZ1: " + err); return; }
    if (fpDefer && g_f.rd.complete()) {
      const wcz::SegReader *rp = &g_f.rd; g_foot.ranges = -1;
      const char *dl = getenv("WISP_TEST_FOOTER_DELAY_MS"); const long delay = dl ? atol(dl) : 0;
      g_foot.t = std::thread([rp, delay]() { if (delay > 0) std::this_thread::sleep_for(std::chrono::milliseconds(delay)); g_foot.ranges = (int64_t)rp->prefetchFooters(); });
    }
  }
  if (!g_f.direct) {
  if (!g_f.rd.complete()) {
    const std::string &why = g_f.rd.fastOpenError();
    if (why.empty() || why == "no trailer") { bad("WCZ1: an incomplete file (no trailer: a capture still running or interrupted) is not supported yet"); return; }
    bad("WCZ1: the file's INDEX was rejected (" + why + "); reading it without one is not supported yet"); return;
  }
  { std::string te; if (!g_f.rd.tEndCoversIndex(te)) { bad("WCZ1: " + te); return; } }  // (a Trailer t_end before the data: refused at open, as the checker refuses it)
  {
    const auto &d = g_f.rd.dumpOff();  // (the reader checked: alternating from off, non-decreasing t)
    for (size_t k = 0; k < d.size(); k++) {
      if (d[k].kind != 0) continue;
      File::Gap x; x.from = d[k].t;
      if (k + 1 < d.size() && d[k + 1].kind == 1) x.to = d[k + 1].t; else x.toEnd = true;
      g_f.gaps.push_back(x);
    }
  }
  }  // (!direct)
  const wcz::Dict &d = dictOf();
  const uint32_t ns = (uint32_t)d.scopes.size();
  g_f.kids.assign(ns, {}); g_f.arrays.assign(ns, {}); g_f.vars.assign(ns, {});
  g_f.skipped.assign(ns, {});
  for (uint32_t s = 0; s < ns; s++) {
    const uint32_t p = d.scopes[s].parent;
    const bool array = d.scopes[s].kind == 10;
    if (p == wcz::NONE32) { if (!array) g_f.top.push_back(s); }  // (a top array scope has no parent to list it)
    else (array ? g_f.arrays : g_f.kids)[p].push_back(s);
  }
  for (uint32_t v = 0; v < d.vars.size(); v++) {
    if (d.vars[v].state != wcz::VS_STORED) { g_f.skippedVars++; g_f.skipped[d.vars[v].scope].push_back(v); continue; }  // (kept)
    g_f.vars[d.vars[v].scope].push_back(v);
  }
  g_f.open = true;
  wczlod::init();
}

static void wczUnload(const Napi::CallbackInfo &info) { (void)info; wczsrc::closeFile(); wczlod::reset(); }

// readMetadata(meta(scopeCount, varCount, timescale, unit), chunk(chunkSize, timeEnd, timeStart))
static void wczReadMetadata(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 2)) return;
  if (!g_f.open) { Napi::Error::New(env, "no file open").ThrowAsJavaScriptException(); return; }
  wcz::FileHeader dh{};
  if (g_f.direct) { dh.tsExp = (int8_t)dsrc::tsExp(); dh.tsMult = 1; dh.tBegin = dsrc::tBegin(); }
  const wcz::FileHeader &h = g_f.direct ? dh : g_f.rd.header();
  // ts_mult x 10^ts_exp s as a digit and the unit at or below it (s ms us ns ps fs as)
  static const char *units[] = {"s", "ms", "us", "ns", "ps", "fs", "as"};
  const int e = h.tsExp, u = (-e + 2) / 3;  // unit 10^(-3u) <= 10^e
  uint32_t digit = h.tsMult;
  for (int k = e + 3 * u; k > 0; k--) digit *= 10;
  info[0].As<Napi::Function>().Call({Napi::Number::New(env, dictOf().scopes.size()), Napi::Number::New(env, dictOf().vars.size() - g_f.skippedVars),
                                     Napi::Number::New(env, digit), Napi::String::New(env, units[std::min(u, 6)])});
  info[1].As<Napi::Function>().Call({Napi::Number::New(env, 0), Napi::Number::New(env, (double)(g_f.direct ? dsrc::tEnd() : g_f.rd.horizon())), Napi::Number::New(env, (double)h.tBegin)});
}

static Napi::Value wczReadScopes(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  Napi::Array a = Napi::Array::New(env);
  if (!g_f.open) return a;
  for (uint32_t k = 0; k < g_f.top.size(); k++) a.Set(k, scopeObject(env, g_f.top[k]));
  return a;
}

static Napi::Value wczScopeChildren(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  Napi::Object r = Napi::Object::New(env);
  r.Set("scopes", Napi::Array::New(env, 0));
  r.Set("totalReturned", Napi::Number::New(env, 0));
  r.Set("remainingItems", Napi::Number::New(env, 0));
  if (!wargs::count(env, info, 2) || !wargs::num(env, info[0]) || !wargs::num(env, info[1]) || !g_f.open) return r;
  const uint32_t s = info[0].As<Napi::Number>().Uint32Value(), start = info[1].As<Napi::Number>().Uint32Value();
  if (s >= g_f.kids.size()) return r;
  const std::vector<uint32_t> &k = g_f.kids[s];
  if (start >= k.size()) return r;
  const uint32_t n = std::min<uint32_t>(kScopesPerPage, (uint32_t)k.size() - start);
  Napi::Array a = Napi::Array::New(env, n);
  for (uint32_t j = 0; j < n; j++) a.Set(j, scopeObject(env, k[start + j]));
  r.Set("scopes", a);
  r.Set("totalReturned", Napi::Number::New(env, n));
  r.Set("remainingItems", Napi::Number::New(env, (double)(k.size() - start - n)));
  return r;
}

// readVars(scopePath, scopeOffsetIdx, onVar, onArrayBegin, onArrayEnd, ...): as the reader's.
// onVar(name, type, encoding, scopePath, netlistId, signalId, width, msb, lsb); an array scope's
// vars come between onArrayBegin(name, scopePath, netlistId) and onArrayEnd(size).
// (an optional 8th argument (after the two placeholders) onSkipped(name, scopePath, netlistId, type, kind, state,
// width, msb, lsb, reason) also gets the vars that are not stored, each at its declaration-order place among the stored ones, with
// the file's reason text ("" = none); without it, as before.)
static void wczReadVars(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 5) || !wargs::str(env, info[0]) || !wargs::num(env, info[1]) || !g_f.open) return;
  const std::string path = info[0].As<Napi::String>().Utf8Value();
  const uint32_t s0 = info[1].As<Napi::Number>().Uint32Value();
  if (s0 >= g_f.vars.size()) return;
  Napi::Function onVar = info[2].As<Napi::Function>(), onBegin = info[3].As<Napi::Function>(), onEnd = info[4].As<Napi::Function>();
  const bool withSkipped = info.Length() > 7 && info[7].IsFunction();
  Napi::Function onSkipped = withSkipped ? info[7].As<Napi::Function>() : Napi::Function();
  const std::vector<uint32_t> noVars;
  const wcz::Dict &d = dictOf();
  const uint32_t nsc = (uint32_t)d.scopes.size();
  std::function<void(uint32_t, int)> walk = [&](uint32_t s, int depth) {
    const std::vector<uint32_t> &sv = g_f.vars[s], &kv = withSkipped ? g_f.skipped[s] : noVars;  // (merged by index)
    for (size_t i = 0, j = 0; i < sv.size() || j < kv.size();) {
      if (j < kv.size() && (i >= sv.size() || kv[j] < sv[i])) {
        const wcz::VarE &x = d.vars[kv[j++]];
        onSkipped.Call({Napi::String::New(env, d.strs[x.name]), Napi::String::New(env, path), Napi::Number::New(env, (double)nsc + kv[j - 1]),
                        Napi::Number::New(env, x.type), Napi::Number::New(env, x.kind), Napi::Number::New(env, x.state), Napi::Number::New(env, x.width()),
                        Napi::Number::New(env, x.msb), Napi::Number::New(env, x.lsb), Napi::String::New(env, reasonOf(kv[j - 1]))});
        if (env.IsExceptionPending()) return;
        continue;
      }
      const uint32_t v = sv[i++];
      const wcz::VarE &x = d.vars[v];
      const char *type = x.type == 5 ? "real" : x.type == 6 ? "string" : x.type == 2 ? "integer" : x.kind == 0 ? "wire" : "reg";
      const char *enc = x.type == 5 ? "Real" : x.type == 6 ? "String" : "BitVector";
      onVar.Call({Napi::String::New(env, d.strs[x.name]), Napi::String::New(env, type), Napi::String::New(env, enc), Napi::String::New(env, path),
                  Napi::Number::New(env, (double)nsc + v), Napi::Number::New(env, (double)x.signal + 1), Napi::Number::New(env, x.width()),
                  Napi::Number::New(env, x.msb), Napi::Number::New(env, x.lsb)});
      if (env.IsExceptionPending()) return;
    }
    if (depth >= 16) return;
    for (uint32_t a : g_f.arrays[s]) {
      onBegin.Call({Napi::String::New(env, d.strs[d.scopes[a].name]), Napi::String::New(env, path), Napi::Number::New(env, a)});
      walk(a, depth + 1);
      onEnd.Call({Napi::Number::New(env, (double)(g_f.vars[a].size() + g_f.arrays[a].size()))});
      if (env.IsExceptionPending()) return;
    }
  };
  walk(s0, 0);
}

// readVarsCols(scopeOffsetIdx) -> {n, names, sig, width, msb, lsb, type}: the vars readVars would
// give onVar for this scope (its array scopes' vars inline, in the same order, the same depth cap),
// as columns in one call: names joined by '\0' (n of them), sig (signalId) Float64Array, width
// Uint32Array, msb/lsb Int32Array, type Uint8Array (0 wire, 1 reg, 2 integer, 5 real, 6 string;
// encoding Real for 5, String for 6, else BitVector). The index build makes one call per scope
// instead of one JS call per var (~79.5K on a big dump).
static Napi::Value wczReadVarsCols(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 1) || !wargs::num(env, info[0]) || !g_f.open) return env.Null();
  const uint32_t s0 = info[0].As<Napi::Number>().Uint32Value();
  if (s0 >= g_f.vars.size()) return env.Null();
  const wcz::Dict &d = dictOf();
  std::vector<uint32_t> vs;
  std::function<void(uint32_t, int)> walk = [&](uint32_t s, int depth) {
    for (uint32_t v : g_f.vars[s]) vs.push_back(v);
    if (depth >= 16) return;
    for (uint32_t a : g_f.arrays[s]) walk(a, depth + 1);
  };
  walk(s0, 0);
  const size_t n = vs.size();
  std::string names;
  Napi::Float64Array sig = Napi::Float64Array::New(env, n);
  Napi::Uint32Array width = Napi::Uint32Array::New(env, n);
  Napi::Int32Array msb = Napi::Int32Array::New(env, n), lsb = Napi::Int32Array::New(env, n);
  Napi::Uint8Array type = Napi::Uint8Array::New(env, n);
  for (size_t i = 0; i < n; i++) {
    const wcz::VarE &x = d.vars[vs[i]];
    if (i) names.push_back('\0');
    names += d.strs[x.name];
    sig[i] = (double)x.signal + 1;
    width[i] = x.width();
    msb[i] = x.msb; lsb[i] = x.lsb;
    type[i] = x.type == 5 ? 5 : x.type == 6 ? 6 : x.type == 2 ? 2 : x.kind == 0 ? 0 : 1;
  }
  Napi::Object o = Napi::Object::New(env);
  o.Set("n", Napi::Number::New(env, (double)n));
  o.Set("names", Napi::String::New(env, names));
  o.Set("sig", sig); o.Set("width", width); o.Set("msb", msb); o.Set("lsb", lsb); o.Set("type", type);
  return o;
}

// sourceInfo() -> {source: 'wcz', caps, signals, blocks, complete, skippedVars, blockLru}
// sourceInfo().zstd: {version, own}. own: the address this object's code calls for
// ZSTD_decompressDCtx (through its GOT when the symbol is interposable) lies in this object, i.e.
// no other zstd in the process (another library's copy) took the binding. version: what the bound copy reports.
static Napi::Object zstdInfo(Napi::Env env) {
  Napi::Object z = Napi::Object::New(env);
  Dl_info a{}, b{};
  void *fn = reinterpret_cast<void *>(&ZSTD_decompressDCtx), *self = reinterpret_cast<void *>(&zstdInfo);
  const bool own = dladdr(fn, &a) && dladdr(self, &b) && a.dli_fbase == b.dli_fbase;
  z.Set("version", Napi::Number::New(env, (double)ZSTD_versionNumber()));
  z.Set("own", Napi::Boolean::New(env, own));
  return z;
}

// checkFile() -> "" or why the file is refused: for a file read directly, waits for the whole-file check (values are
// served only after it; dsrc::waitVerified); "" for a WCZ file.
static Napi::Value wczCheckFile(const Napi::CallbackInfo &info) {
  std::string e;
  if (wczsrc::g_f.open && wczsrc::g_f.direct) dsrc::waitVerified(e);
  return Napi::String::New(info.Env(), e);
}
// checkNow() -> {lazy, state, idleMs}: for a file read directly with the lazy open, the whole-file check's state when
// asked: 1 passed (an answer built now is verified), 0 running, 2 refused, 4 not started yet (WISP_VERIFY_START);
// refusedMs = ms from open to the refusal; idleMs = the idle wait before a deferred check starts (-1: none).
static Napi::Value wczCheckNow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env(); Napi::Object o = Napi::Object::New(env);
  const bool lz = wczsrc::g_f.open && wczsrc::g_f.direct && dsrc::lazyMode();
  o.Set("lazy", Napi::Boolean::New(env, lz)); o.Set("state", Napi::Number::New(env, lz ? dsrc::checkNow() : 1));
  if (lz) o.Set("refusedMs", Napi::Number::New(env, dsrc::refusedAfterMs()));
  o.Set("idleMs", Napi::Number::New(env, lz ? dsrc::verifyIdleMs() : -1));
  return o;
}
// verifyStart() -> bool: a deferred whole-file check (WISP_VERIFY_START) starts now in the background; false if none
// was pending
static Napi::Value wczVerifyStart(const Napi::CallbackInfo &info) {
  const bool lz = wczsrc::g_f.open && wczsrc::g_f.direct && dsrc::lazyMode();
  return Napi::Boolean::New(info.Env(), lz && dsrc::verifyStart());
}
// the helper's main registers the function that writes the withdrawal line (same binary, C linkage)
extern "C" void wisp_set_refuse_hook(dsrc::wisp_refuse_fn f) { dsrc::g_onRefuse = f; }
static Napi::Value wczSourceInfo(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  if (info.Length() > 0 && info[0].IsNumber() && info[0].As<Napi::Number>().DoubleValue() == 1) g_foot.join();  // stats: the deferred count is final
  Napi::Object o = Napi::Object::New(env);
  o.Set("source", Napi::String::New(env, g_f.direct ? "fsdb" : "wcz"));
  Napi::Object c = sourceCaps(env);
  c.Set("tiles", Napi::Boolean::New(env, true));
  c.Set("lod", Napi::Boolean::New(env, g_f.open && wczlod::g_nsig > 0));  // (stored LOD levels: lodWindow)
  o.Set("caps", c);
#ifdef WISP_DIRECT
  o.Set("directThreads", Napi::Number::New(env, (double)dsrc::workThreads()));  // the FSDB open-scan / check thread default
#endif
  if (g_f.open) {
    o.Set("signals", Napi::Number::New(env, nSigs()));
    o.Set("blocks", Napi::Number::New(env, (double)(g_f.direct ? dsrc::records() : g_f.rd.nBlocks())));
    o.Set("complete", Napi::Boolean::New(env, g_f.direct ? true : g_f.rd.complete()));
    if (g_f.direct) {  // the whole-file check before values: "running", "ok" or "refused", its time (ms) and signals done
      const auto v = dsrc::verifyState();
      o.Set("check", Napi::String::New(env, v.state == 0 ? "running" : v.state == 1 ? "ok" : v.state == 3 ? "lazy" : v.state == 4 ? "deferred" : "refused"));
      o.Set("openMode", Napi::String::New(env, dsrc::lazyMode() ? "lazy" : "verified")); if (dsrc::lazyMode()) o.Set("refusedMs", Napi::Number::New(env, dsrc::refusedAfterMs()));
      o.Set("checkMs", Napi::Number::New(env, v.ms)); o.Set("checkDone", Napi::Number::New(env, (double)v.done));
      o.Set("checkCpuMs", Napi::Number::New(env, v.cpuMs)); o.Set("checkThreads", Napi::Number::New(env, v.threads));
      o.Set("checkStart", Napi::String::New(env, dsrc::verifyStartName()));  // WISP_VERIFY_START: open, idle or request
      o.Set("portLinks", Napi::Boolean::New(env, dsrc::portLinks())); o.Set("fullScope", Napi::Boolean::New(env, dsrc::fullScope()));  // the open's link options (WISP_PORT_LINKS, WISP_FULL_SCOPE, WISP_FORCE_LOG)
      o.Set("forceLog", Napi::Boolean::New(env, dsrc::forceLog()));
#ifdef WISP_DIRECT
      if (dsrc::g_cOn) {  // computed signals: count, the per-open build (ms; its reason if none is computed) and the requests
        Napi::Object cc = Napi::Object::New(env);
        cc.Set("signals", Napi::Number::New(env, dsrc::nComputed())); cc.Set("firstId", Napi::Number::New(env, dsrc::nStoredTyped() + 1)); cc.Set("built", Napi::Boolean::New(env, (bool)dsrc::g_cx));
        cc.Set("buildMs", Napi::Number::New(env, dsrc::g_cxMs)); if (!dsrc::g_cxErr.empty()) cc.Set("refused", Napi::String::New(env, dsrc::g_cxErr));
        cc.Set("requests", Napi::Number::New(env, (double)dsrc::g_cst.requests)); cc.Set("names", Napi::Number::New(env, (double)dsrc::g_cst.names));
        cc.Set("ok", Napi::Number::New(env, (double)dsrc::g_cst.ok)); cc.Set("refusedNames", Napi::Number::New(env, (double)dsrc::g_cst.refused));
        cc.Set("rows", Napi::Number::New(env, (double)dsrc::g_cst.rows)); cc.Set("memoryDrops", Napi::Number::New(env, (double)dsrc::g_cst.drops));
        cc.Set("lastMs", Napi::Number::New(env, dsrc::g_cst.lastMs)); cc.Set("lastBuildMs", Napi::Number::New(env, dsrc::g_cst.lastParseMs));
        o.Set("computed", cc);
      }
#endif
    }
    if (!g_f.direct) {  // block reads that reached the decoder (LRU misses) and how many of them were advised WILLNEED
      o.Set("blockReads", Napi::Number::New(env, (double)g_blockReads.load()));
      o.Set("blockReadAheads", Napi::Number::New(env, (double)g_blockAdvised.load()));
      o.Set("footerRead", Napi::String::New(env, g_f.rd.footerFd() >= 0 ? "pread" : "map"));
      { const auto m = g_f.rd.footerPrefetchMode(); o.Set("footerPrefetch", Napi::String::New(env, m == wcz::SegReader::FOOTER_PREFETCH_DEFER ? "defer" : m == wcz::SegReader::FOOTER_PREFETCH_OFF ? "off" : "sync")); }
      o.Set("footerRangesDeferred", Napi::Number::New(env, (double)g_foot.ranges.load()));
    }
    o.Set("skippedVars", Napi::Number::New(env, g_f.skippedVars));
    if (!g_f.gaps.empty()) {  // (only a file with capture epochs has the key)
      Napi::Array ga = Napi::Array::New(env);
      for (uint32_t k = 0; k < g_f.gaps.size(); k++) {
        Napi::Object x = Napi::Object::New(env);
        x.Set("from", Napi::Number::New(env, (double)g_f.gaps[k].from));
        if (g_f.gaps[k].toEnd) x.Set("toEnd", Napi::Boolean::New(env, true)); else x.Set("to", Napi::Number::New(env, (double)g_f.gaps[k].to));
        ga.Set(k, x);
      }
      o.Set("gaps", ga);
    }
  }
  Napi::Object l = Napi::Object::New(env);
  l.Set("bytes", Napi::Number::New(env, (double)g_lruBytes));
  l.Set("capBytes", Napi::Number::New(env, (double)g_lruCap));
  l.Set("blocks", Napi::Number::New(env, (double)g_lru.size()));
  l.Set("hits", Napi::Number::New(env, (double)g_lruHits));
  l.Set("misses", Napi::Number::New(env, (double)g_lruMisses));
  l.Set("prefixReads", Napi::Number::New(env, (double)g_prefixReads.load()));
  l.Set("wholeReads", Napi::Number::New(env, (double)g_wholeReads.load()));
  l.Set("prefixTimeRows", Napi::Number::New(env, (double)g_prefixTimeRows.load()));
  l.Set("prefixValueRows", Napi::Number::New(env, (double)g_prefixValueRows.load()));
  l.Set("prefixRowsOut", Napi::Number::New(env, (double)g_prefixRowsOut.load()));
  o.Set("blockLru", l);
  o.Set("lod", lodInfo(env));
  o.Set("zstd", zstdInfo(env));
  { Napi::Object m = srcMemory(env); m.Set("scratch", Napi::Number::New(env, (double)wczsrc::scratchBytes())); m.Set("scratchPeak", Napi::Number::New(env, (double)wczsrc::g_scratchPeak.load())); m.Set("bigBytes", Napi::Number::New(env, (double)kBigBytes)); o.Set("memory", m); }
  return o;
}

// sourceVerify() -> {ok, changes} | {ok: false, error}: the container reader's full check (every
// segment checksum, every footer entry, every block decoded with its nNorm and stream hash).
// sourceRelease() -> {lruBytes, scratchBytes, mapBytes}: an idle worker gives back what refills on demand: the
// decoded-block LRU, the decode scratch, and the mapped file's resident pages (they read back from the file).
// The store's rows stay. The helper calls it after WISP_IDLE_RELEASE_MS without a request.
static Napi::Value wczSourceRelease(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  const size_t lru = [] { std::lock_guard<std::mutex> lk(g_lruMu); return g_lruBytes; }(), scratch = scratchBytes();
  lruClear();
  scratchRelease(0);
  size_t mapped = 0;
  if (g_f.map && g_f.size) {
    mapped = g_f.size;
    madvise((void *)g_f.map, g_f.size, MADV_DONTNEED);  // (read-only file mapping: pages fault back in from the file)
  }
  if (lru) srcFreed(lru);
#ifdef WISP_DIRECT
  size_t direct = 0;
  if (dsrc::g_on && dsrc::g_file) direct = dsrc::g_file->drop_cache();  // (an FSDB read in place: the reader's block cache)
  if (direct) srcFreed(direct);
  o.Set("directCacheBytes", Napi::Number::New(env, (double)direct));
#endif
  srcTrim();
  o.Set("lruBytes", Napi::Number::New(env, (double)lru));
  o.Set("scratchBytes", Napi::Number::New(env, (double)scratch));
  o.Set("mapBytes", Napi::Number::New(env, (double)mapped));
  return o;
}

static Napi::Value wczSourceVerify(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  std::string err;
  uint64_t n = 0;
  if (g_f.direct) err = "verify reads WCZ files only";
  const bool ok = g_f.open && !g_f.direct && ensureCtx(err) && g_f.rd.verify(g_zd, err, &n);
  o.Set("ok", Napi::Boolean::New(env, ok));
  if (ok) o.Set("changes", Napi::Number::New(env, (double)n));
  else o.Set("error", Napi::String::New(env, g_f.open ? err : "no file open"));
  return o;
}

// verifyFile() -> {ok, error?, ms}: a file read directly gets the whole-file check now (the converter's checks
// on every stored record); a WCZ file gets the reader's verify
static Napi::Value wczVerifyFile(const Napi::CallbackInfo &info) {
  using namespace wczsrc;
  Napi::Env env = info.Env(); Napi::Object o = Napi::Object::New(env);
  const auto t0 = std::chrono::steady_clock::now(); std::string err; bool ok = false;
  if (!g_f.open) err = "no file open";
  else if (g_f.direct) { err = dsrc::verifyNow(); ok = err.empty(); }
  else { uint64_t n = 0; ok = ensureCtx(err) && g_f.rd.verify(g_zd, err, &n); }
  o.Set("ok", Napi::Boolean::New(env, ok)); if (!ok) o.Set("error", Napi::String::New(env, err));
  o.Set("ms", Napi::Number::New(env, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count()));
  return o;
}
// computedPrepare(ids[], t0, t1, budgetBytes, threads): the computed signals among ids evaluated over [t0, t1] (each
// answers its rows or its reason in the window that follows); nothing for other ids or a WCZ file
static Napi::Value wczComputedPrepare(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!wargs::count(env, info, 5) || !wargs::arr(env, info[0])) return env.Undefined();
#ifdef WISP_DIRECT
  if (wczsrc::g_f.open && wczsrc::g_f.direct && dsrc::g_cOn) {
    uint64_t t0 = argTime(info[1]), t1 = argTime(info[2]); if (t1 < t0) std::swap(t0, t1);
    try { dsrc::computedPrepare(argIds(info[0]), t0, t1, info[3].As<Napi::Number>().DoubleValue(), (unsigned)std::max(1.0, info[4].As<Napi::Number>().DoubleValue())); }
    catch (const std::exception &e) { Napi::Error::New(env, std::string("computed rows: ") + e.what()).ThrowAsJavaScriptException(); return env.Undefined(); }
  }
#endif
  return env.Undefined();
}
// computedDone(): the window request is answered; its computed rows are dropped
static Napi::Value wczComputedDone(const Napi::CallbackInfo &info) {
#ifdef WISP_DIRECT
  dsrc::computedDone();
#endif
  return info.Env().Undefined();
}
static void wczExports(Napi::Env env, Napi::Object exports) {
  exports.Set("computedPrepare", Napi::Function::New(env, wczComputedPrepare));
  exports.Set("computedDone", Napi::Function::New(env, wczComputedDone));
  exports.Set("verifyFile", Napi::Function::New(env, wczVerifyFile));
  exports.Set("checkNow", Napi::Function::New(env, wczCheckNow));
  exports.Set("verifyStart", Napi::Function::New(env, wczVerifyStart));
  exports.Set("openFile", Napi::Function::New(env, wczOpen));
  exports.Set("unload", Napi::Function::New(env, wczUnload));
  exports.Set("readMetadata", Napi::Function::New(env, wczReadMetadata));
  exports.Set("readScopes", Napi::Function::New(env, wczReadScopes));
  exports.Set("getScopeChildren", Napi::Function::New(env, wczScopeChildren));
  exports.Set("readVars", Napi::Function::New(env, wczReadVars));
  exports.Set("readVarsCols", Napi::Function::New(env, wczReadVarsCols));
  exports.Set("sourceInfo", Napi::Function::New(env, wczSourceInfo));
  exports.Set("checkFile", Napi::Function::New(env, wczCheckFile));
  exports.Set("sourceVerify", Napi::Function::New(env, wczSourceVerify));
  exports.Set("sourceRelease", Napi::Function::New(env, wczSourceRelease));
  exports.Set("lodWindow", Napi::Function::New(env, wczLodWindow));
}
