#!/bin/bash
# SPDX-License-Identifier: MIT
# direct-inputs.sh <wisp-helper> <good.fsdb> [refused.fsdb...]: direct FSDB read checks that need FSDB files (none ship
# with the tree). Needs a helper built with direct FSDB read on.
#   good: it opens and answers a count; the open-scan / check thread default (directThreads) follows the CPUs the process may run on
#         (taskset -c 0..K-1 -> directThreads = K, capped at 16; WISP_VERIFY_THREADS overrides). Skipped without taskset.
#   good, lazy == scan: valueAt over every signal at the start and the end, and count, give the same reply with the
#         default lazy open as with WISP_DIRECT_OPEN=scan (the whole-file check before values); verify passes.
#   good, memory bound: with a bound below the RSS (WISP_WORKER_RSS_MB=1, WISP_RSS_HEADROOM_MB=-100000), a valueAt
#         while the background check still runs (WISP_TEST_VERIFY_DELAY_MS) is answered (the check's memory is the
#         open's), and after verify the same valueAt is refused with "worker memory limit" (the bound is back).
#   good, bound state (stats memoryBound: the hard bound the helper last gave the library, and whether it is held off):
#         while the check runs, after a window (the LOD path re-sets the bound around its call), hardMB is 0 and heldOff
#         true; after verify, a count (not a loading command) is enough for hardMB > 0 and heldOff false.
#   check start (WISP_VERIFY_START): open (default) starts the check at open; request and off do not start it (not at
#         open, not after 2 s idle), a value before it is unverified, verify checks as many signals as the default and
#         values after it are verified; idle:1: a value before the check is unverified, the check starts after 1 s
#         without a request (stats idleChecks 1), verify passes over every signal and a value after it is verified;
#         idle:3 with a request every second stays deferred; on a refused file (lazy open), request mode: verify
#         refuses the file and a later value is refused.
#   refused (files the converter refuses as a whole): the open is refused with code fileRefused; or the open succeeds
#         (lazy) and verify is refused with fileRefused, and no requested signal of signals 1-8 is a bare null: every
#         null valueAt entry has its reason in errors[] and every count entry without a count has an error.
# Exit 0 = all PASS.
set -u
H=${1:?usage: direct-inputs.sh <wisp-helper> <good.fsdb> [refused.fsdb...]}; G=${2:?good.fsdb}; shift 2; fails=0
ask() { printf '%s\n' "$@" | "$H" 3>&1 1>/dev/null 2>/dev/null; }
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
r=$(ask '{"id":1,"cmd":"open","file":"'"$G"'"}' '{"id":2,"cmd":"count","signalIds":[1]}')
case "$(printf '%s\n' "$r" | grep '"id":2')" in *'"result"'*) ok "good: opens and counts";; *) bad "good: $(printf '%s\n' "$r" | grep -m1 'error')";; esac
th() { printf '%s\n' '{"id":1,"cmd":"open","file":"'"$G"'"}' '{"id":2,"cmd":"stats"}' | "$@" "$H" 3>&1 1>/dev/null 2>/dev/null | grep -o '"directThreads":[0-9]*' | head -1 | cut -d: -f2; }
if command -v taskset > /dev/null; then
  n=$(nproc); for k in 1 2 4; do [ "$k" -le "$n" ] || continue; g=$(th taskset -c 0-$((k-1)))
    [ "$g" = "$k" ] && ok "threads: taskset -c 0-$((k-1)) -> $g" || bad "threads: taskset -c 0-$((k-1)) -> ${g:-none}, want $k"; done
  g=$(th env WISP_VERIFY_THREADS=3 taskset -c 0); [ "$g" = 3 ] && ok "threads: WISP_VERIFY_THREADS=3 overrides" || bad "threads: override -> ${g:-none}, want 3"
else echo "SKIP threads: no taskset"; fi
# good: lazy == scan, verify
n=$(printf '%s\n' '{"id":1,"cmd":"open","file":"'"$G"'"}' | "$H" 3>&1 1>/dev/null 2>/dev/null | grep -o '"netlistIdCount":[0-9]*' | cut -d: -f2)
te=$(printf '%s\n' '{"id":1,"cmd":"open","file":"'"$G"'"}' | "$H" 3>&1 1>/dev/null 2>/dev/null | grep -o '"timeEnd":[0-9.e+]*' | cut -d: -f2)
if [ -n "$n" ] && [ -n "$te" ]; then
  ids=$(seq -s, 1 "$n")
  q=('{"id":1,"cmd":"open","file":"'"$G"'"}' '{"id":2,"cmd":"valueAt","signalIds":['"$ids"'],"t":0,"prev":false}' \
     '{"id":3,"cmd":"valueAt","signalIds":['"$ids"'],"t":'"$te"',"prev":true}' '{"id":4,"cmd":"count","signalIds":['"$ids"']}')
  h() { printf '%s\n' "${q[@]}" | env "$@" "$H" 3>&1 1>/dev/null 2>/dev/null | grep -E '"id":[234][,}]' | sed 's/"ms":[0-9.e+-]*//g; s/"cold":[0-9]*//g' | md5sum | cut -c1-16; }
  a=$(h WISP_DIRECT_OPEN=lazy); b=$(h WISP_DIRECT_OPEN=scan)
  [ "$a" = "$b" ] && ok "good: lazy == scan over $n signals (valueAt start/end, count)" || bad "good: lazy $a != scan $b"
else bad "good: no signal count or end time in the open reply"; fi
r=$(ask '{"id":1,"cmd":"open","file":"'"$G"'"}' '{"id":2,"cmd":"verify"}')
case "$(printf '%s\n' "$r" | grep '"id":2')" in *'"ok":true'*) ok "good: verify passes";; *) bad "good: verify: $(printf '%s\n' "$r" | grep '"id":2' | cut -c1-160)";; esac
mb() { printf '%s\n' "$@" | env WISP_WORKER_RSS_MB=1 WISP_RSS_HEADROOM_MB=-100000 WISP_TEST_VERIFY_DELAY_MS=4000 "$H" 3>&1 1>/dev/null 2>/dev/null | grep '"id":2[,}]'; }
va='{"id":2,"cmd":"valueAt","signalIds":[1],"t":0,"prev":false}'
case "$(mb '{"id":1,"cmd":"open","file":"'"$G"'"}' "$va")" in *'"result"'*) ok "good: memory bound held off while the check runs";; *) bad "good: memory bound while the check runs: $(mb '{"id":1,"cmd":"open","file":"'"$G"'"}' "$va" | cut -c1-160)";; esac
case "$(mb '{"id":1,"cmd":"open","file":"'"$G"'"}' '{"id":3,"cmd":"verify"}' "$va")" in *'worker memory limit'*) ok "good: memory bound back after the check";; *) bad "good: memory bound after the check: $(mb '{"id":1,"cmd":"open","file":"'"$G"'"}' '{"id":3,"cmd":"verify"}' "$va" | cut -c1-160)";; esac
st() { printf '%s\n' "$@" | env WISP_TEST_VERIFY_DELAY_MS=${DLY:-0} "$H" 3>&1 1>/dev/null 2>/dev/null | grep -a '"id":9[,}]' | grep -ao '"memoryBound":{[^}]*}'; }
wq='{"id":2,"cmd":"window","signals":[{"signalId":1}],"t0":0,"t1":1000000,"buckets":64,"lod":true}'
x=$(DLY=4000 st '{"id":1,"cmd":"open","file":"'"$G"'"}' "$wq" '{"id":9,"cmd":"stats"}')
case "$x" in *'"hardMB":0,'*'"heldOff":true'*) ok "good: bound held off while the check runs, after a window: $x";; *) bad "good: bound while the check runs, after a window: ${x:-no memoryBound in stats}";; esac
x=$(st '{"id":1,"cmd":"open","file":"'"$G"'"}' '{"id":3,"cmd":"verify"}' '{"id":4,"cmd":"count","signalIds":[1]}' '{"id":9,"cmd":"stats"}')
case "$x" in *'"heldOff":false'*) case "$x" in *'"hardMB":0,'*) bad "good: bound after the check + count: $x";; *) ok "good: bound set again after the check, by a count: $x";; esac;; *) bad "good: bound after the check + count: ${x:-no memoryBound in stats}";; esac
# check start (WISP_VERIFY_START): sv <setting> <request lines; "sleep N" waits N s>: the replies of one session
sv() { local v=$1; shift; { for x in "$@"; do case "$x" in sleep\ *) sleep "${x#sleep }";; *) printf '%s\n' "$x";; esac; done; } | env WISP_VERIFY_START="$v" "$H" 3>&1 1>/dev/null 2>/dev/null | tr -d '\000'; }
fld() { printf '%s\n' "$1" | grep -a "\"id\":$2[,}]" | grep -ao "\"$3\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '"'; }
op='{"id":1,"cmd":"open","file":"'"$G"'"}'; vq='{"id":3,"cmd":"valueAt","signalIds":[1],"t":0,"prev":false}'
r=$(sv open "$op" '{"id":2,"cmd":"verify"}' '{"id":9,"cmd":"stats"}'); dn0=$(fld "$r" 9 checkDone)
r0=$(sv open "$op" '{"id":2,"cmd":"stats"}'); c0=$(fld "$r0" 2 check); m0=$(fld "$r0" 2 checkStart)
[ "$m0" = open ] && [ "$c0" != deferred ] && [ -n "$dn0" ] && ok "check start open (default): starts at open ($c0 at once), $dn0 signals checked after verify" || bad "check start open: checkStart ${m0:-?} check ${c0:-?} done ${dn0:-?}"
for v in request off; do
  r=$(sv $v "$op" '{"id":2,"cmd":"stats"}' "$vq" 'sleep 2' '{"id":4,"cmd":"stats"}' '{"id":5,"cmd":"verify"}' '{"id":6,"cmd":"stats"}' "${vq/\"id\":3/\"id\":7}")
  a=$(fld "$r" 2 check); b=$(fld "$r" 4 check); y=$(printf '%s\n' "$r" | grep -a '"id":5[,}]'); c=$(fld "$r" 6 check); dn=$(fld "$r" 6 checkDone)
  v3=$(fld "$r" 3 verified); v7=$(fld "$r" 7 verified); ms=$(fld "$r" 2 checkStart)
  [ "$ms" = request ] && [ "$a" = deferred ] && [ "$b" = deferred ] && [[ "$y" == *'"ok":true'* ]] && [ "$c" = ok ] && [ "$dn" = "$dn0" ] && [ "$v3" = false ] && [ "$v7" = true ] \
    && ok "check start $v: not started at open or after 2 s idle; a value before is unverified; verify checks all $dn signals (as the default), values after it verified" \
    || bad "check start $v: start ${ms:-?} at open ${a:-?}, after 2 s ${b:-?}, verify ${y:0:120}, after ${c:-?} done ${dn:-?} of ${dn0:-?}, verified ${v3:-?}/${v7:-?}"
done
r=$(sv idle:1 "$op" '{"id":2,"cmd":"stats"}' "$vq" 'sleep 3' '{"id":4,"cmd":"stats"}' '{"id":5,"cmd":"verify"}' '{"id":6,"cmd":"stats"}' "${vq/\"id\":3/\"id\":7}")
a=$(fld "$r" 2 check); b=$(fld "$r" 4 check); ic=$(fld "$r" 4 idleChecks); y=$(printf '%s\n' "$r" | grep -a '"id":5[,}]'); dn=$(fld "$r" 6 checkDone); ms=$(fld "$r" 2 checkStart)
v3=$(fld "$r" 3 verified); v7=$(fld "$r" 7 verified)
[ "$ms" = idle ] && [ "$a" = deferred ] && [ "$b" != deferred ] && [ "$ic" = 1 ] && [[ "$y" == *'"ok":true'* ]] && [ "$dn" = "$dn0" ] && [ "$v3" = false ] && [ "$v7" = true ] \
  && ok "check start idle:1: deferred at open (a value then unverified), started after 1 s without a request ($b, idleChecks 1); verify passes over all $dn signals, a value after it verified" \
  || bad "check start idle:1: start ${ms:-?} at open ${a:-?}, after 3 s ${b:-?} idleChecks ${ic:-?}, verify ${y:0:120}, done ${dn:-?} of ${dn0:-?}, verified ${v3:-?}/${v7:-?}"
r=$(sv idle:3 "$op" 'sleep 1' '{"id":2,"cmd":"stats"}' 'sleep 1' '{"id":3,"cmd":"stats"}' 'sleep 1' '{"id":4,"cmd":"stats"}' 'sleep 1' '{"id":5,"cmd":"stats"}')
b=$(fld "$r" 5 check); ic=$(fld "$r" 5 idleChecks)
[ "$b" = deferred ] && [ "$ic" = 0 ] && ok "check start idle:3: a request every second for 4 s keeps it deferred" || bad "check start idle:3 with requests every second: ${b:-?} idleChecks ${ic:-?}"
for f in "$@"; do
  r=$(sv request '{"id":1,"cmd":"open","file":"'"$f"'"}' '{"id":2,"cmd":"stats"}' '{"id":3,"cmd":"verify"}' '{"id":4,"cmd":"count","signalIds":[1]}')
  o=$(printf '%s\n' "$r" | grep -a '"id":1[,}]'); [[ "$o" != *'"result"'* ]] && continue   # (refused at open: checked below)
  y=$(printf '%s\n' "$r" | grep -a '"id":3[,}]'); z=$(printf '%s\n' "$r" | grep -a '"id":4[,}]')
  [ "$(fld "$r" 2 check)" = deferred ] && [[ "$y" == *'"code":"fileRefused"'* ]] && [[ "$z" == *'"code":"fileRefused"'* ]] \
    && ok "check start request, refused file: deferred, verify refuses the file, a later value is refused: $(basename "$f")" || bad "check start request on $(basename "$f"): ${y:0:120} | ${z:0:120}"
done
for f in "$@"; do
  r=$(ask '{"id":1,"cmd":"open","file":"'"$f"'"}' '{"id":2,"cmd":"count","signalIds":[1,2,3,4,5,6,7,8]}' '{"id":3,"cmd":"valueAt","signalIds":[1,2,3,4,5,6,7,8],"t":0,"prev":false}' '{"id":4,"cmd":"verify"}')
  o=$(printf '%s\n' "$r" | grep '"id":1'); c=$(printf '%s\n' "$r" | grep '"id":2'); v=$(printf '%s\n' "$r" | grep '"id":3'); y=$(printf '%s\n' "$r" | grep '"id":4')
  if [[ "$o" != *'"result"'* ]]; then [[ "$o" == *'"code":"fileRefused"'* ]] && ok "refused at open: $(basename "$f")" || bad "open of $(basename "$f"): $o"; continue; fi
  [[ "$y" == *'"code":"fileRefused"'* ]] && ok "verify refuses: $(basename "$f")" || bad "verify of $(basename "$f"): ${y:0:160}"
  # a bare null: values[i] null with no errors[i]; count entries: each has count or error (a request-level error is fine)
  if [[ "$v" == *'"result"'* ]]; then
    mapfile -t VA < <(printf '%s' "$v" | grep -o '"values":\[[^]]*\]' | grep -oE '"[^"]*"|null' | tail -n +2)
    mapfile -t EA < <(printf '%s' "$v" | grep -oE '"errors":\[("([^"\\]|\\.)*"|null|,)*\]' | grep -oE '"([^"\\]|\\.)*"|null' | tail -n +2)
    bare=0; for i in "${!VA[@]}"; do [ "${VA[$i]}" = null ] && [ "${EA[$i]:-null}" = null ] && bare=$((bare+1)); done
    [ $bare = 0 ] && ok "no bare null in valueAt: $(basename "$f")" || bad "$(basename "$f"): $bare valueAt nulls with no errors[]"
  fi
  if [[ "$c" == *'"result"'* ]]; then nb=$(printf '%s' "$c" | grep -o '{"signalId":[0-9]*[^}]*}' | grep -vc '"count":\|"error":')
    [ "$nb" = 0 ] && ok "every count entry has a count or a reason: $(basename "$f")" || bad "$(basename "$f"): $nb count entries with neither"; fi
done
echo "direct-inputs: $([ $fails = 0 ] && echo PASS || echo FAIL) ($fails fail)"; [ $fails = 0 ]
