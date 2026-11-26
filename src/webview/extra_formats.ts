// Extra value formats for the webview: RISC-V disassembly and user value aliases
// (Verdi .alias/.rc, JSON, CSV). Kept out of value_format.ts so the hooks into
// existing files are small: getExtraValueFormat() in getNumberFormatById(),
// handleExtraMessage() at the top of VscodeWrapper.handleMessage(), and the
// rawText escape in the value display.
//
// Hosts drive this with webview messages:
//   {command: 'setDisplayFormat', netlistId, numberFormat: 'riscv'}       (existing VaporView message)
//   {command: 'loadValueAliases', text, fileName, bareRadix?, apply?}
//   {command: 'applyAliasBindings'}
//   {command: 'clearValueAliases'}
// or synchronously through window.vaporviewValueFormats (see the bottom of this file).
// Format ids: riscv, riscv_numeric, riscv_noalias, riscv_numeric_noalias, alias:<table>.

import { StateChangeType } from "../common/types";
import { type ValueFormat } from "./value_format";
import { NetlistVariable, CustomVariable } from "./signal_item";
import { events, rowHandler, vscodeWrapper } from "./vaporview";
import { formatRiscvBinaryString, type RiscvDisasmOptions } from "./riscv_disasm";
import { parseAliasFile, formatWithTable, type ValueTable, type AliasBinding, type BareRadix } from "./value_alias";

function is9State(value: string): boolean {
  return /[uxzwlh-]/.test(value);
}

// Search runs once per value change, so compile the pattern once per search string.
// A string that is not a valid regex is matched as plain text.
let searchSource: string | undefined;
let searchRegex: RegExp | null = null;
let searchLower = "";
function matchFormatted(search: string, binaryString: string, formattedValue: string): boolean {
  if (search !== searchSource) {
    searchSource = search;
    searchLower = search.toLowerCase();
    try {
      searchRegex = new RegExp(search, "i");
    } catch {
      searchRegex = null;
    }
  }
  return searchRegex ? searchRegex.test(formattedValue) : formattedValue.toLowerCase().includes(searchLower);
}

// #region RISC-V
class RiscvValueFormat implements ValueFormat {
  public rightJustify = false;
  public symbolText = "asm";
  public rawText = true;
  constructor(public id: string, public label: string, private opts: RiscvDisasmOptions) {}
  public formatString = (binaryString: string, width: number, is2State: boolean) => {
    return formatRiscvBinaryString(binaryString, is2State, this.opts);
  };
  public checkValidSearch = (searchString: string) => searchString.length > 0;
  public parseSearchValue = (searchString: string) => searchString;
  public checkSearchValue = matchFormatted;
  public is9State = is9State;
  public checkWidth = (width: number) => width >= 16;
}

export const riscvFormats: RiscvValueFormat[] = [
  new RiscvValueFormat("riscv", "RISC-V", { abiNames: true, aliases: true }),
  new RiscvValueFormat("riscv_numeric", "RISC-V (x0-x31)", { abiNames: false, aliases: true }),
  new RiscvValueFormat("riscv_noalias", "RISC-V (no pseudo-instructions)", { abiNames: true, aliases: false }),
  new RiscvValueFormat("riscv_numeric_noalias", "RISC-V (x0-x31, no pseudo-instructions)", { abiNames: false, aliases: false }),
];

// #region Value aliases
const aliasTables = new Map<string, ValueTable>();
// The file each table was read from, for the FSDB helper's text search (searchText takes
// the alias file itself): one object per load, shared by the tables it defined.
interface AliasSource { text: string; fileName: string; bareRadix?: BareRadix }
const aliasSources = new Map<string, AliasSource>();
const aliasBindings = new Map<string, string>(); // signal path -> table name or format id
// Rows that already existed when bindings were last applied. Keyed by the row
// object, because rowIds are reused after the viewer empties (unload resets them).
const seenRows = new WeakSet<NetlistVariable>();
const ALIAS_PREFIX = "alias:";

class AliasValueFormat implements ValueFormat {
  public id: string;
  public rightJustify = false;
  public symbolText = "abc";
  public rawText = true;
  constructor(public tableName: string) {this.id = ALIAS_PREFIX + tableName;}
  // Reads the table at call time, so reloading a file updates every row using it.
  public formatString = (binaryString: string, width: number, is2State: boolean) => {
    return formatWithTable(aliasTables, this.tableName, binaryString);
  };
  public checkValidSearch = (searchString: string) => searchString.length > 0;
  public parseSearchValue = (searchString: string) => searchString;
  public checkSearchValue = matchFormatted;
  public is9State = is9State;
  public checkWidth = (width: number) => true;
}

// Fallback for getNumberFormatById(): returns a format for the ids above, else undefined.
export function getExtraValueFormat(numberFormatId: string): ValueFormat | undefined {
  const riscv = riscvFormats.find((f) => f.id === numberFormatId);
  if (riscv) {return riscv;}
  if (numberFormatId.startsWith(ALIAS_PREFIX)) {return new AliasValueFormat(numberFormatId.slice(ALIAS_PREFIX.length));}
  return undefined;
}

function formatIdForBinding(target: string): string {
  return riscvFormats.some((f) => f.id === target) ? target : ALIAS_PREFIX + target;
}

function rowPath(row: NetlistVariable): string {
  return row.scopePath.concat([row.signalName]).join(".");
}

// Re-formats and redraws rows whose format reads one of the given tables.
function refreshTables(names: Set<string>) {
  rowHandler.rowItems.forEach((row, rowId) => {
    if (!(row instanceof NetlistVariable) && !(row instanceof CustomVariable)) {return;}
    const format = row.valueFormat;
    if (!(format instanceof AliasValueFormat) || !names.has(format.tableName)) {return;}
    const data = row.getWaveformData();
    const update = data && data.formattedValues[format.id]
      ? rowHandler.updateValueFormatCache(data, format, true)
      : Promise.resolve();
    update.then(() => events.redrawVariable(rowId));
  });
}

// Sets a row's value format the way rowHandler.setDisplayFormat does for one row,
// without its per-row context update (the caller sends one for the whole batch) and
// without its "search box has focus" early return.
function setRowFormat(row: NetlistVariable, rowId: number, formatId: string): boolean {
  const format = getExtraValueFormat(formatId);
  if (format === undefined || row.valueFormat.id === format.id) {return false;}
  if (!format.checkWidth(row.signalWidth) && !row.missingSignal) {return false;}
  rowHandler.unsetValueFormat(row.getWaveformData(), row.valueFormat);
  row.valueFormat = format;
  rowHandler.setValueFormat(row.getWaveformData(), format, true);
  row.setSignalContextAttribute();
  events.redrawVariable(rowId);
  return true;
}

// Applies bindings to displayed rows. onlyNew: just rows added since the last call
// (the add-variable path). Sends at most one context update.
function bindRows(onlyNew: boolean, paths: Set<string> | undefined, stateChange: StateChangeType): number {
  let applied = 0;
  rowHandler.rowItems.forEach((row, rowId) => {
    if (!(row instanceof NetlistVariable)) {return;}
    const isNew = !seenRows.has(row);
    seenRows.add(row);
    if (onlyNew && !isNew) {return;}
    const path = rowPath(row);
    if (paths !== undefined && !paths.has(path)) {return;}
    const target = aliasBindings.get(path);
    if (target === undefined) {return;}
    if (setRowFormat(row, rowId, formatIdForBinding(target))) {applied++;}
  });
  if (applied > 0) {vscodeWrapper.sendWebviewContext(stateChange);}
  return applied;
}

// Gives every displayed signal with a binding its bound format (one undo step).
export function applyAliasBindings(): number {
  return bindRows(false, undefined, StateChangeType.User);
}

export interface LoadAliasOptions {
  bareRadix?: BareRadix;
  apply?: boolean; // apply the file's signal bindings to displayed signals (default true)
}

export interface LoadAliasResult {
  tables: string[];
  formatIds: string[];
  bindings: AliasBinding[];
  defaultTable?: string;
  warnings: string[];
  applied: number;
}

export function loadValueAliases(text: string, fileName: string, opts: LoadAliasOptions = {}): LoadAliasResult {
  const parsed = parseAliasFile(String(text), String(fileName), { bareRadix: opts.bareRadix });
  const names = new Set<string>();
  const source: AliasSource = { text: String(text), fileName: String(fileName), bareRadix: opts.bareRadix };
  parsed.tables.forEach((t) => {aliasTables.set(t.name, t); aliasSources.set(t.name, source); names.add(t.name);});
  parsed.bindings.forEach((b) => aliasBindings.set(b.signal, b.table));
  refreshTables(names);
  const paths = new Set(parsed.bindings.map((b) => b.signal));
  const applied = opts.apply === false || paths.size === 0 ? 0 : bindRows(false, paths, StateChangeType.User);
  markRowsSeen(); // with apply:false, existing rows must not be bound by a later add-variable
  parsed.warnings.forEach((w) => vscodeWrapper.outputLog(`alias file ${fileName}: ${w}`));
  return {
    tables: [...names],
    formatIds: [...names].map((n) => ALIAS_PREFIX + n),
    bindings: parsed.bindings,
    defaultTable: parsed.defaultTable,
    warnings: parsed.warnings,
    applied,
  };
}

function markRowsSeen() {
  rowHandler.rowItems.forEach((row) => {if (row instanceof NetlistVariable) {seenRows.add(row);}});
}

export function clearValueAliases() {
  const names = new Set(aliasTables.keys());
  aliasTables.clear();
  aliasSources.clear();
  aliasBindings.clear();
  refreshTables(names);
}

// The alias file a table came from, when that one file alone formats the table as the
// viewer does: the table and every table its slices name were read from it (a slice can
// name a table another file defined). Otherwise undefined.
export function aliasSearchSource(tableName: string): AliasSource | undefined {
  const source = aliasSources.get(tableName);
  if (!source) {return undefined;}
  const seen = new Set<string>();
  const walk = (name: string): boolean => {
    if (seen.has(name)) {return true;}
    seen.add(name);
    const table = aliasTables.get(name);
    if (!table || aliasSources.get(name) !== source) {return false;}
    return table.kind !== "slice" || table.slices.every((d) => d.table === undefined || walk(d.table));
  };
  return walk(tableName) ? source : undefined;
}

export function listExtraFormats(): { id: string; label: string }[] {
  return [
    ...riscvFormats.map((f) => ({ id: f.id, label: f.label })),
    ...[...aliasTables.keys()].map((name) => ({ id: ALIAS_PREFIX + name, label: "Alias: " + name })),
  ];
}

// #region Host interface
// Called first by VscodeWrapper.handleMessage. Returns true when the message was
// handled here and VaporView's own switch should skip it.
export function handleExtraMessage(message: Record<string, unknown> | undefined): boolean {
  if (!message || typeof message !== "object") {return false;}
  switch (message.command) {
    case "loadValueAliases": {
      let result: LoadAliasResult | { error: string };
      try {
        const bareRadix = typeof message.bareRadix === "string" ? message.bareRadix as BareRadix : undefined;
        result = loadValueAliases(String(message.text ?? ""), String(message.fileName ?? "alias"),
          { bareRadix, apply: message.apply !== false });
      } catch (err) {
        result = { error: String(err) };
      }
      // Hosts other than VS Code read the reply from this executeCommand message.
      vscodeWrapper.executeCommand("vaporview.valueAliasesLoaded", [{ fileName: message.fileName, ...result }]);
      return true;
    }
    case "applyAliasBindings": applyAliasBindings(); return true;
    case "clearValueAliases":  clearValueAliases(); return true;
    case "add-variable":
      // VaporView creates the rows synchronously in its handler; bind the new ones
      // right after it returns. StateChangeType.None: the binding belongs to the same
      // undo step as the add.
      queueMicrotask(() => bindRows(true, undefined, StateChangeType.None));
      return false;
    case "apply-state":
      // Restored, undone and redone states keep their formats: only mark the rows.
      queueMicrotask(markRowsSeen);
      return false;
  }
  return false;
}

(window as unknown as Record<string, unknown>).vaporviewValueFormats = {
  loadValueAliases,
  clearValueAliases,
  applyAliasBindings,
  listFormats: listExtraFormats,
};
