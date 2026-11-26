#!/bin/sh
# Regenerates nc.vcd from nc_top.sv with Icarus Verilog (iverilog -g2012; it does not dump the 2-state quiet / never).
# The FSDB / WCZ twins come from VCS: quiet and never are in the dump with no value change at all.
set -e
cd "$(dirname "$0")"
iverilog -g2012 -o /tmp/nc_top.vvp nc_top.sv
vvp -n /tmp/nc_top.vvp >/dev/null
sed -i.bak '/^\$date/,/^\$end/d' nc.vcd && rm -f nc.vcd.bak /tmp/nc_top.vvp
# nc_late.vcd: the same sim with the dump started at 30 ns, so no signal has a record before 30 ("no change
# recorded" at t < 30). VCS twin: #30 $fsdbDumpvars(0, nc_top).
sed -e 's/"nc.vcd"/"nc_late.vcd"/' -e 's/^    \$dumpvars(0, nc_top);/    #30 $dumpvars(0, nc_top);/' nc_top.sv > /tmp/nc_late.sv
iverilog -g2012 -o /tmp/nc_late.vvp /tmp/nc_late.sv
vvp -n /tmp/nc_late.vvp >/dev/null
sed -i.bak '/^\$date/,/^\$end/d' nc_late.vcd && rm -f nc_late.vcd.bak /tmp/nc_late.vvp /tmp/nc_late.sv
