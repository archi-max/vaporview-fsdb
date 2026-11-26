// SPDX-License-Identifier: MIT
// wcz_text.h: a value as text (wcz-dump, tests). Bit vectors use the SPEC §II.5 (WCB2) bit order: position p,
// counted from the declared left (most significant) bit, is bit p%8 of byte p/8; so position 0 = MSB and the
// text is positions 0, 1, … left to right, e.g. 4'b0001 is stored as value byte 0x08.
#pragma once
#include "wcz_block.h"
#include <cstdio>
#include <string>

namespace wcz {
static inline std::string valueText(const SigSpec &s, const uint8_t *v, size_t l) {
  if (s.vtype == VT_REAL) { double d; memcpy(&d, v, 8); char b[40]; snprintf(b, sizeof b, "%.17g", d); return b; }
  if (s.vtype == VT_STRING) {
    std::string o = "\"";
    for (size_t i = 0; i < l; i++) { unsigned char c = v[i];
      if (c == '"' || c == '\\') { o += '\\'; o += (char)c; } else if (c < 0x20 || c == 0x7f) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; } else o += (char)c; }
    return o + "\"";
  }
  uint32_t pl = (s.bits + 7) / 8; std::string o;
  for (uint32_t p = 0; p < s.bits; p++) {
    int a = (v[p >> 3] >> (p & 7)) & 1, b = s.fourState ? (v[pl + (p >> 3)] >> (p & 7)) & 1 : 0;
    o += b ? (a ? 'z' : 'x') : (a ? '1' : '0');
  }
  return o;
}
// The inverse for bit vectors: text of '0' '1' 'x' 'z', MSB (position 0) first, into vlen bytes.
static inline std::vector<uint8_t> bitsFromText(const SigSpec &s, const std::string &t) {
  uint32_t pl = (s.bits + 7) / 8; std::vector<uint8_t> v(s.vlen, 0);
  for (uint32_t p = 0; p < s.bits && p < t.size(); p++) {
    char c = t[p]; if (c == '1' || c == 'z') v[p >> 3] |= (uint8_t)(1u << (p & 7)); if (s.fourState && (c == 'x' || c == 'z')) v[pl + (p >> 3)] |= (uint8_t)(1u << (p & 7));
  }
  return v;
}
}  // namespace wcz
