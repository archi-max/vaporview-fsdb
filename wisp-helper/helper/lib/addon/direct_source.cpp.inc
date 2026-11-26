#if defined(__GLIBC__)
#include <malloc.h>
#endif
// SPDX-License-Identifier: MIT
// ---- direct source: an FSDB file read in place through sigread (no conversion) ----
//
// At open: the planner's plan with the converter's per-stream refusals (sigread::File::open, converter_refusals), and a
// WCZ dictionary from the converter's declaration rules (sigread_wcz.h), so the hierarchy calls answer exactly as they
// do on the same file's converted WCZ. Signal i (id i + 1) is sigread var i; its aliases are vars of the same signal.
// Values: per request, through the block-source hooks; a block is one or more of the file's records for the signal
// (sigread::File::record_planes), decoded only when a read needs it. Raw rows only: the store normalizes them as it does a
// WCZ block's rows.
// Built only with WISP_DIRECT (build.sh sets it when the converter's src/ has sigread.h); without it an FSDB open is
// refused (the stub at the end of this file).
#ifdef WISP_DIRECT
#include "sigread.h"
#include "sigread_wcz.h"
#include "window_run.h"   // convert/fsdb/side: the window run of computed names (derive_side --window)
#include <condition_variable>
#include <regex>
#include <set>
#include <sstream>
#include <thread>
#include <sched.h>
#include <unistd.h>

namespace dsrc {
// (src/main.cpp gives an open error with this prefix the reply code fileRefused)
static const std::string FILE_REFUSED = "this FSDB file cannot be read directly: ";
static std::unique_ptr<sigread::File> g_file;
static sigread::wczform::Declarations g_decl;  // after open: typed only (the dict holds the rest)
static sigread::Names g_namesOwn;               // the names table of a verified (full) open; a lazy open uses the File's own
static sigread::Names *g_N = nullptr;
static wcz::Dict g_dict;
static bool g_on = false;
static std::atomic<uint64_t> g_reads{0}, g_countDecodes{0};
static std::unique_ptr<std::atomic<uint64_t>[]> g_norm;  // per signal: the normalized change count, once computed (UINT64_MAX: not yet)
// per bit signal: its stored records and the first record of each block (a new block at every bus record after the
// first record, whose first change time is exact; inline records stay in the block before them)
// flat tables (no per-signal heap object): signal i's records are g_recs[g_ro[i] .. g_ro[i + 1]), its blocks' first
// records (indices within the signal) g_bk[g_bo[i] .. g_bo[i + 1])
static std::vector<sigread::Record> g_recs; static std::vector<uint64_t> g_ro, g_bo; static std::vector<uint32_t> g_bk;
static inline const sigread::Record *recsOf(uint32_t i) { return g_recs.data() + g_ro[i]; }
static inline uint32_t nrec(uint32_t i) { return (uint32_t)(g_ro[i + 1] - g_ro[i]); }
static inline uint32_t blkStart(uint32_t i, uint32_t b) { return g_bk[g_bo[i] + b]; }
static uint64_t g_records = 0;

// Whole-file check before any value (the converter refuses the whole file when any stored record fails to decode, so
// no value of such a file may be served): started at open, in the background; hierarchy requests do not wait for it,
// every value request does (waitVerified). State: 0 running, 1 every record decoded and checked, 2 refused (g_verr),
// 4 not started yet (a lazy open with WISP_VERIFY_START idle:<seconds> or request).
static std::mutex g_vm;
static std::condition_variable g_vcv;
static int g_vstate = 1;
static std::string g_verr;
static std::thread g_vthr;
static std::atomic<bool> g_vstop{false};
static std::atomic<uint64_t> g_vdone{0};
static double g_vms = 0, g_vcpu = 0;
static unsigned g_vthreads = 0;
// Default (lazy): open builds the plan only (with the converter's plan checks, which still refuse the whole file), values do
// not wait; the same whole-file check starts in the background
// at open (after the converter's per-stream rules, a stream it refuses is an error on that signal only), every value reply
// says whether it had passed (verified), and when it refuses the file every later request is refused and the helper
// withdraws the answers it gave unverified (g_onRefuse).
// WISP_DIRECT_OPEN=full (or scan): the blocking, verified-only open of helper snapshots 10 to 15.5: the converter's refusal
// scan at open, and values wait for the whole-file check. Any other value of WISP_DIRECT_OPEN than lazy, full or scan
// refuses the open.
static bool g_lazy = true;
// WISP_VERIFY_START (lazy open only): when the background check starts. open (default): at open. idle:<seconds>: once
// no request has come for that long (the helper's command loop starts it, verifyStart). request (or off): only on a
// verify request. A verify request checks the whole file in every mode; values are served unverified until it passes.
static int g_vstart = 0;          // 0 open, 1 idle, 2 request
static double g_vidleMs = -1;     // idle: the wait in ms
static bool verifyStartSetting(std::string &err) {
  g_vstart = 0; g_vidleMs = -1;
  const char *m = getenv("WISP_VERIFY_START"); if (!m || !*m || !strcmp(m, "open")) return true;
  if (!strcmp(m, "request") || !strcmp(m, "off")) { g_vstart = 2; return true; }
  if (!strncmp(m, "idle:", 5)) {
    char *e = nullptr; const double v = strtod(m + 5, &e);
    if (m[5] && e && !*e && v >= 0 && v <= 86400) { g_vstart = 1; g_vidleMs = v * 1000.0; return true; }
  }
  err = std::string("WISP_VERIFY_START must be open, idle:<seconds> (0 to 86400) or request (or off), not ") + m; return false;
}
static std::chrono::steady_clock::time_point g_vopen;  // the lazy open's start (time to refusal)
static double g_vrefMs = -1;                            // ms from open to the background refusal (-1: none)
extern "C" { typedef void (*wisp_refuse_fn)(const char *why, double msAfterOpen); }
static wisp_refuse_fn g_onRefuse = nullptr;           // set by the helper's main: writes the withdrawal line
static std::unordered_map<uint32_t, std::string> g_sbad;  // bit signal -> why the converter would refuse it (lazy mode; absent = none found yet)
static std::mutex g_sbm;
// the WCZ same-timestamp row limit; WISP_TEST_MAX_ROWS lowers it for the helper's own tests only (a real file over the
// limit needs over a million rows at one time)
static uint64_t maxRows() { static const uint64_t m = [] { const char *e = getenv("WISP_TEST_MAX_ROWS"); return e && atoll(e) > 0 ? (uint64_t)atoll(e) : (uint64_t)wcz::MAX_ROWS; }(); return m; }
// the CPUs this process may run on (its affinity mask, e.g. under taskset or a cgroup cpuset); the hardware count if unknown
// (macOS has no CPU affinity masks: the hardware count, as fplan.cpp's usableCpus)
static unsigned usableCpus() {
#if defined(__linux__)
  cpu_set_t set; CPU_ZERO(&set);
  if (sched_getaffinity(0, sizeof set, &set) == 0) { const int n = CPU_COUNT(&set); if (n > 0) return (unsigned)n; }
#endif
  return std::max(1u, std::thread::hardware_concurrency());
}
// threads for the open scan and the whole-file check: the usable CPUs capped at 16; WISP_VERIFY_THREADS overrides
static unsigned workThreads() {
  unsigned th = std::max(1u, std::min(16u, usableCpus()));
  if (const char *e = getenv("WISP_VERIFY_THREADS")) th = (unsigned)std::max(1, atoi(e));
  return th;
}
static double cpuMs() { timespec t; clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
// computed signals (window_compute.cpp.inc)
static bool g_cOn = false;                 // the open's statement: outsideWrites none
static std::string g_path;                 // the open file
static std::vector<uint32_t> g_cDecl;      // computed k -> g_decl.refused index
static std::vector<std::string> g_cName;   // computed k -> name as derive_side lists it (strip_name)
static void computedClose(); static void computedNames(); static uint32_t nComputed(); static uint64_t computedNRows(uint32_t k); static uint64_t computedT0(uint32_t k);
static void stopVerify() { g_vstop = true; if (g_vthr.joinable()) g_vthr.join(); g_vstop = false; }
static void close() { stopVerify(); computedClose(); g_file.reset(); g_decl = sigread::wczform::Declarations(); g_namesOwn = sigread::Names(); g_N = nullptr; g_dict = wcz::Dict(); g_on = false; g_norm.reset(); g_sbad.clear(); std::vector<sigread::Record>().swap(g_recs); std::vector<uint64_t>().swap(g_ro); std::vector<uint64_t>().swap(g_bo); std::vector<uint32_t>().swap(g_bk); g_records = 0; }

// The dictionary the converter writes for this file (scopes, stored vars with their aliases, refused declarations, then
// real / string signals), from the shared declaration rules (sigread_wcz.h).
static void buildDict() {
  wcz::Dict &d = g_dict; sigread::Names &N = *g_N;
  std::vector<uint32_t> dstr, dsc;  // table string -> dict string, table node -> dict scope (NONE32: not yet)
  auto str = [&](uint32_t s) -> uint32_t {
    if (s >= dstr.size()) dstr.resize(N.str.size(), wcz::NONE32);
    if (dstr[s] == wcz::NONE32) { dstr[s] = (uint32_t)d.strs.size(); d.strs.push_back(N.str[s]); }
    return dstr[s];
  };
  // a path's scopes, created root first when new (a scope is its parent's and its name's: one per table node)
  auto scopeOf = [&](uint32_t n) -> uint32_t {
    if (!n) return wcz::NONE32;
    if (dsc.size() < N.par.size()) dsc.resize(N.par.size(), wcz::NONE32);
    if (dsc[n] != wcz::NONE32) return dsc[n];
    std::vector<uint32_t> up; for (uint32_t a = n; a && dsc[a] == wcz::NONE32; a = N.par[a]) up.push_back(a);
    for (size_t k = up.size(); k-- > 0;) {
      const uint32_t a = up[k], pa = N.par[a], parent = pa ? dsc[pa] : wcz::NONE32;
      const uint32_t sc = (uint32_t)d.scopes.size(); d.scopes.push_back(wcz::ScopeE{str(N.cs[a]), parent, 0}); dsc[a] = sc;
    }
    return dsc[n];
  };
  auto var = [&](uint32_t node, uint32_t leaf, int64_t msb, int64_t lsb, uint32_t sig, uint8_t state, uint8_t type) {
    wcz::VarE v{}; v.name = str(leaf); v.scope = scopeOf(node); v.signal = sig; v.msb = (int32_t)msb; v.lsb = (int32_t)lsb; v.state = state; v.kind = 0; v.dir = 0; v.type = type; v.flags = 0; v.enm = wcz::NONE32;
    d.vars.push_back(v);
  };
  const auto &V = g_file->vars();
  d.sigs.reserve(V.size() + g_decl.typed.size()); d.vars.reserve(N.slots() + g_decl.refused.size());
  size_t c = 0; const auto &C = g_decl.changed;
  for (uint32_t i = 0; i < V.size(); i++) {
    wcz::SigDecl sd; sd.spec.bits = V[i].bits; sd.spec.fourState = true; sd.spec.vlen = wcz::SigSpec::vlenFor(wcz::VT_BITS, V[i].bits, true);
    d.sigs.push_back(sd);
    for (uint64_t sl = N.off[i]; sl < N.off[i + 1]; sl++) {  // the var, then its aliases
      if (c < C.size() && C[c].slot == sl) { var(C[c].node, C[c].leaf, N.left[sl], N.right[sl], i, wcz::VS_STORED, 0); c++; }
      else var(N.node[sl], N.leaf[sl], N.left[sl], N.right[sl], i, wcz::VS_STORED, 0);
    }
  }
  computedNames();   // with the open statement outsideWrites none: the computed candidates (window_compute.cpp.inc)
  const uint32_t cbase = (uint32_t)(V.size() + g_decl.typed.size());
  std::vector<uint32_t> csig(g_decl.refused.size(), wcz::NONE32);
  for (uint32_t k = 0; k < nComputed(); k++) csig[g_cDecl[k]] = cbase + k;
  for (uint32_t q = 0; q < g_decl.refused.size(); q++) {  // with the converter's reason (code + text), as its WCZ carries them (vrsn)
    const auto &r = g_decl.refused[q];
    if (csig[q] != wcz::NONE32) { var(r.decl.node, r.decl.leaf, r.decl.msb, r.decl.lsb, csig[q], wcz::VS_STORED, 0); continue; }   // a computed signal: values per window
    d.reasons.push_back(wcz::VarReason{(uint32_t)d.vars.size(), (uint16_t)r.code, r.reason.empty() ? wcz::NONE32 : str(N.intern(r.reason))});
    var(r.decl.node, r.decl.leaf, r.decl.msb, r.decl.lsb, wcz::NONE32, (uint8_t)r.state, (uint8_t)r.type);
  }
  const auto &Y = g_file->typed();
  for (uint32_t k = 0; k < g_decl.typed.size(); k++) {
    const int ty = Y[g_decl.typed[k].k].kind;
    wcz::SigDecl sd; sd.spec.vtype = ty == 5 ? wcz::VT_REAL : wcz::VT_STRING; sd.spec.bits = ty == 5 ? 64 : 0; sd.spec.fourState = false;
    sd.spec.vlen = wcz::SigSpec::vlenFor(sd.spec.vtype, sd.spec.bits, false);
    d.sigs.push_back(sd);
    for (const auto &dc : g_decl.typed[k].decls) var(dc.node, dc.leaf, dc.msb, dc.lsb, (uint32_t)(V.size() + k), wcz::VS_STORED, (uint8_t)ty);
  }
  for (uint32_t k = 0; k < nComputed(); k++) {  // computed signals (after the stored and typed ones)
    const auto &dc = g_decl.refused[g_cDecl[k]].decl; const uint32_t bits = (uint32_t)(std::llabs(dc.msb - dc.lsb) + 1);
    wcz::SigDecl sd; sd.spec.bits = bits; sd.spec.fourState = true; sd.spec.vlen = wcz::SigSpec::vlenFor(wcz::VT_BITS, bits, true);
    d.sigs.push_back(sd);
  }
  // only the typed list is used after this (and, with computed names, the refused list: their build reads it)
  std::vector<sigread::wczform::Declarations::Changed>().swap(g_decl.changed);
  if (!g_cOn) std::vector<sigread::wczform::Undeclared>().swap(g_decl.refused);
}

// FSDB header magic at byte 4 (both byte orders the files carry)
static bool isPlanFile(const uint8_t *m, size_t n) {
  if (n < 8) return false;
  const uint32_t m4 = (uint32_t)m[4] | ((uint32_t)m[5] << 8) | ((uint32_t)m[6] << 16) | ((uint32_t)m[7] << 24);
  return m4 == 0x48d93dfcu || m4 == 0x48d93e1cu;
}

// WISP_PORT_LINKS / WISP_FULL_SCOPE (0 or 1, default 1) and WISP_FORCE_LOG (a readable file) mirror the
// converter wrapper's port-link, full-scope and force-log switches, so a direct read links the names the converted file
// links. A bad value refuses the open with the converter's wording. Full scope and the force log apply only with port links.
static sigread::LinkOptions g_lo;
static bool linkOptions(sigread::LinkOptions &lo, std::string &err) {
  auto flag = [&](const char *name, bool &out) {
    const char *e = getenv(name); if (!e || !*e) return true;
    if (std::string(e) == "0") { out = false; return true; } if (std::string(e) == "1") { out = true; return true; }
    err = std::string(name) + " must be 0 or 1"; return false;
  };
  if (!flag("WISP_PORT_LINKS", lo.port_links) || !flag("WISP_FULL_SCOPE", lo.full_scope)) return false;
  if (const char *fl = getenv("WISP_FORCE_LOG")) if (*fl) {
    if (access(fl, R_OK) != 0) { err = std::string("WISP_FORCE_LOG not readable: ") + fl; return false; }
    lo.force_log = fl;
  }
  return true;
}
static bool portLinks() { return g_lo.port_links; }
static bool fullScope() { return g_lo.port_links && g_lo.full_scope; }
static bool forceLog() { return g_lo.port_links && !g_lo.force_log.empty(); }

static void startVerify();
static bool open(const std::string &file, std::string &err, bool outsideNone = false) {
  close();
  g_cOn = outsideNone; g_path = file;
  size_t cache = 256u << 20;
  if (const char *mb = getenv("WCB_BLOCK_LRU_MB")) cache = (size_t)std::max(1.0, atof(mb)) << 20;
  sigread::LinkOptions lo;  // the converter's port-link default (the wrapper's PORT_LINKS_DEFAULT=1) and its off switches, same values
  if (!linkOptions(lo, err)) { err = FILE_REFUSED + err; return false; }
  g_lo = lo;
  { const char *m = getenv("WISP_DIRECT_OPEN");
    if (m && *m && strcmp(m, "lazy") && strcmp(m, "full") && strcmp(m, "scan")) { err = FILE_REFUSED + std::string("WISP_DIRECT_OPEN must be lazy, full or scan, not ") + m; return false; }
    g_lazy = !(m && (!strcmp(m, "full") || !strcmp(m, "scan"))); g_vopen = std::chrono::steady_clock::now(); g_vrefMs = -1; }
  if (!verifyStartSetting(err)) { err = FILE_REFUSED + err; return false; }
  g_file = g_lazy ? sigread::File::open_lazy(file, err, cache, (int)workThreads(), lo, /*compact=*/true)
                  : sigread::File::open(file, err, cache, (int)workThreads(), /*converter_refusals=*/true, lo);
  if (g_file) { g_N = g_file->names_mut(); if (!g_N) { if (sigread::wczform::names_from(*g_file, g_namesOwn, err)) g_N = &g_namesOwn; else g_file.reset(); } }
  if (!g_file || !sigread::wczform::declarations(*g_file, *g_N, g_decl, err)) { g_file.reset(); g_N = nullptr; err = FILE_REFUSED + err; return false; }

  const auto &V = g_file->vars();
  for (const auto &v : V)  // the converter's limit on a stored signal's width (it refuses the whole file)
    if (v.bits > wcz::MAX_BITS) { err = FILE_REFUSED + "invalid variable (" + std::to_string(v.bits) + " bits > " + std::to_string(wcz::MAX_BITS) + ")"; g_file.reset(); return false; }
  g_ro.assign(1, 0); g_bo.assign(1, 0); g_ro.reserve(V.size() + 1); g_bo.reserve(V.size() + 1);
  for (size_t i = 0; i < V.size(); i++) {
    const uint64_t r0 = g_recs.size(); g_file->records_into(V[i].id, g_recs);
    for (uint64_t k = r0; k < g_recs.size(); k++) if (k == r0 || g_recs[k].kind == 'B') g_bk.push_back((uint32_t)(k - r0));
    g_ro.push_back(g_recs.size()); g_bo.push_back(g_bk.size());
  }
  g_records = g_recs.size();
  buildDict();

  const size_t n = V.size() + g_decl.typed.size();
  g_norm.reset(new std::atomic<uint64_t>[n ? n : 1]);
  for (size_t i = 0; i < n; i++) g_norm[i] = UINT64_MAX;
  g_on = true;
  if (g_lazy && g_vstart != 0) { std::lock_guard<std::mutex> l(g_vm); g_vstate = 4; g_verr.clear(); g_vdone = 0; g_vms = 0; g_vcpu = 0; g_vthreads = workThreads(); }
  else startVerify();  // (lazy too: in the background, values do not wait for it)
  return true;
}

static uint32_t nBits() { return g_file ? (uint32_t)g_file->vars().size() : 0; }
static uint32_t nStoredTyped() { return g_file ? (uint32_t)(g_file->vars().size() + g_decl.typed.size()) : 0; }
static uint32_t nSignals() { return g_file ? nStoredTyped() + (uint32_t)g_cName.size() : 0; }
static const sigread::Typed *typedOf(uint32_t i) { return i >= nBits() && i < nStoredTyped() ? &g_file->typed()[g_decl.typed[i - nBits()].k] : nullptr; }
static uint32_t recEnd(uint32_t i, uint32_t b) { return b + 1 < g_bo[i + 1] - g_bo[i] ? blkStart(i, b + 1) : nrec(i); }
// a typed signal is one block (its rows are in memory)
static uint32_t nblk(uint32_t i) { if (const auto *y = typedOf(i)) return y->rows.empty() ? 0 : 1; if (i < nBits()) return (uint32_t)(g_bo[i + 1] - g_bo[i]);
  // a computed signal: its last prepared window is one block (window_compute.cpp.inc)
  if (i < nSignals()) return computedNRows(i - nStoredTyped()) ? 1 : 0; return 0; }
static uint64_t blockT0(uint32_t i, uint32_t b) { if (b >= nblk(i)) return UINT64_MAX; if (const auto *y = typedOf(i)) return y->rows[0].first; if (i >= nBits()) return computedT0(i - nStoredTyped()); return recsOf(i)[blkStart(i, b)].begin; }
static uint32_t blockRows(uint32_t i, uint32_t b) {
  if (b >= nblk(i)) return 0; if (const auto *y = typedOf(i)) return (uint32_t)y->rows.size();
  if (i >= nBits()) return (uint32_t)std::min<uint64_t>(UINT32_MAX, computedNRows(i - nStoredTyped()));
  uint64_t n = 0; for (uint32_t k = blkStart(i, b); k < recEnd(i, b); k++) n += recsOf(i)[k].count;
  return (uint32_t)std::min<uint64_t>(UINT32_MAX, n);
}
static int tsExp() { return g_file->timescaleExp(); }
static uint64_t tBegin() { return g_file->tBegin(); }
static uint64_t tEnd() { return g_file->tEnd(); }
static uint64_t records() { return g_records; }

// all raw rows of records [r0, r1) of bit signal i with t <= upto, in order
template <class Fn> static bool rows(uint32_t i, uint32_t r0, uint32_t r1, uint64_t upto, Fn &&fn, std::string &err) {
  const uint64_t id = g_file->vars()[i].id;
  for (uint32_t k = r0; k < r1; k++) {
    if (k > r0 && recsOf(i)[k].exact && recsOf(i)[k].begin > upto) break;
    if (!g_file->record_planes(id, k, upto, fn, err)) return false;
  }
  return true;
}

// One bit signal, every record decoded with the converter's checks (the decoder's per-record checks in sigread, plus time
// order across the signal's records, the WCZ same-timestamp row limit and the plane length); kept = its normalized count.
static bool checkSignal(uint32_t i, uint64_t &kept, std::string &e) {
  const uint32_t bits = g_file->vars()[i].bits, st = (bits + 7) / 8;
  std::vector<uint8_t> allX(st, 0), pend(2 * st), last(2 * st);
  for (uint32_t k = 0; k < bits; k++) allX[k >> 3] |= (uint8_t)(1 << (k & 7));
  bool havePend = false, haveLast = false, have = false; uint64_t tp = 0, prev = 0, same = 0; kept = 0;
  auto flush = [&] {
    if (!havePend) return;
    const bool eq = haveLast ? !memcmp(pend.data(), last.data(), 2 * st)
                             : std::all_of(pend.begin(), pend.begin() + st, [](uint8_t b) { return b == 0; }) && !memcmp(pend.data() + st, allX.data(), st);
    if (!eq) { kept++; last = pend; haveLast = true; }
  };
  bool ok = rows(i, 0, nrec(i), UINT64_MAX, [&](uint64_t t, const uint8_t *planes, size_t len) {
    if (have && t < prev) throw std::runtime_error("value timestamp outside range");
    same = have && t == prev ? same + 1 : 1;
    if (same > maxRows()) throw std::runtime_error("same-timestamp group exceeds WCZ row limit");
    have = true; prev = t;
    if (len != 2 * st) throw std::runtime_error("plane length");
    if (havePend && t != tp) flush();
    memcpy(pend.data(), planes, 2 * st); havePend = true; tp = t;
  }, e);
  if (!ok) { e += " (stored signal " + g_file->var_full(i) + ")"; return false; }
  flush();
  return true;
}
// The whole-file check: checkSignal over every stored bit signal (the first failure refuses the file). Started at open in
// scan mode; on demand (verify) in lazy mode.
static void setBad(uint32_t i, const std::string &why);
static void verifyAll() {
  if (g_lazy) if (const char *d = getenv("WISP_TEST_VERIFY_DELAY_MS")) {  // the helper's own tests only: hold the background check
    for (long w = atol(d); w > 0 && !g_vstop; w -= 10) std::this_thread::sleep_for(std::chrono::milliseconds(10)); }
  const auto t0 = std::chrono::steady_clock::now(); const double c0 = cpuMs();
  const uint32_t n = nBits();
  unsigned th; { std::lock_guard<std::mutex> l(g_vm); th = g_vthreads; }  // set by startVerify before this thread starts
  std::atomic<uint32_t> next{0}; std::atomic<bool> bad{false}; std::mutex em; std::string first;
  auto work = [&] {
    for (;;) {
      const uint32_t i = next++;
      if (i >= n || bad || g_vstop) return;
      uint64_t kept = 0; std::string e;
      if (g_lazy) {  // the converter's order: a stream its per-stream rules refuse is left out (an error on that signal only);
        // every other stream must decode, or the converter refuses the whole file (as the scan open's re-plan + check)
        std::string why, e2;
        if (!g_file->stream_refusal(g_file->vars()[i].id, why, e2)) e = e2;
        else if (!why.empty()) { setBad(i, "the converter refuses this signal: refused: " + why); g_vdone++; continue; }
        else if (checkSignal(i, kept, e)) { g_norm[i] = kept; g_vdone++; continue; }
      } else if (checkSignal(i, kept, e)) { g_norm[i] = kept; g_vdone++; continue; }
      bool expected = false;
      if (bad.compare_exchange_strong(expected, true)) { std::lock_guard<std::mutex> l(em); first = e; }
      return;
    }
  };
  std::vector<std::thread> T; for (unsigned k = 0; k < th; k++) T.emplace_back(work);
  for (auto &x : T) x.join();
  // The check read every block once through the shared decoded-block cache (blocks are shared by many streams, so the
  // cache is what keeps it fast) and left the whole decoded file in it (decoded blocks would otherwise stay resident until
  // idle). Give it back:
  // interactive reads refill only what they use.
  g_file->drop_cache();
#if defined(__GLIBC__)
  malloc_trim(0);
#endif
  std::unique_lock<std::mutex> l(g_vm);
  g_vms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count(); g_vcpu = cpuMs() - c0;
  if (g_vstop && !bad) { g_vstate = 2; g_verr = FILE_REFUSED + "closed"; }
  else if (bad) { g_vstate = 2; g_verr = FILE_REFUSED + first; }
  else g_vstate = 1;
  const bool tell = g_lazy && bad && !g_vstop;
  if (tell) g_vrefMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - g_vopen).count();
  g_vcv.notify_all();
  if (tell && g_onRefuse) { const std::string w = g_verr; const double ms = g_vrefMs; l.unlock(); g_onRefuse(w.c_str(), ms); }
}
static void startVerify() {
  { std::lock_guard<std::mutex> l(g_vm); g_vstate = 0; g_verr.clear(); g_vdone = 0; g_vms = 0; g_vthreads = workThreads(); }  // (stats shows the count at once)
  g_vthr = std::thread(verifyAll);
}
struct VerifyState { int state; double ms; uint64_t done; double cpuMs; unsigned threads; };
// a check not started yet (WISP_VERIFY_START): start it now (true if it was started here)
static bool verifyStart() { { std::lock_guard<std::mutex> l(g_vm); if (g_vstate != 4) return false; } startVerify(); return true; }
// the idle wait before a deferred check starts (ms; -1: none pending)
static double verifyIdleMs() { std::lock_guard<std::mutex> l(g_vm); return g_vstate == 4 && g_vstart == 1 ? g_vidleMs : -1; }
static const char *verifyStartName() { return !g_lazy || g_vstart == 0 ? "open" : g_vstart == 1 ? "idle" : "request"; }
static VerifyState verifyState() { std::lock_guard<std::mutex> l(g_vm); return {g_vstate, g_vms, g_vdone.load(), g_vcpu, g_vthreads}; }
static bool waitVerified(std::string &err) {
  std::unique_lock<std::mutex> l(g_vm);
  if (g_lazy) { if (g_vstate == 2) { err = g_verr; return false; } return true; }  // lazy: values do not wait; after a refusal none is served
  g_vcv.wait(l, [] { return g_vstate != 0; });
  if (g_vstate == 2) { err = g_verr; return false; }
  return true;
}
// verify (on demand): the whole-file check now, on the check threads; "" = every record passed, else the converter's reason
static std::string verifyNow() {
  verifyStart();  // (a deferred check starts here)
  std::unique_lock<std::mutex> l(g_vm); g_vcv.wait(l, [] { return g_vstate != 0; });  // (every open starts the check)
  return g_vstate == 1 ? "" : g_verr;
}
// lazy mode: a signal's first failure is kept and returned for every later request of it
static bool sigBad(uint32_t i, std::string &err) { if (!g_lazy || i >= nBits()) return false; std::lock_guard<std::mutex> l(g_sbm); auto it = g_sbad.find(i); if (it == g_sbad.end()) return false; err = it->second; return true; }
static void setBad(uint32_t i, const std::string &why) { std::lock_guard<std::mutex> l(g_sbm); g_sbad.emplace(i, why); }  // (the first reason stays)
static bool lazyMode() { return g_lazy; }
// lazy: 1 when the whole-file check has passed (an answer built now is verified), 0 while it runs, 2 after it refused,
// 4 before a deferred check has started
static int checkNow() { std::lock_guard<std::mutex> l(g_vm); return g_vstate == 1 ? 1 : g_vstate == 2 ? 2 : g_vstate == 4 ? 4 : 0; }
static double refusedAfterMs() { std::lock_guard<std::mutex> l(g_vm); return g_vrefMs; }

// The normalized change count (the store's rule, normalizeStore with the initial all-x value): the last change at each
// time, minus repeats of the previous kept value, minus a first value that is all x. The plan has only raw counts, so
// this decodes the signal once (whole) and keeps the number; the WCZ source has it in its INDEX.
static bool normCount(uint32_t i, uint64_t &out, std::string &err) {
  if (g_norm[i] != UINT64_MAX) { out = g_norm[i]; return true; }
  if (const auto *y = typedOf(i)) {  // reals and strings: the store's rule without the initial value (normalizeStore(s, false))
    uint64_t kept = 0; size_t last = SIZE_MAX; const auto &R = y->rows;
    for (size_t k = 0; k < R.size(); k++) {
      if (k + 1 < R.size() && R[k + 1].first == R[k].first) continue;
      if (last != SIZE_MAX && R[k].second == R[last].second) continue;
      kept++; last = k;
    }
    g_norm[i] = kept; out = kept; return true;
  }
  if (g_lazy) {  // the signal's first use: its whole history decoded once with the converter's checks
    uint64_t kept = 0; std::string e; g_countDecodes++;
    if (!checkSignal(i, kept, e)) { const std::string why = "the converter refuses this signal: " + e; setBad(i, why); err = why; return false; }
    g_norm[i] = kept; out = kept; return true;
  }
  const uint32_t bits = g_file->vars()[i].bits, st = (bits + 7) / 8;
  std::vector<uint8_t> allX(st, 0), pend(2 * st), last(2 * st);
  for (uint32_t k = 0; k < bits; k++) allX[k >> 3] |= (uint8_t)(1 << (k & 7));
  bool havePend = false, haveLast = false; uint64_t tp = 0, kept = 0;
  auto flush = [&] {
    if (!havePend) return;
    const bool same = haveLast ? !memcmp(pend.data(), last.data(), 2 * st)
                               : std::all_of(pend.begin(), pend.begin() + st, [](uint8_t b) { return b == 0; }) && !memcmp(pend.data() + st, allX.data(), st);
    if (!same) { kept++; last = pend; haveLast = true; }
  };
  g_countDecodes++;
  std::string e;
  if (!rows(i, 0, nrec(i), UINT64_MAX, [&](uint64_t t, const uint8_t *planes, size_t) {
        if (havePend && t != tp) flush();
        memcpy(pend.data(), planes, 2 * st); havePend = true; tp = t;
      }, e)) { err = e; return false; }
  flush();
  g_norm[i] = kept; out = kept;
  return true;
}

#include "window_compute.cpp.inc"

static bool sig(uint32_t i, SrcSig &g, std::string &err) {
  if (i >= nSignals()) { err = "unknown signal"; return false; }
  if (i >= nStoredTyped()) {  // a computed signal (its last prepared window)
    const CRow *r = computedRow(i - nStoredTyped(), err); if (!r) return false;
    const auto &dc = g_decl.refused[g_cDecl[i - nStoredTyped()]].decl; const uint32_t bits = (uint32_t)(std::llabs(dc.msb - dc.lsb) + 1);
    g.kind = kBits; g.bits = bits; g.vlen = wcz::SigSpec::vlenFor(wcz::VT_BITS, bits, true); g.fourState = true; g.nNorm = r->nNorm; g.tLast = r->tLast;
    return true;
  }
  if (!waitVerified(err)) return false;
  if (sigBad(i, err)) return false;
  if (const auto *y = typedOf(i)) {
    g.kind = y->kind == 5 ? kReal : kString; g.bits = y->kind == 5 ? 64 : 32; g.vlen = y->kind == 5 ? 8 : 0; g.fourState = false;
    if (!normCount(i, g.nNorm, err)) return false;
    g.tLast = y->rows.empty() ? UINT64_MAX : y->rows.back().first;
    return true;
  }
  const auto &v = g_file->vars()[i];
  g.kind = kBits; g.bits = v.bits; g.vlen = wcz::SigSpec::vlenFor(wcz::VT_BITS, v.bits, true); g.fourState = true;
  if (!normCount(i, g.nNorm, err)) return false;
  const uint32_t nr = nrec(i); const sigread::Record *R = recsOf(i);
  g.tLast = nr && R[nr - 1].exact ? R[nr - 1].end : UINT64_MAX;
  return true;
}

// rows of block b from the last one before `from` up to `upto` (as the WCZ source gives them)
static bool read(uint32_t i, uint32_t b, uint64_t from, uint64_t upto, SrcRows &out, std::string &err) {
  out.clear();
  if (i >= nSignals() || b >= nblk(i)) { if (i >= nStoredTyped() && i < nSignals() && !computedRow(i - nStoredTyped(), err)) return false; err = "no such block"; return false; }
  if (!waitVerified(err)) return false;
  if (sigBad(i, err)) return false;
  g_reads++;
  if (i >= nStoredTyped()) {  // a computed signal: the prepared rows from the last one before `from` up to `upto`
    const CRow *c = computedRow(i - nStoredTyped(), err); if (!c) return false;
    if (from < g_cw0 || upto > g_cw1) { err = "outside the window the computed rows were made for"; return false; }
    const auto &R = c->rows; const size_t n = R.n(); size_t k0 = std::lower_bound(R.t.data(), R.t.data() + n, from) - R.t.data(); if (k0) k0--;
    for (size_t k = k0; k < n && R.t[k] <= upto; k++) { out.t.push_back(R.t[k]); out.v.insert(out.v.end(), R.v.data() + R.off[k], R.v.data() + R.off[k + 1]); out.off.push_back(out.v.size()); }
    return true;
  }
  if (const auto *y = typedOf(i)) {  // rows from the last one before `from` up to `upto`
    const auto &R = y->rows;
    size_t k0 = std::lower_bound(R.begin(), R.end(), from, [](const std::pair<uint64_t, std::string> &r, uint64_t t) { return r.first < t; }) - R.begin();
    if (k0) k0--;
    for (size_t k = k0; k < R.size() && R[k].first <= upto; k++) {
      out.t.push_back(R[k].first);
      out.v.insert(out.v.end(), (const uint8_t *)R[k].second.data(), (const uint8_t *)R[k].second.data() + R[k].second.size());
      out.off.push_back(out.v.size());
    }
    return true;
  }
  const uint32_t vlen = wcz::SigSpec::vlenFor(wcz::VT_BITS, g_file->vars()[i].bits, true);
  bool havePrev = false;  // out holds (at most) one row before `from` at its front
  std::string e;
  const uint32_t st2 = 2 * ((g_file->vars()[i].bits + 7) / 8); bool have = false; uint64_t prev = 0, same = 0;
  const bool ok = rows(i, blkStart(i, b), recEnd(i, b), upto, [&](uint64_t t, const uint8_t *planes, size_t len) {
    // the converter's checks on the rows this read returns
    if (have && t < prev) throw std::runtime_error("value timestamp outside range");
    same = have && t == prev ? same + 1 : 1;
    if (same > maxRows()) throw std::runtime_error("same-timestamp group exceeds WCZ row limit");
    if (len != st2) throw std::runtime_error("plane length");
    have = true; prev = t;
    if (t < from) {
      if (havePrev) { out.clear(); }
      havePrev = true;
    }
    out.t.push_back(t);
    out.v.insert(out.v.end(), planes, planes + vlen);
    out.off.push_back(out.v.size());
  }, e);
  if (!ok) {
    out.clear();
    if (g_lazy) { const std::string why = "the converter refuses this signal: " + e + " (stored signal " + g_file->var_full(i) + ")"; setBad(i, why); err = why; return false; }
    err = "block " + std::to_string(b) + ": " + e; return false;
  }
  return true;
}
}  // namespace dsrc
#else
namespace dsrc {  // (no direct read in this build)
static wcz::Dict g_dict;
static void close() {}
static bool isPlanFile(const uint8_t *, size_t) { return false; }
static bool open(const std::string &, std::string &err) { err = "reading FSDB files directly is not built in"; return false; }
static uint32_t nSignals() { return 0; }
static uint32_t nblk(uint32_t) { return 0; }
static uint64_t blockT0(uint32_t, uint32_t) { return UINT64_MAX; }
static uint32_t blockRows(uint32_t, uint32_t) { return 0; }
static int tsExp() { return 0; }
static uint64_t tBegin() { return 0; }
static uint64_t tEnd() { return 0; }
static uint64_t records() { return 0; }
struct VerifyState { int state; double ms; uint64_t done; double cpuMs; unsigned threads; };
static VerifyState verifyState() { return {1, 0, 0, 0, 0}; }
static bool portLinks() { return false; }
static bool fullScope() { return false; }
static bool forceLog() { return false; }
static bool waitVerified(std::string &) { return true; }
static std::string verifyNow() { return ""; }
static bool verifyStart() { return false; }
static double verifyIdleMs() { return -1; }
static const char *verifyStartName() { return "open"; }
static bool lazyMode() { return false; }
static int checkNow() { return 1; }
static double refusedAfterMs() { return -1; }
extern "C" { typedef void (*wisp_refuse_fn)(const char *why, double msAfterOpen); }
static wisp_refuse_fn g_onRefuse = nullptr;
static bool sig(uint32_t, SrcSig &, std::string &err) { err = "unknown signal"; return false; }
static bool read(uint32_t, uint32_t, uint64_t, uint64_t, SrcRows &out, std::string &err) { out.clear(); err = "no such block"; return false; }
}  // namespace dsrc
#endif
