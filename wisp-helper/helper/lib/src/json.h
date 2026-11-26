// SPDX-License-Identifier: MIT
// JSON for the native helper, on the shim's value tree (shim/napi.h): parse a request line, and write a
// reply exactly as JSON.stringify would (insertion order; numbers as JS Number#toString; strings escaped as
// JSON.stringify does, invalid UTF-8 as U+FFFD as a UTF-8 to JS string decode gives it; undefined/function members
// left out, undefined/function array items as null; byte buffers as {"type":"Buffer","data":[...]} and typed
// arrays as {"0":..,"1":..}).
#pragma once
#include <napi.h>
#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace wjson {
using Napi::Node;
using Napi::NodeP;
using Napi::T;

// JS Number#toString for a finite double: shortest round-trip digits, fixed for 1e-7 <= |x| < 1e21, else d.ddde+N.
inline void num(std::string &o, double d) {
  if (d != d || d == INFINITY || d == -INFINITY) { o += "null"; return; }
  if (d == 0) { o += '0'; return; }  // (-0 too: JSON.stringify(-0) is "0")
  char buf[64];
  auto r = std::to_chars(buf, buf + sizeof buf, d, std::chars_format::scientific);
  std::string s(buf, r.ptr);
  bool neg = false;
  if (s[0] == '-') { neg = true; s.erase(0, 1); }
  const size_t e = s.find('e');
  std::string digits = s.substr(0, e);
  const int ex = std::atoi(s.c_str() + e + 1);
  digits.erase(std::remove(digits.begin(), digits.end(), '.'), digits.end());
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  const int k = (int)digits.size(), n = ex + 1;  // value = 0.digits * 10^n
  if (neg) o += '-';
  if (k <= n && n <= 21) { o += digits; o.append(n - k, '0'); }
  else if (0 < n && n <= 21) { o += digits.substr(0, n); o += '.'; o += digits.substr(n); }
  else if (-6 < n && n <= 0) { o += "0."; o.append(-n, '0'); o += digits; }
  else {
    o += digits[0];
    if (k > 1) { o += '.'; o += digits.substr(1); }
    o += 'e'; o += (n - 1 >= 0 ? '+' : '-'); o += std::to_string(std::abs(n - 1));
  }
}

inline void hex4(std::string &o, unsigned c) { static const char *h = "0123456789abcdef"; o += "\\u"; o += h[(c >> 12) & 15]; o += h[(c >> 8) & 15]; o += h[(c >> 4) & 15]; o += h[c & 15]; }

// A UTF-8 string as JSON.stringify writes the JS string decoded from it.
inline void str(std::string &o, const std::string &s) {
  o += '"';
  const unsigned char *p = (const unsigned char *)s.data();
  const size_t n = s.size();
  for (size_t i = 0; i < n;) {
    const unsigned c = p[i];
    if (c < 0x80) {
      switch (c) {
        case '"': o += "\\\""; break;
        case '\\': o += "\\\\"; break;
        case '\b': o += "\\b"; break;
        case '\f': o += "\\f"; break;
        case '\n': o += "\\n"; break;
        case '\r': o += "\\r"; break;
        case '\t': o += "\\t"; break;
        default: if (c < 0x20) hex4(o, c); else o += (char)c;
      }
      i++;
      continue;
    }
    // a well-formed multi-byte sequence passes through; anything else is one U+FFFD per maximal bad prefix
    int len = 0; unsigned cp = 0, lo = 0x80, hi = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) { len = 2; cp = c & 0x1F; }
    else if (c >= 0xE0 && c <= 0xEF) { len = 3; cp = c & 0x0F; if (c == 0xE0) lo = 0xA0; if (c == 0xED) hi = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { len = 4; cp = c & 0x07; if (c == 0xF0) lo = 0x90; if (c == 0xF4) hi = 0x8F; }
    if (!len) { o += "\xEF\xBF\xBD"; i++; continue; }
    size_t j = 1; bool ok = true;
    for (; j < (size_t)len; j++) {
      if (i + j >= n) { ok = false; break; }
      const unsigned d = p[i + j];
      if (d < (j == 1 ? lo : 0x80) || d > (j == 1 ? hi : 0xBF)) { ok = false; break; }
      cp = (cp << 6) | (d & 0x3F);
    }
    if (!ok) { o += "\xEF\xBF\xBD"; i += j; continue; }
    o.append((const char *)p + i, len);
    i += len;
  }
  o += '"';
}

inline bool skipped(const NodeP &v) { return !v || v->t == T::Undef || v->t == T::Fn; }

inline void write(std::string &o, const NodeP &v) {
  if (!v) { o += "null"; return; }
  switch (v->t) {
    case T::Undef: case T::Fn: case T::Null: o += "null"; break;
    case T::Bool: o += v->b ? "true" : "false"; break;
    case T::Num: num(o, v->n); break;
    case T::Str: str(o, v->s); break;
    case T::Arr: {
      o += '[';
      for (size_t i = 0; i < v->arr.size(); i++) { if (i) o += ','; write(o, v->arr[i]); }
      o += ']';
      break;
    }
    case T::Obj: {
      o += '{'; bool first = true;
      for (auto &kv : v->obj) {
        if (skipped(kv.second)) continue;
        if (!first) o += ','; first = false;
        str(o, kv.first); o += ':'; write(o, kv.second);
      }
      o += '}';
      break;
    }
    case T::Bytes: {
      o += "{\"type\":\"Buffer\",\"data\":[";
      for (size_t i = 0; i < v->s.size(); i++) { if (i) o += ','; o += std::to_string((unsigned char)v->s[i]); }
      o += "]}";
      break;
    }
    case T::Typed: {
      o += '{';
      const size_t es = v->ta == Napi::TA::U8 ? 1 : v->ta == Napi::TA::F64 ? 8 : 4, ne = v->s.size() / es;
      for (size_t i = 0; i < ne; i++) {
        if (i) o += ',';
        o += '"'; o += std::to_string(i); o += "\":";
        const char *q = v->s.data() + i * es;
        double d = 0;
        if (v->ta == Napi::TA::U8) d = (unsigned char)*q;
        else if (v->ta == Napi::TA::I32) { int32_t x; memcpy(&x, q, 4); d = x; }
        else if (v->ta == Napi::TA::U32) { uint32_t x; memcpy(&x, q, 4); d = x; }
        else { memcpy(&d, q, 8); }
        num(o, d);
      }
      o += '}';
      break;
    }
  }
}
inline std::string stringify(const Napi::Value &v) { std::string o; write(o, v.p); return o; }

// ---- parse (requests are small; strict JSON, \u escapes to UTF-8, a lone surrogate as U+FFFD bytes) ----
struct Parser {
  const char *p, *e; std::string err;
  void ws() { while (p < e && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++; }
  bool lit(const char *w) { size_t n = strlen(w); if ((size_t)(e - p) >= n && !memcmp(p, w, n)) { p += n; return true; } return false; }
  static void utf8(std::string &o, unsigned cp) {
    if (cp < 0x80) o += (char)cp;
    else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
    else { o += (char)(0xF0 | (cp >> 18)); o += (char)(0x80 | ((cp >> 12) & 0x3F)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
  }
  bool hex(unsigned &v) { if (e - p < 4) return false; v = 0; for (int i = 0; i < 4; i++) { char c = *p++; v <<= 4; if (c >= '0' && c <= '9') v |= c - '0'; else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10; else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10; else return false; } return true; }
  bool string(std::string &o) {
    if (p >= e || *p != '"') return false; p++;
    while (p < e && *p != '"') {
      if ((unsigned char)*p < 0x20) return false;
      if (*p != '\\') { o += *p++; continue; }
      p++; if (p >= e) return false;
      char c = *p++;
      switch (c) {
        case '"': o += '"'; break; case '\\': o += '\\'; break; case '/': o += '/'; break;
        case 'b': o += '\b'; break; case 'f': o += '\f'; break; case 'n': o += '\n'; break; case 'r': o += '\r'; break; case 't': o += '\t'; break;
        case 'u': {
          unsigned v; if (!hex(v)) return false;
          if (v >= 0xD800 && v <= 0xDBFF && e - p >= 6 && p[0] == '\\' && p[1] == 'u') {
            const char *s = p; p += 2; unsigned w;
            if (hex(w) && w >= 0xDC00 && w <= 0xDFFF) { utf8(o, 0x10000 + ((v - 0xD800) << 10) + (w - 0xDC00)); break; }
            p = s;
          }
          utf8(o, (v >= 0xD800 && v <= 0xDFFF) ? 0xFFFD : v);
          break;
        }
        default: return false;
      }
    }
    if (p >= e) return false; p++; return true;
  }
  NodeP value(int depth = 0) {
    if (depth > 64) { err = "too deep"; return nullptr; }
    ws(); if (p >= e) { err = "unexpected end"; return nullptr; }
    auto n = std::make_shared<Node>();
    char c = *p;
    if (c == '{') {
      p++; n->t = T::Obj; ws();
      if (p < e && *p == '}') { p++; return n; }
      for (;;) {
        ws(); std::string k; if (!string(k)) { err = "bad key"; return nullptr; }
        ws(); if (p >= e || *p != ':') { err = "expected :"; return nullptr; } p++;
        NodeP v = value(depth + 1); if (!v) return nullptr;
        auto it = n->idx.find(k);
        if (it != n->idx.end()) n->obj[it->second].second = v; else { n->idx.emplace(k, n->obj.size()); n->obj.emplace_back(k, v); }
        ws(); if (p < e && *p == ',') { p++; continue; } if (p < e && *p == '}') { p++; return n; }
        err = "expected , or }"; return nullptr;
      }
    }
    if (c == '[') {
      p++; n->t = T::Arr; ws();
      if (p < e && *p == ']') { p++; return n; }
      for (;;) {
        NodeP v = value(depth + 1); if (!v) return nullptr; n->arr.push_back(v);
        ws(); if (p < e && *p == ',') { p++; continue; } if (p < e && *p == ']') { p++; return n; }
        err = "expected , or ]"; return nullptr;
      }
    }
    if (c == '"') { n->t = T::Str; if (!string(n->s)) { err = "bad string"; return nullptr; } return n; }
    if (lit("true")) { n->t = T::Bool; n->b = true; return n; }
    if (lit("false")) { n->t = T::Bool; n->b = false; return n; }
    if (lit("null")) { n->t = T::Null; return n; }
    const char *s = p;
    if (p < e && *p == '-') p++;
    if (p >= e || !(*p >= '0' && *p <= '9')) { err = "bad value"; return nullptr; }
    if (*p == '0') p++; else while (p < e && *p >= '0' && *p <= '9') p++;
    if (p < e && *p == '.') { p++; if (p >= e || !(*p >= '0' && *p <= '9')) { err = "bad number"; return nullptr; } while (p < e && *p >= '0' && *p <= '9') p++; }
    if (p < e && (*p == 'e' || *p == 'E')) { p++; if (p < e && (*p == '+' || *p == '-')) p++; if (p >= e || !(*p >= '0' && *p <= '9')) { err = "bad number"; return nullptr; } while (p < e && *p >= '0' && *p <= '9') p++; }
    n->t = T::Num; n->n = strtod(std::string(s, p).c_str(), nullptr);
    return n;
  }
};
// nullptr (and err) when the line is not one JSON value
inline NodeP parse(const std::string &line, std::string &err) {
  Parser ps{line.data(), line.data() + line.size(), {}};
  NodeP v = ps.value();
  if (v) { ps.ws(); if (ps.p != ps.e) { err = "trailing characters"; return nullptr; } }
  else err = ps.err;
  return v;
}
}  // namespace wjson
