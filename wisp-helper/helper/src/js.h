// SPDX-License-Identifier: MIT
// The JS value rules the helper protocol is written in, over the shim's
// value tree: String(v), Number(v), truthiness, Number#toFixed, and small JSON output helpers.
#pragma once
#include <napi.h>
#include "json.h"
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace js {
using Napi::T;

inline bool undef(const Napi::Value &v) { return v.type() == T::Undef; }
inline bool nullish(const Napi::Value &v) { return v.type() == T::Undef || v.type() == T::Null; }
inline bool truthy(const Napi::Value &v) { return v.ToBoolean().Value(); }
inline double num(const Napi::Value &v, double def = NAN) { return v.type() == T::Num ? v.p->n : def; }
inline const std::string &str(const Napi::Value &v) { static const std::string e; return v.type() == T::Str ? v.p->s : e; }
inline Napi::Value get(const Napi::Value &o, const char *k) {
  if (o.type() != T::Obj) return Napi::Value();
  auto it = o.p->idx.find(k);
  return it == o.p->idx.end() ? Napi::Value() : Napi::Value(o.p->obj[it->second].second);
}
inline bool has(const Napi::Value &o, const char *k) { return o.type() == T::Obj && o.p->idx.count(k) > 0; }
inline size_t len(const Napi::Value &a) { return a.type() == T::Arr ? a.p->arr.size() : 0; }
inline Napi::Value at(const Napi::Value &a, size_t i) { return a.type() == T::Arr && i < a.p->arr.size() ? Napi::Value(a.p->arr[i]) : Napi::Value(); }

// JS Number#toString of a double (String(x)), NaN and the infinities included
inline std::string numText(double d) {
  if (d != d) return "NaN";
  if (d == INFINITY) return "Infinity";
  if (d == -INFINITY) return "-Infinity";
  std::string o; wjson::num(o, d); return o;
}
// String(v)
inline std::string String(const Napi::Value &v) {
  switch (v.type()) {
    case T::Undef: return "undefined";
    case T::Null: return "null";
    case T::Bool: return v.p->b ? "true" : "false";
    case T::Num: return numText(v.p->n);
    case T::Str: return v.p->s;
    case T::Arr: {
      std::string o;
      for (size_t i = 0; i < v.p->arr.size(); i++) {
        if (i) o += ',';
        Napi::Value x(v.p->arr[i]);
        if (!nullish(x)) o += String(x);
      }
      return o;
    }
    default: return "[object Object]";
  }
}
// Number(s) for a string (StringToNumber: whitespace trimmed, "" is 0, Infinity, 0x/0o/0b, decimal literals)
inline double strNumber(const std::string &s0) {
  auto ws = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; };
  size_t a = 0, b = s0.size();
  while (a < b && ws(s0[a])) a++;
  while (b > a && ws(s0[b - 1])) b--;
  const std::string s = s0.substr(a, b - a);
  if (s.empty()) return 0;
  if (s == "Infinity" || s == "+Infinity") return INFINITY;
  if (s == "-Infinity") return -INFINITY;
  if (s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X' || s[1] == 'o' || s[1] == 'O' || s[1] == 'b' || s[1] == 'B')) {
    const int base = (s[1] == 'x' || s[1] == 'X') ? 16 : (s[1] == 'o' || s[1] == 'O') ? 8 : 2;
    double v = 0;
    for (size_t i = 2; i < s.size(); i++) {
      const char c = s[i];
      int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 99;
      if (d >= base) return NAN;
      v = v * base + d;
    }
    return v;
  }
  // [+-] (digits [. digits?] | . digits) ([eE] [+-] digits)?
  size_t i = 0;
  if (s[i] == '+' || s[i] == '-') i++;
  size_t d0 = i;
  while (i < s.size() && isdigit((unsigned char)s[i])) i++;
  bool any = i > d0;
  if (i < s.size() && s[i] == '.') { i++; size_t f0 = i; while (i < s.size() && isdigit((unsigned char)s[i])) i++; any = any || i > f0; }
  if (!any) return NAN;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    i++;
    if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
    size_t e0 = i;
    while (i < s.size() && isdigit((unsigned char)s[i])) i++;
    if (i == e0) return NAN;
  }
  if (i != s.size()) return NAN;
  return strtod(s.c_str(), nullptr);
}
// Number(v)
inline double Number(const Napi::Value &v) {
  switch (v.type()) {
    case T::Num: return v.p->n;
    case T::Bool: return v.p->b ? 1 : 0;
    case T::Null: return 0;
    case T::Str: return strNumber(v.p->s);
    case T::Arr: return strNumber(String(v));  // (ToPrimitive of an array is its String)
    default: return NAN;
  }
}
// +x.toFixed(k): the exact decimal of the double, a tie going to the larger magnitude (k <= 20, |x| < 1e21)
inline double toFixed(double x, int k) {
  if (!std::isfinite(x) || std::fabs(x) >= 1e21) return x;
  const bool neg = x < 0;
  static thread_local char buf[1200];
  snprintf(buf, sizeof buf, "%.1100f", std::fabs(x));
  std::string s(buf);
  const size_t dot = s.find('.');
  std::string keep = s.substr(0, dot) + s.substr(dot + 1, k);
  if (s[dot + 1 + k] >= '5') {
    size_t i = keep.size();
    while (i > 0) { i--; if (keep[i] == '9') keep[i] = '0'; else { keep[i]++; break; } if (i == 0) { keep.insert(keep.begin(), '1'); break; } }
  }
  std::string out = keep.substr(0, keep.size() - k);
  if (k) out += "." + keep.substr(keep.size() - k);
  const double r = strtod(out.c_str(), nullptr);
  return neg ? -r : r;
}

// ---- output ----
inline void jnum(std::string &o, double d) { wjson::num(o, d); }
inline void jstr(std::string &o, const std::string &s) { wjson::str(o, s); }
inline void jval(std::string &o, const Napi::Value &v) { wjson::write(o, v.p); }
inline std::string q(const std::string &s) { std::string o; wjson::str(o, s); return o; }
}  // namespace js
