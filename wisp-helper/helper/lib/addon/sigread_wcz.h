// SPDX-License-Identifier: MIT
// sigread_wcz (helper side): the declarations the converter writes into the WCZ of the same file, from a sigread::File
// (its vars(), refusals() and typed(), the names as a sigread::Names table). Kept with the helper (the converter owns
// sigread.h; this file only arranges its declarations the way the converter's WCZ lists them). The converter's rules, in
// its order:
//   - names: an escaped component ("\x", "\x [3:0]") takes its reader form ("x", "x[3:0]") unless that plain form
//     collides with another declaration's; a declaration whose full name is already declared is dropped (first kept);
//   - stored bit signals in vars() order, each followed by its aliases;
//   - then the refused declarations, in planner order, as declared-without-values rows (fplan_main --undeclared, then
//     run_plan_threaded's RUN_PLAN_UNDECLARED step): state, type, reason text and reason code;
//   - then real and string signals (typed()), after every bit signal; a typed signal whose every name is already
//     declared is dropped.
// Every name is a (scope node, leaf string) pair of the Names table: a full name is declared once per pair, and the plain
// form of a node or string is computed once. Per stored declaration nothing is kept beyond the table's own slot, except
// for the few whose form changes (escaped names).
#pragma once
#include "sigread.h"
#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

namespace sigread {
namespace wczform {

struct Decl { uint32_t node = 0, leaf = 0; int64_t msb = 0, lsb = 0; };  // in Names terms
struct Undeclared { Decl decl; int state = 0, type = 0, code = 0; std::string reason; };
struct TypedDecls { size_t k = 0; std::vector<Decl> decls; };  // k = typed() index
struct Declarations {
  // stored declarations: slot s of the table, in its own form unless listed in changed (sorted by slot): (slot, node, leaf)
  struct Changed { uint64_t slot; uint32_t node, leaf; };
  std::vector<Changed> changed;
  std::vector<Undeclared> refused; std::vector<TypedDecls> typed;
};

// the converter's reader form of an escaped component: "\x" -> "x", "\x [3:0]" -> "x[3:0]"
inline std::string reader_form(const std::string& x) {
  if (x.size() < 2 || x[0] != '\\') return x;
  std::string o = x.substr(1); const size_t sp = o.find(' ');
  if (sp == std::string::npos) return o;
  std::string tail = o.substr(sp + 1); o.resize(sp); if (o.empty()) return x;
  return o + tail;
}
inline bool escaped(const std::string& x) { return x.size() >= 2 && x[0] == '\\'; }

// The plain (reader) form of every node and string of N, computed once each and kept as indices into N.
struct Plain {
  Names& N; std::vector<uint32_t> pnode, pstr; std::vector<uint8_t> enode, estr;  // plain form; 1 = an escaped part on the path / in the text
  explicit Plain(Names& n) : N(n) {}
  uint32_t str(uint32_t s, bool& esc) {
    if (s >= pstr.size()) { pstr.resize(N.str.size(), UINT32_MAX); estr.resize(N.str.size(), 0); }
    if (pstr[s] == UINT32_MAX) { const std::string x = N.str[s]; estr[s] = escaped(x); pstr[s] = estr[s] ? N.intern(reader_form(x)) : s; }
    esc = estr[s]; return pstr[s]; }
  uint32_t node(uint32_t n, bool& esc) {
    if (n == 0) { esc = false; return 0; }
    if (n >= pnode.size()) { pnode.resize(N.par.size(), UINT32_MAX); enode.resize(N.par.size(), 0); }
    if (pnode[n] != UINT32_MAX) { esc = enode[n]; return pnode[n]; }
    std::vector<uint32_t> up; for (uint32_t a = n; a && (a >= pnode.size() || pnode[a] == UINT32_MAX); a = N.par[a]) up.push_back(a);
    for (size_t i = up.size(); i-- > 0;) {
      const uint32_t a = up[i], pa = N.par[a]; bool ep = false, ec = false; const uint32_t pp = pa ? pnode[pa] : 0; ep = pa ? enode[pa] : false;
      const uint32_t pc = str(N.cs[a], ec); const uint32_t r = (ep || ec) ? N.child(pp, pc) : a;  // (unchanged path: the node itself)
      if (a >= pnode.size() || N.par.size() > pnode.size()) { pnode.resize(N.par.size(), UINT32_MAX); enode.resize(N.par.size(), 0); }
      pnode[a] = r; enode[a] = ep || ec;
    }
    esc = enode[n]; return pnode[n]; }
};
inline uint64_t key_of(uint32_t node, uint32_t leaf) { return (uint64_t(node) << 32) | leaf; }

// N = the file's names (File::names_mut() of a compact open, or names_from(f) for an open with names in vars()).
inline bool declarations(const File& f, Names& N, Declarations& out, std::string& err) {
  out = Declarations(); Plain P(N);
  const uint64_t ns = N.slots();
  // the names declared so far: the table's own keys (every stored slot in its own form, unique: the plan check refuses a
  // repeated one), minus the slots whose form changed, plus the changed forms and every later group's names
  Map64 gone, added;
  auto declared = [&](uint64_t k) { return added.has(k) || (N.has_key(uint32_t(k >> 32), uint32_t(k)) && !gone.has(k)); };
  // stored names: reader form when the plain form is unique among the stored declarations. Counted only when the file
  // has an escaped part at all (otherwise every name keeps its own form).
  bool any = false;
  for (uint64_t s = 0; s < ns && !any; s++) { bool a = false, b = false; P.node(N.node[s], a); P.str(N.leaf[s], b); any = a || b; }
  Map64 cnt;
  if (any) for (uint64_t s = 0; s < ns; s++) { bool a, b; const uint64_t pk = key_of(P.node(N.node[s], a), P.str(N.leaf[s], b)); uint32_t* c = cnt.find_or_add(pk, 0); if (*c < 2) ++*c; }
  if (any) for (uint64_t s = 0; s < ns; s++) {
    bool a = false, b = false; const uint32_t pn = P.node(N.node[s], a), pl = P.str(N.leaf[s], b);
    const uint64_t raw = key_of(N.node[s], N.leaf[s]);
    if ((a || b) && cnt.has(key_of(pn, pl)) && *cnt.find_or_add(key_of(pn, pl), 0) == 1) {
      const uint64_t pk = key_of(pn, pl);
      // (declared so far = the changed forms and the own forms of the earlier slots that kept theirs)
      const uint32_t own = N.key_slot(pn, pl);
      if (pk != raw) { if (added.has(pk) || (own != UINT32_MAX && own < s && !gone.has(pk))) { err = "duplicate declaration"; return false; }
        gone.find_or_add(raw, 1); added.find_or_add(pk, 1); out.changed.push_back({s, pn, pl}); }
      else if (added.has(raw)) { err = "duplicate declaration"; return false; }
    } else if (added.has(raw)) { err = "duplicate declaration"; return false; }
  }
  // later groups: reader form when the plain name is not declared yet; an already declared name is dropped
  auto later = [&](uint32_t node, uint32_t leaf) {
    bool a = false, b = false; const uint32_t pn = P.node(node, a), pl = P.str(leaf, b);
    if ((a || b) && !declared(key_of(pn, pl))) return key_of(pn, pl);
    return key_of(node, leaf); };
  const auto RF = f.refusals();
  for (auto& r : RF) {
    const bool hasNode = r.node != UINT32_MAX;  // (a compact open: the scope as a node; otherwise its components)
    if (r.reason == "duplicate full name" || (hasNode ? r.node == 0 : r.scope.empty()) || r.name.empty()) continue;
    const bool nonbit = r.bits <= 0; Undeclared u; int64_t msb = r.left, lsb = r.right;
    if (r.is_string) { u.state = 1; u.type = 6; msb = lsb = 0; }
    else if (r.nonbit == 1) { u.state = 1; u.type = 5; msb = lsb = 0; }
    else if (r.nonbit == 2) { u.state = 2; u.type = 7; msb = lsb = 0; }
    else if (nonbit) { u.state = 2; u.type = 8; msb = lsb = 0; }
    else { u.state = 1; u.type = 0; }
    u.reason = r.is_string ? "string: decoder pending" : r.nonbit == 1 ? "real: decoder pending" : r.nonbit == 2 ? "event: not stored in WCZ v1"
             : r.reason == "extended ID has no qualified value index" ? "port copy: values not linked yet" : r.reason;
    u.code = 7;
    if (r.nonbit == 2) u.code = 5;
    else if (r.is_string || r.nonbit) u.code = 4;
    else if (r.reason == "extended ID has no qualified value index") u.code = 2;
    else if (nonbit) u.code = 5;
    else if (r.reason == "no supported physical index") u.code = 1;
    else if (r.reason.find("packed-plane stream width") != std::string::npos || r.reason.find("limit") != std::string::npos) u.code = 6;
    else if (r.reason.find("unsupported value encoding") != std::string::npos || r.reason.find("stream width") != std::string::npos) u.code = 3;
    if (!(std::llabs(msb - lsb) < (int64_t(1) << 32) && msb >= INT32_MIN && msb <= INT32_MAX && lsb >= INT32_MIN && lsb <= INT32_MAX && (hasNode ? N.depth[r.node] : r.scope.size()) <= 512)) { err = "invalid refused declaration"; return false; }
    const uint64_t k = later(hasNode ? r.node : N.node_of(r.scope), N.intern(r.name));
    if (declared(k)) continue;  // already declared: keep the first
    added.find_or_add(k, 1);
    u.decl.node = uint32_t(k >> 32); u.decl.leaf = uint32_t(k); u.decl.msb = msb; u.decl.lsb = lsb;
    out.refused.push_back(std::move(u));
  }
  const auto& Y = f.typed();
  for (size_t k = 0; k < Y.size(); k++) {
    TypedDecls t; t.k = k;
    for (auto& n : Y[k].names) {
      const uint64_t key = later(N.node_of(n.first), N.intern(n.second));
      if (declared(key)) continue;
      added.find_or_add(key, 1);
      Decl d; d.node = uint32_t(key >> 32); d.leaf = uint32_t(key); t.decls.push_back(d);
    }
    if (!t.decls.empty()) out.typed.push_back(std::move(t));
  }
  return true;
}

// A Names table for a File whose names are in vars() (the verified open): the same slots a compact open builds.
inline bool names_from(const File& f, Names& N, std::string& err) {
  N = Names();
  for (auto& v : f.vars()) {
    auto add = [&](const std::vector<std::string>& sc, const std::string& nm, int64_t l, int64_t r, uint32_t w) {
      const uint32_t n = N.node_of(sc), lf = N.intern(nm); if (!N.add_key(n, lf, uint32_t(N.node.size()))) { err = "duplicate declaration"; return false; }
      N.slot(n, lf, l, r, w); return true; };
    if (!add(v.scope, v.name, v.left, v.right, v.bits)) return false;
    for (auto& a : v.aliases) if (!add(a.scope, a.name, a.left, a.right, v.bits)) return false;  // (an alias's own width is not kept in vars(); the dict uses the signal's)
    N.off.push_back(N.slots());
  }
  return true;
}

}  // namespace wczform
}  // namespace sigread
