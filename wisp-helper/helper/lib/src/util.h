// SPDX-License-Identifier: MIT
// Small helpers for the native helper: SHA-1 (the store-cache key), file identity and stat times in
// milliseconds (mtimeMs = sec * 1e3 + nsec / 1e6), private directories.
#pragma once
#include <sys/stat.h>
#include <unistd.h>
#include <pwd.h>
#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace wutil {

inline std::string sha1hex(const std::string &msg) {
  uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
  std::string m = msg;
  const uint64_t bits = (uint64_t)msg.size() * 8;
  m += (char)0x80;
  while (m.size() % 64 != 56) m += (char)0;
  for (int i = 7; i >= 0; i--) m += (char)((bits >> (i * 8)) & 0xFF);
  auto rol = [](uint32_t x, int c) { return (x << c) | (x >> (32 - c)); };
  for (size_t off = 0; off < m.size(); off += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++) w[i] = ((uint32_t)(uint8_t)m[off + 4 * i] << 24) | ((uint32_t)(uint8_t)m[off + 4 * i + 1] << 16) | ((uint32_t)(uint8_t)m[off + 4 * i + 2] << 8) | (uint32_t)(uint8_t)m[off + 4 * i + 3];
    for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      uint32_t t = rol(a, 5) + f + e + k + w[i];
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  static const char *hx = "0123456789abcdef";
  std::string o;
  for (uint32_t x : h) for (int i = 7; i >= 0; i--) o += hx[(x >> (i * 4)) & 15];
  return o;
}

struct Stat { bool ok = false; double dev = 0, ino = 0, size = 0, mtimeMs = 0, ctimeMs = 0; bool isFile = false, isDir = false; uint32_t uid = 0; };
inline Stat statOf(const std::string &p, bool follow = true) {
  Stat s; struct stat st;
  if ((follow ? ::stat(p.c_str(), &st) : ::lstat(p.c_str(), &st)) != 0) return s;
  s.ok = true; s.dev = (double)st.st_dev; s.ino = (double)st.st_ino; s.size = (double)st.st_size; s.uid = st.st_uid;
  s.isFile = S_ISREG(st.st_mode); s.isDir = S_ISDIR(st.st_mode);
#if defined(__APPLE__)
  s.mtimeMs = (double)st.st_mtimespec.tv_sec * 1e3 + (double)st.st_mtimespec.tv_nsec / 1e6;
  s.ctimeMs = (double)st.st_ctimespec.tv_sec * 1e3 + (double)st.st_ctimespec.tv_nsec / 1e6;
#else
  s.mtimeMs = (double)st.st_mtim.tv_sec * 1e3 + (double)st.st_mtim.tv_nsec / 1e6;
  s.ctimeMs = (double)st.st_ctim.tv_sec * 1e3 + (double)st.st_ctim.tv_nsec / 1e6;
#endif
  return s;
}
inline std::string realPath(const std::string &p, bool &ok) {
  char buf[PATH_MAX]; ok = ::realpath(p.c_str(), buf) != nullptr; return ok ? std::string(buf) : std::string();
}
// mkdir 0700 if missing; true if it is then a directory we own and not a symlink
inline bool privateDir(const std::string &d) {
  if (::mkdir(d.c_str(), 0700) != 0 && errno != EEXIST) {
    // (recursive, as fs.mkdirSync {recursive: true})
    const size_t k = d.find_last_of('/');
    if (k == std::string::npos || k == 0 || !privateDir(d.substr(0, k))) return false;
    if (::mkdir(d.c_str(), 0700) != 0 && errno != EEXIST) return false;
  }
  struct stat st;
  if (::lstat(d.c_str(), &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != ::getuid()) return false;
  return true;
}
inline std::string userName() {
  std::string u = std::to_string(::getuid());
  if (struct passwd *pw = ::getpwuid(::getuid())) {
    std::string n = pw->pw_name ? pw->pw_name : "";
    for (char &c : n) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) c = '_';
    if (!n.empty()) u = n;
  }
  return u;
}
}  // namespace wutil
