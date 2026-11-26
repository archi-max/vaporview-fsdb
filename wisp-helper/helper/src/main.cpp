// SPDX-License-Identifier: MIT
// The Wisp helper for WCZ files, in one process, speaking the helper protocol (JSON lines in, replies on fd 3).
//
// Shape:
//   - a reader thread takes stdin lines, parses them and queues them; it settles `cancel` requests against the queue
//     and the request in flight as they arrive;
//   - the command thread answers the queue in order, one request at a time, and writes every reply (fd 3, else stdout);
//   - a fixed pool (pool.h) fans out the rows of one window (and of one valueAt) across threads; each row is answered
//     straight from the file's blocks by the library (cacheWindowCold / coldValueAt / coldValueNear), whose decoded-block
//     LRU is one bounded cache for the whole process. Nothing keeps a row's decoded history after its answer.
//   - a dense bit row (>= WISP_SPLIT_MIN expected changes in the window, 262144) is also split in time across the pool
//     at cut points where the sub-windows' bucket bounds equal the window's, and the sub-answers are merged exactly
//     (mergeSplit; anything unexpected falls back to one unsplit call);
//   - idle release: after WISP_IDLE_RELEASE_MS (default 30000; 0 = never) without a request, the command thread gives
//     back what refills on demand (the library's sourceRelease: the decoded-block LRU, the decode scratch, the mapped
//     file's resident pages, an FSDB reader's block cache), as the viewer's earlier helper did after an idle spell.
//   - finished row answers (deflated, bounded 32 MB, LRU) are kept for repeated identical windows; free/close drop them;
//   - text rows answered whole (strings/reals outside a ranged window) and the store-based calls run on the command
//     thread only, so the library's store map is never used concurrently.
//   - memory bounds: the per-row cap and the process hard bound (cacheSetBounds) and the rows-held limit
//     (cacheSetLimit) are set at each open; a split row's merged answer is checked against the cap as the unsplit answer
//     would be, and one that might be over is answered unsplit (so the library's own refusal is the reply); loading
//     commands are refused while the process RSS is over twice the inner bound.
// Thread safety of the library: a per-thread zstd context and decode scratch, a lock on the block LRU and on the
// freed-bytes counter. The reader (wcz_seg.h) is safe for concurrent const reads.
#include <napi.h>
#include "json.h"
#include "util.h"
#include "js.h"
#include "pool.h"
#include <zlib.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <mach/mach.h>
#endif
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <list>
#include <functional>
#include <map>
#include <tuple>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using Napi::T;
using Napi::Value;

// ================================================================ the library's exports
namespace lib {
struct Fns {
  Napi::Function openFile, unload, readMetadata, readScopes, getScopeChildren, readVars, readVarsCols, sourceInfo, sourceCount,
      cacheWindowCold, cacheWindow, cacheLoad, coldValueAt, coldValueNear, cacheValueAt, cacheLastChange, searchScan, cacheEdge,
      cacheFree, cacheStats, lodWindow, cacheSetBounds, cacheSetLimit, cacheSearch, checkFile, verifyFile, checkNow, sourceRelease,
      cacheDerive, knownSignals, computedPrepare, computedDone, verifyStart;
};
static Fns F;
static void bind() {
  Napi::Object ex = napi_shim::shim_exports();
  auto g = [&](const char *n) {
    Value v = ex.Get(n);
    if (!v.IsFunction()) { fprintf(stderr, "wisp-helper: the library has no export %s\n", n); exit(70); }
    return v.As<Napi::Function>();
  };
  F.openFile = g("openFile"); F.unload = g("unload"); F.readMetadata = g("readMetadata"); F.readScopes = g("readScopes");
  F.getScopeChildren = g("getScopeChildren"); F.readVars = g("readVars"); F.readVarsCols = g("readVarsCols");
  F.sourceInfo = g("sourceInfo"); F.sourceCount = g("sourceCount"); F.cacheWindowCold = g("cacheWindowCold");
  F.cacheWindow = g("cacheWindow"); F.cacheLoad = g("cacheLoad"); F.coldValueAt = g("coldValueAt"); F.coldValueNear = g("coldValueNear");
  F.cacheValueAt = g("cacheValueAt"); F.cacheLastChange = g("cacheLastChange"); F.searchScan = g("searchScan"); F.cacheEdge = g("cacheEdge");
  F.cacheFree = g("cacheFree"); F.cacheStats = g("cacheStats"); F.lodWindow = g("lodWindow");
  F.cacheSetBounds = g("cacheSetBounds"); F.cacheSetLimit = g("cacheSetLimit"); F.cacheSearch = g("cacheSearch");
  F.checkFile = g("checkFile"); F.verifyFile = g("verifyFile"); F.checkNow = g("checkNow"); F.sourceRelease = g("sourceRelease");
  F.cacheDerive = g("cacheDerive"); F.knownSignals = g("knownSignals"); F.computedPrepare = g("computedPrepare"); F.computedDone = g("computedDone");
  F.verifyStart = g("verifyStart");
}
// One call; a thrown error (the thread's pending exception) comes back in err, the value is then undefined.
static Value call(const Napi::Function &f, const std::vector<Value> &a, std::string *err = nullptr) {
  Napi::pending().on = false;
  Value r = f.Call(a);
  if (Napi::pending().on) { if (err) *err = Napi::pending().msg; Napi::pending().on = false; return Value(); }
  return r;
}
static Value N(double d) { return Napi::Number::New(Napi::Env(), d); }
static Value S(const std::string &s) { return Napi::String::New(Napi::Env(), s); }
static Value Ids(const std::vector<int64_t> &ids) {
  Napi::Array a = Napi::Array::New(Napi::Env(), ids.size());
  for (size_t i = 0; i < ids.size(); i++) a.Set((uint32_t)i, N((double)ids[i]));
  return a;
}
static Value Fn(std::function<Value(const Napi::CallbackInfo &)> f) { return Napi::Function::New(Napi::Env(), std::move(f)); }
}  // namespace lib
using lib::N;
using lib::S;

// ================================================================ settings
struct Settings {
  bool wcb = true;  // WCZ files open by default; --wcb is still accepted (no-op)
  int workers = 4;
  double textBudget = 16.0 * 1048576;
  double coldRange = 0.25;
  bool lodEnv = true;
  double cacheBytes = 1024e6;  // CACHE_BYTES (the memory bounds)
  bool cacheGiven = false;     // --cache-mb or WISP_CACHE_MB
  unsigned threads = 1;
};
static Settings g_set;

static double nowMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

// ================================================================ output
static int g_out = 1;
static std::mutex g_outMu;
static void writeAll(const char *p, size_t n) {
  while (n) {
    const ssize_t w = ::write(g_out, p, n);
    if (w < 0) { if (errno == EINTR) continue; return; }
    p += w; n -= (size_t)w;
  }
}
static void emitLine(std::string line, const std::string *bin = nullptr) {
  line += '\n';
  std::lock_guard<std::mutex> lk(g_outMu);
  if (bin && !bin->empty()) { line += *bin; }
  writeAll(line.data(), line.size());
}
static void idKey(std::string &o, const Value &id) {  // `"id":<id>,` (left out when the request had none)
  if (js::undef(id)) return;
  o += "\"id\":"; js::jval(o, id); o += ',';
}

struct Reply {
  bool ok = true;
  std::string result;   // the result object's JSON
  std::string error, code;
  std::string bin;      // binary payload
  bool noMs = false;    // (cancel)
  int verified = -1;    // (lazy FSDB open) 1/0 = the whole-file check had / had not passed when the answer was built
  std::string raw;      // a whole reply line written as is
};
// the prefix of an open error for an FSDB file the converter refuses as a whole (lib/addon/direct_source.cpp.inc)
static const std::string FILE_REFUSED = "this FSDB file cannot be read directly: ";
static Reply err(const std::string &e, const std::string &code = "") { Reply r; r.ok = false; r.error = e; r.code = code; return r; }
static Reply res(std::string json) { Reply r; r.result = std::move(json); return r; }

// Lazy FSDB open (the default; WISP_DIRECT_OPEN=full turns it off): answers built before the background whole-file check passed carry
// "verified":false. When the check refuses the file, one line {"event":"fileRefused",...,"withdrawn":N} withdraws the N
// answers sent with verified:false since the open; no value answer is sent after it (g_wd: count and line in one order).
static std::mutex g_wdMu;
static uint64_t g_wdCount = 0; static bool g_wdSent = false; static std::string g_wdWhy;
static void wdReset() { std::lock_guard<std::mutex> l(g_wdMu); g_wdCount = 0; g_wdSent = false; g_wdWhy.clear(); }
extern "C" { typedef void (*wisp_refuse_fn)(const char *, double); void wisp_set_refuse_hook(wisp_refuse_fn f); }
static void onRefuse(const char *why, double msAfterOpen) {
  std::lock_guard<std::mutex> l(g_wdMu);
  if (g_wdSent) return;
  g_wdSent = true; g_wdWhy = why;
  std::string o = "{\"event\":\"fileRefused\",\"error\":"; js::jstr(o, g_wdWhy); o += ",\"code\":\"fileRefused\",\"withdrawn\":";
  js::jnum(o, (double)g_wdCount); o += ",\"msAfterOpen\":"; js::jnum(o, js::toFixed(msAfterOpen, 3)); o += '}';
  emitLine(o);
}
static void emitReply(const Value &id, const Reply &r0, double ms);
static void emitReplyOne(const Value &id, const Reply &r, double ms);
static void emitReply(const Value &id, const Reply &r0, double ms) {
  if (r0.ok && r0.verified == 0) {  // an unverified answer: counted and sent before any withdrawal line, or refused after it
    std::lock_guard<std::mutex> l(g_wdMu);
    if (g_wdSent) { Reply e; e.ok = false; e.error = g_wdWhy; e.code = "fileRefused"; emitReplyOne(id, e, ms); return; }
    g_wdCount++; emitReplyOne(id, r0, ms); return;
  }
  emitReplyOne(id, r0, ms);
}
static void emitReplyOne(const Value &id, const Reply &r, double ms) {
  if (!r.raw.empty()) { emitLine(r.raw); return; }
  std::string o = "{";
  idKey(o, id);
  if (!r.ok) {
    o += "\"error\":"; js::jstr(o, r.error);
    // a file the converter refuses as a whole (found at open, or by the whole-file check before any value): fileRefused
    const std::string code = !r.code.empty() ? r.code : r.error.find(FILE_REFUSED) != std::string::npos ? std::string("fileRefused") : std::string();
    if (!code.empty()) { o += ",\"code\":"; js::jstr(o, code); }
    o += '}';
    emitLine(o);
    return;
  }
  o += "\"result\":"; o += r.result;
  if (r.verified >= 0) o += r.verified ? ",\"verified\":true" : ",\"verified\":false";
  if (!r.noMs) { o += ",\"ms\":"; js::jnum(o, js::toFixed(ms, 3)); }
  if (!r.bin.empty()) { o += ",\"binLength\":"; js::jnum(o, (double)r.bin.size()); }
  o += '}';
  emitLine(o, &r.bin);
}

// ================================================================ raw deflate (RFC 1951)
static std::string deflateRaw(const std::string &in) {
  z_stream z;
  memset(&z, 0, sizeof z);
  if (deflateInit2(&z, 1, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) != Z_OK) return std::string();
  std::string out;
  out.resize(deflateBound(&z, in.size()) + 16);
  z.next_in = (Bytef *)in.data(); z.avail_in = (uInt)in.size();
  z.next_out = (Bytef *)&out[0]; z.avail_out = (uInt)out.size();
  deflate(&z, Z_FINISH);
  out.resize(z.total_out);
  deflateEnd(&z);
  return out;
}

static std::string inflateRaw(const std::string &in) {
  z_stream z;
  memset(&z, 0, sizeof z);
  if (inflateInit2(&z, -15) != Z_OK) return std::string();
  std::string out;
  char buf[1 << 16];
  z.next_in = (Bytef *)in.data(); z.avail_in = (uInt)in.size();
  for (;;) {
    z.next_out = (Bytef *)buf; z.avail_out = sizeof buf;
    const int r = inflate(&z, Z_NO_FLUSH);
    out.append(buf, sizeof buf - z.avail_out);
    if (r != Z_OK) break;
  }
  inflateEnd(&z);
  return out;
}

// ================================================================ per-file state
struct Ident { bool ok = false; std::string real; double dev = 0, ino = 0, size = 0, mtimeMs = 0, ctimeMs = 0; };
static Ident identOf(const std::string &file) {
  Ident id;
  bool ok;
  id.real = wutil::realPath(file, ok);
  if (!ok) return id;
  wutil::Stat st = wutil::statOf(id.real);
  if (!st.ok) return id;
  id.ok = true; id.dev = st.dev; id.ino = st.ino; id.size = st.size; id.mtimeMs = st.mtimeMs; id.ctimeMs = st.ctimeMs;
  return id;
}
static bool sameIdent(const Ident &a, const Ident &b) {
  return a.ok && b.ok && a.real == b.real && a.dev == b.dev && a.ino == b.ino && a.size == b.size && a.mtimeMs == b.mtimeMs && a.ctimeMs == b.ctimeMs;
}

struct FileState {
  bool open = false;
  Ident ident;
  double want = 0;
  std::string outsideWrites;  // the open statement ("none" or "")
  int64_t computedFirst = 0, computedN = 0;  // computed signal ids [computedFirst, computedFirst + computedN)
  std::string resultHead;  // the open result up to (not including) "index"
  bool lod = false, gaps = false;
  double timeStart = 0, timeEnd = 0;
  uint32_t nSignals = 0;
  // scope merging: a listed scope's members (itself first), for the life of the open
  std::unordered_map<double, std::vector<double>> members;
  // the hierarchy's signal ids, built on first use
  bool knownBuilt = false;
  std::vector<uint8_t> known;
  // rows that keep answering an error
  std::unordered_map<int64_t, std::string> sticky;
  // sticky errors found by the request in flight: kept only when it completes (a cancelled request remembers nothing)
  std::vector<std::pair<int64_t, std::string>> pendSticky;
  // each row's first sourceCount answer of the open: what count reports (the INDEX's count; later block read
  // failures don't change it)
  std::unordered_map<int64_t, Value> firstCount;
  // capture gaps: unseen changes at [f + 1, E); `json` = the library's entry, as listed
  struct Gap { double f = 0, u = 0; bool toEnd = false; double E = 0; std::string json; };
  std::vector<Gap> gapList;
  std::map<std::tuple<int64_t, double, double>, double> unseenMemo;  // a row's changes in [a, b)
  std::unordered_map<int64_t, double> winDensity;  // the highest changes / time a row's windows have shown
  // derived signals (derive): id (from 1e9) -> definition; the same program over the same operands -> the same id
  struct DNodeDef { int op = 0; uint32_t w = 1; int a = -1, b = -1, k = -1; std::string bits; };
  struct Derived { std::vector<DNodeDef> program; std::vector<int64_t> operands; uint32_t width = 1; std::string expr; };
  std::map<int64_t, Derived> derived;
  std::map<std::string, int64_t> derivedByKey;
  int64_t nextDerived = 1000000000;
};
static FileState g_f;
static bool isDerived(int64_t id) { return id >= 1000000000 && g_f.derived.count(id) > 0; }

static void clearAnswers();
static void closeFile() {
  clearAnswers();
  if (g_f.open) { lib::call(lib::F.cacheFree, {}); lib::call(lib::F.unload, {}); }
  g_f = FileState();
}

// ================================================================ hierarchy
// The scopes the hierarchy leaves out, by exact name, with everything under them: the class-object roots and the
// class structure under them, and the converter's own scope for value IDs no declaration names. Every other scope
// is listed, a `$` name too (tools name unnamed blocks that way). The library's knownSignals uses the same names
// (lib/addon/known_ids.cpp.inc).
static bool dollar(const std::string &n) {
  return n == "$object_root" || n == "$trans_root" || n == "$hidden_class" || n == "$unreferenced_value_ids";
}

// Merge scope objects into a list: the reserved scopes (dollar) left out, a repeated name joins the first one's members.
struct ScopeList {
  std::vector<Value> listed;
  std::unordered_map<std::string, double> byName;
  void add(const Value &sc) {
    const std::string name = js::String(js::get(sc, "name"));
    if (dollar(name)) return;
    const double idx = js::num(js::get(sc, "scopeOffsetIdx"));
    auto it = byName.find(name);
    if (it == byName.end()) {
      byName.emplace(name, idx);
      listed.push_back(sc);
      auto &m = g_f.members[idx];
      if (m.empty()) m.push_back(idx);
      return;
    }
    auto &m = g_f.members[it->second];
    if (m.empty()) m.push_back(it->second);
    if (std::find(m.begin(), m.end(), idx) == m.end()) m.push_back(idx);
  }
};
static std::vector<double> membersOf(double idx) {
  auto it = g_f.members.find(idx);
  if (it != g_f.members.end() && !it->second.empty()) return it->second;
  return {idx};
}
// getScopeChildren pages of one scope: until totalReturned is 0 or remainingItems <= 0, at most 256 pages
template <class F> static void childPages(const Value &idx, F &&each) {
  double start = 0;
  for (int page = 0; page < 256; page++) {
    Value r = lib::call(lib::F.getScopeChildren, {idx, N(start)});
    if (r.type() != T::Obj) return;
    Value a = js::get(r, "scopes");
    for (size_t i = 0; i < js::len(a); i++) each(js::at(a, i));
    const double tr = js::Number(js::get(r, "totalReturned")), rem = js::Number(js::get(r, "remainingItems"));
    if (!(tr != 0) || !(rem > 0)) return;
    start += tr;
  }
}

struct ArrNode;
struct Holder {
  std::vector<std::string> vars;  // JSON
  std::unordered_set<std::string> varNames;
  std::vector<std::unique_ptr<ArrNode>> arrays;
  std::unordered_map<std::string, ArrNode *> arrByName;
  // its arrays appended to sc (anySc: sc already has items), its vars to vs (empty list so far)
  void json(std::string &sc, bool anySc, std::string &vs) const;
};
struct ArrNode { std::string name; Holder h; };
void Holder::json(std::string &sc, bool anySc, std::string &vs) const {
  for (auto &a : arrays) {
    if (anySc) sc += ',';
    anySc = true;
    std::string s2 = "[", v2 = "[";
    a->h.json(s2, false, v2);
    s2 += ']'; v2 += ']';
    sc += "{\"name\":"; js::jstr(sc, a->name); sc += ",\"type\":\"array\",\"inline\":{\"scopes\":"; sc += s2; sc += ",\"vars\":"; sc += v2; sc += "}}";
  }
  for (size_t i = 0; i < vars.size(); i++) { if (i) vs += ','; vs += vars[i]; }
}

static std::string varName(const std::string &name, double width, double msb, double lsb) {
  if (!(width > 1)) return name;
  const std::string suf = "[" + js::numText(msb) + ":" + js::numText(lsb) + "]";
  if (name.size() >= suf.size() && name.compare(name.size() - suf.size(), suf.size(), suf) == 0) return name.substr(0, name.size() - suf.size());
  return name;
}

static void readVarsInto(const Value &path, double idx, Holder &root) {
  std::vector<Holder *> stack{&root};
  int ignored = 0;
  Value onVar = lib::Fn([&](const Napi::CallbackInfo &i) {
    const double width = js::Number(i[6]), msb = js::Number(i[7]), lsb = js::Number(i[8]);
    const std::string name = varName(js::String(i[0]), width, msb, lsb);
    Holder *h = stack.back();
    if (!h->varNames.insert(name).second) return Value();
    std::string o = "{\"name\":";
    js::jstr(o, name);
    o += ",\"type\":"; js::jval(o, i[1]);
    o += ",\"encoding\":"; js::jval(o, i[2]);
    o += ",\"netlistId\":"; js::jval(o, i[4]);
    o += ",\"signalId\":"; js::jval(o, i[5]);
    o += ",\"width\":"; js::jval(o, i[6]);
    o += ",\"msb\":"; js::jval(o, i[7]);
    o += ",\"lsb\":"; js::jval(o, i[8]);
    o += '}';
    h->vars.push_back(std::move(o));
    return Value();
  });
  Value onBegin = lib::Fn([&](const Napi::CallbackInfo &i) {
    if (stack.size() > 16) { ignored++; return Value(); }  // (16 open nodes at most)
    const std::string name = js::String(i[0]);
    Holder *h = stack.back();
    auto it = h->arrByName.find(name);
    ArrNode *n;
    if (it != h->arrByName.end()) n = it->second;
    else { h->arrays.emplace_back(new ArrNode{name, {}}); n = h->arrays.back().get(); h->arrByName.emplace(name, n); }
    stack.push_back(&n->h);
    return Value();
  });
  Value onEnd = lib::Fn([&](const Napi::CallbackInfo &) {
    if (ignored) { ignored--; return Value(); }
    if (stack.size() > 1) stack.pop_back();
    return Value();
  });
  // vars the viewer cannot show (not stored): listed in their declaration-order place, greyed with a reason, no signal id
  Value onSkipped = lib::Fn([&](const Napi::CallbackInfo &i) {
    const double width = js::Number(i[6]), msb = js::Number(i[7]), lsb = js::Number(i[8]);
    const std::string name = varName(js::String(i[0]), width, msb, lsb);
    Holder *h = stack.back();
    if (!h->varNames.insert(name).second) return Value();
    const int type = (int)js::Number(i[3]), kind = (int)js::Number(i[4]), state = (int)js::Number(i[5]);
    static const char *const typeNames[] = {"logic", "bit", "integer", "enum", "struct", "real", "string", "event", "other"};
    std::string o = "{\"name\":";
    js::jstr(o, name);
    o += ",\"type\":\"";
    o += type == 5 ? "real" : type == 6 ? "string" : type == 7 ? "event" : type == 8 ? "other" : type == 2 ? "integer" : kind == 0 ? "wire" : "reg";
    o += "\",\"encoding\":\"";
    o += type == 5 ? "Real" : type == 6 ? "String" : type == 7 || type == 8 ? "None" : "BitVector";
    o += "\",\"netlistId\":"; js::jval(o, i[2]);
    o += ",\"signalId\":null,\"width\":"; js::jval(o, i[6]);
    o += ",\"msb\":"; js::jval(o, i[7]);
    o += ",\"lsb\":"; js::jval(o, i[8]);
    // the reason: the file's named reason when it has one (the converter's, e.g. "stored history starts after the dump
    // start ..."), else a fixed text by state
    const std::string why = i.Length() > 9 && i[9].type() == T::Str ? js::String(i[9]) : std::string();
    o += state == 1 ? ",\"unavailable\":{\"state\":\"absent\",\"reason\":" : ",\"unavailable\":{\"state\":\"unsupported\",\"reason\":";
    js::jstr(o, !why.empty() ? why : state == 1 ? std::string("declared, no values") : std::string(type >= 0 && type <= 8 ? typeNames[type] : "other") + ": not supported yet");
    o += "}}";
    h->vars.push_back(std::move(o));
    return Value();
  });
  Value noop = lib::Fn([](const Napi::CallbackInfo &) { return Value(); });  // (the two placeholder callbacks before onSkipped)
  lib::call(lib::F.readVars, {path, N(idx), onVar, onBegin, onEnd, noop, noop, onSkipped});
}

static Reply cmdChildren(const Value &req) {
  const Value idxV = js::get(req, "scopeOffsetIdx");
  const Value path = js::get(req, "scopePath");
  std::vector<double> mem;
  if (idxV.type() == T::Num) mem = membersOf(idxV.p->n);
  ScopeList kids;
  Holder root;
  if (idxV.type() == T::Num) {
    for (double m : mem) childPages(N(m), [&](const Value &sc) { kids.add(sc); });
    for (double m : mem) readVarsInto(path, m, root);
  } else {
    childPages(idxV, [&](const Value &sc) { kids.add(sc); });
  }
  std::string sc = "[", vs = "[";
  for (size_t i = 0; i < kids.listed.size(); i++) { if (i) sc += ','; js::jval(sc, kids.listed[i]); }
  root.json(sc, !kids.listed.empty(), vs);
  sc += ']'; vs += ']';
  return res("{\"scopes\":" + sc + ",\"vars\":" + vs + "}");
}

// The hierarchy's signal ids: every var under the top scopes, `$` scopes and their subtrees left out.
// the ids a value request may name: every signal a var lists under the non-$ scopes (the library's knownSignals: one
// pass over its tables; WISP_KNOWN_WALK=1 walks the scopes through the hierarchy calls instead, as before, for tests)
static void buildKnownWalk() {
  g_f.known.assign((size_t)g_f.nSignals + 1, 0);
  std::vector<double> todo;
  std::unordered_set<double> seen;
  Value top = lib::call(lib::F.readScopes, {});
  for (size_t i = 0; i < js::len(top); i++) {
    Value sc = js::at(top, i);
    if (dollar(js::String(js::get(sc, "name")))) continue;
    const double idx = js::num(js::get(sc, "scopeOffsetIdx"));
    if (seen.insert(idx).second) todo.push_back(idx);
  }
  for (size_t k = 0; k < todo.size(); k++) {
    const double s = todo[k];
    Value cols = lib::call(lib::F.readVarsCols, {N(s)});
    Value sig = js::get(cols, "sig");
    if (sig.type() == T::Typed) {
      const size_t n = sig.p->s.size() / 8;
      for (size_t i = 0; i < n; i++) {
        double d;
        memcpy(&d, sig.p->s.data() + i * 8, 8);
        if (d >= 0 && d < (double)g_f.known.size()) g_f.known[(size_t)d] = 1;
      }
    }
    childPages(N(s), [&](const Value &c) {
      if (dollar(js::String(js::get(c, "name")))) return;
      const double idx = js::num(js::get(c, "scopeOffsetIdx"));
      if (seen.insert(idx).second) todo.push_back(idx);
    });
  }
}
static void buildKnown() {
  if (g_f.knownBuilt) return;
  g_f.knownBuilt = true;
  if (const char *w = getenv("WISP_KNOWN_WALK")) if (!strcmp(w, "1")) { buildKnownWalk(); return; }
  Value k = lib::call(lib::F.knownSignals, {N((double)g_f.nSignals)});
  if (!(k.type() == T::Typed && k.p->s.size() == (size_t)g_f.nSignals + 1)) { buildKnownWalk(); return; }
  g_f.known.assign(k.p->s.begin(), k.p->s.end());
  if (const char *c = getenv("WISP_KNOWN_CHECK")) if (!strcmp(c, "1")) {  // tests: both ways, every id compared (stderr)
    const std::vector<uint8_t> fast = g_f.known; buildKnownWalk(); size_t diff = 0, n1 = 0;
    for (size_t i = 0; i < fast.size(); i++) { diff += fast[i] != g_f.known[i]; n1 += g_f.known[i] != 0; }
    fprintf(stderr, "wisp-helper: known ids: %zu of %zu, native vs walk differ at %zu\n", n1, fast.size(), diff);
  }
}

// ================================================================ shared checks
static bool idOk(const Value &v, int64_t &id) {
  if (v.type() != T::Num) return false;
  const double d = v.p->n;
  if (!(d >= 0) || d != std::floor(d)) return false;
  if (d >= 1e9) { if (!isDerived((int64_t)d)) return false; id = (int64_t)d; return true; }  // (a derived signal)
  buildKnown();
  if (d >= (double)g_f.known.size() || !g_f.known[(size_t)d]) return false;
  id = (int64_t)d;
  return true;
}
static bool idsOk(const Value &arr, std::vector<int64_t> &ids, std::string &e) {
  if (arr.type() != T::Arr) { e = "signal ids must be an array"; return false; }
  for (size_t i = 0; i < js::len(arr); i++) {
    int64_t id;
    if (!idOk(js::at(arr, i), id)) { e = "unknown signal #" + js::String(js::at(arr, i)); return false; }
    ids.push_back(id);
  }
  return true;
}
static bool timeOk(const Value &v, const char *name, double &t, std::string &e) {
  const double d = js::num(v);
  if (v.type() != T::Num || !std::isfinite(d) || d < 0 || d > 1.8e19) { e = std::string("bad ") + name + ": " + js::String(v); return false; }
  t = std::floor(d);
  return true;
}

// ================================================================ open
static std::string errnoName(int e) {
  switch (e) {
    case EACCES: return "EACCES"; case EPERM: return "EPERM"; case EISDIR: return "EISDIR"; case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG"; case ENOTDIR: return "ENOTDIR"; case EIO: return "EIO"; case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE"; case ENOMEM: return "ENOMEM"; case EBUSY: return "EBUSY"; case EINVAL: return "EINVAL";
    case ENXIO: return "ENXIO"; case ENODEV: return "ENODEV"; case EAGAIN: return "EAGAIN"; case EOVERFLOW: return "EOVERFLOW";
    case ENOENT: return "ENOENT"; case ETXTBSY: return "ETXTBSY"; case EFBIG: return "EFBIG";
    default: return "UNKNOWN";
  }
}

static std::string indexJson(const Ident &id) {
  std::string dir;
  bool have = false;
  {
    std::string root;
    const char *e = getenv("WISP_INDEX_DIR");
    if (e && *e) root = e; else root = "/tmp/" + wutil::userName() + "-wisp-helper/index";
    std::string key("vvz1-normalized", 15);
    auto add = [&](const std::string &s) { key += '\0'; key += s; };
    add(id.real); add(js::numText(id.dev)); add(js::numText(id.ino)); add(js::numText(id.size)); add(js::numText(id.mtimeMs));
    dir = root + "/" + wutil::sha1hex(key).substr(0, 16);
    have = wutil::privateDir(root) && ::access(root.c_str(), W_OK) == 0 && wutil::privateDir(dir) && ::access(dir.c_str(), W_OK) == 0;
  }
  std::string o = "{\"on\":false,\"dir\":";
  if (have) js::jstr(o, dir); else o += "null";
  o += ",\"indexed\":0,\"bytes\":0,\"rawBytes\":0,\"todo\":0,\"inflight\":0,\"failed\":0,\"yields\":0,\"stopped\":null,\"ms\":0}";
  return o;
}

// ---- memory bounds, set at each open (W = the open's want) ----
// The library holds them (cacheSetBounds, cacheSetLimit) and refuses with its own texts; they are set only on the
// command thread, before the file opens, never during a fan-out.
struct Bounds { double cap = 0, held = 0, inner = 0, hard = 0; };
static Bounds g_bounds;
static double envMB(const char *n, double dflt) {
  const char *v = getenv(n);
  if (!v || !*v) return dflt;
  char *end = nullptr;
  const double x = strtod(v, &end);
  return end && !*end && x == x && x >= 0 ? x * 1e6 : dflt;
}
static double g_libHard = 0;  // the process hard bound last given to the library (0 = none); stats shows it
static void libBounds(double cap, double hard) { g_libHard = hard; lib::call(lib::F.cacheSetBounds, {N(cap), N(hard)}); }
static void setBounds(double W) {
  Bounds b;
  b.cap = std::floor(g_set.cacheBytes / W);
  if (!g_set.cacheGiven) b.cap = std::max(b.cap, 256e6);
  b.held = std::min(b.cap, envMB("WCB_STORE_MB", 128e6));
  b.inner = std::max(1024e6, 2 * b.held + 512e6);
  b.inner = envMB("WISP_WORKER_RSS_MB", b.inner);
  b.hard = 2 * b.inner;
  g_bounds = b;
  libBounds(b.cap, b.hard);
  lib::call(lib::F.cacheSetLimit, {N(b.held)});  // (one process-wide rows-held limit)
}
static double rssBytes() {  // (as the library measures it)
#if defined(__APPLE__)
  // (macOS has no /proc: the task's resident size from the kernel, the counterpart of statm's resident pages)
  mach_task_basic_info_data_t ti; mach_msg_type_number_t cnt = MACH_TASK_BASIC_INFO_COUNT;
  return task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&ti, &cnt) == KERN_SUCCESS ? (double)ti.resident_size : 0;
#else
  FILE *f = fopen("/proc/self/statm", "r");
  if (!f) return 0;
  unsigned long size = 0, res = 0;
  const int n = fscanf(f, "%lu %lu", &size, &res);
  fclose(f);
  return n == 2 ? (double)res * (double)sysconf(_SC_PAGESIZE) : 0;
#endif
}
// The floor of the inner bound: the RSS right after the open + WISP_RSS_HEADROOM_MB (default 16, may be
// negative). The hard bound given to the library follows it.
static void applyFloor() {
  double head = 16e6;
  if (const char *h = getenv("WISP_RSS_HEADROOM_MB")) { char *end = nullptr; const double x = strtod(h, &end); if (*h && end && !*end && x == x) head = x * 1e6; }
  const double floor = rssBytes() + head;
  if (g_bounds.inner < floor) {
    if (getenv("WISP_WORKER_RSS_MB")) fprintf(stderr, "wisp-helper: WISP_WORKER_RSS_MB is below the floor (RSS after open + margin); using %.0f MB\n", floor / 1e6);
    g_bounds.inner = floor;
    g_bounds.hard = 2 * floor;
    libBounds(g_bounds.cap, g_bounds.hard);
  }
}
// A file read directly with the lazy open: the whole-file check runs in the background after the open, and its memory
// is part of the open (the full open counts it in the floor). While it runs, the RSS bound is held off (the helper's
// refusal below and the library's hard bound); when it has ended, the floor is set again from the RSS then.
static bool g_floorAfterCheck = false;
static void floorAtOpen() {
  applyFloor();
  const Value cn = lib::call(lib::F.checkNow, {});
  g_floorAfterCheck = js::truthy(js::get(cn, "lazy")) && js::Number(js::get(cn, "state")) == 0;
  if (g_floorAfterCheck) libBounds(g_bounds.cap, 0);
}
static bool checkRunning() {
  if (!g_floorAfterCheck) return false;
  const Value cn = lib::call(lib::F.checkNow, {});
  if (js::Number(js::get(cn, "state")) == 0) return true;
  g_floorAfterCheck = false;
  applyFloor();
  libBounds(g_bounds.cap, g_bounds.hard);
  return false;
}
// a deferred check (WISP_VERIFY_START idle:<seconds> or request) that starts now: its memory is held off the bound
// while it runs, as at open
static void holdBoundsForCheck() { g_floorAfterCheck = true; libBounds(g_bounds.cap, 0); }
// the process hard bound to give the library now: none while the lazy check runs
static double hardNow() { return g_floorAfterCheck ? 0 : g_bounds.hard; }
// a loading command (window, valueAt, edge, search) is refused while the process is over twice the inner bound;
// checked after the command's own checks, before anything is loaded. Over the inner bound, least recently used held
// rows are dropped first (the held rows to half the rows-held limit, then the limit back).
static bool overMemory(std::string &e) {
  if (!(g_bounds.inner > 0)) return false;
  const bool running = checkRunning();
  double rss = rssBytes();
  if (!(rss > g_bounds.inner)) return false;
  lib::call(lib::F.cacheSetLimit, {N(std::floor(g_bounds.held / 2))});
  lib::call(lib::F.cacheSetLimit, {N(g_bounds.held)});
  rss = rssBytes();
  if (!(rss > 2 * g_bounds.inner) || running) return false;
  e = "worker memory limit (";
  js::jnum(e, std::round(rss / 1e6));
  e += " MB > ";
  js::jnum(e, std::round(2 * g_bounds.inner / 1e6));
  e += " MB)";
  return true;
}

// The failed-output file the path names or resolves to (a name ending in ".FAILED", see cmdOpen), or "" when neither does.
static std::string failedName(const std::string &file) {
  static const std::string kSuf = ".FAILED";
  auto ends = [](const std::string &f) { return f.size() >= kSuf.size() && f.compare(f.size() - kSuf.size(), kSuf.size(), kSuf) == 0; };
  if (ends(file)) return file;
  char *r = ::realpath(file.c_str(), nullptr);
  if (!r) return "";
  std::string f(r);
  free(r);
  return ends(f) ? f : "";
}

static Reply cmdOpen(const Value &req) {
  const Value fv = js::get(req, "file");
  if (fv.type() != T::Str || fv.p->s.empty()) return err("open needs a file");
  const std::string file = fv.p->s;
  {
    struct stat sb;
    if (::stat(file.c_str(), &sb) != 0) {
      if (errno == ENOENT || errno == ENOTDIR) return err("no such file: " + file);
      return err("cannot read " + file + ": " + errnoName(errno));
    }
    // A converter output that failed its self-check is kept as <out>.FAILED (with <out>.FAILED.diff.tsv beside it), never
    // at the requested path. Its name, or the name it resolves to, refuses the open unless the request sets "force".
    const std::string failed = failedName(file);
    if (!failed.empty() && !js::truthy(js::get(req, "force"))) {
      struct stat db;
      const std::string d = failed + ".diff.tsv";
      return err("this file did not pass the converter's self-check: " + failed + " (a name ending in .FAILED)" +
                     (::stat(d.c_str(), &db) == 0 ? "; the differences are listed in " + d : std::string()) +
                     "; open it with \"force\": true to read it anyway", "failedFile");
    }
#ifdef WISP_DIRECT
    const char *notWcz = "this file is neither a WCZ file nor an FSDB file: this build of the helper opens WCZ and FSDB files only";
#else
    const char *notWcz = "this file is not a WCZ file: only WCZ files open here";
#endif
    if (!S_ISREG(sb.st_mode)) return err(notWcz, "unsupportedFile");
    const int fd = ::open(file.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) return err("cannot read " + file + ": " + errnoName(errno));
    uint8_t m[8];
    ssize_t n = 0;
    int re = 0;
    while (n < 8) { const ssize_t r = ::read(fd, m + n, 8 - n); if (r < 0 && errno == EINTR) continue; if (r < 0) re = errno; if (r <= 0) break; n += r; }
    ::close(fd);
    if (re) return err("cannot read " + file + ": " + errnoName(re));
    if (n < 4) return err(notWcz, "unsupportedFile");
    const uint32_t magic = (uint32_t)m[0] | ((uint32_t)m[1] << 8) | ((uint32_t)m[2] << 16) | ((uint32_t)m[3] << 24);
    if (magic == 0x32424357u || magic == 0x31424357u) return err("a single-signal stream (WCB2/WCB1), not a dump: open its WCZ1 container", "wcbStream");
    // An FSDB file (its header magic at byte 4) is read in place (never converted): the plan at open, values per request.
    const uint32_t m4 = n >= 8 ? ((uint32_t)m[4] | ((uint32_t)m[5] << 8) | ((uint32_t)m[6] << 16) | ((uint32_t)m[7] << 24)) : 0;
    const bool direct = magic != 0x315A4357u && (m4 == 0x48d93dfcu || m4 == 0x48d93e1cu);
    if (magic != 0x315A4357u && !direct) return err(notWcz, "unsupportedFile");
#ifndef WISP_DIRECT
    if (direct)
      return err("this build of the helper was made without its FSDB reader, so it opens WCZ files only: build the helper with the FSDB reader sources in convert/fsdb/ present (see the Build section of helper/README.md) to open FSDB files directly", "unsupportedFile");
#endif
  }
  const Value wv = js::get(req, "workers");
  // want: workers when truthy (a numeric string coerces as in JS), else the default; clamped, kept as given (2.5 stays)
  double want = js::truthy(wv) ? js::Number(wv) : (double)g_set.workers;
  if (!(want == want)) want = (double)g_set.workers;
  want = std::max(1.0, std::min(8.0, want));
  const Ident id = identOf(file);
  // "outsideWrites": "none": the statement that the run wrote no design signal from outside the logic (no force, deposit or
  // C-code write); on an FSDB file its computed names then get signals and values per window request
  const Value owv = js::get(req, "outsideWrites");
  const std::string ow = owv.type() == T::Str ? owv.p->s : std::string();
  if (!ow.empty() && ow != "none") return err("outsideWrites must be \"none\" (or not given)");
  if (g_f.open && !js::truthy(js::get(req, "reload")) && sameIdent(id, g_f.ident) && std::ceil(want) == std::ceil(g_f.want) && ow == g_f.outsideWrites) {
    std::string o = g_f.resultHead + "\"index\":" + indexJson(id) + ",\"reused\":true";
    return res(o + "}");
  }
  closeFile();
  const std::string &wczFile = file;
  setBounds(want);
  std::string e;
  lib::call(lib::F.openFile, {S(wczFile), S(ow)}, &e);
  // an FSDB file the converter refuses as a whole is refused here too, with the converter's message (code fileRefused)
  if (!e.empty()) { closeFile(); return e.rfind(FILE_REFUSED, 0) == 0 ? err(e, "fileRefused") : err(e); }
  g_f.open = true;
  g_f.ident = id;
  g_f.outsideWrites = ow;
  g_f.want = want;
  // metadata
  double scopeCount = 0, varCount = 0, timeEnd = 0, timeStart = 0;
  std::string timeScale = "1", timeUnit = "\"s\"";
  Value cb1 = lib::Fn([&](const Napi::CallbackInfo &i) {
    scopeCount = js::Number(i[0]); varCount = js::Number(i[1]);
    timeScale.clear(); js::jval(timeScale, i[2]);
    timeUnit.clear(); js::jval(timeUnit, i[3]);
    return Value();
  });
  Value cb2 = lib::Fn([&](const Napi::CallbackInfo &i) {
    timeEnd = js::Number(i[1]);
    const Value ts = i[2];
    timeStart = ts.type() == T::Num && ts.p->n != 0 && ts.p->n == ts.p->n ? ts.p->n : 0;
    return Value();
  });
  lib::call(lib::F.readMetadata, {cb1, cb2}, &e);
  if (!e.empty()) { closeFile(); return err(e); }
  g_f.timeStart = timeStart;
  g_f.timeEnd = timeEnd;
  Value info = lib::call(lib::F.sourceInfo, {});
  g_f.nSignals = (uint32_t)std::max(0.0, js::num(js::get(info, "signals"), 0));
  { const Value cv = js::get(info, "computed");   // computed signals (FSDB, outsideWrites none): ids [first, first + n)
    g_f.computedFirst = cv.type() == T::Obj ? (int64_t)js::num(js::get(cv, "firstId"), 0) : 0; g_f.computedN = cv.type() == T::Obj ? (int64_t)js::num(js::get(cv, "signals"), 0) : 0; }
  const Value gaps = js::get(info, "gaps");
  g_f.gaps = gaps.type() == T::Arr;
  for (size_t i = 0; g_f.gaps && i < js::len(gaps); i++) {
    const Value x = js::at(gaps, i);
    FileState::Gap gp;
    gp.f = js::num(js::get(x, "from"), 0);
    gp.toEnd = js::truthy(js::get(x, "toEnd"));
    gp.u = gp.toEnd ? 0 : js::num(js::get(x, "to"), 0);
    gp.E = gp.toEnd ? std::max(timeEnd, gp.f + 1) + 1 : gp.u + 1;
    js::jval(gp.json, x);
    g_f.gapList.push_back(gp);
  }
  const char *wl = getenv("WCB_LOD");
  g_f.lod = js::truthy(js::get(js::get(info, "caps"), "lod")) && !(wl && std::string(wl) == "0");
  std::string o = "{\"metadata\":{\"timeTableLoaded\":true,\"scopeCount\":";
  js::jnum(o, scopeCount);
  o += ",\"netlistIdCount\":"; js::jnum(o, varCount);
  o += ",\"signalIdCount\":0,\"timeTableCount\":0,\"timeStart\":"; js::jnum(o, timeStart);
  o += ",\"timeEnd\":"; js::jnum(o, timeEnd);
  o += ",\"minTimeStep\":1,\"timeScale\":"; o += timeScale;
  o += ",\"timeUnit\":"; o += timeUnit;
  if (g_f.gaps) { o += ",\"gaps\":"; js::jval(o, gaps); }
  {  // vars the viewer cannot show (listed greyed in children): their count, only when there are any
    const double sk = js::num(js::get(info, "skippedVars"), 0);
    if (sk > 0) { o += ",\"skippedVars\":"; js::jnum(o, sk); }
  }
  o += "},\"top\":[";
  ScopeList top;
  Value scopes = lib::call(lib::F.readScopes, {});
  for (size_t i = 0; i < js::len(scopes); i++) top.add(js::at(scopes, i));
  for (size_t i = 0; i < top.listed.size(); i++) { if (i) o += ','; js::jval(o, top.listed[i]); }
  o += "],\"workers\":"; js::jnum(o, want);
  o += ",\"source\":"; js::jval(o, js::get(info, "source"));
  o += ",\"caps\":{\"derive\":true,\"lod\":"; o += g_f.lod ? "true" : "false";
  o += "},";
  if (!failedName(file).empty()) o += "\"selfCheckFailed\":true,";  // opened with "force" (a failed name is refused otherwise)
  g_f.resultHead = o;
  floorAtOpen();
  o += "\"index\":" + indexJson(id);
  return res(o + "}");
}

// ================================================================ window
static bool permanentErr(const std::string &e) {
  return e.find("unsupported") != std::string::npos || e.find("0 bits") != std::string::npos || e.find("not a bit signal") != std::string::npos ||
         e.find("are not split") != std::string::npos;
}
static bool stickyErr(const std::string &e) { return permanentErr(e) || e.find("larger than") != std::string::npos; }
static bool largerThan(const std::string &e) { return e.find("larger than") != std::string::npos; }

// ---- rows held whole (text rows: strings and reals), in the library's store ----
// The library's store is the truth (its LRU drops rows past the rows-held limit); store calls run on the command
// thread only. A held row answers windows of every span, valueAt prev, edge, search and count from the store.
struct HeldRow { bool held = false; double count = 0, bits = 0; bool xz = false; };
static HeldRow heldRow(int64_t id) {
  HeldRow h;
  Value st = lib::call(lib::F.cacheStats, {});
  const Value sg = js::get(st, "signals");
  for (size_t i = 0; i < js::len(sg); i++) {
    const Value e = js::at(sg, i);
    if ((int64_t)js::num(js::get(e, "signalId"), -1) != id) continue;
    h.held = true;
    h.count = js::num(js::get(e, "count"), 0);
    h.bits = js::num(js::get(e, "bits"), 0);
    h.xz = js::truthy(js::get(e, "xz"));
    break;
  }
  return h;
}
// Load a text row whole and keep it (least recently used rows past the limit go). false: e = the load's error; a
// `larger than` refusal is remembered when the request completes.
static bool ensureDerived(int64_t id, std::string &e);
static bool holdRow(int64_t id, std::string &e) {
  if (isDerived(id)) return ensureDerived(id, e);
  std::string le;
  Value ld = js::at(lib::call(lib::F.cacheLoad, {lib::Ids({id}), Napi::Boolean::New(Napi::Env(), true)}, &le), 0);
  if (!le.empty()) { e = le; return false; }
  if (ld.type() != T::Obj) { e = "cannot load"; return false; }
  if (!js::undef(js::get(ld, "error"))) {
    e = js::String(js::get(ld, "error"));
    if (largerThan(e)) g_f.pendSticky.push_back({id, e});
    return false;
  }
  return true;
}
static bool stickyLarger(int64_t id) {
  auto st = g_f.sticky.find(id);
  return st != g_f.sticky.end() && largerThan(st->second);
}

struct RowInfo { bool err = false; std::string error; bool text = false; std::string kind; double count = 0, bits = 0; };
// Each row's sourceCount answer, the first one of the open (a count is the INDEX's, whatever block reads find later).
// A computed signal's answer is asked each time and never kept: it describes the window prepared for the request in
// flight (its rows there), or is the refusal outside a window request; keeping either would answer later requests
// with it.
static bool isComputed(int64_t id) { return id >= g_f.computedFirst && id < g_f.computedFirst + g_f.computedN; }
static std::vector<Value> srcCounts(const std::vector<int64_t> &ids) {
  std::vector<int64_t> miss, now;
  for (int64_t id : ids) if (isComputed(id)) now.push_back(id); else if (!isDerived(id) && !g_f.firstCount.count(id)) miss.push_back(id);
  if (!miss.empty()) {
    std::sort(miss.begin(), miss.end());
    miss.erase(std::unique(miss.begin(), miss.end()), miss.end());
    Value r = lib::call(lib::F.sourceCount, {lib::Ids(miss)});
    for (size_t i = 0; i < miss.size(); i++) g_f.firstCount[miss[i]] = js::at(r, i);
  }
  std::unordered_map<int64_t, Value> cur;
  if (!now.empty()) {
    std::sort(now.begin(), now.end());
    now.erase(std::unique(now.begin(), now.end()), now.end());
    Value r = lib::call(lib::F.sourceCount, {lib::Ids(now)});
    for (size_t i = 0; i < now.size(); i++) cur[now[i]] = js::at(r, i);
  }
  std::vector<Value> out;
  for (int64_t id : ids) out.push_back(isDerived(id) ? Value() : isComputed(id) ? cur[id] : g_f.firstCount[id]);  // (derived: none; see rowInfo)
  return out;
}
// The plain text of a block-check error: a block check's first report reads "block n: signal m: ...", later
// reads of the signal "signal m: ..."; which read comes first depends on the order rows run in, so the prefix is dropped.
// The library's other block texts (e.g. "block 0: block checksum mismatch") are kept as they are.
static std::string plainText(const std::string &e) {
  if (e.compare(0, 6, "block ") != 0) return e;
  size_t i = 6;
  while (i < e.size() && e[i] >= '0' && e[i] <= '9') i++;
  if (i == 6 || e.compare(i, 9, ": signal ") != 0) return e;
  return e.substr(i + 2);
}
// The first round's span of a range scan.
static double scanSpan0(int64_t id) {
  double span = std::max(1.0, std::ceil(std::max(1.0, g_f.timeEnd) / 4096));
  double density = 0;
  auto c = g_f.firstCount.find(id);
  if (c != g_f.firstCount.end() && g_f.timeEnd > g_f.timeStart) {
    const Value n = js::get(c->second, "count");
    if (n.type() == T::Num) density = n.p->n / (g_f.timeEnd - g_f.timeStart);
  }
  if (!(density > 0)) { auto w = g_f.winDensity.find(id); if (w != g_f.winDensity.end()) density = w->second; }
  if (density > 0) {
    static const double kChanges = [] { const char *v = getenv("WISP_RANGED_CHANGES"); return v && *v ? atof(v) : 8e6; }();
    span = std::min(span, std::max(1.0, std::floor(kChanges / density)));
  }
  return span;
}
static std::vector<RowInfo> rowInfo(const std::vector<int64_t> &ids) {
  std::vector<RowInfo> out(ids.size());
  const std::vector<Value> r = srcCounts(ids);
  for (size_t i = 0; i < ids.size(); i++) {
    Value x = r[i];
    RowInfo &ri = out[i];
    if (isDerived(ids[i])) {
      // a derived row is answered from the store, like a text row held whole (it is built there, and rebuilt when
      // the store dropped it)
      ri.text = true;
      ri.bits = g_f.derived[ids[i]].width;
      const HeldRow h = heldRow(ids[i]);
      ri.count = h.held ? h.count : 0;
      continue;
    }
    if (x.type() != T::Obj) { ri.err = true; ri.error = "unknown signal"; continue; }
    const Value e = js::get(x, "error");
    if (!js::undef(e)) { ri.err = true; ri.error = js::String(e); continue; }
    const Value k = js::get(x, "kind");
    if (!js::undef(k)) { ri.text = true; ri.kind = js::String(k); }
    ri.count = js::num(js::get(x, "count"), 0);
    ri.bits = js::num(js::get(x, "bits"), 0);
  }
  return out;
}

// ---- capture gaps ----
// A row's normalized changes in [a, b), exact (a one-bucket cold window's count), memoised for the open.
static double changesIn(int64_t id, double a, double b) {
  if (!(b > a) || isDerived(id)) return 0;
  const auto key = std::make_tuple(id, a, b);
  auto it = g_f.unseenMemo.find(key);
  if (it != g_f.unseenMemo.end()) return it->second;
  std::string ce;
  Value r = js::at(lib::call(lib::F.cacheWindowCold, {lib::Ids({id}), N(a), N(b), N(1), N(g_set.textBudget)}, &ce), 0);
  double c = 0;
  if (ce.empty() && r.type() == T::Obj && js::undef(js::get(r, "error"))) c = js::num(js::get(r, "count"), 0);
  g_f.unseenMemo[key] = c;
  return c;
}
static double unseenTotal(int64_t id) {  // the row's unseen changes over the whole dump
  double n = 0;
  for (const auto &g : g_f.gapList) n += changesIn(id, g.f + 1, g.E);
  return n;
}
static bool unrecordedAt(double t) {
  for (const auto &g : g_f.gapList) if (t > g.f && (g.toEnd || t < g.u)) return true;
  return false;
}
static int unseenGap(double t) {  // the gap whose unseen changes hold time t, else -1
  for (size_t i = 0; i < g_f.gapList.size(); i++) { const auto &g = g_f.gapList[i]; if (t > g.f && (g.toEnd || t <= g.u)) return (int)i; }
  return -1;
}

struct RowAns {
  bool err = false; std::string error;
  bool lod = false; double lodCount = 0, lodLevel = 0, lodWidth = 0; std::string flags;
  bool exact = false; double count = 0; std::string rec, cnt; bool hasCnt = false; double walkMs = 0;
  double total = NAN;
  bool text = false; std::string kind; bool minmax = false; double mn = 0, mx = 0; bool hasMean = false; double mean = 0; bool cut = false;
  bool tile = false;  // (answered from the window-answer cache)
  bool store = false;  // (answered from the row held whole: no `ranged`)
  size_t bytes() const { return rec.size() + cnt.size() + flags.size() + error.size() + kind.size() + sizeof(RowAns); }
};
static void fromWindow(const Value &o, RowAns &a, bool deflCounts, bool whole) {
  if (o.type() != T::Obj) { a.err = true; a.error = "no answer"; return; }
  const Value e = js::get(o, "error");
  if (!js::undef(e)) { a.err = true; a.error = js::String(e); return; }
  a.exact = js::truthy(js::get(o, "exact"));
  a.count = js::num(js::get(o, "count"), 0);
  const Value rec = js::get(o, "records");
  a.rec = deflateRaw(rec.type() == T::Bytes ? rec.p->s : std::string());
  const Value c = js::get(o, "counts");
  if (c.type() == T::Bytes) { a.hasCnt = true; a.cnt = deflCounts ? deflateRaw(c.p->s) : c.p->s; }
  a.walkMs = js::num(js::get(o, "walkMs"), 0);
  if (js::truthy(js::get(o, "text"))) {
    a.text = true;
    a.kind = js::String(js::get(o, "kind"));
    a.cut = js::truthy(js::get(o, "cut"));
    const Value mean = js::get(o, "textMean");
    if (mean.type() == T::Num) { a.hasMean = true; a.mean = mean.p->n; }
    if (whole && js::get(o, "min").type() == T::Num) { a.minmax = true; a.mn = js::num(js::get(o, "min")); a.mx = js::num(js::get(o, "max")); }
  }
  if (whole) a.total = js::num(js::get(o, "total"));
}

static Pool *g_pool = nullptr;
static double kSplitMin = 262144;  // a bit row expected to hold this many changes in the window is split in time (WISP_SPLIT_MIN)
static std::atomic<bool> g_cancelRun{false};  // the request in flight was cancelled

// ---- window-answer cache: a row's finished (deflated) answer per (row, t0, t1, buckets, budget, deflateCounts) ----
// Bounded (kAnsCap bytes, least recently used out); dropped by free, close and open. Answers only, never decoded rows.
struct AnsCache {
  static const size_t kAnsCap = 32u << 20;
  struct E { int64_t id; RowAns a; std::list<std::string>::iterator pos; };
  std::unordered_map<std::string, E> m;
  std::list<std::string> order;  // most recent first
  size_t bytes = 0;
  static std::string key(int64_t id, double t0, double t1, double B, double budget, bool dc) {
    std::string k = js::numText((double)id);
    for (double d : {t0, t1, B, budget}) { k += '|'; k += js::numText(d); }
    k += dc ? "|d" : "|r";
    return k;
  }
  const RowAns *get(const std::string &k) {
    auto it = m.find(k);
    if (it == m.end()) return nullptr;
    order.splice(order.begin(), order, it->second.pos);
    return &it->second.a;
  }
  void put(const std::string &k, int64_t id, const RowAns &a) {
    if (a.bytes() > kAnsCap / 8 || m.count(k)) return;
    order.push_front(k);
    m.emplace(k, E{id, a, order.begin()});
    bytes += a.bytes();
    while (bytes > kAnsCap && !order.empty()) { auto it = m.find(order.back()); bytes -= it->second.a.bytes(); m.erase(it); order.pop_back(); }
  }
  void drop(int64_t id) {
    for (auto it = m.begin(); it != m.end();) {
      if (it->second.id == id) { bytes -= it->second.a.bytes(); order.erase(it->second.pos); it = m.erase(it); } else ++it;
    }
  }
  void clear() { m.clear(); order.clear(); bytes = 0; }
};
static AnsCache g_ans;
static void clearAnswers() { g_ans.clear(); }

// ---- one dense bit row split in time across threads ----
// Cut points k (bucket indices) where span * k / B is an integer: there a sub-window's own bucket bounds
// (a + ceil(span' * i / B')) are the window's (t0 + ceil(span * (k + i) / B)), so its counts are the window's counts for
// those buckets. The sub-answers are merged into exactly the answer of the whole window (BitWindow's rules: the value at
// t0, then every change in (t0, t1) when the window holds at most 2 x B changes, else each bucket's first and last).
// A normalized change exactly at a cut a_j is folded into sub-window j's first record (its value at a_j); it is found
// again as a value different from the last record before a_j. Anything unexpected falls back to one unsplit call.
struct Sub { bool ok = false; bool hasCnt = false; double count = 0; std::string rec, cnt; };
static uint64_t gcd64(uint64_t a, uint64_t b) { while (b) { const uint64_t r = a % b; a = b; b = r; } return a; }
static uint64_t bnd(uint64_t T0, uint64_t S, uint64_t B, uint64_t k) { return T0 + (uint64_t)(((unsigned __int128)S * k + B - 1) / B); }
static std::vector<uint64_t> splitCuts(double t0, double t1, double B, unsigned parts) {
  std::vector<uint64_t> ks;
  if (!(t1 > t0) || t1 >= 9007199254740992.0 || parts < 2) return ks;
  const uint64_t T0 = (uint64_t)t0, S = (uint64_t)t1 - T0, Bu = (uint64_t)B;
  const uint64_t g = gcd64(S, Bu), m = Bu / g;  // cut points: multiples of m (g of them in [0, B))
  const uint64_t P = std::min<uint64_t>(g, parts);
  if (P < 2) return ks;
  for (uint64_t j = 0; j <= P; j++) ks.push_back((j * g / P) * m);
  return ks;
}
static bool mergeSplit(double t0, double t1, double Bd, uint32_t bits, const std::vector<uint64_t> &ks, const std::vector<Sub> &subs,
                       RowAns &a, bool deflCounts, double cap) {
  const uint64_t T0 = (uint64_t)t0, S = (uint64_t)t1 - T0, B = (uint64_t)Bd;
  const size_t rs = 8 + (size_t)bits;
  struct R { uint64_t t; const char *v; };
  std::vector<R> recs;  // the window's changes (t > t0) that a sub-answer names, in time order
  const char *at0 = nullptr, *last = nullptr;
  double count = 0;
  bool allExact = true;
  std::vector<uint32_t> counts(B, 0);
  for (size_t j = 0; j < subs.size(); j++) {
    const Sub &s = subs[j];
    if (!s.ok || s.rec.size() < rs || s.rec.size() % rs) return false;
    const uint64_t aj = bnd(T0, S, B, ks[j]);
    const size_t n = s.rec.size() / rs;
    uint64_t t = 0;
    std::vector<R> mine;
    for (size_t i = 0; i < n; i++) {
      uint64_t d;
      memcpy(&d, s.rec.data() + i * rs, 8);
      t += d;
      mine.push_back({t, s.rec.data() + i * rs + 8});
    }
    if (mine[0].t != aj) return false;
    count += s.count;
    size_t atChange = 0;
    if (j == 0) at0 = mine[0].v;
    else if (memcmp(mine[0].v, last, bits)) { recs.push_back({aj, mine[0].v}); atChange = 1; }
    if (j == 0 && !s.hasCnt) {  // (a change at t0 itself: counted, not sent)
      const double c0 = s.count - (double)(n - 1);
      if (c0 != 0 && c0 != 1) return false;
      atChange = (size_t)c0;
    }
    if (!s.hasCnt && (double)(n - 1 + atChange) != s.count) return false;
    for (size_t i = 1; i < n; i++) { if (mine[i].t <= aj) return false; recs.push_back(mine[i]); }
    last = mine[n - 1].v;
    if (s.hasCnt) {
      allExact = false;
      const uint64_t bj = ks[j + 1] - ks[j];
      if (s.cnt.size() != bj * 4) return false;
      memcpy(&counts[ks[j]], s.cnt.data(), bj * 4);
    } else {
      counts[ks[j]] += (uint32_t)atChange;
      uint64_t cur = ks[j];
      for (size_t i = 1; i < n; i++) {
        while (cur + 1 < ks[j + 1] && mine[i].t >= bnd(T0, S, B, cur + 1)) cur++;
        counts[cur]++;
      }
    }
  }
  const bool exact = count <= 2 * (double)B;
  if (exact && !allExact) return false;  // (a sub-window bucketed what the window sends whole: not mergeable)
  // The cap is on the whole answer, as the unsplit fill counts it (BitWindow: per record its time, both
  // planes and the sent chars; 4 B a bucket once bucketed; checked before each record is held). An answer that might
  // be over is not merged: the unsplit call answers it, the library's own refusal included.
  if (cap > 0) {
    const double per = 16.0 + bits + 2.0 * ((bits + 7) / 8);
    size_t picks = 0;  // the records the unsplit answer holds (t > t0)
    if (exact) picks = recs.size();
    else {
      uint64_t cur = 0;
      for (size_t i = 0; i < recs.size();) {
        while (cur + 1 < B && recs[i].t >= bnd(T0, S, B, cur + 1)) cur++;
        const uint64_t end = cur + 1 < B ? bnd(T0, S, B, cur + 1) : UINT64_MAX;
        size_t k = i;
        while (k + 1 < recs.size() && recs[k + 1].t < end) k++;
        picks += k > i ? 2 : 1;
        i = k + 1;
      }
    }
    if (exact) { if ((double)(picks + 1) * per > cap) return false; }
    else {
      // before bucketing it held up to 2 x B + 1 changes (one fewer with a change at t0: counted as if there were none)
      if ((2.0 * (double)B + 2) * per > cap) return false;
      if ((double)(picks + 1) * per + 4.0 * (double)B > cap) return false;
    }
  }
  std::string out;
  auto put = [&](uint64_t t, const char *v, uint64_t &prev) {
    const uint64_t d = t - prev;
    prev = t;
    out.append((const char *)&d, 8);
    out.append(v, bits);
  };
  uint64_t prev = 0;
  put(T0, at0, prev);
  if (exact) {
    for (const R &r : recs) put(r.t, r.v, prev);
  } else {
    // each bucket's first and last change
    uint64_t cur = 0;
    size_t i = 0;
    while (i < recs.size()) {
      while (cur + 1 < B && recs[i].t >= bnd(T0, S, B, cur + 1)) cur++;
      const uint64_t end = cur + 1 < B ? bnd(T0, S, B, cur + 1) : UINT64_MAX;
      size_t k = i;
      while (k + 1 < recs.size() && recs[k + 1].t < end) k++;
      put(recs[i].t, recs[i].v, prev);
      if (k > i) put(recs[k].t, recs[k].v, prev);
      i = k + 1;
    }
  }
  a.err = false;
  a.exact = exact;
  a.count = count;
  a.rec = deflateRaw(out);
  if (!exact) {
    a.hasCnt = true;
    std::string c((const char *)counts.data(), counts.size() * 4);
    a.cnt = deflCounts ? deflateRaw(c) : c;
  }
  return true;
}

static Reply cmdWindow(const Value &req) {
  const Value sigs = js::get(req, "signals");
  if (sigs.type() != T::Arr) return err("window needs signals");
  std::vector<int64_t> ids;
  for (size_t i = 0; i < js::len(sigs); i++) {
    const Value ent = js::at(sigs, i);
    const Value idv = ent.type() == T::Obj || ent.type() == T::Arr ? js::get(ent, "signalId") : ent;
    int64_t id;
    if (!idOk(idv, id)) return err("unknown signal #" + js::String(idv));
    ids.push_back(id);
  }
  double t0, t1;
  std::string e;
  if (!timeOk(js::get(req, "t0"), "t0", t0, e) || !timeOk(js::get(req, "t1"), "t1", t1, e)) return err(e);
  if (t1 < t0) return err("window needs t1 >= t0");
  double B = std::floor(js::Number(js::get(req, "buckets")));
  if (!(B == B) || B == 0) B = 1;
  B = std::max(1.0, std::min(4194304.0, B));
  const bool deflCounts = js::truthy(js::get(req, "deflateCounts"));
  if (overMemory(e)) return err(e);
  const double te = g_f.timeEnd;
  // computed signals (an FSDB open with outsideWrites none): evaluated over [t0, t1] first, inside the memory room left
  // under the refusal line (twice the inner bound); then answered below as stored rows are
  struct ComputedDone { bool on; ~ComputedDone() { if (on) lib::call(lib::F.computedDone, {}); } } computedDone{g_f.outsideWrites == "none"};
  if (computedDone.on) {
    const double room = g_bounds.inner > 0 ? std::max(0.0, 2 * g_bounds.inner - rssBytes()) : -1;
    std::string ce;
    lib::call(lib::F.computedPrepare, {lib::Ids(ids), N(t0), N(t1), N(room), N((double)g_pool->threads())}, &ce);
    if (!ce.empty()) return err(ce);
  }
  const bool ranged = t1 > t0 && te > 0 && (t1 - t0) <= te * g_set.coldRange;

  // distinct rows, their kinds and counts
  std::vector<int64_t> dist;
  std::unordered_map<int64_t, size_t> slot;
  for (int64_t id : ids) if (slot.emplace(id, dist.size()).second) dist.push_back(id);
  const std::vector<RowInfo> info = rowInfo(dist);
  size_t nStr = 0;
  for (auto &ri : info) if (!ri.err && ri.text && ri.kind == "string") nStr++;
  const double TB = g_set.textBudget;
  const double budget = std::floor(std::max(TB / 4, TB / (double)std::max<size_t>(1, nStr)));
  std::vector<RowAns> ans(dist.size());
  std::vector<uint8_t> done(dist.size(), 0);
  for (size_t k = 0; k < dist.size(); k++) {
    auto st = g_f.sticky.find(dist[k]);
    if (st != g_f.sticky.end() && permanentErr(st->second)) { ans[k].err = true; ans[k].error = st->second; done[k] = 1; }
    else if (info[k].err) { ans[k].err = true; ans[k].error = info[k].error; done[k] = 1; }
  }
  // (a remembered `larger than` row is still offered to LOD; otherwise a non-ranged window answers its error)
  auto stickyRest = [&]() {
    for (size_t k = 0; k < dist.size(); k++) {
      if (done[k]) continue;
      auto st = g_f.sticky.find(dist[k]);
      if (st != g_f.sticky.end() && !ranged) { ans[k].err = true; ans[k].error = st->second; done[k] = 1; }
    }
  };
  // LOD (stored overview levels)
  const Value lodV = js::get(req, "lod");
  if (g_f.lod && lodV.type() == T::Bool && lodV.p->b && t1 > t0) {
    std::vector<int64_t> lids;
    std::vector<size_t> lk;
    for (size_t k = 0; k < dist.size(); k++) if (!done[k]) { lids.push_back(dist[k]); lk.push_back(k); }
    if (!lids.empty()) {
      Napi::Array gr = Napi::Array::New(Napi::Env());
      for (size_t g = 0; g < g_f.gapList.size(); g++) {
        Napi::Array pr = Napi::Array::New(Napi::Env());
        pr.Set(0u, N(g_f.gapList[g].f + 1)); pr.Set(1u, N(g_f.gapList[g].E));
        gr.Set((uint32_t)g, pr);
      }
      // (LOD is answered outside the per-row signal cap: lifted for this call, command thread only)
      libBounds(0, hardNow());
      Value r = lib::call(lib::F.lodWindow, {lib::Ids(lids), N(t0), N(t1), N(B), gr});
      libBounds(g_bounds.cap, hardNow());
      for (size_t j = 0; j < lids.size(); j++) {
        Value x = js::at(r, j);
        if (!js::truthy(js::get(x, "lod"))) continue;
        RowAns &a = ans[lk[j]];
        a.lod = true;
        a.lodCount = js::num(js::get(x, "count"), 0);
        a.lodLevel = js::num(js::get(x, "level"), 0);
        a.lodWidth = js::num(js::get(x, "width"), 0);
        const Value fl = js::get(x, "flags");
        const std::string raw = fl.type() == T::Bytes ? fl.p->s : std::string();
        a.flags = deflCounts ? deflateRaw(raw) : raw;
        a.total = info[lk[j]].count;
        done[lk[j]] = 1;
      }
    }
  }
  stickyRest();
  // the cold rows in parallel: bit rows always, text rows when ranged and not held; biggest first. Held text rows are
  // answered from the store (every span), other text rows of a non-ranged window are loaded whole and kept.
  std::vector<size_t> par, whole, held;
  for (size_t k = 0; k < dist.size(); k++) {
    if (done[k]) continue;
    if (info[k].text && heldRow(dist[k]).held) held.push_back(k);
    else if (info[k].text && (!ranged || isDerived(dist[k]))) whole.push_back(k);
    else par.push_back(k);
  }
  // finished answers from the cache
  std::vector<std::string> keys(dist.size());
  {
    std::vector<size_t> left;
    for (size_t k : par) {
      if (info[k].text) { left.push_back(k); continue; }  // (text rows: their answer depends on whether they are held)
      keys[k] = AnsCache::key(dist[k], t0, t1, B, budget, deflCounts);
      if (const RowAns *c = g_ans.get(keys[k])) { ans[k] = *c; ans[k].tile = true; } else left.push_back(k);
    }
    par.swap(left);
  }
  // tasks: a row whole, or one time part of a dense bit row; the costliest first
  auto cost = [&](size_t k) {
    const double frac = te > 0 ? std::min(1.0, (t1 - t0) / te) : 1.0;
    return info[k].count * frac;
  };
  struct Task { size_t k; int part; double cost; };
  std::vector<Task> tasks;
  std::vector<std::vector<uint64_t>> cuts(dist.size());
  std::vector<std::vector<Sub>> subs(dist.size());
  const unsigned parts = g_pool->threads();
  for (size_t k : par) {
    const double c = cost(k);
    if (!info[k].text && c >= kSplitMin && c > 4 * B) cuts[k] = splitCuts(t0, t1, B, parts);
    if (cuts[k].size() > 2) {
      subs[k].resize(cuts[k].size() - 1);
      for (size_t j = 0; j + 1 < cuts[k].size(); j++) tasks.push_back({k, (int)j, c / (double)(cuts[k].size() - 1)});
    } else {
      cuts[k].clear();
      tasks.push_back({k, -1, c * std::max(1.0, info[k].bits / 8)});
    }
  }
  std::stable_sort(tasks.begin(), tasks.end(), [](const Task &a, const Task &b) { return a.cost > b.cost; });
  auto oneRow = [&](size_t k) {
    RowAns &a = ans[k];
    std::string ce;
    Value r = lib::call(lib::F.cacheWindowCold, {lib::Ids({dist[k]}), N(t0), N(t1), N(B), N(budget)}, &ce);
    a = RowAns();
    if (!ce.empty()) { a.err = true; a.error = ce; }
    else fromWindow(js::at(r, 0), a, deflCounts, false);
    if (a.err) a.error = plainText(a.error);
    if (!a.err) a.total = info[k].count;
  };
  g_pool->run(tasks.size(), [&](size_t i) {
    if (g_cancelRun.load(std::memory_order_relaxed)) return;
    const Task &tk = tasks[i];
    if (tk.part < 0) { oneRow(tk.k); return; }
    const std::vector<uint64_t> &ks = cuts[tk.k];
    const uint64_t T0 = (uint64_t)t0, S = (uint64_t)t1 - T0, Bu = (uint64_t)B;
    const double a = (double)bnd(T0, S, Bu, ks[tk.part]), b = (double)bnd(T0, S, Bu, ks[tk.part + 1]), bj = (double)(ks[tk.part + 1] - ks[tk.part]);
    std::string ce;
    Value r = js::at(lib::call(lib::F.cacheWindowCold, {lib::Ids({dist[tk.k]}), N(a), N(b), N(bj), N(budget)}, &ce), 0);
    Sub &s = subs[tk.k][tk.part];
    if (!ce.empty() || r.type() != T::Obj || !js::undef(js::get(r, "error"))) return;  // (merge falls back)
    const Value rec = js::get(r, "records"), cnt = js::get(r, "counts");
    if (rec.type() != T::Bytes) return;
    s.rec = rec.p->s;
    s.count = js::num(js::get(r, "count"), 0);
    if (cnt.type() == T::Bytes) { s.hasCnt = true; s.cnt = cnt.p->s; }
    s.ok = true;
  });
  if (g_cancelRun.load()) { Reply c; c.ok = false; c.error = "cancelled"; return c; }
  {
    std::vector<size_t> redo;
    for (size_t k : par) {
      if (cuts[k].empty()) continue;
      RowAns &a = ans[k];
      if (mergeSplit(t0, t1, B, (uint32_t)info[k].bits, cuts[k], subs[k], a, deflCounts, g_bounds.cap)) a.total = info[k].count;
      else redo.push_back(k);
      subs[k].clear();
    }
    g_pool->run(redo.size(), [&](size_t i) { if (!g_cancelRun.load(std::memory_order_relaxed)) oneRow(redo[i]); });
    if (g_cancelRun.load()) { Reply c; c.ok = false; c.error = "cancelled"; return c; }
  }
  // text rows answered whole (the store: command thread only)
  // (each row is answered right after its load: a later load may drop it again)
  std::vector<size_t> textRows(held);
  textRows.insert(textRows.end(), whole.begin(), whole.end());
  std::sort(textRows.begin(), textRows.end());
  for (size_t k : textRows) {
    RowAns &a = ans[k];
    std::string le;
    if (!heldRow(dist[k]).held && !holdRow(dist[k], le)) { a.err = true; a.error = plainText(le); continue; }
    std::string we;
    Value w = lib::call(lib::F.cacheWindow, {N((double)dist[k]), N(t0), N(t1), N(B), N(budget)}, &we);
    a = RowAns();
    if (!we.empty()) { a.err = true; a.error = plainText(we); continue; }
    fromWindow(w, a, deflCounts, true);
    a.store = true;
  }
  // (a computed row's reason belongs to its request: never kept for the open)
  for (size_t k = 0; k < dist.size(); k++) if (ans[k].err && stickyErr(ans[k].error) && !isComputed(dist[k])) g_f.pendSticky.push_back({dist[k], ans[k].error});
  for (size_t k : par) if (!ans[k].err && !info[k].text) g_ans.put(keys[k], dist[k], ans[k]);

  // a computed row's whole-history change count is not known (only its window is computed): no total
  for (size_t k = 0; k < dist.size(); k++) if (dist[k] >= g_f.computedFirst && dist[k] < g_f.computedFirst + g_f.computedN) ans[k].total = NAN;
  // capture gaps: totals, counts and bucket counts leave out the unseen changes
  std::vector<size_t> listed;
  for (size_t g = 0; g < g_f.gapList.size(); g++) if (g_f.gapList[g].f + 1 < t1 && g_f.gapList[g].E > t0) listed.push_back(g);
  if (!g_f.gapList.empty()) {
    const uint64_t T0 = (uint64_t)t0, S = (uint64_t)(t1 - t0), Bu = (uint64_t)B;
    auto edge = [&](uint64_t k) { return (double)bnd(T0, S, Bu, k); };
    auto bucketOf = [&](double x) {  // the last k with edge k <= x
      uint64_t lo = 0, hi = Bu - 1;
      while (lo < hi) { const uint64_t m = (lo + hi + 1) / 2; if (edge(m) <= x) lo = m; else hi = m - 1; }
      return lo;
    };
    for (size_t k = 0; k < dist.size(); k++) {
      RowAns &a = ans[k];
      if (a.err) continue;
      if (a.total == a.total) a.total -= unseenTotal(dist[k]);
      if (a.lod) continue;
      for (size_t g : listed) {
        const double lo = std::max(t0, g_f.gapList[g].f + 1), hi = std::min(t1, g_f.gapList[g].E);
        if (!(hi > lo)) continue;
        // the lost changes: a one-bucket, non-LOD window over [lo, hi) under the per-row cap; a failed read fails the
        // whole command with its text
        std::string ce;
        Value xr = js::at(lib::call(lib::F.cacheWindowCold, {lib::Ids({dist[k]}), N(lo), N(hi), N(1), N(budget)}, &ce), 0);
        if (ce.empty() && xr.type() == T::Obj && !js::undef(js::get(xr, "error"))) ce = js::String(js::get(xr, "error"));
        if (!ce.empty()) return err(plainText(ce));
        const double lost = js::num(js::get(xr, "count"), 0);
        g_f.unseenMemo[std::make_tuple(dist[k], lo, hi)] = lost;
        if (!(lost > 0)) continue;
        a.count -= lost;
        if (!a.hasCnt || !(t1 > t0)) continue;
        std::string raw = deflCounts ? inflateRaw(a.cnt) : a.cnt;
        if (raw.size() != Bu * 4) continue;
        // each window bucket that holds a lost change is read whole too (a range scan under the per-row cap); a cap
        // refusal there fails the whole command (the one-bucket [lo, hi) read alone may not refuse)
        if (!info[k].text) {
          const uint64_t k0 = bucketOf(lo), k1 = bucketOf(hi - 1);
          for (uint64_t kb = k0; kb <= k1; kb++) {
            const double e0 = edge(kb), e1 = kb + 1 < Bu ? edge(kb + 1) : t1;
            if (!(e1 > e0)) continue;
            std::string fe;
            Value sr = js::at(lib::call(lib::F.searchScan, {lib::Ids({dist[k]}), N(e0), N(1), ::S(""), N(e1 - 1)}, &fe), 0);
            if (fe.empty() && sr.type() == T::Obj && !js::undef(js::get(sr, "error"))) fe = js::String(js::get(sr, "error"));
            if (!fe.empty() && largerThan(fe)) return err(fe);
          }
        }
        uint32_t *c = (uint32_t *)&raw[0];
        // each lost change off the bucket that holds its time: bisect the buckets [k0, k1] by their changes
        std::function<void(uint64_t, uint64_t)> take = [&](uint64_t k0, uint64_t k1) {
          const double p = std::max(lo, edge(k0)), q = std::min(hi, k1 + 1 < Bu ? edge(k1 + 1) : hi);
          const double n = changesIn(dist[k], p, q);
          if (!(n > 0)) return;
          if (k0 == k1) { c[k0] = c[k0] >= (uint32_t)n ? c[k0] - (uint32_t)n : 0; return; }
          const uint64_t m = (k0 + k1) / 2;
          take(k0, m); take(m + 1, k1);
        };
        take(bucketOf(lo), bucketOf(hi - 1));
        a.cnt = deflCounts ? deflateRaw(raw) : raw;
      }
    }
  }
  for (size_t k = 0; k < dist.size(); k++)  // (densities for the range scans' first span)
    if (!ans[k].err && !ans[k].lod && t1 > t0) {
      double &d = g_f.winDensity[dist[k]];
      d = std::max(d, ans[k].count / (t1 - t0));
    }
  // headers in request order, then the payloads
  Reply out;
  std::string o = "{\"signals\":[";
  for (size_t i = 0; i < ids.size(); i++) {
    const RowAns &a = ans[slot[ids[i]]];
    if (i) o += ',';
    o += "{\"signalId\":"; js::jnum(o, (double)ids[i]);
    if (a.err) {
      o += ",\"error\":"; js::jstr(o, a.error);
      o += ",\"bytes\":0,\"bucketBytes\":0";
      if (permanentErr(a.error)) o += ",\"permanent\":true";
      o += '}';
      continue;
    }
    if (a.lod) {
      o += ",\"lod\":true,\"exact\":false,\"countEstimate\":"; js::jnum(o, a.lodCount);
      o += ",\"bytes\":0,\"bucketBytes\":"; js::jnum(o, (double)a.flags.size());
      o += ",\"lodLevel\":"; js::jnum(o, a.lodLevel);
      o += ",\"lodWidth\":"; js::jnum(o, a.lodWidth);
      o += ",\"cached\":false,\"walkMs\":0";
      if (a.total == a.total) { o += ",\"total\":"; js::jnum(o, a.total); }
      o += '}';
      out.bin += a.flags;
      continue;
    }
    o += ",\"exact\":"; o += a.exact ? "true" : "false";
    o += ",\"count\":"; js::jnum(o, a.count);
    o += ",\"bytes\":"; js::jnum(o, (double)a.rec.size());
    o += ",\"bucketBytes\":"; js::jnum(o, a.hasCnt ? (double)a.cnt.size() : 0);
    o += ",\"cached\":false,\"walkMs\":"; js::jnum(o, js::toFixed(a.walkMs, 3));
    if (ranged && !a.store) o += ",\"ranged\":true";
    if (a.tile) o += ",\"tile\":true";
    if (a.total == a.total) { o += ",\"total\":"; js::jnum(o, a.total); }
    if (a.text) {
      o += ",\"text\":true,\"kind\":"; js::jstr(o, a.kind);
      if (a.minmax) { o += ",\"min\":"; js::jnum(o, a.mn); o += ",\"max\":"; js::jnum(o, a.mx); }
      if (a.hasMean) { o += ",\"textMean\":"; js::jnum(o, js::toFixed(a.mean, 1)); }
      if (a.cut) o += ",\"cut\":true";
    }
    o += '}';
    out.bin += a.rec;
    if (a.hasCnt) out.bin += a.cnt;
  }
  o += ']';
  if (!listed.empty()) {
    o += ",\"gaps\":[";
    for (size_t i = 0; i < listed.size(); i++) { if (i) o += ','; o += g_f.gapList[listed[i]].json; }
    o += ']';
  }
  o += '}';
  out.result = std::move(o);
  return out;
}

// ================================================================ valueAt
static Reply cmdValueAt(const Value &req) {
  double t;
  std::string e;
  if (!timeOk(js::get(req, "t"), "t", t, e)) return err(e);
  std::vector<int64_t> ids;
  if (!idsOk(js::get(req, "signalIds"), ids, e)) return err(e);
  const bool prev = js::truthy(js::get(req, "prev"));
  if (overMemory(e)) return err(e);
  std::vector<int64_t> dist;
  std::unordered_map<int64_t, size_t> slot;
  for (int64_t id : ids) if (slot.emplace(id, dist.size()).second) dist.push_back(id);
  const std::vector<RowInfo> info = rowInfo(dist);
  struct VA { bool have = false; std::string v; bool hasP = false; double pt = 0; bool pv = false; std::string pval; std::string err; };
  std::vector<VA> va(dist.size());
  g_pool->run(dist.size(), [&](size_t k) {
    if (g_cancelRun.load(std::memory_order_relaxed)) return;
    VA &x = va[k];
    if (isDerived(dist[k])) return;  // (answered from the store below: command thread)
    Value r = lib::call(lib::F.coldValueAt, {lib::Ids({dist[k]}), N(t)});
    Value v = js::at(r, 0);
    if (v.type() == T::Obj && js::has(v, "error")) { x.err = js::String(js::get(v, "error")); return; }  // the reason goes in "errors" (same text as window)
    if (v.type() != T::Str) return;
    x.have = true; x.v = v.p->s;
    if (!prev || info[k].err || info[k].text) return;
    // the last change at or before t: [t - span, t], the span growing until it reaches 0
    for (double span = scanSpan0(dist[k]);; span *= 8) {
      if (span >= t) span = t;
      Value n = js::at(lib::call(lib::F.coldValueNear, {lib::Ids({dist[k]}), N(t), N(span)}), 0);
      if (n.type() != T::Obj || js::has(n, "error")) { x.have = false; if (n.type() == T::Obj) x.err = js::String(js::get(n, "error")); return; }  // (unreadable: value and prev null, the reason in "errors")
      const Value pt = js::get(n, "t");
      if (pt.type() == T::Num) { x.hasP = true; x.pt = pt.p->n; return; }
      if (span >= t) return;
    }
  });
  if (g_cancelRun.load()) { Reply c; c.ok = false; c.error = "cancelled"; return c; }
  // derived rows: value (and prev) from the store
  for (size_t k = 0; k < dist.size(); k++) {
    if (!isDerived(dist[k])) continue;
    std::string le;
    if (!ensureDerived(dist[k], le)) { va[k].err = le; continue; }
    Value v = lib::call(lib::F.cacheValueAt, {N((double)dist[k]), N(t)});
    if (v.type() != T::Str) { va[k].err = "cannot read the derived signal"; continue; }
    va[k].have = true; va[k].v = v.p->s;
    if (!prev) continue;
    Value lc = lib::call(lib::F.cacheLastChange, {N((double)dist[k]), N(t)});
    const Value pt = js::get(lc, "t");
    if (pt.type() != T::Num) continue;
    Value pv = lib::call(lib::F.cacheValueAt, {N((double)dist[k]), N(pt.p->n)});
    va[k].hasP = true; va[k].pt = pt.p->n;
    if (pv.type() == T::Str) { va[k].pv = true; va[k].pval = pv.p->s; }
  }
  if (prev) {
    // text rows: prev from the row held whole ({t, value} of its last change as the store prints it). A row not held
    // now (never loaded, or dropped by the rows-held limit) is loaded here, as window / edge / search do; a row that
    // cannot be held (its load's error, or a remembered `larger than`) answers null for both with the reason in
    // "errors", never a bare null
    for (size_t k = 0; k < dist.size(); k++) {
      if (!va[k].have || info[k].err || !info[k].text || isDerived(dist[k])) continue;
      if (stickyLarger(dist[k])) { va[k].have = false; va[k].err = plainText(g_f.sticky.find(dist[k])->second); continue; }
      std::string le;
      if (!heldRow(dist[k]).held && !holdRow(dist[k], le)) { va[k].have = false; va[k].err = plainText(le.empty() ? std::string("cannot load") : le); continue; }
      Value lc = lib::call(lib::F.cacheLastChange, {N((double)dist[k]), N(t)});
      const Value pt = js::get(lc, "t");
      if (pt.type() != T::Num) continue;
      // the value of that change as valueAt prints it (the store's own "value" is its raw form: a real's bit pattern,
      // a string's code bytes), so prev.value and values[] use one text for the same change
      Value pv = js::at(lib::call(lib::F.coldValueAt, {lib::Ids({dist[k]}), N(pt.p->n)}), 0);
      if (pv.type() != T::Str) { va[k].have = false; va[k].err = pv.type() == T::Obj && js::has(pv, "error") ? js::String(js::get(pv, "error")) : std::string("prev: the value of the last change cannot be read"); continue; }
      va[k].hasP = true; va[k].pt = pt.p->n; va[k].pv = true; va[k].pval = pv.p->s;
    }
  }
  if (unrecordedAt(t)) {  // (nothing was recorded at t)
    std::string o = "{\"values\":[";
    for (size_t i = 0; i < ids.size(); i++) { if (i) o += ','; o += "null"; }
    o += ']';
    if (prev) { o += ",\"prev\":["; for (size_t i = 0; i < ids.size(); i++) { if (i) o += ','; o += "null"; } o += ']'; }
    return res(o + ",\"notRecorded\":true,\"cold\":0}");
  }
  std::string o = "{\"values\":[";
  for (size_t i = 0; i < ids.size(); i++) {
    if (i) o += ',';
    const VA &x = va[slot[ids[i]]];
    if (x.have) js::jstr(o, x.v); else o += "null";
  }
  o += ']';
  if (prev) {
    o += ",\"prev\":[";
    for (size_t i = 0; i < ids.size(); i++) {
      if (i) o += ',';
      const VA &x = va[slot[ids[i]]];
      if (x.have && x.hasP && unseenGap(x.pt) >= 0) o += "{\"t\":null,\"notRecorded\":true}";
      else if (x.have && x.hasP) { o += "{\"t\":"; js::jnum(o, x.pt); o += ",\"value\":"; js::jstr(o, x.pv ? x.pval : x.v); o += '}'; }
      else o += "null";
    }
    o += ']';
  }
  {  // "errors": present only when a signal could not be read; per requested id, null or the reason (the window reply's text)
    bool any = false; for (const auto &x : va) any = any || !x.err.empty();
    if (any) { o += ",\"errors\":["; for (size_t i = 0; i < ids.size(); i++) { if (i) o += ','; const VA &x = va[slot[ids[i]]]; if (x.err.empty()) o += "null"; else js::jstr(o, x.err); } o += ']'; }
  }
  o += ",\"cold\":"; js::jnum(o, (double)dist.size());
  o += '}';
  return res(o);
}

// ================================================================ edge and search
// Rounds of searchScan over [t, t + span] (or [t - span, t]), the span growing 8x a round, until a hit or the end.
static Reply scanRounds(int64_t id, double t, int dir, const std::string &pat, int kind) {
  double span = scanSpan0(id);
  double cur = t;
  const double kMax = 18446744073709551615.0;
  for (int round = 1;; round++) {
    double bound;
    bool last = false;
    if (dir > 0) { bound = cur + span; if (bound >= g_f.timeEnd) { bound = kMax; last = true; } }
    else { bound = cur - span; if (bound <= 0) { bound = 0; last = true; } }
    std::vector<Value> a{lib::Ids({id}), N(cur), N(dir), S(pat), N(bound)};
    if (kind >= 0) { a.push_back(N(kind)); a.push_back(N(g_f.timeStart)); }
    std::string ce;
    Value r = js::at(lib::call(lib::F.searchScan, a, &ce), 0);
    if (!ce.empty()) return err(plainText(ce));
    if (r.type() != T::Obj) return err("no answer");
    if (!js::undef(js::get(r, "error"))) return err(plainText(js::String(js::get(r, "error"))));
    const Value ht = js::get(r, "t");
    std::string o = "{\"t\":";
    if (ht.type() == T::Num) { js::jnum(o, ht.p->n); o += ",\"ranged\":"; js::jnum(o, round); o += '}'; return res(o); }
    const Value nb = js::get(r, "bound");
    if (nb.type() == T::Num) { cur = nb.p->n; continue; }  // (narrowed to the signal cap: resume there)
    if (last) { o += "null,\"ranged\":"; js::jnum(o, round); o += '}'; return res(o); }
    cur = bound;
    span *= 8;
  }
}

// Capture gaps: an answer at an unseen-change time runs again past its gap (forward from u, backward from f + 1); forward
// into a gap with no resume answers null. At most (gaps + 1) runs; diagnostic fields from the last one.
static Reply gapRerun(double t, int dir, const std::function<Reply(double)> &run) {
  Reply r = run(t);
  for (size_t n = 0; n <= g_f.gapList.size(); n++) {
    if (!r.ok || g_f.gapList.empty() || g_cancelRun.load()) return r;
    std::string pe;
    Napi::NodeP p = wjson::parse(r.result, pe);
    if (!p) return r;
    const Value v(p);
    const Value ht = js::get(v, "t");
    if (ht.type() != T::Num) return r;
    const int g = unseenGap(ht.p->n);
    if (g < 0) return r;
    const auto &gp = g_f.gapList[g];
    if (dir > 0 && gp.toEnd) {
      std::string o = "{\"t\":null";
      const Value rg = js::get(v, "ranged");
      if (rg.type() == T::Num) { o += ",\"ranged\":"; js::jnum(o, rg.p->n); }
      return res(o + "}");
    }
    if (n == g_f.gapList.size()) return r;
    r = run(dir > 0 ? gp.u : gp.f + 1);
  }
  return r;
}

// A text row (string, real) is answered from the row held whole: edge finds any change for every kind (no
// `ranged`), search gives the store's own refusal. A text row with a remembered `larger than` goes to range scans.
static Reply edgeOnce(int64_t id, double t, int dir, int kind) {
  const RowInfo ri = rowInfo({id})[0];
  if (!ri.err && ri.text && !stickyLarger(id)) {
    std::string le;
    if (!heldRow(id).held && !holdRow(id, le)) return err(le);
    std::string ce;
    Value r = lib::call(lib::F.cacheEdge, {N((double)id), N(t), N(dir), N(kind), N(g_f.timeStart)}, &ce);
    if (!ce.empty()) return err(ce);
    std::string o = "{\"t\":";
    if (r.type() == T::Num) js::jnum(o, r.p->n); else o += "null";
    return res(o + "}");
  }
  return scanRounds(id, t, dir, "", kind);
}
static Reply searchOnce(int64_t id, double t, int dir, const std::string &pat) {
  const RowInfo ri = rowInfo({id})[0];
  if (!ri.err && ri.text && !stickyLarger(id)) {
    std::string le;
    if (!heldRow(id).held && !holdRow(id, le)) return err(le);
    std::string ce;
    Value r = lib::call(lib::F.cacheSearch, {N((double)id), N(t), N(dir), S(pat)}, &ce);
    if (!ce.empty()) return err(ce);
    std::string o = "{\"t\":";
    if (r.type() == T::Num) js::jnum(o, r.p->n); else o += "null";
    return res(o + "}");
  }
  return scanRounds(id, t, dir, pat, -1);
}

static Reply cmdEdge(const Value &req) {
  double t;
  std::string e;
  if (!timeOk(js::get(req, "t"), "t", t, e)) return err(e);
  const Value kv = js::get(req, "kind");
  int kind = 0;
  if (!js::nullish(kv)) {
    static const char *kinds[] = {"any", "rise", "fall", "posedge", "negedge", "edge"};
    kind = -1;
    if (kv.type() == T::Str) for (int k = 0; k < 6; k++) if (kv.p->s == kinds[k]) kind = k;
    if (kind < 0) { std::string o = "edge: unknown kind "; js::jval(o, kv); return err(o); }
  }
  int64_t id;
  const Value idv = js::get(req, "signalId");
  if (!idOk(idv, id)) return err("unknown signal #" + js::String(idv));
  const int dir = js::Number(js::get(req, "dir")) < 0 ? -1 : 1;
  if (overMemory(e)) return err(e);
  return gapRerun(t, dir, [&](double from) { return edgeOnce(id, from, dir, kind); });
}

static bool searchValueOk(const Value &v) {
  if (v.type() != T::Str) return false;  // (an empty value is valid)
  for (char c : v.p->s) if (!strchr("01xXzZ?", c) || !c) return false;
  return true;
}
static Reply cmdSearch(const Value &req) {
  double t;
  std::string e;
  if (!timeOk(js::get(req, "t"), "t", t, e)) return err(e);
  const Value val = js::get(req, "value");
  if (!searchValueOk(val)) return err("bad search value " + js::String(val));
  int64_t id;
  const Value idv = js::get(req, "signalId");
  if (!idOk(idv, id)) return err("unknown signal #" + js::String(idv));
  const Value wc = js::get(req, "wildcard");
  if (!js::nullish(wc) && !(wc.type() == T::Str && wc.p->s == "?")) return err("bad wildcard " + js::String(wc) + " (only '?')");
  const int dir = js::Number(js::get(req, "dir")) < 0 ? -1 : 1;
  if (overMemory(e)) return err(e);
  const std::string pat = js::nullish(wc) ? val.p->s : "!" + val.p->s;
  return gapRerun(t, dir, [&](double from) { return searchOnce(id, from, dir, pat); });
}

// ================================================================ count, free, stats
static Reply cmdCount(const Value &req) {
  std::vector<int64_t> ids;
  std::string e;
  if (!idsOk(js::get(req, "signalIds"), ids, e)) return err(e);
  const bool exact = js::truthy(js::get(req, "exact"));
  // (count loads nothing: a row held whole answers from the store, others from the source's count; no RSS check;
  // a derived row is built in the store if it was dropped)
  for (int64_t id : ids) if (isDerived(id)) { std::string le; if (!ensureDerived(id, le)) return err(le); }
  const std::vector<Value> r = srcCounts(ids);
  std::string o = "{\"counts\":[";
  for (size_t i = 0; i < ids.size(); i++) {
    if (i) o += ',';
    Value x = r[i];
    o += "{\"signalId\":"; js::jnum(o, (double)ids[i]);
    const HeldRow h = heldRow(ids[i]);
    if (h.held) {
      const double count = h.count - unseenTotal(ids[i]);
      o += ",\"count\":"; js::jnum(o, count);
      o += ",\"bits\":"; js::jnum(o, h.bits);
      o += ",\"xz\":"; o += h.xz ? "true" : "false";
      o += ",\"bytes\":"; js::jnum(o, count * (8 + h.bits));
      o += ",\"source\":\"store\"}";
      continue;
    }
    const Value er = js::get(x, "error");
    if (x.type() != T::Obj || !js::undef(er)) {
      if (exact && !js::undef(er)) { o += ",\"error\":"; js::jstr(o, js::String(er)); }
      else { o += ",\"unknown\":true"; if (!js::undef(er)) { o += ",\"error\":"; js::jstr(o, js::String(er)); } }  // (the reason, as window gives it)
      o += '}';
      continue;
    }
    const double count = js::num(js::get(x, "count"), 0) - unseenTotal(ids[i]), bits = js::num(js::get(x, "bits"), 0);
    o += ",\"count\":"; js::jnum(o, count);
    o += ",\"bits\":"; js::jnum(o, bits);
    o += ",\"xz\":"; o += js::truthy(js::get(x, "xz")) ? "true" : "false";
    o += ",\"bytes\":"; js::jnum(o, count * (8 + bits));
    o += ",\"source\":\"source\"}";
  }
  o += "]}";
  return res(o);
}

static Reply cmdFree(const Value &req) {
  const Value ids = js::get(req, "signalIds");
  if (js::undef(ids)) { lib::call(lib::F.cacheFree, {}); g_ans.clear(); }
  else for (size_t i = 0; i < js::len(ids); i++) if (js::at(ids, i).type() == T::Num) { lib::call(lib::F.cacheFree, {js::at(ids, i)}); g_ans.drop((int64_t)js::at(ids, i).p->n); }
  return res("{}");
}

static double rssKB() {
#if defined(__APPLE__)
  // (macOS has no /proc: the task's resident size from the kernel, the counterpart of statm's resident pages)
  mach_task_basic_info_data_t ti; mach_msg_type_number_t cnt = MACH_TASK_BASIC_INFO_COUNT;
  return task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&ti, &cnt) == KERN_SUCCESS ? (double)ti.resident_size / 1024 : 0;
#else
  FILE *f = fopen("/proc/self/status", "r");
  if (!f) return 0;
  char line[256];
  double kb = 0;
  while (fgets(line, sizeof line, f)) if (!strncmp(line, "VmRSS:", 6)) { kb = atof(line + 6); break; }
  fclose(f);
  return kb;
#endif
}
static uint64_t g_idleReleases = 0;
static bool g_idleArmed = false;  // a request ran since the last idle release (command thread only)
static std::chrono::steady_clock::time_point g_lastReqEnd = std::chrono::steady_clock::now();  // the last request's end (command thread)
static uint64_t g_idleChecks = 0;  // deferred checks started after the idle wait
static Reply cmdStats(const Value &) {
  std::string o = "{\"pid\":";
  js::jnum(o, (double)getpid());
  o += ",\"threads\":"; js::jnum(o, g_pool->threads());
  o += ",\"workers\":"; js::jnum(o, g_set.workers);
  o += ",\"open\":"; o += g_f.open ? "true" : "false";
  o += ",\"rssKB\":"; js::jnum(o, rssKB());
  o += ",\"idleReleases\":"; js::jnum(o, (double)g_idleReleases);
  o += ",\"idleChecks\":"; js::jnum(o, (double)g_idleChecks);
  o += ",\"memoryBound\":{\"innerMB\":"; js::jnum(o, std::round(g_bounds.inner / 1e6));
  o += ",\"hardMB\":"; js::jnum(o, std::round(g_libHard / 1e6)); o += ",\"heldOff\":"; o += g_floorAfterCheck ? "true" : "false"; o += '}';
  {  // a build with direct FSDB read: the thread default for an FSDB open's scan and check (CPU affinity, at most 16)
    const Value dt = js::get(lib::call(lib::F.sourceInfo, {}), "directThreads");
    if (!js::undef(dt)) { o += ",\"directThreads\":"; js::jval(o, dt); }
  }
  if (g_f.open) {
    Value info = lib::call(lib::F.sourceInfo, {N(1)});  // (1: waits for the deferred footer advice, so its count is final)
    o += ",\"blockLru\":"; js::jval(o, js::get(info, "blockLru"));
    o += ",\"memory\":"; js::jval(o, js::get(info, "memory"));
    if (!js::undef(js::get(info, "blockReads"))) {  // a WCZ file: block reads past the cache and the read-ahead advice given
      o += ",\"blockReads\":"; js::jval(o, js::get(info, "blockReads")); o += ",\"blockReadAheads\":"; js::jval(o, js::get(info, "blockReadAheads")); if (!js::undef(js::get(info, "footerRead"))) { o += ",\"footerRead\":"; js::jval(o, js::get(info, "footerRead")); } if (!js::undef(js::get(info, "footerPrefetch"))) { o += ",\"footerPrefetch\":"; js::jval(o, js::get(info, "footerPrefetch")); o += ",\"footerRangesDeferred\":"; js::jval(o, js::get(info, "footerRangesDeferred")); }
    }
    if (!js::undef(js::get(info, "check"))) {  // a file read directly: the whole-file check
      o += ",\"check\":"; js::jval(o, js::get(info, "check")); o += ",\"checkMs\":"; js::jval(o, js::get(info, "checkMs"));
      o += ",\"checkCpuMs\":"; js::jval(o, js::get(info, "checkCpuMs")); o += ",\"checkThreads\":"; js::jval(o, js::get(info, "checkThreads"));
      o += ",\"checkDone\":"; js::jval(o, js::get(info, "checkDone")); o += ",\"checkStart\":"; js::jval(o, js::get(info, "checkStart"));
      o += ",\"portLinks\":"; js::jval(o, js::get(info, "portLinks")); o += ",\"fullScope\":"; js::jval(o, js::get(info, "fullScope"));
      o += ",\"forceLog\":"; js::jval(o, js::get(info, "forceLog"));
      if (!js::undef(js::get(info, "openMode"))) { o += ",\"openMode\":"; js::jval(o, js::get(info, "openMode")); }
      if (!js::undef(js::get(info, "refusedMs"))) { o += ",\"refusedMs\":"; js::jval(o, js::get(info, "refusedMs")); }
      // computed signals (an open with outsideWrites none): count, first id, the per-open build and the requests so far
      if (!js::undef(js::get(info, "computed"))) { o += ",\"computed\":"; js::jval(o, js::get(info, "computed")); }
    }
    Value cs = lib::call(lib::F.cacheStats, {});
    o += ",\"storeBytes\":"; js::jval(o, js::get(cs, "bytes"));
  }
  o += '}';
  return res(o);
}

// ================================================================ dispatch
static const std::unordered_set<std::string> kKnown = {"open", "children", "close", "cancel", "window", "count", "valueAt", "edge", "search",
                                                       "free", "stats", "signals", "aliasHints", "derive", "searchAll", "searchText",
                                                       "clockVerify", "clockInfo", "warm", "verify"};

// ================================================================ derive (derived signals)
// derive {expr} -> {signalId, width, count, bits, xz, operands, materialized}: a signal computed from stored ones,
// answered by window / valueAt (with prev) / edge / search / count like a stored one. Its id is 1e9 or above; the same
// program over the same operands gives the same id for the life of the open. Built whole in the store (lib/addon's
// cacheDerive: one merge over the operands' changes, a record only where the result changes; all x before the first
// change) and rebuilt when the store dropped it. Semantics follow the viewer helper's earlier derive command:
// results are evaluated once per distinct operand change time.
// Expressions (SystemVerilog, a subset): #<signalId>, sized binary literals (1'bx, 4'b10x1), parentheses, unary ~ ^ & |
// (reductions give 1 bit), binary & ^ | (operands zero-extended to the wider), == != === !== (1 bit). Precedence as
// SystemVerilog: unary, then equality, &, ^, |. Driver tracing asks for "(^#id) === 1'bx" (1 while any bit is x or z)
// and "(#id ^ #id)" (x where the value has x or z, else 0).
namespace dexpr {
// deval.h's DOp numbers (lib/addon/deval.h, enum DOp)
enum { SIG = 0, CONST = 1, NOT = 5, AND = 6, OR = 7, XOR = 8, RAND = 9, ROR = 10, RXOR = 11, EQ = 15, NE = 16, EXT = 25, CEQ = 32, CNE = 33 };
using Def = FileState::DNodeDef;
struct Parser {
  static constexpr int kMaxDepth = 256;
  const std::string &s;
  size_t i = 0;
  int depth = 0;
  std::vector<Def> prog;
  std::vector<int64_t> operands;
  std::string error;
  explicit Parser(const std::string &t) : s(t) {}
  void ws() { while (i < s.size() && isspace((unsigned char)s[i])) i++; }
  bool eat(const char *t) {
    ws();
    const size_t n = strlen(t);
    if (s.compare(i, n, t) != 0) return false;
    // (a single & | ^ ~ = ! must not be the start of a longer operator)
    i += n;
    return true;
  }
  bool peekIs(const char *t) { ws(); return s.compare(i, strlen(t), t) == 0; }
  int node(Def d) { prog.push_back(std::move(d)); return (int)prog.size() - 1; }
  int ext(int a, uint32_t w) {
    if (a < 0 || prog[a].w == w) return a;
    Def d; d.op = EXT; d.w = w; d.a = a; return node(d);
  }
  int fail(const std::string &m) { if (error.empty()) error = m + " at " + std::to_string(i); return -1; }
  bool enterNested() {
    if (depth >= kMaxDepth) { error = "expression nested too deeply"; return false; }
    depth++;
    return true;
  }
  int primary() {
    ws();
    if (i >= s.size()) return fail("expression ends early");
    if (s[i] == '(') {
      if (!enterNested()) return -1;
      i++;
      const int r = expr();
      depth--;
      if (r < 0) return r;
      if (!eat(")")) return fail("missing )");
      return r;
    }
    if (s[i] == '#') {
      i++;
      size_t j = i;
      while (j < s.size() && isdigit((unsigned char)s[j])) j++;
      if (j == i) return fail("bad signal reference");
      const std::string num = s.substr(i, j - i);
      i = j;
      const double dv = atof(num.c_str());
      int64_t id;
      if (!idOk(N(dv), id)) return fail("unknown signal #" + num);
      uint32_t w = 0;
      if (isDerived(id)) w = g_f.derived[id].width;
      else {
        const RowInfo ri = rowInfo({id})[0];
        if (ri.err) return fail("signal #" + num + ": " + ri.error);
        if (ri.text) return fail("a " + ri.kind + " signal can't be an expression operand");
        w = (uint32_t)ri.bits;
      }
      if (w < 1) return fail("signal #" + num + " has no width");
      int k = -1;
      for (size_t q = 0; q < operands.size(); q++) if (operands[q] == id) k = (int)q;
      if (k < 0) { k = (int)operands.size(); operands.push_back(id); }
      Def d; d.op = SIG; d.w = w; d.k = k; return node(d);
    }
    if (isdigit((unsigned char)s[i])) {
      size_t j = i;
      while (j < s.size() && isdigit((unsigned char)s[j])) j++;
      const long w = atol(s.substr(i, j - i).c_str());
      if (j + 1 >= s.size() || s[j] != '\'' || (s[j + 1] != 'b' && s[j + 1] != 'B')) return fail("only sized binary literals (like 1'bx)");
      j += 2;
      std::string bits;
      while (j < s.size() && strchr("01xXzZ_", s[j])) { if (s[j] != '_') bits += (char)tolower(s[j]); j++; }
      i = j;
      if (w < 1 || w > 65536 || bits.empty()) return fail("bad literal");
      // (a literal narrower than its size is padded with 0, or with x / z when its top digit is x / z)
      const char pad = bits[0] == 'x' || bits[0] == 'z' ? 'x' : '0';
      for (char &c : bits) if (c == 'z') c = 'x';
      if ((long)bits.size() > w) bits = bits.substr(bits.size() - (size_t)w);
      if ((long)bits.size() < w) bits = std::string((size_t)w - bits.size(), pad) + bits;
      Def d; d.op = CONST; d.w = (uint32_t)w; d.bits = bits; return node(d);
    }
    return fail("unexpected character");
  }
  int unary() {
    ws();
    if (i < s.size() && (s[i] == '~' || s[i] == '^' || s[i] == '&' || s[i] == '|')) {
      if (!enterNested()) return -1;
      const char c = s[i++];
      const int a = unary();
      depth--;
      if (a < 0) return a;
      Def d; d.a = a;
      if (c == '~') { d.op = NOT; d.w = prog[a].w; } else { d.op = c == '^' ? RXOR : c == '&' ? RAND : ROR; d.w = 1; }
      return node(d);
    }
    return primary();
  }
  int binop(int op, int a, int b, bool compare) {
    if (a < 0 || b < 0) return -1;
    const uint32_t w = std::max(prog[a].w, prog[b].w);
    a = ext(a, w); b = ext(b, w);
    Def d; d.op = op; d.w = compare ? 1 : w; d.a = a; d.b = b; return node(d);
  }
  int equality() {
    int a = unary();
    for (;;) {
      if (a < 0) return a;
      int op;
      if (eat("===")) op = CEQ; else if (eat("!==")) op = CNE; else if (eat("==")) op = EQ; else if (eat("!=")) op = NE; else return a;
      a = binop(op, a, unary(), true);
    }
  }
  int band() { int a = equality(); while (a >= 0 && !peekIs("&&") && eat("&")) a = binop(AND, a, equality(), false); return a; }
  int bxor() { int a = band(); while (a >= 0 && eat("^")) a = binop(XOR, a, band(), false); return a; }
  int bor() { int a = bxor(); while (a >= 0 && !peekIs("||") && eat("|")) a = binop(OR, a, bxor(), false); return a; }
  int expr() { return bor(); }
};
}  // namespace dexpr

static bool ensureDerived(int64_t id, std::string &e) {
  auto it = g_f.derived.find(id);
  if (it == g_f.derived.end()) { e = "unknown signal #" + std::to_string(id); return false; }
  if (heldRow(id).held) return true;
  const FileState::Derived &d = it->second;
  // the operands whole in the store (a derived operand: built first)
  for (int64_t op : d.operands) {
    if (heldRow(op).held) continue;
    std::string le;
    if (!holdRow(op, le)) { e = "derive: signal #" + std::to_string(op) + ": " + plainText(le.empty() ? std::string("cannot load") : le); return false; }
  }
  Napi::Array prog = Napi::Array::New(Napi::Env());
  for (size_t i = 0; i < d.program.size(); i++) {
    const auto &n = d.program[i];
    Napi::Object o = Napi::Object::New(Napi::Env());
    o.Set("op", N(n.op));
    o.Set("w", N(n.w));
    if (n.a >= 0) o.Set("a", N(n.a));
    if (n.b >= 0) o.Set("b", N(n.b));
    if (n.k >= 0) o.Set("k", N(n.k));
    if (n.op == dexpr::CONST) o.Set("bits", lib::S(n.bits));
    prog.Set((uint32_t)i, o);
  }
  Napi::Array ops = Napi::Array::New(Napi::Env());
  for (size_t i = 0; i < d.operands.size(); i++) {
    Napi::Object o = Napi::Object::New(Napi::Env());
    o.Set("id", N((double)d.operands[i]));
    ops.Set((uint32_t)i, o);
  }
  std::string ce;
  Napi::Object opt = Napi::Object::New(Napi::Env());
  opt.Set("start", N(g_f.timeStart));  // (all x from the dump's start until an operand's first stored change)
  lib::call(lib::F.cacheDerive, {N((double)id), prog, ops, Napi::Boolean::New(Napi::Env(), true), opt}, &ce);
  if (!ce.empty()) { e = "derive: " + ce; return false; }
  if (!heldRow(id).held) { e = "derive: the result was dropped at once (store limit)"; return false; }
  return true;
}

static Reply cmdDerive(const Value &req) {
  const Value ev = js::get(req, "expr");
  if (ev.type() != T::Str || ev.p->s.empty() || ev.p->s.size() > 65536) return err("derive needs expr");
  std::string e;
  if (overMemory(e)) return err(e);
  dexpr::Parser P(ev.p->s);
  const int root = P.expr();
  P.ws();
  if (P.error.empty() && P.i != P.s.size()) P.fail("unexpected text");
  if (root < 0 || !P.error.empty()) return err("derive: " + (P.error.empty() ? std::string("bad expression") : P.error));
  if (P.operands.empty()) return err("derive: expression has no signals");
  std::string key;
  for (const auto &n : P.prog) key += std::to_string(n.op) + ',' + std::to_string(n.w) + ',' + std::to_string(n.a) + ',' + std::to_string(n.b) + ',' + std::to_string(n.k) + ',' + n.bits + ';';
  key += '|';
  for (int64_t id : P.operands) key += std::to_string(id) + ',';
  int64_t id;
  bool created = false;
  auto k = g_f.derivedByKey.find(key);
  if (k != g_f.derivedByKey.end()) id = k->second;
  else {
    id = g_f.nextDerived++;
    FileState::Derived d;
    d.program = P.prog; d.operands = P.operands; d.width = P.prog[(size_t)root].w; d.expr = ev.p->s;
    // (the last node is the result)
    if ((size_t)root + 1 != d.program.size()) return err("derive: bad program");
    g_f.derived[id] = d;
    g_f.derivedByKey[key] = id;
    created = true;
  }
  const auto t0 = std::chrono::steady_clock::now();
  if (!ensureDerived(id, e)) {
    if (created) { g_f.derived.erase(id); g_f.derivedByKey.erase(key); }
    return err(e);
  }
  const HeldRow h = heldRow(id);
  std::string o = "{\"signalId\":"; js::jnum(o, (double)id);
  o += ",\"width\":"; js::jnum(o, g_f.derived[id].width);
  o += ",\"count\":"; js::jnum(o, h.count);
  o += ",\"xz\":"; o += h.xz ? "true" : "false";
  o += ",\"operands\":[";
  for (size_t i = 0; i < P.operands.size(); i++) { if (i) o += ','; js::jnum(o, (double)P.operands[i]); }
  o += "],\"created\":"; o += created ? "true" : "false";
  o += ",\"materializeMs\":"; js::jnum(o, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
  return res(o + "}");
}

static Reply dispatchValue(const std::string &cmd, const Value &req);
static Reply dispatch(const Value &req) {
  const Value cv = js::get(req, "cmd");
  const std::string cmd = js::String(cv);
  if (cv.type() != T::Str || !kKnown.count(cmd)) return err("unknown command " + cmd);
  if (cmd == "open") { wdReset(); return cmdOpen(req); }
  if (cmd == "close") { closeFile(); return res("{}"); }
  if (g_f.open) checkRunning();  // every command: once the lazy check has ended, the bound is set again before it runs
  if (cmd == "stats") return cmdStats(req);
  if (!g_f.open) return err("no file open");
  if (cmd == "children") return cmdChildren(req);
  if (cmd == "verify") {  // the whole-file check on demand: {ok, error?, ms}; a refusal has code fileRefused
    if (js::Number(js::get(lib::call(lib::F.checkNow, {}), "state")) == 4) holdBoundsForCheck();  // (a deferred check starts here)
    const Value v = lib::call(lib::F.verifyFile, {});
    if (!js::truthy(js::get(v, "ok"))) return err(js::String(js::get(v, "error")), js::String(js::get(v, "error")).rfind(FILE_REFUSED, 0) == 0 ? "fileRefused" : "");
    std::string o = "{\"ok\":true,\"ms\":"; js::jval(o, js::get(v, "ms")); return res(o + "}");
  }
  // a value request on a file read directly waits for the whole-file check; a file it refuses gives no value at all
  static const std::unordered_set<std::string> kValues = {"window", "count", "valueAt", "edge", "search", "searchAll", "searchText", "derive", "clockVerify", "clockInfo", "warm"};
  if (g_f.open && kValues.count(cmd)) {
    const std::string why = js::String(lib::call(lib::F.checkFile, {}));
    if (!why.empty()) return err(why, "fileRefused");
    const Value cn = lib::call(lib::F.checkNow, {});
    if (js::truthy(js::get(cn, "lazy"))) {  // lazy FSDB open: the answer is verified only if the check had passed before it was built
      const bool before = js::Number(js::get(cn, "state")) == 1;
      Reply r = dispatchValue(cmd, req);
      if (r.ok) {
        const std::string why2 = js::String(lib::call(lib::F.checkFile, {}));
        if (!why2.empty()) return err(why2, "fileRefused");
        r.verified = before ? 1 : 0;
      }
      return r;
    }
  }
  return dispatchValue(cmd, req);
}
static Reply dispatchValue(const std::string &cmd, const Value &req) {
  if (cmd == "window") return cmdWindow(req);
  if (cmd == "valueAt") return cmdValueAt(req);
  if (cmd == "edge") return cmdEdge(req);
  if (cmd == "search") return cmdSearch(req);
  if (cmd == "count") return cmdCount(req);
  if (cmd == "free") return cmdFree(req);
  if (cmd == "derive") return cmdDerive(req);
  if (cmd == "signals") {
    std::vector<int64_t> ids;
    std::string e;
    if (!idsOk(js::get(req, "signalIds"), ids, e)) return err(e);
    return err("signals (v1) is not supported by this helper: use children");
  }
  if (cmd == "aliasHints") {
    if (js::get(req, "pairs").type() != T::Arr) return err("aliasHints needs pairs");
    return err("aliasHints is not supported by this helper");
  }
  return err("not supported by this helper: " + cmd);
}

// ================================================================ the request queue and cancel
struct Item {
  enum Kind { Req, BadJson, TooLong, Cancel, Eof } kind = Req;
  Value req, id;
  bool numId = false; double nid = 0;
  bool dropped = false;            // cancelled while queued
  // a cancel's outcome, settled when it arrived
  bool noTarget = false, hit = false; int nDropped = 0, nRunning = 0;
  std::string longId;              // TooLong: the reply's id text
};
static std::mutex g_qMu;
static std::condition_variable g_qCv;
static std::deque<std::shared_ptr<Item>> g_q;
static bool g_running = false;
static double g_runId = 0;
static bool g_runNumId = false;

// The id of a too-long line: the last top-level `"id": <1-15 digits>` followed by `,` or `}`.
static std::string longLineId(const std::string &s) {
  std::string found = "-1";
  int depth = 0;
  bool inStr = false;
  for (size_t i = 0; i < s.size(); i++) {
    const char c = s[i];
    if (inStr) { if (c == '\\') i++; else if (c == '"') inStr = false; continue; }
    if (c == '{' || c == '[') { depth++; continue; }
    if (c == '}' || c == ']') { depth--; continue; }
    if (c != '"') continue;
    if (depth == 1 && s.compare(i, 4, "\"id\"") == 0) {
      size_t j = i + 4;
      while (j < s.size() && (s[j] == ' ' || s[j] == '\t' || s[j] == '\r' || s[j] == '\n')) j++;
      if (j < s.size() && s[j] == ':') {
        j++;
        while (j < s.size() && (s[j] == ' ' || s[j] == '\t' || s[j] == '\r' || s[j] == '\n')) j++;
        size_t d0 = j;
        while (j < s.size() && s[j] >= '0' && s[j] <= '9') j++;
        const size_t nd = j - d0;
        size_t k = j;
        while (k < s.size() && (s[k] == ' ' || s[k] == '\t' || s[k] == '\r' || s[k] == '\n')) k++;
        if (nd >= 1 && nd <= 15 && k < s.size() && (s[k] == ',' || s[k] == '}')) {
          std::string d = s.substr(d0, nd);
          js::jnum(found = std::string(), strtod(d.c_str(), nullptr));
        }
      }
    }
    inStr = true;
  }
  return found;
}

// The line's length as a JavaScript string (UTF-16 code units of the UTF-8 decoded line): one per character, two for a
// 4-byte sequence; a stray continuation byte decodes to U+FFFD (one).
static size_t utf16Len(const std::string &s) {
  size_t n = 0;
  for (size_t i = 0; i < s.size(); i++) {
    const uint8_t c = (uint8_t)s[i];
    if (c < 0x80) { n++; continue; }
    size_t len = c >= 0xF0 && c < 0xF8 ? 4 : c >= 0xE0 ? 3 : c >= 0xC2 ? 2 : 1;
    if (len > 1) {
      size_t j = 1;
      while (j < len && i + j < s.size() && ((uint8_t)s[i + j] & 0xC0) == 0x80) j++;
      if (j < len) len = 1; else i += len - 1;
    }
    n += len == 4 ? 2 : 1;
  }
  return n;
}

static void enqueueLine(std::string line) {
  bool blank = true;
  for (char c : line) if (!(c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f')) { blank = false; break; }
  if (blank) return;
  auto it = std::make_shared<Item>();
  if (line.size() > 1048576 && utf16Len(line) > 1048576) {
    it->kind = Item::TooLong;
    it->longId = longLineId(line);
  } else {
    std::string pe;
    Napi::NodeP n = wjson::parse(line, pe);
    if (!n || n->t != T::Obj) it->kind = Item::BadJson;
    else {
      it->req = Value(n);
      it->id = js::get(it->req, "id");
      if (it->id.type() == T::Num) { it->numId = true; it->nid = it->id.p->n; }
      const Value cmd = js::get(it->req, "cmd");
      if (cmd.type() == T::Str && cmd.p->s == "cancel") {
        it->kind = Item::Cancel;
        const Value tv = js::get(it->req, "target");
        it->noTarget = js::undef(tv);
        const Value target = it->noTarget ? it->id : tv;
        std::lock_guard<std::mutex> lk(g_qMu);
        if (target.type() == T::Num) {
          const double m = target.p->n;
          for (auto &q : g_q) if (q->kind == Item::Req && !q->dropped && q->numId && q->nid == m) { q->dropped = true; it->nDropped++; }
          if (g_running && g_runNumId && g_runId == m && !g_cancelRun.load()) { g_cancelRun.store(true); it->nRunning = 1; }
        }
        it->hit = it->nDropped + it->nRunning > 0;
        g_q.push_back(it);
        g_qCv.notify_one();
        return;
      }
    }
  }
  std::lock_guard<std::mutex> lk(g_qMu);
  g_q.push_back(it);
  g_qCv.notify_one();
}

static void readerThread() {
  std::string buf;
  char chunk[1 << 16];
  for (;;) {
    const ssize_t n = ::read(0, chunk, sizeof chunk);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    size_t a = 0;
    for (ssize_t i = 0; i < n; i++) {
      if (chunk[i] != '\n') continue;
      buf.append(chunk + a, (size_t)i - a);
      enqueueLine(std::move(buf));
      buf.clear();
      a = (size_t)i + 1;
    }
    buf.append(chunk + a, (size_t)n - a);
  }
  if (!buf.empty()) enqueueLine(std::move(buf));
  auto e = std::make_shared<Item>();
  e->kind = Item::Eof;
  std::lock_guard<std::mutex> lk(g_qMu);
  g_q.push_back(e);
  g_qCv.notify_one();
}

static void cancelledLine(const Value &id) {
  std::string o = "{";
  idKey(o, id);
  o += "\"cancelled\":true}";
  emitLine(o);
}

// ================================================================ main
static int parseWorkers(const std::string &v) {
  if (v == "auto") {
    double cpus = (double)std::thread::hardware_concurrency();
    if (const char *c = getenv("WISP_HOST_CPUS")) cpus = atof(c);
    double avail = 0;
    if (const char *a = getenv("WISP_HOST_AVAIL_MB")) avail = atof(a);
#if defined(__APPLE__)
    else {  // (macOS: free + inactive + purgeable + speculative pages, the counterpart of MemAvailable)
      vm_statistics64_data_t vs; mach_msg_type_number_t cnt = HOST_VM_INFO64_COUNT;
      if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vs, &cnt) == KERN_SUCCESS)
        avail = (double)((uint64_t)vs.free_count + vs.inactive_count + vs.purgeable_count + vs.speculative_count) * (double)vm_kernel_page_size / 1048576;
    }
#else
    else if (FILE *f = fopen("/proc/meminfo", "r")) {
      char line[256];
      while (fgets(line, sizeof line, f)) if (!strncmp(line, "MemAvailable:", 13)) { avail = atof(line + 13) / 1024; break; }
      fclose(f);
    }
#endif
    return (int)std::max(1.0, std::min(8.0, std::min(std::floor(cpus / 2), std::floor((avail - 4096) / 600))));
  }
  char *end = nullptr;
  const long n = strtol(v.c_str(), &end, 10);
  if (v.empty() || (end && *end)) return 4;
  return (int)std::max(1L, std::min(8L, n));
}

int main(int argc, char **argv) {
  if (fcntl(3, F_GETFD) != -1) g_out = 3;  // (before anything else opens a descriptor)
  signal(SIGPIPE, SIG_IGN);
  bool haveWorkers = false;
  std::string cacheMb;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--wcb") g_set.wcb = true;  // (the default; kept so older launch lines still work)
    else if (a == "--workers" && i + 1 < argc) { g_set.workers = parseWorkers(argv[++i]); haveWorkers = true; }
    else if (a == "--cache-mb" && i + 1 < argc) cacheMb = argv[++i];
    else if (a == "--text-budget-mb" && i + 1 < argc) g_set.textBudget = std::max(1.0, atof(argv[++i])) * 1048576;
  }
  if (!haveWorkers) { const char *w = getenv("WISP_WORKERS"); g_set.workers = w && *w ? parseWorkers(w) : 4; }
  if (const char *b = getenv("WISP_TEXT_BUDGET_MB")) { bool flag = false; for (int i = 1; i < argc; i++) if (!strcmp(argv[i], "--text-budget-mb")) flag = true; if (!flag && *b) g_set.textBudget = std::max(1.0, atof(b)) * 1048576; }
  if (const char *c = getenv("WISP_COLD_RANGE")) { if (*c) { const double v = atof(c); if (v == v) g_set.coldRange = v; } }
  // the one block cache of the process: the library's decoded-block LRU (--cache-mb, else WCB_BLOCK_LRU_MB, else 256 MB)
  if (!cacheMb.empty() && !getenv("WCB_BLOCK_LRU_MB")) setenv("WCB_BLOCK_LRU_MB", cacheMb.c_str(), 1);
  {  // CACHE_BYTES: --cache-mb, else env WISP_CACHE_MB, else 1024e6
    const char *fc = getenv("WISP_CACHE_MB");
    const std::string cm = !cacheMb.empty() ? cacheMb : (fc ? std::string(fc) : std::string());
    char *end = nullptr;
    const double v = cm.empty() ? NAN : strtod(cm.c_str(), &end);
    if (v == v && v > 0 && end && !*end) { g_set.cacheBytes = v * 1e6; g_set.cacheGiven = true; }
  }
  if (const char *m = getenv("WISP_SPLIT_MIN")) if (*m) kSplitMin = atof(m);
  unsigned th = std::thread::hardware_concurrency();
  if (const char *t = getenv("WISP_THREADS")) th = (unsigned)atoi(t);
  g_set.threads = std::max(1u, std::min(8u, th ? th : 1u));
  lib::bind();
  wisp_set_refuse_hook(onRefuse);  // (lazy FSDB open: the withdrawal line)
  Pool pool(g_set.threads);
  g_pool = &pool;
  {
    std::string o = "{\"id\":0,\"ready\":true,\"pid\":";
    js::jnum(o, (double)getpid());
    o += ",\"workers\":"; js::jnum(o, g_set.workers);
    o += '}';
    emitLine(o);
  }
  std::thread rd(readerThread);
  rd.detach();
  for (;;) {
    std::shared_ptr<Item> it;
    // a deferred whole-file check (WISP_VERIFY_START idle:<seconds>): its idle wait, from the last request's end
    double vIdle = -1;
    if (g_f.open) { vIdle = js::num(js::get(lib::call(lib::F.checkNow, {}), "idleMs"), -1); if (!(vIdle >= 0)) vIdle = -1; }
    {
      std::unique_lock<std::mutex> lk(g_qMu);
      // idle release: once per idle spell, after WISP_IDLE_RELEASE_MS without a request, while a file is open
      static const long idleMs = [] { const char *e = getenv("WISP_IDLE_RELEASE_MS"); return e && *e ? atol(e) : 30000L; }();
      if (vIdle >= 0) {  // the earlier of the deferred check's start and the idle release
        using clk = std::chrono::steady_clock;
        const clk::time_point due = g_lastReqEnd + std::chrono::milliseconds((long long)vIdle);
        const clk::time_point rel = g_idleArmed && idleMs > 0 ? g_lastReqEnd + std::chrono::milliseconds(idleMs) : clk::time_point::max();
        const clk::time_point first = std::min(due, rel);
        if (!g_qCv.wait_until(lk, first, [] { return !g_q.empty(); })) {
          lk.unlock();
          if (rel <= due) { g_idleArmed = false; lib::call(lib::F.sourceRelease, {}); g_idleReleases++; }
          else if (js::truthy(lib::call(lib::F.verifyStart, {}))) { holdBoundsForCheck(); g_idleChecks++; }
          continue;
        }
      } else if (g_idleArmed && idleMs > 0 && g_f.open) {
        if (!g_qCv.wait_for(lk, std::chrono::milliseconds(idleMs), [] { return !g_q.empty(); })) {
          g_idleArmed = false;
          lk.unlock();
          lib::call(lib::F.sourceRelease, {});
          g_idleReleases++;
          continue;
        }
      } else {
        g_qCv.wait(lk, [] { return !g_q.empty(); });
      }
      it = g_q.front();
      g_q.pop_front();
      if (it->kind == Item::Req && !it->dropped) { g_running = true; g_runNumId = it->numId; g_runId = it->nid; g_cancelRun.store(false); }
    }
    switch (it->kind) {
      case Item::Eof:
        closeFile();
        fflush(stdout);
        _exit(0);
      case Item::BadJson: emitLine("{\"id\":-1,\"error\":\"bad json\"}"); break;
      case Item::TooLong: emitLine("{\"id\":" + it->longId + ",\"error\":\"request longer than 1048576 bytes\"}"); break;
      case Item::Cancel: {
        std::string o = "{";
        idKey(o, it->id);
        if (it->noTarget) {
          if (it->hit) break;  // (its own reply was the cancelled line)
          o += "\"cancelled\":false}";
        } else if (it->hit) {
          o += "\"result\":{\"cancelled\":true,\"dropped\":"; js::jnum(o, it->nDropped);
          o += ",\"running\":"; js::jnum(o, it->nRunning); o += "}}";
        } else o += "\"result\":{\"cancelled\":false}}";
        emitLine(o);
        break;
      }
      case Item::Req: {
        if (it->dropped) { cancelledLine(it->id); break; }
        const double t0 = nowMs();
        g_idleArmed = true;
        Reply r = dispatch(it->req);
        g_lastReqEnd = std::chrono::steady_clock::now();
        const double ms = nowMs() - t0;
        bool cancelled;
        {
          std::lock_guard<std::mutex> lk(g_qMu);
          cancelled = g_cancelRun.load();
          g_running = false;
          g_cancelRun.store(false);
        }
        // sticky errors of a completed request are remembered (a cancelled one, or one refused whole, remembers nothing)
        if (!cancelled && r.ok && g_f.open) for (auto &p : g_f.pendSticky) g_f.sticky[p.first] = p.second;
        g_f.pendSticky.clear();
        if (cancelled) cancelledLine(it->id);
        else emitReply(it->id, r, ms);
        break;
      }
    }
  }
}
