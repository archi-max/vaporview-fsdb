// SPDX-License-Identifier: MIT
// ---- computed rows on a direct FSDB open (included by direct_source.cpp.inc, inside namespace dsrc) ----
//
// With the open statement "outsideWrites": "none" (the run wrote no design signal from outside the logic), every port
// copy the converter declares without values (reason code 2, a bit vector) gets a signal id after the stored and typed
// signals. Its values come from the dump's derivation records over the asked window only: the window run that
// derive_side --window runs (convert/fsdb/side/window_run.h, the same code), reading its stored inputs from this open's
// File (DirectFile over it: the same plan, records and per-stream verdicts as the stored rows), with the leaf scan.
// A window request with computed ids first evaluates those names over [t0, t1] (prepare); the rows are then served to
// the store's own window code as one block per name, so a computed row's answer has the stored rows' form. Each name
// that cannot be computed answers its reason by name; the stored rows are not affected.
// Kept per open, built on the first computed request: the dump's derivation block and graph, the planner's id list and
// unlinked-name list (fplan run in memory with the planner command's defaults, the inputs the side-file command gives derive_side),
// and the rule words (built in). Per request: the computed histories and input caches, inside a byte budget (the
// helper's memory room at the request); a name whose history alone passes the room is refused by name.
// Without the statement the dictionary is the one before (those names stay declared without values).
// (g_cOn, g_path, g_cDecl, g_cName: declared in direct_source.cpp.inc, before its dictionary)
static uint32_t nComputed() { return (uint32_t)g_cName.size(); }

// the rule words (convert/fsdb/side/proven-words.txt, window-safe-words.txt), built in by build.sh
#include "window_words.h"

struct CCtx {
  const uint8_t *raw = nullptr; size_t n = 0;
  dblk::FileData F; std::unique_ptr<dblk::Graph> G; dblk::Sem sem; dblk::Words allow, safe;
  std::set<std::string> und;                                     // the planner's unlinked port copies (strip_name)
  std::unordered_map<std::string, std::set<uint64_t>> nameIds; std::unordered_map<std::string, uint64_t> name2id;
  std::unordered_map<uint64_t, dblk::NodeId> t0k;
  std::map<std::string, std::pair<long long, long long>> absent; std::unordered_map<std::string, uint32_t> absentType;
  std::unique_ptr<dblk::DirectFile> df;
  double buildMs = 0;
  ~CCtx() { if (raw) munmap((void *)raw, n); }
};
static std::unique_ptr<CCtx> g_cx;
static std::string g_cxErr;                // why no name of this file is computed ("" = none, or not built yet)
static double g_cxMs = 0;
// the last prepared window: per computed k, its rows (one block) or its reason
struct CRow { bool on = false, ok = false; std::string err; SrcRows rows; uint64_t nNorm = 0, tLast = UINT64_MAX; size_t n = 0; std::string sha; };
static std::vector<CRow> g_crow;
static uint64_t g_cw0 = 0, g_cw1 = 0;
static struct { uint64_t requests = 0, names = 0, ok = 0, refused = 0; double lastMs = 0, lastParseMs = 0; size_t drops = 0; uint64_t rows = 0; } g_cst;

static void computedClose() { g_cOn = false; g_cDecl.clear(); g_cName.clear(); g_cx.reset(); g_cxErr.clear(); g_cxMs = 0; g_crow.clear(); g_cst = {}; }

// a declaration's scope path, dotted (the open's names table)
static std::string declScope(const sigread::wczform::Decl &d) { std::string s; for (auto &c : g_N->path(d.node)) s += (s.empty() ? "" : ".") + c; return s; }

// at open (from buildDict): the computed candidates, in the converter's refused order
static void computedNames() {
  g_cDecl.clear(); g_cName.clear();
  if (!g_cOn) return;
  for (uint32_t k = 0; k < g_decl.refused.size(); k++) {
    const auto &r = g_decl.refused[k];
    if (r.code != 2 || r.state != 1 || r.type != 0) continue;
    std::string nm = declScope(r.decl); nm += (nm.empty() ? "" : ".") + g_N->str[r.decl.leaf];
    g_cDecl.push_back(k); g_cName.push_back(dblk::strip_name(nm));
  }
  g_crow.assign(g_cName.size(), CRow());
}

static double crss() {  // this process's resident bytes
  FILE *f = fopen("/proc/self/statm", "r"); if (!f) return 0;
  unsigned long size = 0, res = 0; const int n = fscanf(f, "%lu %lu", &size, &res); fclose(f);
  return n == 2 ? (double)res * (double)sysconf(_SC_PAGESIZE) : 0;
}
static std::string mib(double b) { return std::to_string((long long)(b / 1048576.0)); }
// The WISP_TEST_COMPUTED_* hooks are for the helper's own tests only (as WISP_TEST_MAX_ROWS). Each can only refuse or
// narrow (a planted failure, a narrower prepared window, a lower kept-rows bound) or write the answers it gives; none
// widens what a request may use.
// WISP_TEST_COMPUTED_THROW=build|run throws inside the build / the window run (build-alloc|run-alloc: out of memory)
static void plantedThrow(const char *where) {
  if (const char *t = getenv("WISP_TEST_COMPUTED_THROW")) {
    if (!strcmp(t, where)) throw std::runtime_error(std::string("planted test failure (") + where + ")");
    if (!strncmp(t, where, strlen(where)) && !strcmp(t + strlen(where), "-alloc")) throw std::bad_alloc();
  }
}

// the per-open part, on first use. room = the bytes this request may use (< 0: no bound). Its memory is checked before
// it is built: an estimate of 400 bytes per declared name for the planner's tables + 2 bytes per dump byte for the
// derivation records, graph and maps. A build that does not fit, or that fails, refuses the computed names of this open
// by name, and is not tried again on this open.
static bool computedBuild(std::string &why, double room) {
  if (g_cx) return true;
  if (!g_cxErr.empty()) { why = g_cxErr; return false; }
  const auto t0 = std::chrono::steady_clock::now();
  auto fail = [&](const std::string &w) { g_cxErr = w; why = w; return false; };
  struct stat fsb; const double fileBytes = stat(g_path.c_str(), &fsb) == 0 ? (double)fsb.st_size : 0;
  const double est = 400.0 * (double)(g_file->vars().size() + g_decl.refused.size() + g_decl.typed.size()) + 2.0 * fileBytes;
  if (room >= 0 && est > room) return fail("computed names need about " + mib(est) + " MiB for this file's derivation records and planner tables (an estimate), over this request's memory room (" + mib(room) + " MiB; the helper's memory bound)");
  try {
  plantedThrow("build");
  std::unique_ptr<CCtx> c(new CCtx);
  { const int fd = ::open(g_path.c_str(), O_RDONLY | O_CLOEXEC); if (fd < 0) return fail("the dump cannot be read again for its derivation records");
    struct stat sb; if (fstat(fd, &sb) != 0) { ::close(fd); return fail("the dump cannot be read again for its derivation records"); }
    void *m = mmap(nullptr, (size_t)sb.st_size, PROT_READ, MAP_PRIVATE, fd, 0); ::close(fd);
    if (m == MAP_FAILED) return fail("the dump cannot be mapped for its derivation records");
    c->raw = (const uint8_t *)m; c->n = (size_t)sb.st_size; }
  { const std::string w = dblk::forceStatusRefusal(c->raw, c->n); if (!w.empty()) return fail(w); }
  try { c->F.B = dblk::read(c->raw, c->n); } catch (const std::exception &e) { return fail(std::string("derivation block not readable: ") + e.what()); }
  if (!c->F.B.present) return fail("no derivation block");
  if (!dblk::proven_release(c->F.B.ver)) return fail("derivation block version '" + c->F.B.ver + "' is not the proven writer release");
  // the planner's id list and unlinked names, as the planner command gives them to derive_side (its defaults)
  fplan::Options o; o.dump_off = true; o.skip_dirs = true; o.ids = true; o.emit_text = false; o.emit_struct = true; o.crc = false; o.threads = (int)workThreads();
  fplan::Result res; std::string perr;
  if (!fplan::build(c->raw, c->n, o, res, perr)) return fail("the planner refuses the file for computed names: " + perr);
  { std::istringstream in(res.ids); dblk::load(c->F, in); }
  res.ids.clear(); res.ids.shrink_to_fit(); res.sp = fplan::StructPlan();
  for (auto &r : res.refusals) {
    if (r.reason == "duplicate full name" || r.scope.empty() || r.name.empty()) continue;
    const std::string why2 = r.is_string ? "string: decoder pending" : r.nonbit == 1 ? "real: decoder pending" : r.nonbit == 2 ? "event: not stored in WCZ v1" : r.reason == "extended ID has no qualified value index" ? (res.link_reason.count(r.ident) ? res.link_reason.at(r.ident) : std::string("port copy: values not linked yet")) : r.reason;
    if (why2 != "port copy: values not linked yet") continue;
    std::string nm; for (auto &x : r.scope) nm += (nm.empty() ? "" : ".") + x; nm += (nm.empty() ? "" : ".") + r.name;
    c->und.insert(dblk::strip_name(nm));
  }
  c->G.reset(new dblk::Graph(c->F, false));
  for (auto k : c->F.idOrder) for (auto &nm : c->F.idn[k]) { const std::string sn = dblk::strip_name(nm); c->name2id.emplace(sn, k); c->nameIds[sn].insert(k); }
  for (auto &t : c->F.B.t0) c->t0k.emplace(t.k, dblk::NodeId{t.x, t.v});
  // the names the converted file declares without values (its WCZ dictionary: this open's refused declarations)
  static const std::regex RG("\\[-?\\d+:-?\\d+\\]$");
  for (auto &r : g_decl.refused) {
    std::string nm = declScope(r.decl); nm += "." + std::regex_replace(g_N->str[r.decl.leaf], RG, "");
    c->absent.emplace(nm, std::make_pair((long long)r.decl.msb, (long long)r.decl.lsb)); c->absentType.emplace(nm, (uint32_t)r.type); }
  c->allow = dblk::readWordsText(kProvenWords); c->safe = dblk::readWordsText(kWindowSafeWords);
  c->df.reset(new dblk::DirectFile(*g_file));
  c->buildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  g_cxMs = c->buildMs; g_cx = std::move(c);
  return true;
  } catch (const std::bad_alloc &) { return fail("out of memory building the derivation records for computed names");
  } catch (const std::exception &e) { return fail(std::string("computed names cannot be built for this file: ") + e.what()); }
}

// one computed history as the store's raw rows (value plane, then x/z plane; position 0 the MSB), its normalized count
static bool computedRows(const dblk::Hist &h, uint32_t bits, CRow &r, std::string &err) {
  const uint32_t st = (bits + 7) / 8, vlen = wcz::SigSpec::vlenFor(wcz::VT_BITS, bits, true);
  if (vlen != 2 * st) { err = "plane length"; return false; }
  std::vector<uint8_t> allX(st, 0), last; bool haveLast = false;
  for (uint32_t k = 0; k < bits; k++) allX[k >> 3] |= (uint8_t)(1 << (k & 7));
  r.rows.clear(); r.nNorm = 0;
  for (size_t i = 0; i < h.size(); i++) {
    if (h.width(i) != bits) { err = "computed width " + std::to_string(h.width(i)) + " vs declared " + std::to_string(bits); return false; }
    const uint8_t *p = h.planes(i);
    r.rows.t.push_back(h.time(i)); r.rows.v.insert(r.rows.v.end(), p, p + vlen); r.rows.off.push_back(r.rows.v.size());
    if (i + 1 < h.size() && h.time(i + 1) == h.time(i)) continue;   // (the store keeps the last row at a time)
    const bool same = haveLast ? !memcmp(p, last.data(), vlen) : std::all_of(p, p + st, [](uint8_t b) { return b == 0; }) && !memcmp(p + st, allX.data(), st);
    if (!same) { r.nNorm++; last.assign(p, p + vlen); haveLast = true; }
  }
  r.tLast = h.size() ? h.time(h.size() - 1) : UINT64_MAX;
  return true;
}

// the computed names among ids over [t0, t1]; budget = the bytes the request may use (< 0: the helper has no memory bound)
static void computedPrepare(const std::vector<int64_t> &ids, uint64_t t0, uint64_t t1, double budget, unsigned threads) {
  const uint32_t base = nBits() + (uint32_t)g_decl.typed.size();
  std::vector<uint32_t> ks;
  for (int64_t id : ids) { if (id < 1) continue; const uint64_t i = (uint64_t)id - 1; if (i >= base && i < base + nComputed()) ks.push_back((uint32_t)(i - base)); }
  if (ks.empty()) return;
  std::sort(ks.begin(), ks.end()); ks.erase(std::unique(ks.begin(), ks.end()), ks.end());
  const auto c0 = std::chrono::steady_clock::now();
  for (auto &r : g_crow) r = CRow();
  // evaluated from t0 - 1: the first row is then the value in effect before t0 (as a stored row's last change before t0),
  // and a change at t0 itself is a row at t0, so the window's records and counts mean what they mean for stored rows
  if (t0 > 0) t0--;
  g_cw0 = t0; g_cw1 = t1; g_cst.requests++; g_cst.names += ks.size();
  if (getenv("WISP_TEST_COMPUTED_NARROW")) g_cw0 = t0 + 2;   // test only: the guard on reads outside the prepared window
  auto refuseAll = [&](const std::string &w) { for (auto k : ks) { g_crow[k].on = true; g_crow[k].err = w; } g_cst.refused += ks.size(); };
  if (forceLog()) { refuseAll("computed values are not served with a force log (WISP_FORCE_LOG) on this open"); return; }
  // any failure past here refuses the computed names of this request by name; the stored rows are answered as usual
  const uint64_t ok0 = g_cst.ok, ref0 = g_cst.refused;
  auto recount = [&] { uint64_t n = 0; for (auto k : ks) n += g_crow[k].ok; g_cst.ok = ok0 + n; g_cst.refused = ref0 + (ks.size() - n); };  // (after a failure)
  try {
  std::string why;
  const double p0 = g_cxMs, r0 = crss();
  if (!computedBuild(why, budget)) { refuseAll(why); return; }
  g_cst.lastParseMs = g_cxMs - p0;
  if (budget >= 0 && g_cxMs != p0) budget = std::max(0.0, budget - std::max(0.0, crss() - r0));   // what the build kept
  CCtx &c = *g_cx;
  std::vector<std::string> names; std::vector<uint32_t> nk;
  for (auto k : ks) {
    const std::string &nm = g_cName[k]; CRow &r = g_crow[k]; r.on = true;
    if (!c.und.count(nm)) { r.err = "not computed: the planner does not list this name as an unlinked port copy"; g_cst.refused++; continue; }
    names.push_back(nm); nk.push_back(k);
  }
  if (names.empty()) return;
  dblk::WindowInputs wi; wi.F = &c.F; wi.G = c.G.get(); wi.sem = &c.sem; wi.allow = &c.allow; wi.safe = &c.safe; wi.dumpPath = g_path; wi.df = c.df.get(); wi.absent = &c.absent;
  wi.severalIds = [&c](const std::string &nm) -> size_t { auto it = c.nameIds.find(nm); return it == c.nameIds.end() || it->second.size() < 2 ? 0 : it->second.size(); };
  wi.nonBit = [&c](const std::string &nm) -> uint32_t { auto it = c.absentType.find(nm); return it == c.absentType.end() || it->second <= 4 ? 0 : it->second; };
  wi.pickNode = [&c](const std::string &nm, dblk::NodeId &nd) -> std::string {
    auto a = c.name2id.find(nm); if (a == c.name2id.end()) return "no table entry";
    auto t = c.t0k.find(a->second); if (t == c.t0k.end()) return "no table entry"; nd = t->second; return ""; };
  wi.forcedRefuse = [](const dblk::Words &w) { for (auto &x : w) if (x.compare(0, 7, "FORCED:") == 0) throw dblk::Refuse("computed from a forced or deposited signal: " + x.substr(7)); };
  wi.threads = std::max(1u, threads); wi.leaves = true;
  // memory: the request's room (the bytes left under the helper's refusal line) for the workers' caches; a history over
  // the room (or over 4 GiB) refused by name
  // the room is shared: half for the workers' caches (dropped and recomputed when over), half for the rows the request
  // keeps (all names together, the computed histories and then the served rows); one name over it is refused by name
  const uint64_t room = budget < 0 ? (6ull << 30) : (uint64_t)budget;
  wi.workerBudget = std::max<uint64_t>(1, room / 2 / wi.threads); wi.keptCap = std::max<uint64_t>(1, room / 2);
  wi.histCap = std::max<uint64_t>(1, std::min<uint64_t>(room / 2, 4ull << 30));
  if (const char *k = getenv("WISP_TEST_COMPUTED_KEPT")) if (*k) wi.keptCap = std::max<uint64_t>(1, std::min<uint64_t>(wi.keptCap, strtoull(k, nullptr, 10)));   // test only: a lower kept-rows bound in bytes
  dblk::WindowRun run(wi); std::vector<dblk::WindowAnswer> out;
  plantedThrow("run");
  const bool ok = run.run(names, t0, t1, out, true, "", [](const char *, const std::string &) {});
  g_cst.drops += run.drops; g_cst.rows += run.rows;
  for (size_t j = 0; j < nk.size(); j++) {
    CRow &r = g_crow[nk[j]];
    if (!ok) { r.err = run.err; g_cst.refused++; continue; }
    dblk::WindowAnswer &a = out[j];
    if (a.st != "ok") {
      r.err = a.why;
      if (r.err.compare(0, 39, "history over the per-history memory cap") == 0) r.err = "history over this request's memory room (" + std::to_string(wi.histCap >> 20) + " MiB; the helper's memory bound)";
      g_cst.refused++; continue; }
    const auto &dc = g_decl.refused[g_cDecl[nk[j]]].decl; const uint32_t bits = (uint32_t)(std::llabs(dc.msb - dc.lsb) + 1);
    std::string e;
    if (!computedRows(a.h, bits, r, e)) { r.err = e; g_cst.refused++; continue; }
    r.ok = true; r.n = a.rows; r.sha = a.sha; g_cst.ok++;
    a.h = dblk::Hist();
  }
  } catch (const std::bad_alloc &) { for (auto k : ks) { CRow &r = g_crow[k]; if (!r.ok) { r = CRow(); r.on = true; r.err = "out of memory computing this name"; } } recount();
  } catch (const std::exception &e) { for (auto k : ks) { CRow &r = g_crow[k]; r = CRow(); r.on = true; r.err = std::string("computed names: ") + e.what(); } recount(); }
  g_cst.lastMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - c0).count();
  // test only: WISP_TEST_COMPUTED_OUT=<prefix>: request n's answers to <prefix>.<n>, in derive_side --window-out's columns
  // (the window evaluated, [t0 - 1, t1]) plus the signal id
  if (const char *to = getenv("WISP_TEST_COMPUTED_OUT")) if (*to) {
    if (FILE *f = fopen((std::string(to) + "." + std::to_string(g_cst.requests)).c_str(), "w")) { fprintf(f, "name\tstatus\trows\tsha256\tcheck\treason\tsignal_id\n");
      for (auto k : ks) { const CRow &r = g_crow[k]; fprintf(f, "%s\t%s\t%zu\t%s\t\t%s\t%u\n", g_cName[k].c_str(), r.ok ? "ok" : "refused", r.n, r.sha.c_str(), r.ok ? "" : r.err.c_str(), base + k + 1); }
      fclose(f); } }
}

static uint64_t computedNRows(uint32_t k) { return k < g_crow.size() && g_crow[k].ok ? g_crow[k].rows.n() : 0; }
static uint64_t computedT0(uint32_t k) { return computedNRows(k) ? g_crow[k].rows.t[0] : UINT64_MAX; }
// after the window request: no computed values are served outside a window request (valueAt, count, edge, search)
static void computedDone() { for (auto &r : g_crow) r = CRow(); }
// the block-source view of computed signal k (its last prepared window)
static const CRow *computedRow(uint32_t k, std::string &err) {
  if (k >= g_crow.size() || !g_crow[k].on) { err = "a computed signal answers window requests only"; return nullptr; }
  if (!g_crow[k].ok) { err = g_crow[k].err; return nullptr; }
  return &g_crow[k];
}
