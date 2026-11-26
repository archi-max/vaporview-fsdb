// SPDX-License-Identifier: MIT
// fplan: multithreaded C++17 FSRAWPLAN3 planner (same plans as the Python reference planner). Pure file parsing.
// Output (plan text, refusals, summary) is byte-identical to the Python reference planner for the same options (refusal and error texts use this planner's own wording).
#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>
#include "plan_names.h"

namespace fplan {

// Not-listed items of the extended declaration path (internal carriers): parsed declarations the planner does not enumerate as names. Kept as metadata
// keyed by the projected ID, separate from the public name list (filled only when carrier_rows is set).
struct CarrierRow { uint64_t raw_id, id; int64_t bits, left, right, fid; uint32_t dir; std::string scope, name; };
extern std::vector<CarrierRow>* carrier_rows;
struct Options {
  bool allow_partial = false;                   // --allow-partial
  int threads = 0;                              // 0 = std::thread::hardware_concurrency()
  std::map<uint64_t, std::string> exclude_streams;  // --exclude-streams: native ID -> reason
  bool has_select_ids = false;                  // --select-ids given
  std::vector<uint64_t> select_ids;             //   IDs in file order
  bool accept_derived = true;                   // false = --strict-derived
  bool derived_prefix = false;                  // --derived-prefix: store the stored prefix of reader-computed streams (old behaviour)
  bool typed = false;                           // --typed F: decode real (field 16) and string (field 19) streams into Result::typed
  bool ids = false;                             // --ids F: one row per declaration in file order (DIAGNOSTIC id map; no value decode)
  bool port_links = false;                      // link x=0 IDENTITY port copies from the FSDB. OFF by default, opt-in --port-links
  std::string force_log;                        // simulator force log (--force-log F); forced components are never linked
  std::string force_report;                     // --force-report F: one TSV row per force-log target with the match rule that fired
  bool links_file_rule = true;                  // with port links: a port copy with its own stream refuses every link in the file (always on; --no-links-file-rule turns it off only in the test build, FPLAN_TEST_HOOKS)
  bool full_scope = false;                      // --full-scope-dump, the producer declares a FULL-SCOPE dump of the linked scopes
  bool emit_text = true;                        // build Result::plan (FSRAWPLAN3 text)
  bool emit_struct = false;                     // build Result::sp (same plan as structs; no text needed)
  bool emit_names = false;                      // with emit_struct: the declarations as Result::names (one slot per V/D line, in plan order) and
                                                //   PlanVar::head / aliases left empty (no head text); with refusal_scope_ids, Refusal::names_node
  // emit_text with a sink: the plan text is handed to plan_sink in order, in pieces (no whole-plan copy is held);
  // Result::plan stays empty and Result::plan_bytes is the byte count. A false return fails the build.
  std::function<bool(const char*, size_t)> plan_sink;
  bool refusal_scopes = true;                   // fill Refusal::scope (components); the CLI needs them only for --undeclared
  bool refusal_scope_ids = false;               // with refusal_scopes: Refusal::scope_ix (a scope id) + Result::scope_recs (the
                                                //   scope record tables, handed over at the end) instead of a component copy in each Refusal::scope
  bool crc = true;                              // false: no whole-file CRC (StructPlan::crc = 0); for in-place readers that do not print the plan
  bool skip_dirs = false;                       // with allow_partial: a later tree directory holding a record kind not read is left out (its IDs listed by ID), not the file;
                                                //   false = refuse such a file whole (library callers that do not show the listing). The CLI and fsdb-compat-check set it
  bool index_willneed = false;                  // advise each index block's range before decoding (cold opens read only those)
  bool dump_off = false;                        // read a dump-off stream into the plan's O section; false = refuse such a file whole (the CLI sets it)
};

// Structured FSRAWPLAN3: exactly the content of the text plan (to_text() reproduces it byte for byte).
struct PlanBlock { uint64_t off; uint32_t size, period; };                       // B / C lines
struct PlanPeriod { uint64_t begin, end; bool direct; std::vector<uint64_t> delta; };  // T lines (direct = empty table)
struct PlanWindow { uint32_t period; uint64_t start, end; };                      // W lines
struct PlanRec {  // R lines; same fields as "R kind period count index_block vc block offset begin end"
  char kind;       // 'S' scalar inline, 'I' bus inline, 'B' bus
  uint32_t period; uint64_t count; uint32_t index_blk, vc, block, offset; uint64_t begin, end;
};
struct PlanVar {
  uint64_t id; uint32_t bits; int64_t left, right;
  std::string head;                  // "bits left right nparts <scope hex...> <name hex>" (V line minus id/nrec)
  std::vector<std::string> aliases;  // alias lines minus the leading "D "
  std::vector<PlanRec> recs;
};
struct StructPlan {
  uint64_t size = 0; uint32_t crc = 0; int scale = 0; uint64_t tmin = 0, tmax = 0;
  uint64_t text_bytes = 0;  // size the FSRAWPLAN3 text would have
  std::vector<PlanBlock> bus, index_blk; std::vector<PlanPeriod> periods; std::vector<PlanWindow> windows; std::vector<PlanVar> vars;
  std::vector<PlanRec> doff;  // O section: the dump-off stream's records (1-bit inline), empty when never switched off
};
std::string to_text(const StructPlan& sp, int threads = 0);

struct Refusal {
  std::string reason;
  uint64_t ident;
  std::string full_name;
  // declaration of the refused var (for --undeclared): scope path components, leaf name, range, kind of value
  std::vector<std::string> scope; uint32_t scope_ix = UINT32_MAX; std::string name; int64_t bits = 0, left = 0, right = 0; bool is_string = false; int nonbit = 0;  // nonbit: 1 real, 2 event
  uint32_t names_node = UINT32_MAX;  // Options::emit_names + refusal_scope_ids: the scope as a Result::names node (UINT32_MAX: none)
  bool excluded = false;  // listed in Options::exclude_streams (the converter's re-plan): reason = the caller's text, unchanged
};

struct Derived {  // summary['derived_after'] rows: (idcode, stream_id, T file units, full_name)
  uint64_t ident, stream_id, t;
  std::string full_name;
};

struct Result {
  std::string plan;              // FSRAWPLAN3 text (empty when Options::plan_sink took it)
  uint64_t plan_bytes = 0;       // plan text bytes (built or handed to the sink)
  std::vector<Refusal> refusals;  // reference planner order (report .refusals.tsv)
  struct ScopeRecs {  // Options::refusal_scope_ids: scope id -> first record; record -> parent record, component name
    std::vector<uint32_t> first; std::vector<int32_t> parent; std::vector<std::string> rname;
    std::vector<std::string> components(uint32_t id) const {
      std::vector<std::string> v; for (int32_t a = int32_t(first[id]); a >= 0; a = parent[a]) v.push_back(rname[a]);
      std::reverse(v.begin(), v.end()); return v;
    }
  } scope_recs;
  std::vector<Derived> derived;   // export order
  std::string summary_json;       // json.dumps(summary, sort_keys=True)      (stdout line)
  std::string report_json;        // json.dumps(summary, indent=1, sort_keys=True) + "\n" (report .json)
  int scale_exponent = 0;
  std::string stats;              // DIAGNOSTIC phase timings (stderr)
  StructPlan sp;                  // filled when Options::emit_struct
  plannames::Names names;         // filled when Options::emit_names
  std::string typed;              // --typed side file text (FSTYPED1), empty unless Options::typed
  std::string force_log_bytes; bool force_log_read = false;  // the force log exactly as parsed (the check record hashes these bytes)
  uint64_t typed_vars = 0, typed_rows = 0;
  std::string port_links;         // one-line PORTLINKS summary (stderr), empty unless Options::port_links
  std::unordered_map<uint64_t, std::string> link_reason;  // port copy id -> WCZ reason text when its link was refused by a full-scope / force-log rule
  std::string force_report;       // --force-report text (empty unless Options::port_links and a log was given)
  std::string port_links_note;    // one stderr line: links ON and no force log given
  // When not empty: the WCZ reason text for every port copy left without a link (in place of "port copy: values not linked
  // yet"), so that no computed value from a side file is filled for it. Set when the file shows a possible force or deposit
  // (a port copy with its own stream and no usable force log), when a usable force log lists forced nets, or when the port
  // links were not decoded (a force or deposit cannot be ruled out).
  std::string claim_block;
  std::string pl_json_scope, pl_json_force;  // report keys port_links_full_scope / force_log (links ON only)
  std::string ids;                // --ids side file (FSIDS1), empty unless Options::ids
  std::vector<uint64_t> unref_ids;  // class-object layout: value-carrying native IDs no declaration references (ascending)
  std::vector<std::pair<uint64_t, std::string>> unref_dir;  // of unref_ids: the ones a skipped later tree directory introduces (ID, reason)
};

// Returns false and sets err (the text printed after "plan3 rejected: ") on rejection.
// data/n: the whole FSDB file (e.g. a read-only mmap). Thread-safe; no global state.
bool build(const uint8_t* data, size_t n, const Options& opt, Result& out, std::string& err);

}  // namespace fplan

// Convenience entry point for in-process callers (GPU converter).
bool fplan_build(const uint8_t* data, size_t n, const fplan::Options& opt, std::string& planText, std::string& err);
// Structured plan, no text built (opt.emit_text/emit_struct are overridden). Same checks and rejections as the text path.
bool fplan_build_struct(const uint8_t* data, size_t n, const fplan::Options& opt, fplan::StructPlan& plan, std::string& err);
