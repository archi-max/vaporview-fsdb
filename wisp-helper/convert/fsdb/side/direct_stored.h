// SPDX-License-Identifier: MIT
// direct_stored.h: a leaf source over the FSDB file read directly (sigread, the lazy open), for a window [t0, t1].
// For each stored input it decodes only the records from the last one that starts at or before t0 (one earlier if that is
// an inline record) up to the first one past t1 (sigread File::changes_planes), not the whole history. The history it gives
// is partial, in file time: the last row at or before t0 (the window-start value), then the rows in (t0, t1]; with the
// stored-only file's rules (WczStored): rows at one time settle to the last, values are MSB-first 0/1/x/z text at the
// declared width, and an x row at time 0 when the first row is later. Wrapped in WindowSource, the cut is the same as the
// cut of the whole history: the rows at or before t0 that are left out do not change the value at t0.
// A stored input that has rows only after t1 gives one x row at 0 (its value at t0); a stream the converter refuses gives
// the refusal (Refuse) by name.
#pragma once
#include "derive_eval.h"
#include "sigread.h"
#include "wcz_stored.h"   // threadCpuNs, g_storedCpuNs / g_storedMisses (the same stored-read counters)
#include <atomic>
#include <memory>
#include <mutex>
#include <regex>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace dblk {

// the file read directly, opened once and shared by every worker's source (sigread reads are thread-safe): opened here
// from a path (derive_side), or an existing open File the caller keeps (the helper's direct open; not owned)
struct DirectFile {
  std::unique_ptr<sigread::File> own;
  sigread::File *f = nullptr;
  struct V { uint64_t id; uint32_t bits; };
  std::unordered_map<std::string, V> var;   // full name (scope.name, range removed) -> stored id
  // deferred = true: the window reads skip the per-stream rules and record the ids they read (touched); the caller then
  // applies the rules to those ids at once (File::scan over them) and, if any of them is refused, evaluates again with
  // deferred = false (each read checked first), so no answer ever uses a refused stream.
  bool deferred = false; std::mutex mu; std::unordered_set<uint64_t> touched;
  explicit DirectFile(const std::string &path, int threads = 0) {
    std::string err; own = sigread::File::open_lazy(path, err, 0, threads);
    if (!own) throw std::runtime_error("direct read of " + path + ": " + err);
    f = own.get(); names();
  }
  explicit DirectFile(sigread::File &file) : f(&file) { names(); }
 private:
  void names() {
    static const std::regex RG("\\[-?\\d+:-?\\d+\\]$");
    auto full = [&](const std::vector<std::string> &sc, const std::string &nm) {
      std::string s; for (auto &c : sc) s += c + "."; return s + std::regex_replace(nm, RG, ""); };
    const auto &vs = f->vars();
    if (const sigread::Names *N = f->names()) {  // a compact open: the names are in its table (var k: slots off[k] .. off[k + 1])
      for (size_t k = 0; k < vs.size(); k++)
        for (uint64_t sl = N->off[k]; sl < N->off[k + 1]; sl++) var.emplace(full(N->path(N->node[sl]), N->str[N->leaf[sl]]), V{vs[k].id, vs[k].bits});
      return;
    }
    for (auto &v : vs) {
      var.emplace(full(v.scope, v.name), V{v.id, v.bits});
      for (auto &a : v.aliases) var.emplace(full(a.scope, a.name), V{v.id, v.bits});
    }
  }
};

inline std::atomic<uint64_t> g_directRows{0}, g_directCalls{0};
// measurement switch (WISP_DIRECT_STATS=<file>): one line per stored input read, written when the process ends:
// id bits recs b_recs k0 recs_read rows_read rows_out t0rec_rows t0rec_span check_cpu_ns read_cpu_ns text_cpu_ns
struct DirectStats {
  std::mutex mu; std::vector<std::string> lines; const char *path = getenv("WISP_DIRECT_STATS");
  ~DirectStats() { if (!path || lines.empty()) return; FILE *f = fopen(path, "w"); if (!f) return;
    fputs("id\tbits\trecs\tb_recs\tk0\trecs_read\trows_read\trows_out\tt0rec_rows\tt0rec_span\tcheck_ns\tread_ns\ttext_ns\n", f);
    for (auto &l : lines) fputs(l.c_str(), f); fclose(f); }
};
inline DirectStats g_directStats;

struct DirectStored final : LeafSource {
  DirectFile &df; uint64_t t0, t1;
  std::unordered_map<uint64_t, std::shared_ptr<const Hist>> cache; uint64_t bytes = 0;
  DirectStored(DirectFile &d, uint64_t a, uint64_t z) : df(d), t0(a), t1(z) {}
  std::shared_ptr<const Hist> hist(const std::string &name) override {
    auto it = df.var.find(name); if (it == df.var.end()) return nullptr;
    const uint64_t id = it->second.id; const uint32_t w = it->second.bits;
    auto c = cache.find(id); if (c != cache.end()) return c->second;
    const uint64_t c0 = g_storedTiming ? threadCpuNs() : 0;
    auto h = std::make_shared<Hist>(); std::string err; std::vector<uint8_t> codes; std::string val(w, 'x'); uint64_t n = 0;
    static const char kC[4] = {'0', '1', 'x', 'z'};
    const bool st = g_directStats.path != nullptr; uint64_t s0 = 0, s1 = 0, tx = 0;
    if (st && !df.deferred) { s0 = threadCpuNs(); std::string why, e2; df.f->stream_refusal(id, why, e2); s1 = threadCpuNs(); }
    const bool dfr = df.deferred; if (dfr) { std::lock_guard<std::mutex> g(df.mu); df.touched.insert(id); }
    const bool ok = df.f->changes_planes(id, t0, t1, [&](uint64_t t, const uint8_t *p, size_t len) {
      const uint64_t q0 = st ? threadCpuNs() : 0;
      sigread::codes_from_planes(p, len, w, codes); for (uint32_t j = 0; j < w; j++) val[j] = kC[codes[j] & 3]; n++;
      if (!h->empty() && h->time(h->size() - 1) == t) h->setLast(val); else h->push(t, val);
      if (st) tx += threadCpuNs() - q0; }, err, !dfr);
    if (!ok) throw Refuse("stored input " + name + ": " + err);
    if (h->empty()) { bool any = false; for (auto &r : df.f->records(id)) if (r.count) { any = true; break; } if (any) h->push(0, X(w)); }
    else if (h->time(0) != 0) h->prepend(0, X(h->width(0)));
    if (st) { const uint64_t s2 = threadCpuNs(); auto rs = df.f->records(id); size_t k0 = 0, nb = 0, nr = 0; uint64_t rows = 0;
      for (size_t k = 0; k < rs.size(); k++) { if (rs[k].kind == 'B') nb++; if (rs[k].begin <= t0) k0 = k; }
      if (k0 > 0 && rs[k0].kind != 'B') k0--;
      for (size_t k = k0; k < rs.size() && rs[k].begin <= t1; k++) { nr++; rows += rs[k].count; }
      const uint64_t r0 = rs.empty() ? 0 : rs[k0].count, sp = rs.empty() ? 0 : (k0 + 1 < rs.size() ? rs[k0 + 1].begin : rs[k0].end) - rs[k0].begin;
      char b[256]; snprintf(b, sizeof b, "%llu\t%u\t%zu\t%zu\t%zu\t%zu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\n", (unsigned long long)id, w, rs.size(), nb, k0, nr,
        (unsigned long long)rows, (unsigned long long)n, (unsigned long long)r0, (unsigned long long)sp, (unsigned long long)(s1 - s0),
        (unsigned long long)(s2 - s1 - tx), (unsigned long long)tx);
      std::lock_guard<std::mutex> g(g_directStats.mu); g_directStats.lines.push_back(b); }
    h->shrink(); bytes += h->bytes(); cache.emplace(id, h); g_directRows += n; g_directCalls++;
    if (g_storedTiming) { g_storedCpuNs += threadCpuNs() - c0; g_storedMisses++; }
    return h;
  }
  void dropCache() override { cache.clear(); bytes = 0; }
  uint64_t cachedBytes() const override { return bytes; }
};

}  // namespace dblk
