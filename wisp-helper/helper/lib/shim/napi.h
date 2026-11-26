// SPDX-License-Identifier: MIT
// A small in-process stand-in for node-addon-api's napi.h, so the helper addon's C++ (store, block source,
// WCZ source) compiles unchanged into the native helper. Values are a JSON-like tree (insertion-ordered objects,
// arrays, numbers as doubles, strings, booleans, null/undefined) plus byte buffers and typed arrays; functions are
// C++ callables. A "JS exception" is a pending error on the thread (Error::ThrowAsJavaScriptException), which the
// caller reads after the call (Env::IsExceptionPending / takePending). Only the surface the addon uses is here.
#pragma once
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <functional>
#include <initializer_list>
#include <memory>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace Napi {

enum class T : uint8_t { Undef, Null, Bool, Num, Str, Arr, Obj, Bytes, Typed, Fn };
enum class TA : uint8_t { None, U8, I32, U32, F64 };
class Value;
class CallbackInfo;
struct Node;
using NodeP = std::shared_ptr<Node>;
using Fn = std::function<Value(const CallbackInfo &)>;

struct Node {
  T t = T::Undef;
  bool b = false;
  double n = 0;
  std::string s;                       // Str; Bytes/Typed: the bytes
  TA ta = TA::None;                    // Typed: element type
  std::vector<NodeP> arr;              // Arr
  std::vector<std::pair<std::string, NodeP>> obj;  // Obj, in insertion order
  std::unordered_map<std::string, size_t> idx;     // Obj key -> position
  std::shared_ptr<Fn> fn;              // Fn
};

struct Pending { bool on = false; std::string msg; bool type = false; };
inline Pending &pending() { static thread_local Pending p; return p; }

class Env {
 public:
  Env() {}
  Value Undefined() const;
  Value Null() const;
  bool IsExceptionPending() const { return pending().on; }
};

class Value {
 public:
  NodeP p;
  Value() : p(std::make_shared<Node>()) {}
  explicit Value(NodeP q) : p(std::move(q)) {}
  Napi::Env Env() const { return Napi::Env(); }
  T type() const { return p ? p->t : T::Undef; }
  bool IsUndefined() const { return type() == T::Undef; }
  bool IsNull() const { return type() == T::Null; }
  bool IsBoolean() const { return type() == T::Bool; }
  bool IsNumber() const { return type() == T::Num; }
  bool IsString() const { return type() == T::Str; }
  bool IsArray() const { return type() == T::Arr; }
  bool IsObject() const { return type() == T::Obj || type() == T::Arr || type() == T::Bytes || type() == T::Typed || type() == T::Fn; }
  bool IsTypedArray() const { return type() == T::Typed || type() == T::Bytes; }
  bool IsBuffer() const { return type() == T::Bytes; }
  bool IsFunction() const { return type() == T::Fn; }
  template <class X> X As() const { return X(p); }
  class Boolean ToBoolean() const;
  class Number ToNumber() const;
  operator bool() const { return p != nullptr; }
  // conversions used by Object::Set / Array::Set
  static Value From(const Value &v) { return v; }
  static Value From(bool v) { auto n = std::make_shared<Node>(); n->t = T::Bool; n->b = v; return Value(n); }
  static Value From(const std::string &v) { auto n = std::make_shared<Node>(); n->t = T::Str; n->s = v; return Value(n); }
  static Value From(const char *v) { return From(std::string(v)); }
  template <class N, typename std::enable_if<std::is_arithmetic<N>::value && !std::is_same<N, bool>::value, int>::type = 0>
  static Value From(N v) { auto n = std::make_shared<Node>(); n->t = T::Num; n->n = (double)v; return Value(n); }
};

inline Value Env::Undefined() const { return Value(); }
inline Value Env::Null() const { auto n = std::make_shared<Node>(); n->t = T::Null; return Value(n); }

class Boolean : public Napi::Value {
 public:
  Boolean() {}
  explicit Boolean(NodeP q) : Napi::Value(std::move(q)) {}
  static Boolean New(Napi::Env, bool v) { return Boolean(Value::From(v).p); }
  bool Value() const { return p && p->b; }
  operator bool() const { return p && p->b; }
};

class Number : public Value {
 public:
  Number() {}
  explicit Number(NodeP q) : Value(std::move(q)) {}
  static Number New(Napi::Env, double v) { return Number(Value::From(v).p); }
  double DoubleValue() const { return p ? p->n : 0; }
  int64_t Int64Value() const { const double d = DoubleValue(); return d != d ? 0 : d >= 9.2233720368547758e18 ? INT64_MAX : d <= -9.2233720368547758e18 ? INT64_MIN : (int64_t)d; }
  int32_t Int32Value() const { const double d = DoubleValue(); if (!(d == d) || d == 1.0 / 0 || d == -1.0 / 0) return 0; return (int32_t)(uint32_t)(int64_t)d; }
  uint32_t Uint32Value() const { return (uint32_t)Int32Value(); }
  operator double() const { return DoubleValue(); }
  operator int64_t() const { return Int64Value(); }
  operator uint32_t() const { return Uint32Value(); }
  operator int32_t() const { return Int32Value(); }
};

class String : public Value {
 public:
  String() {}
  explicit String(NodeP q) : Value(std::move(q)) {}
  static String New(Napi::Env, const std::string &v) { return String(Value::From(v).p); }
  static String New(Napi::Env, const char *v) { return String(Value::From(v).p); }
  static String New(Napi::Env, const char *v, size_t n) { return String(Value::From(std::string(v, n)).p); }
  std::string Utf8Value() const { return p ? p->s : std::string(); }
  operator std::string() const { return Utf8Value(); }
};

inline Boolean Value::ToBoolean() const {
  bool b = false;
  switch (type()) {
    case T::Undef: case T::Null: b = false; break;
    case T::Bool: b = p->b; break;
    case T::Num: b = p->n == p->n && p->n != 0; break;
    case T::Str: b = !p->s.empty(); break;
    default: b = true;
  }
  return Boolean::New(Napi::Env(), b);
}
inline Number Value::ToNumber() const {
  double d = 0;
  switch (type()) {
    case T::Num: d = p->n; break;
    case T::Bool: d = p->b ? 1 : 0; break;
    case T::Null: d = 0; break;
    case T::Str: { char *e = nullptr; const std::string &x = p->s; size_t a = x.find_first_not_of(" \t\n\r"); if (a == std::string::npos) { d = 0; break; } d = strtod(x.c_str() + a, &e); if (e && *e && std::string(e).find_first_not_of(" \t\n\r") != std::string::npos) d = 0.0 / 0.0; break; }
    default: d = 0.0 / 0.0;
  }
  return Number::New(Napi::Env(), d);
}

class Object : public Value {
 public:
  Object() {}
  explicit Object(NodeP q) : Value(std::move(q)) {}
  static Object New(Napi::Env) { auto n = std::make_shared<Node>(); n->t = T::Obj; return Object(n); }
  template <class V> void Set(const std::string &k, const V &v) {
    Value x = Value::From(v);
    auto it = p->idx.find(k);
    if (it != p->idx.end()) p->obj[it->second].second = x.p;
    else { p->idx.emplace(k, p->obj.size()); p->obj.emplace_back(k, x.p); }
  }
  template <class V> void Set(const char *k, const V &v) { Set(std::string(k), v); }
  template <class V> void Set(uint32_t k, const V &v) { Set(std::to_string(k), v); }
  template <class V> void Set(const Napi::Value &k, const V &v) { Set(k.p ? k.p->s : std::string(), v); }
  Value Get(const std::string &k) const { auto it = p->idx.find(k); return it == p->idx.end() ? Value() : Value(p->obj[it->second].second); }
  Value Get(const char *k) const { return Get(std::string(k)); }
  bool Has(const std::string &k) const { return p->idx.count(k) > 0; }
  bool Has(const char *k) const { return Has(std::string(k)); }
};

class Array : public Object {
 public:
  Array() {}
  explicit Array(NodeP q) : Object(std::move(q)) {}
  static Array New(Napi::Env) { auto n = std::make_shared<Node>(); n->t = T::Arr; return Array(n); }
  static Array New(Napi::Env e, size_t n) { Array a = New(e); a.p->arr.resize(n); for (auto &x : a.p->arr) x = std::make_shared<Node>(); return a; }
  template <class V> void Set(uint32_t i, const V &v) { if (i >= p->arr.size()) { size_t o = p->arr.size(); p->arr.resize(i + 1); for (size_t k = o; k < p->arr.size(); k++) p->arr[k] = std::make_shared<Node>(); } p->arr[i] = Value::From(v).p; }
  template <class V> void Set(int i, const V &v) { Set((uint32_t)i, v); }
  template <class V> void Set(size_t i, const V &v) { Set((uint32_t)i, v); }
  template <class V> void Set(const std::string &k, const V &v) { Object::Set(k, v); }
  template <class V> void Set(const char *k, const V &v) { Object::Set(k, v); }
  Value Get(uint32_t i) const { return i < p->arr.size() ? Value(p->arr[i]) : Value(); }
  Value Get(int i) const { return Get((uint32_t)i); }
  Value Get(size_t i) const { return Get((uint32_t)i); }
  Value Get(const std::string &k) const { return Object::Get(k); }
  Value Get(const char *k) const { return Object::Get(k); }
  uint32_t Length() const { return (uint32_t)p->arr.size(); }
};

template <class E> struct TAKind;
template <> struct TAKind<uint8_t> { static const TA k = TA::U8; };
template <> struct TAKind<int32_t> { static const TA k = TA::I32; };
template <> struct TAKind<uint32_t> { static const TA k = TA::U32; };
template <> struct TAKind<double> { static const TA k = TA::F64; };

template <class E> class TypedArrayOf : public Object {
 public:
  TypedArrayOf() {}
  explicit TypedArrayOf(NodeP q) : Object(std::move(q)) {}
  static TypedArrayOf New(Napi::Env, size_t n) { auto x = std::make_shared<Node>(); x->t = T::Typed; x->ta = TAKind<E>::k; x->s.assign(n * sizeof(E), '\0'); return TypedArrayOf(x); }
  E *Data() const { return reinterpret_cast<E *>(&p->s[0]); }
  size_t ElementLength() const { return p->s.size() / sizeof(E); }
  size_t ByteLength() const { return p->s.size(); }
  E &operator[](size_t i) const { return Data()[i]; }
};
using Uint8Array = TypedArrayOf<uint8_t>;
using Int32Array = TypedArrayOf<int32_t>;
using Uint32Array = TypedArrayOf<uint32_t>;
using Float64Array = TypedArrayOf<double>;

template <class E> class Buffer : public Object {
 public:
  Buffer() {}
  explicit Buffer(NodeP q) : Object(std::move(q)) {}
  static Buffer New(Napi::Env, size_t n) { auto x = std::make_shared<Node>(); x->t = T::Bytes; x->s.assign(n * sizeof(E), '\0'); return Buffer(x); }
  static Buffer Copy(Napi::Env, const E *d, size_t n) { auto x = std::make_shared<Node>(); x->t = T::Bytes; x->s.assign(reinterpret_cast<const char *>(d), n * sizeof(E)); return Buffer(x); }
  E *Data() const { return reinterpret_cast<E *>(&p->s[0]); }
  size_t Length() const { return p->s.size() / sizeof(E); }
  size_t ByteLength() const { return p->s.size(); }
};

class CallbackInfo {
 public:
  std::vector<Value> args;
  CallbackInfo() {}
  explicit CallbackInfo(std::vector<Value> a) : args(std::move(a)) {}
  size_t Length() const { return args.size(); }
  Value operator[](size_t i) const { return i < args.size() ? args[i] : Value(); }
  Napi::Env Env() const { return Napi::Env(); }
};

class Function : public Object {
 public:
  Function() {}
  explicit Function(NodeP q) : Object(std::move(q)) {}
  static Function New(Napi::Env, Fn f) { auto x = std::make_shared<Node>(); x->t = T::Fn; x->fn = std::make_shared<Fn>(std::move(f)); return Function(x); }
  static Function New(Napi::Env e, void (*f)(const CallbackInfo &)) { return New(e, Fn([f](const CallbackInfo &i) { f(i); return Value(); })); }
  template <class R> static Function New(Napi::Env e, R (*f)(const CallbackInfo &)) { return New(e, Fn([f](const CallbackInfo &i) { return Value(f(i).p); })); }
  Value Call(std::initializer_list<Value> a) const { return (*p->fn)(CallbackInfo(std::vector<Value>(a))); }
  Value Call(const std::vector<Value> &a) const { return (*p->fn)(CallbackInfo(a)); }
};

class Error : public Object {
 public:
  std::string msg; bool type = false;
  Error() {}
  static Error New(Napi::Env, const std::string &m) { Error e; e.msg = m; return e; }
  void ThrowAsJavaScriptException() const { pending().on = true; pending().msg = msg; pending().type = type; }
  const std::string &Message() const { return msg; }
};
class TypeError : public Error {
 public:
  static TypeError New(Napi::Env, const std::string &m) { TypeError e; e.msg = m; e.type = true; return e; }
};
class RangeError : public Error {
 public:
  static RangeError New(Napi::Env, const std::string &m) { RangeError e; e.msg = m; return e; }
};

}  // namespace Napi

// The module's Init, registered at static-initialization time; shim_exports() returns its exports object.
namespace napi_shim {
using InitFn = Napi::Object (*)(Napi::Env, Napi::Object);
inline InitFn &initFn() { static InitFn f = nullptr; return f; }
struct Reg { explicit Reg(InitFn f) { initFn() = f; } };
inline Napi::Object &exportsObj() { static Napi::Object o = Napi::Object::New(Napi::Env()); return o; }
inline Napi::Object shim_exports() { static bool done = false; if (!done) { done = true; initFn()(Napi::Env(), exportsObj()); } return exportsObj(); }
}  // namespace napi_shim
#define NODE_API_MODULE(name, init) static napi_shim::Reg napi_shim_reg_##name(init);
