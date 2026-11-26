// SPDX-License-Identifier: MIT
// window_run.h (file-only route): the window run. Each asked name is computed over [t0, t1] only, from the dump's
// derivation records and its stored inputs over that window, by the rules derive_side proves; names whose rules are not
// in the window-safe word list are refused by name. Shared by derive_side's window run (--window) and the helper's
// computed rows on a direct FSDB open, so both give the same answer for a name and a window.
// Stored inputs: the stored-only conversion of the dump (WczStored, cut to the window), or the dump read directly
// (DirectFile + DirectStored: only the records over the window). With the direct source and leaves = true, the window
// reads skip the per-stream rules and record the ids they read; those ids are then checked at once (File::scan over
// them), and if one of them is refused the window is computed again with every read checked first, so no answer comes
// from a refused input (that input's refusal reaches the names computed from it).
// check = true also computes each name over its whole history from the stored-only file and compares the window's rows
// with that history cut to the window (SAME / DIFF).
// Memory: the workers' computed histories and input caches are dropped when they pass workerBudget (then recomputed);
// a name that runs the machine out of memory is refused by name and the others go on.
#pragma once
#include "wcz_stored.h"
#include "direct_stored.h"
#include "fsdb_stream_check.h"   // RUN_PLAN_TEST_ENV (test builds only)
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

namespace dblk {

// The proven writer release of the derivation block: a version text "<letter>-<year>.<month>" (optionally followed by
// "-<anything>"), compared as numbers (the same numeric rule as the converter's other file-only release gate). Only the release the producer was proven on passes.
inline constexpr int PROVEN_YEAR = 2024, PROVEN_MONTH = 9;
inline constexpr const char *PROVEN_RELEASE_TEXT = "year=2024,month=9";
inline bool proven_release(const std::string &ver) {
  size_t i = 0; auto num = [&](int &v) { size_t s = i; v = 0; while (i < ver.size() && ver[i] >= '0' && ver[i] <= '9' && i - s < 6) v = v * 10 + (ver[i++] - '0'); return i > s; };
  if (ver.size() < 2 || ver[0] < 'A' || ver[0] > 'Z' || ver[1] != '-') return false;
  i = 2; int y, m; if (!num(y) || i >= ver.size() || ver[i] != '.') return false; i++; if (!num(m)) return false;
  return y == PROVEN_YEAR && m == PROVEN_MONTH && (i == ver.size() || ver[i] == '-');
}
// force-status records: a dump made with the force dump option and a force or C-code write in the run carries a tree
// directory after the first that introduces ids with no scope, variable or datatype records. This decode cannot place
// those ids on a name, so any such directory refuses the whole run, even with the outside-writes statement. A directory
// sequence this scan cannot read also refuses (fail closed). "" = none found (which certifies nothing: the statement stays required).
inline std::string forceStatusRefusal(const uint8_t *raw, uint64_t n) {
  std::string why;
  auto le = [&](uint64_t o, unsigned w, uint64_t &v) { if (o > n || w > n - o) return false; v = 0; for (unsigned q = 0; q < w; q++) v |= (uint64_t)raw[o + q] << (8 * q); return true; };
  uint64_t sec = n > 0x3c ? (uint64_t)raw[0x3c] * 256 : 0, o = 0, ids = 0, cnt = 0; const unsigned w = n > 0x100 && raw[0x100] == 1 ? 8 : 4;
  if (!sec || !le(sec, 8, o) || o >= n || raw[o] != 0xf0) why = "the dump's tree directory sequence is not readable";
  for (size_t d = 0; why.empty() && o < n && raw[o] == 0xf0; d++) {
    if (d >= 100000 || !le(o + 1, w, ids)) { why = "the dump's tree directory sequence is not readable"; break; }
    o += 1 + w; uint64_t recs = 0;
    for (int g = 0; g < 3 && why.empty(); g++) { if (!le(o, 4, cnt) || cnt > 1000000) { why = "the dump's tree directory sequence is not readable"; break; } o += 4 + 12 * cnt; recs += cnt; }
    if (why.empty() && d > 0 && ids > 0 && recs == 0) why = "the dump carries undeclared id records (force-status records: a force or an outside write in the run)";
  }
  return why;
}

// what a window run reads; built once per open of the files and kept for every window
struct WindowInputs {
  const FileData *F = nullptr; const Graph *G = nullptr; const Sem *sem = nullptr; const Words *allow = nullptr;
  const Words *safe = nullptr;   // the window-safe rule words
  std::string storedPath;        // the stored-only conversion ("": none; then the direct source and no check)
  std::string dumpPath;          // the dump (for messages)
  DirectFile *df = nullptr;      // the direct source (nullptr: the stored-only file)
  const std::map<std::string, std::pair<long long, long long>> *absent = nullptr;   // declared range of each name without values
  std::function<size_t(const std::string &)> severalIds;          // > 1: the name stands for several ids
  std::function<uint32_t(const std::string &)> nonBit;            // != 0: declared with a value type that is not a bit vector
  std::function<std::string(const std::string &, NodeId &)> pickNode;   // the name's node, or why it has none
  std::function<void(const Words &)> forcedRefuse;                // throws Refuse when a word marks a forced input
  std::unordered_map<NodeId, std::string, NodeHash> forcedNode; const std::unordered_map<uint64_t, std::string> *forcedStored = nullptr;
  uint64_t histCap = 0, workerBudget = 2ull << 30; unsigned threads = 1;
  uint64_t keptCap = 0;           // keepRows: the bytes all kept histories of a run may hold together (0 = no bound); a name
                                  // whose history would pass it is refused by name (which names, when several are near the
                                  // bound, depends on the order the workers finish them)
  bool leaves = false;           // direct source: the leaf scan (see the top of this file)
  bool check = false;            // also the whole-history check (needs storedPath)
};

// one name's answer: status ok / refused, the reason, the rows' count and sha256 ("<time> <value>" lines, the first row
// the value at t0), the check's verdict, and the rows themselves when asked (keepRows)
struct WindowAnswer { std::string st, why, sha, chk; size_t rows = 0; Hist h; };

struct WindowRun {
  using PhaseFn = std::function<void(const char *, const std::string &)>;
  const WindowInputs &in;
  std::string err;                // a run error (no answers): the message
  size_t drops = 0;               // memory drops in the last run
  uint64_t rows = 0;              // rows computed in the last run
  std::string leafNote;           // the leaf scan's counts for the phase line
  explicit WindowRun(const WindowInputs &i) : in(i) {}

  static std::string rowsSha(const Hist &h, uint64_t base) {
    Sha256 s; Val v; for (size_t i = 0; i < h.size(); i++) { h.get(i, v); std::string l = std::to_string(h.time(i) + base) + " " + v + "\n"; s.add(l.data(), l.size()); }
    return s.hex(); }

  // names over [t0, t1]; out[i] answers names[i]. tag is appended to the phase lines. false: a run error (err set).
  bool run(const std::vector<std::string> &names, uint64_t t0, uint64_t t1, std::vector<WindowAnswer> &out, bool keepRows, const std::string &tag, const PhaseFn &ph) {
    struct Worker { std::unique_ptr<WczStored> ws; std::unique_ptr<DirectStored> ds; std::unique_ptr<WindowSource> win; std::unique_ptr<Eval> e, full; size_t drops = 0; };
    const WindowInputs &I = in; const unsigned nw = std::max(1u, I.threads); err.clear(); leafNote.clear(); drops = 0;
    if (!I.df && I.storedPath.empty()) { err = "a window run needs the stored-only file or the direct source"; return false; }
    if (I.check && I.storedPath.empty()) { err = "the window check needs the stored-only file"; return false; }
    DirectFile *df = I.df; const uint64_t winT[2] = {t0, t1};
    g_directRows = 0; g_storedCpuNs = 0; g_storedMisses = 0; if (df) { df->touched.clear(); df->deferred = I.leaves; }
    std::vector<std::unique_ptr<Worker>> workers;
    for (unsigned t = 0; t < nw; t++) {
      std::unique_ptr<Worker> w(new Worker);
      if (!I.storedPath.empty()) w->ws.reset(new WczStored(I.storedPath));
      if (df) w->ds.reset(new DirectStored(*df, t0, t1));
      w->win.reset(w->ds ? new WindowSource(*w->ds, t0, t1) : new WindowSource(*w->ws, t0, t1));
      w->e.reset(new Eval(*I.F, *I.G, storedFn(*w->win), *I.sem)); w->e->allow = I.allow; w->e->sem.pwrite_cw = true;
      if (I.check) { w->full.reset(new Eval(*I.F, *I.G, storedFn(*w->ws), *I.sem)); w->full->allow = I.allow; w->full->sem.pwrite_cw = true; }
      for (Eval *e : {w->e.get(), w->full.get()}) if (e) { e->histCap = I.histCap; e->forcedNode = I.forcedNode; e->forcedStored = I.forcedStored; }
      workers.push_back(std::move(w)); }
    ph("window-workers", "what\tworkers for this window" + tag);
    std::string perr; std::mutex perrMu; std::atomic<uint64_t> wrows{0}, kept{0};
    auto pfor = [&](size_t n, size_t chunk, const std::function<void(Worker &, size_t)> &fn) {
      std::atomic<size_t> next{0}; std::vector<std::thread> th; std::string startErr;
      for (auto &wp : workers) {
        try { th.emplace_back([&, w = wp.get()] {
          for (;;) { size_t b = next.fetch_add(chunk); if (b >= n) break;
            for (size_t i = b; i < std::min(n, b + chunk); i++) try { fn(*w, i); } catch (const std::exception &e) { std::lock_guard<std::mutex> l(perrMu); if (perr.empty()) perr = e.what(); } } }); }
        catch (const std::system_error &e) { startErr = "cannot start worker thread " + std::to_string(th.size() + 1) + " of " + std::to_string(workers.size()) + ": " + e.what() + " (give fewer --threads); no side file was written"; next = n; break; }
      }
      for (auto &t : th) t.join();
      if (!startErr.empty()) { std::lock_guard<std::mutex> l(perrMu); perr = startErr; } };
    auto evalAll = [&]() { out.assign(names.size(), WindowAnswer()); wrows = 0; kept = 0;
      pfor(names.size(), std::max<size_t>(1, names.size() / (nw * 8 + 1)), [&](Worker &w, size_t i) {
        const std::string &nm = names[i]; WindowAnswer &r = out[i];
        try {
          if (size_t ni = I.severalIds(nm)) throw Refuse("several ids for one name (" + std::to_string(ni) + " ids)");
          if (uint32_t ty = I.nonBit(nm)) throw Refuse("declared with a value type that is not a bit vector (type " + std::to_string(ty) + ") in the converted file");
          NodeId nd{0, 0}; { std::string pw = I.pickNode(nm, nd); if (!pw.empty()) throw Refuse(pw); }
          auto ab = I.absent->find(nm); if (ab == I.absent->end()) throw Refuse("no absent var of this name in the converted file");
          const size_t wd = (size_t)std::llabs(ab->second.first - ab->second.second) + 1;
          Hist h = windowHist(*w.e, nd, wd, winT[0], *I.safe); I.forcedRefuse(w.e->used[nd]);
          if (keepRows && I.keptCap) { const uint64_t b = h.bytes();
            if (kept.fetch_add(b) + b > I.keptCap) { kept.fetch_sub(b); throw Refuse("rows over the memory room of this request (" + std::to_string(I.keptCap >> 20) + " MiB for all the names' rows together)"); } }
          r.st = "ok"; r.rows = h.size(); r.sha = rowsSha(h, 0); wrows += h.size();
          if (w.full) { try { Hist c = canon(w.full->hist(nd), wd), cut = windowCut(c, winT[0], winT[1]); r.chk = rowsSha(cut, winT[0]) == r.sha ? "SAME" : "DIFF"; }
            catch (const Refuse &e) { r.chk = std::string("FULL-REFUSED ") + e.what(); } }
          if (keepRows) r.h = std::move(h);
        } catch (const Refuse &e) { r.st = "refused"; r.why = e.what(); }
        catch (const std::bad_alloc &) { r.st = "refused"; r.why = "out of memory computing this name"; }
        if (w.e->memoBytes + (w.full ? w.full->memoBytes : 0) + w.win->cachedBytes() > I.workerBudget) { w.e->dropMemo(); if (w.full) w.full->dropMemo(); w.win->dropCache(); w.drops++; } });
    };
    evalAll();
    if (df && df->deferred) {
      ph("window-evaluate-unchecked", "touched\t" + std::to_string(df->touched.size()) + tag);
      std::string e; df->f->scan(e, (int)nw, &df->touched);
      if (!e.empty()) { err = "direct scan of " + I.dumpPath + ": " + e; return false; }
      size_t nref = 0; for (auto id : df->touched) { std::string why, e2; if (!df->f->stream_refusal(id, why, e2) || !why.empty()) nref++; }
      // test build only (RUN_PLAN_TEST_HOOKS; the shipped binary does not read these): WISP_TEST_DIRECT_RECHECK takes the
      // re-evaluation path with no refused input; WISP_TEST_DIRECT_NO_RECHECK is the red (keeps the unchecked answers)
      const bool force = RUN_PLAN_TEST_ENV("WISP_TEST_DIRECT_RECHECK") != nullptr, red = RUN_PLAN_TEST_ENV("WISP_TEST_DIRECT_NO_RECHECK") != nullptr;
      ph("direct-scan-leaves", "ids\t" + std::to_string(df->touched.size()) + "\trefused\t" + std::to_string(nref) + (force ? "\tforced_recheck\t1" : "") + tag);
      leafNote = "\tleaf_ids\t" + std::to_string(df->touched.size()) + "\tleaf_refused\t" + std::to_string(nref);
      if ((nref || force) && !red) {   // a read stream is refused: evaluate again, each read checked first (the refusal reaches its names)
        df->deferred = false;
        for (auto &wp : workers) { wp->e->dropMemo(); if (wp->full) wp->full->dropMemo(); wp->win->dropCache(); }
        evalAll(); leafNote += "\trechecked\t1"; }
    }
    if (!perr.empty()) { err = perr; return false; }
    for (auto &wp : workers) drops += wp->drops;
    rows = wrows.load();
    return true;
  }
};

}  // namespace dblk
