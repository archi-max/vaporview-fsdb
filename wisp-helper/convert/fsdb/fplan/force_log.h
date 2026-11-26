// SPDX-License-Identifier: MIT
// force_log.h: the simulator's force log as a port-link refusal input.
// Format (the simulator's force log, "force list"): a title line, a header section that lists every force / deposit / release
// target once per statement (language forces: ID target module file line; external forces: ID target), then an event list
// section (time lines, then "ID KIND [value]" lines). The header alone names every target (a whole-array force can be
// header-only), so targets come from the header; events are checked against it.
// Fail closed: any line this parser does not recognise makes the log unusable as a whole (the caller refuses every link
// in the file, with the line number). A log is never partly used.
#pragma once
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>
#include <zlib.h>

namespace forcelog {

// The planner's claim block when the force log lists forced or deposited nets (fplan.cpp R_CLAIM_FORCED). The merge
// (run_plan_threaded.cpp) lifts exactly this block for a side file bound to the same log, so both use this one text.
inline constexpr const char* CLAIM_FORCED = "port copy: values not linked yet; computed values refused: the force log lists forced or deposited nets in this file";

struct Target { std::string id, target, section, module, file; int line = 0; };
struct Event { std::string id, kind; uint64_t time = 0; int line = 0; };
struct Log {
  std::vector<Target> targets;      // header rows, file order (a statement may be listed twice: force + release)
  std::vector<Event> events;
  std::map<std::string, uint64_t> kinds;  // event kind -> count (report only)
  std::string err; int err_line = 0;      // non-empty err = unusable log
};

inline std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r"), b = s.find_last_not_of(" \t\r");
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}

// Reads one hierarchical target starting at s[i]. Components are separated by '.'; a component that starts with '\' is an
// escaped identifier and runs to the next whitespace, which is part of the name (kept verbatim: "\a.b "). After an escaped
// component the target goes on only if the next character after that one space is '.' or '['. Selects "[...]" stay attached.
inline bool read_target(const std::string& s, size_t& i, std::string& out) {
  out.clear(); const size_t n = s.size();
  while (i < n) {
    if (s[i] == '\\') {
      size_t j = i + 1; while (j < n && !isspace((unsigned char)s[j])) j++;
      if (j == i + 1) return false;
      out.append(s, i, j - i); out += ' '; i = (j < n) ? j + 1 : j;
      if (i < n && (s[i] == '.' || s[i] == '[')) { continue; }
      return true;
    }
    size_t j = i; int depth = 0;
    while (j < n) {
      char c = s[j];
      if (c == '[') depth++; else if (c == ']') { if (depth == 0) return false; depth--; }
      else if (depth == 0 && isspace((unsigned char)c)) break;
      else if (depth == 0 && c == '\\') break;
      j++;
    }
    if (depth) return false;
    out.append(s, i, j - i); i = j;
    if (i < n && s[i] == '\\') { if (out.empty() || out.back() != '.') return false; continue; }  // "a.\b " escaped next component
    return !out.empty();
  }
  return !out.empty();
}

inline std::vector<std::string> words(const std::string& s, size_t from) {
  std::vector<std::string> w; size_t i = from, n = s.size();
  while (i < n) { while (i < n && isspace((unsigned char)s[i])) i++; size_t j = i; while (j < n && !isspace((unsigned char)s[j])) j++; if (j > i) w.push_back(s.substr(i, j - i)); i = j; }
  return w;
}

inline bool gunzip(const std::string& in, std::string& out) {
  z_stream z{}; if (inflateInit2(&z, 16 + MAX_WBITS) != Z_OK) return false;
  z.next_in = (Bytef*)in.data(); z.avail_in = (uInt)in.size(); char buf[65536]; int rc;
  do { z.next_out = (Bytef*)buf; z.avail_out = sizeof buf; rc = inflate(&z, Z_NO_FLUSH);
       if (rc != Z_OK && rc != Z_STREAM_END) { inflateEnd(&z); return false; }
       out.append(buf, sizeof buf - z.avail_out); if (out.size() > (size_t(1) << 31)) { inflateEnd(&z); return false; } } while (rc != Z_STREAM_END);
  inflateEnd(&z); return true;
}

inline Log parse(std::string text) {
  Log L; auto bad = [&](int ln, const std::string& why) { if (L.err.empty()) { L.err = why; L.err_line = ln; } return L; };
  if (text.size() >= 2 && (unsigned char)text[0] == 0x1f && (unsigned char)text[1] == 0x8b) {
    std::string o; if (!gunzip(text, o)) return bad(0, "force log: gzip stream damaged"); text.swap(o); }
  enum { TITLE, HEADER, LANG_COLS, LANG, EXT_COLS, EXT, EVENTS } st = TITLE;
  bool seen_header = false, seen_events = false; uint64_t now = 0; bool have_time = false;
  std::set<std::string> ids; size_t p = 0; int ln = 0;
  while (p <= text.size()) {
    size_t e = text.find('\n', p); if (e == std::string::npos) e = text.size();
    std::string raw = text.substr(p, e - p); p = e + 1; ln++;
    if (!raw.empty() && raw.back() == '\r') raw.pop_back();
    std::string t = trim(raw);
    if (t.empty()) { if (e == text.size()) break; continue; }
    if (st == TITLE) { if (t.size() < 11 || t.compare(t.size() - 11, 11, " Force List") != 0) return bad(ln, "force log: first line is not the force list title"); st = HEADER; continue; }
    if (t == "Header Section") { if (seen_header) return bad(ln, "force log: second header section"); seen_header = true; st = HEADER; continue; }
    if (t == "Language Forces") { if (!seen_header || seen_events) return bad(ln, "force log: language forces outside the header"); st = LANG_COLS; continue; }
    if (t == "External Forces") { if (!seen_header || seen_events) return bad(ln, "force log: external forces outside the header"); st = EXT_COLS; continue; }
    if (t == "Event List Section") { if (!seen_header || seen_events) return bad(ln, "force log: event list before the header or twice"); seen_events = true; st = EVENTS; continue; }
    auto w = words(t, 0);
    switch (st) {
      case HEADER: return bad(ln, "force log: unexpected line in the header section");
      case LANG_COLS: if (w.size() == 5 && w[0] == "ID" && w[1] == "Target" && w[2] == "Module" && w[3] == "File" && w[4] == "Line") { st = LANG; continue; }
                      return bad(ln, "force log: language forces column line not recognised");
      case EXT_COLS: if (w.size() == 2 && w[0] == "ID" && w[1] == "Target") { st = EXT; continue; }
                     return bad(ln, "force log: external forces column line not recognised");
      case LANG: case EXT: {
        size_t i = 0; while (i < t.size() && !isspace((unsigned char)t[i])) i++;
        Target T; T.id = t.substr(0, i); T.line = ln; T.section = st == LANG ? "language" : "external";
        while (i < t.size() && isspace((unsigned char)t[i])) i++;
        if (!read_target(t, i, T.target)) return bad(ln, "force log: target name not parsed");
        auto rest = words(t, i);
        // A struct-member target carries the simulator's type note after the line number, "<module> <file> <line> ** <note> **"
        // (e.g. "** struct **"): exactly that 6-word form is accepted in the language section; every other shape refuses as before.
        if (st == LANG && rest.size() == 6 && rest[3] == "**" && rest[5] == "**" && rest[4] != "**") rest.resize(3);
        if (st == LANG) { if (rest.size() != 3) return bad(ln, "force log: language force row needs target module file line");
          for (char c : rest[2]) if (!isdigit((unsigned char)c)) return bad(ln, "force log: language force line number not numeric");
          T.module = rest[0]; T.file = rest[1] + ":" + rest[2]; }
        else if (rest.size() == 3 && rest[0] == "**" && rest[2] == "**") T.module = rest[1];  // type note, e.g. "** struct **" (whole struct target)
        else if (!rest.empty()) return bad(ln, "force log: external force row has fields after the target");
        ids.insert(T.id); L.targets.push_back(T); continue; }
      case EVENTS: {
        if (w.size() >= 3 && w[0].find_first_not_of('-') == std::string::npos && w[1] == "Time:" && w.back().find_first_not_of('-') == std::string::npos && w.size() == 4) {
          const std::string& v = w[2]; if (v.empty() || v.find_first_not_of("0123456789") != std::string::npos) return bad(ln, "force log: time not numeric");
          uint64_t tv = strtoull(v.c_str(), nullptr, 10); if (have_time && tv < now) return bad(ln, "force log: time goes backwards");
          now = tv; have_time = true; continue; }
        if (w.size() < 2 || w[1].size() != 2 || !isupper((unsigned char)w[1][0]) || !isupper((unsigned char)w[1][1])) return bad(ln, "force log: event line not recognised");
        if (!have_time) return bad(ln, "force log: event before the first time line");
        if (!ids.count(w[0])) return bad(ln, "force log: event ID " + w[0] + " has no header target");
        Event E; E.id = w[0]; E.kind = w[1]; E.time = now; E.line = ln; L.kinds[E.kind]++; L.events.push_back(E); continue; }
      default: return bad(ln, "force log: parser state");
    }
  }
  if (st == TITLE) return bad(ln, "force log: empty file");
  if (!seen_header) return bad(ln, "force log: no header section");
  return L;
}

// Writer spelling of one escaped component: the writer drops the escape of a name that is a legal simple identifier
// ("\abc " is stored as "abc"); any other escaped name keeps "\name " verbatim.
inline std::string canon_component(const std::string& c) {
  if (c.size() < 3 || c[0] != '\\' || c.back() != ' ') return c;
  std::string b = c.substr(1, c.size() - 2);
  bool simple = !b.empty() && (isalpha((unsigned char)b[0]) || b[0] == '_');
  for (char ch : b) if (!(isalnum((unsigned char)ch) || ch == '_' || ch == '$')) simple = false;
  return simple ? b : c;
}

// Splits a hierarchical name into components on '.', not inside an escaped component ("\a.b ") or a select.
inline std::vector<std::string> split_path(const std::string& s) {
  std::vector<std::string> out; std::string cur; size_t i = 0, n = s.size(); int depth = 0;
  while (i < n) {
    char c = s[i];
    if (c == '\\' && cur.empty()) { size_t j = i; while (j < n && s[j] != ' ') j++; cur.append(s, i, (j < n ? j + 1 : j) - i); i = (j < n ? j + 1 : j); continue; }
    if (c == '[') depth++; else if (c == ']') depth--;
    if (c == '.' && depth == 0) { out.push_back(cur); cur.clear(); i++; continue; }
    cur += c; i++;
  }
  out.push_back(cur); return out;
}

inline std::string join_path(const std::vector<std::string>& v, size_t n) {
  std::string o; for (size_t i = 0; i < n && i < v.size(); i++) { if (i) o += '.'; o += v[i]; } return o;
}

inline std::string canon(const std::string& s) {
  auto v = split_path(s); for (auto& c : v) { std::string sel; size_t k = c[0] == '\\' ? c.find(' ') + 1 : c.find('[');
    if (k != std::string::npos && k < c.size()) { sel = c.substr(k); c = c.substr(0, k); }
    c = canon_component(c) + sel; }
  return join_path(v, v.size());
}

// Strips every trailing select group "[...]" of the last component: the base vector / array name.
inline std::string strip_selects(const std::string& s) {
  std::string o = s;
  while (!o.empty() && o.back() == ']') { int d = 0; size_t k = o.size(); while (k-- > 0) { if (o[k] == ']') d++; else if (o[k] == '[') { if (--d == 0) break; } }
    if (k == std::string::npos || k == 0) break; o.erase(k); }
  return o;
}


// One path component split into its base name and its select groups ("g_rep[i][2]" -> "g_rep", {"[i]", "[2]"}).
inline void split_selects(const std::string& c, std::string& base, std::vector<std::string>& sel) {
  sel.clear(); size_t k = (!c.empty() && c[0] == '\\') ? c.find(' ') : std::string::npos;
  size_t start = (k == std::string::npos) ? c.find('[') : (c.find('[', k) == k + 1 ? k + 1 : std::string::npos);
  if (start == std::string::npos) { base = c; return; }
  base = c.substr(0, start); size_t i = start;
  while (i < c.size() && c[i] == '[') { int d = 0; size_t j = i; for (; j < c.size(); j++) { if (c[j] == '[') d++; else if (c[j] == ']' && --d == 0) break; }
    sel.push_back(c.substr(i, j - i + 1)); i = j + 1; }
  if (i < c.size()) { base = c; sel.clear(); }
}
// A constant select: "[N]" or "[N:M]" with decimal integers (optional sign / spaces).
inline bool const_select(const std::string& g) {
  if (g.size() < 3) return false; bool digit = false, colon = false;
  for (size_t i = 1; i + 1 < g.size(); i++) { char c = g[i];
    if (isdigit((unsigned char)c)) digit = true; else if (c == ':' && !colon && digit) { colon = true; digit = false; }
    else if (c != ' ' && c != '-' && c != '+') return false; }
  return digit;
}
inline bool has_variable_select(const std::string& t) {
  for (auto& c : split_path(t)) { std::string b; std::vector<std::string> sel; split_selects(c, b, sel); for (auto& g : sel) if (!const_select(g)) return true; }
  return false;
}
// Widened match: a declaration name k matches target t when every component has the same base name, every constant
// select is equal, a variable select matches any select, and the LAST component matches on its base name only (the
// whole vector / array). Used for the base_vector rule.
inline bool widened_match(const std::vector<std::string>& tc, const std::string& k) {
  auto kc = split_path(k); if (kc.size() != tc.size()) return false;
  for (size_t i = 0; i < tc.size(); i++) {
    std::string tb, kb; std::vector<std::string> ts, ks; split_selects(tc[i], tb, ts); split_selects(kc[i], kb, ks);
    if (tb != kb) return false;
    if (i + 1 == tc.size()) return true;
    if (ts.size() != ks.size()) return false;
    for (size_t j = 0; j < ts.size(); j++) if (const_select(ts[j]) && ts[j] != ks[j]) return false;
  }
  return true;
}

}  // namespace forcelog
