<!-- SPDX-License-Identifier: MIT -->
<!-- doc: helper/README.md | written: 2026-11-25 -->
# helper/: the waveform helper

This page describes snapshot 15.12.

The helper, called Wisp, serves waveform data to viewers, scripts and agents over a pipe. Its program is
`wisp-helper`, and its settings start with `WISP_`. It is one process with a thread pool. It opens a waveform file
and answers requests on it (below).

It reads two formats, each in its own form:
- WCZ files;
- FSDB files, in place, with the FSDB converter's own reader and planner, compiled from this repository. No file is
  written, and no FSDB reader library is needed.

Any other file is refused.

## Build

```
make helper                 # from the repository root: build/helper/wisp-helper
sh build.sh <outdir>        # the same build by hand: <outdir>/wisp-helper
```

It builds on Linux and on macOS (arm64 and x86_64). It needs GCC 11 or newer (C++17), or on macOS the Xcode clang,
a C compiler, zlib (on macOS the SDK's) and pthreads. The zstd decompressor is included. On an older compiler the
build stops at once and names the requirement (exit code 2).

The build prints `direct FSDB read: on (<dir>)` when it finds the converter's source, and `off` otherwise. A helper
built with it off refuses FSDB files and says how to build it with the FSDB reader.

### macOS

The build is the same command, with Apple clang and the SDK's zlib. For Intel Macs:
`CXX="clang++ -arch x86_64" CC="clang -arch x86_64" sh build.sh <outdir>`. What differs from Linux:
- the threads for the FSDB checks use the hardware CPU count. macOS has no CPU affinity masks, so `taskset` limits
  do not apply;
- the resident memory used by the memory bounds and by `stats` (`rssKB`) is the task's resident size from the
  kernel. On Linux it comes from `/proc/self/statm` and `/proc/self/status`. Both count the mapped file's resident
  pages;
- `--workers auto` takes the available memory as free + inactive + purgeable + speculative pages. On Linux it is
  `MemAvailable` in `/proc/meminfo`. `WISP_HOST_AVAIL_MB` sets it on both;
- freed memory goes back to the system with `malloc_zone_pressure_relief` (Linux: `malloc_trim`), and buffers of
  64 KiB or more (Linux: 1 MiB) are mapped and unmapped directly;
- read-ahead advice is the same call, and how far the kernel reads ahead is the kernel's own.

The helper's tests (tests/check.sh) pass on macOS arm64 and x86_64.

## Run

```
wisp-helper [--workers N] [--cache-mb MB] [--text-budget-mb MB]
```

Requests are JSON objects, one per line, on stdin. Replies are JSON lines on file descriptor 3, or on stdout when
descriptor 3 is not open. A reply that carries binary data gives its length (`binLength`), and the bytes follow it on
the same descriptor.

## Requests

Each request has a `cmd` field and an optional `id`, which the reply carries back:

| request | fields | returns |
|---|---|---|
| `open` | `file`; `force` for a `.FAILED` file | the file's summary |
| `close` | - | `{}` |
| `children` | `scopePath` | the scopes and variables under it |
| `stats` | - | memory, threads, settings; an FSDB open's computed names |
| `verify` | - | `ok` and `ms` after the whole-file check (below) |
| `window` | `signals`, `t0`, `t1` | the changes of each signal |
| `valueAt` | `signalIds`, `t`, `prev` | `values`, and `prev` when set |
| `count` | `signalIds`, `exact` | the change count of each signal; a computed signal is refused |
| `edge` | `signalId`, `t`, `dir`, `kind` | a time |
| `search` | `signalId`, `t`, `dir`, `value`, `wildcard` | a time |
| `derive` | `expr` | `signalId`, `width`, `count`, `bits`, `xz`, `operands`, `materialized` |
| `free` | `signalIds`, or none for all | `{}` |
| `cancel` | `target`, or its own `id` | `cancelled`, `dropped`, `running` |

Notes:
- `edge` and `search` look forward with `dir` 1 and back with `dir` -1. `kind` is `any`, `rise`, `fall`,
  `posedge`, `negedge` or `edge`. `value` is a string of `0`, `1`, `x`, `z` (either case) and `?`.
- `derive` makes a signal computed from stored ones, which the value requests answer like a stored one.
- `free` drops decoded data.
- `cancel` drops the queued or running request with that id. Its reply is
  `{"result":{"cancelled":true,"dropped":<n>,"running":<0|1>}}`, or `cancelled: false` when nothing matched, and the
  dropped request gets a line `{"id":...,"cancelled":true}`.

`signals`, `aliasHints`, `searchAll`, `searchText`, `clockVerify`, `clockInfo` and `warm` are accepted and answer that
this helper does not support them. Any other `cmd` gets `unknown command`.

## Replies

The hierarchy leaves out four reserved scopes and everything under them: `$object_root`, `$trans_root` and
`$hidden_class` (class objects), and `$unreferenced_value_ids` (the converter's scope for value ids that no
declaration names). Every other scope is listed, also one whose name starts with `$`: some tools name unnamed blocks
that way (`$unm_blk_1`, `$ivl_for_loop0`). The value requests accept exactly the signal ids of the listed scopes.

A name the file declares with no values is still listed: its entry has `signalId: null` and an `unavailable` field
with the state (`absent` or `unsupported`) and the reason the file names. A generic reason is given only when the file
names none.

A signal that cannot be read, for example because of a damaged block, gets an error and no value:
- a `window` reply gives the signal an `error`;
- a `valueAt` reply gives it `null` in `values` (and in `prev`), and the reason in `errors`, a list with one entry per
  requested id (`null` for the ids that were read). `errors` is present only when a requested signal failed;
- a `count` entry gives the reason in `error`, and `unknown: true` unless the request set `exact`.

For a string or real signal, `valueAt` with `prev` loads the signal first, and prints `prev.value` the same way as
`values`.

Files the open refuses:
- a WCZ file whose end time is before some signal's last change, as `wcz-check` refuses it;
- a file whose name ends in `.FAILED`, or a link to one: a converter output that failed its self-check (code
  `failedFile`; the reply names the `.diff.tsv` report). `"force": true` in the open request opens it anyway, and the
  result then has `"selfCheckFailed": true`. The check is by name only, so a renamed copy opens normally.

The default of 4 reader threads is meant to serve the same values as a one-thread read. Large damaged files, and FSDB
files read with several threads, are not covered by tests. Run `wcz-check` on a file you think is damaged.

## Reading an FSDB file

The helper reads an FSDB file with the converter's reader and rules, so it lists the same hierarchy, the same
values and the same names with no values as the converted file ([docs/fsdb-support.md](../docs/fsdb-support.md)).
There is one difference: where the converter refused to link a port copy (for example a forced one), the helper
shows `port copy: values not linked yet`, and the converted file shows the converter's reason.

Opening plans the file and runs the converter's checks on the plan, its time bounds and the width limit of 1,048,576
bits. A file the converter refuses for these does not open: the error has code `fileRefused` and the text `this FSDB
file cannot be read directly: ` followed by the converter's message. The open reads the declarations and index
blocks, and no values.

Values do not wait for the whole file. The first request for a signal decodes that signal with the converter's
checks. A signal that fails gets `the converter refuses this signal: <message> (stored signal <name>)`, and the other
signals still answer.

The whole-file check runs in the background. `WISP_VERIFY_START` sets when it starts:
- `open` (the default): at the open;
- `idle:<seconds>` (0 to 86400): once the client has sent no request for that long. Every request starts the wait
  again;
- `request`, or `off`: only on a `verify` request.

Any other value of the setting refuses an FSDB open (`fileRefused`); a WCZ open ignores it. With
`WISP_DIRECT_OPEN=full` or `scan`, the check still runs before the first value. `stats` gives `checkStart` (open,
idle or request), `check` (`deferred` until it starts), `checkDone` (signals checked) and `idleChecks` (checks
started after the idle wait).

What this means for requests:
- until the check has passed, an answer can come from a file the converter would refuse as a whole. Every value
  reply carries `"verified"`, and it is `false` until the check has passed, in every mode;
- a stream the converter refuses on its own shows as a normal signal in hierarchy replies until it is first read;
- when the check refuses the file, the helper sends one line that answers no request:
  `{"event":"fileRefused","error":"<message>","code":"fileRefused","withdrawn":<n>,"msAfterOpen":<ms>}`. It withdraws
  the n answers given with `"verified": false`, and every later value request gets `fileRefused`;
- `verify` starts the check at once if it has not started, in every mode, waits for it, and replies `{"ok": true,
  "ms": ...}`, or `fileRefused` with the message. A program that cannot take back an answer should send `verify` and
  wait, or use the full open;
- while the check runs, the first read of each signal also runs that signal's check, and the background check uses
  the same CPUs. How much this adds to a first read is not measured;
- while the check runs, its memory counts as part of the open, also when it starts after the open, and no value
  request is refused with `worker memory limit`.

With `WISP_DIRECT_OPEN=full`, the open scans every stored stream first, and the first value waits until every record
has been decoded and checked. A file the converter refuses then gives no value at all. This open reads the whole
file, so its time and memory grow with the file.

Other points on an FSDB open:
- strings and reals are read as the converter reads them. A real is given as text, the shortest decimal that reads
  back to the same value, and `NaN` for every NaN;
- events are listed with no values (state `unsupported`);
- the open reply has `source` set to `fsdb`, no zoom-out summaries (`caps.lod` is false) and no dump-off list;
- damaged blocks and index errors give an error for the damaged signals;
- a file whose recorded begin or end time does not match its stored time periods does not open (`file time bounds
  do not match the stored periods`);
- a file changed while it is open is not detected;
- not tested yet: the escaped-name rule and `unconsumed declaration bytes` through the helper, an unknown value
  encoding inside a stream, a signal wider than 1,048,576 bits, more than 1,048,576
  changes of one signal at one time, and the plan size limit.

Port links work as in the converter, with links and full scope on and no force log by default. Without a force log,
a forced port copy that leaves no stored history is not detected.

Converting the FSDB file to WCZ is optional, at the cost of one conversion. The open, the first data and window
requests on both are compared on the [benchmarks page](../docs/benchmarks.md) where measured.

### Computed signals on an FSDB open

Port copies declared with `port copy: values not linked yet` can be computed from the dump's own description of the
logic, over the window a request asks for. This needs `"outsideWrites": "none"` in the open request: your statement
that the run wrote no design signal from outside the logic (no force, deposit or C-code write). Without it, those
names stay with no values.

With it:
- each such bit-vector name gets a signal id after the stored signals (`stats` gives `computed.firstId` and
  `computed.signals`);
- a `window` request with those ids computes them over [t0, t1] only, by the same rules as the dump-alone route of
  [docs/convert.md](../docs/convert.md#values-from-the-dump-alone). The answers have the form of stored rows, with no
  `total`;
- `valueAt`, `count`, `edge` and `search` on a computed id answer `a computed signal answers window requests only`,
  before and after a window on that id. No count of a computed signal is kept between requests;
- a name that cannot be computed answers its reason by name, and the other rows are not affected.

Memory:
- the first computed request reads the dump's logic records once per open. Its memory is first estimated from the
  file and checked against the memory left. If it does not fit, or the read fails, every computed name of that open
  answers the reason by name until the file is opened again;
- each request then uses the memory left at its start, half for the evaluation's caches and half for the rows it
  keeps. A name over that is refused by name (`rows over the memory room of this request`, `history over this
  request's memory room`).

With `WISP_FORCE_LOG` set, computed names are refused by name. Nothing refuses delays, power-aware behaviour or
sampled views on this path, as on the dump-alone route of
[docs/convert.md](../docs/convert.md#values-from-the-dump-alone).

## Settings

| setting | default | what it does |
|---|---|---|
| `--workers N`, `WISP_WORKERS` | 4 | reader threads, 1 to 8 |
| `--cache-mb MB` | 256 MiB cache; 1,024 MB read limit | the decoded-block cache, and the read limit (below) |
| `WCB_BLOCK_LRU_MB` | 256 | the decoded-block cache; wins over `--cache-mb` |
| `WISP_CACHE_MB` | 1,024 | the read limit only |
| `--text-budget-mb MB`, `WISP_TEXT_BUDGET_MB` | 16 MiB | the memory budget for string rows, at least 1; the option wins over the variable |
| `WISP_DIRECT_OPEN` | `lazy` | `full` or `scan`: check the whole FSDB file before the first value. Any other value refuses the open |
| `WISP_VERIFY_THREADS` | the CPUs the helper may use, at most 16 | threads for the FSDB checks |
| `WISP_VERIFY_START` | `open` | when the whole-file check starts: `open`, `idle:<seconds>`, `request` or `off` (FSDB files) |
| `WISP_IDLE_RELEASE_MS` | 30000 | after this long with no request, gives back caches and resident pages; 0 never does |
| `WISP_PORT_LINKS` | 1 | 0: no port copy is linked (FSDB files) |
| `WISP_FULL_SCOPE` | 1 | 0: links stay on and no copy is linked, as the converter's setting (FSDB files) |
| `WISP_FORCE_LOG` | none | the simulator's force log (FSDB files). A log that cannot be read refuses the open |
| `WISP_BLOCK_READAHEAD` | 1 | 0: no read-ahead advice for data blocks of two pages or more (WCZ files) |
| `WISP_FOOTER_PREFETCH` | 1 | 0: no footer read-ahead at open; `defer`: from a thread after the open (WCZ files) |
| `WISP_FOOTER_FD` | 1 | 0: read the footers through the memory map; same answers (WCZ files) |
| `WISP_INDEX_DIR` | `/tmp/<user>-wisp-helper/index` | where the per-file index directory is made |
| `WCZ_INCLUDE`, `WISP_CONVERTER_DIR` | the repository's `include/` and FSDB converter | build paths for the WCZ reader headers and the FSDB reader |

The read limit is the MB divided by the workers. With neither `--cache-mb` nor `WISP_CACHE_MB` given, each worker
gets at least 256 MB. A port-link setting other than 0 or 1 refuses the open. WCZ files ignore the port-link
settings. The footers are those of the value sections.

## Layout and tests

| path | contents |
|---|---|
| `src/` | the request loop, thread pool, protocol values and file open |
| `lib/addon/` | the store and answer code over WCZ, and the FSDB source over the converter's reader |
| `lib/shim/`, `lib/src/` | a small interface layer, a JSON printer and parser, utilities |
| `lib/third_party/zstd/` | the zstd decompressor |
| `tests/` | the helper's checks |

`make check` runs `tests/check.sh` on the repository's WCZ vector and hand-made bytes. Among its cases: open,
children, value and close; `derive` nesting; damaged or missing FSDB data (refused, no value); a damaged block in
`valueAt`, which gives a reason; string and real rows with `prev`; the port-link setting refusals; the `.FAILED` name
refusal; a file that is neither format; the thread default; and the read-ahead and footer modes on a WCZ file from a
generated VCD.

Tests that need FSDB files, of which the repository ships none, say SKIP without inputs:
- `make check-helper-inputs HELPER_TEST_GOOD=<good.fsdb> HELPER_TEST_REFUSED="<refused.fsdb>..."`;
- `make check-helper-computed HELPER_TEST_COMPUTED="<dump.fsdb>..."`: the computed answers and replies, refusals
  under low memory bounds and a failure inside the computation, a force log, and reopening with and without the
  statement.
