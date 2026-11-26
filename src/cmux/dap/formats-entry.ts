// vscode-port P4: the viewer's own value formatters for text breakpoints in the extension host (dist/cmux-formats.js),
// bundled from src/webview by esbuild.js with the same stubs as cmux's scripts/waveform-viewer-checks/text/build-formats.mjs.
// VaporView is GPL-3.0 (https://github.com/Lramseyer/vaporview); the RISC-V disassembler and alias tables are the cmux
// fork's additions. Not type-checked by tsc (the webview sources need the DOM lib); built only by esbuild.
import { formatRiscvBinaryString } from "../../webview/riscv_disasm";
import { parseAliasFile, formatWithTable } from "../../webview/value_alias";
import { valueFormatList, formatAscii, valueIs9State } from "../../webview/value_format";

const byId = (id: string) => {
  const f = valueFormatList.find((x) => x.id === id);
  if (!f) {throw new Error("no format " + id);}
  return f;
};
export const riscvOptions = {
  riscv: { abiNames: true, aliases: true },
  riscv_numeric: { abiNames: false, aliases: true },
  riscv_noalias: { abiNames: true, aliases: false },
  riscv_numeric_noalias: { abiNames: false, aliases: false },
};
export { formatRiscvBinaryString, parseAliasFile, formatWithTable, formatAscii, valueIs9State };
export const formatHexString = byId("hexadecimal").formatString;
export const formatOctString = byId("octal").formatString;
export const formatBinString = byId("binary").formatString;
export const formatDecString = byId("decimal").formatString;
export const formatSdecString = byId("signed").formatString;

// cmux-textmatch.js (the text breakpoints' match rule) reads globalThis.cmuxFormats when it loads.
declare const require: (p: string) => unknown;
(globalThis as any).cmuxFormats = { riscvOptions, formatRiscvBinaryString, parseAliasFile, formatWithTable, formatAscii, valueIs9State,
  formatHexString, formatOctString, formatBinString, formatDecString, formatSdecString };
require('./vendor/cmux-textmatch.js');
export const textMatch = (globalThis as any).cmuxTextMatch;
