// SPDX-License-Identifier: MIT
// ---- N-API argument checks for the WCZ addon exports ----
// Each check returns true when the argument is acceptable. Otherwise it leaves a pending JS
// TypeError (Napi::TypeError::New(...).ThrowAsJavaScriptException(), as in the node-addon-api
// error-handling docs) and returns false; the export then returns at once.
#pragma once
#include <napi.h>
#include <algorithm>
#include <cstring>
#include <new>
#include <string>
#include <vector>

namespace wargs {
static inline bool fail(const Napi::Env &env, const std::string &what) {
  Napi::TypeError::New(env, "wcz addon: " + what).ThrowAsJavaScriptException();
  return false;
}
// at least `n` arguments were passed
static inline bool count(const Napi::Env &env, const Napi::CallbackInfo &info, size_t n) {
  return info.Length() >= n || fail(env, "needs " + std::to_string(n) + " argument(s), got " + std::to_string(info.Length()));
}
static inline bool str(const Napi::Env &env, const Napi::Value &v) { return v.IsString() || fail(env, "argument must be a string"); }
static inline bool num(const Napi::Env &env, const Napi::Value &v) { return v.IsNumber() || fail(env, "argument must be a number"); }
static inline bool arr(const Napi::Env &env, const Napi::Value &v) { return v.IsArray() || fail(env, "argument must be an array"); }
}  // namespace wargs
