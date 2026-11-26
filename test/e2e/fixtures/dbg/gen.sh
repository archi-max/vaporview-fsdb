#!/bin/sh
# Regenerates dbg.vcd from dbg_top.sv with Icarus Verilog (iverilog -g2012). The $date line is dropped so the file is stable.
set -e
cd "$(dirname "$0")"
iverilog -g2012 -o /tmp/dbg_top.vvp dbg_top.sv
vvp -n /tmp/dbg_top.vvp >/dev/null
sed -i.bak '/^\$date/,/^\$end/d' dbg.vcd && rm -f dbg.vcd.bak /tmp/dbg_top.vvp
# dbg_partial.vcd ("no value" e2e): dbg.vcd without dbg_top.u1.cnt (an always_ff register: not computable
# from a connection; u1.next / u1.wrap depend on it). VCS twin: the same sim with $fsdbSuppress(dbg_top.u1.cnt).
awk '$0=="$var reg 8 0 cnt [7:0] $end"{next} /^b[01xzXZ]+ 0$/{next} {print}' dbg.vcd > dbg_partial.vcd
# dbg_partial2.vcd : also without dbg_top.c1, u1.cnt's port wire (VCS keeps u1.cnt through c1 when only
# u1.cnt is suppressed). VCS twin: $fsdbSuppress(dbg_top.u1.cnt) + $fsdbSuppress(dbg_top.c1).
awk '$0=="$var reg 8 0 cnt [7:0] $end"||$0=="$var wire 8 $ c1 [7:0] $end"{next} /^b[01xzXZ]+ [0$]$/{next} {print}' dbg.vcd > dbg_partial2.vcd
