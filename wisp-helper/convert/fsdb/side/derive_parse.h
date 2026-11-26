// SPDX-License-Identifier: MIT
// derive_parse.h (file-only route): the op-table expression parser and the code-block program parser.
// Same results on the corpus as the reference parser it was ported from (not shipped).
// Op-table grammar (prefix bytes): c0..cf arg | 00 / 01 one-bit literal | b2 <pad to 4> u32 pool constant |
//   81 82 94 95 b9 one operand | 83 84 85 86 two operands | bf 85 X I bit select | bf 86 X A B part select |
//   bf 82 <pad> u32 r, u32 n, n nodes concat | bf 9b SEL V part write.
#pragma once
#include "derive_block.h"
#include <functional>
#include <memory>

namespace dblk {

struct Node {
  enum Kind { ARG, LIT, CONST, UN, BIN, BSEL, PSEL, PWRITE, CONCAT } kind;
  uint32_t v = 0;                 // ARG index | LIT bit | CONST pool index | UN/BIN op byte | CONCAT repeat
  std::vector<std::unique_ptr<Node>> kids;
};
using NodeP = std::unique_ptr<Node>;

struct ParseError : std::runtime_error { using std::runtime_error::runtime_error; };

inline NodeP parse_code(const Bytes &c) {
  size_t pos = 0;
  auto at = [&](size_t i) -> uint8_t { if (i >= c.size()) throw ParseError("code ends"); return c[i]; };
  auto pad4 = [&]() { while (pos % 4) { if (at(pos) != 0) throw ParseError("nonzero pad"); pos++; } };
  auto rd32 = [&]() { if (pos + 4 > c.size()) throw ParseError("code ends"); uint32_t v = u32(c.data() + pos); pos += 4; return v; };
  std::function<NodeP()> node = [&]() -> NodeP {
    uint8_t b = at(pos++); auto n = std::make_unique<Node>();
    if (b >= 0xc0 && b <= 0xcf) { n->kind = Node::ARG; n->v = b - 0xc0; return n; }
    if (b == 0 || b == 1) { n->kind = Node::LIT; n->v = b; return n; }
    if (b == 0xb2) { pad4(); n->kind = Node::CONST; n->v = rd32(); return n; }
    if (b == 0x81 || b == 0x82 || b == 0x94 || b == 0x95 || b == 0xb9) { n->kind = Node::UN; n->v = b; n->kids.push_back(node()); return n; }
    if (b >= 0x83 && b <= 0x86) { n->kind = Node::BIN; n->v = b; n->kids.push_back(node()); n->kids.push_back(node()); return n; }
    if (b == 0xbf) {
      uint8_t m = at(pos++);
      if (m == 0x85) { n->kind = Node::BSEL; n->kids.push_back(node()); n->kids.push_back(node()); return n; }
      if (m == 0x86) { n->kind = Node::PSEL; for (int k = 0; k < 3; k++) n->kids.push_back(node()); return n; }
      if (m == 0x9b) { n->kind = Node::PWRITE; n->kids.push_back(node()); n->kids.push_back(node()); return n; }
      if (m == 0x82) { pad4(); n->kind = Node::CONCAT; n->v = rd32(); uint32_t k = rd32(); for (uint32_t q = 0; q < k; q++) n->kids.push_back(node()); return n; }
      throw ParseError("bf code");
    }
    throw ParseError("code byte");
  };
  NodeP t = node(); if (pos != c.size()) throw ParseError("leftover bytes"); return t;
}

inline std::string fmt(const Node &t) {
  char b[32];
  switch (t.kind) {
    case Node::ARG: snprintf(b, sizeof b, "a%u", t.v); return b;
    case Node::LIT: snprintf(b, sizeof b, "1'b%u", t.v); return b;
    case Node::CONST: snprintf(b, sizeof b, "#%u", t.v); return b;
    default: break;
  }
  std::string s;
  switch (t.kind) {
    case Node::UN: case Node::BIN: snprintf(b, sizeof b, "%c%02x", t.kind == Node::UN ? 'u' : 'b', t.v); s = b; break;
    case Node::BSEL: s = "bsel"; break; case Node::PSEL: s = "psel"; break; case Node::PWRITE: s = "pwrite"; break;
    case Node::CONCAT: s = "concat"; break; default: break;
  }
  s += '('; bool first = true;
  if (t.kind == Node::CONCAT) { s += std::to_string(t.v); first = false; }
  for (auto &k : t.kids) { if (!first) s += ','; s += fmt(*k); first = false; }
  return s + ')';
}

// code-block entry text: optional "Out[m:+-o] = " prefix, then "bcid <id> <n> <words...> RET"
struct Word { std::string op; std::vector<long long> a; };
struct Prog { bool hasOut = false; int64_t msb = 0, lsb = 0; std::vector<Word> words; };

inline Prog parse_block(const Bytes &body) {
  std::string txt(body.begin(), body.end());
  while (!txt.empty() && txt.back() == '\n') txt.pop_back();
  Prog P; static const std::regex OUTRE("^Out\\[(\\d+)(?::\\+-(\\d+))?\\] = ");
  std::smatch m;
  if (std::regex_search(txt, m, OUTRE)) {
    P.hasOut = true; P.msb = std::stoll(m[1]); P.lsb = P.msb - (m[2].matched ? std::stoll(m[2]) : 0); txt = txt.substr(m[0].length());
  }
  // split(' ', 3): three single-space separated fields, then the rest
  size_t p = 0; for (int k = 0; k < 3; k++) { size_t q = txt.find(' ', p); if (q == std::string::npos) return P; p = q + 1; }
  std::string rest = txt.substr(p); size_t r = rest.rfind("RET"); if (r != std::string::npos) rest = rest.substr(0, r);
  size_t i = 0;
  while (i < rest.size()) {
    while (i < rest.size() && isspace((unsigned char)rest[i])) i++;
    if (i >= rest.size()) break;
    size_t j = i; while (j < rest.size() && !isspace((unsigned char)rest[j])) j++;
    std::string tok = rest.substr(i, j - i); i = j;
    Word w; size_t c = tok.find(','); w.op = tok.substr(0, c);
    while (c != std::string::npos) {
      size_t d = tok.find(',', c + 1); std::string f = tok.substr(c + 1, d == std::string::npos ? std::string::npos : d - c - 1);
      size_t used = 0; long long v;
      try { v = std::stoll(f, &used); } catch (...) { throw ParseError("word argument not an integer"); }
      if (used != f.size()) throw ParseError("word argument not an integer");
      w.a.push_back(v); c = d;
    }
    P.words.push_back(std::move(w));
  }
  return P;
}

}  // namespace dblk
