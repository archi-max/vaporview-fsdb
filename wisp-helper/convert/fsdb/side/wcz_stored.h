// SPDX-License-Identifier: MIT
// wcz_stored.h (file-only route): stored histories of a converted (no-merge) WCZ through the tree's own
// reader (include/wcz_seg.h), in-process. Same names, same values and same settling as the dump tool gets them through its
// `tree` and `values` output (checked byte-identical against that path).
#pragma once
#include "wcz_seg.h"
#include "wcz_text.h"
#include "derive_eval.h"
#include <atomic>
#include <ctime>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace dblk {

// phase timing (derive_side DERIVE_PHASES=<file>): thread CPU spent reading and building stored histories (cache misses)
inline std::atomic<uint64_t> g_storedCpuNs{0}, g_storedMisses{0}; inline bool g_storedTiming = false;
inline uint64_t threadCpuNs() { timespec t; clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t); return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec; }

struct WczStored final : LeafSource {
  wcz::SegReader r; const uint8_t *m = nullptr; size_t n = 0; ZSTD_DCtx *zd = ZSTD_createDCtx();
  struct V { uint32_t sig; long long msb, lsb; };
  std::unordered_map<std::string, V> var; std::map<std::string, std::pair<long long, long long>> absent; std::unordered_map<std::string, uint32_t> absentType;   // the converted file's declared value type of each absent var (0 = bit vector)
  std::unordered_map<uint32_t, std::shared_ptr<const Hist>> cache;
  uint64_t cacheBytes = 0; void dropCache() override { cache.clear(); cacheBytes = 0; }
  uint64_t cachedBytes() const override { return cacheBytes; }
  int8_t tsExp = 0; uint16_t tsMult = 1; uint64_t tEnd = 0;
  ~WczStored() override { ZSTD_freeDCtx(zd); if (m) munmap((void *)m, n); }
  explicit WczStored(const std::string &path) {
    int fd = ::open(path.c_str(), O_RDONLY); if (fd < 0) throw std::runtime_error("cannot open " + path);
    struct stat st; fstat(fd, &st); n = st.st_size; void *p = mmap(nullptr, n, PROT_READ, MAP_PRIVATE, fd, 0); ::close(fd);
    if (p == MAP_FAILED) throw std::runtime_error("mmap " + path); m = (const uint8_t *)p;
    std::string err; if (!r.open(m, n, err)) throw std::runtime_error(path + ": " + err);
    const auto &D = r.dict(); tsExp = r.header().tsExp; tsMult = r.header().tsMult; tEnd = r.horizon() == wcz::NONE64 ? r.header().tBegin : r.horizon();
    std::vector<std::string> path_(D.scopes.size());
    for (size_t i = 0; i < D.scopes.size(); i++) { auto &s = D.scopes[i]; path_[i] = (s.parent == wcz::NONE32 ? std::string() : path_[s.parent] + ".") + D.strs[s.name]; }
    static const std::regex RG("\\[-?\\d+:-?\\d+\\]$");
    for (auto &v : D.vars) {
      std::string nm = path_[v.scope] + "." + std::regex_replace(D.strs[v.name], RG, "");
      if (v.signal != wcz::NONE32 && v.type == 0) var.emplace(nm, V{v.signal, (long long)v.msb, (long long)v.lsb});
      if (v.signal == wcz::NONE32) { absent.emplace(nm, std::make_pair((long long)v.msb, (long long)v.lsb)); absentType.emplace(nm, (uint32_t)v.type); }
    }
  }
  // a read block's pages of the map are given back (read-only private map: read from the file again if touched later), so the
  // stored file does not stay resident in every worker's map
  void dropPages(const wcz::BlockRef &br) const {
    static const uintptr_t pg = (uintptr_t)sysconf(_SC_PAGESIZE);
    if (br.off >= n || br.info.len == 0) return; const uintptr_t a = (uintptr_t)(m + br.off) & ~(pg - 1), e = (uintptr_t)(m + std::min<uint64_t>(n, br.off + br.info.len));
    madvise((void *)a, e - a, MADV_DONTNEED);
  }
  std::shared_ptr<const Hist> hist(const std::string &name) override {
    auto it = var.find(name); if (it == var.end()) return nullptr;
    uint32_t i = it->second.sig; auto c = cache.find(i); if (c != cache.end()) return c->second;
    const uint64_t c0 = g_storedTiming ? threadCpuNs() : 0;
    const auto &D = r.dict(); const wcz::SigSpec &s = D.sigs[r.dataOf(i)].spec; wcz::Rows rows; std::vector<uint8_t> tmp; std::string err;
    auto h = std::make_shared<Hist>(); size_t w = (size_t)std::llabs(it->second.msb - it->second.lsb) + 1;
    for (uint32_t b = 0; b < r.nblk(i); b++) for (uint32_t ch = 0, nc = r.block(i, b).info.nchunk; ch < nc; ch++) {
      if (!r.decodeChunk(zd, i, b, ch, rows, tmp, err)) throw std::runtime_error("decode " + name + ": " + err);
      // a bit vector at least as wide as the declared range: its planes are this file's text-order planes, taken as they are
      // (the same value the text path builds: valueText of s.bits positions, no padding)
      const bool direct = s.vtype == wcz::VT_BITS && s.bits >= w && s.bits > 0 && s.vlen >= (s.fourState ? 2u : 1u) * ((s.bits + 7) / 8);
      for (uint32_t j = 0; j < rows.n(); j++) {
        if (!r.complete() && (r.horizon() == wcz::NONE64 || rows.t[j] > r.horizon())) break;
        if (direct) { const uint8_t *pv = rows.val(j, s.vlen), *pb = s.fourState ? pv + (s.bits + 7) / 8 : nullptr; uint64_t t = rows.t[j];
          if (!h->empty() && h->time(h->size() - 1) == t) h->setLastPlanes(s.bits, pv, pb); else h->pushPlanes(t, s.bits, pv, pb); continue; }
        std::string val = wcz::valueText(s, rows.val(j, s.vlen), rows.len(j, s.vlen));
        if (val.size() < w) val = std::string(w - val.size(), (val[0] == 'x' || val[0] == 'z') ? val[0] : '0') + val;
        uint64_t t = rows.t[j]; if (!h->empty() && h->time(h->size() - 1) == t) h->setLast(val); else h->push(t, val);
      }
      if (ch + 1 == nc) dropPages(r.block(i, b));
    }
    // the evaluator reads a stored value as x until its first row: that x row at time 0 is added here, once per signal, so
    // the evaluator does not keep a second copy of the history with it (same rows as before for every caller)
    if (!h->empty() && h->time(0) != 0) h->prepend(0, X(h->width(0)));
    h->shrink(); cache[i] = h; cacheBytes += h->bytes();
    if (g_storedTiming) { g_storedCpuNs += threadCpuNs() - c0; g_storedMisses++; }
    return h;
  }
};

}  // namespace dblk
