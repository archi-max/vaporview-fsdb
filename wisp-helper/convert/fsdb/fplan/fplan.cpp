// SPDX-License-Identifier: MIT
// fplan: multithreaded FSRAWPLAN3 planner, same plans as the Python reference planner.
// Every check/limit of the Python planner is kept, in the same evaluation order, so the same input gives the same
// plan bytes, the same refusals and the same rejection reason. Parallel work (CRC, index-block decode, index walks,
// text formatting) only computes per-item results; all order-dependent decisions are replayed sequentially.
#include "plan_cap.h"
#include "fplan.h"
#include "fsdb_codecs.h"
#include "force_log.h"
#include "port_links.h"
#include "scope_intern.h"

#include <algorithm>
#include <array>
#include <deque>
#include <map>
#include <memory>
#include <set>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <sys/mman.h>
#include <cstring>
#include <exception>
#include <functional>
#include <future>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#ifdef __linux__
#include <sched.h>
#endif
// CPUs this process may run on (taskset / container cpuset), not every online CPU.
static unsigned usableCpus() {
#ifdef __linux__
  cpu_set_t cs; CPU_ZERO(&cs); if (sched_getaffinity(0, sizeof cs, &cs) == 0 && CPU_COUNT(&cs) > 0) return unsigned(CPU_COUNT(&cs));
#endif
  return std::max(1u, std::thread::hardware_concurrency());
}

// Test-only red mutants (FPLAN_TEST_*): read only in the test build (FPLAN_TEST_HOOKS, build.mk fsdb/test/); the shipped
// planner is built without it, so these names are not in its binary and setting them has no effect.
#ifdef FPLAN_TEST_HOOKS
#define FPLAN_TEST_ENV(n) getenv(n)
#else
#define FPLAN_TEST_ENV(n) ((const char*)nullptr)
#endif
namespace fplan {
std::vector<CarrierRow>* carrier_rows = nullptr;
namespace {
// test builds: FPLAN_TEST_FC=<arm> plants one full-chip tree damage (reds in tests/test_fullchip_tree.sh); nullptr in release
bool fc_arm(const char* a) { const char* e = FPLAN_TEST_ENV("FPLAN_TEST_FC"); return e && !strcmp(e, a); }

using fsdbraw::Bytes;
using fsdbraw::DecodeError;
struct ParseError : std::runtime_error { using std::runtime_error::runtime_error; };
struct OtherError : std::runtime_error { using std::runtime_error::runtime_error; };  // other ValueError/KeyError

constexpr size_t MB2 = size_t(2) << 20;
// planner limits
// Declaration-side count limit (scopes, declarations, aliases, native IDs, plan rows): sized for designs of
// tens of millions of signals; memory, not this bound, is the practical limit.
constexpr uint64_t DECL_LIMIT = 64000000;
constexpr uint64_t MAX_COUNT = DECL_LIMIT, MAX_TOTAL_DELTAS = (uint64_t(256) << 20) / 8, DICT_MAX_BYTES = uint64_t(256) << 20;
constexpr uint64_t MAX_SCOPES = 512, MAX_NAME_BYTES = 1048576;
// plan text cap: plan_cap.h (default max(1 GiB, input size / 2); FPLAN_MAX_PLAN_BYTES replaces it)
constexpr uint64_t MAX_RECORDS = 64000000, MAX_BLOCKS = 16000000, MAX_WINDOWS = 64000000;
const char* STRING_SKIP = "string var not carried";
const char* REAL_SKIP = "real var not carried";
// FSDB stores only a prefix of these streams; the reader computes the values after the derived-after time. Storing the
// prefix alone would show its last value as the whole rest of the history, so the var is declared without values.
const char* DERIVED_SKIP = "reader-computed after the stored prefix (not carried)";
const char* EVENT_SKIP = "event var not carried";
// Class objects (field tag 0x19 dumps) are created during the run: an instance is named by its creation number
// (<class>@<n>), and the member rows of every instance of a class carry the same full name, so no full name has one
// history. Each is declared by name and refused with the reason for its kind (counted together in the summary).
const char* CLASS_INST = "class object instance (created during the run, named <class>@<n>): not carried";
const char* CLASS_MEMBER = "class object member (the same name for every instance of the class, no single history): not carried";
const char* CLASS_HANDLE = "class handle (refers to objects created during the run): not carried";
const char* CLASS_SKIP = "class object variable (a run-time object or under a class-object root): not carried";
inline bool class_reason(const char* r) { return r == CLASS_SKIP || r == CLASS_INST || r == CLASS_MEMBER || r == CLASS_HANDLE; }
inline bool class_reason(const std::string& r) { return r == CLASS_SKIP || r == CLASS_INST || r == CLASS_MEMBER || r == CLASS_HANDLE; }
const int64_t CLASS_FID = -3;  // field_id of class-object records (handles, instances, member rows)
// Late start: a stream whose first stored record starts after the dump start holds only its own (e.g. forced) segment; the
// earlier values come from a port link this planner does not decode, so the var is declared without values.
const char* LATE_SKIP = "stored history starts after the dump start (earlier values via an undecoded port link)";
const char* NOINDEX = "extended ID has no qualified value index";
const char* FLAGS_SKIP = "native-ID summary flags not decoded yet (class-object dumps)";
const char* PKG_SKIP = "package scope: value IDs not linked yet";
const char* DTYPE_SKIP = "var with an extended datatype not carried";  // + " (<why>)": the datatype kind or the block damage
const char* ENUM_NOTE = "enum labels not carried";
const char* ASSERT_SKIP = "assertion not carried (no value kind for assertions)";
// a name the plan cannot spell (the token check) is refused by name; the names that share its values are refused with it
static const char* const NAME_PREFIX = "plan: ambiguous/unsupported ";
const char* NAME_SHARED = "values shared with a refused name (unsupported name spelling)";
const char* D8_MULTI = "field-typed variable of an unpacked array or struct type (one value ID for several rows): not carried";
const char* BIG_PREFIX = "unpacked array or struct over the per-item row bound";
std::string big_reason(uint64_t n) { return std::string(BIG_PREFIX) + " (" + std::to_string(n) + " elements): not carried"; }

std::string hx(uint64_t v) { char b[32]; snprintf(b, sizeof b, "0x%llx", (unsigned long long)v); return b; }
// Whole-file refusal for a dump that was switched off during the run (off and on again, or off to the end).
static const char* const DUMP_OFF_REASON = "dump-off interval: not supported in WCZ v1 (the dump was switched off during the run)";
std::string hexbytes(const uint8_t* p, size_t n) {
  static const char* d = "0123456789abcdef"; std::string s(2 * n, '0');
  for (size_t i = 0; i < n; i++) { s[2 * i] = d[p[i] >> 4]; s[2 * i + 1] = d[p[i] & 15]; }
  return s;
}
inline uint64_t le(const uint8_t* p, unsigned k) {
  switch (k) {
    case 0: return 0;
    case 1: return p[0];
    case 2: { uint16_t x; memcpy(&x, p, 2); return x; }
    case 4: { uint32_t x; memcpy(&x, p, 4); return x; }
    case 8: { uint64_t x; memcpy(&x, p, 8); return x; }
    default: { uint64_t v = 0; for (unsigned i = 0; i < k && i < 8; i++) v |= uint64_t(p[i]) << (8 * i); return v; }
  }
}
inline void put(std::string& s, uint64_t v) { char b[24]; auto r = std::to_chars(b, b + 24, v); s.append(b, r.ptr); }
inline void puti(std::string& s, int64_t v) { char b[24]; auto r = std::to_chars(b, b + 24, v); s.append(b, r.ptr); }
std::string u2s(uint64_t v) { std::string s; put(s, v); return s; }
std::string i2s(int64_t v) { std::string s; puti(s, v); return s; }

// ---------------------------------------------------------------- parallel helpers
template <class F> void pfor(size_t n, int T, size_t grain, F&& f) {  // f(i, tid); f must not throw
  if (!n) return;
  if (grain < 1) grain = 1;
  size_t chunks = (n + grain - 1) / grain;
  int nt = int(std::min<size_t>(size_t(std::max(T, 1)), chunks));
  if (nt <= 1) { for (size_t i = 0; i < n; i++) f(i, 0); return; }
  std::atomic<size_t> next{0};
  auto work = [&](int tid) {
    for (;;) {
      size_t b = next.fetch_add(grain);
      if (b >= n) break;
      size_t e = std::min(n, b + grain);
      for (size_t i = b; i < e; i++) f(i, tid);
    }
  };
  std::vector<std::thread> th;
  for (int t = 1; t < nt; t++) th.emplace_back(work, t);
  work(0);
  for (auto& x : th) x.join();
}

// Captured exception (ParseError / DecodeError / other), rethrown with its original kind.
struct Err {
  int kind = 0;  // 0 none, 1 ParseError, 2 DecodeError, 3 other
  std::string msg;
  explicit operator bool() const { return kind != 0; }
  [[noreturn]] void raise() const {
    if (kind == 1) throw ParseError(msg);
    if (kind == 2) throw DecodeError(msg);
    throw OtherError(msg);
  }
};
template <class F> Err capture(F&& f) {
  Err e;
  try { f(); }
  catch (const ParseError& x) { e.kind = 1; e.msg = x.what(); }
  catch (const DecodeError& x) { e.kind = 2; e.msg = x.what(); }
  catch (const std::exception& x) { e.kind = 3; e.msg = x.what(); }
  return e;
}

// ---------------------------------------------------------------- raw container
struct Raw {
  const uint8_t* b; uint64_t n;
  void need(uint64_t o, uint64_t k) const { if (o > n || k > n - o) throw ParseError("out of bounds " + hx(o) + "+" + hx(k)); }
  uint64_t u(uint64_t o, unsigned k) const { need(o, k); return le(b + o, k); }
};
struct Header { uint64_t section = 1024, bsh = 0, min_ticks = 0, max_ticks = 0, max_id_low = 0; std::string scale; };
Header read_header(const Raw& r) {
  Header h; uint64_t m = r.u(4, 4);
  if (m != 0x48d93dfcu && m != 0x48d93e1cu) throw ParseError("unrecognized FSDB magic");
  if (r.u(8, 4) != 0x01020304u) throw ParseError("only little endian subset implemented");
  uint64_t s = r.u(0x3c, 1) * 256;
  if (s != 1024) throw ParseError("only 1024-byte-header variant implemented");
  r.need(0, 4 * s);
  h.section = s; h.bsh = r.u(0x2c, 4);
  const char* sp = (const char*)r.b + 0x4c; h.scale.assign(sp, strnlen(sp, 20));
  h.min_ticks = (r.u(2 * s, 4) << 32) | r.u(2 * s + 4, 4);
  h.max_ticks = (r.u(2 * s + 8, 4) << 32) | r.u(2 * s + 12, 4);
  h.max_id_low = r.u(2 * s + 0xa4, 4);
  return h;
}
int scale_exponent(const std::string& s) {
  static const std::pair<const char*, int> units[] = {{"s", 0}, {"ms", -3}, {"us", -6}, {"ns", -9}, {"ps", -12}, {"fs", -15}};
  for (const char* m : {"100", "10", "1"}) {
    size_t L = strlen(m);
    if (s.compare(0, L, m) != 0) continue;
    std::string rest = s.substr(L);
    for (auto& u : units) if (rest == u.first) return u.second + int(L) - 1;
  }
  throw ParseError("plan: unsupported timescale");
}

// Strict UTF-8 (Python bytes.decode('utf8')).
void check_utf8(const uint8_t* p, size_t n) {
  size_t i = 0;
  while (i < n) {
    uint8_t c = p[i];
    if (c < 0x80) { i++; continue; }
    size_t k; uint32_t cp, mn;
    if (c >= 0xc2 && c <= 0xdf) { k = 1; cp = c & 0x1f; mn = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { k = 2; cp = c & 0x0f; mn = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { k = 3; cp = c & 0x07; mn = 0x10000; }
    else throw OtherError("'utf-8' codec can't decode byte " + hx(c) + " in position " + u2s(i) + ": invalid start byte");
    for (size_t j = 1; j <= k; j++) {
      if (i + j >= n || (p[i + j] & 0xc0) != 0x80) throw OtherError("'utf-8' codec can't decode byte " + hx(c) + " in position " + u2s(i) + ": invalid continuation byte");
      cp = (cp << 6) | (p[i + j] & 0x3f);
    }
    if (cp < mn || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw OtherError("'utf-8' codec can't decode byte " + hx(c) + " in position " + u2s(i) + ": invalid continuation byte");
    i += k + 1;
  }
}

struct Cursor {
  const uint8_t* b; size_t n; size_t i = 0;
  explicit Cursor(const Bytes& v) : b(v.data()), n(v.size()) {}
  uint64_t u(uint64_t k) {
    if (k > n - i) throw ParseError("truncated declaration");
    uint64_t v = le(b + i, unsigned(std::min<uint64_t>(k, 8))); i += k; return v;
  }
  void expect(const uint8_t* e, size_t k) {
    if (n - i < k || memcmp(b + i, e, k)) throw ParseError("unsupported declaration at " + hx(i) + ": expected " + hexbytes(e, k));
    i += k;
  }
  std::string text() {
    const void* z = memchr(b + i, 0, n - i);
    if (!z) throw ParseError("unterminated name");
    size_t e = size_t((const uint8_t*)z - b);
    check_utf8(b + i, e - i);
    std::string s((const char*)b + i, e - i); i = e + 1; return s;
  }
  size_t skip_text() {  // text() without the copy: same checks, returns the length
    const void* z = memchr(b + i, 0, n - i);
    if (!z) throw ParseError("unterminated name");
    size_t e = size_t((const uint8_t*)z - b);
    check_utf8(b + i, e - i);
    size_t L = e - i; i = e + 1; return L;
  }
  bool text_empty() { return skip_text() == 0; }
  void end() { if (i != n) throw ParseError("unconsumed declaration bytes"); }
};

Bytes dec(const uint8_t* p, uint64_t n, std::initializer_list<unsigned> m, size_t lim = MB2) {
  return fsdbraw::decode_stages(p, size_t(n), std::vector<unsigned>(m), true, lim);
}

// Extended datatype blocks (the third block group of a tree directory), joined per directory. Entries are back to back.
// Decoded kind: 0x08, an enum (seen in two designs, one entry each):
//   u8 0x08, a 2-byte type number (the two bytes a var record names after its ID, read the same way), a NUL-terminated
//   type name, u32 left, u32 right, u16 member count (>= 1), u32 width (= |left - right| + 1), u8 0x02, the member names
//   (count NUL-terminated strings), then count x width bytes: each member's value, one byte per bit, msb first, 0 or 1.
// Only a block holding exactly one such entry, every byte accounted for, is decoded. Anything else (another kind byte,
// a damaged or truncated entry, trailing bytes, several entries: none seen yet) leaves the whole block undecoded with
// the reason, and every var naming a type in it is refused by name with that reason. Member names and values are
// checked but not carried (ENUM_NOTE).
struct DtType { std::string why; uint64_t bits = 0; };  // why empty: a decoded enum
struct DtTable { std::map<uint64_t, DtType> types; std::string rest; };  // rest: why a type number not in types is refused
DtTable decode_datatypes(Bytes raw) {
  DtTable t; std::string where;
  if (const char* dm = FPLAN_TEST_ENV("FPLAN_TEST_DT_DAMAGE")) {  // test-only planted damage (reds)
    const std::string m = dm; const size_t nm = raw.size();
    auto at = [&](size_t i) -> uint8_t& { static uint8_t z = 0; return i < raw.size() ? raw[i] : z; };
    const void* e0 = raw.empty() ? nullptr : memchr(raw.data() + 3, 0, raw.size() > 3 ? raw.size() - 3 : 0);
    const size_t fx = e0 ? size_t((const uint8_t*)e0 - raw.data()) + 1 : 0;  // first byte after the type name
    if (m == "trunc" && nm > 4) raw.resize(nm - 4);
    else if (m == "trunc-head" && nm > 2) raw.resize(2);
    else if (m == "kind") at(0) = 0x09;
    else if (m == "number") at(1) ^= 1;
    else if (m == "count0") { at(fx + 8) = 0; at(fx + 9) = 0; }
    else if (m == "count+1") at(fx + 8) += 1;
    else if (m == "width") at(fx + 10) += 1;
    else if (m == "bounds") at(fx) += 1;
    else if (m == "attr") at(fx + 14) = 0x03;
    else if (m == "value2") at(nm - 1) = 2;
    else if (m == "extra") raw.push_back(0x08);
    else if (m == "twice") { Bytes y = raw; if (y.size() > 1) y[1] ^= 1; raw.insert(raw.end(), y.begin(), y.end()); }  // two well-formed entries
    else if (m == "noname") raw.resize(fx > 1 ? fx - 1 : 0);
  }
  const bool dup_mut = FPLAN_TEST_ENV("FPLAN_TEST_DT_DAMAGE") && std::string(FPLAN_TEST_ENV("FPLAN_TEST_DT_DAMAGE")) == "dupvalue";
  Cursor c(raw);
  while (c.i < c.n) {
    const size_t pos = c.i; const uint8_t kind = raw[pos];
    if (kind != 0x08) { t.rest = "datatype kind " + hx(kind) + " not decoded"; t.types.clear(); return t; }
    try {
      c.u(1); const uint64_t num = c.u(2); c.text();
      const int64_t left = int64_t(c.u(4)), right = int64_t(c.u(4));
      const uint64_t count = c.u(2), bits = c.u(4), attr = c.u(1);
      if (count == 0) throw ParseError("enum with no members");
      if (bits == 0 || bits != uint64_t((left > right ? left - right : right - left) + 1)) throw ParseError("enum width does not match its bounds");
      if (attr != 2) throw ParseError("enum attribute byte " + hx(attr) + " not decoded");
      if (count * bits > c.n) throw ParseError("truncated declaration");
      for (uint64_t k = 0; k < count; k++) if (c.text().empty()) throw ParseError("enum member without a name");
      std::set<std::vector<uint8_t>> vals;
      for (uint64_t k = 0; k < count; k++) {
        if (bits > c.n - c.i) throw ParseError("truncated declaration");
        std::vector<uint8_t> v(raw.begin() + long(c.i), raw.begin() + long(c.i + bits)); c.i += bits;
        if (dup_mut && k + 1 == count && !vals.empty()) v = *vals.begin();  // test-only: the last member takes the first one's value
        for (uint8_t x : v) if (x > 1) throw ParseError("enum member value byte " + hx(x) + " not decoded");
        if (!vals.insert(v).second) throw ParseError("two enum members with one value");
      }
      if (t.types.count(num)) throw ParseError("type number repeated");
      t.types[num] = DtType{"", bits};
    } catch (const ParseError& e) {
      t.rest = std::string("datatype block damaged at ") + hx(pos) + ": " + e.what(); t.types.clear(); return t;
    }
  }
  if (t.types.size() > 1) { t.rest = "datatype block with " + u2s(t.types.size()) + " entries (only single-entry blocks are decoded)"; t.types.clear(); }
  return t;
}

struct Blk { uint64_t off, size; };
struct TreeDir { std::vector<Blk> g[3]; };  // scope, var, datatype
TreeDir tree_directory(const Raw& r, uint64_t h) {
  uint64_t o = r.u(h, 8);
  if (r.u(o, 1) != 0xf0) throw ParseError("no tree directory at the directory pointer (byte " + hx(r.u(o, 1)) + ", the directory marker is 0xf0): the file holds no signal tree this converter can read");
  unsigned n = r.u(0x100, 1) == 1 ? 8 : 4;
  r.u(o + 1, n); o += 1 + n;
  TreeDir t;
  for (int k = 0; k < 3; k++) {
    uint64_t count = r.u(o, 4); o += 4;
    if (count > 1000000) throw ParseError("unreasonable directory count");
    for (uint64_t i = 0; i < count; i++) {
      uint64_t off = r.u(o, 8), size = r.u(o + 8, 4); o += 12;
      r.need(off, size); t.g[k].push_back({off, size});
    }
  }
  return t;
}
// the tree directory at S+0x000 is the first of a sequence of f0 directories written back to back (UVM benches with
// packages / +fsdbfile: tb, one directory per package, class-object increments). Each is f0, a word (the count of new
// low value IDs the directory introduces), then the three block groups. The sequence ends at the first byte that is not f0.
struct TreeDirSeq { uint64_t new_ids; TreeDir g; };
Bytes join_decode(const Raw& r, const std::vector<Blk>& g);
static void test_dt_table(const Raw& r, const TreeDir& t, size_t k) {  // test-only: each directory's group counts, datatype bytes and decoded table
  const char* dd = FPLAN_TEST_ENV("FPLAN_TEST_DTTABLE"); if (!dd) return;
  FILE* f = fopen((std::string(dd) + ".idx").c_str(), "a"); if (!f) return;
  fprintf(f, "dir %zu groups %zu %zu %zu\n", k, t.g[0].size(), t.g[1].size(), t.g[2].size()); fclose(f);
  if (t.g[2].empty()) return;
  try { Bytes y = join_decode(r, t.g[2]); FILE* f2 = fopen((std::string(dd) + ".dt." + std::to_string(k)).c_str(), "wb"); if (f2) { fwrite(y.data(), 1, y.size(), f2); fclose(f2); }
    DtTable dt = decode_datatypes(y); FILE* f4 = fopen((std::string(dd) + ".idx").c_str(), "a");
    if (f4) { for (auto& kv : dt.types) fprintf(f4, "dir %zu type %llu bits %llu %s\n", k, (unsigned long long)kv.first, (unsigned long long)kv.second.bits, kv.second.why.empty() ? "enum" : kv.second.why.c_str());
      fprintf(f4, "dir %zu rest %s\n", k, dt.rest.empty() ? "-" : dt.rest.c_str()); fclose(f4); } }
  catch (...) { FILE* f3 = fopen((std::string(dd) + ".idx").c_str(), "a"); if (f3) { fprintf(f3, "dir %zu dt decode failed\n", k); fclose(f3); } }
}
std::vector<TreeDirSeq> tree_dir_seq(const Raw& r, uint64_t h) {
  std::vector<TreeDirSeq> out; uint64_t o = r.u(h, 8);
  if (r.u(o, 1) != 0xf0) throw ParseError("no tree directory at the directory pointer (byte " + hx(r.u(o, 1)) + ", the directory marker is 0xf0): the file holds no signal tree this converter can read");
  unsigned n = r.u(0x100, 1) == 1 ? 8 : 4;
  while (o < r.n && r.b[o] == 0xf0) {
    if (out.size() >= 100000) throw ParseError("tree-directory sequence limit");
    TreeDirSeq c; c.new_ids = r.u(o + 1, n); o += 1 + n;
    for (int k = 0; k < 3; k++) {
      uint64_t count = r.u(o, 4); o += 4;
      if (count > 1000000) throw ParseError("unreasonable directory count");
      for (uint64_t i = 0; i < count; i++) {
        uint64_t off = r.u(o, 8), size = r.u(o + 8, 4); o += 12;
        r.need(off, size); c.g.g[k].push_back({off, size});
      }
    }
    test_dt_table(r, c.g, out.size());
    out.push_back(std::move(c));
  }
  if (FPLAN_TEST_ENV("FPLAN_TEST_DTTABLE_STOP")) throw ParseError("test stop after the tree directories");
  return out;
}
int walk_threads();
Bytes join_decode(const Raw& r, const std::vector<Blk>& g) {
  Bytes out;
  if (g.size() < 16) { for (auto& x : g) { Bytes d = dec(r.b + x.off, x.size, {1, 1}); out.insert(out.end(), d.begin(), d.end()); } return out; }
  // many blocks: each decodes on its own (walk_threads()), joined in order; the first failing block in order is raised
  std::vector<Bytes> part(g.size()); std::vector<Err> err(g.size());
  pfor(g.size(), walk_threads(), 4, [&](size_t i, int) { err[i] = capture([&] { part[i] = dec(r.b + g[i].off, g[i].size, {1, 1}); }); });
  size_t n = 0; for (size_t i = 0; i < g.size(); i++) { if (err[i]) err[i].raise(); n += part[i].size(); }
  out.reserve(n); for (auto& d : part) { out.insert(out.end(), d.begin(), d.end()); Bytes().swap(d); }
  return out;
}

// ---------------------------------------------------------------- field types
struct Field {
  int64_t bits = 0, left = 0, right = 0; uint64_t base = 0;
  bool string = false, unpacked = false; int tag = -1; int nonbit = 0;  // nonbit: 1 real, 2 event (one row, no bit width)
  std::vector<std::pair<int64_t, int64_t>> dims;
  std::vector<std::string> members;  // class types (tag 0x19): member names, for naming refused class-object rows; unpacked struct (0x12): member names
  std::vector<uint64_t> mfids;       // unpacked struct (tag 0x12): member field IDs, in declaration order
};
using FieldMap = std::unordered_map<uint64_t, Field>;
struct FieldRow { uint64_t fid; uint8_t f0, f1; std::string name; };
struct FieldDef { std::string definition; uint64_t kind; std::vector<std::string> children; std::vector<FieldRow> rows; };
using DefMap = std::unordered_map<uint64_t, FieldDef>;

inline int64_t sat_mul(int64_t a, int64_t b) {  // Python ints are unbounded; widths this large are rejected later anyway
  const int64_t cap = int64_t(1) << 62; __int128 x = (__int128)a * b;
  return x > cap ? cap : x < -cap ? -cap : int64_t(x);
}
int64_t sbound(Cursor& c, unsigned code) {
  static const unsigned W[4] = {0, 1, 2, 4};
  unsigned n = W[code]; if (!n) return 0;
  uint64_t x = c.u(n);
  return (n == 4 && (x & (1u << 31))) ? int64_t(x) - (int64_t(1) << 32) : int64_t(x);
}
size_t field_definitions(const Bytes& raw, size_t offset, DefMap& out, std::vector<uint64_t>& order) {
  Cursor c(raw); c.i = offset;
  auto sized = [&](unsigned code) -> uint64_t { if (code == 3) throw ParseError("reserved field-def width"); static const unsigned W[3] = {1, 2, 4}; return c.u(W[code]); };
  while (c.i < raw.size() && raw[c.i] == 0x15) {
    c.u(1); uint64_t kind = c.u(1); uint64_t m = c.u(1);
    if (kind == 2 && FPLAN_TEST_ENV("FPLAN_TEST_DEFKIND2_UNKNOWN")) kind = 9;  // TEST-ONLY mutant: a program definition read as an unknown kind
    if (m & 0x83) throw ParseError("extended field definition attributes");
    uint64_t fid = c.u(m & 64 ? 4 : 2);
    uint64_t n = sized((m >> 4) & 3), nc = sized((m >> 2) & 3);
    FieldDef d; d.kind = kind; d.definition = c.text();
    for (uint64_t i = 0; i < nc; i++) d.children.push_back(c.text());
    uint64_t group = 0;
    for (uint64_t i = 0; i < n; i++) {
      if (i % 4 == 0) group = c.u(1);
      unsigned mode = unsigned(group >> (6 - 2 * (i % 4))) & 3;
      FieldRow row; row.fid = sized(mode); row.f0 = uint8_t(c.u(1)); row.f1 = uint8_t(c.u(1));
      d.rows.push_back(std::move(row));
    }
    for (auto& row : d.rows) row.name = c.text();
    if (out.count(fid)) throw ParseError("duplicate field definition");
    out.emplace(fid, std::move(d)); order.push_back(fid);
  }
  return c.i;
}
void parse_fields(const Bytes& raw, FieldMap& fields, DefMap& fdefs) {
  static const std::pair<int, int> builtins[] = {{0, 1}, {1, 1}, {2, 1}, {3, 1}, {4, 1}, {5, 1}, {6, 64}, {7, 64}, {8, 32}, {9, 32},
                                                 {10, 32}, {11, 32}, {12, 16}, {13, 16}, {14, 8}, {15, 8}, {18, 64}};
  for (auto& b : builtins) { Field f; f.bits = b.second; f.left = b.second - 1; f.right = 0; f.base = b.first; fields[b.first] = f; }
  { Field f; f.base = 19; f.string = true; fields[19] = f; }
  // builtin 16 = real, 20 = event (SystemVerilog interface members in UVM benches): declared, values not carried yet
  { Field f; f.base = 16; f.nonbit = 1; fields[16] = f; }
  { Field f; f.base = 20; f.nonbit = 2; fields[20] = f; }
  if (raw.empty()) return;
  Cursor c(raw); bool ended = false;
  auto sized = [&](unsigned code) -> uint64_t { if (code > 2) throw ParseError("unsupported field size code"); static const unsigned W[3] = {1, 2, 4}; return c.u(W[code]); };
  auto resolved = [&](uint64_t fid) -> const Field& { auto it = fields.find(fid); if (it == fields.end()) throw ParseError("unknown base field " + u2s(fid)); return it->second; };
  while (c.i < c.n) {
    size_t start = c.i; uint64_t tag = c.u(1);
    if (tag == 0x80) { if (c.i < c.n) continue; ended = true; break; }  // 0x80 ends one field section; package benches carry several
    if (tag == 0x15) {
      DefMap d; std::vector<uint64_t> order; size_t end = field_definitions(raw, start, d, order);
      for (auto& kv : d) if (fdefs.count(kv.first)) throw ParseError("duplicate field definition");
      for (auto& kv : d) fdefs.emplace(kv.first, std::move(kv.second));
      c.i = end; continue;
    }
    if (!(tag == 0x0f || tag == 0x10 || tag == 1 || tag == 0x11 || tag == 0x12 || tag == 0x13 || tag == 0x19 || tag == 0 || tag == 2)) throw ParseError("unsupported field tag " + hx(tag) + " at " + hx(start));
    uint64_t mask = c.u(1);
    if (mask & 0x80) throw ParseError("extended field metadata unsupported");
    uint64_t fid = c.u(mask & 0x40 ? 4 : 2);
    if (fields.count(fid)) throw ParseError("duplicate field id");
    if (tag == 0x19) {
      // Class type (class-object dumps): the struct record grammar (member count, a size word, member field IDs in groups
      // of 8, member names), but members may name class handles or records that follow, so nothing is resolved. Every variable
      // of a class type is a per-name refusal (CLASS_SKIP); the rest of the file converts.
      uint64_t n = sized((mask >> 4) & 3); sized(mask & 3); uint64_t gm = 0;
      for (uint64_t i = 0; i < n; i++) { if (i % 8 == 0) gm = c.u(1); c.u((gm & (1u << (i % 8))) ? 4 : 1); }
      Field f; f.bits = 0; f.nonbit = 3; f.tag = 0x19;
      for (uint64_t i = 0; i < n; i++) f.members.push_back(c.text());
      fields[fid] = f;
      continue;
    }
    if (tag == 0) {
      // Named class property (follows the class records in class-object dumps): base field ID + name, nothing else. Not
      // resolved; variables of it are refused with the class reason. Mask bits 0-3 are property flags with no extra bytes.
      sized((mask >> 4) & 3); c.text();
      Field f; f.bits = 0; f.nonbit = 3; f.tag = 0; fields[fid] = f;
      continue;
    }
    if (tag == 0x11 || tag == 0x12 || tag == 0x13) {
      // 0x11 packed struct, 0x13 packed union: one flat vector. 0x12 unpacked struct: the same grammar (member count, total
      // bits, member field IDs in groups of 8, member names); every member is a row of its own ("<var>.<member>", the
      // member's type), so a variable of it expands into one row per member, in declaration order.
      uint64_t n = sized((mask >> 4) & 3), flat = sized(mask & 3);
      if (tag == 0x12 && FPLAN_TEST_ENV("FPLAN_TEST_USTRUCT_FLAT")) flat++;  // TEST-ONLY mutant: a damaged unpacked-struct width word
      std::vector<uint64_t> members; uint64_t gm = 0;
      for (uint64_t i = 0; i < n; i++) { if (i % 8 == 0) gm = c.u(1); members.push_back(c.u((gm & (1u << (i % 8))) ? 4 : 1)); }
      std::vector<std::string> mnames;
      for (uint64_t i = 0; i < n; i++) mnames.push_back(c.text());
      int64_t expected = 0;
      for (auto x : members) { const Field& m = resolved(x); if (tag == 0x12 && (m.string || m.nonbit || m.bits <= 0)) throw ParseError("unpacked struct member of a non-bit type: field " + u2s(fid)); int64_t w = m.bits; expected = tag == 0x13 ? std::max(expected, w) : expected + w; }
      if (int64_t(flat) != expected) throw ParseError(std::string(tag == 0x11 ? "struct" : tag == 0x12 ? "unpacked struct" : "union") + " width mismatch: field " + u2s(fid) + " declares " + u2s(flat) + " bits, members sum to " + i2s(expected));
      if (tag == 0x12) {
        if (n == 0) throw ParseError("unpacked struct without members: field " + u2s(fid));
        std::unordered_set<std::string> seen;
        for (auto& nm : mnames) if (nm.empty() || !seen.insert(nm).second) throw ParseError("unpacked struct member name empty or repeated: field " + u2s(fid));
      }
      Field f; f.bits = int64_t(flat); f.left = int64_t(flat) - 1; f.right = 0; f.tag = int(tag);
      if (tag == 0x12) { f.members = std::move(mnames); f.mfids = std::move(members); }
      fields[fid] = f;
    } else {
      uint64_t base = sized((mask >> 4) & 3); Field bf = resolved(base);
      uint64_t n = sized((mask >> 2) & 3);
      if (tag == 1) {
        for (uint64_t i = 0; i < n; i++) c.text();
        uint64_t skip = (bf.bits > 0 && n > 0 && uint64_t(bf.bits) > ~uint64_t(0) / n) ? ~uint64_t(0) : n * uint64_t(std::max<int64_t>(bf.bits, 0));
        c.u(skip);
        Field f = bf; f.base = base; f.tag = 1; fields[fid] = f;
      } else {
        Field f; int64_t bits = bf.bits;
        for (uint64_t i = 0; i < n; i++) {
          uint64_t m = c.u(1);
          if (m & 15) throw ParseError("extended dimension flags unsupported");
          int64_t l = sbound(c, (m >> 6) & 3), rr = sbound(c, (m >> 4) & 3);
          f.dims.push_back({l, rr}); bits = sat_mul(bits, (l > rr ? l - rr : rr - l) + 1);
        }
        if (n == 1 && bf.bits == 1) { f.left = f.dims[0].first; f.right = f.dims[0].second; } else { f.left = bits - 1; f.right = 0; }
        f.bits = bits; f.base = base; f.unpacked = tag == 0x10; f.tag = int(tag);
        if (tag == 2) { f.bits = 0; f.nonbit = 3; }  // class-property vector type (0x0f grammar): refused with the class reason
        fields[fid] = f;
      }
    }
  }
  if (!ended) throw ParseError("missing field stream terminator");
}
Bytes read_field_stream(const Raw& r) {
  uint64_t o = r.u(0x4a0, 8);
  if (!o) return {};
  uint64_t total = r.u(o, 4); o += 4; uint64_t start = o; Bytes out;
  for (;;) {
    uint64_t n = r.u(o, 4); o += 4;
    if (!n) break;
    r.need(o, n); Bytes d = dec(r.b + o, n, {1, 1}); out.insert(out.end(), d.begin(), d.end()); o += n;
    if (o - start > total + 4) throw ParseError("field temp stream overrun");
  }
  return out;
}

// extended field rows, evaluated lazily: count + row at index.
struct FRow { std::string name; int64_t fid, bits, left, right; };
// Per-item bound on the rows one field-def row (or one extended variable) expands to. Counting alone uses COUNT_ONLY (no
// allocation, overflow-safe), so an item over the bound is refused by name with its element count and the file goes on.
constexpr uint64_t FROW_BOUND = 1000000, FROW_COUNT_ONLY = uint64_t(1) << 40;
uint64_t frow_bound() {
  const char* b = FPLAN_TEST_ENV("FPLAN_TEST_FROW_BOUND");  // TEST-ONLY: a lower bound, so the at-bound / one-over reds fit a small fixture
  return b && *b ? std::strtoull(b, nullptr, 10) : FROW_BOUND;
}
// an item expanding to n rows is over the bound when n > bound (TEST-ONLY mutant FPLAN_TEST_FROW_OFF1: n >= bound)
bool frow_over(uint64_t n, uint64_t bound) { return FPLAN_TEST_ENV("FPLAN_TEST_FROW_OFF1") ? n >= bound : n > bound; }
uint64_t frow_count(const FieldMap& F, uint64_t fid, uint8_t f0, uint8_t f1, int depth, uint64_t lim = FROW_BOUND) {
  if (depth > 16) throw ParseError("recursive field in extended variable");
  if (!(f0 <= 3 && f1 <= 2)) throw ParseError("unqualified extended field flags");
  if (fid == 19) return 1;
  auto it = F.find(fid);
  if (it == F.end()) throw ParseError("unknown field in extended variable");
  const Field& x = it->second;
  if (x.tag == 0x12) {  // unpacked struct: one row per member (members may themselves expand)
    uint64_t total = 0;
    for (auto m : x.mfids) { total += frow_count(F, m, f0, f1, depth + 1, lim); if (total > lim) throw ParseError("expanded field-def row limit"); }
    return total;
  }
  if (x.unpacked || x.tag == 0x10) {
    if (x.dims.size() != 1) throw ParseError("only one-dimensional unpacked field qualified");
    uint64_t inner = frow_count(F, x.base, f0, f1, depth + 1, lim);
    int64_t l = x.dims[0].first, r = x.dims[0].second;
    uint64_t ne = uint64_t(l > r ? l - r : r - l) + 1;
    if (inner && ne > lim / inner) throw ParseError("expanded field-def row limit");
    return ne * inner;
  }
  return 1;
}
FRow frow_at(const FieldMap& F, std::string name, uint64_t fid, uint8_t f0, uint8_t f1, int depth, uint64_t idx) {
  if (fid == 19) return {std::move(name), 19, 0, 0, 0};
  const Field& x = F.at(fid);
  if (x.tag == 0x12) {
    for (size_t k = 0; k < x.mfids.size(); k++) {
      uint64_t c = frow_count(F, x.mfids[k], f0, f1, depth + 1);
      if (FPLAN_TEST_ENV("FPLAN_TEST_USTRUCT_ORDER") && x.mfids.size() > 1) {  // TEST-ONLY mutant: members named in reverse order
        size_t j = x.mfids.size() - 1 - k; if (idx < c) return frow_at(F, name + "." + x.members[j], x.mfids[k], f0, f1, depth + 1, idx);
      } else if (idx < c) return frow_at(F, name + "." + x.members[k], x.mfids[k], f0, f1, depth + 1, idx);
      idx -= c;
    }
    throw ParseError("unpacked struct row outside its members");
  }
  if (x.unpacked || x.tag == 0x10) {
    uint64_t inner = frow_count(F, x.base, f0, f1, depth + 1);
    int64_t l = x.dims[0].first, r = x.dims[0].second; int64_t k = int64_t(idx / inner);
    int64_t ind = l <= r ? l + k : l - k;
    return frow_at(F, name + "[" + i2s(ind) + "]", x.base, f0, f1, depth + 1, idx % inner);
  }
  if (x.string || x.nonbit) return {std::move(name), int64_t(fid), 0, 0, 0};
  return {std::move(name), int64_t(fid), x.bits, x.left, x.right};
}

// ---------------------------------------------------------------- declarations
struct Sig { uint64_t id; int64_t bits, left, right, field_id; uint32_t scope; std::string name; bool pkg = false; uint32_t dir = 0; int32_t dtype = -1; const char* why = nullptr; uint8_t ctag = 0; uint64_t big = 0; };  // dtype: -1 none, 0 a decoded enum (carried as a plain vector), -2 an undecoded datatype on a struct member (carried as a plain vector, as before), n > 0 refused (Decl::dtype_why[n - 1]), -3 a reference never resolved (refused)  // why: the reason of a pkg-style (id 0) refusal  // dir: tree directory that declares it (0 = the first)  // pkg: package-scope row, declared with no values
struct ScopeTab {  // interned scope names (one id per full name) + recovered components (first record) + ambiguity
  // Names are interned by (parent name id, component) in scopeintern::Tab; a full name is built on demand (full()).
  // Two records whose components differ only in where a '.' splits them ("a.b" + "c" vs "a" + "b.c") name the same
  // scope, as before; only names with a '.' inside a component keep a full-string key (dotfull), so the usual case
  // stores no full names at all.
  std::vector<int32_t> parent; std::vector<std::string> rname; std::vector<uint32_t> rnid;  // per record
  scopeintern::Tab tab; std::unordered_map<std::string, uint32_t> dotfull; std::vector<uint8_t> dotted;
  std::vector<uint32_t> first; std::vector<uint8_t> ambiguous;
  std::vector<uint8_t> croot;  // per name id: under a class-object root ("$object_root" / "$trans_root"), set when interned
  size_t size() const { return first.size(); }
  static bool class_root_comp(std::string_view c) {
    for (std::string_view r : {std::string_view("$object_root"), std::string_view("$trans_root")})
      if (c.size() >= r.size() && c.compare(0, r.size(), r) == 0 && (c.size() == r.size() || c[r.size()] == '.')) return true;
    return false;
  }
  void push_name(uint32_t pid, uint8_t dot, uint32_t rec, std::string_view comp) {
    dotted.push_back(dot); first.push_back(rec); ambiguous.push_back(0);
    croot.push_back(pid == scopeintern::ROOT ? uint8_t(class_root_comp(comp)) : croot[pid]);
  }
  std::string full(uint32_t id) const { return tab.full(id); }
  // id of an existing name equal to full string f whose components hold no '.', or NONE
  uint32_t find_plain(const std::string& f) const {
    uint32_t p = scopeintern::ROOT; size_t i = 0;
    for (;;) { size_t j = f.find('.', i); std::string_view c(f.data() + i, (j == std::string::npos ? f.size() : j) - i);
      uint32_t id = tab.find(p, c); if (id == scopeintern::NONE || dotted[id]) return scopeintern::NONE;
      if (j == std::string::npos) return id; p = id; i = j + 1; }
  }
  uint32_t add(int32_t par, std::string name) {
    const uint32_t pid = par < 0 ? scopeintern::ROOT : rnid[par];
    const bool dot = name.find('.') != std::string::npos || (par >= 0 && dotted[pid]);
    uint32_t rec = uint32_t(parent.size()), id = scopeintern::NONE;
    if (!dot && dotfull.empty()) {  // the usual case: one probe, get-or-add
      parent.push_back(par); rname.push_back(std::move(name));
      const size_t before = first.size(); id = tab.get(pid, rname.back());
      if (id == before) push_name(pid, 0, rec, rname.back());
      else if (!ambiguous[id] && !same_components(first[id], int32_t(rec))) ambiguous[id] = 1;
      rnid.push_back(id); return rec;
    }
    if (!dot) {
      id = tab.find(pid, name);
      if (id == scopeintern::NONE && !dotfull.empty()) { auto it = dotfull.find((par < 0 ? std::string() : tab.full(pid) + ".") + name); if (it != dotfull.end()) id = it->second; }
    } else {
      std::string f = (par < 0 ? std::string() : tab.full(pid) + ".") + name; auto it = dotfull.find(f);
      if (it != dotfull.end()) id = it->second; else if ((id = find_plain(f)) == scopeintern::NONE) {
        id = tab.get(pid, name); if (id != first.size()) throw ParseError("scope table: dotted scope name interned twice");
        dotfull.emplace(std::move(f), id); push_name(pid, 1, rec, name);
        parent.push_back(par); rname.push_back(std::move(name)); rnid.push_back(id); return rec;
      }
    }
    parent.push_back(par); rname.push_back(std::move(name));
    if (id == scopeintern::NONE) {
      id = tab.get(pid, rname.back()); if (id != first.size()) throw ParseError("scope table: scope name interned twice");
      push_name(pid, 0, rec, rname.back());
    } else if (!ambiguous[id] && !same_components(first[id], rec)) ambiguous[id] = 1;
    rnid.push_back(id); return rec;
  }
  // mark / rollback: undo every add() since the mark (a later tree directory left out); the ambiguity flags are restored too
  struct Mark { size_t recs, names; std::vector<std::pair<uint32_t, uint8_t>> amb; };
  Mark mark() const { return {parent.size(), first.size(), {}}; }
  void rollback(const Mark& m) {
    for (size_t i = m.names; i < first.size(); i++) if (dotted[i]) dotfull.erase(tab.full(uint32_t(i)));
    tab.truncate(m.names); dotted.resize(m.names); first.resize(m.names); ambiguous.resize(m.names); croot.resize(m.names);
    parent.resize(m.recs); rname.resize(m.recs); rnid.resize(m.recs);
    std::fill(ambiguous.begin(), ambiguous.end(), 0);  // recomputed from the records that stay
    for (size_t rec = 0; rec < parent.size(); rec++) { uint32_t id = rnid[rec]; if (first[id] != rec && !ambiguous[id] && !same_components(first[id], int32_t(rec))) ambiguous[id] = 1; }
  }
  bool same_components(int32_t a, int32_t b) const {
    while (a >= 0 && b >= 0) { if (rname[a] != rname[b]) return false; a = parent[a]; b = parent[b]; }
    return a < 0 && b < 0;
  }
  std::vector<std::string> components(uint32_t id) const {
    std::vector<std::string> v; for (int32_t a = int32_t(first[id]); a >= 0; a = parent[a]) v.push_back(rname[a]);
    std::reverse(v.begin(), v.end()); return v;
  }
};
struct Decl {
  std::vector<Sig> sig; ScopeTab scopes; bool fdefs = false;
  bool plain_groups = false;  // plain tree with array groups (list-file dumps): element values located through the array aliases
  std::unordered_map<uint32_t, std::vector<uint64_t>> plain_copies;
  uint64_t not_listed = 0;  // identity-extended records with the not-listed bit (named "hidden" in the dumps seen): skipped, counted  // list-file dumps: kept signal index -> IDs of its earlier same-name copies
  std::unordered_set<uint64_t> class_fids;  // field IDs of class types (tags 0x19 / 0 / 2): their variables are per-name refusals
  uint64_t n_tree = 0;  // ordinary tree variables declared (not package rows, not class-object records)
  std::unordered_map<uint64_t, uint64_t> plain;  // plain_aliases
  bool empty_dir = false;  // a later tree directory with no scope, variable or datatype block
  // later tree directories not read: index, reason, and the low value IDs the directory introduces [lo, hi) (its directory
  // word); their value-carrying IDs no other declaration references are listed by ID with the directory index
  struct SkippedDir { size_t k; std::string why; uint64_t lo, hi; };
  std::vector<SkippedDir> skipped_dirs;
  std::vector<std::string> dtype_why;  // refusal reasons of vars that name an extended datatype (Sig::dtype)
};

// a declaration's full name: its scope's full name + "." + its name (built on demand; Sig stores no full name)
std::string sig_full(const Decl& d, const Sig& s) { std::string f = d.scopes.full(s.scope); f += '.'; f += s.name; return f; }
// the old "$object_root." / "$trans_root." prefix test on the full name, without building it: the root component is
// the root name exactly, or starts with the root name and a '.'
bool under_class_root(const Decl& d, const Sig& s) { return d.scopes.croot[s.scope] != 0; }

// declaration-walk threads: FPLAN_WALK_THREADS (DIAGNOSTIC override, 1..64), else the usable CPUs (at most 16)
int walk_threads() {
  static const int n = [] { const char* e = getenv("FPLAN_WALK_THREADS"); int v = e ? atoi(e) : 0;
    return v >= 1 && v <= 64 ? v : int(std::min(16u, std::max(1u, usableCpus()))); }();
  return n;
}

// DIAGNOSTIC (FPLAN_WALK_TRACE set): declaration-walk phase times (accumulated per phase, printed at the end of the walk)
struct WalkTrace {
  bool on = getenv("FPLAN_WALK_TRACE") != nullptr; std::vector<std::pair<const char*, double>> acc; double t = 0;
  static double now() { timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec * 1e-9; }
  void start() { if (on) t = now(); }
  void add(const char* w) { if (!on) return; double n = now(); for (auto& x : acc) if (!strcmp(x.first, w)) { x.second += n - t; t = n; return; } acc.push_back({w, n - t}); t = n; }
  void print(size_t dirs) { if (!on) return; fprintf(stderr, "WALKTRACE dirs %zu", dirs); for (auto& x : acc) fprintf(stderr, " %s=%.3f", x.first, x.second); fprintf(stderr, "\n"); }
};

// DIAGNOSTIC (FPLAN_RSS_TRACE set): resident and peak memory at the planner's phase boundaries, one stderr line each
void rss_mark(const char* tag) {
  static const bool on = getenv("FPLAN_RSS_TRACE") != nullptr; if (!on) return;
  long rss = -1, hwm = -1; if (FILE* f = fopen("/proc/self/status", "r")) { char l[256];
    while (fgets(l, sizeof l, f)) { if (!strncmp(l, "VmRSS:", 6)) rss = atol(l + 6); else if (!strncmp(l, "VmHWM:", 6)) hwm = atol(l + 6); } fclose(f); }
  static const auto t0 = std::chrono::steady_clock::now();
  fprintf(stderr, "RSS %s rss_kb %ld hwm_kb %ld t_s %.3f\n", tag, rss, hwm, std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
}

// ordinary and extended scope streams share the link grammar.
struct ScopeGrammar {
  Cursor& c;
  void prev() { uint64_t m = c.u(1); if (!(m & 0xc0)) c.u(uint64_t(1) << (m & 3)); }
  void uprev() {
    uint64_t m = c.u(1);
    if (m == 255) throw ParseError("extended upscope link unsupported");
    if (!(m & 128)) c.u(uint64_t(1) << (m & 3));
    if (!(m & 64)) c.u(uint64_t(1) << ((m >> 2) & 3));
  }
  bool link(uint64_t m, uint64_t& off) {
    unsigned mode = m & 3;
    if (mode == 3) throw ParseError("extended variable link unsupported");
    if (!mode) return false;
    off = c.u(mode == 1 ? 4 : 8); return true;
  }
};

bool scope_links_plain(const Raw& r, const TreeDir& g, ScopeTab& tab, std::unordered_map<uint64_t, uint32_t>& links, std::unordered_map<uint64_t, bool>& group_link) {
  bool list_tags = false;  // a block / generate / interface / modport scope (list-file dumps; 15.1 refused them)
  if (g.g[0].size() != 1 || g.g[1].size() < 1) throw ParseError("single scope block subset only");
  Bytes raw = dec(r.b + g.g[0][0].off, g.g[0][0].size, {1, 1});
  Cursor c(raw); ScopeGrammar G{c};
  static const uint8_t fe = 0xfe; c.expect(&fe, 1);
  uint64_t begin = c.u(1), off;
  if (begin & ~uint64_t(7)) throw ParseError("extended tree start unsupported");
  if (G.link(begin, off)) throw ParseError("begin variable link unsupported");
  if (begin & 4) G.prev();
  std::vector<int32_t> stack;
  for (;;) {
    size_t pos = c.i; uint64_t tag = c.u(1);
    if (tag == 255) { if (begin & 4) G.uprev(); c.end(); if (!stack.empty()) throw ParseError("unbalanced scope stack"); break; }
    if (tag == 253) {
      uint64_t m = c.u(1);
      if (m & ~uint64_t(7)) throw ParseError("extended upscope flags unsupported");
      if (G.link(m, off)) throw ParseError("upscope variable link unsupported");
      if (m & 4) G.uprev();
      if (stack.empty()) throw ParseError("scope stack underflow");
      stack.pop_back(); continue;
    }
    // list-file dumps: tag 3 = named block ("unnamed$$_0"), 7 = generate block ("g_cl[0]"), 0x1f = interface instance (as
    // the extended stream reads it), 0x20 = modport inside an interface instance; all in the module grammar (two names,
    // empty third, flags). Any other tag stays refused.
    if (tag != 0 && tag != 3 && tag != 7 && tag != 0x1f && tag != 0x20) throw ParseError("unsupported scope tag " + hx(tag) + " at " + hx(pos));
    if (tag) list_tags = true;
    std::string name = c.text(); c.text();
    if (!c.text_empty()) throw ParseError("scope third string unsupported");
    uint64_t m = c.u(1);
    // bit 4 (0x10) has no payload. Seen only on links to array records (list-file dumps): every 0xda array group link has it,
    // and most 0xc9 struct-array links (596 of 660 in the large list-file fixture). The variable parser refuses a flagged link to any other record
    // and an unflagged link to an array group. Bits 5 and 7 stay refused.
    if (m & ~uint64_t(0x5f)) throw ParseError("extended scope flags unsupported");
    if ((m & 0x10) && !(m & 3)) throw ParseError("array-group scope flag without a variable link");
    bool has = G.link(m, off);
    if ((m & 4) && !(m & 8)) G.prev();
    uint32_t rec = tab.add(stack.empty() ? -1 : stack.back(), std::move(name));
    stack.push_back(int32_t(rec));
    if (has) {
      auto it = links.find(off);
      if (it != links.end() && it->second != tab.rnid[rec]) throw ParseError("ambiguous scope link");
      auto gl = group_link.find(off);
      if (gl != group_link.end() && gl->second != bool(m & 0x10)) throw ParseError("array-group scope flag differs between links");
      links[off] = tab.rnid[rec]; group_link[off] = bool(m & 0x10);
    }
  }
  return list_tags;
}

std::string compact_tag_hex(uint64_t tag) { char b[8]; snprintf(b, sizeof b, "0x%02llx", (unsigned long long)tag); return b; }

bool project_plain_ids(const Raw& r, const Header& h, Decl& d);
void native_vars_plain(const Raw& r, const Header& h, const FieldMap& f, Decl& d) {
  if (tree_dir_seq(r, h.section).size() > 1) throw ParseError("several tree directories without field definitions not supported");
  std::unordered_map<uint64_t, uint32_t> links; std::unordered_map<uint64_t, bool> group_link;
  TreeDir g = tree_directory(r, h.section);
  const bool list_tags = scope_links_plain(r, g, d.scopes, links, group_link);
  Bytes raw = join_decode(r, g.g[1]);
  Cursor c(raw); static const uint8_t bf = 0xbf; c.expect(&bf, 1);
  std::unordered_set<uint64_t> used; int64_t scope = -1; uint64_t last = 0;
  static const unsigned W3[3] = {1, 2, 4};
  // array groups (list-file dumps): 0xda name+type, then one 0xd9 row per element (the 0xd5 row grammar), closed by 0xdb.
  // Each listed element re-declares its whole array; repeats must match exactly and are declared once.
  const unsigned WG[3] = {r.u(0x100, 1) == 1 ? 8u : 1u, 2u, 4u};
  std::unordered_map<std::string, std::pair<uint64_t, int64_t>> group_rows; bool groups = false;
  // TEST-ONLY red mutants (FPLAN_TEST_LISTDUMP): "flag" = array-group links read as ordinary links; "dupid" = every repeated
  // array declaration one ID higher; "rowshift" = element rows named one element later; "nosuffix" = vector names without [l:r];
  // "members" = struct members named without their struct path; "firstcopy" = the FIRST copy of a re-declared name kept.
  // One red per refusal reason (each fires once, at the first record it can act on): "scount" / "acount" = the first struct /
  // unpacked array declares one member more; "closer" = the first 0xc8 read as 0xc1; "noclose" = the first 0xc8 ignored;
  // "kind" = the first struct kind byte read as 0x0c; "zero" = the first element count read as 0; "linkin" = the first record
  // inside a struct carries a scope link; "arrin" = the first struct directly inside an unpacked array read as an unpacked
  // array; "grpin" = the first 0xda met inside an (empty) open struct; "width" = the first dropped copy one bit wider;
  // identity bytes (byte rewrites of a real record): "hid20" / "hid36" = the first explicit-ID record's extension byte
  // rewritten to 0x14 / 0x24, i.e. a [20:0] / [36:0] vector with a consecutive ID in the old reading; "outside" = the first
  // explicit-ID record read as if no struct were open; "seq17" / "seq33" = the first bounded explicit-ID member with 0x11 /
  // 0x21 rewritten to a sequential [17:0] / [33:0] member (its bound byte and ID bytes removed, later scope links moved)
  const char* lm = FPLAN_TEST_ENV("FPLAN_TEST_LISTDUMP");
  static const char* const LM[] = {"", "flag", "dupid", "rowshift", "nosuffix", "members", "firstcopy", "scount", "acount", "closer",
    "noclose", "kind", "zero", "linkin", "arrin", "grpin", "width", "hid20", "hid36", "outside", "seq17", "seq33"};
  int list_mut = 0; if (lm) for (int k = 1; k < int(sizeof LM / sizeof *LM); k++) if (!strcmp(lm, LM[k])) list_mut = k;
  bool fired = false;  // the one-shot mutants above
  auto shot = [&](int k) { if (list_mut != k || fired) return false; fired = true; return true; };
  // list-file records seen (array groups, struct records, identity-extension bytes): only then do the copies rule and the ID
  // projection run, so a dump without them takes 15.1's path (duplicates go to the plan3 duplicate check)
  // The range suffix ("[l:r]" on a vector name whose text lacks it) is part of the same set: 15.1 named plain vectors by their
  // text alone, and dumps from our own writer keep that naming. A block / generate / interface / modport scope counts too.
  std::vector<std::pair<size_t, uint64_t>> plain_dt;  // (signal index, type number) of struct members that name a datatype
  bool list_records = list_tags; std::vector<size_t> unsuffixed;  // ordinary records whose name may take the range suffix
  // struct records (list-file dumps): 0xc9 <u32 element count> <name> opens an unpacked array (its elements are structs or
  // ordinary records named with their index, e.g. "cpuregs[0][31:0]"), closed by 0xc1 after exactly that many elements; 0xc7 0x0b <u32 member count> <name> opens one struct (an element, or a struct member),
  // closed by 0xc8 after exactly that many direct members. Members are the ordinary records, named <struct>.<member>.
  struct SFrame { bool arr; uint64_t want, got; std::string prefix; };
  std::vector<SFrame> st;
  auto member = [&]() { if (!st.empty()) st.back().got++; };
  while (c.i < c.n) {
    size_t offset = c.i; uint64_t tag = c.u(1);
    auto it = links.find(offset);
    if (it != links.end() || (!st.empty() && shot(13))) {
      if (!st.empty()) throw ParseError("scope link inside a struct record");
      scope = it->second; used.insert(offset);
      const bool flagged = list_mut == 1 ? false : group_link.at(offset);
      if (flagged ? !(tag == 0xda || tag == 0xc9) : tag == 0xda) throw ParseError("array-group scope flag does not match the linked record");
    }
    if (tag == 0xff) { if (!st.empty()) throw ParseError("struct record not closed"); continue; }
    if (scope < 0) throw ParseError("variable before scope link");
    if (tag == 0xc7) {
      uint64_t kind = c.u(1); if (shot(11)) kind = 0x0c;
      if (kind != 0x0b) throw ParseError("struct record kind unsupported");
      if (!st.empty() && st.back().arr && shot(14)) tag = 0xc9;
    }
    if (tag == 0xc9) {
      list_records = true;
      if (!st.empty() && st.back().arr) throw ParseError("unpacked array directly inside an unpacked array");
      uint64_t n = c.u(4); std::string name = c.text();
      if (shot(12)) n = 0;
      if (!n || n > 1000000) throw ParseError("struct array element count");
      if (shot(8)) n++;
      member(); st.push_back({true, n, 0, st.empty() ? std::string() : st.back().prefix}); continue;
    }
    if (tag == 0xc7) {
      list_records = true;
      uint64_t n = c.u(4); std::string name = c.text();
      if (n > 1000000) throw ParseError("struct member count");
      if (shot(7)) n++;
      member(); std::string pre = st.empty() || st.back().prefix.empty() ? name : st.back().prefix + "." + name;
      st.push_back({false, n, 0, pre}); continue;
    }
    if (tag == 0xc8 && shot(10)) continue;
    if (tag == 0xc8 && shot(9)) tag = 0xc1;
    if (tag == 0xc8 || tag == 0xc1) {
      if (st.empty() || st.back().arr != (tag == 0xc1)) throw ParseError("struct record closed out of order");
      if (st.back().got != st.back().want) throw ParseError("struct record member count mismatch");
      st.pop_back(); continue;
    }
    Sig s; s.scope = uint32_t(scope); s.field_id = -1; int64_t plain_dt_num = -1;
    if (tag == 0xda) {
      list_records = true;
      if (shot(15)) st.push_back({false, 1000000, 0, std::string()});
      if (!st.empty()) throw ParseError("array group inside a struct record");
      std::string name = c.text(); uint64_t m = c.u(1);
      if (m & ~uint64_t(0x40)) throw ParseError("array group flags " + hx(m));
      uint64_t fid = c.u(m & 0x40 ? 4 : 2), f0 = c.u(1), f1 = c.u(1);
      if (!f.count(fid)) throw ParseError("unknown field id");
      uint64_t total = frow_count(f, fid, uint8_t(f0), uint8_t(f1), 0), nrow = 0; int64_t row = -1;
      std::vector<uint8_t> seen(size_t(total), 0);
      while (c.i < c.n && c.b[c.i] == 0xd9) {
        c.u(1); uint64_t rm = c.u(1);
        if (rm & 15) throw ParseError("array group row identity " + hx(rm));
        unsigned mode = (rm >> 4) & 3;
        if (mode == 3) last += 1; else last = c.u(WG[mode]);
        unsigned rmode = (rm >> 6) & 3;
        if (rmode == 3) row += 1; else row = int64_t(c.u(W3[rmode]));
        if (row < 0 || uint64_t(row) >= total || seen[size_t(row)]) throw ParseError("array group row outside its type or repeated");
        seen[size_t(row)] = 1; nrow++;
        FRow fr = frow_at(f, name, fid, uint8_t(f0), uint8_t(f1), 0, list_mut == 3 ? (uint64_t(row) + 1) % total : uint64_t(row));
        Sig e; e.scope = uint32_t(scope); e.id = last; e.field_id = fr.fid; e.bits = fr.bits; e.left = fr.left; e.right = fr.right;
        e.name = std::move(fr.name);
        if (e.bits > 1) e.name += "[" + i2s(e.left) + ":" + i2s(e.right) + "]";
        const std::string efull = sig_full(d, e);
        auto g2 = group_rows.find(efull);
        if (list_mut == 2 && g2 != group_rows.end()) e.id++;
        if (g2 != group_rows.end()) {
          if (g2->second.first != e.id || g2->second.second != e.bits) throw ParseError("array group re-declared with a different ID or width");
          continue;
        }
        group_rows.emplace(efull, std::make_pair(e.id, e.bits)); groups = true;
        if (e.field_id != CLASS_FID) d.n_tree++;
        d.sig.push_back(std::move(e));
      }
      if (nrow != total) throw ParseError("array group does not declare every element");
      if (c.u(1) != 0xdb) throw ParseError("array group not closed");
      continue;
    }
    if (tag == 0x04 || tag == 0x0f) {
      s.name = c.text(); uint64_t m = c.u(1); unsigned lw = m & 3, rw = (m >> 2) & 3;
      // bit 7 alone, only on struct members: a 2-byte type reference after the ID (enum-typed members); no value meaning
      const bool typed = (m & 0xc0) == 0x80 && !st.empty(); if (typed) m &= 0x3f;
      if ((m & 0xc0) || (tag == 0x04 && (lw > 1 || rw)) || lw == 3 || rw == 3) throw ParseError("compact var " + compact_tag_hex(tag) + ": unqualified mask");
      // identity extension (tag 0x04, ID mode bits 0x30). In 15.1 mode 3 means "the next ID" and the bound byte (if any)
      // follows; the extended grammar instead puts one extension byte first. The two readings are told apart by the next byte
      // and the form, keeping every 15.1 reading of an ordinary record:
      //  - next byte 0x14 / 0x24 (not listed: 2- / 4-byte ID, declared nowhere), no bound byte: the extension (15.1 refused
      //    such a dump: the byte was read as a tag). With a bound byte it is also a [20:0] / [36:0] vector with the next ID
      //    in 15.1's reading: refused as ambiguous.
      //  - next byte 0x11 / 0x21 (explicit 2- / 4-byte ID, listed) INSIDE a struct record or unpacked array: the extension
      //    (15.1 refused struct records, so no 15.1 reading exists there; the identity check of the struct list-file pair holds
      //    with it). Outside them it is a bound / the next ID as in 15.1.
      //  - anything else: 15.1's reading.
      bool hidden = false; uint64_t identity = m;
      if (tag == 0x04 && (m & 0x30) == 0x30 && c.i < c.n) {
        if ((lw || rw) && shot(17)) raw[c.i] = 0x14; else if ((lw || rw) && shot(18)) raw[c.i] = 0x24;
        if (lw == 1 && !rw && !st.empty() && ((raw[c.i] == 0x11 && shot(20)) || (raw[c.i] == 0x21 && shot(21)))) {
          const size_t k = raw[c.i] == 0x11 ? 3 : 5, at = c.i + 1;  // the bound byte + the 2- / 4-byte ID
          raw.erase(raw.begin() + long(at), raw.begin() + long(at + k)); c.b = raw.data(); c.n = raw.size();
          std::unordered_map<uint64_t, uint32_t> l2; std::unordered_map<uint64_t, bool> g2;
          for (auto& kv : links) l2[kv.first > at ? kv.first - k : kv.first] = kv.second;
          for (auto& kv : group_link) g2[kv.first > at ? kv.first - k : kv.first] = kv.second;
          links.swap(l2); group_link.swap(g2);
        }
        const uint8_t nb = c.b[c.i];
        const bool open = !st.empty() && !((nb == 0x11 || nb == 0x21) && shot(19));
        if (nb == 0x14 || nb == 0x24) {
          if (lw || rw) throw ParseError("compact var 0x04: ambiguous identity byte " + hx(nb) + " on a record with a bound (an identity extension, or a vector bound with the next ID)");
          identity = c.u(1); hidden = true; list_records = true;
        } else if ((nb == 0x11 || nb == 0x21) && open) { identity = c.u(1); list_records = true; }
      }
      int64_t left = lw ? int64_t(c.u(lw)) : 0, right = rw ? int64_t(c.u(rw)) : 0;
      unsigned mode = (identity >> 4) & 3;
      if (mode == 0) throw ParseError("mode0 native ID width depends on unqualified extended-ID header flag");
      if (mode == 3) last += 1; else last = c.u(W3[mode]);
      if (typed) plain_dt_num = c.u(2);
      if (hidden) { d.not_listed++; continue; }
      s.id = last; s.bits = (left > right ? left - right : right - left) + 1; s.left = left; s.right = right;
    } else {
      if (tag != 0xd8) throw ParseError("only field-typed var 0xd8 qualified, got " + hx(tag));
      s.name = c.text(); uint64_t m = c.u(1);
      if (m & 0x0f) throw ParseError("ext-identity/extended native var unsupported");
      unsigned mode = (m >> 4) & 3;
      if (mode == 0) throw ParseError("mode0 native ID width depends on unqualified extended-ID header flag");
      if (mode == 3) last += 1; else last = c.u(W3[mode]);
      uint64_t fid = c.u(m & 0x40 ? 4 : 2), f0 = c.u(1), f1 = c.u(1);
      if (f0 > 3 || !(f1 == 0 || f1 == 2)) throw ParseError("native var attributes unsupported");  // f0 1-3: as in the extended grammar (direction-like, no payload)
      auto ft = f.find(fid);
      if (ft == f.end()) throw ParseError("unknown field id");
      s.id = last; s.field_id = int64_t(fid); s.bits = ft->second.bits; s.left = ft->second.left; s.right = ft->second.right;
    }
    unsuffixed.push_back(d.sig.size());
    if (!st.empty()) { member(); if (list_mut != 5 && !st.back().prefix.empty()) s.name = st.back().prefix + "." + s.name; }
    if (s.field_id != CLASS_FID && !under_class_root(d, s)) d.n_tree++;
    if (plain_dt_num >= 0) plain_dt.push_back({d.sig.size(), uint64_t(plain_dt_num)});
    d.sig.push_back(std::move(s));
  }
  // struct members that name a datatype: carried as plain vectors (no value change). Named in the report: a decoded enum
  // of the member's width counts in the enum note (labels not carried); any other reference counts as undecoded.
  if (!plain_dt.empty()) {
    DtTable dt{{}, "no datatype block"};  // a block that does not decode only changes the note (these members were carried before)
    if (!g.g[2].empty()) try { dt = decode_datatypes(join_decode(r, g.g[2])); } catch (const std::exception&) { dt = DtTable{{}, "datatype block not decoded"}; }
    for (auto& x : plain_dt) {
      auto it = dt.types.find(x.second);
      d.sig[x.first].dtype = it != dt.types.end() && it->second.why.empty() && it->second.bits == uint64_t(d.sig[x.first].bits) ? 0 : -2;
    }
  }
  if (raw.empty() || raw.back() != 0xff) throw ParseError("missing variable stream terminator");
  if (!st.empty()) throw ParseError("struct record not closed");
  // list-file dumps: the extended path's naming, a vector name carries its range (a name whose text already ends with it,
  // e.g. struct members or names converted from VCD, is kept). The suffix goes at the end, so a struct path is unaffected.
  if (list_records && list_mut != 4) for (size_t k : unsuffixed) {
    Sig& x = d.sig[k]; const std::string rg = "[" + i2s(x.left) + ":" + i2s(x.right) + "]";
    const bool has = x.name.size() > rg.size() && x.name.compare(x.name.size() - rg.size(), rg.size(), rg) == 0;
    if (x.bits > 1 && !has) x.name += rg;
  }
  if (used.size() != links.size()) throw ParseError("scope link misses variable boundary");
  {  // copies: a list-file dump re-declares a whole struct / unpacked array for each listed member, under new IDs. The LAST
     // declaration of a name is kept; the earlier copies' IDs are kept beside it, and the planner refuses the name if one of
     // them carries values of its own (the copies are expected to be value-free). Copies must agree in width.
    std::unordered_map<std::string, size_t> lastpos;
    if (list_records) for (size_t k = 0; k < d.sig.size(); k++) { std::string f = sig_full(d, d.sig[k]); if (list_mut != 6 || !lastpos.count(f)) lastpos[f] = k; }
    if (list_records && lastpos.size() != d.sig.size()) {
      std::vector<Sig> keep; keep.reserve(lastpos.size()); std::unordered_map<std::string, std::vector<uint64_t>> drop;
      for (size_t k = 0; k < d.sig.size(); k++) {
        Sig& x = d.sig[k]; const std::string xfull = sig_full(d, x); size_t L = lastpos.at(xfull);
        if (L != k) {
          const Sig& y = d.sig[L];
          if (y.bits != x.bits + (shot(16) ? 1 : 0) || y.left != x.left || y.right != x.right) throw ParseError("list-dump copies of one name differ in width");
          if (x.id != y.id) drop[xfull].push_back(x.id);
          if (x.field_id != CLASS_FID && !under_class_root(d, x)) d.n_tree--;  // the predicate that counted it
          continue;
        }
        auto dd = drop.find(xfull);
        if (dd != drop.end()) d.plain_copies[uint32_t(keep.size())] = std::move(dd->second);
        keep.push_back(std::move(x));
      }
      d.sig = std::move(keep);
    }
  }
  if (list_records && project_plain_ids(r, h, d)) d.plain_groups = true;  // array-group element IDs live in the array-alias namespace: project as the extended path does
}

// extended scope stream: records with definition ids
struct ExtScope { int64_t def; };  // -1 none
void parse_scope_stream(const Bytes& raw, const DefMap& defs, ScopeTab& tab, std::vector<ExtScope>& recs, std::unordered_map<uint64_t, uint32_t>& links, bool multi_dir = false) {
  Cursor c(raw); ScopeGrammar G{c};
  static const uint8_t fe = 0xfe; c.expect(&fe, 1);
  uint64_t begin = c.u(1), off;
  if (begin & ~uint64_t(7)) throw ParseError("extended tree start unsupported");
  if (G.link(begin, off)) throw ParseError("begin variable link unsupported");
  if (begin & 4) G.prev();
  std::vector<uint32_t> stack; std::vector<bool> genport;  // genport: the scope (or one above it) is a generic interface port (0x21)
  static const unsigned W3[3] = {1, 2, 4};
  for (;;) {
    size_t pos = c.i; uint64_t tag = c.u(1);
    if (tag == 255) {
      if (begin & 4) G.uprev();
      else if (multi_dir && c.i + 1 == c.n && raw[c.i] == 0xff) c.i++;  // multi_dir fragment without a prev link: one empty link byte (ff)
      c.end(); if (!stack.empty()) throw ParseError("unbalanced scope stack"); break;
    }
    if (tag == 253) {
      uint64_t m = c.u(1);
      if (m & ~uint64_t(7)) throw ParseError("extended upscope flags unsupported");
      if (G.link(m, off)) throw ParseError("upscope variable link unsupported");
      if (m & 4) G.uprev();
      if (stack.empty()) throw ParseError("scope stack underflow");
      stack.pop_back(); genport.pop_back(); continue;
    }
    int64_t fid = -1; std::string name;
    // 0x21: a generic interface port (a module port declared `interface <name>`), in the 0x1f grammar; its second string
    // is the path of the interface instance bound to it. The members are that instance's and are declared there, so a
    // 0x21 scope carries no variables of its own: one that links variables (itself or a scope under it) refuses the file.
    // tag 3 = named block, 7 = generate block, 0x20 = modport: the module grammar (as the plain stream reads them)
    // tag 1 = task scope, 2 = function scope (a later tree directory of dumps made with assertion dumping on: an interface's
    // tasks and functions): the module grammar too; their variables, if a scope links any, are declared as under any scope.
    // TEST-ONLY red (FPLAN_TEST_TASKSCOPE_BLOCK=1): tags 1 / 2 are refused again (the old whole-file refusal).
    const bool taskfn = (tag == 1 || tag == 2) && !FPLAN_TEST_ENV("FPLAN_TEST_TASKSCOPE_BLOCK");
    if (tag == 0 || tag == 3 || tag == 7 || tag == 0x1f || tag == 0x20 || tag == 0x21 || tag == 0x22 || taskfn) {
      name = c.text(); c.skip_text();
      if (!c.text_empty()) throw ParseError("scope third string unsupported");
    } else if (tag == 0xfa) {
      name = c.text(); uint64_t m = c.u(1);
      if (m & ~uint64_t(64)) throw ParseError("field-def root flags unsupported");
      fid = int64_t(c.u(m & 64 ? 4 : 2));
    } else if (tag == 0xfb) {
      uint64_t m = c.u(1);
      if (m & ~uint64_t(0x70)) throw ParseError("field-def child flags unsupported");
      fid = int64_t(c.u(m & 64 ? 4 : 2)); unsigned mode = (m >> 4) & 3;
      if (mode == 3) throw ParseError("field-def child name width unsupported");
      uint64_t child = c.u(W3[mode]);
      if (stack.empty() || recs[stack.back()].def < 0 || !defs.count(uint64_t(recs[stack.back()].def))) throw ParseError("field-def child without parent definition");
      const auto& ch = defs.at(uint64_t(recs[stack.back()].def)).children;
      if (child >= ch.size()) throw ParseError("field-def child outside parent names");
      name = ch[child];
    } else throw ParseError("unsupported scope tag " + hx(tag) + " at " + hx(pos));
    if (fid >= 0) {
      auto it = defs.find(uint64_t(fid));
      if (it == defs.end()) throw ParseError("unknown scope definition ID");
      uint64_t k = it->second.kind;
      // 2 = program instance (program ... endprogram): an instance scope like a module; its rows are static variables
      if (!(k == 0 || (k == 1 && multi_dir) || k == 2 || k == 3 || k == 4 || k == 5 || k == 6 || k == 7 || k == 8)) throw ParseError("unsupported field-def scope kind " + u2s(k) + " (" + it->second.definition + ")");  // 6/7 = function/task scopes; 1 = package root (later tree directories only)
    }
    uint64_t m = c.u(1);
    // bit 7: no payload; seen only on linked scopes of a later tree directory (full-chip dumps). The link is read as without it.
    if (m & ~uint64_t(0xdf)) throw ParseError("unsupported scope link flags " + hx(m) + " at " + hx(pos));
    if (fc_arm("bit7") && (m & 0x80)) m &= ~uint64_t(3);
    if ((m & 0x80) && !(m & 3)) throw ParseError("scope flag bit 7 without a variable link at " + hx(pos));
    bool has = G.link(m, off);
    if ((m & 4) && !(m & 8)) G.prev();
    const bool in_gen = tag == 0x21 || (!genport.empty() && genport.back());  // TEST-ONLY mutant FPLAN_TEST_GENPORT_VARS: a 0x21 scope read as linking variables
    if ((has || (tag == 0x21 && FPLAN_TEST_ENV("FPLAN_TEST_GENPORT_VARS"))) && in_gen) throw ParseError("generic interface port scope (tag 0x21) with variables of its own at " + hx(pos) + ": not supported");
    uint32_t rec = tab.add(stack.empty() ? -1 : int32_t(stack.back()), std::move(name));
    recs.push_back({fid});
    if (has && !links.emplace(off, rec).second) throw ParseError("duplicate scope variable link");
    stack.push_back(rec); genport.push_back(in_gen);
    if (stack.size() > 512 || recs.size() > DECL_LIMIT) throw ParseError("scope count/depth limit");
  }
}

struct VarRec { uint64_t off; uint8_t tag; uint64_t id; std::string name; uint64_t fid; uint8_t f0, f1; int64_t left, right, bits; int extra; int64_t row; int64_t dtype = -1; int32_t dt_st = -1; };
void ext_records(const Bytes& raw_in, bool ext, std::vector<VarRec>& out, bool first_dir = true) {
  // TEST-ONLY hook FPLAN_TEST_VRAW_APPEND=<file>: the file's bytes (whole variable records) are inserted before the final
  // 0xff of the first directory's variable block, so a test can plant a record kind no fixture dump holds
  Bytes planted; const char* pf = first_dir ? FPLAN_TEST_ENV("FPLAN_TEST_VRAW_APPEND") : nullptr;
  const bool plant = pf && !raw_in.empty() && raw_in.back() == 0xff;
  if (plant) {
    FILE* f = fopen(pf, "rb"); if (!f) throw ParseError("test hook: cannot open FPLAN_TEST_VRAW_APPEND");
    planted.assign(raw_in.begin(), raw_in.end() - 1); int ch; while ((ch = fgetc(f)) != EOF) planted.push_back(uint8_t(ch)); fclose(f);
    planted.push_back(0xff);
  }
  const Bytes& raw = plant ? planted : raw_in;
  Cursor c(raw); static const uint8_t bf = 0xbf;
  if (first_dir) c.expect(&bf, 1); else if (!raw.empty() && raw[0] == 0xbf) throw ParseError("later tree directory: variable fragment with a leading 0xbf byte");
  bool seen = first_dir;  // a later-directory fragment must name its first value ID explicitly (no carry from the previous fragment)
  // An assertion record carries its own 4-byte ID; whether the writer counts it for a following implicit (last + 1) ID is not
  // established, so an implicit ID right after assertion records (no explicit ID between) refuses the file: no guessed IDs.
  bool after_assert = false, plant_assert = fc_arm("asimpl") && first_dir;  // red: act as if an assertion preceded the next implicit ID
  const unsigned W[3] = {ext ? 8u : 1u, 2u, 4u}; static const unsigned W3[3] = {1, 2, 4};
  // State between records: cursor, last ID, field-def row, class field ID, ID-carry flags, records emitted. Large blocks are
  // read twice: a serial skim (same grammar and checks, names not copied) saves the state every CP records, then the
  // records between checkpoints are built in parallel (walk_threads()). Small blocks or one thread: one serial pass.
  struct St { size_t i = 0; uint64_t last = 0; int64_t row = -1, cls_fid = -1; bool after_assert = false, seen = false, plant_assert = false; size_t cnt = 0; };
  const size_t CP = 65536;
  auto run = [&](auto skim, St st, size_t cend, VarRec* dst, std::vector<St>* cps) -> St {
    constexpr bool SKIM = decltype(skim)::value;
    Cursor c(raw); c.i = st.i; uint64_t last = st.last; int64_t row = st.row, cls_fid = st.cls_fid; bool after_assert = st.after_assert, seen = st.seen, plant_assert = st.plant_assert; size_t cnt = st.cnt;
    auto next_id = [&](unsigned mode, uint64_t& last, const unsigned* W) {
      if (plant_assert) { plant_assert = false; after_assert = true; mode = 3; }
      if (mode == 3) {
        if (!seen) throw ParseError("later tree directory: variable fragment starts with an implicit value ID");
        if (after_assert) throw ParseError("implicit value ID after an assertion record");
        last += 1;
      }
      else { last = c.u(W[mode]); after_assert = false; }
      seen = true;
    };
#define TXT(x) do { if constexpr (SKIM) { const void* z_ = memchr(c.b + c.i, 0, c.n - c.i); if (!z_) throw ParseError("unterminated name"); size_t e_ = size_t((const uint8_t*)z_ - c.b); check_utf8(c.b + c.i, e_ - c.i); c.i = e_ + 1; } else x = c.text(); } while (0)
#define EMIT(x) do { if constexpr (!SKIM) dst[cnt - st.cnt] = std::move(x); cnt++; } while (0)
    while (c.i < raw.size() && (SKIM || cnt < cend)) {
      if constexpr (SKIM) if (cps && cnt - st.cnt == cps->size() * CP) cps->push_back({c.i, last, row, cls_fid, after_assert, seen, plant_assert, cnt});
    if (cnt >= DECL_LIMIT && raw[c.i] != 255) throw ParseError("extended declaration count limit");
      size_t offset = c.i; uint64_t tag = c.u(1);
      if (tag == 0xff) { row = -1; continue; }
      VarRec v{}; v.off = offset; v.tag = uint8_t(tag); v.extra = -1;
      // Class-object records: 0xd3 / 0xdb open / close a class-object group (no payload); 0x3f = class handle (the 0x04
      // grammar plus one trailing byte after the ID); 0xda = class-object instance (the 0xd8 grammar, mask bit 2 set);
      // 0xd9 = one member row of the last instance (the 0xd5 grammar). All of them become per-name refusals.
      if (tag == 0xd3 || tag == 0xdb) continue;
      if (tag == 0x3f) {
        TXT(v.name); uint64_t m = c.u(1);
        if ((m & 0xc0) != 0x40 || (m & 0x30) == 0x30) throw ParseError("class handle attributes " + hx(m) + " at " + hx(offset));
        v.left = sbound(c, m & 3); v.right = sbound(c, (m >> 2) & 3);
        next_id((m >> 4) & 3, last, W); c.u(1);
        v.id = last; v.bits = 0; EMIT(v); continue;
      }
      if (tag == 0xda) {
        TXT(v.name); uint64_t m = c.u(1);
        if ((m & 15) != 4) throw ParseError("class instance identity " + hx(m) + " at " + hx(offset));
        next_id((m >> 4) & 3, last, W);
        v.fid = c.u(m & 64 ? 4 : 2); v.f0 = uint8_t(c.u(1)); v.f1 = uint8_t(c.u(1)); v.id = last; cls_fid = int64_t(v.fid); row = -1;
        EMIT(v); continue;
      }
      if (tag == 0xd9) {
        uint64_t m = c.u(1);
        if (m & 15) throw ParseError("class member identity " + hx(m) + " at " + hx(offset));
        next_id((m >> 4) & 3, last, W);
        unsigned rm = (m >> 6) & 3;
        if (rm == 3) row += 1; else row = int64_t(c.u(W3[rm]));
        if (cls_fid < 0) throw ParseError("class member row before a class instance at " + hx(offset));
        v.fid = uint64_t(cls_fid); v.id = last; v.row = row; EMIT(v); continue;
      }
      if (tag != 0xd5) {
        if (tag == 0xd8) {
          TXT(v.name); uint64_t m = c.u(1);
          if (m & 15) throw ParseError("extended field-type identity");
          unsigned mode = (m >> 4) & 3;
          next_id(mode, last, W);
          v.fid = c.u(m & 64 ? 4 : 2); v.f0 = uint8_t(c.u(1)); v.f1 = uint8_t(c.u(1)); v.id = last;
          EMIT(v); continue;
        }
        // 0x36 / 0x38 / 0x3e: assertion records (a later tree directory of full-chip dumps), attributes 0x64 or 0x54: the name,
        // one bound byte, a value ID (4 bytes with 0x64, 2 bytes with 0x54: bits 4-5 give the ID width as for ordinary
        // records), a 7-byte trailer (not decoded). Declared by name and refused (ASSERT_SKIP); the ID is not used.
        if (fc_arm("astag") && tag == 0x3e) tag = 0x3d;
        if (tag == 0x36 || tag == 0x38 || tag == 0x3e) {
          TXT(v.name); uint64_t m = c.u(1);
          if (fc_arm("asmask")) m = 0x65;
          if (m != 0x64 && m != 0x54) throw ParseError("assertion record attributes " + hx(m) + " at " + hx(offset));
          c.u(1); c.u(m == 0x64 ? 4 : 2); c.u(4); c.u(2); c.u(1);
          v.id = 0; v.bits = 0; after_assert = true; EMIT(v); continue;
        }
        if (tag != 4) throw ParseError("unsupported extended variable tag " + hx(tag) + " at " + hx(offset) + "; parsed " + u2s(cnt) + " records");
        TXT(v.name); uint64_t m = c.u(1);
        // bit 7: the record names an extended datatype (a 2-byte index into the directory's datatype blocks) after its ID;
        // resolved in native_vars_ext (an enum is carried, any other kind refused by name, DTYPE_SKIP). Bit 6 stays refused.
        if (fc_arm("attr40") && (m & 0x80)) m |= 0x40;
        if (m & 0x40) throw ParseError("ordinary trailing attributes " + hx(m) + " at " + hx(offset));
        const bool has_dtype = m & 0x80; m &= 0x7f;
        if (has_dtype && (m & 0x30) == 0x30) throw ParseError("extended datatype with an identity extension at " + hx(offset));
        uint64_t identity = m;
        if ((m & 0x30) == 0x30) {
          uint64_t extra = c.u(1); identity = extra; v.extra = int(extra);
          // 0x14 = 2-byte ID, 0x24 = the same with a 4-byte ID (large designs); bit 2 = not listed
          if (extra != 0x14 && extra != 0x24) throw ParseError("unqualified ordinary identity extension " + hx(extra));
          if (extra & 2) { uint64_t length = c.u(2); c.u(length); }
          if ((extra & 0x30) == 0x30) throw ParseError("ordinary ext-identity at " + hx(offset));
        }
        v.left = sbound(c, m & 3); v.right = sbound(c, (m >> 2) & 3);
        unsigned mode = (identity >> 4) & 3;
        next_id(mode, last, W);
        v.id = last; v.bits = (v.left > v.right ? v.left - v.right : v.right - v.left) + 1;
        if (has_dtype) v.dtype = int64_t(c.u(2));
        EMIT(v); continue;
      }
      uint64_t m = c.u(1);
      // bit 1 is a payload-free flag on field-def element records (seen on real IP gate builds); no payload follows it and the
      // flagged names carry normal values. Bits 0, 2, 3 stay refused.
      if (m & 13) throw ParseError("extended identity mask " + hx(m) + " at " + hx(offset));
      if (m & 2) v.extra = 2;
      unsigned mode = (m >> 4) & 3;
      next_id(mode, last, W);
      unsigned rm = (m >> 6) & 3;
      if (rm == 3) row += 1; else row = int64_t(c.u(W3[rm]));
      v.id = last; v.row = row; EMIT(v);
  
    }
#undef TXT
#undef EMIT
    return {c.i, last, row, cls_fid, after_assert, seen, plant_assert, cnt};
  };
  const St s0{c.i, 0, -1, -1, after_assert, seen, plant_assert, out.size()};
  const int WT = walk_threads();
  if (WT <= 1 || raw.size() < (size_t(8) << 20)) {  // one serial pass
    std::vector<VarRec> tmp; St e = s0;
    for (;;) { tmp.assign(CP, VarRec{}); St x = run(std::false_type(), e, e.cnt + CP, tmp.data(), nullptr);
      for (size_t k = 0; k < x.cnt - e.cnt; k++) out.push_back(std::move(tmp[k]));
      if (x.cnt - e.cnt < CP) break; e = x; }
  } else {
    std::vector<St> cps; const St end = run(std::true_type(), s0, 0, nullptr, &cps);
    const size_t base = out.size(); out.resize(base + (end.cnt - s0.cnt));
    std::vector<Err> perr(cps.size());
    pfor(cps.size(), WT, 1, [&](size_t k, int) {
      perr[k] = capture([&] {
        const size_t ce = k + 1 < cps.size() ? cps[k + 1].cnt : end.cnt;
        run(std::false_type(), cps[k], ce, &out[base + (cps[k].cnt - s0.cnt)], nullptr);
      });
    });
    for (auto& e : perr) if (e) e.raise();
  }
  if (raw.empty() || raw.back() != 255) throw ParseError("missing variable list terminator");
}

// array aliases
struct ArrayAliases {
  uint64_t physical_max_id, projected_base; Bytes flags;
  struct Entry { uint64_t begin, end, active, index_offset; uint8_t raw_flag; };
  std::vector<Entry> entries; std::vector<uint64_t> starts; uint64_t table_end;
};
ArrayAliases parse_array_aliases(const Raw& r, const Header& h) {
  uint64_t section = h.section;
  if (r.u(0x3b, 1) != 11) throw ParseError("array aliases: unsupported file configuration");
  if (r.u(0x372, 1)) throw ParseError("multiple array-alias table layout unsupported");
  uint64_t expected = r.u(2 * section + 0x180, 8);
  if (!expected || expected > DECL_LIMIT) throw ParseError("array-alias expansion flag count limit");
  uint64_t pointer = r.u(section + 0x140, 8);
  if (pointer < 4 * section) throw ParseError("invalid array-alias header pointer");
  ArrayAliases a; uint64_t cursor = pointer;
  while (a.flags.size() < expected) {
    uint64_t n = r.u(cursor, 4); cursor += 4;
    if (!n || n > (16u << 20)) throw ParseError("array-alias flag compressed block size");
    r.need(cursor, n); Bytes d = dec(r.b + cursor, n, {0, 0});
    if (d.empty() || d.size() > expected - a.flags.size()) throw ParseError("array-alias flag expansion size");
    a.flags.insert(a.flags.end(), d.begin(), d.end()); cursor += n;
  }
  for (auto x : a.flags) if (x > 1) throw ParseError("unknown array-alias expansion flag");
  std::vector<uint64_t> pre(a.flags.size() + 1, 0);
  for (size_t i = 0; i < a.flags.size(); i++) pre[i + 1] = pre[i] + a.flags[i];
  uint64_t count = r.u(cursor, 4); cursor += 4;
  if (!count || count > DECL_LIMIT) throw ParseError("array-alias record count limit");
  uint64_t prev_end = 0;
  for (uint64_t i = 0; i < count; i++) {
    uint64_t start = r.u(cursor, 8), span = r.u(cursor + 8, 4), active = r.u(cursor + 12, 4), co = r.u(cursor + 16, 8), flag = r.u(cursor + 24, 1), table_index = r.u(cursor + 25, 1);
    cursor += 26;
    if ((start >> 32) != 4 || table_index || flag > 1) throw ParseError("unsupported array alias namespace/flags");
    uint64_t low = start & 0xffffffffu;
    if (low != prev_end || !span || span > expected - low) throw ParseError("array-alias range bounds/order");
    uint64_t end = low + span;
    if (!a.flags[low] || active != pre[end] - pre[low]) throw ParseError("array-alias active count mismatch");
    a.entries.push_back({low, end, active, co, uint8_t(flag)}); a.starts.push_back(low);
    prev_end = end;
  }
  if (prev_end != expected) throw ParseError("array-alias ranges do not cover expansion flags");
  a.physical_max_id = h.max_id_low; a.projected_base = h.max_id_low + 1; a.table_end = cursor;
  return a;
}
uint64_t project_id(const ArrayAliases& a, uint64_t raw_id) {
  if (raw_id == 0) throw ParseError("invalid raw declaration ID");
  if (raw_id <= a.physical_max_id) return raw_id;
  if ((raw_id >> 32) != 4) throw ParseError("unsupported extended declaration namespace");
  uint64_t index = raw_id & 0xffffffffu;
  if (index >= a.flags.size()) throw ParseError("extended declaration ID outside expansion flags");
  if (!a.flags[index]) {
    auto it = std::upper_bound(a.starts.begin(), a.starts.end(), index);
    if (it == a.starts.begin() || index >= a.entries[size_t(it - a.starts.begin()) - 1].end) throw ParseError("missing extended declaration alias range");
    index = a.entries[size_t(it - a.starts.begin()) - 1].begin;
  }
  uint64_t resolved = (uint64_t(4) << 32) + index;
  if (resolved <= a.physical_max_id) return resolved;
  return a.projected_base + index;
}

bool project_plain_ids(const Raw& r, const Header& h, Decl& d) {
  bool needs = false;  // as the extended path: project only when some ID is beyond the ordinary ID range
  for (auto& s : d.sig) if (s.id > h.max_id_low) { needs = true; break; }
  for (auto& kv : d.plain_copies) for (auto x : kv.second) if (x > h.max_id_low) needs = true;
  if (!needs) return false;
  ArrayAliases al = parse_array_aliases(r, h);
  for (auto& s : d.sig) s.id = project_id(al, s.id);
  for (auto& kv : d.plain_copies) for (auto& x : kv.second) x = project_id(al, x);
  return true;
}

std::unordered_map<uint64_t, uint64_t> parse_plain_aliases(const Raw& r, const Header& h) {
  uint64_t section = h.section;
  if (r.u(0x3b, 1) != 11) throw ParseError("ordinary aliases: unsupported file configuration");
  uint64_t p = r.u(section + 0xe8, 8);
  std::unordered_map<uint64_t, uint64_t> al;
  if (!p) return al;
  if (p < 4 * section) throw ParseError("ordinary alias header pointer");
  if (r.u(p, 4) != 0) throw ParseError("ordinary alias version");
  uint64_t count = r.u(p + 4, 4); p += 8;
  if (count > DECL_LIMIT) throw ParseError("ordinary alias count limit");
  bool extended = r.u(0x100, 1) == 1; uint64_t total = 0;
  std::vector<uint64_t> order;
  for (;;) {
    uint64_t length = r.u(p, 4); p += 4;
    if (!length) break;
    if (length > (16u << 20)) throw ParseError("ordinary alias compressed size limit");
    r.need(p, length); Bytes raw = dec(r.b + p, length, {0, 0}, 16u << 20); p += length;
    size_t q = 0; uint64_t mask = 0, local = 0;
    auto read_id = [&](unsigned code) -> uint64_t {
      if (code == 3) throw ParseError("ordinary alias unknown ID width");
      unsigned n = code == 0 ? (extended ? 8 : 4) : code == 1 ? 2 : 4;
      if (q + n > raw.size()) throw ParseError("truncated ordinary alias ID");
      uint64_t v = le(raw.data() + q, n); q += n;
      if (!v) throw ParseError("ordinary alias zero ID");
      return v;
    };
    while (q < raw.size()) {
      if (total >= count) throw ParseError("ordinary alias excess records");
      if (local % 2 == 0) { mask = raw[q]; q += 1; }
      unsigned shift = 4 * (local % 2);
      uint64_t slave = read_id((mask >> shift) & 3), master = read_id((mask >> (shift + 2)) & 3);
      if (al.count(slave)) throw ParseError("ordinary alias duplicate ID");
      if (slave == master) throw ParseError("ordinary alias self cycle");
      al[slave] = master; order.push_back(slave); local++; total++;
    }
    if (q != raw.size()) throw ParseError("ordinary alias trailing bytes");
  }
  if (total != count) throw ParseError("ordinary alias count mismatch");
  // resolve_alias over every identifier: any cycle rejects (iterative colouring, same verdict as the index walk)
  std::unordered_map<uint64_t, uint8_t> state;  // 1 visiting, 2 done
  for (uint64_t id : order) {
    std::vector<uint64_t> path; uint64_t x = id;
    while (al.count(x)) {
      auto& s = state[x];
      if (s == 2) break;
      if (s == 1) throw ParseError("ordinary alias cycle");
      s = 1; path.push_back(x); x = al[x];
    }
    for (auto y : path) state[y] = 2;
  }
  return al;
}
uint64_t resolve_alias(const std::unordered_map<uint64_t, uint64_t>& al, uint64_t id) {
  if (id == 0) throw ParseError("invalid ordinary alias ID");
  size_t steps = 0;
  for (auto it = al.find(id); it != al.end(); it = al.find(id)) { id = it->second; if (++steps > al.size()) throw ParseError("ordinary alias cycle"); }
  return id;
}

// A later tree directory (k > 0) is self-delimiting: its blocks and its ID count are in the directory sequence, it names its
// first value ID explicitly, and its scope stack and link grammar start empty. So when its scope stream or variable block holds
// a record kind this parser does not read (skippable_dir_reason: three named reasons), the directory can be left out on its own
// (skip_dirs = allow-partial): its scope records are rolled back, its blocks and ID count still count, and every value-carrying
// ID that no other declaration references is listed by ID. A link from another directory into it, or a variable of another
// directory left without a scope, still refuses the file (the checks below). Directory 0, damage (block decode, layout,
// truncation) and any other reason still refuse the whole file.
// TEST-ONLY plant (FPLAN_TEST_PLANT_DIR=<k>): the first record tag of directory k's decoded variable block becomes 0x7e, a kind
// no parser reads (directory 0: the byte after its leading 0xbf). The shipped planner is built without the hook.
static void plant_var_block(Bytes& raw, size_t k) {
  const char* p = FPLAN_TEST_ENV("FPLAN_TEST_PLANT_DIR");
  if (!p || std::strtoull(p, nullptr, 10) != k || raw.empty()) return;
  size_t at = (k == 0 && raw[0] == 0xbf) ? 1 : 0; if (at < raw.size()) raw[at] = 0x7e;
}
// TEST-ONLY (FPLAN_TEST_DIRMSG=<k>:<message>): directory k's read fails with that parse message, so every reason the
// classifier below sees can be tried on a real dump. The shipped planner is built without the hook.
static void plant_dir_msg(size_t k) {
  const char* p = FPLAN_TEST_ENV("FPLAN_TEST_DIRMSG"); const char* c = p ? std::strchr(p, ':') : nullptr;
  if (c && std::strtoull(p, nullptr, 10) == k) throw ParseError(std::string(c + 1));
}
// the reasons that name a record kind this parser does not read (a scope record tag, a field-definition scope kind, a variable
// record tag). Every other reason (flags, links, attributes, damage) refuses the whole file.
static bool skippable_dir_reason(const std::string& m) {
  static const char* const kinds[] = {"unsupported scope tag ", "unsupported field-def scope kind ", "unsupported extended variable tag "};
  for (const char* q : kinds) if (m.compare(0, std::strlen(q), q) == 0) return true;
  return false;
}
void native_vars_ext(const Raw& r, const Header& h, const FieldMap& fields, const DefMap& defs, Decl& d, bool skip_dirs = false) {
  const bool dt_unset_mut = FPLAN_TEST_ENV("FPLAN_TEST_DT_DAMAGE") && std::string(FPLAN_TEST_ENV("FPLAN_TEST_DT_DAMAGE")) == "unset";  // test-only: no var datatype resolved
  if (r.u(0x28, 4) != 89 || r.u(0x3b, 1) != 11) throw ParseError("extended metadata: unsupported file version or configuration");
  // every directory of the tree-directory sequence is one (scope, variable) fragment of the same grammar. Directory 0
  // is read as before. A later directory: its scope stream may root package definitions and ends with one empty
  // link byte when it has no prev link; its variable block (at most one, 64 KiB) has no leading 0xbf byte, names its first value ID
  // explicitly, and is addressed by the scope links as (variable-block ordinal << 16) + offset, counting every earlier
  // variable block of the sequence. A low value ID may not be used before the directory that introduces it (running sum of
  // the directory words). Any mismatch refuses the whole file.
  std::vector<TreeDirSeq> sequence = tree_dir_seq(r, h.section);
  // TEST-ONLY red mutants (FPLAN_TEST_TREEDIRS): "first" = directory 0 only (the single-directory reader); "noshift" = no 64 KiB
  // variable-block rebase; "idplus" = every value ID of a later directory one too high; "idminus" = every low (non-array) one one too low
  const char* cm = FPLAN_TEST_ENV("FPLAN_TEST_TREEDIRS");
  const int treedirs_mut = !cm ? 0 : !strcmp(cm, "first") ? 1 : !strcmp(cm, "noshift") ? 2 : !strcmp(cm, "idplus") ? 3 : !strcmp(cm, "idminus") ? 4 : 0;
  if (treedirs_mut == 1) sequence.resize(1);
  const bool multi_dir = sequence.size() > 1;
  std::vector<ExtScope> srecs; std::unordered_map<uint64_t, uint32_t> links;
  std::vector<std::vector<VarRec>> frags; uint64_t vblocks = 0, intro = 0; size_t nrows = 0;
  std::unordered_set<uint32_t> seqdir_pkg_recs;  // scope records rooted on a package definition by a later directory
  WalkTrace wt; wt.start();
  for (size_t k = 0; k < sequence.size(); k++) {
    const TreeDir& g = sequence[k].g;
    // datatype blocks: decoded by decode_datatypes. A var record that names a datatype (bit 7) is carried when it names a
    // decoded enum of its width, else refused by name (DTYPE_SKIP + why); a directory whose vars name a datatype but that
    // has no datatype block refuses the whole file (below)
    const bool dt_blocks = !g.g[2].empty() && !fc_arm("dtnone");
    Bytes dtx;  // the datatype block, decoded before the scope and variable blocks so a block this planner cannot read is named
    if (dt_blocks) {
      // a directory whose datatype group is filled but whose scope group is empty is not a layout this planner reads
      if (g.g[0].empty() || fc_arm("dtnoscope")) throw ParseError("tree directory with a datatype block has no scope block");
      try { if (fc_arm("dtdec")) throw ParseError("planted"); dtx = join_decode(r, g.g[2]); }
      catch (const std::exception& e) { throw ParseError(std::string("extended datatype block not decoded: ") + e.what()); }
    }
    std::unordered_map<uint64_t, uint32_t> fl; size_t s0 = srecs.size();
    // a later directory with no scope, variable or datatype block declares nothing (its ID count still counts below)
    const bool empty_dir = k > 0 && g.g[0].empty() && g.g[1].empty() && g.g[2].empty();
    std::vector<VarRec> rows;
    // variable blocks of directory k -> rows: one path for the full read and for the by-directory skip branch (--allow-partial),
    // so the multi-block, size and datatype checks are the same on both
    auto read_var_blocks = [&]() {
      if (multi_dir) {
        // a later directory may hold several variable blocks (full-chip dumps: the module tree is directory 1); every block but
        // the last is 64 KiB, so (ordinal << 16) + offset addresses the joined blocks
        for (size_t b = 0; b + 1 < g.g[1].size(); b++)
          if (dec(r.b + g.g[1][b].off, g.g[1][b].size, {1, 1}).size() != 65536) throw ParseError("later tree directory: variable block not 64 KiB");
      }
      Bytes raw = join_decode(r, g.g[1]); plant_var_block(raw, k);
      if (fc_arm("vtrunc") && k > 0 && raw.size() > 5) raw.resize(raw.size() - 5);
      if (k > 0 && raw.size() > (uint64_t(g.g[1].size()) << 16)) throw ParseError("later tree directory: variable blocks over 64 KiB each");
      ext_records(raw, r.u(0x100, 1) == 1, rows, k == 0);
      for (auto& v : rows) if (v.dtype >= 0 && !dt_blocks) throw ParseError("var names an extended datatype but the tree directory has no datatype block");
      if (dt_blocks) {  // an enum (kind byte 0x08, then its 2-byte type number): the var is carried as its stored bit value (enum labels not carried)
        Bytes x = std::move(dtx);
        if (fc_arm("dtkind") && !x.empty()) x[0] ^= 0x01;
        if (fc_arm("dtidx") && x.size() >= 3) x[1] ^= 0x01;
        if (fc_arm("dttrunc")) x.resize(std::min<size_t>(x.size(), 2));
        const DtTable dt = decode_datatypes(std::move(x));
        const bool ref_mut = FPLAN_TEST_ENV("FPLAN_TEST_DT_DAMAGE") && std::string(FPLAN_TEST_ENV("FPLAN_TEST_DT_DAMAGE")) == "ref";
        for (auto& v : rows) {
          if (v.dtype < 0) continue;
          if (ref_mut) v.dtype ^= 1;  // test-only: the var names a type number the block does not hold
          auto it = dt.types.find(uint64_t(v.dtype)); std::string why;
          if (it == dt.types.end()) why = dt.rest.empty() ? "type number " + u2s(uint64_t(v.dtype)) + " not in the datatype block" : dt.rest;
          else if (!it->second.why.empty()) why = it->second.why;
          else if (it->second.bits != uint64_t(v.bits)) why = "enum width " + u2s(it->second.bits) + " differs from the var width " + u2s(uint64_t(v.bits));
          if (why.empty()) { v.dt_st = 0; continue; }
          d.dtype_why.push_back(std::string(DTYPE_SKIP) + " (" + why + ")"); v.dt_st = int32_t(d.dtype_why.size());
        }
      }
      if (treedirs_mut != 2) for (auto& v : rows) v.off += vblocks << 16;
      if ((treedirs_mut == 3 || treedirs_mut == 4) && k > 0)
        for (auto& v : rows) if ((v.tag == 4 || v.tag == 0xd5 || v.tag == 0xd8) && (treedirs_mut == 3 || (v.id > 0 && v.id <= h.max_id_low))) v.id += treedirs_mut == 3 ? 1 : uint64_t(-1);
    };
    if (skip_dirs && k > 0 && !empty_dir) {  // the same steps as below, with a by-directory refusal for an unread record kind
      ScopeTab::Mark mk = d.scopes.mark();
      Bytes sraw = join_decode(r, g.g[0]);
      Err e = capture([&] { plant_dir_msg(k); parse_scope_stream(sraw, defs, d.scopes, srecs, fl, true); });
      if (!g.g[1].empty() && !e) e = capture([&] { read_var_blocks(); });
      if (e && !(e.kind == 1 && skippable_dir_reason(e.msg))) e.raise();
      if (e) {
        d.scopes.rollback(mk); srecs.resize(s0); fl.clear(); rows.clear();
        d.skipped_dirs.push_back({k, e.msg, intro, intro + sequence[k].new_ids});
      } else {
        for (size_t q = s0; q < srecs.size(); q++)
          if (srecs[q].def >= 0 && defs.at(uint64_t(srecs[q].def)).kind == 1) seqdir_pkg_recs.insert(uint32_t(q));
      }
      vblocks += g.g[1].size();
    } else {
    wt.add("dir_pre");
    if (empty_dir) d.empty_dir = true; else { Bytes sraw = join_decode(r, g.g[0]); wt.add("dir_scope_decode"); parse_scope_stream(sraw, defs, d.scopes, srecs, fl, k > 0); }
    wt.add("dir_scopes");
    for (size_t q = s0; q < srecs.size(); q++)
      if (srecs[q].def >= 0 && defs.at(uint64_t(srecs[q].def)).kind == 1) seqdir_pkg_recs.insert(uint32_t(q));
    if (!g.g[1].empty()) {
      read_var_blocks();
      vblocks += g.g[1].size();
    }
    wt.add("dir_vars");
    }
    if (multi_dir) {
      if (sequence[k].new_ids > (uint64_t(1) << 40) || intro + sequence[k].new_ids < intro) throw ParseError("tree directory ID count");
      intro += sequence[k].new_ids;
      for (auto& v : rows)
        if ((v.tag == 4 || v.tag == 0xd5 || v.tag == 0xd8) && v.id <= h.max_id_low && v.id >= intro)
          throw ParseError("tree directory " + u2s(k) + " uses value ID " + u2s(v.id) + " before it is introduced (" + u2s(intro) + ")");
    }
    if (links.empty()) links.swap(fl);  // first directory: its keys are already unique
    else for (auto& kv : fl) { if (links.count(kv.first)) throw ParseError("duplicate scope variable link"); links[kv.first] = kv.second; }
    nrows += rows.size(); frags.push_back(std::move(rows));
  }
  wt.add("dir_vars_tail");
  // resolve_records
  struct Item { int64_t bits, left, right, fid; std::string name; uint32_t scope_rec; bool listed; uint64_t id; uint32_t dir = 0; int32_t dtype = -1; const char* why = nullptr; uint8_t ctag = 0; uint64_t big = 0; int64_t bigk = -1; };
  // (records become declarations directly, per chunk below)
  const uint64_t fbound = frow_bound();
  // Records resolve in parallel chunks (walk_threads()). Per record the scope is the last scope link at or before it in its
  // fragment: link hits are looked up in parallel, the scope prefix runs serially, then each chunk builds its items. The
  // chunks are joined in record order; the first error in record order is raised; a row over the bound is refused once per
  // (scope record, row), the first in record order.
  bool needs = false;
  for (auto& rows : frags) for (auto& v : rows) if (v.id > h.max_id_low) { needs = true; break; }
  ArrayAliases al; if (needs) al = parse_array_aliases(r, h);
  wt.add("aliases");
  d.sig.reserve(d.sig.size() + nrows);
  const int WT = walk_threads(); uint64_t nhit = 0; uint32_t fragno = 0;
  std::set<std::pair<int64_t, int64_t>> big_seen;  // (scope record, field-def row) already refused as over the row bound
  for (auto& rows : frags) {
  const uint32_t dirno = fragno++; const size_t nr = rows.size();
  std::vector<int64_t> sc(nr, -1);
  pfor(nr, WT, 4096, [&](size_t i, int) { auto it = links.find(rows[i].off); if (it != links.end()) sc[i] = int64_t(it->second); });
  { int64_t cur = -1; for (size_t i = 0; i < nr; i++) { if (sc[i] >= 0) { cur = sc[i]; nhit++; } else sc[i] = cur; } }
  const size_t CH = 65536, nch = (nr + CH - 1) / CH;
  struct Part { size_t n = 0; std::vector<CarrierRow> car; std::vector<std::array<int64_t, 3>> big; /* (index in sig, scope record, row) */ uint64_t not_listed = 0, n_tree = 0; };
  std::vector<Part> part(nch); std::vector<Err> perr(nch);
  const size_t base = d.sig.size(); d.sig.resize(base + nr);  // chunk ci writes from base + ci * CH; compacted in order below
  pfor(nch, WT, 1, [&](size_t ci, int) {
    std::unordered_map<uint64_t, std::vector<uint64_t>> expanded;  // definition -> prefix counts
    Part& P = part[ci]; const size_t e0 = ci * CH, e1 = std::min(nr, e0 + CH); Sig* const out = &d.sig[base + e0];
    // item -> declaration (or a not-listed carrier row), in record order
    auto emit = [&](Item&& it) {
      if (!it.listed) { P.not_listed++;
        if (carrier_rows) P.car.push_back({it.id, needs ? project_id(al, it.id) : it.id, it.bits, it.left, it.right, it.fid, it.dir, d.scopes.full(d.scopes.rnid[it.scope_rec]), it.name});
        return; }
      Sig s; s.id = it.why ? 0 : needs ? project_id(al, it.id) : it.id; s.dir = it.dir; s.dtype = it.dtype; s.why = it.why; s.pkg = it.why != nullptr;
      s.bits = it.bits; s.left = it.left; s.right = it.right; s.field_id = it.fid; s.scope = d.scopes.rnid[it.scope_rec]; s.ctag = it.ctag;
      if (it.big) { s.big = it.big; s.pkg = true; s.id = 0; }  // declared with no value ID, refused (big_reason)
      s.name = std::move(it.name);
      if (s.bits > 1) s.name += "[" + i2s(s.left) + ":" + i2s(s.right) + "]";
      if (it.bigk >= 0) P.big.push_back({int64_t(P.n), int64_t(it.scope_rec), it.bigk});  // counted once kept (below)
      else if (s.field_id != CLASS_FID && !under_class_root(d, s)) P.n_tree++;
      out[P.n++] = std::move(s);
    };
    perr[ci] = capture([&] {
    for (size_t ri = e0; ri < e1; ri++) {
    VarRec& v = rows[ri]; const int64_t scope = sc[ri];
    if (scope < 0) throw ParseError("extended variable before scope link");
    Item item; item.scope_rec = uint32_t(scope); item.id = v.id; item.dir = dirno;
      if (v.tag == 0x36 || v.tag == 0x38 || v.tag == 0x3e) {  // assertion records: declared by name, refused (ASSERT_SKIP)
        item.fid = -1; item.bits = 0; item.left = 0; item.right = 0; item.listed = true; item.name = std::move(v.name); item.why = ASSERT_SKIP;
        emit(std::move(item)); continue;
      }
      if (v.tag == 0x3f || v.tag == 0xda || v.tag == 0xd9) {  // class-object records: declared by name, refused (CLASS_SKIP)
        item.fid = CLASS_FID; item.bits = 0; item.left = 0; item.right = 0; item.listed = true; item.ctag = v.tag;
        if (v.tag == 0xd9) {
          auto f = fields.find(v.fid);
          item.name = (f != fields.end() && v.row >= 0 && uint64_t(v.row) < f->second.members.size()) ? f->second.members[size_t(v.row)] : "member#" + i2s(v.row);
        } else item.name = std::move(v.name);
        emit(std::move(item)); continue;
      }
      if (v.tag == 0xd5) {
        int64_t did = srecs[size_t(scope)].def;
        if (did < 0 || !defs.count(uint64_t(did))) throw ParseError("field-def variable outside field-def scope");
        const FieldDef& D = defs.at(uint64_t(did));
        auto ex = expanded.find(uint64_t(did));
        if (ex == expanded.end()) {  // per-thread cache: the same prefix counts on every thread
          std::vector<uint64_t> pre(1, 0);
          for (auto& e : D.rows) pre.push_back(pre.back() + frow_count(fields, e.fid, e.f0, e.f1, 0, FROW_COUNT_ONLY));
          ex = expanded.emplace(uint64_t(did), std::move(pre)).first;
        }
        const auto& pre = ex->second; uint64_t total = pre.back();
        if (v.row < 0 || uint64_t(v.row) >= total) throw ParseError("field-def row " + i2s(v.row) + " outside expanded definition " + i2s(did) + " (" + u2s(total) + " rows)");
        size_t k = size_t(std::upper_bound(pre.begin(), pre.end(), uint64_t(v.row)) - pre.begin()) - 1;
        const FieldRow& e = D.rows[k];
        if (const uint64_t ck = pre[k + 1] - pre[k]; frow_over(ck, fbound)) {  // one row over the bound: refused once by name, its elements not read
          item.bigk = int64_t(k);  // refused once per (scope record, row): duplicates dropped in record order below
          item.name = e.name; item.fid = -1; item.bits = 0; item.left = 0; item.right = 0; item.listed = true; item.big = ck;
          emit(std::move(item)); continue;
        }
        FRow fr = frow_at(fields, e.name, e.fid, e.f0, e.f1, 0, uint64_t(v.row) - pre[k]);
        item.name = std::move(fr.name); item.fid = fr.fid; item.bits = fr.bits; item.left = fr.left; item.right = fr.right; item.listed = true;
      } else if (v.tag == 0xd8) {
        const uint64_t ck = frow_count(fields, v.fid, v.f0, v.f1, 0, FROW_COUNT_ONLY);
        if (frow_over(ck, fbound)) {  // over the bound: refused by name
          item.name = std::move(v.name); item.fid = -1; item.bits = 0; item.left = 0; item.right = 0; item.listed = true; item.big = ck;
          emit(std::move(item)); continue;
        }
        // a field-typed variable record carries ONE value ID, so a type that expands to several rows (an unpacked array or
        // struct) cannot be read as one signal at its first row's width: declared by name, refused (TEST-ONLY mutant
        // FPLAN_TEST_D8_MULTI_CARRY: the old reading, one signal at row 0)
        if (ck != 1 && !FPLAN_TEST_ENV("FPLAN_TEST_D8_MULTI_CARRY")) {
          item.name = std::move(v.name); item.fid = -1; item.bits = 0; item.left = 0; item.right = 0; item.listed = true; item.why = D8_MULTI;
          emit(std::move(item)); continue;
        }
        FRow fr = frow_at(fields, v.name, v.fid, v.f0, v.f1, 0, 0);
        item.name = std::move(v.name); item.fid = int64_t(v.fid); item.bits = fr.bits; item.left = fr.left; item.right = fr.right; item.listed = true;
      } else {
        item.name = std::move(v.name); item.fid = -1; item.bits = v.bits; item.left = v.left; item.right = v.right;
        item.listed = !((v.extra < 0 ? 0 : v.extra) & 4); item.dtype = v.dtype < 0 ? -1 : v.dt_st >= 0 && !dt_unset_mut ? v.dt_st : -3;  // -3: never resolved -> refused
      }
      emit(std::move(item));
    }
    });
  });
  for (size_t ci = 0; ci < nch; ci++) if (perr[ci]) perr[ci].raise();
  // a row over the bound is declared once per (scope record, row): the first in record order; later copies dropped
  std::vector<std::vector<uint8_t>> drop(nch);
  for (size_t ci = 0; ci < nch; ci++) for (auto& b3 : part[ci].big) {
    const size_t k = size_t(b3[0]); const Sig& g = d.sig[base + ci * CH + k];
    if (!big_seen.insert({b3[1], b3[2]}).second) { if (drop[ci].empty()) drop[ci].assign(part[ci].n, 0); drop[ci][k] = 1; }
    else if (g.field_id != CLASS_FID && !under_class_root(d, g)) part[ci].n_tree++; }
  size_t o = base;  // compact in record order (left to right: a target never passes its source)
  for (size_t ci = 0; ci < nch; ci++) { Sig* src = &d.sig[base + ci * CH];
    for (size_t k = 0; k < part[ci].n; k++) if (drop[ci].empty() || !drop[ci][k]) { if (o != base + ci * CH + k) d.sig[o] = std::move(src[k]); o++; } }
  d.sig.resize(o);
  for (auto& P : part) { d.not_listed += P.not_listed; d.n_tree += P.n_tree; if (carrier_rows) for (auto& c : P.car) carrier_rows->push_back(std::move(c)); }
  }
  if (nhit != links.size()) throw ParseError("scope variable link did not point at record boundary");
  std::vector<std::vector<VarRec>>().swap(frags);
  wt.add("resolve_build");
  // Package scopes (UVM benches with packages dumped): each package is a package field definition in the field stream. Its rows
  // (and the rows of its function/task children) become root-level "<pkg>.<name>" declarations. Their value IDs are not
  // linked yet, so each is a per-name refusal (PKG_SKIP), never a value. A row whose type does not expand is left out.
  {
    const char* pm = FPLAN_TEST_ENV("FPLAN_TEST_PKG_MUT"); const int pkg_mut = !pm ? 0 : !strcmp(pm, "width") ? 1 : !strcmp(pm, "drop") ? 2 : 0;
    std::vector<uint64_t> pk; for (auto& kv : defs) if (kv.second.kind == 1) pk.push_back(kv.first);
    std::sort(pk.begin(), pk.end());
    std::unordered_map<std::string, std::vector<uint64_t>> sub;  // function/task definitions by name (children resolve only if unique)
    for (auto& kv : defs) if (kv.second.kind == 5 || kv.second.kind == 6 || kv.second.kind == 7) sub[kv.second.definition].push_back(kv.first);
    // a package rooted by a multi_dir tree directory is declared there, with its own value IDs: its field-def rows are not emitted again
    std::unordered_set<uint64_t> seqdir_pkg;
    for (uint32_t q : seqdir_pkg_recs) seqdir_pkg.insert(uint64_t(srecs[q].def));
    auto add_rows = [&](const FieldDef& D, uint32_t rec, bool later_dir_pkg) {
      if (later_dir_pkg) return;
      for (auto& e : D.rows) {
        uint64_t c = 0; Err er = capture([&] { c = frow_count(fields, e.fid, e.f0, e.f1, 0, FROW_COUNT_ONLY); });
        if (er) continue;
        if (frow_over(c, fbound)) {  // a package row over the row bound: declared once by name, refused with its element count
          Sig s; s.id = 0; s.bits = 0; s.left = 0; s.right = 0; s.field_id = -1; s.scope = d.scopes.rnid[rec]; s.pkg = true; s.big = c;
          s.name = e.name; d.sig.push_back(std::move(s)); continue;
        }
        for (uint64_t j = 0; j < c; j++) {
          FRow fr; Err e2 = capture([&] { fr = frow_at(fields, e.name, e.fid, e.f0, e.f1, 0, j); });
          if (e2) continue;
          if (pkg_mut == 1 && fr.bits > 1) { fr.bits++; fr.left++; }  // TEST-ONLY mutant (FPLAN_TEST_PKG_MUT=width): package row width off by one
          Sig s; s.id = 0; s.bits = fr.bits; s.left = fr.left; s.right = fr.right; s.field_id = fr.fid; s.scope = d.scopes.rnid[rec]; s.pkg = true;
          s.name = std::move(fr.name);
          if (s.bits > 1) s.name += "[" + i2s(s.left) + ":" + i2s(s.right) + "]";
          d.sig.push_back(std::move(s));
        }
      }
    };
    for (uint64_t f : pk) {
      const FieldDef& P = defs.at(f);
      if (pkg_mut == 2) break;  // TEST-ONLY mutant (FPLAN_TEST_PKG_MUT=drop): package scopes not declared
      if (P.rows.empty() && P.children.empty()) continue;
      const bool pch = seqdir_pkg.count(f) != 0;
      uint32_t rec = d.scopes.add(-1, P.definition);
      add_rows(P, rec, pch);
      for (auto& ch : P.children) {
        auto it = sub.find(ch);
        if (it == sub.end() || it->second.size() != 1) continue;
        const FieldDef& C = defs.at(it->second[0]);
        if (C.rows.empty()) continue;
        add_rows(C, d.scopes.add(int32_t(rec), ch), pch);
      }
    }
  }
  wt.add("sig_build_pkg");
  d.fdefs = true;
  d.plain = parse_plain_aliases(r, h);
  wt.add("plain_aliases"); wt.print(sequence.size());
}

Decl native_vars(const Raw& r, bool skip_dirs) {
  Header h = read_header(r);
  if (r.b[0x3b] != 11) throw ParseError("unsupported file configuration");
  FieldMap fields; DefMap defs;
  parse_fields(read_field_stream(r), fields, defs);
  Decl d;
  for (auto& kv : fields) if (kv.second.tag == 0x19 || kv.second.tag == 0 || kv.second.tag == 2) d.class_fids.insert(kv.first);
  if (!defs.empty()) native_vars_ext(r, h, fields, defs, d, skip_dirs);
  else native_vars_plain(r, h, fields, d);
  return d;
}

// ---------------------------------------------------------------- index
struct Period { uint64_t begin, end; };
struct BlockDesc { uint64_t offset; uint32_t size; uint32_t period; };
enum : uint8_t { K_SCALAR = 0, K_BUSINLINE = 1, K_BUS = 2, K_ZERO = 3, K_TOPO = 4 };
struct Rec {
  uint8_t kind; bool has_derived; uint32_t period;
  uint64_t previous, count, index_block, off, bus_block, begin, end, derived;
};
struct Locator {
  Raw r; std::vector<Period> periods; std::vector<BlockDesc> bus, index_blk;
  std::vector<uint64_t> latest;  // index = native ID (1..entries-1); [0] unused
  std::unordered_set<uint64_t> flagged;  // native IDs whose start-time summary flags are not decoded: per-name refusals (FLAGS_SKIP); also a port-link guard input
  // index metadata cap (a bound, not an allocation): at 32 B per native ID, 2 GiB fits tens of millions of IDs
  int64_t budget = int64_t(2) << 30, reserved = 0; uint64_t index_limit = 0, max_records = DECL_LIMIT;
  std::vector<Bytes> cdec; std::vector<Err> cerr;
  bool has_latest(uint64_t id) const { return id >= 1 && id < latest.size(); }
  bool carry_doff = false;  // Options::dump_off: entry 0's record reference (the dump-off stream) is read, not refused
  uint64_t doff_head = 0;   // that reference (0 = the dump was never switched off)
};
void loc_init(Locator& nv, const Raw& r, const Header& head) {
  nv.r = r;
  const uint64_t max_output = MB2, cache_bytes = 8u << 20;
  if (r.u(0x28, 4) != 89 || r.u(0x3b, 1) != 11 || head.bsh != 65536) throw ParseError("index: unsupported version/configuration/block size");
  if (r.u(0x8c4, 1) != 1) throw ParseError("index: only 64-bit start-time entries supported");
  uint64_t n = r.u(0x898, 4);
  if (!(1 <= n && n <= nv.max_records)) throw ParseError("index: unreasonable period count");
  uint64_t p = r.u(0x408, 8), period_offset = p;
  uint64_t dictionary_offset = r.u(0x478, 8), directory_end = dictionary_offset ? dictionary_offset : r.n;
  if (!(4096 <= p && p <= directory_end && directory_end <= r.n) || 26 * n > directory_end - p) throw ParseError("index: period directory physical bound");
  int64_t physical_limit = int64_t((directory_end - p - 26 * n) / 12);
  int64_t max_blocks = std::min<int64_t>(physical_limit, int64_t(0xffffffffu));
  nv.reserved = int64_t(4096 + 2048 * n + cache_bytes + 8 * max_output);
  if (nv.reserved > nv.budget) throw ParseError("index: metadata memory budget");
  auto take = [&](unsigned k) -> uint64_t {
    if (p + k > directory_end) throw ParseError("index: truncated period directory");
    uint64_t v = r.u(p, k); p += k; return v;
  };
  auto time = [&]() -> uint64_t { uint64_t hi = take(4); return (hi << 32) | take(4); };
  nv.periods.reserve(n);
  for (uint64_t i = 0; i < n; i++) {
    if (take(1) != 0x0f) throw ParseError("index: extended/unknown period marker");
    uint64_t begin = time(), end = time(), flags = take(1), first = take(4);
    if (begin > end || flags != 0 || first != nv.bus.size()) throw ParseError("index: unsupported period flags or block numbering");
    for (int kind = 0; kind < 2; kind++) {
      uint64_t count = take(2);
      if (int64_t(count) > max_blocks - int64_t(nv.bus.size()) - int64_t(nv.index_blk.size())) throw ParseError("index: physical block count limit");
      if (count * 12 > directory_end - p) throw ParseError("index: truncated block directory");
      auto& dst = kind == 0 ? nv.bus : nv.index_blk;
      for (uint64_t j = 0; j < count; j++) {
        uint64_t bo = take(8), size = take(4); r.need(bo, size);
        if (!size || bo < 4096 || bo + size > period_offset) throw ParseError("index: bad physical block extent");
        dst.push_back({bo, uint32_t(size), uint32_t(i)});
      }
    }
    nv.periods.push_back({begin, end});
  }
  if (dictionary_offset && p > dictionary_offset) throw ParseError("index: period directory overlaps timestamp dictionary");
  // _start_time
  uint64_t o = r.u(0x410, 8), relative = r.u(o, 8), footer = o + relative; r.need(footer, 8);
  if (relative < 8) throw ParseError("index: invalid start-time footer");
  uint64_t count = r.u(footer, 4), capacity = r.u(footer + 4, 4);
  if (!(1 <= count && count <= nv.max_records) || !capacity || capacity % 9) throw ParseError("index: invalid start-time block layout");
  uint64_t entries = r.u(0x8a4, 4) + 1;
  // charge what the start-time table holds per native ID: 8 B in latest + 9 B decoded (+ slack), so a full-chip dump
  // with a few hundred thousand IDs fits; entries is bounded by max_records below either way
  const int64_t per_id = 32;
  if (fc_arm("idcap")) nv.budget = nv.reserved + per_id * int64_t(entries) - 1;  // red: one byte short of the new cap
  if (per_id * int64_t(entries) > nv.budget - nv.reserved) throw ParseError("index: native-ID metadata memory budget");
  nv.reserved += per_id * int64_t(entries);
  uint64_t per = capacity / 9;
  if (entries > nv.max_records || count != (entries + per - 1) / per) throw ParseError("index: start-time entry count mismatch");
  r.need(footer + 8, count * 4); p = o + 8; Bytes decoded; decoded.reserve(entries * 9);
  for (uint64_t i = 0; i < count; i++) {
    uint64_t length = r.u(p, 4); p += 4;
    if (length != r.u(footer + 8 + i * 4, 4) || p + length > footer) throw ParseError("index: start-time physical block mismatch");
    r.need(p, length); Bytes raw = dec(r.b + p, length, {0, 0}, max_output);
    uint64_t want = std::min<uint64_t>(capacity, entries * 9 - decoded.size());
    if (raw.size() != want) throw ParseError("index: start-time decoded size mismatch");
    decoded.insert(decoded.end(), raw.begin(), raw.end()); p += length;
  }
  if (p != footer || decoded.size() != entries * 9) throw ParseError("index: start-time framing mismatch");
  nv.latest.assign(entries, 0);
  for (uint64_t i = 0; i < entries; i++) {
    uint64_t logical = le(decoded.data() + i * 9, 8); uint8_t flags = decoded[i * 9 + 8];
    if (i == 0) {  // zero in every file without a dump-off; a dump switched off during the run sets it to a record reference
      if (logical && !flags && (logical >> 16) < nv.index_blk.size()) { if (!nv.carry_doff) throw ParseError(DUMP_OFF_REASON); nv.doff_head = logical; }
      else if (logical || flags) throw ParseError("index: invalid null native-ID entry");
    }
    else if (flags & ~3) nv.flagged.insert(i);  // fail closed per ID (FLAGS_SKIP), not per file
    else nv.latest[i] = logical;
  }
  nv.index_limit = std::min<uint64_t>(nv.max_records, uint64_t(std::max<int64_t>(0, (nv.budget - nv.reserved) / 2048)));
}
void loc_decode_index(Locator& nv, int T, bool willneed) {
  size_t n = nv.index_blk.size(); nv.cdec.assign(n, Bytes()); nv.cerr.assign(n, Err());
  // Options::index_willneed: ask the kernel for every index block's range up front, so a cold open reads only them, at
  // queue depth, instead of a page-fault read-ahead per decoding thread that also pulls the data next to each block.
  // Advice only; no result changes.
  if (willneed) {
    const uintptr_t pg = 4096, base = uintptr_t(nv.r.b);
    for (size_t i = 0; i < n; i++) { const BlockDesc& b = nv.index_blk[i]; if (b.offset >= nv.r.n) continue;
      uintptr_t a0 = (base + b.offset) & ~(pg - 1), a1 = base + std::min<uint64_t>(nv.r.n, b.offset + b.size);
      madvise((void*)a0, a1 - a0, MADV_WILLNEED); }
  }
  pfor(n, T, 4, [&](size_t i, int) {
    const BlockDesc& b = nv.index_blk[i];
    if (b.size > MB2) { nv.cerr[i] = {1, "index: encoded block workspace limit"}; return; }
    try { nv.cdec[i] = dec(nv.r.b + b.offset, b.size, {1, 1}, MB2); }
    catch (...) { nv.cerr[i] = {2, "native index codec rejected block"}; return; }
    if (nv.cdec[i].empty() || nv.cdec[i].size() > MB2) nv.cerr[i] = {1, "index: decoded block workspace limit"};
  });
}
inline void record(const Locator& nv, uint64_t logical, bool topo, Rec& rc) {
  uint64_t index = logical >> 16, off = logical & 0xffff;
  if (index >= nv.index_blk.size()) throw ParseError("index: logical index block number");
  if (nv.cerr[index]) nv.cerr[index].raise();
  const Bytes& raw = nv.cdec[index]; const uint8_t* b = raw.data(); size_t n = raw.size(); size_t p = off;
  auto num = [&](unsigned k) -> uint64_t {
    if (p + k > n) throw ParseError("index: truncated index record");
    uint64_t v = le(b + p, k); p += k; return v;
  };
  auto sot = [&](unsigned mode) -> uint64_t {
    if (mode == 3) { if (p + 8 > n) throw ParseError("index: truncated index record"); uint64_t hi = le(b + p, 4), lo = le(b + p + 4, 4); p += 8; return (hi << 32) | lo; }
    return num(mode == 0 ? 1 : mode == 1 ? 2 : 4);
  };
  unsigned flag = unsigned(num(1)), second = unsigned(num(1));
  if ((flag & 3) == 3) throw ParseError("index: extended64-bit backdelta unsupported");
  uint64_t delta = num(1u << (flag & 3));
  if (delta >= logical && delta) throw ParseError("index: invalid backward index delta");
  rc.has_derived = false; rc.period = nv.index_blk[index].period; rc.index_block = index;
  rc.previous = delta ? logical - delta : 0; rc.count = 0;
  if ((flag & 0xc0) == 0xc0) {
    if (topo) { rc.kind = K_TOPO; return; }
    if (second == 0) {
      rc.kind = K_ZERO;
      if (p + 4 <= n) { rc.has_derived = true; rc.derived = le(b + p, 4); }
      return;
    }
    if ((second & 0xf0) || !(1 <= (second & 15) && (second & 15) <= 14)) throw ParseError("index: extended/empty inline header unsupported");
    rc.off = p; unsigned rec_code = unsigned(num(1));
    if (!(rec_code == 0 || rec_code == 4 || rec_code == 5 || rec_code == 10 || rec_code == 11)) throw ParseError("index: unsupported inline value encoding");
    rc.kind = rec_code == 0 ? K_SCALAR : K_BUSINLINE; rc.count = second & 15;
    return;
  }
  if (second & 0xc0) throw ParseError("index: unsupported bus index flags");
  uint64_t vc = num(1u << ((flag >> 2) & 3)); sot((flag >> 4) & 3);
  unsigned mode = flag >> 6;
  uint64_t count = num(mode == 0 ? 1 : mode == 1 ? 2 : 4);
  uint64_t begin = sot(second & 3), end = sot((second >> 2) & 3);
  uint64_t bi = vc >> 16, bo = vc & 0xffff;
  if (bi >= nv.bus.size() || nv.bus[bi].period != nv.index_blk[index].period || begin > end || !count) throw ParseError("index: bus reference/range/count invalid");
  rc.kind = K_BUS; rc.bus_block = bi; rc.off = bo; rc.count = count; rc.begin = begin; rc.end = end;
}
// records_from_logical; out is reversed to index order with zero-inline records removed (full mode).
void walk(const Locator& nv, uint64_t logical, bool topo, bool accept_derived, std::vector<Rec>& out, bool& has_derived, uint64_t& derived) {
  out.clear(); has_derived = false; uint64_t seen = 0;
  while (logical) {
    if (seen >= nv.index_limit) throw ParseError("index: index cycle/limit");
    seen++;
    Rec rc; record(nv, logical, topo, rc);
    if (rc.kind == K_ZERO && !topo) {
      if (!(accept_derived && out.empty() && rc.has_derived)) throw ParseError("index: zero-count inline encoding requires clock/derived-value qualification");
      has_derived = true; derived = rc.derived;
    }
    out.push_back(rc); logical = rc.previous;
  }
  std::reverse(out.begin(), out.end());
  if (!topo) {
    out.erase(std::remove_if(out.begin(), out.end(), [](const Rec& x) { return x.kind == K_ZERO; }), out.end());
    for (size_t i = 1; i < out.size(); i++) if (out[i - 1].period >= out[i].period) throw ParseError("index: repeated/backwards stream period");
    if (has_derived) for (auto& x : out) if (x.kind == K_BUS && x.end >= derived) throw ParseError("index: stored prefix reaches the derived-after time");
  }
}

// ---------------------------------------------------------------- time dictionaries
struct Tables { std::vector<uint64_t> vals; std::vector<uint64_t> start; };  // table i = vals[start[i]..start[i+1])
Bytes dec_stage_sizes(const uint8_t* p, uint64_t n, size_t lim, size_t& maxstage) {
  Bytes cur = fsdbraw::checked_payload(p, size_t(n)); maxstage = 0;
  for (int k = 0; k < 2; k++) { cur = fsdbraw::decompress(0, cur.data(), cur.size(), lim); maxstage = std::max(maxstage, cur.size()); }
  return cur;
}
Tables dictionaries(const Raw& r, const Header& h, int T) {
  Tables t; const uint64_t max_output = DICT_MAX_BYTES;
  if (r.u(0x3b, 1) != 11) throw ParseError("time dictionaries: unsupported file configuration");
  uint64_t offset = r.u(h.section + 0x78, 8);
  if (!offset) {
    if (r.u(0x28, 4) != 89) throw ParseError("unsupported direct-time file version");
    uint64_t count = r.u(0x898, 4);
    if (!(1 <= count && count <= 1000000)) throw ParseError("direct-time period count limit");
    t.start.assign(count + 1, 0); return t;
  }
  uint64_t expected = r.u(offset, 4);
  if (expected > max_output) throw ParseError("time dictionary exceeds memory limit");
  // chunk list (stops at the first framing error, raised after the earlier chunks as Python would)
  std::vector<Blk> chunks; uint64_t cursor = offset + 4; Err pending;
  pending = capture([&] {
    for (;;) {
      uint64_t size = r.u(cursor, 4); cursor += 4;
      if (!size) break;
      r.need(cursor, size); chunks.push_back({cursor, size}); cursor += size;
    }
  });
  std::vector<Bytes> out(chunks.size()); std::vector<Err> errs(chunks.size()); std::vector<size_t> maxst(chunks.size());
  pfor(chunks.size(), T, 1, [&](size_t i, int) { errs[i] = capture([&] { out[i] = dec_stage_sizes(r.b + chunks[i].off, chunks[i].size, max_output, maxst[i]); }); });
  uint64_t have = 0;
  for (size_t i = 0; i < chunks.size(); i++) {
    if (errs[i]) errs[i].raise();
    if (maxst[i] > max_output - have) throw DecodeError("lz0 literal bounds");
    have += out[i].size();
    if (have > expected) throw ParseError("time dictionary expanded size mismatch");
  }
  if (pending) pending.raise();
  if (have != expected) throw ParseError("time dictionary size mismatch");
  Bytes b; b.reserve(have);
  for (auto& x : out) { b.insert(b.end(), x.begin(), x.end()); Bytes().swap(x); }
  size_t p = 0; const size_t L = b.size();
  auto need = [&](size_t k) { if (p + k > L) throw ParseError("truncated delta dictionary"); };
  t.start.push_back(0);
  while (p < L) {
    need(1); if (b[p] != 0xfe) throw ParseError("unsupported delta dictionary marker"); p++;
    need(4); uint64_t count = le(b.data() + p, 4); p += 4;
    need(1); unsigned width = b[p++];
    if (width != 4 && width != 8) throw ParseError("unsupported delta dictionary width");
    if (count > max_output / 4) throw ParseError("unreasonable delta dictionary count");
    unsigned mask = 0;
    for (uint64_t i = 0; i < count; i++) {
      if (i % 4 == 0) { need(1); mask = b[p++]; }
      unsigned mode = (mask >> (2 * (i % 4))) & 3;
      if (mode == 3 && width == 4) throw ParseError("invalid 64-bit delta in 32-bit dictionary");
      unsigned k = 1u << mode; need(k);
      uint64_t v = k == 8 ? ((le(b.data() + p, 4) << 32) | le(b.data() + p + 4, 4)) : le(b.data() + p, k);
      p += k; t.vals.push_back(v);
    }
    t.start.push_back(t.vals.size());
  }
  if (t.start.size() == 1) throw ParseError("empty delta dictionary");
  return t;
}

// ---------------------------------------------------------------- array-alias holders
struct ArrayAliasMap { uint64_t projected_base = 0; std::vector<uint8_t> active; std::vector<uint64_t> logical; bool present = false;
  bool has(uint64_t id) const { return present && id >= projected_base && id - projected_base < active.size() && active[id - projected_base]; }
  uint64_t at(uint64_t id) const { return logical[id - projected_base]; } };
ArrayAliasMap array_alias_parse(const Raw& r, const Header& h) {
  ArrayAliases a = parse_array_aliases(r, h);
  const uint64_t max_output = 16u << 20, max_blocks = 1000000;
  uint64_t start = a.table_end, relative = r.u(start, 8), footer = start + relative;
  if (relative < 8) throw ParseError("array-alias compressed directory relative footer");
  uint64_t count = r.u(footer, 4);
  if (!(1 <= count && count <= max_blocks)) throw ParseError("array-alias compressed block count");
  r.need(footer + 4, 4 * count); uint64_t cursor = start + 8, total = 0;
  std::vector<Bytes> blocks;
  for (uint64_t i = 0; i < count; i++) {
    uint64_t size = r.u(footer + 4 + 4 * i, 4);
    if (size < 5 || size > max_output || cursor + size > footer) throw ParseError("array-alias physical block bounds");
    if (r.u(cursor, 4) != size - 4) throw ParseError("array-alias physical block size mismatch");
    blocks.push_back(dec(r.b + cursor + 4, size - 4, {0, 0}, max_output));
    total += blocks.back().size();
    if (total > (128u << 20)) throw ParseError("array-alias aggregate decoded block limit");
    cursor += size;
  }
  if (cursor != footer) throw ParseError("array-alias physical block directory mismatch");
  ArrayAliasMap m; m.projected_base = a.projected_base; size_t E = a.flags.size();
  std::vector<uint8_t> have(E, 0); m.logical.assign(E, 0);
  for (auto& e : a.entries) {
    uint64_t bi = e.index_offset >> 32, off = e.index_offset & 0xffffffffu;
    if (bi >= blocks.size()) throw ParseError("array-alias group block index");
    const Bytes& raw = blocks[bi];
    if (off + 4 > raw.size()) throw ParseError("array-alias group header bounds");
    uint64_t length = le(raw.data() + off, 4);
    if (length < 4 || length > max_output) throw ParseError("array-alias group length limit");
    Bytes payload; uint64_t remaining = length;
    while (remaining) {
      if (bi >= blocks.size()) throw ParseError("array-alias group crosses final block");
      const Bytes& bl = blocks[bi];
      uint64_t take = off < bl.size() ? std::min<uint64_t>(remaining, bl.size() - off) : 0;
      if (!take) throw ParseError("array-alias empty group continuation");
      payload.insert(payload.end(), bl.begin() + off, bl.begin() + off + take); remaining -= take; bi++; off = 0;
    }
    uint64_t width = e.raw_flag ? 9 : 13;
    if ((length - 4) % width) throw ParseError("array-alias holder alignment");
    uint64_t n = (length - 4) / width, expected = e.raw_flag ? e.end - e.begin : e.active;
    if (n != expected) throw ParseError("array-alias holder count mismatch");
    size_t p = 4; int64_t previous = -1;
    for (uint64_t j = 0; j < n; j++) {
      uint64_t local = j;
      if (!e.raw_flag) {
        local = le(payload.data() + p, 4); p += 4;
        if (int64_t(local) <= previous) throw ParseError("array-alias sparse indices not increasing");
        previous = int64_t(local);
      }
      uint64_t low = e.begin + local;
      if (low >= e.end) throw ParseError("array-alias holder ID outside group");
      uint64_t logical = le(payload.data() + p, 8); uint8_t flags = payload[p + 8]; p += 9;
      if (flags & ~3) throw ParseError("array-alias unsupported holder summary flags");
      if (have[low]) throw ParseError("array-alias duplicate holder");
      have[low] = 1; m.logical[low] = logical;
    }
  }
  for (size_t low = 0; low < E; low++) if (a.flags[low] && !have[low]) throw ParseError("array-alias active ID has no holder");
  m.active.assign(a.flags.begin(), a.flags.end()); m.present = true;
  return m;
}

// ---------------------------------------------------------------- plan tokens
inline bool id0(uint8_t c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '$'; }
inline bool id1(uint8_t c) { return id0(c) || (c >= '0' && c <= '9'); }
inline bool dig(uint8_t c) { return c >= '0' && c <= '9'; }
inline bool prn(uint8_t c) { return c >= '!' && c <= '~'; }
size_t bracket(const std::string& s, size_t i, bool range) {  // \[-?[0-9]+(?::-?[0-9]+)?\]
  const size_t bad = std::string::npos;
  if (i >= s.size() || s[i] != '[') return bad;
  i++; if (i < s.size() && s[i] == '-') i++;
  size_t d = i; while (i < s.size() && dig(uint8_t(s[i]))) i++;
  if (i == d) return bad;
  if (range && i < s.size() && s[i] == ':') {
    i++; if (i < s.size() && s[i] == '-') i++;
    d = i; while (i < s.size() && dig(uint8_t(s[i]))) i++;
    if (i == d) return bad;
  }
  if (i >= s.size() || s[i] != ']') return bad;
  return i + 1;
}
bool match_ident_brackets(const std::string& s, bool range) {
  if (s.empty() || !id0(uint8_t(s[0]))) return false;
  size_t i = 1; while (i < s.size() && id1(uint8_t(s[i]))) i++;
  while (i < s.size()) { i = bracket(s, i, range); if (i == std::string::npos) return false; }
  return true;
}
bool match_scope(const std::string& s) {
  if (!s.empty() && s[0] == '\\') { if (s.size() < 2) return false; for (size_t i = 1; i < s.size(); i++) if (!prn(uint8_t(s[i]))) return false; return true; }
  return match_ident_brackets(s, false);
}
bool match_name(const std::string& s) {
  if (!s.empty() && s[0] == '\\') {
    size_t k = 1; while (k < s.size() && prn(uint8_t(s[k]))) k++;
    if (k < 2) return false;
    if (k == s.size()) return true;
    if (s[k] != ' ') return false;
    return bracket(s, k + 1, true) == s.size();
  }
  return match_ident_brackets(s, true);
}
// split a declared variable name at dots outside brackets; escaped names (leading backslash) stay whole
std::vector<std::string> dotted_parts(const std::string& s) {
  std::vector<std::string> out;
  if (!s.empty() && s[0] == '\\') { out.push_back(s); return out; }
  size_t st = 0; int depth = 0;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '[') depth++; else if (s[i] == ']') depth--;
    else if (s[i] == '.' && depth == 0) { out.push_back(s.substr(st, i - st)); st = i + 1; }
  }
  out.push_back(s.substr(st));
  return out;
}
std::string token(const std::string& text, bool name, const char* label) {
  if (!(name ? match_name(text) : match_scope(text))) throw ParseError(std::string("plan: ambiguous/unsupported ") + label);
  if (!(1 <= text.size() && text.size() <= MAX_NAME_BYTES)) throw ParseError("plan: name length limit");
  return hexbytes((const uint8_t*)text.data(), text.size());
}
// Scope tokens: one token per scope RECORD (its own component), in per-chunk arenas; a scope's joined form
// " p1 p2 ... pn" is written by walking its record chain (ScopeTab::first / parent), so no joined copy is held.
struct ScopeToks {
  static constexpr size_t CH = 65536;
  std::vector<std::string> arena; std::vector<std::vector<uint32_t>> off;  // per chunk of records
  std::vector<uint32_t> rerr;                                               // per record: ErrTab row of its token
  std::vector<uint32_t> err, jlen; std::vector<int32_t> nparts;             // per scope
  std::string_view tok(size_t a) const { const auto& o = off[a / CH]; size_t j = a % CH; return {arena[a / CH].data() + o[j], size_t(o[j + 1] - o[j])}; }
};
// head = "bits left right nparts p1 .. pn namehex". Held re-keyed: the scope part (p1 .. pk) is the interned scope's
// joined tokens (ScopeTok::joined, one copy per scope), so a declaration keeps only its own tail (dotted name parts +
// name) and the head is rendered where it is written (head_len / put_head).
// Only lengths are held: the tail (dotted name parts + name tokens) is formatted again where the head is written.
struct DeclTok { uint32_t err = 0, tail_len = 0; int32_t nparts = 0; bool refused = false; };  // err: ErrTab row
// per-stream rows of one flat DeclTok array (offsets by stream)
struct DeclToks {
  std::vector<DeclTok> v; std::vector<size_t> off;
  struct Row { DeclTok* p; size_t n; DeclTok& operator[](size_t j) const { return p[j]; } size_t size() const { return n; } };
  Row operator[](size_t k) { return {v.data() + off[k], off[k + 1] - off[k]}; }
};
// (scope, name) of a declaration keyed by its index in the signal table: the same equality as the old
// u2s(scope) + '\0' + name string key, with no key string stored per declaration.
// Open-addressing set of declarations keyed by (scope, name) through SigNameKey: one (signal, stream) pair per slot.
struct SigNameSet {
  static constexpr uint32_t EMPTY = UINT32_MAX;
  std::vector<std::pair<uint32_t, uint32_t>> slot; size_t mask = 0;
  template <class K> SigNameSet(size_t n, const K&) { size_t c = 16; while (c < 2 * n + 1) c <<= 1; slot.assign(c, {EMPTY, 0}); mask = c - 1; }
  // the slot holding a declaration of si's (scope, name), or the empty slot where it goes
  template <class K> std::pair<uint32_t, uint32_t>& at(uint32_t si, const K& k) { return at_slot(si, k(si) & mask, k); }
  // the same, probing from a home slot computed beforehand (home = k(si) & mask)
  template <class K> std::pair<uint32_t, uint32_t>& at_slot(uint32_t si, size_t h, const K& k) {
    for (;; h = (h + 1) & mask) if (slot[h].first == EMPTY || k(slot[h].first, si)) return slot[h];
  }
  void prefetch(size_t h) const { __builtin_prefetch(&slot[h]); }
  // home slots of a run of declarations, computed in parallel (the serial probe loop then only probes, prefetching ahead)
  template <class K, class Get> std::vector<uint32_t> homes(size_t n, Get get, const K& k, int T) const {
    std::vector<uint32_t> h(n); pfor(n, T, 4096, [&](size_t i, int) { h[i] = uint32_t(k(get(i)) & mask); }); return h;
  }
};
struct SigNameKey {
  const std::vector<Sig>* S;
  // mixed (splitmix64 finaliser): the same leaf name under consecutive scope ids must not fill consecutive slots
  // (linear probing in SigNameSet: an unmixed key stalled the 50M plan in the duplicate check)
  size_t operator()(uint32_t i) const {
    const Sig& g = (*S)[i]; uint64_t z = uint64_t(std::hash<std::string_view>()(g.name)) ^ (uint64_t(g.scope) * 0x9e3779b97f4a7c15ull);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull; z = (z ^ (z >> 27)) * 0x94d049bb133111ebull; return size_t(z ^ (z >> 31));
  }
  bool operator()(uint32_t a, uint32_t b) const { const Sig& x = (*S)[a]; const Sig& y = (*S)[b]; return x.scope == y.scope && x.name == y.name; }
};

// ---------------------------------------------------------------- JSON (json.dumps, ensure_ascii)
std::string jstr(const std::string& s) {
  std::string o = "\"";
  for (size_t i = 0; i < s.size();) {
    uint8_t c = uint8_t(s[i]); uint32_t cp; size_t k;
    if (c < 0x80) { cp = c; k = 1; }
    else if ((c >> 5) == 6 && i + 1 < s.size()) { cp = ((c & 0x1f) << 6) | (s[i + 1] & 0x3f); k = 2; }
    else if ((c >> 4) == 14 && i + 2 < s.size()) { cp = ((c & 0x0f) << 12) | ((s[i + 1] & 0x3f) << 6) | (s[i + 2] & 0x3f); k = 3; }
    else if ((c >> 3) == 30 && i + 3 < s.size()) { cp = ((c & 0x07) << 18) | ((s[i + 1] & 0x3f) << 12) | ((s[i + 2] & 0x3f) << 6) | (s[i + 3] & 0x3f); k = 4; }
    else { cp = 0xfffd; k = 1; }
    i += k;
    char b[16];
    if (cp == '"') o += "\\\""; else if (cp == '\\') o += "\\\\"; else if (cp == '\n') o += "\\n"; else if (cp == '\r') o += "\\r";
    else if (cp == '\t') o += "\\t"; else if (cp == '\b') o += "\\b"; else if (cp == '\f') o += "\\f";
    else if (cp < 0x20 || (cp > 0x7e && cp != 0x7f)) {
      if (cp >= 0x10000) { uint32_t v = cp - 0x10000; snprintf(b, sizeof b, "\\u%04x\\u%04x", 0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)); }
      else snprintf(b, sizeof b, "\\u%04x", cp);
      o += b;
    } else o += char(cp);
  }
  return o + "\"";
}

double now() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

uint32_t parallel_crc(const uint8_t* p, size_t n, int T) {
  const size_t chunk = size_t(32) << 20; size_t k = (n + chunk - 1) / chunk;
  std::vector<uLong> c(k);
  pfor(k, T, 1, [&](size_t i, int) { size_t b = i * chunk, len = std::min(chunk, n - b); c[i] = crc32(0L, p + b, uInt(len)); });
  uLong crc = 0;
  for (size_t i = 0; i < k; i++) { size_t len = std::min(chunk, n - i * chunk); crc = i ? crc32_combine(crc, c[i], z_off_t(len)) : c[i]; }
  return uint32_t(crc);
}

std::string py_list5(const std::vector<uint64_t>& m) {
  std::string s = "[";
  for (size_t i = 0; i < m.size() && i < 5; i++) { if (i) s += ", "; put(s, m[i]); }
  return s + "]";
}
std::string refusal_reason(const std::string& msg) {  // str(e).split(':')[-1].strip()
  size_t c = msg.rfind(':'); std::string s = c == std::string::npos ? msg : msg.substr(c + 1);
  size_t a = s.find_first_not_of(" \t\n\r\f\v"), b = s.find_last_not_of(" \t\n\r\f\v");
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}

// ---------------------------------------------------------------- planner
struct U32Span {  // a run of one shared index array
  const uint32_t* p = nullptr; uint32_t n = 0;
  const uint32_t* begin() const { return p; } const uint32_t* end() const { return p + n; }
  size_t size() const { return n; } uint32_t operator[](size_t j) const { return p[j]; }
};
struct Stream { uint64_t rep, stream_id, logical; U32Span decls; uint64_t db = 0; };  // decls: Stream rows of the shared decl array (db = first)
// Parallel sort: chunks sorted in parallel, then merged pairwise in parallel rounds. For element types with a total
// order where equal elements are indistinguishable (integers, distinct pairs) the result equals std::sort's.
template <class E> void psort(std::vector<E>& e, int T) {
  const size_t n = e.size(); size_t P = 1; while (P < size_t(std::max(T, 1)) && P < 16) P <<= 1;
  if (P < 2 || n < (size_t(1) << 16)) { std::sort(e.begin(), e.end()); return; }
  std::vector<size_t> b(P + 1); for (size_t i = 0; i <= P; i++) b[i] = n * i / P;
  pfor(P, T, 1, [&](size_t c, int) { std::sort(e.begin() + b[c], e.begin() + b[c + 1]); });
  std::vector<E> t(n); auto* src = &e; auto* dst = &t;
  for (size_t w = 1; w < P; w <<= 1) {
    pfor(P / (2 * w), T, 1, [&](size_t q, int) {
      size_t lo = b[2 * w * q], mid = b[2 * w * q + w], hi = b[2 * w * q + 2 * w];
      std::merge(src->begin() + lo, src->begin() + mid, src->begin() + mid, src->begin() + hi, dst->begin() + lo);
    });
    std::swap(src, dst);
  }
  if (src != &e) e.swap(t);
}
// Group keys in first-appearance order without a hash map: (key, member) pairs sorted by key give the runs; runs are
// numbered by their first member. Out: key per group (group order), CSR members (start/mem, member order kept), and
// the (key, group) pairs sorted by key for lookups.
struct Groups {
  std::vector<uint64_t> key; std::vector<uint32_t> start, mem; std::vector<std::pair<uint64_t, uint32_t>> bykey;
  static constexpr uint32_t NONE = UINT32_MAX;
  U32Span operator[](size_t g) const { return {mem.data() + start[g], start[g + 1] - start[g]}; }
  size_t size() const { return key.size(); }
  uint32_t find(uint64_t k) const {
    auto it = std::lower_bound(bykey.begin(), bykey.end(), std::make_pair(k, uint32_t(0)));
    return it != bykey.end() && it->first == k ? it->second : NONE;
  }
  void build(std::vector<std::pair<uint64_t, uint32_t>>& e, int T) {  // e: (key, member), consumed
    psort(e, T);
    std::vector<std::pair<uint32_t, uint32_t>> run;  // (first member, run start in e)
    for (size_t i = 0; i < e.size(); i++) if (!i || e[i].first != e[i - 1].first) run.push_back({e[i].second, uint32_t(i)});
    std::vector<uint32_t> rend(run.size());
    for (size_t r = 0; r < run.size(); r++) rend[r] = r + 1 < run.size() ? run[r + 1].second : uint32_t(e.size());
    std::vector<uint32_t> order(run.size());
    { std::vector<std::pair<uint64_t, uint32_t>> fr(run.size()); for (uint32_t r = 0; r < fr.size(); r++) fr[r] = {run[r].first, r};
      psort(fr, T); for (uint32_t g = 0; g < fr.size(); g++) order[g] = fr[g].second; }  // runs by first member (distinct)
    key.resize(run.size()); start.assign(run.size() + 1, 0); mem.resize(e.size()); bykey.resize(run.size());
    uint32_t at = 0;
    for (uint32_t g = 0; g < order.size(); g++) {
      uint32_t r = order[g]; start[g] = at; key[g] = e[run[r].second].first; bykey[r] = {key[g], g};
      for (uint32_t i = run[r].second; i < rend[r]; i++) mem[at++] = e[i].second;
    }
    start[run.size()] = at;
    std::vector<std::pair<uint64_t, uint32_t>>().swap(e);
  }
};
// first time a record can carry: a bus record knows its first change, an inline record only its period start.
uint64_t rec_first_t(const Locator& loc, const Rec& rc) { return rc.kind == K_BUS ? rc.begin : loc.periods[rc.period].begin; }
// Errors are rare: per-stream and per-declaration errors live in one side table and the rows hold an index (0 = none).
// Rows are added from worker threads (under the lock) and read only after the parallel phase.
struct ErrTab {
  std::mutex m; std::deque<Err> v; ErrTab() { v.emplace_back(); }
  uint32_t add(Err e) { if (!e) return 0; std::lock_guard<std::mutex> g(m); v.push_back(std::move(e)); return uint32_t(v.size() - 1); }
  uint32_t msg(std::string x) { Err e; e.kind = 3; e.msg = std::move(x); return add(std::move(e)); }
  const Err& operator[](uint32_t i) const { return v[i]; }
};
// Append-only text blocks (one per walk thread): a stored piece never moves, so rows hold a pointer + length.
struct TextArena {
  std::vector<std::unique_ptr<char[]>> blk; size_t used = 0, cap = 0;
  const char* put(const std::string& x) {
    if (x.empty()) return nullptr;
    if (used + x.size() > cap) { cap = std::max<size_t>(size_t(4) << 20, x.size()); blk.emplace_back(new char[cap]); used = 0; }
    char* d = blk.back().get() + used; memcpy(d, x.data(), x.size()); used += x.size(); return d;
  }
};
struct StreamOut {
  const char* tp = nullptr;  // R text (in a TextArena); tlen bytes
  uint64_t derived = 0, nrec = 0, textlen = 0;
  uint32_t err = 0, rerr = 0, tlen = 0;  // ErrTab rows: err = the status message, rerr = a record check
  uint8_t status = 0;  // 0 ok, 1 records ParseError (refusal), 2 other walk error (rejection), 3 excluded, 4 other
  bool has_derived = false, late = false;
  std::string_view text() const { return {tp ? tp : "", tlen}; }
};
inline uint64_t nd(uint64_t v) { uint64_t k = 1; while (v >= 10) { v /= 10; k++; } return k; }
inline uint64_t ndi(int64_t v) { return v < 0 ? 1 + nd(uint64_t(0) - uint64_t(v)) : nd(uint64_t(v)); }
constexpr size_t NP = 2048;  // bus-start partitions (by bus block range) for the parallel window index


// ---------------------------------------------------------------- typed values (real / string)
// Real (field 16): bus record, encoding 0x20, no header words; columnar: count time flags (+ dictionary delta codes),
// then count high u32 words, then count low u32 words of the binary64 value, each word XOR the previous change's.
// String (field 19): bus record, encoding 0x22, flags 0x02, u32 4; rows [flag + delta code][u32 ref]; ref = index into
// the NUL-separated text table at header section+0x20. Anything else stays refused (fail closed).
static std::string hexs(const std::string& x) { static const char* d = "0123456789abcdef"; std::string o; o.reserve(x.size() * 2); for (unsigned char c : x) { o += d[c >> 4]; o += d[c & 15]; } return o; }
std::vector<std::string> load_text_table(const Raw& r, const Header& h) {
  uint64_t p = r.u(h.section + 0x20, 8);
  if (!p || p < 4 * h.section) throw ParseError("text table pointer");
  uint64_t len = r.u(p + 8, 4); if (!len || len > (64u << 20)) throw ParseError("text table size");
  r.need(p + 12, len); Bytes d = dec(r.b + p + 12, len, {0, 0}, 64u << 20);
  std::vector<std::string> t; size_t a = 0;
  for (size_t i = 0; i < d.size(); i++) if (!d[i]) { t.emplace_back((const char*)d.data() + a, i - a); a = i + 1; }
  if (a != d.size()) throw ParseError("text table not NUL-terminated");
  return t;
}
std::string typed_stream(const Locator& loc, const Tables& tables, const Raw& r, const Header& H, std::vector<std::string>& text, const std::vector<Sig>& S, const Decl& decl,
                         const std::vector<uint32_t>& decls, uint64_t logical, int field, std::string& why) {
  std::vector<Rec> recs; bool hd = false; uint64_t dv = 0;
  Err e = capture([&] { walk(loc, logical, false, true, recs, hd, dv); });
  if (e) { why = "walk: " + e.msg; return ""; }
  if (hd) { why = "derived-after stream"; return ""; }
  if (recs.empty()) { why = "no records"; return ""; }
  std::vector<std::pair<uint64_t, std::string>> rows; uint64_t prevT = 0; bool any = false;
  Err e2 = capture([&] {
    for (auto& rc : recs) {
      if (rc.kind != K_BUS) throw ParseError("typed: record kind " + std::to_string(rc.kind) + " not qualified");
      if (rc.period + 1 >= tables.start.size()) throw ParseError("typed: record period");
      const uint64_t* tb = tables.vals.data() + tables.start[rc.period]; const size_t tn = tables.start[rc.period + 1] - tables.start[rc.period];
      if (!tn || tb[0] != 0) throw ParseError("typed: direct-time period not qualified");
      const auto& bd = loc.bus[rc.bus_block]; loc.r.need(bd.offset, bd.size); Bytes d = dec(loc.r.b + bd.offset, bd.size, {2, 0});
      size_t q = rc.off; auto need = [&](size_t k) { if (q + k > d.size()) throw ParseError("typed: record past its block (spanning records not qualified)"); };
      auto u8 = [&]() { need(1); return d[q++]; }; auto u32 = [&]() { need(4); uint32_t v = uint32_t(le(d.data() + q, 4)); q += 4; return v; };
      auto delta = [&](uint8_t flag) -> uint64_t { static const unsigned W[4] = {1, 2, 4, 0}; unsigned n = W[(flag >> 4) & 3]; need(n); uint64_t c = n ? le(d.data() + q, n) : 0; q += n;
        if (c >= tn) throw ParseError("typed: delta code outside dictionary"); return tb[c]; };
      uint64_t t = 0, cnt = rc.count; if (!cnt || cnt > 100000000) throw ParseError("typed: record count");
      std::vector<uint64_t> ts;
      if (field == 16) {
        if (u8() != 0x20) throw ParseError("typed: real encoding not qualified");
        for (uint64_t i = 0; i < cnt; i++) { uint8_t f = u8(); if (f & ~0x30) throw ParseError("typed: real time flag not qualified"); t += delta(f); ts.push_back(t); }
        std::vector<uint32_t> hi(cnt), lo(cnt); for (auto& x : hi) x = u32(); for (auto& x : lo) x = u32();
        uint32_t ph = 0, pl = 0; const bool noxor = FPLAN_TEST_ENV("FPLAN_TEST_TYPED_NOXOR") != nullptr;  // TEST-ONLY red mutant: absolute words
        for (uint64_t i = 0; i < cnt; i++) { if (noxor) { ph = hi[i]; pl = lo[i]; } else { ph ^= hi[i]; pl = lo[i]; }  /* high word XOR'd with the previous value, low word absolute */ uint64_t bitsv = (uint64_t(ph) << 32) | pl; char hx[17]; snprintf(hx, 17, "%016llx", (unsigned long long)bitsv); rows.push_back({ts[i], hx}); }
      } else {
        if (u8() != 0x22 || u8() != 0x02 || u32() != 4) throw ParseError("typed: string encoding not qualified");
        if (text.empty()) text = load_text_table(r, H);
        for (uint64_t i = 0; i < cnt; i++) { uint8_t f = u8(); if (f & ~0x30) throw ParseError("typed: string time flag not qualified"); t += delta(f); uint32_t ref = u32();
          if (ref >= text.size()) throw ParseError("typed: string reference outside the text table"); rows.push_back({t, text[ref].empty() ? "-" : hexs(text[ref])}); }
      }
      need(1); if (d[q] != 0xc0 && d[q] != 0xc1) throw ParseError("typed: record not terminated after its count");
    }
    for (auto& x : rows) { if (any && x.first < prevT) throw ParseError("typed: decreasing time"); prevT = x.first; any = true; }
  });
  if (e2) { why = e2.msg; return ""; }
  std::string o = "V " + std::to_string(field == 16 ? 5 : 6) + " " + std::to_string(decls.size()) + " " + std::to_string(rows.size()) + "\n";
  for (auto s : decls) {
    const Sig& g = S[s]; if (decl.scopes.ambiguous[g.scope]) { why = "ambiguous scope"; return ""; }
    auto sc = decl.scopes.components(g.scope); if (sc.empty()) { why = "no scope"; return ""; }
    o += "D " + std::to_string(sc.size()); for (auto& c : sc) o += " " + hexs(c); o += " " + hexs(g.name) + "\n";
  }
  for (auto& x : rows) o += "r " + std::to_string(x.first) + " " + x.second + "\n";
  return o;
}
void build_impl(const uint8_t* data, size_t n, const Options& opt, Result& res) {
  const char* cap_env = getenv("FPLAN_MAX_PLAN_BYTES"); std::string cap_err; plancap::Src cap_src;
  const uint64_t MAX_PLAN_BYTES = plancap::cap(n, cap_env, "FPLAN_MAX_PLAN_BYTES", getenv("RUN_PLAN_BUDGET_MB"), cap_err, &cap_src);
  if (!MAX_PLAN_BYTES) throw ParseError(cap_err);
  const int T = opt.threads > 0 ? opt.threads : usableCpus();
  double t0 = now(); std::string& st = res.stats;
  auto mark = [&](const char* what) { char b[96]; snprintf(b, sizeof b, "%s=%.3f ", what, now() - t0); st += b; rss_mark(what); };
  if (!n) throw OtherError("empty FSDB source");
  Raw r{data, n};
  // CRC runs alongside the metadata phases.
  uint32_t crc = 0; std::thread crc_thread([&] { if (opt.crc) crc = parallel_crc(data, n, std::max(1, T / 2)); });
  struct Joiner { std::thread& t; ~Joiner() { if (t.joinable()) t.join(); } } joiner{crc_thread};

  // parse_inputs: header, declarations, index, dictionaries, array aliases (errors raised in that order)
  Header H = read_header(r);
  Decl decl; Locator loc; Tables tables; ArrayAliasMap amap;
  loc.carry_doff = opt.dump_off;
  bool array_alias_flag = r.u(2 * H.section + 0x180, 8) != 0;
  auto fd = std::async(std::launch::async, [&] { return capture([&] { decl = native_vars(r, opt.allow_partial && opt.skip_dirs); }); });
  auto fn = std::async(std::launch::async, [&] { return capture([&] { loc_init(loc, r, H); }); });
  auto ft = std::async(std::launch::async, [&] { return capture([&] { tables = dictionaries(r, H, T); }); });
  auto fm = std::async(std::launch::async, [&] { return array_alias_flag ? capture([&] { amap = array_alias_parse(r, H); }) : Err(); });
  Err ed = fd.get(), en = fn.get(), et = ft.get(), em = fm.get();
  if (ed) ed.raise();
  if (en) en.raise();
  if (et) et.raise();
  if ((decl.fdefs || decl.plain_groups) && array_alias_flag) {
    if (em) em.raise();
    uint64_t limit = uint64_t(loc.index_blk.size()) * 65536;
    if (limit == 0) throw ParseError("array-alias invalid logical extent");
    for (size_t low = 0; low < amap.active.size(); low++)
      if (amap.active[low] && amap.logical[low] >= limit) throw ParseError("array-alias start-time outside ordinary index extent");
  } else amap = ArrayAliasMap();
  mark("parse");
  loc_decode_index(loc, T, opt.index_willneed);
  mark("index_decode");
  // Dump-off stream (Options::dump_off): native-ID entry 0 holds a record reference when the dump was switched off during
  // the run. It is walked like any stream; every record must be a 1-bit inline record (the shape every dump-off file seen
  // has). Its records go to the plan's O section; the converter decodes them and checks the off/on order. Any other shape
  // refuses the whole file, named. The signal streams are planned as usual: they hold what the dump stored.
  std::vector<Rec> doff_recs;
  if (loc.doff_head) {
    bool hd = false; uint64_t dv = 0;
    Err e = capture([&] { walk(loc, loc.doff_head, false, false, doff_recs, hd, dv); });
    if (e) throw ParseError(std::string(DUMP_OFF_REASON) + "; its record does not read (" + e.msg + ")");
    if (doff_recs.empty()) throw ParseError(std::string(DUMP_OFF_REASON) + "; its stream has no records");
    for (auto& x : doff_recs) if (x.kind != K_SCALAR) throw ParseError(std::string(DUMP_OFF_REASON) + "; its stream is not a 1-bit inline stream");
  }

  const char* R_CLAIM_NOLINKS = "port copy: values not linked yet; computed values refused: port links were not decoded, so a force or deposit cannot be ruled out";
  const char* R_CLAIM_OWN = "port copy: values not linked yet; computed values refused: a port copy in this file has its own stream and no force log was given (a force or deposit is possible)";
  const char* R_CLAIM_OWN_UNLISTED = "port copy: values not linked yet; computed values refused: a port copy in this file has its own stream that the force log does not list";
  const char* R_CLAIM_FORCED = forcelog::CLAIM_FORCED;   // shared with the merge's lift (run_plan_threaded.cpp)
  const char* R_CLAIM_UNUSABLE = "port copy: values not linked yet; computed values refused: the force log could not be used, so a force or deposit cannot be ruled out";
  res.claim_block = R_CLAIM_NOLINKS;  // fail closed until the links are decoded and checked below
  if (opt.port_links) {  // x=0 IDENTITY port-copy links from the FSDB (0xf0 + 0x538), fail closed
    portlinks::Result pl = portlinks::decode(r.b, r.n, H.section);
    uint64_t used = 0, skipped = 0, mut_moved = 0; bool mut_on = false;
    auto has_values = [&](uint64_t id) { uint64_t z = resolve_alias(decl.plain, id); return (amap.has(z) || loc.has_latest(z)) && (amap.has(z) ? amap.at(z) : loc.latest[z]) != 0; };
    uint64_t collide = 0, widthmis = 0, viaalias = 0, ownstream = 0, forced = 0, noscope = 0, wholefile = 0, ownstream_comp = 0, late_scope = 0, late_member = 0, ownfile = 0;
    // TEST-ONLY knob, own-stream guard OFF (red arm for the force-log gate): exists only in the test build (FPLAN_TEST_HOOKS).
#ifdef FPLAN_TEST_HOOKS
    const bool noguard = getenv("FPLAN_TEST_PL_NOGUARD") && std::string(getenv("FPLAN_TEST_PL_NOGUARD")) == "1";
#else
    constexpr bool noguard = false;
#endif
#ifdef FPLAN_TEST_HOOKS
    const uint64_t testFlagId = getenv("FPLAN_TEST_PL_FLAG_ID") ? std::stoull(getenv("FPLAN_TEST_PL_FLAG_ID")) : 0;  // TEST-ONLY red: treat this port copy as flagged
#else
    constexpr uint64_t testFlagId = 0;
#endif
    std::string fl_state = opt.force_log.empty() ? "none" : "given", fl_why; uint64_t fl_targets = 0, fl_events = 0;
    std::map<std::string, uint64_t> fl_rule;  // match rule -> targets
    if (opt.force_log.empty()) res.port_links_note = "PORTLINKS NOTE: port links ON and no force log given (--force-log / FSDB2WCZ_FORCE_LOG): a force or deposit on a port copy with no stream of its own is not detected";
    if (pl.why.empty()) {
      // a port copy whose reader-spelling name (escapes dropped) is shared with another declaration cannot be told
      // apart by name from that declaration; do not link it (fail closed: it stays refused).
      std::unordered_map<std::string, uint32_t> ncount; std::unordered_map<uint64_t, std::vector<std::string>> idnames;
      auto rform = [](const std::string& f) { std::string o; o.reserve(f.size()); for (char c : f) if (c != '\\' && c != ' ') o += c; return o; };
      std::unordered_map<uint64_t, int64_t> idbits;
      FILE* dump = getenv("FPLAN_PL_DUMP") ? fopen(getenv("FPLAN_PL_DUMP"), "w") : nullptr;  // DIAGNOSTIC: one line per decoded link
      // Names, widths and name counts are asked only for IDs on a decoded link (and, with the diagnostic dump, the refused
      // copies and their candidates): only those IDs' names are built. A name's count over every declaration is taken by a
      // hash of its reader spelling per declaration (scope part hashed once per scope); a declaration whose hash matches an
      // asked name is compared by its full string, so the counts are exact.
      {
        std::vector<uint64_t> q; q.reserve(2 * pl.link.size());
        for (auto& kv : pl.link) { q.push_back(kv.first); q.push_back(kv.second); }
        if (dump) for (auto& r : pl.refused) { q.push_back(r.pc); if (r.cand) q.push_back(r.cand); }
        std::sort(q.begin(), q.end()); q.erase(std::unique(q.begin(), q.end()), q.end());
        if (!q.empty()) {
          for (auto& sg : decl.sig) { if (sg.pkg || !std::binary_search(q.begin(), q.end(), sg.id)) continue;
            idnames[sg.id].push_back(rform(sig_full(decl, sg))); idbits.emplace(sg.id, sg.bits); }
          auto fnv = [](uint64_t h, std::string_view t) { for (unsigned char c : t) if (c != '\\' && c != ' ') { h ^= c; h *= 1099511628211ULL; } return h; };
          const uint64_t H0 = 14695981039346656037ULL;
          std::unordered_set<uint64_t> want; std::unordered_map<std::string, uint32_t> asked;
          for (auto& kv : idnames) for (auto& k : kv.second) { want.insert(fnv(H0, k)); asked.emplace(k, 0); }
          std::vector<uint64_t> hs(decl.scopes.size());
          for (uint32_t c = 0; c < hs.size(); c++) hs[c] = fnv(fnv(H0, decl.scopes.full(c)), ".");
          for (auto& sg : decl.sig) { if (sg.pkg || !want.count(fnv(hs[sg.scope], sg.name))) continue;
            auto it = asked.find(rform(sig_full(decl, sg))); if (it != asked.end()) it->second++; }
          for (auto& kv : asked) if (kv.second) ncount.emplace(kv.first, kv.second);
        }
      }
      std::vector<std::pair<uint64_t, uint64_t>> add;
      auto nm = [&](uint64_t id) { auto it = idnames.find(id); return it == idnames.end() || it->second.empty() ? std::string("-") : it->second[0]; };
      auto say = [&](uint64_t a, uint64_t b, const char* st) { if (dump) fprintf(dump, "%s\t%s\t%s\t%llu\t%llu\n", nm(a).c_str(), nm(b).c_str(), st, (unsigned long long)a, (unsigned long long)b); };
      // ---- full-scope declaration + force log -> components that are never linked ----
      const char* R_SCOPE = "port copy: link refused, dump not declared full-scope";
      bool refuse_all = !opt.full_scope; std::string all_reason = refuse_all ? R_SCOPE : "";
      std::unordered_map<uint64_t, uint64_t> uf;  // union-find over link pairs + the FSDB alias table
      std::function<uint64_t(uint64_t)> find = [&](uint64_t x) { auto it = uf.find(x); if (it == uf.end() || it->second == x) return x; uint64_t r = find(it->second); uf[x] = r; return r; };
      auto unite = [&](uint64_t a, uint64_t b) { a = find(a); b = find(b); if (a != b) uf[a] = b; };
      std::unordered_map<uint64_t, std::string> forced_comp;  // component root -> "rule target"
      for (auto& kv : pl.link) unite(kv.first, kv.second);
      for (auto& kv : decl.plain) unite(kv.first, kv.second);
      // the own-stream guard covers the whole component. A port copy with its own value stream (or undecoded
      // index flags) means the net was written to on that side (force, deposit, release, ...): every link in its
      // component (link pairs + alias table) is refused, not only that copy's (a deposit one hop out left the inner copies
      // linked to the testbench driver on a real design).
      std::unordered_set<uint64_t> own_comp, own_ids, listed_ids;  // own_ids: port copies that show their own (or a refused) stream
      if (!noguard) for (auto& kv : pl.link) { uint64_t z = resolve_alias(decl.plain, kv.first);
        if (!decl.plain.count(kv.first) && (loc.flagged.count(z) || has_values(kv.first))) { own_comp.insert(find(kv.first)); own_ids.insert(kv.first); } }
      // File-wide rule (on by default with links; --no-links-file-rule turns it off): a port copy with its own stream anywhere in
      // the file shows that something wrote on a port side. Without a usable force log, a write that left no stream on another
      // net cannot be seen, so no port copy in this file is linked. With a usable force log the forced components are known
      // and only the per-component rules apply.
      const char* R_OWN_FILE = "port copy: link refused, a port copy in this file has its own stream and no force log was given (file-wide rule)";
      bool own_file = false;
      // Full scope means dumped from the dump start for the whole run. A component is refused when any member (link pair or
      // alias-table entry) is declared by a later tree directory (a scope added to the dump after the start), or has stored
      // history whose first record is after the dump start (planner walk, or a converter late-start refusal fed back by
      // --exclude-streams). Before that time the dump holds nothing for the member, so a link would invent values.
      const char* R_LATE_SCOPE = "port copy: link refused, a scope on the same net was added to the dump after the dump start";
      const char* R_LATE_MEMBER = "port copy: link refused, a port on the same net has stored history starting after the dump start";
      std::unordered_map<uint64_t, const char*> late_comp;  // component root -> reason
      if (!noguard) {
        std::unordered_set<uint64_t> roots; std::vector<uint64_t> members;
        for (auto& kv : pl.link) { roots.insert(find(kv.first)); members.push_back(kv.first); members.push_back(kv.second); }
        for (auto& kv : decl.plain) if (roots.count(find(kv.first))) { members.push_back(kv.first); members.push_back(kv.second); }
        for (auto& sg : decl.sig) if (!sg.pkg && sg.dir > 0 && roots.count(find(sg.id))) late_comp.emplace(find(sg.id), R_LATE_SCOPE);
        std::sort(members.begin(), members.end()); members.erase(std::unique(members.begin(), members.end()), members.end());
        for (uint64_t id : members) {
          uint64_t r0 = find(id); if (late_comp.count(r0)) continue;
          uint64_t z = resolve_alias(decl.plain, id);
          auto ex = opt.exclude_streams.find(z);
          if (ex != opt.exclude_streams.end() && ex->second.find("after the dump start") != std::string::npos) { late_comp.emplace(r0, R_LATE_MEMBER); continue; }
          uint64_t lg = amap.has(z) ? amap.at(z) : loc.has_latest(z) ? loc.latest[z] : 0; if (!lg || loc.periods.empty()) continue;
          std::vector<Rec> rr; bool hd = false; uint64_t dv = 0;
          Err e = capture([&] { walk(loc, lg, false, opt.accept_derived, rr, hd, dv); });
          if (e) { late_comp.emplace(r0, R_LATE_MEMBER); continue; }  // fail closed: a member whose history cannot be walked
          if (!rr.empty() && rec_first_t(loc, rr[0]) > H.min_ticks) late_comp.emplace(r0, R_LATE_MEMBER);  // the header's stored dump start (same rule as the converter)
        }
      }
      if (!opt.force_log.empty()) {
        std::string text; FILE* f = fopen(opt.force_log.c_str(), "rb");
        if (!f) { fl_state = "unusable"; fl_why = "cannot open the force log"; }
        else { char buf[65536]; size_t k; while ((k = fread(buf, 1, sizeof buf, f)) > 0) text.append(buf, k);
          const bool rerr = ferror(f) != 0; fclose(f);  // a read error (e.g. a directory, an I/O fault) is an unusable log
          if (rerr) { fl_state = "unusable"; fl_why = "read error on the force log"; } else { res.force_log_bytes = text; res.force_log_read = true; } }
        forcelog::Log L; if (fl_why.empty()) { L = forcelog::parse(text); if (!L.err.empty()) { fl_state = "unusable"; fl_why = L.err + " (line " + std::to_string(L.err_line) + ")"; } }
        if (fl_state == "unusable") { refuse_all = true; if (all_reason.empty()) all_reason = "port copy: link refused, force log unusable (force log rule whole_file)"; }
        else {
          fl_state = "used"; fl_events = L.events.size();
          // declaration names in writer spelling, declared range dropped ("a[7:0]" -> "a"); array elements keep their index
          std::unordered_map<std::string, std::vector<uint64_t>> byname; std::set<std::string> scopes; for (uint32_t q = 0; q < decl.scopes.size(); q++) scopes.insert(decl.scopes.full(q));
          auto key_of = [](const std::string& full) { size_t k = full.size(); if (k && full.back() == ']') { size_t o = full.rfind('['); if (o != std::string::npos && full.find(':', o) != std::string::npos) return full.substr(0, o); } return full; };
          std::vector<std::pair<std::string, uint64_t>> sorted;
          for (auto& sg : decl.sig) { if (sg.pkg) continue; std::string k = key_of(sig_full(decl, sg)); byname[k].push_back(sg.id); sorted.push_back({k, sg.id}); }
          std::sort(sorted.begin(), sorted.end());
          auto under = [&](const std::string& pre, std::vector<uint64_t>& out) {  // every declaration whose name starts with pre
            for (auto it = std::lower_bound(sorted.begin(), sorted.end(), std::make_pair(pre, uint64_t(0))); it != sorted.end() && it->first.compare(0, pre.size(), pre) == 0; ++it) out.push_back(it->second); };
          std::set<std::string> seen;
          for (auto& T : L.targets) {
            std::string tc = forcelog::canon(T.target); if (!seen.insert(T.id + "\t" + tc).second) continue;
            fl_targets++; std::vector<uint64_t> hit; std::string rule, at;
            auto it = byname.find(tc);
            if (it != byname.end()) { rule = "exact"; hit = it->second; at = tc; }
            else {
              std::string b = forcelog::strip_selects(tc);
              auto ib = byname.find(b); if (ib != byname.end()) hit = ib->second;
              under(b + "[", hit);
              if (hit.empty() && forcelog::has_variable_select(tc)) {  // variable index anywhere: widen it (any index), last part = whole vector
                auto tcomp = forcelog::split_path(tc); std::string pre; { auto c0 = tcomp; std::string bb; std::vector<std::string> ss;
                  size_t i = 0; for (; i < c0.size(); i++) { forcelog::split_selects(c0[i], bb, ss); bool var = false; for (auto& g : ss) if (!forcelog::const_select(g)) var = true; if (var || i + 1 == c0.size()) break; }
                  forcelog::split_selects(c0[i], bb, ss); pre = forcelog::join_path(c0, i); pre += (pre.empty() ? "" : ".") + bb; }
                for (auto it = std::lower_bound(sorted.begin(), sorted.end(), std::make_pair(pre, uint64_t(0))); it != sorted.end() && it->first.compare(0, pre.size(), pre) == 0; ++it)
                  if (forcelog::widened_match(tcomp, it->first)) hit.push_back(it->second);
                b = tc;
              }
              if (!hit.empty()) { rule = "base_vector"; at = b; }
              else {
                auto comp = forcelog::split_path(b);
                for (size_t n = comp.size(); n-- > 1;) { std::string sc = forcelog::join_path(comp, n); if (scopes.count(sc)) { rule = "enclosing_scope"; at = sc; under(sc + ".", hit); break; } }
                if (rule.empty()) { rule = "whole_file"; at = "-"; refuse_all = true; if (all_reason.empty()) all_reason = "port copy: link refused, force target matches no dumped scope (force log rule whole_file)"; }
              }
            }
            fl_rule[rule]++;
            if (rule != "enclosing_scope" && rule != "whole_file") listed_ids.insert(hit.begin(), hit.end());  // names the net or a part of it
            for (uint64_t id : hit) forced_comp.emplace(find(id), rule);
            res.force_report += T.id + "\t" + T.section + "\t" + T.target + "\t" + rule + "\t" + at + "\t" + std::to_string(hit.size()) + "\n";
          }
        }
        if (fl_state == "unusable") res.force_report += "-\t-\t-\twhole_file\tunusable: " + fl_why + "\t0\n";
      }
      own_file = opt.links_file_rule && !own_comp.empty() && fl_state != "used";
      // Values computed from the design source cannot see a force or deposit. Evidence of one: a port copy with its own stream
      // (own_comp) or a port copy whose own stream the converter refused (--exclude-streams on the re-plan, e.g. a late start).
      bool own_ev = !own_comp.empty();
      for (auto& kv : pl.link) { if (decl.plain.count(kv.first)) continue; if (opt.exclude_streams.count(resolve_alias(decl.plain, kv.first))) { own_ev = true; own_ids.insert(kv.first); } }
      for (auto& kv : pl.link) if (testFlagId && kv.first == testFlagId) { own_ev = true; own_ids.insert(kv.first); }  // test builds only: the planted flagged copy counts as evidence
      bool all_listed = !own_ids.empty(); for (uint64_t id : own_ids) all_listed = all_listed && listed_ids.count(id);
      // A force log adds refusals and never removes one the dump shows: a port copy with its own (or a refused) stream keeps
      // the file blocked unless the log names that copy or a part of it (then: the listed reason), and a listed net blocks
      // too. An entry that names only a copy's driver or an enclosing scope does not list the copy. A merge needs no such
      // copy in the dump and no net in the log.
      res.claim_block = fl_state == "unusable" ? R_CLAIM_UNUSABLE
                      : own_ev ? (fl_state != "used" ? R_CLAIM_OWN : all_listed ? R_CLAIM_FORCED : R_CLAIM_OWN_UNLISTED)
                      : (fl_state == "used" && fl_targets > 0) ? R_CLAIM_FORCED : "";
      for (auto& kv : pl.link) {
        if (refuse_all) { (opt.full_scope ? wholefile : noscope)++; res.link_reason[kv.first] = all_reason; say(kv.first, kv.second, opt.full_scope ? "refused_force_log_whole_file" : "refused_no_full_scope"); continue; }
        if (own_file) { ownfile++; res.link_reason[kv.first] = R_OWN_FILE; say(kv.first, kv.second, "refused_own_stream_file"); continue; }
        if (!forced_comp.empty()) { auto fc = forced_comp.find(find(kv.first));
          if (fc != forced_comp.end()) { forced++; res.link_reason[kv.first] = "port copy: link refused, net forced or deposited in simulation (force log rule " + fc->second + ")"; say(kv.first, kv.second, "refused_forced"); continue; } }
        auto lc = late_comp.find(find(kv.first));
        if (lc != late_comp.end() && lc->second == R_LATE_SCOPE) { late_scope++; res.link_reason[kv.first] = lc->second; say(kv.first, kv.second, "refused_late_scope"); continue; }
        if (own_comp.count(find(kv.first)) && !loc.flagged.count(resolve_alias(decl.plain, kv.first)) && !has_values(kv.first)) {
          ownstream_comp++; res.link_reason[kv.first] = "port copy: link refused, a port on the same net has its own stream"; say(kv.first, kv.second, "refused_own_stream_component"); continue; }
        // after the own-stream rules (a forced or deposited port usually also starts late): a late-starting member, copy without values
        if (lc != late_comp.end() && !has_values(kv.first) && !loc.flagged.count(resolve_alias(decl.plain, kv.first))) {
          late_member++; res.link_reason[kv.first] = lc->second; say(kv.first, kv.second, "refused_late_member"); continue; }
        if (decl.plain.count(kv.first)) {  // the FSDB already aliases this port copy; it is carried if its alias path reaches a linked id
          uint64_t z = resolve_alias(decl.plain, kv.first); bool via = pl.link.count(z) && !decl.plain.count(z);
          if (via) { viaalias++; say(kv.first, kv.second, "carried_via_alias"); } else { skipped++; say(kv.first, kv.second, "skip_pc_already_alias"); }
          continue; }
        if (!noguard && (loc.flagged.count(resolve_alias(decl.plain, kv.first)) || (testFlagId && kv.first == testFlagId))) { ownstream++; res.link_reason[kv.first] = "port copy: link refused, undecoded index flags: it may hold its own stream"; say(kv.first, kv.second, "refused_own_stream_flagged"); continue; }  // undecoded index flags: may hold its own stream; never linked
        if (!noguard && has_values(kv.first)) { ownstream++; say(kv.first, kv.second, "refused_own_stream"); continue; }  // a port copy with its own value stream is never linked
        if (!has_values(kv.second)) { skipped++; say(kv.first, kv.second, "skip_owner_no_values"); continue; }
        bool dup = false; for (auto& k : idnames[kv.first]) if (ncount[k] > 1) dup = true;
        if (dup) { collide++; say(kv.first, kv.second, "name_collision"); continue; }
        if (idbits.count(kv.first) && idbits.count(kv.second) && idbits[kv.first] != idbits[kv.second]) { widthmis++; say(kv.first, kv.second, "width_mismatch"); continue; }
        say(kv.first, kv.second, "linked");
        add.push_back({kv.first, resolve_alias(decl.plain, kv.second)});
      }
      if (dump) {  // port copies not linked at decode (no link pair reached the loop above); candidate "-" when none
        auto nm0 = [&](uint64_t id) { return id ? nm(id) : std::string("-"); };
        for (auto& q : pl.refused) fprintf(dump, "%s\t%s\t%s\t%llu\t%llu\n", nm(q.pc).c_str(), nm0(q.cand).c_str(), q.status, (unsigned long long)q.pc, (unsigned long long)q.cand);
        fclose(dump); }
#ifdef FPLAN_TEST_HOOKS
      if (getenv("FPLAN_TEST_PL_SHIFT")) { mut_on = true; }  // TEST-ONLY red mutant (test build only)
#endif
      if (mut_on) {  // TEST-ONLY red mutant: each link moved to the next owner of the same width (wrong values)
        std::map<int64_t, std::vector<size_t>> byw; for (size_t q = 0; q < add.size(); q++) byw[idbits[add[q].first]].push_back(q);
        std::vector<std::pair<uint64_t, uint64_t>> m = add;
        for (auto& g : byw) for (size_t q = 0; q < g.second.size(); q++) m[g.second[q]].second = add[g.second[(q + 1) % g.second.size()]].second;
        for (size_t q = 0; q < add.size(); q++) if (m[q].second != add[q].second) mut_moved++;
        add.swap(m);
      }
      for (auto& x : add) { decl.plain[x.first] = x.second; used++; }
    }
    res.pl_json_scope = opt.full_scope ? "declared by the producer (--full-scope-dump)" : "not declared: no port copy linked";
    res.pl_json_force = fl_state == "none" ? "none given" : fl_state == "unusable" ? "unusable: " + fl_why : "used: " + std::to_string(fl_targets) + " targets, " + std::to_string(forced) + " links refused";
    res.port_links = "PORTLINKS " + std::string(pl.why.empty() ? "decoded" : "none: " + pl.why) + " records " + std::to_string(pl.nrec) + " t0 " + std::to_string(pl.t0) +
                     " t1 " + std::to_string(pl.t1) + " identity " + std::to_string(pl.identity) + " linked " + std::to_string(used) + " carried_via_alias " + std::to_string(viaalias) + " own_stream_refused " + std::to_string(ownstream) + " own_stream_component_refused " + std::to_string(ownstream_comp) + " own_stream_file_refused " + std::to_string(ownfile) + " skipped " + std::to_string(skipped) + " name_collision " + std::to_string(collide) + " width_mismatch " + std::to_string(widthmis) +
                     " held_unproven " + std::to_string(pl.held_unproven) + " no_path " + std::to_string(pl.refused_nopath) + " multi_owner " + std::to_string(pl.refused_multi) +
                     " x_nonzero_refused " + std::to_string(pl.x_nonzero) +
                     " full_scope " + std::string(opt.full_scope ? "declared" : "not_declared") + " no_full_scope_refused " + std::to_string(noscope) +
                     " force_log " + fl_state + " force_targets " + std::to_string(fl_targets) + " force_events " + std::to_string(fl_events) +
                     " rule_exact " + std::to_string(fl_rule["exact"]) + " rule_base_vector " + std::to_string(fl_rule["base_vector"]) +
                     " rule_enclosing_scope " + std::to_string(fl_rule["enclosing_scope"]) + " rule_whole_file " + std::to_string(fl_rule["whole_file"] + (fl_state == "unusable" ? 1 : 0)) +
                     " forced_refused " + std::to_string(forced) + " force_whole_file_refused " + std::to_string(wholefile) +
                     " late_scope_refused " + std::to_string(late_scope) + " late_member_refused " + std::to_string(late_member) +
                     (fl_why.empty() ? std::string() : " force_log_error \"" + fl_why + "\"") +
                     std::string() + (mut_on ? " TEST_MUTANT_moved " + std::to_string(mut_moved) : std::string()) + (noguard ? " TEST_NOGUARD own_stream_guard_off" : "");
  }
  const auto& S = decl.sig;
  if (opt.ids) {  // --ids: declaration-order id map (decl_index idcode resolved field_id bits left right full_name)
    res.ids = "# FSIDS1 columns=decl_index idcode resolved field_id bits left right full_name\n";
    for (size_t i = 0; i < S.size(); ++i)  // package rows: idcode 0 / resolved 0 (no value ID linked)
      res.ids += std::to_string(i) + "\t" + std::to_string(S[i].id) + "\t" + std::to_string(S[i].pkg ? 0 : resolve_alias(decl.plain, S[i].id)) + "\t" + std::to_string(S[i].field_id) + "\t" +
                 std::to_string(S[i].bits) + "\t" + std::to_string(S[i].left) + "\t" + std::to_string(S[i].right) + "\t" + sig_full(decl, S[i]) + "\n";
  }
  auto in_loc = [&](uint64_t id) { return amap.has(id) || loc.has_latest(id); };
  auto logical_of = [&](uint64_t id) { return amap.has(id) ? amap.at(id) : loc.latest[id]; };
  auto is_string = [&](const Sig& s) { return s.bits == 0 && s.field_id == 19; };
  auto nonbit_skip = [&](const Sig& s) -> const char* { if (s.bits) return nullptr; if (s.field_id == 19) return STRING_SKIP; if (s.field_id == 16) return REAL_SKIP; if (s.field_id == 20) return EVENT_SKIP; if (s.field_id == CLASS_FID || (s.field_id >= 0 && decl.class_fids.count(uint64_t(s.field_id)))) return CLASS_SKIP; return nullptr; };

  rss_mark("classify");
  // classify
  Groups gsig; std::vector<std::pair<uint64_t, uint32_t>> gent;  // value ID -> declarations, first-appearance order
  const std::vector<uint64_t>& gid = gsig.key;
  std::vector<std::pair<std::string, uint32_t>> refusals;  // (reason, signal index)
  auto copy_values = [&](uint64_t id) { uint64_t z = resolve_alias(decl.plain, id); return (amap.has(z) || loc.has_latest(z)) && (amap.has(z) ? amap.at(z) : loc.latest[z]) != 0; };
  uint64_t copy_refused = 0, copy_checked = 0, n_enum = 0, n_dtund = 0;
  for (uint32_t i = 0; i < S.size(); i++) {
    if (S[i].pkg) { refusals.push_back({S[i].big ? big_reason(S[i].big) : std::string(S[i].why ? S[i].why : PKG_SKIP), i}); continue; }
    if (S[i].dtype > 0) { refusals.push_back({decl.dtype_why[size_t(S[i].dtype - 1)], i}); continue; }
    if (S[i].dtype < -2) { refusals.push_back({std::string(DTYPE_SKIP) + " (datatype reference not resolved)", i}); continue; }  // never carried by default
    if (!decl.plain_copies.empty()) {
      auto pc = decl.plain_copies.find(i);
      if (pc != decl.plain_copies.end()) {
        bool own = false; for (uint64_t x : pc->second) { copy_checked++; if (copy_values(x)) own = true; }
        if (own) { copy_refused++; refusals.push_back({"list-dump copy: an earlier declaration of this name carries values of its own", i}); continue; }
      }
    }
    if (S[i].field_id == CLASS_FID || (S[i].field_id >= 0 && decl.class_fids.count(uint64_t(S[i].field_id))) ||
        under_class_root(decl, S[i])) {
      const char* why = S[i].ctag == 0xda ? CLASS_INST : S[i].ctag == 0xd9 ? CLASS_MEMBER : S[i].ctag == 0x3f ? CLASS_HANDLE : CLASS_SKIP;
      if (!(FPLAN_TEST_ENV("FPLAN_TEST_CLASS_DROP") && S[i].ctag == 0xd9)) refusals.push_back({why, i});  // TEST-ONLY mutant: member rows dropped silently
      continue; }  // class objects (any var under the class-object roots): never grouped with value IDs
    gent.push_back({S[i].id, i});
  }
  rss_mark("classify_sigs");
  gsig.build(gent, T);
  rss_mark("classify_groups");
  // Class-object layout (field tags 0x19 / 0 / 2 present). unreferenced value IDs = value-carrying native IDs that no
  // declaration references. No ordinary tree variable, or more than half the value IDs unreferenced: the file's other
  // variables are stored somewhere not decoded yet, so the whole file is refused instead of emitting an inventory that
  // looks complete. Any unreferenced value ID otherwise: PARTIAL with the count (label below).
  uint64_t uv_with = 0, uv_orph = 0;
  if (!decl.class_fids.empty()) {
    std::unordered_set<uint64_t> ref; for (auto& sg : S) if (sg.id) ref.insert(resolve_alias(decl.plain, sg.id));
    const bool keep = !(FPLAN_TEST_ENV("FPLAN_TEST_UNREF_ROWS") && !strcmp(FPLAN_TEST_ENV("FPLAN_TEST_UNREF_ROWS"), "drop"));  // TEST-ONLY red: drop the rows
    for (uint64_t i = 1; i < loc.latest.size(); i++) if (loc.latest[i]) { uv_with++; if (!ref.count(i)) { uv_orph++; if (keep) res.unref_ids.push_back(i); } }
    const char* um = FPLAN_TEST_ENV("FPLAN_TEST_UNREF");  // TEST-ONLY red mutants: "tree" = pretend tree vars exist; "tree-nohalf" = also skip the >50% rule
    const bool um_tree = um && !strncmp(um, "tree", 4), um_nohalf = um && !strcmp(um, "tree-nohalf");
    if (!decl.n_tree && !um_tree)
      throw ParseError("tb variables not located (class-object layout): 0 ordinary variables declared; " + u2s(uv_orph) + " of " + u2s(uv_with) +
                       " value-carrying IDs unreferenced");
    if (2 * uv_orph > uv_with && !um_nohalf)
      throw ParseError("unreferenced value IDs (class-object layout): " + u2s(uv_orph) + " of " + u2s(uv_with) + " value-carrying IDs have no declaration (more than half)");
  }
  // A later directory that declares nothing can still introduce value IDs. In such a file every value-carrying ID that
  // no declaration references has no name: it is listed by ID (unreferenced_value_ids), never dropped silently.
  uint64_t ue_orph = 0; std::map<size_t, uint64_t> dir_listed;  // per skipped directory: its IDs listed by ID
  if ((decl.empty_dir || !decl.skipped_dirs.empty()) && decl.class_fids.empty()) {
    std::unordered_set<uint64_t> ref; for (auto& sg : S) if (sg.id) ref.insert(resolve_alias(decl.plain, sg.id));
    for (uint64_t i = 1; i < loc.latest.size(); i++) if (loc.latest[i] && !ref.count(i)) {
      ue_orph++; res.unref_ids.push_back(i);
      for (auto& sd : decl.skipped_dirs) if (i >= sd.lo && i < sd.hi) { res.unref_dir.push_back({i, "tree directory " + u2s(sd.k) + " not read: " + sd.why}); dir_listed[sd.k]++; break; }
    }
  }
  std::unordered_set<uint32_t> excluded_sig;  // signal indices refused through Options::exclude_streams
  Groups phys; std::vector<std::pair<uint64_t, uint32_t>> pent;  // stream_id -> groups, first-appearance order
  for (uint32_t g = 0; g < gid.size(); g++) {
    uint64_t stream_id = resolve_alias(decl.plain, gid[g]);
    if (loc.flagged.count(stream_id)) { for (auto s : gsig[g]) refusals.push_back({FLAGS_SKIP, s}); continue; }
    if (!in_loc(stream_id)) { for (auto s : gsig[g]) refusals.push_back({"no supported physical index", s}); continue; }
    uint64_t logical = logical_of(stream_id);
    if (decl.fdefs && !logical) { for (auto s : gsig[g]) refusals.push_back({NOINDEX, s}); continue; }
    pent.push_back({stream_id, g});
  }
  rss_mark("classify_streams_of");
  phys.build(pent, T);
  rss_mark("classify_phys");
  std::vector<Stream> streams; std::vector<std::string> text_table; bool text_loaded = false; (void)text_loaded;
  std::vector<std::pair<uint64_t, std::string>> typed_why;  // DIAGNOSTIC: typed streams left refused (stream id, why)
  if (opt.typed) res.typed = "FSTYPED1\n";
  std::vector<uint32_t> sdecl;  // every stream's declarations, one array (Stream::decls)
  for (uint32_t pg = 0; pg < phys.size(); pg++) {
    const std::pair<uint64_t, U32Span> ph{phys.key[pg], phys[pg]};
    uint32_t repg = ph.second[0]; std::vector<uint32_t> decls;
    for (auto g : ph.second) decls.insert(decls.end(), gsig[g].begin(), gsig[g].end());
    int64_t bits = S[gsig[repg][0]].bits;
    if (!bits && opt.typed && (S[decls[0]].field_id == 16 || S[decls[0]].field_id == 19)) {  // real / string values
      std::string why; std::string out = typed_stream(loc, tables, r, H, text_table, S, decl, decls, logical_of(ph.first), S[decls[0]].field_id, why);
      if (why.empty()) { res.typed += out; res.typed_vars += decls.size(); continue; }
      typed_why.push_back({ph.first, why});
    }
    if (!bits) { for (auto s : decls) { const char* k = nonbit_skip(S[s]); refusals.push_back({k ? k : "non-bit width", s}); } continue; }
    Stream sm; sm.rep = gid[repg]; sm.stream_id = ph.first; sm.logical = logical_of(ph.first);
    sm.db = sdecl.size();
    for (auto s : decls) { if (S[s].bits != bits) refusals.push_back({"alias width mismatch", s}); else { sdecl.push_back(s); sm.decls.n++; } }
    streams.push_back(sm);
  }
  for (auto& sm : streams) sm.decls.p = sdecl.data() + sm.db;  // sdecl is complete: no reallocation after this
  phys = Groups();
  if (opt.has_select_ids) {
    std::unordered_set<uint64_t> sel(opt.select_ids.begin(), opt.select_ids.end());
    std::vector<uint64_t> missing;
    for (auto x : sel) if (gsig.find(x) == Groups::NONE) missing.push_back(x);
    std::sort(missing.begin(), missing.end());
    if (!missing.empty()) throw ParseError("plan3: --select-ids lists " + u2s(missing.size()) + " undeclared IDs (first " + py_list5(missing) + ")");
    std::vector<Stream> keep;
    for (auto& sm : streams) { bool any = false; for (auto s : sm.decls) if (sel.count(S[s].id)) { any = true; break; } if (any) keep.push_back(std::move(sm)); }
    streams.swap(keep);
    std::vector<std::pair<std::string, uint32_t>> rk;
    for (auto& x : refusals) if (sel.count(S[x.second].id)) rk.push_back(x);
    refusals.swap(rk);
  }
  mark("classify");

  rss_mark("scope_tokens");
  // scope component tokens per interned scope (scope_components minus the per-signal hierarchy check)
  ErrTab ET, SET; ScopeToks stok;  // SET: scope-token errors, complete before the stream walk reads them
  {
    const ScopeTab& SC = decl.scopes; const size_t nrec = SC.rname.size(), nch = (nrec + ScopeToks::CH - 1) / ScopeToks::CH;
    stok.arena.resize(nch); stok.off.resize(nch); stok.rerr.assign(nrec, 0);
    pfor(nch, T, 1, [&](size_t c, int) {
      size_t b = c * ScopeToks::CH, e = std::min(nrec, b + ScopeToks::CH); std::string& A = stok.arena[c]; auto& O = stok.off[c]; O.reserve(e - b + 1);
      for (size_t a = b; a < e; a++) {
        O.push_back(uint32_t(A.size()));
        std::string t; Err x = capture([&] { t = token(SC.rname[a], false, "scope component"); });
        if (x) stok.rerr[a] = SET.add(std::move(x)); else A += t;
      }
      O.push_back(uint32_t(A.size()));
    });
    const size_t ns = SC.size(); stok.err.assign(ns, 0); stok.jlen.assign(ns, 0); stok.nparts.assign(ns, 0);
    pfor(ns, T, 64, [&](size_t i, int) {
      // same checks and order as before: ambiguous, then the part count, then the first bad token from the root
      if (SC.ambiguous[i]) { stok.err[i] = SET.add(capture([&] { throw ParseError("plan: ambiguous recovered scope"); })); return; }
      thread_local std::vector<uint32_t> ch; ch.clear();
      for (int32_t a = int32_t(SC.first[i]); a >= 0 && ch.size() <= MAX_SCOPES; a = SC.parent[a]) ch.push_back(uint32_t(a));
      if (!(1 <= ch.size() && ch.size() <= MAX_SCOPES)) { stok.err[i] = SET.add(capture([&] { throw ParseError("plan: scope count limit"); })); return; }
      uint32_t jl = 0;
      for (size_t q = ch.size(); q-- > 0;) { if (stok.rerr[ch[q]]) { stok.err[i] = stok.rerr[ch[q]]; return; } jl += 1 + uint32_t(stok.tok(ch[q]).size()); }
      stok.nparts[i] = int32_t(ch.size()); stok.jlen[i] = jl;
    });
  }
  // per thread, the last scope written is kept (declarations of one scope are mostly adjacent in plan order); the
  // build generation keeps a cached form from ever crossing into another build in the same process
  static std::atomic<uint64_t> build_gen{0}; const uint64_t my_gen = ++build_gen;
  auto put_joined = [&, my_gen](std::string& o, uint32_t sc) {
    struct Last { uint64_t gen = 0; uint32_t sc = 0; std::string j; };
    thread_local Last last;
    if (last.gen != my_gen || last.sc != sc) {
      thread_local std::vector<uint32_t> ch; ch.clear();
      for (int32_t a = int32_t(decl.scopes.first[sc]); a >= 0; a = decl.scopes.parent[a]) ch.push_back(uint32_t(a));
      last.j.clear(); for (size_t q = ch.size(); q-- > 0;) { last.j += ' '; last.j += stok.tok(ch[q]); }
      last.gen = my_gen; last.sc = sc;
    }
    o += last.j;
  };
  auto put_tail = [&](std::string& o, const std::vector<std::string>& dp) {
    for (size_t q = 0; q + 1 < dp.size(); q++) { o += ' '; o += token(dp[q], false, "variable name scope part"); }
    o += ' '; o += token(dp.back(), true, "variable name");
  };
  auto decl_tok = [&](uint32_t si, DeclTok& d) {
    d.err = ET.add(capture([&] {
      const Sig& s = S[si];
      if (s.bits < 0 || s.bits > (int64_t(1) << 20)) throw ParseError("plan: invalid width");
      const int64_t lim = int64_t(1) << 31;
      if (!(-lim <= s.left && s.left < lim) || !(-lim <= s.right && s.right < lim) || s.bits < 1 || s.bits != (s.left > s.right ? s.left - s.right : s.right - s.left) + 1) throw ParseError("plan: declaration bounds");
      if (stok.err[s.scope]) SET[stok.err[s.scope]].raise();
      const int32_t sc_nparts = stok.nparts[s.scope];
      // (a declaration's full name is its scope's full name + "." + its name by construction; no stored copy to check)
      // a declared name may carry generate hierarchy ("gen_tree[4].gen_level[0].C1[31:0]"): the dotted prefix becomes scope components
      std::vector<std::string> dp = dotted_parts(s.name);
      thread_local std::string tl; tl.clear();
      for (size_t q = 0; q + 1 < dp.size(); q++) { tl += ' '; tl += token(dp[q], false, "variable name scope part"); }
      if (sc_nparts + dp.size() - 1 > MAX_SCOPES) throw ParseError("plan: scope count limit");
      tl += ' '; tl += token(dp.back(), true, "variable name");
      d.nparts = sc_nparts + int(dp.size()) - 1; d.tail_len = uint32_t(tl.size());
    }));
  };
  auto head_len = [&](uint32_t si, const DeclTok& d) -> uint64_t {
    const Sig& s = S[si];
    return ndi(s.bits) + 1 + ndi(s.left) + 1 + ndi(s.right) + 1 + ndi(d.nparts) + stok.jlen[s.scope] + d.tail_len;
  };
  auto put_head = [&](std::string& o, uint32_t si, const DeclTok& d) {
    const Sig& s = S[si];
    puti(o, s.bits); o += ' '; puti(o, s.left); o += ' '; puti(o, s.right); o += ' '; puti(o, d.nparts); put_joined(o, s.scope);
    put_tail(o, dotted_parts(s.name));  // the declaration checked clean in decl_tok, so token() does not throw here
  };
  auto head_of = [&](uint32_t si, const DeclTok& d) { std::string o; o.reserve(head_len(si, d)); put_head(o, si, d); return o; };

  rss_mark("stream_walk");
  // Walk every candidate stream in full mode (records_from_logical) and format its V/R lines.
  std::vector<StreamOut> so(streams.size());
  std::vector<TextArena> tarena(static_cast<size_t>(T));  // R text per walk thread
  std::vector<std::vector<PlanRec>> sorecs(opt.emit_struct ? streams.size() : 0);  // struct-plan records per stream
  DeclToks dtok; dtok.off.resize(streams.size() + 1, 0);
  for (size_t k = 0; k < streams.size(); k++) dtok.off[k + 1] = dtok.off[k] + streams[k].decls.size();
  dtok.v.resize(dtok.off.back());
  const uint64_t nper = loc.periods.size(), nindex = loc.index_blk.size(), nbus = loc.bus.size();
  // bus starts of successfully walked streams, per (thread, partition); every status-0 stream is a good stream
  std::vector<std::vector<uint64_t>> wb(size_t(T) * NP);
  auto bpart = [&](uint64_t bus_block) -> size_t { return size_t(bus_block * NP / std::max<uint64_t>(nbus, 1)); };
  pfor(streams.size(), T, 16, [&](size_t k, int tid) {
    thread_local std::vector<Rec> recs;
    Stream& sm = streams[k]; StreamOut& o = so[k];
    auto ex = opt.exclude_streams.find(sm.stream_id);
    if (ex != opt.exclude_streams.end()) { o.status = 3; o.err = ET.msg(ex->second); return; }
    Err e = capture([&] { walk(loc, sm.logical, false, opt.accept_derived, recs, o.has_derived, o.derived); });
    if (e) { o.status = e.kind == 1 ? 1 : 2; o.err = ET.msg(e.kind == 1 ? refusal_reason(e.msg) : e.msg); if (e.kind == 3) o.status = 4; return; }
    if (!recs.empty() && !loc.periods.empty() && rec_first_t(loc, recs[0]) > loc.periods[0].begin) o.late = true;
    for (size_t j = 0; j < sm.decls.size(); j++) decl_tok(sm.decls[j], dtok[k][j]);
    o.nrec = recs.size();
    const bool TX = opt.emit_text, SP = opt.emit_struct;
    thread_local std::string tbuf; tbuf.clear(); std::string& t = tbuf;
    const DeclTok& p = dtok[k][0]; uint64_t tl = 0, vl = 0;
    // the V line is rendered at assembly (put_head); o.text holds the R lines only
    if (!p.err) { vl = 2 + nd(sm.rep) + 1 + head_len(sm.decls[0], p) + 1 + nd(recs.size()) + 1; tl += vl; }
    std::vector<PlanRec>* orecs = SP ? &sorecs[k] : nullptr; if (SP) orecs->reserve(recs.size());
    for (auto& rc : recs) {
      if (o.rerr) break;
      o.rerr = ET.add(capture([&] {
        if (rc.period > nper - 1) throw ParseError("plan: invalid record period");
        if (rc.count > 0xffffffffu) throw ParseError("plan: invalid record count");
        if (!rc.count) throw ParseError("plan: empty record");
        if (rc.kind == K_SCALAR || rc.kind == K_BUSINLINE) {
          if (rc.index_block > nindex - 1) throw ParseError("plan: invalid index block");
          if (rc.off > 65535) throw ParseError("plan: invalid inline offset");
          if (loc.index_blk[rc.index_block].period != rc.period) throw ParseError("plan: inline period mismatch");
          if (TX) { t += rc.kind == K_SCALAR ? "R S " : "R I "; put(t, rc.period); t += ' '; put(t, rc.count); t += ' '; put(t, rc.index_block); t += ' '; put(t, rc.off); t += " 0 0 0 0\n"; }
          tl += 4 + nd(rc.period) + 1 + nd(rc.count) + 1 + nd(rc.index_block) + 1 + nd(rc.off) + 9;
          if (SP) orecs->push_back({rc.kind == K_SCALAR ? 'S' : 'I', rc.period, rc.count, uint32_t(rc.index_block), uint32_t(rc.off), 0, 0, 0, 0});
        } else if (rc.kind == K_BUS) {
          if (rc.bus_block > nbus - 1) throw ParseError("plan: invalid bus block");
          if (rc.off > 65535) throw ParseError("plan: invalid bus offset");
          const Period& ss = loc.periods[rc.period];
          if (!(ss.begin <= rc.begin && rc.begin <= rc.end && rc.end <= ss.end)) throw ParseError("plan: record outside period");
          if (TX) { t += "R B "; put(t, rc.period); t += ' '; put(t, rc.count); t += " 0 0 "; put(t, rc.bus_block); t += ' '; put(t, rc.off); t += ' '; put(t, rc.begin); t += ' '; put(t, rc.end); t += '\n'; }
          tl += 4 + nd(rc.period) + 1 + nd(rc.count) + 5 + nd(rc.bus_block) + 1 + nd(rc.off) + 1 + nd(rc.begin) + 1 + nd(rc.end) + 1;
          if (SP) orecs->push_back({'B', rc.period, rc.count, 0, 0, uint32_t(rc.bus_block), uint32_t(rc.off), rc.begin, rc.end});
        } else throw ParseError("plan: unsupported record kind");
      }));
    }
    o.textlen = TX ? t.size() + vl : tl;
    if (TX) { o.tp = tarena[size_t(tid)].put(t); o.tlen = uint32_t(t.size()); }  // the per-thread buffer is reused
    for (auto& rc : recs) if (rc.kind == K_BUS) wb[size_t(tid) * NP + bpart(rc.bus_block)].push_back(rc.bus_block * 65536 + rc.off);
  });
  mark("walk");

  rss_mark("stream_loop");
  // Stream loop in plan order.
  std::vector<size_t> good; std::vector<Derived> derived;
  for (size_t k = 0; k < streams.size(); k++) {
    StreamOut& o = so[k]; Stream& sm = streams[k];
    const std::string& oerr = ET[o.err].msg;
    if (o.status == 3) { for (auto s : sm.decls) { refusals.push_back({oerr, s}); excluded_sig.insert(s); } continue; }  // the caller's reason, as given
    if (o.status == 2) throw DecodeError(oerr);
    if (o.status == 4) throw OtherError(oerr);
    if (o.status == 1) { for (auto s : sm.decls) refusals.push_back({"records: " + oerr, s}); continue; }
    if (o.has_derived) for (auto s : sm.decls) derived.push_back({S[s].id, sm.stream_id, o.derived, sig_full(decl, S[s])});
    if (o.has_derived && !opt.derived_prefix) { for (auto s : sm.decls) refusals.push_back({DERIVED_SKIP, s}); continue; }
    if (o.late) { for (auto s : sm.decls) refusals.push_back({LATE_SKIP, s}); continue; }
    {
      auto name_err = [&](const DeclTok& d) { const Err& x = ET[d.err]; return x.kind == 1 && x.msg.compare(0, strlen(NAME_PREFIX), NAME_PREFIX) == 0; };
      auto dt = dtok[k];
      if (FPLAN_TEST_ENV("FPLAN_TEST_NAMEREFUSE") && !strcmp(FPLAN_TEST_ENV("FPLAN_TEST_NAMEREFUSE"), "whole")) {}  // TEST-ONLY red: the old whole-file refusal
      else if (name_err(dt[0])) {
        for (size_t j = 0; j < sm.decls.size(); j++) refusals.push_back({name_err(dt[j]) ? ET[dt[j].err].msg.substr(6) : std::string(NAME_SHARED), sm.decls[j]});
        continue;
      } else for (size_t j = 1; j < sm.decls.size(); j++) if (name_err(dt[j])) { refusals.push_back({ET[dt[j].err].msg.substr(6), sm.decls[j]}); dt[j].refused = true; }
    }
    good.push_back(k);
  }
  // An assertion declaration has no value kind: it is refused by name (ASSERT_SKIP, in the undeclared list and the label),
  // like string / real / event vars, and the rest of the file is planned. TEST-ONLY red (FPLAN_TEST_ASSERT_BLOCK=1): an
  // assertion blocks the strict plan again (the old whole-file refusal).
  const bool assert_blocks = FPLAN_TEST_ENV("FPLAN_TEST_ASSERT_BLOCK") != nullptr;
  // A declaration refused on its own (its stored history starts after the dump start, LATE_SKIP; or its name spelling is
  // refused, with the names sharing its values) is refused by name on the strict route too: the rest of the file is
  // planned, so the side step keeps the file's other computed names. TEST-ONLY red (FPLAN_TEST_ONENAME_BLOCK=1): such a
  // declaration blocks the strict plan again (the old whole-file refusal).
  const bool onename_blocks = FPLAN_TEST_ENV("FPLAN_TEST_ONENAME_BLOCK") != nullptr;
  static const char* const NAME_REASON = NAME_PREFIX + 6;  // "ambiguous/unsupported ...", as pushed above (prefix "plan: " dropped)
  auto onename_reason = [&](const std::string& r) { return r == LATE_SKIP || r == NAME_SHARED || r.compare(0, strlen(NAME_REASON), NAME_REASON) == 0; };
  auto blocking_count = [&]() {
    std::map<std::string, uint64_t> c;
    for (auto& x : refusals) if (x.first != STRING_SKIP && x.first != REAL_SKIP && x.first != EVENT_SKIP && x.first != DERIVED_SKIP && x.first != NOINDEX && x.first != PKG_SKIP && !class_reason(x.first) && x.first != FLAGS_SKIP && (assert_blocks || x.first != ASSERT_SKIP) && (onename_blocks || !onename_reason(x.first))) c[x.first]++;
    return c;
  };
  if (!opt.allow_partial) {
    auto c = blocking_count();
    if (!c.empty()) {
      std::string m = "plan3: refused declarations: "; bool first = true;
      for (auto& kv : c) { if (!first) m += "; "; first = false; m += kv.first + " x" + u2s(kv.second); }
      throw ParseError(m);
    }
  }
  if (good.empty()) throw ParseError("plan3: no plannable stream");

  rss_mark("export_plan");
  // ---- export_plan (base FSRAWPLAN2)
  int scale = scale_exponent(H.scale); res.scale_exponent = scale;
  uint64_t fbegin = H.min_ticks, fend = H.max_ticks;
  if (fbegin > fend) throw ParseError("plan: reversed file time bounds");
  for (size_t k : good) {
    uint64_t ident = streams[k].rep;
    if (ident > 0xffffffffu) throw ParseError("plan: invalid selected ID");
    const uint32_t gx = gsig.find(ident); if (gx == Groups::NONE) throw OtherError("plan: selected ID has no group");
    const U32Span group = gsig[gx];
    int64_t b0 = S[group[0]].bits; bool mixed = false;
    for (auto s : group) if (S[s].bits != b0) mixed = true;
    if (mixed || !b0) throw ParseError("plan: selected ID has ambiguous/non-bit width " + u2s(ident));
    const uint32_t gi = gsig.find(streams[k].stream_id);
    if (gi != Groups::NONE) for (auto s : gsig[gi]) if (S[s].bits != b0) throw ParseError("plan: ordinary alias width mismatch");
  }
  // windows: selected bus starts vs the authoritative index of every index head (topology walk). Starts are bucketed
  // by bus-block range; bus blocks are numbered in period order, so the partitions in order are the (period, start)
  // order Python sorts by, and each partition is sorted/searched independently.
  std::vector<std::array<uint64_t, 3>> windows;
  bool any_wanted = false;
  for (auto& v : wb) if (!v.empty()) { any_wanted = true; break; }
  if (any_wanted) {
    std::vector<uint64_t> heads;
    for (size_t i = 1; i < loc.latest.size(); i++) heads.push_back(loc.latest[i]);
    for (size_t i = 0; i < amap.active.size(); i++) if (amap.active[i]) heads.push_back(amap.logical[i]);
    psort(heads, T); heads.erase(std::unique(heads.begin(), heads.end()), heads.end());
    std::vector<std::vector<uint64_t>> tb(size_t(T) * NP);
    std::vector<Err> herr(heads.size()); std::atomic<bool> anyerr{false};
    pfor(heads.size(), T, 16, [&](size_t i, int tid) {
      thread_local std::vector<Rec> recs; bool hd; uint64_t dv;
      herr[i] = capture([&] { walk(loc, heads[i], true, opt.accept_derived, recs, hd, dv); });
      if (herr[i]) { anyerr = true; return; }
      for (auto& rc : recs) if (rc.kind == K_BUS) tb[size_t(tid) * NP + bpart(rc.bus_block)].push_back(rc.bus_block * 65536 + rc.off);
    });
    if (anyerr) for (auto& e : herr) if (e) e.raise();  // heads are sorted: first error = Python's first
    mark("topo");
    std::vector<std::vector<uint64_t>> wp(NP), pp(NP);
    pfor(NP, T, 4, [&](size_t p, int) {
      for (int pass = 0; pass < 2; pass++) {
        auto& src = pass ? tb : wb; auto& dst = pass ? pp[p] : wp[p]; size_t c = 0;
        for (int t = 0; t < T; t++) c += src[size_t(t) * NP + p].size();
        dst.reserve(c);
        for (int t = 0; t < T; t++) { auto& v = src[size_t(t) * NP + p]; dst.insert(dst.end(), v.begin(), v.end()); std::vector<uint64_t>().swap(v); }
        std::sort(dst.begin(), dst.end()); dst.erase(std::unique(dst.begin(), dst.end()), dst.end());
      }
    });
    std::vector<uint64_t> last_bus(nper, ~uint64_t(0));
    for (size_t i = 0; i < loc.bus.size(); i++) last_bus[loc.bus[i].period] = i;
    std::vector<size_t> woff(NP + 1, 0); std::vector<uint64_t> nextfirst(NP + 1, ~uint64_t(0));
    for (size_t p = 0; p < NP; p++) woff[p + 1] = woff[p] + wp[p].size();
    for (size_t p = NP; p-- > 0;) nextfirst[p] = pp[p].empty() ? nextfirst[p + 1] : pp[p][0];
    windows.resize(woff[NP]);
    std::vector<Err> perr(NP);
    pfor(NP, T, 4, [&](size_t p, int) {
      perr[p] = capture([&] {
        const auto& pts = pp[p]; uint64_t after = nextfirst[p + 1];
        for (size_t i = 0; i < wp[p].size(); i++) {
          uint64_t ws = wp[p][i]; uint32_t pidx = loc.bus[ws >> 16].period;
          auto it = std::upper_bound(pts.begin(), pts.end(), ws);
          if (it == pts.begin() || *(it - 1) != ws) throw ParseError("plan: selected stream missing from authoritative index");
          uint64_t nx = it != pts.end() ? *it : after, we;
          if (nx != ~uint64_t(0) && loc.bus[nx >> 16].period == pidx) we = nx;
          else { if (last_bus[pidx] == ~uint64_t(0)) throw OtherError(u2s(pidx)); we = (last_bus[pidx] + 1) * 65536; }
          windows[woff[p] + i] = {pidx, ws, we};
        }
      });
    });
    for (auto& e : perr) if (e) e.raise();
  }
  mark("windows");
  if (windows.size() > MAX_WINDOWS) throw ParseError("plan: window count limit");
  if (!(1 <= good.size() && good.size() <= MAX_COUNT) || !(1 <= nper && nper <= MAX_COUNT)) throw ParseError("plan: count limit");
  if (tables.start.size() - 1 != nper) throw ParseError("plan: period/dictionary mismatch");
  if (nbus > MAX_BLOCKS || nindex > MAX_BLOCKS) throw ParseError("plan: block count limit");
  {
    uint64_t total = 0;
    for (size_t i = 0; i < nper; i++) {
      const Period& s = loc.periods[i];
      if (!(fbegin <= s.begin && s.begin <= s.end && s.end <= fend)) throw ParseError("plan: period outside file range");
      total += tables.start[i + 1] - tables.start[i];
      if (total > MAX_TOTAL_DELTAS) throw ParseError("plan: delta count limit");
    }
  }
  {  // V lines in order: per-signal checks, duplicate primaries, record total, record checks
    const SigNameKey nk{&S}; SigNameSet names(good.size(), nk); uint64_t total = 0;
    const std::vector<uint32_t> nh = names.homes(good.size(), [&](size_t i) { return streams[good[i]].decls[0]; }, nk, T);
    constexpr size_t PF = 32;  // probe-ahead distance
    for (size_t i = 0; i < good.size(); i++) {
      const size_t k = good[i];
      if (i + PF < good.size()) names.prefetch(nh[i + PF]);
      const DeclTok& p = dtok[k][0];
      if (p.err) ET[p.err].raise();
      auto& sl = names.at_slot(streams[k].decls[0], nh[i], nk);
      if (sl.first != SigNameSet::EMPTY) throw ParseError("plan: duplicate full name");
      sl.first = streams[k].decls[0];
      total += so[k].nrec;
      if (total > MAX_RECORDS) throw ParseError("plan: record count limit");
      if (so[k].rerr) ET[so[k].rerr].raise();
    }
  }
  crc_thread.join();
  mark("checks");

  rss_mark("text");
  // Header, B/C, T and W text (parallel chunks)
  std::string head = "FSRAWPLAN3\n";
  put(head, n); head += ' '; put(head, crc); head += ' '; puti(head, scale); head += ' '; put(head, fbegin); head += ' '; put(head, fend); head += ' ';
  put(head, nbus); head += ' '; put(head, nindex); head += ' '; put(head, nper); head += ' '; put(head, good.size()); head += ' '; put(head, windows.size()); head += '\n';
  const size_t BC = 65536; const bool TX = opt.emit_text;
  size_t nbc = TX ? (nbus + BC - 1) / BC : 0, ncc = TX ? (nindex + BC - 1) / BC : 0;
  std::vector<std::string> bc(nbc + ncc);
  pfor(bc.size(), T, 1, [&](size_t i, int) {
    bool isb = i < nbc; const auto& v = isb ? loc.bus : loc.index_blk; size_t b = (isb ? i : i - nbc) * BC, e = std::min(v.size(), b + BC);
    std::string& s = bc[i]; s.reserve((e - b) * 24);
    for (size_t j = b; j < e; j++) { s += isb ? "B " : "C "; put(s, v[j].offset); s += ' '; put(s, v[j].size); s += ' '; put(s, v[j].period); s += '\n'; }
  });
  std::vector<std::string> tl(TX ? nper : 0);
  pfor(tl.size(), T, 8, [&](size_t i, int) {
    std::string& s = tl[i]; size_t b = tables.start[i], e = tables.start[i + 1];
    s.reserve(32 + (e - b) * 8);
    s += "T "; put(s, loc.periods[i].begin); s += ' '; put(s, loc.periods[i].end); s += ' '; s += (b == e) ? '1' : '0'; s += ' '; put(s, e - b);
    for (size_t j = b; j < e; j++) { s += ' '; put(s, tables.vals[j]); }
    s += '\n';
  });
  const size_t WC = 65536; size_t nwc = TX ? (windows.size() + WC - 1) / WC : 0;
  std::vector<std::string> wl(nwc);
  pfor(nwc, T, 1, [&](size_t i, int) {
    std::string& s = wl[i]; size_t b = i * WC, e = std::min(windows.size(), b + WC); s.reserve((e - b) * 32);
    for (size_t j = b; j < e; j++) { s += "W "; put(s, windows[j][0]); s += ' '; put(s, windows[j][1]); s += ' '; put(s, windows[j][2]); s += '\n'; }
  });
  uint64_t base_size = head.size() + 2;  // + "E\n"
  for (auto& x : bc) base_size += x.size();
  for (auto& x : tl) base_size += x.size();
  for (auto& x : wl) base_size += x.size();
  for (size_t k : good) base_size += so[k].textlen;
  if (!TX) {  // the text the plan would have: same limits as the text path
    std::vector<uint64_t> part(size_t(T), 0);
    pfor(nbus + nindex, T, 4096, [&](size_t i, int tid) { const BlockDesc& b = i < nbus ? loc.bus[i] : loc.index_blk[i - nbus]; part[size_t(tid)] += 2 + nd(b.offset) + 1 + nd(b.size) + 1 + nd(b.period) + 1; });
    pfor(nper, T, 8, [&](size_t i, int tid) {
      size_t b = tables.start[i], e = tables.start[i + 1]; uint64_t L = 2 + nd(loc.periods[i].begin) + 1 + nd(loc.periods[i].end) + 3 + nd(e - b) + 1;
      for (size_t j = b; j < e; j++) L += 1 + nd(tables.vals[j]);
      part[size_t(tid)] += L;
    });
    pfor(windows.size(), T, 65536, [&](size_t j, int tid) { part[size_t(tid)] += 2 + nd(windows[j][0]) + 1 + nd(windows[j][1]) + 1 + nd(windows[j][2]) + 1; });
    for (auto x : part) base_size += x;
  }
  st += "base_plan_bytes=" + u2s(base_size) + " ";
  if (base_size > MAX_PLAN_BYTES) throw ParseError(plancap::refusal("plan: text size limit", base_size, MAX_PLAN_BYTES, cap_src, "FPLAN_MAX_PLAN_BYTES"));
  mark("format");

  rss_mark("plan3_extras");
  // ---- plan3 extras: every declaration of each good stream; duplicates merged / refused
  // seen: first declaration of each full name and its stream (the old (rep, bits, left, right) are read back from them)
  const SigNameKey sk{&S}; size_t ndecl = 0; for (size_t k : good) ndecl += streams[k].decls.size();
  SigNameSet seen(ndecl, sk);
  // A/D text per good stream: "A 0" for a stream with no aliases (xt[0]); others hold their own row
  std::vector<uint32_t> xid(streams.size(), 0); std::vector<std::string> xt(1, "A 0\n");
  auto extra_of = [&](size_t k) -> const std::string& { return xt[xid[k]]; };
  uint64_t merged = 0, nalias = 0;
  std::vector<std::vector<std::string>> alias_heads(opt.emit_struct ? streams.size() : 0);
  // home slots of every declaration of the good streams, in loop order (parallel), so the serial loop prefetches ahead
  std::vector<uint64_t> gdo(good.size() + 1, 0); for (size_t i = 0; i < good.size(); i++) gdo[i + 1] = gdo[i] + streams[good[i]].decls.size();
  std::vector<uint32_t> sh(ndecl);
  pfor(good.size(), T, 1024, [&](size_t i, int) { const auto& dl = streams[good[i]].decls; for (size_t j = 0; j < dl.size(); j++) sh[gdo[i] + j] = uint32_t(sk(dl[j]) & seen.mask); });
  size_t u = 0;  // position in sh
  // Options::emit_names: the names table, one slot per V / D line in this order (the V line is decls[0], the D lines the
  // kept declarations after the first), from the scope records and each name's dotted parts, as put_head writes them
  plannames::Names& NT = res.names; if (opt.emit_names) NT = plannames::Names();
  std::vector<uint32_t> recNode;  // scope record -> trie node (UINT32_MAX: not yet)
  auto nodeOfScope = [&](uint32_t sc) -> uint32_t {
    if (recNode.size() < decl.scopes.parent.size()) recNode.resize(decl.scopes.parent.size(), UINT32_MAX);
    thread_local std::vector<int32_t> up; up.clear();
    int32_t a = int32_t(decl.scopes.first[sc]);
    for (; a >= 0 && recNode[size_t(a)] == UINT32_MAX; a = decl.scopes.parent[size_t(a)]) up.push_back(a);
    uint32_t n = a >= 0 ? recNode[size_t(a)] : 0;
    for (size_t q = up.size(); q-- > 0;) { const std::string& c = decl.scopes.rname[size_t(up[q])]; n = NT.child(n, NT.intern(c)); recNode[size_t(up[q])] = n; }
    return n; };
  auto nameSlot = [&](uint32_t si) {
    const Sig& s = S[si]; uint32_t n = nodeOfScope(s.scope), lf;
    if (s.name.find('.') == std::string::npos || s.name[0] == '\\') lf = NT.intern(s.name);
    else { const auto dp = dotted_parts(s.name); for (size_t q = 0; q + 1 < dp.size(); q++) n = NT.child(n, NT.intern(dp[q])); lf = NT.intern(dp.back()); }
    if (NT.first_wide == UINT64_MAX && !(s.bits >= 0 && s.bits <= int64_t(UINT32_MAX) && s.left >= INT32_MIN && s.left <= INT32_MAX && s.right >= INT32_MIN && s.right <= INT32_MAX))
      NT.first_wide = NT.slots();  // (the head text would carry these numbers; the converter refuses them: check_plan says so here)
    NT.slot(n, lf, s.left, s.right, uint32_t(s.bits)); };
  for (size_t k : good) {
    std::vector<uint32_t> toks;
    for (size_t j = 0; j < streams[k].decls.size(); j++, u++) {
      if (u + 32 < ndecl) seen.prefetch(sh[u + 32]);
      const DeclTok& d = dtok[k][j];
      if (d.refused) continue;  // refused by name above
      if (d.err) ET[d.err].raise();
      uint32_t si = streams[k].decls[j]; const Sig& s = S[si];
      auto& sl = seen.at_slot(si, sh[u], sk);
      if (sl.first != SigNameSet::EMPTY) {
        const Sig& x = S[sl.first];
        if (streams[sl.second].rep == streams[k].rep && x.bits == s.bits && x.left == s.left && x.right == s.right) { merged++; continue; }
        if (!opt.allow_partial) throw ParseError("plan3: duplicate full name");
        refusals.push_back({"duplicate full name", si}); continue;
      }
      sl = {si, uint32_t(k)}; toks.push_back(uint32_t(j));
    }
    size_t na = toks.empty() ? 0 : toks.size() - 1;
    if (na) {
      xid[k] = uint32_t(xt.size()); xt.emplace_back(); std::string& e = xt.back();
      e += "A "; put(e, na); e += '\n'; nalias += na;
      for (size_t q = 1; q < toks.size(); q++) { e += "D "; put_head(e, streams[k].decls[toks[q]], dtok[k][toks[q]]); e += '\n'; }
    }
    if (opt.emit_names) { nameSlot(streams[k].decls[0]); for (size_t q = 1; q < toks.size(); q++) nameSlot(streams[k].decls[toks[q]]); NT.off.push_back(NT.slots()); }
    else if (opt.emit_struct) { auto& a = alias_heads[k]; for (size_t q = 1; q < toks.size(); q++) a.push_back(head_of(streams[k].decls[toks[q]], dtok[k][toks[q]])); }
  }
  std::vector<uint32_t>().swap(sh); std::vector<uint64_t>().swap(gdo);
  rss_mark("plan3_dups");
  std::string doff_text;  // "O <n>" + n R lines, before "E"; empty when the dump was never switched off (plan bytes unchanged)
  if (!doff_recs.empty()) {
    doff_text = "O "; put(doff_text, doff_recs.size()); doff_text += '\n';
    for (auto& rc : doff_recs) { doff_text += "R S "; put(doff_text, rc.period); doff_text += ' '; put(doff_text, rc.count); doff_text += ' '; put(doff_text, rc.index_block); doff_text += ' '; put(doff_text, rc.off); doff_text += " 0 0 0 0\n"; }
  }
  uint64_t total = base_size + doff_text.size();
  for (size_t k : good) total += extra_of(k).size();
  seen = SigNameSet(0, sk);
  if (total > MAX_PLAN_BYTES) throw ParseError(plancap::refusal("plan3: text size limit", total, MAX_PLAN_BYTES, cap_src, "FPLAN_MAX_PLAN_BYTES"));

  if (opt.emit_struct) {
    StructPlan& sp = res.sp; sp = StructPlan();
    sp.size = n; sp.crc = crc; sp.scale = scale; sp.tmin = fbegin; sp.tmax = fend; sp.text_bytes = total;
    for (auto& rc : doff_recs) sp.doff.push_back({'S', rc.period, rc.count, uint32_t(rc.index_block), uint32_t(rc.off), 0, 0, 0, 0});
    sp.bus.resize(nbus); sp.index_blk.resize(nindex); sp.periods.resize(nper); sp.windows.resize(windows.size()); sp.vars.resize(good.size());
    pfor(nbus + nindex, T, 65536, [&](size_t i, int) { const BlockDesc& b = i < nbus ? loc.bus[i] : loc.index_blk[i - nbus]; (i < nbus ? sp.bus[i] : sp.index_blk[i - nbus]) = {b.offset, b.size, b.period}; });
    pfor(nper, T, 8, [&](size_t i, int) {
      size_t b = tables.start[i], e = tables.start[i + 1];
      sp.periods[i].begin = loc.periods[i].begin; sp.periods[i].end = loc.periods[i].end; sp.periods[i].direct = b == e;
      sp.periods[i].delta.assign(tables.vals.begin() + b, tables.vals.begin() + e);
    });
    pfor(windows.size(), T, 65536, [&](size_t j, int) { sp.windows[j] = {uint32_t(windows[j][0]), windows[j][1], windows[j][2]}; });
    pfor(good.size(), T, 16, [&](size_t i, int) {
      size_t k = good[i]; const Sig& s = S[streams[k].decls[0]]; PlanVar& v = sp.vars[i];
      v.id = streams[k].rep; v.bits = uint32_t(s.bits); v.left = s.left; v.right = s.right;
      if (!opt.emit_names) { v.head = head_of(streams[k].decls[0], dtok[k][0]); v.aliases = std::move(alias_heads[k]); }
      v.recs = std::move(sorecs[k]);
    });
    mark("struct");
  }

  rss_mark("assemble");
  auto put_v = [&](std::string& v, size_t k) {
    v += "V "; put(v, streams[k].rep); v += ' '; put_head(v, streams[k].decls[0], dtok[k][0]); v += ' '; put(v, so[k].nrec); v += '\n';
  };
  // the streamed assembly runs on its own thread while the summary below is built (they read the same tables, and
  // write different Result fields); joined before "total", its error (if any) raised then
  std::thread asm_thr; std::exception_ptr asm_err;
  struct JoinA { std::thread& t; ~JoinA() { if (t.joinable()) t.join(); } } asm_join{asm_thr};
  if (TX && opt.plan_sink) {
    asm_thr = std::thread([&]() { try {
    // ---- assemble to the sink: in order, good streams rendered in parallel groups of at most ~16 MiB
    uint64_t sent = 0;
    auto send = [&](const char* p, size_t m) { if (m && !opt.plan_sink(p, m)) throw OtherError("plan: cannot write the plan"); sent += m; };
    send(head.data(), head.size());
    for (auto* g : {&bc, &tl, &wl}) for (auto& x : *g) { send(x.data(), x.size()); std::string().swap(x); }
    // two buffers: group g+1 is rendered while group g goes to the sink on its own thread (sink order kept)
    const size_t GB = size_t(16) << 20; std::string bufs[2]; std::vector<size_t> off; std::atomic<bool> vbad{false};
    std::thread wr; std::exception_ptr werr; int cur = 0;
    struct Join { std::thread& t; ~Join() { if (t.joinable()) t.join(); } } wr_join{wr};  // any exception: the writer finishes first
    auto wait_wr = [&]() { if (wr.joinable()) wr.join(); if (werr) std::rethrow_exception(werr); };
    for (size_t gi = 0; gi < good.size();) {
      size_t ge = gi, sz = 0; off.clear();
      while (ge < good.size() && (ge == gi || sz < GB)) { size_t k = good[ge]; off.push_back(sz); sz += so[k].textlen + extra_of(k).size(); ge++; }
      std::string& buf = bufs[cur];
      off.push_back(sz); buf.resize(sz);
      pfor(ge - gi, T, 256, [&](size_t i, int) {
        size_t k = good[gi + i]; thread_local std::string v; v.clear(); put_v(v, k);
        char* d = &buf[off[i]]; const std::string_view tx = so[k].text(); const size_t vl = so[k].textlen - tx.size();
        if (v.size() != vl) { vbad = true; return; }
        memcpy(d, v.data(), vl); memcpy(d + vl, tx.data(), tx.size()); const std::string& x = extra_of(k); memcpy(d + vl + tx.size(), x.data(), x.size());
      });
      if (vbad) { wait_wr(); throw OtherError("plan: V line length differs from its count"); }
      wait_wr();
      wr = std::thread([&, p = buf.data(), sz]() { try { send(p, sz); } catch (...) { werr = std::current_exception(); } });
      cur ^= 1; gi = ge;
    }
    wait_wr();
    std::string().swap(bufs[0]); std::string().swap(bufs[1]);
    send(doff_text.data(), doff_text.size()); send("E\n", 2);
    res.plan_bytes = sent;
    } catch (...) { asm_err = std::current_exception(); } });
  } else
  // ---- assemble (parallel copy)
  if (TX) {
  std::vector<std::pair<const char*, size_t>> pieces;
  pieces.push_back({head.data(), head.size()});
  for (auto& x : bc) pieces.push_back({x.data(), x.size()});
  for (auto& x : tl) pieces.push_back({x.data(), x.size()});
  for (auto& x : wl) pieces.push_back({x.data(), x.size()});
  // per good stream: a V-line slot (rendered in place below; data == nullptr) + its R text + its A/D text
  const size_t vfirst = pieces.size();
  for (size_t k : good) { pieces.push_back({nullptr, so[k].textlen - so[k].tlen}); pieces.push_back({so[k].text().data(), so[k].tlen}); pieces.push_back({extra_of(k).data(), extra_of(k).size()}); }
  if (!doff_text.empty()) pieces.push_back({doff_text.data(), doff_text.size()});
  pieces.push_back({"E\n", 2});
  std::vector<size_t> at(pieces.size() + 1, 0);
  for (size_t i = 0; i < pieces.size(); i++) at[i + 1] = at[i] + pieces[i].second;
  res.plan.resize(at.back()); res.plan_bytes = at.back();
  char* dst = &res.plan[0];
  std::atomic<bool> vbad{false};
  pfor(pieces.size(), T, 64, [&](size_t i, int) {
    if (pieces[i].first) { if (pieces[i].second) memcpy(dst + at[i], pieces[i].first, pieces[i].second); return; }
    size_t k = good[(i - vfirst) / 3]; thread_local std::string v; v.clear(); put_v(v, k);
    if (v.size() != pieces[i].second) { vbad = true; return; }
    memcpy(dst + at[i], v.data(), v.size());
  });
  if (vbad) throw OtherError("plan: V line length differs from its count");
  mark("assemble");
  }

  rss_mark("summary");
  // ---- summary
  res.refusals.clear(); res.refusals.reserve(refusals.size());
  for (auto& x : refusals) {
    const Sig& g = S[x.second]; Refusal r{x.first, g.id, sig_full(decl, g)};
    r.excluded = excluded_sig.count(x.second) > 0;
    r.name = g.name; r.bits = g.bits; r.left = g.left; r.right = g.right; r.is_string = is_string(g); r.nonbit = g.bits ? 0 : g.field_id == 16 ? 1 : g.field_id == 20 ? 2 : 0;
    if (opt.refusal_scopes && !decl.scopes.ambiguous[g.scope]) {
      if (!opt.refusal_scope_ids) r.scope = decl.scopes.components(g.scope);
      else { r.scope_ix = g.scope;  // components from res.scope_recs (moved in at the end)
        if (opt.emit_names) r.names_node = nodeOfScope(g.scope); }
    }
    res.refusals.push_back(std::move(r));
  }
  res.derived = std::move(derived);
  std::map<std::string, uint64_t> by_reason;
  for (auto& x : refusals) by_reason[x.first]++;
  uint64_t nstring = 0, nreal = 0, nevent = 0, nderived = 0, nlate = 0, npkg = 0, nbig = 0, nd8 = 0, nclass = 0, ncinst = 0, ncmem = 0, nchand = 0, nflags = 0, ndtype = 0, nassert = 0, nname = 0; std::unordered_set<uint64_t> noindex_ids; std::map<std::string, std::unordered_set<uint64_t>> excl;
  for (auto& x : res.refusals) {
    if (x.reason == STRING_SKIP) nstring++;
    if (x.reason == REAL_SKIP) nreal++;
    if (x.reason == EVENT_SKIP) nevent++;
    if (class_reason(x.reason)) nclass++;
    if (x.reason == CLASS_INST) ncinst++;
    if (x.reason == CLASS_MEMBER) ncmem++;
    if (x.reason == CLASS_HANDLE) nchand++;
    if (x.reason == FLAGS_SKIP) nflags++;
    if (x.reason == DERIVED_SKIP) nderived++;
    if (x.reason == LATE_SKIP) nlate++;
    if (x.reason == NOINDEX) noindex_ids.insert(x.ident);
    if (x.excluded) excl[x.reason].insert(x.ident);
    if (x.reason == PKG_SKIP) npkg++;
    if (x.reason.compare(0, strlen(DTYPE_SKIP), DTYPE_SKIP) == 0) ndtype++;
    if (x.reason == ASSERT_SKIP) nassert++;
    if (x.reason == D8_MULTI) nd8++;
    if (x.reason == NAME_SHARED || x.reason.compare(0, strlen(NAME_PREFIX) - 6, NAME_PREFIX + 6) == 0) nname++;
    if (x.reason.compare(0, strlen(BIG_PREFIX), BIG_PREFIX) == 0) nbig++;
  }
  std::vector<std::string> lab;
  if (nd8) lab.push_back("PARTIAL: " + u2s(nd8) + " field-typed vars of an unpacked array or struct type not carried");
  if (nbig) lab.push_back("PARTIAL: " + u2s(nbig) + " unpacked arrays or structs over the per-item row bound not carried (refused by name with their element counts)");
  if (nassert) lab.push_back("PARTIAL: " + u2s(nassert) + " assertions not carried");
  if (ndtype) lab.push_back("PARTIAL: " + u2s(ndtype) + " vars with an extended datatype not carried");
  if (npkg) lab.push_back("PARTIAL: " + u2s(npkg) + " package-scope vars not carried (value IDs not linked)");
  if (nstring) lab.push_back("PARTIAL: " + u2s(nstring) + " string vars not carried");
  if (nreal) lab.push_back("PARTIAL: " + u2s(nreal) + " real vars not carried");
  if (nevent) lab.push_back("PARTIAL: " + u2s(nevent) + " event vars not carried");
  if (nflags) lab.push_back("PARTIAL: " + u2s(nflags) + " vars on native IDs with undecoded summary flags not carried");
  if (nclass) lab.push_back("PARTIAL: " + u2s(nclass) + " class-object vars not carried (run-time objects: " + u2s(ncinst) + " instances, " + u2s(ncmem) + " member rows, " +
                            u2s(nchand) + " handles, " + u2s(nclass - ncinst - ncmem - nchand) + " other)");
  if (!decl.class_fids.empty() && uv_orph) lab.push_back("PARTIAL: " + u2s(uv_orph) + " of " + u2s(uv_with) + " value-carrying IDs have no declaration (class-object layout)");
  if (ue_orph && decl.skipped_dirs.empty()) lab.push_back("PARTIAL: " + u2s(ue_orph) + " value-carrying IDs have no declaration (a later tree directory declares nothing)");
  for (auto& sd : decl.skipped_dirs) lab.push_back("PARTIAL: tree directory " + u2s(sd.k) + " not read (" + sd.why + "): its names are not carried; " + u2s(dir_listed.count(sd.k) ? dir_listed[sd.k] : 0) + " value IDs it introduces listed by ID");
  if (ue_orph && !decl.skipped_dirs.empty()) lab.push_back("PARTIAL: " + u2s(ue_orph) + " value-carrying IDs have no declaration (listed by ID; a tree directory was not read)");
  if (nderived) lab.push_back("PARTIAL: " + u2s(nderived) + " reader-computed vars not carried (stored prefix only in FSDB)");
  if (nname) lab.push_back("PARTIAL: " + u2s(nname) + " vars with an unsupported name spelling not carried (refused by name)");
  if (nlate) lab.push_back("PARTIAL: " + u2s(nlate) + " late-start vars not carried (earlier values via an undecoded port link)");
  if (!noindex_ids.empty()) lab.push_back("PARTIAL: " + u2s(noindex_ids.size()) + " port-collapsed IDs not carried (driver link unknown)");
  for (auto& kv : excl) {
    const std::string& why = kv.first;
    lab.push_back("PARTIAL: " + u2s(kv.second.size()) + " streams excluded (" + why + ")");
  }
  std::string partial; for (size_t i = 0; i < lab.size(); i++) { if (i) partial += "; "; partial += lab[i]; }
  std::unordered_set<uint64_t> did; for (auto& x : res.derived) did.insert(x.ident);
  std::string dl = did.empty() ? "" : "PARTIAL: " + u2s(did.size()) + " signals reader-computed after T";
  std::string label = partial; if (!dl.empty()) label += (label.empty() ? "" : "; ") + dl;
  uint64_t n_src_ids = 0;  // distinct value IDs of the non-package declarations (sorted copy, no hash set)
  { std::vector<uint64_t> v; v.reserve(S.size()); for (auto& s : S) if (!s.pkg) v.push_back(s.id);
    std::sort(v.begin(), v.end()); n_src_ids = uint64_t(std::unique(v.begin(), v.end()) - v.begin()); }
  std::string selv = "null";
  if (opt.has_select_ids) { std::unordered_set<uint64_t> u(opt.select_ids.begin(), opt.select_ids.end()); selv = u2s(u.size()); }
  std::vector<std::pair<std::string, std::string>> kv = {
      {"aliases", u2s(nalias)}, {"declarations", u2s(good.size() + nalias)}, {"derived_after_declarations", u2s(res.derived.size())},
      {"derived_after_ids", u2s(did.size())}, {"label", jstr(label)}, {"merged_duplicates", u2s(merged)}, {"refused", u2s(refusals.size())},
      {"refused_by_reason", ""}, {"selected_ids", selv}, {"source_declarations", u2s(S.size())}, {"source_ids", u2s(n_src_ids)}, {"streams", u2s(good.size())}};
  { std::vector<uint8_t> refd(S.size(), 0); for (auto& x : refusals) refd[x.second] = 1;
    for (uint32_t i = 0; i < S.size(); i++) if (!refd[i]) { if (S[i].dtype == 0) n_enum++; else if (S[i].dtype == -2) n_dtund++; } }
  if (n_enum || n_dtund) {  // vars of a decoded enum datatype: stored values carried as plain vectors of the enum width (not PARTIAL); only when present
    auto at = std::find_if(kv.begin(), kv.end(), [](const std::pair<std::string, std::string>& x) { return x.first == "label"; });
    std::string note = u2s(n_enum) + " vars of an enum datatype carried as plain vectors: " + ENUM_NOTE;
    if (n_dtund) note += "; " + u2s(n_dtund) + " struct members name a datatype that is not decoded: carried as plain vectors";
    kv.insert(at, {"enum_vars_note", jstr(note)});
  }
  if (decl.not_listed) {  // only when present, so every other report keeps its bytes (sorted-key order kept)
    auto at = std::find_if(kv.begin(), kv.end(), [](const std::pair<std::string, std::string>& x) { return x.first == "refused"; });
    kv.insert(at, {"not_listed_skipped", u2s(decl.not_listed)});
  }
  if (!decl.class_fids.empty()) kv.push_back({"unreferenced_value_ids", jstr(u2s(uv_orph) + "/" + u2s(uv_with))});  // class-object layouts only (other reports keep their bytes)
  if (opt.port_links) {  // the link-mode inputs are recorded in the report (sorted-key order kept)
    kv.push_back({"force_log", jstr(res.pl_json_force)}); kv.push_back({"port_links_full_scope", jstr(res.pl_json_scope)});
    std::sort(kv.begin(), kv.end(), [](const std::pair<std::string, std::string>& a, const std::pair<std::string, std::string>& b) { return a.first < b.first; });
  }
  std::string c = "{", ind = "{\n";
  for (size_t i = 0; i < kv.size(); i++) {
    std::string v = kv[i].second, vi = v;
    if (kv[i].first == "refused_by_reason") {
      v = "{"; vi = by_reason.empty() ? "{}" : "{\n"; size_t j = 0;
      for (auto& br : by_reason) {
        if (j) { v += ", "; vi += ",\n"; }
        v += jstr(br.first) + ": " + u2s(br.second); vi += "  " + jstr(br.first) + ": " + u2s(br.second); j++;
      }
      v += "}"; if (!by_reason.empty()) vi += "\n }";
    }
    if (i) { c += ", "; ind += ",\n"; }
    c += jstr(kv[i].first) + ": " + v; ind += " " + jstr(kv[i].first) + ": " + vi;
  }
  res.summary_json = c + "}"; res.report_json = ind + "\n}\n";
  if (asm_thr.joinable()) { asm_thr.join(); if (asm_err) std::rethrow_exception(asm_err); mark("assemble"); }
  if (opt.refusal_scopes && opt.refusal_scope_ids) {  // nothing reads the scope tables after this point
    res.scope_recs.first = std::move(decl.scopes.first); res.scope_recs.parent = std::move(decl.scopes.parent); res.scope_recs.rname = std::move(decl.scopes.rname); }
  mark("total");
}

}  // namespace

std::string to_text(const StructPlan& sp, int threads) {
  const int T = threads > 0 ? threads : usableCpus();
  std::string head = "FSRAWPLAN3\n";
  put(head, sp.size); head += ' '; put(head, sp.crc); head += ' '; puti(head, sp.scale); head += ' '; put(head, sp.tmin); head += ' '; put(head, sp.tmax); head += ' ';
  put(head, sp.bus.size()); head += ' '; put(head, sp.index_blk.size()); head += ' '; put(head, sp.periods.size()); head += ' '; put(head, sp.vars.size()); head += ' '; put(head, sp.windows.size()); head += '\n';
  const size_t C = 65536; size_t nb = (sp.bus.size() + C - 1) / C, nc = (sp.index_blk.size() + C - 1) / C, nw = (sp.windows.size() + C - 1) / C;
  std::vector<std::string> blk(nb + nc), tl(sp.periods.size()), wl(nw), vl(sp.vars.size());
  pfor(blk.size(), T, 1, [&](size_t i, int) {
    bool isb = i < nb; const auto& v = isb ? sp.bus : sp.index_blk; size_t b = (isb ? i : i - nb) * C, e = std::min(v.size(), b + C); std::string& s = blk[i];
    for (size_t j = b; j < e; j++) { s += isb ? "B " : "C "; put(s, v[j].off); s += ' '; put(s, v[j].size); s += ' '; put(s, v[j].period); s += '\n'; }
  });
  pfor(tl.size(), T, 8, [&](size_t i, int) {
    const PlanPeriod& x = sp.periods[i]; std::string& s = tl[i];
    s += "T "; put(s, x.begin); s += ' '; put(s, x.end); s += ' '; s += x.direct ? '1' : '0'; s += ' '; put(s, x.delta.size());
    for (auto d : x.delta) { s += ' '; put(s, d); }
    s += '\n';
  });
  pfor(nw, T, 1, [&](size_t i, int) {
    std::string& s = wl[i];
    for (size_t j = i * C; j < std::min(sp.windows.size(), (i + 1) * C); j++) { s += "W "; put(s, sp.windows[j].period); s += ' '; put(s, sp.windows[j].start); s += ' '; put(s, sp.windows[j].end); s += '\n'; }
  });
  pfor(vl.size(), T, 16, [&](size_t i, int) {
    const PlanVar& v = sp.vars[i]; std::string& s = vl[i];
    s += "V "; put(s, v.id); s += ' '; s += v.head; s += ' '; put(s, v.recs.size()); s += '\n';
    for (auto& r : v.recs) {
      if (r.kind == 'B') { s += "R B "; put(s, r.period); s += ' '; put(s, r.count); s += " 0 0 "; put(s, r.block); s += ' '; put(s, r.offset); s += ' '; put(s, r.begin); s += ' '; put(s, r.end); s += '\n'; }
      else { s += "R "; s += r.kind; s += ' '; put(s, r.period); s += ' '; put(s, r.count); s += ' '; put(s, r.index_blk); s += ' '; put(s, r.vc); s += " 0 0 0 0\n"; }
    }
    s += "A "; put(s, v.aliases.size()); s += '\n';
    for (auto& a : v.aliases) { s += "D "; s += a; s += '\n'; }
  });
  std::string dt;  // the O section (dump-off stream), as the text path writes it
  if (!sp.doff.empty()) {
    dt = "O "; put(dt, sp.doff.size()); dt += '\n';
    for (auto& r : sp.doff) { dt += "R S "; put(dt, r.period); dt += ' '; put(dt, r.count); dt += ' '; put(dt, r.index_blk); dt += ' '; put(dt, r.vc); dt += " 0 0 0 0\n"; }
  }
  size_t total = head.size() + 2 + dt.size();
  for (auto* g : {&blk, &tl, &wl, &vl}) for (auto& x : *g) total += x.size();
  std::string out; out.reserve(total); out += head;
  for (auto* g : {&blk, &tl, &wl, &vl}) for (auto& x : *g) out += x;
  out += dt;
  out += "E\n";
  return out;
}

bool build(const uint8_t* data, size_t n, const Options& opt, Result& out, std::string& err) {
  try { build_impl(data, n, opt, out); return true; }
  catch (const std::exception& e) { err = e.what(); }
  catch (...) { err = "unknown error"; }
  out.plan.clear();
  return false;
}

}  // namespace fplan

bool fplan_build_struct(const uint8_t* data, size_t n, const fplan::Options& opt, fplan::StructPlan& plan, std::string& err) {
  fplan::Options o = opt; o.emit_text = false; o.emit_struct = true;
  fplan::Result r;
  if (!fplan::build(data, n, o, r, err)) return false;
  plan = std::move(r.sp);
  return true;
}

bool fplan_build(const uint8_t* data, size_t n, const fplan::Options& opt, std::string& planText, std::string& err) {
  fplan::Result r;
  if (!fplan::build(data, n, opt, r, err)) return false;
  planText.swap(r.plan);
  return true;
}
