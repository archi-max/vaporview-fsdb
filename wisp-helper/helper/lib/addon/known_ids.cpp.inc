// SPDX-License-Identifier: MIT
// knownSignals(n) -> Uint8Array(n + 1): 1 for every signal id (signal + 1) a var lists in a scope reachable from the
// top scopes through scopes other than the reserved ones the hierarchy leaves out ($object_root, $trans_root,
// $hidden_class, $unreferenced_value_ids). It is the same set the helper got by walking
// readScopes / getScopeChildren / readVarsCols: the same scopes (each once), the first 256 pages of 1024 children per
// scope, and a scope's own vars plus its array scopes' vars, 16 levels deep. One pass over the source's own tables, in
// one call. Before, the walk made one call per scope and per children page through the library interface, on the first
// value request after an open.
namespace wczsrc {
static Napi::Value knownSignalsImpl(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const size_t n = (wargs::count(env, info, 1) && wargs::num(env, info[0])) ? (size_t)std::max(0.0, info[0].As<Napi::Number>().DoubleValue()) : 0;
  Napi::Uint8Array out = Napi::Uint8Array::New(env, n + 1);
  uint8_t *known = out.Data();
  if (!g_f.open) return out;
  const wcz::Dict &d = dictOf();
  auto dollar = [&](uint32_t s) {  // the reserved scopes the hierarchy leaves out (the helper's dollar(), src/main.cpp)
    const std::string &x = d.strs[d.scopes[s].name];
    return x == "$object_root" || x == "$trans_root" || x == "$hidden_class" || x == "$unreferenced_value_ids"; };
  std::vector<uint8_t> seen(d.scopes.size(), 0);
  std::vector<uint32_t> todo;
  auto add = [&](uint32_t s) { if (s < seen.size() && !dollar(s) && !seen[s]) { seen[s] = 1; todo.push_back(s); } };
  for (uint32_t s : g_f.top) add(s);
  std::function<void(uint32_t, int)> mark = [&](uint32_t s, int depth) {  // (readVarsCols' walk)
    for (uint32_t v : g_f.vars[s]) { const uint64_t id = (uint64_t)d.vars[v].signal + 1; if (id < n + 1) known[id] = 1; }
    if (depth >= 16) return;
    for (uint32_t a : g_f.arrays[s]) mark(a, depth + 1);
  };
  static const size_t kMaxKids = (size_t)256 * kScopesPerPage;  // (the walk's page limit)
  for (size_t k = 0; k < todo.size(); k++) {
    const uint32_t s = todo[k];
    if (s < g_f.vars.size()) mark(s, 0);
    if (s >= g_f.kids.size()) continue;
    const std::vector<uint32_t> &c = g_f.kids[s];
    for (size_t j = 0; j < c.size() && j < kMaxKids; j++) add(c[j]);
  }
  return out;
}
}  // namespace wczsrc
static Napi::Value knownSignals(const Napi::CallbackInfo &info) { return wczsrc::knownSignalsImpl(info); }
