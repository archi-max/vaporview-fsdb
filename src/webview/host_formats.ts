// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: the viewer's own value formatters (RISC-V disassembler, alias tables, ASCII), for searchText in
// the extension host (src/cmux/wisp/text_search.ts). esbuild.js bundles this file alone as dist/host_formats.js (CJS,
// node), which the extension loads at run time, so the extension's type check never pulls in the page. The same set as cmux's helper-v2 formats.js / scripts/waveform-viewer-checks/text/
// formats-entry.ts: nothing here is rewritten. value_format.ts imports the page (vaporview.ts, signal_item.ts,
// extra_formats.ts) for paths these formatters never reach; esbuild.js stubs those imports in that bundle.
// Source credit: VaporView (GPL-3.0, https://github.com/Lramseyer/vaporview) and the cmux fork's additions.
import { formatRiscvBinaryString } from './riscv_disasm';
import { parseAliasFile, formatWithTable } from './value_alias';
import { formatAscii, valueIs9State } from './value_format';

export const riscvOptions: Record<string, {abiNames: boolean; aliases: boolean}> = {
  riscv: {abiNames: true, aliases: true},
  riscv_numeric: {abiNames: false, aliases: true},
  riscv_noalias: {abiNames: true, aliases: false},
  riscv_numeric_noalias: {abiNames: false, aliases: false},
};
export { formatRiscvBinaryString, parseAliasFile, formatWithTable, formatAscii, valueIs9State };
