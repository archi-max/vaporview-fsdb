#!/bin/bash
# SPDX-License-Identifier: MIT
# check.sh <wisp-helper> <on|off> <file.wcz>: the helper's checks for `make check` (bash + the built helper; inputs are
# the repository's WCZ vector and hand-made bytes, no FSDB files). <on|off> = the build's direct FSDB read mode.
#   1 WCZ smoke: open, children of the top scope, valueAt, close each answer
#  1b derive nesting: parentheses and unary operators share a limit; the next derive still answers
#   2 FSDB header probe: a file with an FSDB header and random bytes after it: on = refused with code fileRefused
#     ("this FSDB file cannot be read directly: ..."); off = unsupportedFile (this build has no FSDB reader)
#   3 whole-file refusal: a truncated file (the 8-byte header only) gives no value: the open is refused (fileRefused
#     on, unsupportedFile off) and count / valueAt return no result
#   4 not-a-WCZ message per mode: a text file, a 2-byte file and a directory get unsupportedFile with the mode's text
#   5 thread default (on): stats directThreads = the CPUs in the affinity mask, at most 16 (taskset -c 0 / 0-1), and
#     WISP_VERIFY_THREADS overrides it; off: no directThreads. SKIP without taskset.
#   6 block read-ahead (needs [wcz-from-vcd]): a generated WCZ with multi-page blocks; a full-range window advises each
#     block read once (stats blockReadAheads == blockReads > 0), the same window again is served from the cache (no new
#     read, no new advice), and WISP_BLOCK_READAHEAD=0 gives reads with no advice. SKIP without the converter.
#   7 footer prefetch (same fixture): stats footerPrefetch sync by default, defer / off with WISP_FOOTER_PREFETCH=defer
#     / 0; in defer the helper's thread has advised footer ranges (footerRangesDeferred > 0; stats waits for the
#     thread, also when WISP_TEST_FOOTER_DELAY_MS holds it 500 ms); same window answer in all.
#  7b footer reads (same fixture): stats footerRead pread by default, map with WISP_FOOTER_FD=0; same window answer.
#   8 unreadable signal in valueAt: the WCZ vector with one bit flipped in a data block (byte 336, bit 3: the open
#     still succeeds, the window reply has an error for signal 1); valueAt (prev off and on) must give errors[0] = a
#     reason, never a bare null. A fixture that is no longer corrupt FAILS (the test would no longer bite).
#   9 text rows in valueAt with prev (needs [wcz-from-vcd]): a generated WCZ with a real and a 1-bit signal, nothing
#     loaded before; valueAt prev on must give the same values as prev off and prev = {t, value} of the last change,
#     never a bare null (the snapshot-13 helper answered null for both: the row was not held yet), and the same prev
#     after a window holds the row (snapshot 13 printed the store's raw bit pattern there instead of 2.25).
#  10 port-link switches (on): WISP_PORT_LINKS / WISP_FULL_SCOPE other than 0 or 1, or an unreadable
#     WISP_FORCE_LOG, refuse an FSDB open with the converter wrapper's wording; a WCZ open ignores them
#  11 failed name: a copy of the WCZ vector named *.FAILED (and a link to it with a good name) is refused with code
#     failedFile, naming the failed file and its .diff.tsv; with "force": true it opens, says "selfCheckFailed":true, and answers as the vector does
#  12 known-id table: on the WCZ vector and (with [wcz-from-vcd]) a generated WCZ with nested and sibling scopes,
#     WISP_KNOWN_CHECK=1 builds the table both ways (one native pass, and the scope walk) and must report 0 differing ids
#     with every var of the fixture known; valueAt for every id from 0 to the last netlist id + 1 answers the same with
#     the native table and with WISP_KNOWN_WALK=1
#  13 check start setting (on): WISP_VERIFY_START other than open, idle:<seconds> or request/off refuses an FSDB open
#     (fileRefused, the setting's wording); each good value passes the setting (the header-probe file is then refused
#     for its bytes, not for the setting); a WCZ open ignores it
#  14 reserved scopes (with [wcz-from-vcd]): on a generated WCZ with a top-level $object_root (holding $hidden_class), a
#     $unreferenced_value_ids scope and, under top, $unm_blk_1 and $ivl_for_loop0 (unnamed blocks as a tool names them):
#     the open lists top only at the top level; top's children are $ivl_for_loop0 and $unm_blk_1 with their vars
#     (signal ids); the known-id table has the 3 vars outside the reserved scopes, native == walk; a var in an unnamed
#     block answers valueAt; a var under $object_root is an unknown signal
# Usage: check.sh <wisp-helper> <on|off> <file.wcz> [wcz-from-vcd]
# Prints PASS / FAIL / SKIP per case and a summary; exit 0 = no FAIL.
set -u
H=${1:?usage: check.sh <wisp-helper> <on|off> <file.wcz> [wcz-from-vcd]}; M=${2:?mode}; W=${3:?file.wcz}; V2W=${4:-}; fails=0; pass=0
case "$M" in on|off) ;; *) echo "mode must be on or off"; exit 2;; esac
export LC_ALL=C  # (BSD tr and grep on binary replies need the C locale; macOS)
T=$(mktemp -d); trap 'rm -rf "${T:?}"' EXIT
ask() { printf '%s\n' "$@" | "$H" 3>&1 1>/dev/null 2>/dev/null; }  # replies: JSON lines on descriptor 3
line() { printf '%s\n' "$1" | grep "\"id\":$2[,}]"; }
ok() { echo "PASS $*"; pass=$((pass+1)); }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
# 1
r=$(ask '{"id":1,"cmd":"open","file":"'"$W"'"}' '{"id":2,"cmd":"children","scopeOffsetIdx":0,"scopePath":"top"}' \
        '{"id":3,"cmd":"valueAt","signalIds":[1],"t":0,"prev":false}' '{"id":4,"cmd":"close"}')
n=0; for i in 1 2 3 4; do [[ "$(line "$r" $i)" == *'"result"'* ]] && n=$((n+1)); done
[ $n = 4 ] && ok "1 WCZ smoke: open, children, valueAt, close" || bad "1 WCZ smoke: $n of 4 answered: $(printf '%s\n' "$r" | grep -m1 error | cut -c1-160)"
# 1b
printf -v spaces '%*s' 255 ''
left=${spaces// /(}; right=${spaces// /)}
depth_error='"error":"derive: expression nested too deeply"'
r=$(ask '{"id":1,"cmd":"open","file":"'"$W"'"}' \
        '{"id":2,"cmd":"derive","expr":"'"${left}~~#1${right}"'"}' '{"id":3,"cmd":"derive","expr":"'"${left}#1${right}"'"}')
if [[ "$(line "$r" 2)" == *"$depth_error"* && "$(line "$r" 3)" == *'"operands":[1]'* ]]; then
  ok "1b derive nesting: refused at 257, then accepted at 255"
  left=$(printf '%65536s' '' | tr ' ' '(')
  if r=$(ask '{"id":1,"cmd":"open","file":"'"$W"'"}' '{"id":2,"cmd":"derive","expr":"'"$left"'"}') && [[ "$(line "$r" 2)" == *"$depth_error"* ]]; then
    ok "1b derive nesting: refused maximum-length input"
  else bad "1b derive nesting: maximum-length input: $(line "$r" 2 | cut -c1-160)"; fi
else bad "1b derive nesting: $(line "$r" 2 | cut -c1-160) / $(line "$r" 3 | cut -c1-160)"; fi
# hand-made files with an FSDB header: 4 zero bytes + the header magic, then random bytes (g1) or nothing (g2)
printf '\0\0\0\0\xfc\x3d\xd9\x48' > "$T/g2.bin"; { cat "$T/g2.bin"; head -c 4096 /dev/urandom; } > "$T/g1.bin"
# 2
o=$(line "$(ask '{"id":1,"cmd":"open","file":"'"$T/g1.bin"'"}')" 1)
if [ $M = on ]; then [[ "$o" == *'"code":"fileRefused"'* && "$o" == *'this FSDB file cannot be read directly: '* ]] && ok "2 header probe ($M): fileRefused" || bad "2 header probe ($M): ${o:0:200}"
else [[ "$o" == *'"code":"unsupportedFile"'* && "$o" == *"made without its FSDB reader"* && "$o" != *"onvert this"* ]] && ok "2 header probe ($M): unsupportedFile, says the build lacks the FSDB reader" || bad "2 header probe ($M): ${o:0:200}"; fi
# 3
r=$(ask '{"id":1,"cmd":"open","file":"'"$T/g2.bin"'"}' '{"id":2,"cmd":"count","signalIds":[1]}' '{"id":3,"cmd":"valueAt","signalIds":[1],"t":0,"prev":false}')
want=fileRefused; [ $M = off ] && want=unsupportedFile
if [[ "$(line "$r" 1)" == *"\"code\":\"$want\""* && "$(line "$r" 2)" != *'"result"'* && "$(line "$r" 3)" != *'"result"'* ]]; then ok "3 truncated file ($M): $want, no value"
else bad "3 truncated file ($M): $(printf '%s\n' "$r" | cut -c1-160 | tr '\n' ' ')"; fi
# 4
printf 'hello, not a waveform\n' > "$T/a.txt"; printf 'ab' > "$T/b.bin"; mkdir "$T/dir"
txt='neither a WCZ file nor an FSDB file'; [ $M = off ] && txt='only WCZ files open here'
for f in "$T/a.txt" "$T/b.bin" "$T/dir"; do o=$(line "$(ask '{"id":1,"cmd":"open","file":"'"$f"'"}')" 1)
  [[ "$o" == *'"code":"unsupportedFile"'* && "$o" == *"$txt"* ]] && ok "4 not a WCZ file ($M, $(basename "$f")): $txt" || bad "4 not a WCZ file ($M, $(basename "$f")): ${o:0:200}"; done
# 5
dt() { printf '%s\n' '{"id":1,"cmd":"stats"}' | "$@" "$H" 3>&1 1>/dev/null 2>/dev/null | grep '"id":1' | grep -o '"directThreads":[0-9]*' | cut -d: -f2; }
if [ $M = off ]; then g=$(dt env); [ -z "$g" ] && ok "5 thread default (off): no directThreads" || bad "5 thread default (off): directThreads=$g"
elif ! command -v taskset > /dev/null; then echo "SKIP 5 thread default: no taskset"
else
  g=$(dt taskset -c 0); [ "$g" = 1 ] && ok "5 thread default: taskset -c 0 -> 1" || bad "5 thread default: taskset -c 0 -> ${g:-none}, want 1"
  if [ "$(nproc)" -ge 2 ]; then g=$(dt taskset -c 0-1); [ "$g" = 2 ] && ok "5 thread default: taskset -c 0-1 -> 2" || bad "5 thread default: taskset -c 0-1 -> ${g:-none}, want 2"; fi
  g=$(dt env WISP_VERIFY_THREADS=3 taskset -c 0); [ "$g" = 3 ] && ok "5 thread default: WISP_VERIFY_THREADS=3 overrides" || bad "5 thread default: override -> ${g:-none}, want 3"
fi
# 6
if [ -z "$V2W" ] || [ ! -x "$V2W" ]; then echo "SKIP 6 block read-ahead: no wcz-from-vcd given"
else
  { printf '$timescale 1ns $end\n$scope module top $end\n$var wire 64 ! d $end\n$var wire 1 " c $end\n$upscope $end\n$enddefinitions $end\n#0\nb0 !\n0"\n'
    awk 'BEGIN{srand(3); for(i=1;i<=40000;i++){printf "#%d\nb", i*10; for(k=0;k<64;k++) printf "%d", int(rand()*2); printf " !\n%d\"\n", i%2}}'; } > "$T/ra.vcd"
  if ! "$V2W" "$T/ra.vcd" "$T/ra.wcz" > "$T/ra.log" 2>&1; then bad "6 block read-ahead: fixture conversion failed: $(tail -1 "$T/ra.log")"
  else
    # signal 1 (64 bits): multi-page blocks, each advised once; signal 2 (1 bit): blocks under 2 pages, never advised
    win='{"id":2,"cmd":"window","signals":[{"signalId":1}],"t0":0,"t1":400000,"buckets":64}'
    st() { printf '%s\n' "$1" | grep -a '"id":'"$2"'[,}]' | grep -ao '"blockRead[A-Za-z]*":[0-9]*' | cut -d: -f2 | tr '\n' ' '; }
    r=$(ask '{"id":1,"cmd":"open","file":"'"$T/ra.wcz"'"}' "$win" '{"id":3,"cmd":"stats"}' "${win/\"id\":2/\"id\":4}" '{"id":5,"cmd":"stats"}' \
            '{"id":6,"cmd":"window","signals":[{"signalId":2}],"t0":0,"t1":400000,"buckets":64}' '{"id":7,"cmd":"stats"}' | tr -d '\000')  # (window replies carry binary data)
    read -r n1 a1 <<< "$(st "$r" 3)"; read -r n2 a2 <<< "$(st "$r" 5)"; read -r n3 a3 <<< "$(st "$r" 7)"
    if [ -n "$n1" ] && [ "$n1" -gt 0 ] && [ "$a1" = "$n1" ] && [ "$n2" = "$n1" ] && [ "$a2" = "$a1" ]; then ok "6 block read-ahead: $n1 block reads, $a1 advised; the repeat window is served from the cache (no new read or advice)"
    else bad "6 block read-ahead: reads/advised after window $n1/$a1, after repeat $n2/$a2"; fi
    if [ -n "$n3" ] && [ "$n3" -gt "$n2" ] && [ "$a3" = "$a2" ]; then ok "6 block read-ahead: blocks under 2 pages are read without advice ($((n3-n2)) reads)"
    else bad "6 block read-ahead: small blocks: reads/advised $n2/$a2 -> $n3/$a3"; fi
    r=$(printf '%s\n' '{"id":1,"cmd":"open","file":"'"$T/ra.wcz"'"}' "$win" '{"id":3,"cmd":"stats"}' | WISP_BLOCK_READAHEAD=0 "$H" 3>&1 1>/dev/null 2>/dev/null | tr -d '\000')
    read -r n1 a1 <<< "$(st "$r" 3)"
    [ -n "$n1" ] && [ "$n1" -gt 0 ] && [ "$a1" = 0 ] && ok "6 block read-ahead: WISP_BLOCK_READAHEAD=0 -> $n1 reads, 0 advised" || bad "6 block read-ahead off: reads/advised $n1/$a1"
    # 7 footer prefetch mode: default sync (advice inside open, no deferred thread); WISP_FOOTER_PREFETCH=defer: the
    # same advice from the helper's thread after open (footerRangesDeferred > 0 by the time a window has been answered);
    # =0: off. The window's answer is the same in every mode.
    fp() { printf '%s\n' "$1" | grep -a '"id":3[,}]' | grep -ao '"footerPrefetch":"[a-z]*","footerRangesDeferred":-\?[0-9]*' | sed 's/"footerPrefetch":"\([a-z]*\)","footerRangesDeferred":/\1 /'; }
    wa() { printf '%s\n' "$1" | grep -a '"id":2[,}]' | sed 's/"ms":[0-9.]*//; s/"walkMs":[0-9.]*//' | md5sum | cut -c1-12; }  # (timings removed; the line carries the binary answer)
    for m in sync defer 0; do e=(); [ $m != sync ] && e=(WISP_FOOTER_PREFETCH=$m)
      r=$(printf '%s\n' '{"id":1,"cmd":"open","file":"'"$T/ra.wcz"'"}' "$win" '{"id":3,"cmd":"stats"}' | env ${e[@]+"${e[@]}"} "$H" 3>&1 1>/dev/null 2>/dev/null | tr -d '\000')
      read -r md nr <<< "$(fp "$r")"; h=$(wa "$r"); eval "h_$m=\$h"
      case $m in sync) want="sync"; okr=$([ "$nr" = -1 ] && echo y);; defer) want="defer"; okr=$([ -n "$nr" ] && [ "$nr" -gt 0 ] && echo y);; 0) want="off"; okr=$([ "$nr" = -1 ] && echo y);; esac
      if [ "$md" = "$want" ] && [ "$okr" = y ]; then ok "7 footer prefetch WISP_FOOTER_PREFETCH=${m}: mode $md, deferred ranges $nr"; else bad "7 footer prefetch $m: mode '$md' deferred '$nr'"; fi
    done
    # defer with the thread held 500 ms (WISP_TEST_FOOTER_DELAY_MS): stats still reports the thread's count, not -1
    r=$(printf '%s\n' '{"id":1,"cmd":"open","file":"'"$T/ra.wcz"'"}' "$win" '{"id":3,"cmd":"stats"}' | env WISP_FOOTER_PREFETCH=defer WISP_TEST_FOOTER_DELAY_MS=500 "$H" 3>&1 1>/dev/null 2>/dev/null | tr -d '\000')
    read -r md nr <<< "$(fp "$r")"
    if [ "$md" = defer ] && [ -n "$nr" ] && [ "$nr" -gt 0 ]; then ok "7 footer prefetch defer, thread held 500 ms: stats waits for it, deferred ranges $nr"; else bad "7 footer prefetch defer, thread held 500 ms: mode '$md' deferred '$nr'"; fi
    [ -n "$h_sync" ] && [ "$h_sync" = "$h_defer" ] && [ "$h_sync" = "$h_0" ] && ok "7 footer prefetch: the window answer is the same in all three modes" || bad "7 footer prefetch: answers differ ($h_sync / $h_defer / $h_0)"
    # 7b footer reads: by pread from the file by default (stats footerRead pread); WISP_FOOTER_FD=0: through the mapping
    # (footerRead map). The window's answer is the same in both.
    for m in d 0; do e=(); [ $m = 0 ] && e=(WISP_FOOTER_FD=0)
      r=$(printf '%s\n' '{"id":1,"cmd":"open","file":"'"$T/ra.wcz"'"}' "$win" '{"id":3,"cmd":"stats"}' | env ${e[@]+"${e[@]}"} "$H" 3>&1 1>/dev/null 2>/dev/null | tr -d '\000')
      fr=$(printf '%s\n' "$r" | grep -a '"id":3[,}]' | grep -ao '"footerRead":"[a-z]*"' | cut -d'"' -f4); h=$(wa "$r"); eval "f_$m=\$h"
      want=pread; [ $m = 0 ] && want=map
      [ "$fr" = "$want" ] && ok "7b footer reads ${e[*]:-default}: $fr" || bad "7b footer reads ${e[*]:-default}: '$fr', want $want"
    done
    [ -n "$f_d" ] && [ "$f_d" = "$f_0" ] && [ "$f_d" = "$h_sync" ] && ok "7b footer reads: the window answer is the same by pread and by the mapping" || bad "7b footer reads: answers differ ($f_d / $f_0 / $h_sync)"
  fi
fi
# 8
cp "$W" "$T/c8.wcz"; c8=$(( $(od -An -tu1 -j336 -N1 "$W") ^ 8 )); printf "\\$(printf %03o $c8)" | dd of="$T/c8.wcz" bs=1 seek=336 conv=notrunc status=none
r=$(ask '{"id":1,"cmd":"open","file":"'"$T/c8.wcz"'"}' '{"id":2,"cmd":"window","signals":[1],"t0":0,"t1":20,"buckets":10}' \
        '{"id":3,"cmd":"valueAt","signalIds":[1],"t":5,"prev":false}' '{"id":4,"cmd":"valueAt","signalIds":[1],"t":5,"prev":true}' | tr -d '\000')
if [[ "$(line "$r" 1)" != *'"result"'* || "$(line "$r" 2)" != *'"signalId":1,"error":'* ]]; then bad "8 valueAt errors: the fixture no longer opens with a per-signal window error: $(line "$r" 2 | cut -c1-160)"
else for i in 3 4; do v=$(line "$r" $i)
  [[ "$v" == *'"values":[null]'* && "$v" == *'"errors":["'* ]] && ok "8 valueAt errors (request $i): null value with errors[0] = $(printf '%s' "$v" | grep -o '"errors":\["[^"]*' | cut -c12-70)" || bad "8 valueAt errors (request $i): ${v:0:200}"; done; fi
# 9
if [ -z "$V2W" ] || [ ! -x "$V2W" ]; then echo "SKIP 9 text rows valueAt prev: no wcz-from-vcd given"
else
  printf '$timescale 1ns $end\n$scope module top $end\n$var real 64 ! r $end\n$var wire 1 # c $end\n$upscope $end\n$enddefinitions $end\n#0\nr1.5 !\n0#\n#10\nr2.25 !\n1#\n#20\n0#\n' > "$T/tx.vcd"
  if ! "$V2W" "$T/tx.vcd" "$T/tx.wcz" > "$T/tx.log" 2>&1; then bad "9 text rows: fixture conversion failed: $(tail -1 "$T/tx.log")"
  else
    r=$(ask '{"id":1,"cmd":"open","file":"'"$T/tx.wcz"'"}' '{"id":2,"cmd":"valueAt","signalIds":[1,2],"t":15,"prev":true}' '{"id":3,"cmd":"valueAt","signalIds":[1,2],"t":15,"prev":false}' \
            '{"id":4,"cmd":"window","signals":[1],"t0":0,"t1":20,"buckets":4}' '{"id":5,"cmd":"valueAt","signalIds":[1,2],"t":15,"prev":true}' | tr -d '\000')
    c=$(printf '%s\n' "$r" | grep -a '"id":5[,}]' | grep -ao '{"id":5[,}].*')  # (the window's binary data runs into this line)
    a=$(line "$r" 2); b=$(line "$r" 3); va=$(printf '%s' "$a" | grep -o '"values":\[[^]]*\]'); vb=$(printf '%s' "$b" | grep -o '"values":\[[^]]*\]')
    if [ -n "$vb" ] && [ "$va" = "$vb" ] && [[ "$vb" != *null* ]] && [[ "$a" == *'"prev":[{"t":10,"value":"2.25"}'* ]] && [[ "$c" == *'"prev":[{"t":10,"value":"2.25"}'* ]]; then ok "9 text rows valueAt prev: $va, prev of the real = {t 10, 2.25} before and after a window holds the row"
    else bad "9 text rows valueAt prev: prev on ${a:0:220} | prev off ${b:0:160} | after a window ${c:0:200}"; fi
  fi
fi
# 10
if [ $M = off ]; then echo "SKIP 10 port-link switches: no direct FSDB read in this build"
else
  n=0; for kv in WISP_PORT_LINKS=2 WISP_FULL_SCOPE=yes; do
    o=$(line "$(env "$kv" bash -c 'printf "%s\n" "$1" | "$2" 3>&1 1>/dev/null 2>/dev/null' _ '{"id":1,"cmd":"open","file":"'"$T/g1.bin"'"}' "$H")" 1)
    [[ "$o" == *'"code":"fileRefused"'* && "$o" == *"${kv%%=*} must be 0 or 1"* ]] && n=$((n+1)) || echo "  10 $kv: ${o:0:200}"
  done
  o=$(line "$(WISP_FORCE_LOG="$T/none.log" ask '{"id":1,"cmd":"open","file":"'"$T/g1.bin"'"}')" 1)
  [[ "$o" == *'"code":"fileRefused"'* && "$o" == *"WISP_FORCE_LOG not readable: $T/none.log"* ]] && n=$((n+1)) || echo "  10 force log: ${o:0:200}"
  o=$(line "$(WISP_PORT_LINKS=2 ask '{"id":1,"cmd":"open","file":"'"$W"'"}')" 1)
  [[ "$o" == *'"result"'* ]] && n=$((n+1)) || echo "  10 WCZ open with a bad switch: ${o:0:200}"
  [ $n = 4 ] && ok "10 port-link switches: bad values refuse an FSDB open with the converter's wording; WCZ ignores them" || bad "10 port-link switches: $n of 4"
fi
# 11
cp "$W" "$T/c11.wcz.FAILED"; printf 'name\tdifference\n' > "$T/c11.wcz.FAILED.diff.tsv"; ln -s "$T/c11.wcz.FAILED" "$T/c11-link.wcz"
q='{"id":2,"cmd":"children","scopeOffsetIdx":0,"scopePath":"top"}'
o=$(line "$(ask '{"id":1,"cmd":"open","file":"'"$T/c11.wcz.FAILED"'"}')" 1); l=$(line "$(ask '{"id":1,"cmd":"open","file":"'"$T/c11-link.wcz"'"}')" 1)
[[ "$o" == *'"code":"failedFile"'* && "$o" == *"$T/c11.wcz.FAILED.diff.tsv"* && "$l" == *'"code":"failedFile"'* && "$l" == *"c11.wcz.FAILED.diff.tsv"* ]] && ok "11 failed name: refused (failedFile, names the report), also through a link" || bad "11 failed name: ${o:0:200} | link ${l:0:160}"
f=$(ask '{"id":1,"cmd":"open","file":"'"$T/c11.wcz.FAILED"'","force":true}' "$q"); g=$(ask '{"id":1,"cmd":"open","file":"'"$W"'"}' "$q")
[[ "$(line "$f" 1)" == *'"selfCheckFailed":true'* && "$(line "$g" 1)" != *'"selfCheckFailed"'* ]] && ok "11 failed name: opens with force and says selfCheckFailed:true (a good name does not)" || bad "11 failed name with force: $(line "$f" 1 | cut -c1-200)"
[ -n "$(line "$g" 2)" ] && [ "$(line "$f" 2 | sed 's/"ms":[0-9.e-]*//')" = "$(line "$g" 2 | sed 's/"ms":[0-9.e-]*//')" ] && ok "11 failed name: with force, children answer as the vector" || bad "11 failed name: answers differ: $(line "$f" 2 | cut -c1-160) / $(line "$g" 2 | cut -c1-160)"
# 12
kc() {  # kc FILE: the known-id check on FILE; prints "<known> <differing>" from stderr, then compares valueAt per id
  local f=$1 n i q=() a b e
  n=$(line "$(ask '{"id":1,"cmd":"open","file":"'"$f"'"}')" 1 | grep -o '"netlistIdCount":[0-9]*' | cut -d: -f2)
  [ -n "$n" ] || { echo "open failed"; return; }
  q=('{"id":1,"cmd":"open","file":"'"$f"'"}'); for i in $(seq 0 $((n + 1))); do q+=('{"id":'$((i + 2))',"cmd":"valueAt","signalIds":['$i'],"t":0,"prev":false}'); done
  printf '%s\n' "${q[@]}" | WISP_KNOWN_CHECK=1 "$H" 3>/dev/null 1>/dev/null 2>"$T/kc.err"
  e=$(grep -o 'known ids: [0-9]* of [0-9]*, native vs walk differ at [0-9]*' "$T/kc.err" | sed 's/known ids: \([0-9]*\) of [0-9]*, native vs walk differ at \([0-9]*\)/\1 \2/')
  a=$(printf '%s\n' "${q[@]}" | "$H" 3>&1 1>/dev/null 2>/dev/null | grep -v '"id":[01][,}]' | sed 's/"ms":[0-9.e-]*//' | md5sum | cut -c1-12)
  b=$(printf '%s\n' "${q[@]}" | WISP_KNOWN_WALK=1 "$H" 3>&1 1>/dev/null 2>/dev/null | grep -v '"id":[01][,}]' | sed 's/"ms":[0-9.e-]*//' | md5sum | cut -c1-12)
  echo "${e:-none none} $n $([ "$a" = "$b" ] && echo same || echo differ)"; }
read -r k d n s <<< "$(kc "$W")"
[ "$d" = 0 ] && [ "$k" != none ] && [ "$k" -gt 0 ] && [ "$s" = same ] && ok "12 known-id table (vector): $k known, 0 differing; valueAt ids 0..$((n + 1)) same with the walk" || bad "12 known-id table (vector): known '$k' differing '$d' answers '$s'"
if [ -z "$V2W" ] || [ ! -x "$V2W" ]; then echo "SKIP 12 known-id table (nested scopes): no wcz-from-vcd given"
else
  printf '$timescale 1ns $end\n$scope module top $end\n$var wire 1 ! t0 $end\n$scope module a $end\n$var wire 1 " a0 $end\n$var wire 4 # a1 $end\n$scope module b $end\n$var wire 1 $ b0 $end\n$scope module c $end\n$var wire 1 %% c0 $end\n$var wire 1 ! c1 $end\n$upscope $end\n$upscope $end\n$upscope $end\n$scope module d $end\n$var wire 1 & d0 $end\n$upscope $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n1"\nb0101 #\n0$\n1%%\n0&\n#10\n1!\n0%%\n' > "$T/kc.vcd"
  if ! "$V2W" "$T/kc.vcd" "$T/kc.wcz" > "$T/kc.log" 2>&1; then bad "12 known-id table: fixture conversion failed: $(tail -1 "$T/kc.log")"
  else
    read -r k d n s <<< "$(kc "$T/kc.wcz")"
    [ "$d" = 0 ] && [ "$k" = 6 ] && [ "$s" = same ] && ok "12 known-id table (nested scopes): 6 of 6 signals known, 0 differing; valueAt ids 0..$((n + 1)) same with the walk" || bad "12 known-id table (nested scopes): known '$k' (want 6) differing '$d' answers '$s'"
  fi
fi
# 13
if [ $M = off ]; then echo "SKIP 13 check start setting: no direct FSDB read in this build"
else
  n=0; for v in later idle: idle:x idle:-1 idle:90000 "idle:5 "; do
    o=$(line "$(WISP_VERIFY_START="$v" ask '{"id":1,"cmd":"open","file":"'"$T/g1.bin"'"}')" 1)
    [[ "$o" == *'"code":"fileRefused"'* && "$o" == *"WISP_VERIFY_START must be open, idle:<seconds>"* ]] && n=$((n+1)) || echo "  13 bad '$v': ${o:0:200}"
  done
  for v in open idle:0 idle:2.5 request off; do
    o=$(line "$(WISP_VERIFY_START="$v" ask '{"id":1,"cmd":"open","file":"'"$T/g1.bin"'"}')" 1)
    [[ "$o" == *'"code":"fileRefused"'* && "$o" != *"WISP_VERIFY_START"* ]] && n=$((n+1)) || echo "  13 good '$v': ${o:0:200}"
  done
  o=$(line "$(WISP_VERIFY_START=later ask '{"id":1,"cmd":"open","file":"'"$W"'"}')" 1)
  [[ "$o" == *'"result"'* ]] && n=$((n+1)) || echo "  13 WCZ open with a bad setting: ${o:0:200}"
  [ $n = 12 ] && ok "13 check start setting: 6 bad values refuse an FSDB open by the setting, 5 good values pass it, WCZ ignores it" || bad "13 check start setting: $n of 12"
fi
# 14
if [ -z "$V2W" ] || [ ! -x "$V2W" ]; then echo "SKIP 14 reserved scopes: no wcz-from-vcd given"
else
  printf '$timescale 1ns $end\n$scope module top $end\n$var wire 1 ! t0 $end\n$scope begin $unm_blk_1 $end\n$var reg 1 " u $end\n$upscope $end\n$scope begin $ivl_for_loop0 $end\n$var integer 32 # i $end\n$upscope $end\n$upscope $end\n$scope module $object_root $end\n$var wire 1 $ o $end\n$scope module $hidden_class $end\n$var wire 1 %% h $end\n$upscope $end\n$upscope $end\n$scope module $unreferenced_value_ids $end\n$var wire 1 & r $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n1"\nb101 #\n0$\n0%%\n0&\n#10\n1!\n0"\n' > "$T/rs.vcd"
  if ! "$V2W" "$T/rs.vcd" "$T/rs.wcz" > "$T/rs.log" 2>&1; then bad "14 reserved scopes: fixture conversion failed: $(tail -1 "$T/rs.log")"
  else
    r=$(ask '{"id":1,"cmd":"open","file":"'"$T/rs.wcz"'"}' '{"id":2,"cmd":"children","scopeOffsetIdx":0,"scopePath":"top"}')
    tops=$(line "$r" 1 | grep -o '"top":\[[^]]*\]' | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | sort | paste -sd,)
    kids=$(line "$r" 2 | grep -o '"scopes":\[[^]]*\]' | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | sort | paste -sd,)
    read -r k d n s <<< "$(kc "$T/rs.wcz")"
    # the ids of u (in $unm_blk_1) and o (under $object_root), from the children replies of their scopes
    sid() { local sc=$1 v=$2; local q; q=$(ask '{"id":1,"cmd":"open","file":"'"$T/rs.wcz"'"}' '{"id":2,"cmd":"children","scopeOffsetIdx":0,"scopePath":"top"}' | grep '"id":2[,}]')
      local ix; ix=$(printf '%s' "$q" | grep -o '{"name":"'"$sc"'"[^}]*}' | grep -o '"scopeOffsetIdx":[0-9]*' | cut -d: -f2)
      ask '{"id":1,"cmd":"open","file":"'"$T/rs.wcz"'"}' '{"id":3,"cmd":"children","scopeOffsetIdx":'"${ix:-0}"',"scopePath":"top.'"$sc"'"}' | grep '"id":3[,}]' | grep -o '"name":"'"$v"'"[^}]*"signalId":[0-9]*' | grep -o '[0-9]*$'; }
    u=$(sid '$unm_blk_1' u)
    va=$(line "$(ask '{"id":1,"cmd":"open","file":"'"$T/rs.wcz"'"}' '{"id":2,"cmd":"valueAt","signalIds":['"${u:-0}"'],"t":0,"prev":false}')" 2)
    vo=$(line "$(ask '{"id":1,"cmd":"open","file":"'"$T/rs.wcz"'"}' '{"id":2,"cmd":"valueAt","signalIds":[4],"t":0,"prev":false}')" 2)
    [ "$tops" = top ] && [ "$kids" = '$ivl_for_loop0,$unm_blk_1' ] && [ "$k" = 3 ] && [ "$d" = 0 ] && [ "$s" = same ] && [ -n "$u" ] && [[ "$va" == *'"values":["1"]'* ]] && [[ "$vo" == *'unknown signal'* ]] \
      && ok "14 reserved scopes: top level [$tops], top's children [$kids], 3 known (native == walk), u (#$u) in \$unm_blk_1 answers, #4 under \$object_root unknown" \
      || bad "14 reserved scopes: top [$tops] children [$kids] known '$k' differ '$d' answers '$s' u '${u:-none}' valueAt ${va:0:120} | #4 ${vo:0:120}"
  fi
fi
echo "check-helper ($M): $pass pass, $fails fail"; [ $fails = 0 ]
