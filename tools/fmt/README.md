# FSDB / WCZ twins of the test fixtures 

The e2e and visual suites open FSDB (default) or WCZ copies of the repo's VCD fixtures: `E2E_FORMAT=fsdb|wcz|vcd`,
twins under `E2E_FIXTURES_FMT_DIR/<format>/<relative path of the VCD>` with the extension swapped
(test/e2e/suite/helpers.cjs). FSDB files are never committed; the twin directory lives on the test machine.

Producing them (list.txt = every `test/e2e/fixtures/**/*.vcd`, `test/trace/dumps/*.vcd`, plus `xr1m.icarus.vcd`:
`iverilog -g2012 -DCYCLES=1000000 test/trace/designs/tb_xr.sv test/trace/designs/xr_run.sv`):
1. FSDB: `vcd2fsdb <rel>.vcd -o fsdb/<rel>.fsdb` (Verdi), one file at a time.
2. WCZ: `wcz-from-fsdb fsdb/<rel>.fsdb wcz/<rel>.wcz` (a WCZ converter).
3. Content check: `node tools/fmt/content-check.cjs <wisp-helper> vcd <fsdb|wcz> <fsdb|wcz> list.txt out.jsonl`
   (with `WISP_DIRECT_OPEN=full`): every VCD variable's full change history against the twin's whole-dump window,
   times in fs. Every difference is listed (missing / extra names, widths, values, open errors); exit 1 on any.

`tools/linux-test.sh fmt [FILTER]` runs the suite with fsdb, then wcz, and prints a SUMMARY per format.
