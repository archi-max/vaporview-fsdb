import { type NetlistId, type RowId, type ValueChange, EnumData, EnumEntry, NameType, VariableEncoding, CollapseState, type BitRangeSource, type SignalSeparatorContext, type NetlistVariableContext, CustomVariableContext, SignalGroupContext, SavedRowItem, SavedSignalSeparator, SavedNetlistVariable, SavedCustomVariable, SavedSignalGroup, type SavedSlices } from '../common/types';
import { ActionType, type EventHandler } from './event_handler';
import { dataManager, viewport, viewerState, events, rowHandler, vscodeWrapper, styles, config, windowCache } from "./vaporview"; // cmux: windowed loading
import { EnumValueFormat, formatBinary, formatHex, formatString, type ValueFormat } from "./value_format";
import { type WaveformRenderer, setRenderBounds } from "./renderer";
import type { WaveformData } from "./data_manager";
import { labelsPanel, getParentGroupId } from "./vaporview"; // cmux: getParentGroupId for slices
import { bitRangeString, createInstancePath } from '../common/functions';
import { ValueLinkEvent } from '../../packages/vaporview-api/types';
import { pushAll } from '../common/arrays'; // vscode-port

export function htmlSafe(string: string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlAttributeSafe(string: string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// cmux: a value for a double-quoted attribute (& and " escaped), so file-controlled text
// (signal names in data-vscode-context, tooltips) can't end the attribute and add others.
export function htmlQuotedAttribute(string: string) {
  return string.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function isAnalogSignal(renderType: WaveformRenderer) {
  return renderType.id === 'linear' || renderType.id === 'linearSigned' ||
         renderType.id === 'stepped' || renderType.id === 'steppedSigned';
}

export function getRowHeightCssClass(height: number) {
  switch (height) {
    case 2:  {return "height2x";}
    case 4:  {return "height4x";}
    case 8:  {return "height8x";}
    default: {return "height1x";}
  }
}

function mouseOverHandler(event: MouseEvent, signalItem: NetlistVariable, checkBounds: boolean) {

  if (!signalItem.valueLinkEnable) {return;}
  if (!event.target) {return;}

  let redraw        = false;
  let valueIndex    = -1;

  if (checkBounds) {
    const elementX    = event.pageX - viewport.scrollAreaBounds.left;
    signalItem.valueLinkBounds.forEach(([min, max], i) => {
      if (elementX >= min && elementX <= max) {
        valueIndex = i;
      }
    });
  }

  // store a pointer to the netlistData object for a keydown event handler
  if (valueIndex >= 0) {
    viewport.valueLinkObject = signalItem;
  } else {
    viewport.valueLinkObject = null;
  }

  // Check to change cursor to a pointer
  if (valueIndex >= 0 && (event.ctrlKey || event.metaKey)) {
    viewport.overlayCanvasElement.classList.add('waveform-link');
  } else {
    viewport.overlayCanvasElement.classList.remove('waveform-link');
  }

  if (valueIndex !== signalItem.valueLinkIndex) {redraw = true;}
  signalItem.valueLinkIndex = valueIndex;

  if (redraw) {
    signalItem.wasRendered = false;
    signalItem.renderWaveform();
  }
}

export type VariableItem = NetlistVariable | CustomVariable;

export abstract class SignalItem {

  public labelElement: HTMLElement | null = null;
  public valueDisplayElement: HTMLElement | null = null;
  public viewportElement: HTMLElement | null = null;
  public vscodeContext: string = "";
  public wasRendered: boolean = false;
  public rowHeight: number = 1;
  public isSelected: boolean = false;
  public topBounds: number | null = null;
  public abstract readonly rowId: RowId;

  public abstract createLabelElement(): string
  public abstract createValueDisplayElement(): string
  public getValueAtTime(time: number | null): string[] {return [""];}
  public getNearestTransition(time: number | null): ValueChange | null {return null;}
  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {return [this.rowId];}
  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {return 1;}
  public findParentGroupId(rowId: RowId): number | null {return null;}
  public formatValue(value: string): string {return "";}
  public getWaveformData(): WaveformData | undefined {return undefined;}
  public renderWaveform() {return;}
  public handleValueLink(time: number, snapToTime: number) {return false;}
  public getAllEdges(valueList: string[]): number[] {return [];}
  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {return null;}
  public dispose() {return;}
}

export interface RowItem {
  labelElement: HTMLElement | null;
  valueDisplayElement: HTMLElement | null;
  viewportElement: HTMLElement | null;
  vscodeContext: string;
  wasRendered: boolean;
  rowHeight: number;
  isSelected: boolean;
  netlistId?: NetlistId;
  topBounds: number | null;

  createLabelElement(): string;
  createValueDisplayElement(): string;
  setSignalContextAttribute(): void;
  createWaveformRowContent(): string;
  getLabelText(): string;
  setLabelText(newLabel: string): void;
  getSaveData(): SavedRowItem;

  getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[];
  rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number
  findParentGroupId(rowId: RowId): number | null;

  getValueAtTime(time: number | null): string[];
  getAllEdges(valueList: string[]): number[];
  getNextEdge(time: number, direction: number, valueList: string[]): number | null;
  getNearestTransition(time: number | null): [number, string] | null;
  getWaveformData(): WaveformData | undefined;

  renderWaveform(): void;
  handleValueLink(time: number, snapToTime: number): boolean;

  dispose(): void;
}

export class SignalSeparator extends SignalItem implements RowItem {

  constructor(
    public readonly rowId: number,
    public label: string,
  ) {
    super();
    this.setSignalContextAttribute();
  }

  public createWaveformRowContent() {return `<p>${htmlSafe(this.label)}</p>`;} // cmux: separator names come from sessions

  public createLabelElement() {
    const height            = getRowHeightCssClass(this.rowHeight);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    //const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    // cmux: quoted and escaped attributes (htmlQuotedAttribute)
    return `<div class="waveform-label waveform-separator is-idle" id="label-${this.rowId}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}">
              <div class="waveform-row ${selectorClass} ${height}">${this.createWaveformRowContent()}</div>
            </div>`;
    }

  public createValueDisplayElement() {

    const height            = getRowHeightCssClass(this.rowHeight);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass     = isSelectedClass + ' ' + lastSelectedClass;
    // cmux: quoted and escaped attributes (htmlQuotedAttribute)
    const result = `<div class="value-display-item ${selectorClass} ${height}" id="value-${this.rowId}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}"></div>`;
    return result;
  }

  public setSignalContextAttribute() {
    const context: SignalSeparatorContext = {
      webviewSection: "signal-separator",
      rowId: this.rowId,
      preventDefaultContextMenuItems: true,
    };
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedSignalSeparator {
    return {
      dataType: "signal-separator",
      label: this.label,
      rowHeight: this.rowHeight,
    };
  }

  getLabelText(): string {return this.label;}
  setLabelText(newLabel: string) {this.label = newLabel;}
}

// cmux: slices (Split, Add Slice). A variable's slices are custom variables in a
// SliceGroup the variable owns. The group has no row of its own: the variable's row
// is its header, with a chevron, and the slices follow it in the flat row list, so
// upstream's group code collapses, reorders and removes them. See row_handler.ts.
export type SlicedVariable = NetlistVariable | CustomVariable;

export function sliceGroupOf(item: SlicedVariable): SliceGroup | null {
  if (!item.sliceGroupId) {return null;}
  const group = rowHandler.rowItems[rowHandler.groupIdTable[item.sliceGroupId]];
  return group instanceof SliceGroup ? group : null;
}

// The group, when it has slices to show.
function shownSlices(item: SlicedVariable): SliceGroup | null {
  const group = sliceGroupOf(item);
  return group && group.children.length > 0 ? group : null;
}

function sliceChevron(item: SlicedVariable): string {
  const group = shownSlices(item);
  if (!group) {return '';}
  const icon = group.collapseState === CollapseState.Expanded ? 'codicon-chevron-down' : 'codicon-chevron-right';
  return `<div class='codicon ${icon}'></div>`;
}

// The slices' labels (or value cells), nested in the variable's label as a group's
// children are; nothing when collapsed.
function sliceElements(item: SlicedVariable, labels: boolean): string {
  const group = shownSlices(item);
  if (!group || group.collapseState !== CollapseState.Expanded) {return '';}
  return group.children.map((id) => {
    const child = rowHandler.rowItems[id];
    if (!child) {return '';}
    return labels ? child.createLabelElement() : child.createValueDisplayElement();
  }).join('');
}

function sliceLabelWrap(item: SlicedVariable, label: string): string {
  if (!shownSlices(item)) {return label;}
  const children = `<div class="labels-group child-group">${sliceElements(item, true)}</div>`;
  return label.replace(/<\/div>\s*$/, children + '</div>');
}

function sliceFlatten(item: SlicedVariable, ignoreCollapsed: boolean, ignoreRowId: number): number[] {
  if (ignoreRowId === item.rowId) {return [];}
  const result: number[] = [item.rowId];
  const group = shownSlices(item);
  if (group && (!ignoreCollapsed || group.collapseState === CollapseState.Expanded)) {
    group.children.forEach((id) => {
      if (id === ignoreRowId) {return;}
      const child = rowHandler.rowItems[id];
      if (child) {pushAll(result, child.getFlattenedRowIdList(ignoreCollapsed, ignoreRowId));} // vscode-port: no spread
    });
  }
  return result;
}

function sliceParentGroupId(item: SlicedVariable, rowId: RowId): number | null {
  const group = sliceGroupOf(item);
  if (!group) {return null;}
  // The group's own row: it sits where its owner sits.
  if (rowId === group.rowId) {return getParentGroupId(item.rowId);}
  return group.findParentGroupId(rowId);
}

function sliceSaveData(item: SlicedVariable): SavedSlices | undefined {
  const group = shownSlices(item);
  if (!group) {return undefined;}
  const children: SavedCustomVariable[] = [];
  group.children.forEach((id) => {
    const child = rowHandler.rowItems[id];
    if (child instanceof CustomVariable) {children.push(child.getSaveData());}
  });
  return {collapseState: group.collapseState, children: children};
}

// The slice context keys: whether it has slices, the name they're named after and the
// declared indices of its bits (a slice's own bits count from 0).
// `declared`: a signal of the dump (not a bit range), which the design declares a type for.
function sliceContext(item: SlicedVariable, name: string, msb: number, lsb: number, declared: boolean) {
  return {cmuxSlices: shownSlices(item) !== null, cmuxSliceName: name, cmuxMsb: msb, cmuxLsb: lsb, cmuxDeclared: declared};
}

export class NetlistVariable extends SignalItem implements RowItem {

  public valueFormat: ValueFormat;
  public valueLinkEnable: boolean = false;
  public valueLinkBounds: [number, number][] = [];
  public valueLinkIndex: number = -1;
  public colorIndex: number = 0;
  public color: string = "";
  public rowHeight: number = 1;
  public wasRendered: boolean = false;
  public verticalScale: number = 1;
  public nameType: NameType = NameType.fullPath;
  public customName: string = "";
  public min: number = 0;
  public max: number = 0;
  public readonly missingSignal: boolean;
  public sliceGroupId: number = 0; // cmux: the SliceGroup holding its slices, 0 for none

  constructor(
    public readonly rowId: RowId,
    public readonly netlistId: number | undefined,
    public readonly signalId: number | undefined,
    public readonly signalName: string,
    public readonly scopePath: string[],
    public readonly signalWidth: number,
    public readonly variableType: string,
    public readonly encoding: VariableEncoding,
    public renderType: WaveformRenderer,
    public enumType: string,
    public msb: number,
    public lsb: number,
  ) {
    super();

    this.customName = this.signalName;
    this.nameType   = config.defaultNameType as NameType;
    this.colorIndex = 1;

    if (this.signalWidth === 1) {
      this.colorIndex = config.defaultSingleBitColor;
    } else {
      this.colorIndex = config.defaultMultiBitColor;
    }

    if (this.signalId === undefined && this.netlistId === undefined) {
      this.missingSignal = true;
    } else {
      this.missingSignal = false;
    }

    if (this.encoding === VariableEncoding.String) {
      this.valueFormat = formatString;
      this.colorIndex  = config.defaultStringColor;
    } else if (this.encoding === VariableEncoding.Real) {
      this.valueFormat = formatString;
      this.colorIndex  = config.defaultMultiBitColor;
    } else if (this.enumType !== "") {
      this.valueFormat = new EnumValueFormat(this.enumType);
      this.colorIndex  = config.defaultEnumColor;
    } else {
      this.valueFormat = this.signalWidth === 1 ? formatBinary : formatHex;
    }

    if (this.variableType === 'Parameter') {
      this.colorIndex = config.defaultParamColor;
    }

    this.setSignalContextAttribute();
    this.setColorFromColorIndex();
  }

  public createWaveformRowContent(): string {
    let result = sliceChevron(this); // cmux: slices
    const signalName  = htmlSafe(this.signalName + bitRangeString(this.msb, this.lsb, true));
    if (this.nameType === NameType.fullPath) {
      const scopePath = htmlSafe(this.scopePath.join('.') + '.');
      result += `<p style="opacity:50%">${scopePath}</p><p>${signalName}</p>`;
    } else if (this.nameType === NameType.signalName) {
      result += `<p>${signalName}</p>`;
    } else if (this.nameType === NameType.custom) {
      result += `<p>${htmlSafe(this.customName)}</p>`;
    }

    return result;
  }

  public createLabelElement() {

    let missingSignalClass = "";
    if (this.missingSignal) {missingSignalClass = 'missing-signal';}
    const height        = getRowHeightCssClass(this.rowHeight);
    // cmux: the tooltip is plain text, escaped once at the sink (htmlQuotedAttribute below)
    const fullPath      = createInstancePath(this.scopePath, this.signalName);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass + ' ' + missingSignalClass;
    // vscode-port: a whole load shown as a summary (windowing off, too many changes) says so on the row
    const summary       = this.signalId !== undefined && dataManager.summarySignals.has(this.signalId);
    const summaryNote   = "Summary, not exact: more value changes than one whole load holds. Turn on vaporview.wisp.windowing to see exact values.";
    const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding + (summary ? "\n" + summaryNote : "");
    const summaryBadge  = summary ? `<span class="vv-summary-badge" title="${htmlQuotedAttribute(summaryNote)}" style="margin-left:4px;padding:0 3px;border-radius:2px;font-size:10px;color:var(--vscode-inputValidation-warningForeground, inherit);background:var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.25));border:1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,0.8))">summary</span>` : "";
    // cmux: quoted and escaped attributes (htmlQuotedAttribute)
    return sliceLabelWrap(this, `<div class="waveform-label is-idle" id="label-${this.rowId}" title="${htmlQuotedAttribute(tooltip)}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}">
              <div class='waveform-row ${selectorClass} ${height}'>${this.createWaveformRowContent()}${summaryBadge}</div>
            </div>`); // cmux: slices
    }

  public createValueDisplayElement() {
    let   value = labelsPanel.valueAtMarker[this.rowId];
    if (this.missingSignal || value === undefined) {value = [];}
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    const height        = getRowHeightCssClass(this.rowHeight);
    const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
    const parseValue    = this.valueFormat.formatString;
    const valueIs9State = this.valueFormat.is9State;
    const pElement      = value.map((v: string) => {
      const is9State     = valueIs9State(v);
      const colorStyle   = is9State ? styles.xzColor : this.color;
      const displayValue = htmlSafe(parseValue(v, this.signalWidth, !is9State)); // cmux: every format escaped (String shows file bytes); was rawText only
      return `<p style="color:${colorStyle}">${displayValue}</p>`;
    }).join(joinString);

    // cmux: quoted and escaped attributes (htmlQuotedAttribute)
    return `<div class="value-display-item ${selectorClass} ${height}" id="value-${this.rowId}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}">${pElement}</div>` + sliceElements(this, false); // cmux: slices
  }

  public setSignalContextAttribute() {
    const renderType = this.renderType.id;
    const isAnalog = isAnalogSignal(this.renderType);
    const context: NetlistVariableContext = {
      webviewSection: "signal",
      scopePath: this.scopePath.join('.'),
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      preventDefaultContextMenuItems: true,
      valueLinkEnable: this.valueLinkEnable,
      netlistId: this.netlistId!,
      rowId: this.rowId,
      isAnalog: isAnalog,
      enum: this.enumType !== "",
      ...sliceContext(this, this.signalName, this.msb, this.lsb, true), // cmux: slices
    };
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedNetlistVariable {
    return {
      dataType:         "netlist-variable",
      netlistId:        this.netlistId,
      name:             createInstancePath(this.scopePath, this.signalName),
      numberFormat:     this.valueFormat.id,
      colorIndex:       this.colorIndex,
      rowHeight:        this.rowHeight,
      verticalScale:    this.verticalScale,
      nameType:         this.nameType,
      customName:       this.customName,
      renderType:       this.renderType.id,
      valueLinkEnable:  this.valueLinkEnable,
      cmuxSlices:       sliceSaveData(this), // cmux: slices
    };
  }

  public getLabelText(): string {
    if (this.nameType === NameType.custom) {
      return this.customName;
    } else if (this.nameType === NameType.signalName) {
      return this.signalName;
    } else {
      return [this.scopePath.join('.'), this.signalName].join('.');
    }
  }

  public setLabelText(newLabel: string) {
    this.customName = newLabel;
    this.nameType = NameType.custom;
  }

  // cmux: a row with slices is followed by them, as a group by its children.
  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    return sliceFlatten(this, ignoreCollapsed, ignoreRowId);
  }
  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {return sliceFlatten(this, ignoreCollapsed, -1).length;}
  public findParentGroupId(rowId: RowId): number | null {return sliceParentGroupId(this, rowId);}

  public renderWaveform() {

    if (this.signalId === undefined) {return;}
    const data = dataManager.valueChangeData[this.signalId];

    // cmux: windowed loading draws from the best loaded windows
    if (!data && windowCache.isWindowed(this.signalId)) {windowCache.renderRow(this); this.wasRendered = true; return;}
    if (!data) {return;}

    const valueChangeChunk = setRenderBounds(this, data);
    this.renderType.draw(valueChangeChunk, this);
    this.wasRendered = true;
  }

  public getValueAtTime(time: number | null) {
    if (this.signalId === undefined) {return [];}
    if (windowCache.isWindowed(this.signalId)) {return windowCache.valueAtTime(this.signalId, time);} // cmux
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getValueAtTime(data, time);
  }

  public getNearestTransition(time: number | null): ValueChange | null {
    if (this.signalId === undefined) {return null;}
    if (windowCache.isWindowed(this.signalId) && time !== null) {return windowCache.nearestTransition(this.signalId, time);} // cmux
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getNearestTransition(data, time);
  }

  public getWaveformData(): WaveformData | undefined {
    if (this.signalId === undefined) {return undefined;}
    return dataManager.valueChangeData[this.signalId];
  }

  public setColorFromColorIndex() {
    this.color = styles.colorKey[this.colorIndex];
  }

  public getAllEdges(valueList: string[]): number[] {
    if (this.signalId === undefined) {return [];}
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getAllEdges(valueList, data, this.signalWidth);
  }

  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {
    if (this.signalId === undefined) {return null;}
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getNextEdge(data, time, direction, valueList);
  }

  handleValueLinkMouseOver(event: MouseEvent) {
    mouseOverHandler(event, this, true);
  }

  handleValueLinkMouseExit(event: MouseEvent) {
    mouseOverHandler(event, this, false);
  }

  handleValueLink(time: number, snapToTime: number): boolean {

    if (this.signalId === undefined) {return false;}
    const data = dataManager.valueChangeData[this.signalId];

    if (!data) {return false;}
    if (!this.valueLinkEnable) {return false;}
    if (this.renderType.id !== 'multiBit') {return false;}
    if (this.valueLinkIndex < 0) {return false;}
    if (time !== snapToTime) {return false;}

    const signalId       = this.signalId;
    const index          = dataManager.binarySearch(data.valueChangeData, time) - 1;
    const valueChange    = dataManager.valueChangeData[signalId].valueChangeData[index];
    const timeValue      = valueChange[0];
    const value          = valueChange[1];
    const formattedValue = this.valueFormat.formatString(value, this.signalWidth, !this.valueFormat.is9State(value));

    const event: ValueLinkEvent = {
      uri: viewerState.uri?.toString() || "",
      rowId: this.rowId,
      netlistId: this.netlistId,
      scopePath: this.scopePath,
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      encoding: this.encoding,
      numberFormat: this.valueFormat.id,
      value: value,
      formattedValue: formattedValue,
      time: timeValue,
    };

    vscodeWrapper.emitValueLinkEvent(event);
    return true;
  }

  public dispose() {
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
  }
}

export class CustomVariable extends SignalItem implements RowItem {

  public valueFormat: ValueFormat;
  public valueLinkEnable: boolean = false;
  public valueLinkBounds: [number, number][] = [];
  public valueLinkIndex: number = -1;
  public colorIndex: number = config.defaultCustomSignalColor;
  public color: string = "";
  public rowHeight: number = 1;
  public wasRendered: boolean = false;
  public verticalScale: number = 1;
  public nameType: NameType = NameType.fullPath;
  public customName: string = "";
  public min: number = 0;
  public max: number = 0;
  public readonly variableType: string = "custom";
  public encoding: VariableEncoding = VariableEncoding.BitVector;
  public enumType: string = "";
  public readonly missingSignal: boolean;
  public sliceGroupId: number = 0; // cmux: the SliceGroup holding its slices, 0 for none

  constructor(
    public readonly rowId: number,
    public source: BitRangeSource[],
    public readonly customSignalId: number | undefined,
    public signalName: string,
    public signalWidth: number,
    public renderType: WaveformRenderer,
  ) {
    super();
    this.customName = this.signalName;
    this.valueFormat = this.signalWidth === 1 ? formatBinary : formatHex;
    this.missingSignal = (this.customSignalId === undefined);
    this.setSignalContextAttribute();
    this.setColorFromColorIndex();
  }

  public createWaveformRowContent(): string {

    if (this.nameType === NameType.custom) {
      return sliceChevron(this) + `<p>${htmlSafe(this.customName)}</p>`; // cmux: slices
    } else {
      return sliceChevron(this) + `<p>${htmlSafe(this.signalName)}</p>`;
    }
  }

  public createLabelElement() {

    let missingSignalClass = "";
    if (this.missingSignal) {missingSignalClass = 'missing-signal';}
    const height        = getRowHeightCssClass(this.rowHeight);
    const signalName    = this.signalName; // cmux: plain text, escaped once at the sink (htmlQuotedAttribute below)
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass + ' ' + missingSignalClass;
    const tooltip       = "Name: " + signalName + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    // cmux: quoted and escaped attributes (htmlQuotedAttribute)
    return sliceLabelWrap(this, `<div class="waveform-label is-idle" id="label-${this.rowId}" title="${htmlQuotedAttribute(tooltip)}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}">
              <div class='waveform-row ${selectorClass} ${height}'>${this.createWaveformRowContent()}</div>
            </div>`); // cmux: slices
    }

    public createValueDisplayElement() {

      let   value = labelsPanel.valueAtMarker[this.rowId];
      if (this.missingSignal || value === undefined) {value = [];}
      const isSelectedClass   = this.isSelected ? 'is-selected' : '';
      const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
      const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
      const height        = getRowHeightCssClass(this.rowHeight);
      const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
      const parseValue    = this.valueFormat.formatString;
      const valueIs9State = this.valueFormat.is9State;
      const pElement      = value.map((v: string) => {
        const is9State     = valueIs9State(v);
        const colorStyle   = is9State ? styles.xzColor : this.color;
        const displayValue = htmlSafe(parseValue(v, this.signalWidth, !is9State)); // cmux: every format escaped (String shows file bytes); was rawText only
        return `<p style="color:${colorStyle}">${displayValue}</p>`;
      }).join(joinString);
  
      // cmux: quoted and escaped attributes (htmlQuotedAttribute)
      return `<div class="value-display-item ${selectorClass} ${height}" id="value-${this.rowId}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}">${pElement}</div>` + sliceElements(this, false); // cmux: slices
    }

  public setSignalContextAttribute() {
    const renderType = this.renderType.id;
    const isAnalog = isAnalogSignal(this.renderType);
    const context: CustomVariableContext = {
      webviewSection: "signal",
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      preventDefaultContextMenuItems: true,
      rowId: this.rowId,
      netlistId: this.source[0].netlistId || -1,
      isAnalog: isAnalog,
      ...sliceContext(this, this.nameType === NameType.custom ? this.customName : this.signalName, this.signalWidth - 1, 0, false), // cmux: slices
    };
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedCustomVariable {
    return {
      dataType:         "custom-variable",
      source:           this.source,
      numberFormat:     this.valueFormat.id,
      colorIndex:       this.colorIndex,
      rowHeight:        this.rowHeight,
      verticalScale:    this.verticalScale,
      nameType:         this.nameType,
      customName:       this.customName,
      renderType:       this.renderType.id,
      valueLinkEnable:  this.valueLinkEnable,
      cmuxSlices:       sliceSaveData(this), // cmux: slices
    };
  }

  public getLabelText(): string {
    if (this.nameType === NameType.custom) {
      return this.customName;
    } else if (this.nameType === NameType.signalName) {
      return this.signalName;
    } else {
      return this.signalName;
    }
  }

  public setLabelText(newLabel: string) {
    this.customName = newLabel;
    this.nameType = NameType.custom;
  }

  // cmux: a row with slices is followed by them, as a group by its children.
  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    return sliceFlatten(this, ignoreCollapsed, ignoreRowId);
  }
  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {return sliceFlatten(this, ignoreCollapsed, -1).length;}
  public findParentGroupId(rowId: RowId): number | null {return sliceParentGroupId(this, rowId);}

  public renderWaveform() {

    if (this.customSignalId === undefined) {return;}
    const data = dataManager.customValueChangeData[this.customSignalId];

    if (!data) {return;}
    const valueChangeData = data.valueChangeData;
    if (valueChangeData.length === 0) {return;}

    const valueChangeChunk = setRenderBounds(this, data);
    this.renderType.draw(valueChangeChunk, this);
    this.wasRendered = true;
  }

  public getValueAtTime(time: number | null) {
    if (this.customSignalId === undefined) {return [];}
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getValueAtTime(data, time);
  }

  public getNearestTransition(time: number | null): ValueChange | null {
    if (this.customSignalId === undefined) {return null;}
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getNearestTransition(data, time);
  }

  public getWaveformData(): WaveformData | undefined {
    if (this.customSignalId === undefined) {return undefined;}
    return dataManager.customValueChangeData[this.customSignalId];
  }

  public setColorFromColorIndex() {
    this.color = styles.colorKey[this.colorIndex];
  }

  public getAllEdges(valueList: string[]): number[] {
    if (this.customSignalId === undefined) {return [];}
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getAllEdges(valueList, data, this.signalWidth);
  }

  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {
    if (this.customSignalId === undefined) {return null;}
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getNextEdge(data, time, direction, valueList);
  }

  //handleValueLinkMouseOver(event: MouseEvent) {
  //  mouseOverHandler(event, this, true);
  //}

  //handleValueLinkMouseExit(event: MouseEvent) {
  //  mouseOverHandler(event, this, false);
  //}

  public dispose() {
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
  }

}

export class SignalGroup extends SignalItem implements RowItem {

  public collapseState: CollapseState = CollapseState.Expanded;
  public children: RowId[] = [];

  constructor(
    public readonly rowId: number,
    public label: string,
    public readonly groupId: number
  ) {
    super();
    this.setSignalContextAttribute();
  }

  public createWaveformRowContent() {
    const icon = this.collapseState === CollapseState.Expanded ? 
      'codicon-chevron-down' : 'codicon-chevron-right';
    return `<div class='codicon ${icon}'></div><p>${htmlSafe(this.label)}</p>`; // cmux: group names come from sessions
  }

  public createLabelElement() {

    let childElements = '';
    let icon = 'codicon-chevron-right';
    let groupClass = 'collapsed-group';
    if (this.collapseState === CollapseState.Expanded) {
      this.children.forEach((childRowId) => {
        const signalItem = rowHandler.rowItems[childRowId];
        childElements += signalItem.createLabelElement();
      });
      icon = 'codicon-chevron-down';
      groupClass = 'expanded-group';
    }
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    //const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    // cmux: quoted and escaped attributes (htmlQuotedAttribute)
    return `<div class="waveform-label waveform-group is-idle ${groupClass}" id="label-${this.rowId}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}">
              <div class="waveform-row ${selectorClass} height1x">${this.createWaveformRowContent()}</div>
              <div class="labels-group child-group">${childElements}</div>
            </div>`;
    }

  public createValueDisplayElement() {

    let   value = labelsPanel.valueAtMarker[this.rowId];
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    // cmux: quoted and escaped attributes (htmlQuotedAttribute)
    let result = `<div class="value-display-item ${selectorClass} height1x" id="value-${this.rowId}" data-vscode-context="${htmlQuotedAttribute(this.vscodeContext)}"></div>`;
    if (value === undefined) {value = [];}
    if (this.collapseState === CollapseState.Expanded) {
      this.children.forEach((childRowId) => {
        const signalItem = rowHandler.rowItems[childRowId];
        result += signalItem.createValueDisplayElement();
      });
    }
    return result;
  }

  public setSignalContextAttribute() {
    const context: SignalGroupContext = {
      webviewSection: "signal-group",
      groupId: this.groupId,
      rowId: this.rowId,
      preventDefaultContextMenuItems: true,
    };
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedSignalGroup {
    const children: SavedRowItem[] = [];
    this.children.forEach((childRowId) => {
      const rowItem = rowHandler.rowItems[childRowId];
      if (!rowItem) {return;}
      children.push(rowItem.getSaveData());
    });
    return {
      dataType: "signal-group",
      groupName: this.label,
      collapseState: this.collapseState,
      children: children,
    };
  }

  getLabelText(): string {return this.label;}
  setLabelText(newLabel: string) {this.label = newLabel;}

  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    const result: number[] = [this.rowId];
    if (!ignoreCollapsed || this.collapseState === CollapseState.Expanded) {
      this.children.forEach((rowId) => {
        if (rowId === ignoreRowId) {return;} // Skip the ignored rowId
        const signalItem = rowHandler.rowItems[rowId];
        pushAll(result, signalItem.getFlattenedRowIdList(ignoreCollapsed, ignoreRowId)); // vscode-port: no spread
      });
    }
    return result;
  }

  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {
    let total = 1; // Count the group row itself
    if (!ignoreCollapsed || this.collapseState === CollapseState.Expanded) {
      this.children.forEach((rowId, i) => {
        if (i >= stopIndex) {return;}
        const signalItem = rowHandler.rowItems[rowId];
        total += signalItem.rowIdCount(ignoreCollapsed, Infinity);
      });
    }
    return total;
  }

  public findParentGroupId(rowId: RowId): number | null {
    if (this.children.includes(rowId)) {
      return this.groupId;
    }
    for (const childRowId of this.children) {
      const signalItem = rowHandler.rowItems[childRowId];
      const parentGroupId = signalItem.findParentGroupId(rowId);
      if (parentGroupId !== null) {
        return parentGroupId;
      }
    }
    return null;
  }

  public showHideViewportRows() {
    //const childRows = this.getFlattenedRowIdList(false, -1);
    //let childRows: number[] = [];
    //this.children.forEach((rowId) => {
    //  const childRowItem = rowHandler.rowItems[rowId];
    //  if (!childRowItem) {return;}
    //  childRows = childRows.concat(childRowItem.getFlattenedRowIdList(true, -1));
    //});
    //childRows.forEach((rowId) => {
    //  if (rowId === this.rowId) {return;} // Skip the group row itself
    //  const signalItem = rowHandler.rowItems[rowId];
    //  if (signalItem instanceof NetlistVariable || signalItem instanceof CustomVariable) {
    //    signalItem.wasRendered = false; // Reset rendering state for child signals
    //  }
    //});
    rowHandler.updateDisplayedSignalsFlat();
    viewport.updateElementHeight();
  }

  public expand() {
    this.collapseState = CollapseState.Expanded;
    labelsPanel.renderLabelsPanels();
    labelsPanel.renderValueDisplay();
    this.showHideViewportRows();
  }

  public collapse() {
    this.collapseState = CollapseState.Collapsed;
    const childRows = this.getFlattenedRowIdList(false, -1);
    const newSelection = viewerState.selectedSignal.filter((rowId) => !childRows.includes(rowId));
    let lastSelected = viewerState.lastSelectedSignal;
    if (viewerState.selectedSignal.length !== newSelection.length) {
      if (lastSelected !== null && childRows.includes(lastSelected)) {
        lastSelected = null;
      }
      events.signalSelect(newSelection, lastSelected);
    }
    labelsPanel.renderLabelsPanels();
    labelsPanel.renderValueDisplay();
    this.showHideViewportRows();
  }

  public toggleCollapse() {
    if (this.collapseState === CollapseState.Expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  //public renderWaveform() {this.wasRendered = true;}

  public dispose() {
    //this.canvas?.remove();
    //this.canvas = null;
    //this.ctx = null;
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
    this.label = "";
  }
}
// cmux: the group holding a variable's slices (see sliceGroupOf). It never has a row:
// its owner's row shows its chevron, and its children follow its owner.
export class SliceGroup extends SignalGroup {
  constructor(rowId: number, label: string, groupId: number, public readonly owner: RowId) {
    super(rowId, label, groupId);
  }
}
