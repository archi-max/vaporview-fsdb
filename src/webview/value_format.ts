// This section defines all of the different ways we can display the various
// values in the waveform viewer. To create your own format, you need to:
// 1. Implement a new ValueFormat object and add it to the valueFormatList
// array at the bottom of the file. There are helper functions supplied to
// discern 9-state values and to format as binary in case non-2-state values
// are invalid.
// 2. Define a new command in the package.json file (which has examples)
// under contributes.commands and create the context menus entries under 
// contributes.menus.vaporview.valueFormat.
// 3. Register the new command in the commands.ts (which has examples)

import { Temporal } from '@js-temporal/polyfill';
import { WindowMessageType } from "../common/types";
import { type NetlistVariable, type CustomVariable } from "./signal_item";
import { dataManager, vscodeWrapper } from "./vaporview";
import { getExtraValueFormat } from "./extra_formats";
import { matchBinaryExact, signedSearchBits } from "./value_search";

export function  valueIs9State(value: string): boolean {
  if (value.match(/[uxzwlh-]/)) {return true;}
  return false;
}

function formatBinaryString(inputString: string) {
  return inputString.replace(/\B(?=(\w{4})+(?!\w))/g, "_");
}

function signedBinaryStringToInt(inputString: string) {
  const isNegative = inputString[0] === '1';
  let result = parseInt(inputString, 2);
  if (isNegative) {
    result -= 2 ** inputString.length;
  }
  return result;
}

function formatBinaryStringFloat9State(inputString: string, exponentBits: number, mantissaBits: number) {
  const sign = inputString[0];
  const exponent = inputString.slice(1, 1 + exponentBits);
  const mantissa = inputString.slice(1 + exponentBits);
  return sign + "_" + exponent + "_" + mantissa;
}

function parseBinaryStringAsFloat(inputString: string, exponentBits: number, mantissaBits: number) {
  const sign = inputString[0] === '1' ? -1 : 1;
  const exponent = parseInt(inputString.slice(1, 1 + exponentBits), 2);
  const mantissa = parseInt(inputString.slice(1 + exponentBits), 2);
  // Infinity and NaN
  if (exponent === 2 ** exponentBits - 1) {
    if (mantissa === 0) {
      return sign * Infinity;
    } else {
      return sign * NaN;
    }
  }
  return sign * 2 ** (exponent - (2 ** (exponentBits - 1) - 1)) * (1 + mantissa / 2 ** mantissaBits);
}

function formatFloat(inputString: string, exponentBits: number, mantissaBits: number, is2State: boolean) {
  if (!is2State) {
    return formatBinaryStringFloat9State(inputString, exponentBits, mantissaBits);
  }
  return parseBinaryStringAsFloat(inputString, exponentBits, mantissaBits).toString();
}

// This function checks for a valid number in float format in the search bar
function checkValidFloat(inputText: string) {
  if (inputText.match(/^-?(\d+)?\.?\d+$/)) {return true;}
  if (inputText.match(/^-?Inf(inity)?$/)) {return true;}
  if (inputText.match(/^-?NaN$/)) {return true;}
  return false;
}

// This function parses a number and returns a binary string for searching
function parseFloatForSearch(inputText: string, exponentBits: number, mantissaBits: number,) {
  if (inputText.match(/^-?Inf(inity)?$/)) {
    const sign = inputText[0] === '-' ? '1' : '0';
    return sign + '1'.repeat(exponentBits) + '0'.repeat(mantissaBits);
  }
  if (inputText.match(/^-?NaN$/)) {
    const sign = inputText[0] === '-' ? '1' : '0';
    return sign + '1'.repeat(exponentBits) + '1' + '.'.repeat(mantissaBits - 1);
  }
  const number = parseFloat(inputText);
  const sign = number < 0 ? '1' : '0';
  const absNumber = Math.abs(number);
  const exponent = Math.floor(Math.log2(absNumber));
  const mantissa = absNumber / 2 ** exponent - 1;
  return sign + exponent.toString(2).padStart(exponentBits, '0') + mantissa.toString(2).slice(2).padEnd(mantissaBits, '0');
}

function regexMatchBinary(inputString: string, binaryString: string, formattedString: string): boolean {
  return binaryString.match(new RegExp(inputString, 'ig')) !== null;
}

// cmux: numeric formats match the whole value (value_search.ts); upstream's
// regexMatchBinary above stays for ASCII, string and enum values.
function matchExact(inputString: string, binaryString: string, formattedString: string): boolean {
  return matchBinaryExact(inputString, binaryString);
}

function matchExactSigned(inputString: string, binaryString: string, formattedString: string): boolean {
  return matchBinaryExact(inputString, binaryString, true);
}

// cmux: whether a format's search is a bit pattern over the whole value (matchExact,
// matchExactSigned: binary, hex, octal, decimal, signed, floats), which the windowed
// viewer can hand to the helper as such. Every other format searches text or a regex
// (ASCII, string, enum, fixed point, epoch time, RISC-V, aliases), even when the text is
// made only of 0, 1, x and z, and must be matched as non-windowed rows match it.
export function searchesBitPattern(format: ValueFormat): boolean {
  return format.checkSearchValue === matchExact || format.checkSearchValue === matchExactSigned;
}

function regexMatchString(inputString: string, binaryString: string, formattedString: string): boolean {
  return formattedString.match(new RegExp(inputString, 'ig')) !== null;
}

// #region Value Format Interface
// The interface is defined by the ValueFormat interface:
export interface ValueFormat {
  // Unique identifier for the format
  id: string;

  // If true, the value will be right justified when displayed in a waveform
  rightJustify: boolean;

  // The text to display in the search symbol
  symbolText: string;

  // Function to format the string for display. The input format is an ASCII string of binary values
  // and the output format is a string that will be displayed in the viewer.
  formatString: (binaryString: string, width: number, is2State: boolean) => string;

  // Function to check if the string is valid in the search bar
  checkValidSearch: (searchString: string) => boolean;

  // Function to parse the search value
  parseSearchValue: (searchString: string) => string;

  // Function that's iteratively called during a search to compare values to match search
  checkSearchValue: (parsedSearchValue: string, binaryString: string, formattedValue: string) => boolean;

  // Function to check if the value is a 9-state value
  is9State: (value: string) => boolean;

  // Function to check if the value format can be applied to a signal
  checkWidth: (width: number) => boolean;

  // If true, formatString returns plain text and the value display escapes it for
  // HTML (the canvas, search and clipboard use the text as is). extra_formats.ts
  rawText?: boolean;
}

// #region Format Hexadecimal
// vscode-port: upstream's hex formatting, kept for values with other characters (see formatHexFast).
export function formatHexUpstream(inputString: string, width: number, is2State: boolean): string {
    if (!is2State) {
      const stringArray = inputString.replace(/\B(?=(.{4})+(?!.))/g, "_").split("_");
      return stringArray.map((chunk) => {

        if (chunk.match(/[z]/)) {return "z";}
        if (chunk.match(/[x]/)) {return "x";}
        if (chunk.match(/[u]/)) {return "u";}
        if (chunk.match(/[w]/)) {return "w";}
        if (chunk.match(/[l]/)) {return "l";}
        if (chunk.match(/[h]/)) {return "h";}
        if (chunk.match(/[-]/)) {return "-";}
        return parseInt(chunk, 2).toString(16);
      }).join('').replace(/\B(?=(.{4})+(?!.))/g, "_");
    } else {
      const stringArray = inputString.replace(/\B(?=(\d{16})+(?!\d))/g, "_").split("_");
      return stringArray.map((chunk) => {
        const digits = Math.ceil(chunk.length / 4);
        return parseInt(chunk, 2).toString(16).padStart(digits, '0');
      }).join('_');
    }
}

// vscode-port: the same hex text in linear time. Upstream's grouping regex /\B(?=(.{4})+(?!.))/ rescans the rest of
// the string at every position (quadratic: ~0.7 ms per 512-bit value, 17 s for 25,000 of them in one task). Values
// made only of word characters (0 1 x z u w l h) group from the right exactly as that regex does; anything else
// (a '-' changes where \B matches) keeps upstream's code. test/riscv/hex.test.ts checks both give the same text.
const HEX_WORD_ONLY = /^[01xzuwlh]*$/;
function groupFromRight(s: string, n: number): string[] {
  const out: string[] = [];
  const first = s.length % n || Math.min(n, s.length);
  if (s.length === 0) {return [''];}
  out.push(s.slice(0, first));
  for (let i = first; i < s.length; i += n) {out.push(s.slice(i, i + n));}
  return out;
}
export function formatHexFast(inputString: string, is2State: boolean): string | null {
  if (!HEX_WORD_ONLY.test(inputString)) {return null;}
  if (!is2State) {
    const digits = groupFromRight(inputString, 4).map((chunk) => {
      if (chunk.includes('z')) {return "z";}
      if (chunk.includes('x')) {return "x";}
      if (chunk.includes('u')) {return "u";}
      if (chunk.includes('w')) {return "w";}
      if (chunk.includes('l')) {return "l";}
      if (chunk.includes('h')) {return "h";}
      return parseInt(chunk, 2).toString(16);
    }).join('');
    return groupFromRight(digits, 4).join('_');
  }
  if (!/^[01]*$/.test(inputString)) {return null;} // upstream's \d grouping: digits only
  return groupFromRight(inputString, 16).map((chunk) => parseInt(chunk, 2).toString(16).padStart(Math.ceil(chunk.length / 4), '0')).join('_');
}

export const formatHex: ValueFormat = {
  id: "hexadecimal",
  rightJustify: true,
  symbolText: "hex",

  formatString: (inputString: string, width: number, is2State: boolean) => {
    const fast = formatHexFast(inputString, is2State); // vscode-port
    if (fast !== null) {return fast;}
    return formatHexUpstream(inputString, width, is2State);
  },

  checkValidSearch: (searchString: string) => {
    if (searchString.match(/^(0x)?[0-9a-fA-FxzXZ_]+$/)) {return true;}
    else {return false;}
  },

  parseSearchValue: (searchString: string) =>{
    let result = searchString.replace(/_/g, '').replace(/^0x/i, '');
    result = result.split('').map((c) => {
      if (c.match(/[xXzZ]/)) {return '....';}
      return parseInt(c, 16).toString(2).padStart(4, '0');
    }).join('');
    return result;
  },

  checkSearchValue: matchExact,

  is9State: valueIs9State,

  checkWidth: (width: number) => {return width > 1;},
};

// #region Format Octal
export const formatOctal: ValueFormat = {
  id: "octal",
  rightJustify: true,
  symbolText: "oct",

  formatString: (binaryString: string, width: number, is2State: boolean) => {
  // If number format is hexadecimal
    if (!is2State) {
      const stringArray = binaryString.replace(/\B(?=(.{3})+(?!.))/g, "_").split("_");
      return stringArray.map((chunk) => {

        if (chunk.match(/[z]/)) {return "z";}
        if (chunk.match(/[x]/)) {return "x";}
        if (chunk.match(/[u]/)) {return "u";}
        if (chunk.match(/[w]/)) {return "w";}
        if (chunk.match(/[l]/)) {return "l";}
        if (chunk.match(/[h]/)) {return "h";}
        if (chunk.match(/[-]/)) {return "-";}
        return parseInt(chunk, 2).toString(16);
      }).join('');
    } else {
      const stringArray = binaryString.replace(/\B(?=(\d{3})+(?!\d))/g, "_").split("_");
      return stringArray.map((chunk) => {
        const digits = Math.ceil(chunk.length / 3);
        return parseInt(chunk, 2).toString(8).padStart(digits, '0');
      }).join('');
    }
  },

  checkValidSearch: (searchString: string) => {
    if (searchString.match(/^[0-7xzXZ_]+$/)) {return true;}
    else {return false;}
  },

  parseSearchValue: (searchString: string) =>{
    let result = searchString.replace(/_/g, '');
    result = result.split('').map((c) => {
      if (c.match(/[xXzZ]/)) {return '...';}
      return parseInt(c, 8).toString(2).padStart(3, '0');
    }).join('');
    return result;
  },

  checkSearchValue: matchExact,

  is9State: valueIs9State,

  checkWidth: (width: number) => {return width > 1;},
};

// #region Format Binary
export const formatBinary: ValueFormat = {
  id: "binary",
  rightJustify: true,
  symbolText: "bin",

  formatString: formatBinaryString,

  checkValidSearch: (searchString: string) => {
    if (searchString.match(/^b?[01xzXZdD_]+$/)) {return true;}
    else {return false;}
  },

  parseSearchValue:(searchString: string) => {
    return searchString.replace(/_/g, '').replace(/[dD]/g, '.');
  },

  checkSearchValue: matchExact,

  is9State: valueIs9State,

  checkWidth: (width: number) => {return width > 0;},
};

// #region Format Decimal
const formatDecimal: ValueFormat = {
  id: "decimal",
  rightJustify: false,
  symbolText: "dec",

  formatString: (binaryString: string, width: number, is2State: boolean) => {
    if (!is2State) {
      return formatBinaryString(binaryString);
    }
    // Use BigInt for arbitrary precision
    return BigInt('0b' + binaryString).toString(10);
  },

  checkValidSearch: (searchString: string) => {
    if (searchString.match(/^[0-9xzXZ_,]+$/)) {return true;}
    else {return false;}
  },

  parseSearchValue: (searchString: string) => {
    const result = searchString.replace(/[,_]/g, '');
    if (result.match(/[xXzZ]/)) {
      // For don't care values, match any pattern
      return '.*';
    }
    // Use BigInt for arbitrary precision conversion from decimal to binary
    return BigInt(result).toString(2);
  },

  checkSearchValue: matchExact,

  is9State: valueIs9State,

  checkWidth: (width: number) => {return width > 1;},
};

// #region Format Signed
const formatSignedInt: ValueFormat = {
  id: "signed",
  rightJustify: false,
  symbolText: "int",

  formatString: (binaryString: string, width: number, is2State: boolean) => {
    if (!is2State) {
      return formatBinaryString(binaryString);
    }
    // Use BigInt for arbitrary precision two's complement signed conversion
    const isNegative = binaryString[0] === '1';
    let result = BigInt('0b' + binaryString);
    if (isNegative) {
      // Subtract 2^width to get the negative value
      result -= (BigInt(1) << BigInt(binaryString.length));
    }
    return result.toString(10);
  },

  checkValidSearch: (searchString: string) => {
    if (searchString.match(/^-?[0-9xzXZ_,]+$/)) {return true;}
    else {return false;}
  },

  // cmux: with a sign bit, so +5 ("0101") is not -3 ("101"). value_search.ts
  parseSearchValue: signedSearchBits,

  checkSearchValue: matchExactSigned,

  is9State: valueIs9State,

  checkWidth: (width: number) => {return width > 1;},
};

// #region Format Float 4
export const formatFloat4: ValueFormat = {
  id: "float4",
  rightJustify: false,
  symbolText: "fp4",
  formatString: (inputString: string, width: number, is2State: boolean) => {
    if (!is2State) {
      return formatBinaryStringFloat9State(inputString, 1, 2);
    }
    const table = ["0", "0.5", "1", "1.5", "2", "3", "4", "6", "-0", "-0.5", "-1", "-1.5", "-2", "-3", "-4", "-6"];
    const index = parseInt(inputString, 2);
    return table[index];
  },
  checkValidSearch: checkValidFloat,
  parseSearchValue: (searchString: string) => {return parseFloatForSearch(searchString, 4, 3);},
  checkSearchValue: matchExact,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width === 4;},
};

// #region Format Float 8
export const formatFloat8: ValueFormat = {
  id: "float8",
  rightJustify: false,
  symbolText: "fp8",
  formatString: (inputString: string, width: number, is2State: boolean) => {return formatFloat(inputString, 4, 3, is2State);},
  checkValidSearch: checkValidFloat,
  parseSearchValue: (searchString: string) => {return parseFloatForSearch(searchString, 4, 3);},
  checkSearchValue: matchExact,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width === 8;},
};

// #region Format Float 16
export const formatFloat16: ValueFormat = {
  id: "float16",
  rightJustify: false,
  symbolText: "f16",
  formatString: (inputString: string, width: number, is2State: boolean) => {return formatFloat(inputString, 5, 10, is2State);},
  checkValidSearch: checkValidFloat,
  parseSearchValue: (searchString: string) => {return parseFloatForSearch(searchString, 5, 10);},
  checkSearchValue: matchExact,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width === 16;},
};

// #region Format BFloat 16
export const formatBFloat16: ValueFormat = {
  id: "bfloat16",
  rightJustify: false,
  symbolText: "b16",
  formatString: (inputString: string, width: number, is2State: boolean) => {return formatFloat(inputString, 8, 7, is2State);},
  checkValidSearch: checkValidFloat,
  parseSearchValue: (searchString: string) => {return parseFloatForSearch(searchString, 8, 7);},
  checkSearchValue: matchExact,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width === 16;},
};

// #region TensorFloat 32
export const formatTensorFloat32: ValueFormat = {
  id: "tensorfloat32",
  rightJustify: false,
  symbolText: "t19",
  formatString: (inputString: string, width: number, is2State: boolean) => {return formatFloat(inputString, 8, 10, is2State);},
  checkValidSearch: checkValidFloat,
  parseSearchValue: (searchString: string) => {return parseFloatForSearch(searchString, 8, 10);},
  checkSearchValue: matchExact,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width === 19;},
};

// #region Format Float 32
export const formatFloat32: ValueFormat = {
  id: "float32",
  rightJustify: false,
  symbolText: "f32",
  formatString: (inputString: string, width: number, is2State: boolean) => {return formatFloat(inputString, 8, 23, is2State);},
  checkValidSearch: checkValidFloat,
  parseSearchValue: (searchString: string) => {return parseFloatForSearch(searchString, 8, 23);},
  checkSearchValue: matchExact,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width === 32;},
};

// #region Format Float 64
export const formatFloat64: ValueFormat = {
  id: "float64",
  rightJustify: false,
  symbolText: "f64",
  formatString: (inputString: string, width: number, is2State: boolean) => {return formatFloat(inputString, 11, 52, is2State);},
  checkValidSearch: checkValidFloat,
  parseSearchValue: (searchString: string) => {return parseFloatForSearch(searchString, 11, 52);},
  checkSearchValue: matchExact,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width === 64;},
};

// #region Format ASCII
export const formatAscii: ValueFormat = {
  id: "ascii",
  rightJustify: false,
  symbolText: "txt",
  formatString: (binaryString: string, width: number, is2State: boolean) => {
    if (!is2State) {
      return formatBinaryString(binaryString);
    }
    let result = '';
    for (let i = 0; i < binaryString.length; i += 8) {
      const byte = binaryString.slice(i, i + 8);
      const charCode = parseInt(byte, 2);
      if (charCode < 32) {
        //result += '&#' + charCode.toString() + ';';
        result += ' ';
      } else {
        result += String.fromCharCode(charCode);
      }
    }
    return result.trim();
  },

  checkValidSearch: (searchString: string) => {
    if (searchString.match(/^[\x20-\xFF]*$/)) {return true;}
    else {return false;}
  },

  parseSearchValue: (searchString: string) => {
    return searchString.split('').map((c) => {
      const charCode = c.charCodeAt(0);
      return charCode.toString(2).padStart(8, '0');
    }).join('');
  },

  checkSearchValue: regexMatchBinary,

  is9State: valueIs9State,

  checkWidth: (width: number) => {return width > 1;},
};

//region Format epoch time nanoseconds
export const formatEpochTime: ValueFormat = {
  id: "nsepoch",
  rightJustify: false,
  symbolText: "time",

  formatString: (binaryString: string, width: number, is2State: boolean) => {
    if (!is2State) {return formatBinaryString(binaryString);}
    const intValue = BigInt('0b' + binaryString);
    const instant  = Temporal.Instant.fromEpochNanoseconds(intValue);
    const dateTime = instant.toZonedDateTimeISO('UTC');
    const year     = dateTime.year.toString().padStart(4, '0');
    const month    = dateTime.month.toString().padStart(2, '0');
    const day      = dateTime.day.toString().padStart(2, '0');
    const hour     = dateTime.hour.toString().padStart(2, '0');
    const minute   = dateTime.minute.toString().padStart(2, '0');
    const second   = dateTime.second.toString().padStart(2, '0');
    const ms       = dateTime.millisecond.toString().padStart(3, '0');
    const mus      = dateTime.microsecond.toString().padStart(3, '0');
    const ns       = dateTime.nanosecond.toString().padStart(3, '0');

    return `${year}-${month}-${day} ${hour}:${minute}:${second}.${ms},${mus},${ns}`;
  },

  checkValidSearch: (searchString: string) => {return true;},
  parseSearchValue: (searchString: string) => {return searchString;},
  checkSearchValue: regexMatchString,
  is9State: valueIs9State,
  checkWidth: (width: number) => {return width >= 64;},
};

// #region Format String
export const formatString: ValueFormat = {
  id: "string",
  rightJustify: false,
  symbolText: "str",

  formatString: (inputString: string, width: number, is2State: boolean) => {return inputString;},
  checkValidSearch: (searchString: string) => {return true;},
  parseSearchValue: (searchString: string) => {return searchString;},
  checkSearchValue: regexMatchBinary,
  is9State: () => {return false;},
  checkWidth: (width: number) => {return true;},
};

// #region Format Enum
// Enum format is a special case where the value is looked up in a table
// to get the string representation. The enum type is stored in the netlist item.
export class EnumValueFormat implements ValueFormat {
  public id = "enum";
  public rightJustify = false;
  public symbolText = "abc";
  constructor(public enumType: string) {this.enumType = enumType;}

  public formatString = (inputString: string, width: number, is2State: boolean) => {
    // This function is a placeholder and will be replaced in the NetlistVariable class
    // cmux: plain text; the value display escapes every format once (signal_item.ts), and
    // the canvas and clipboard want the text itself
    const enumTable = dataManager.enumTable[this.enumType];
    if (!enumTable) {return inputString;}
    const result = enumTable.find((entry) => {return entry[0] === inputString;});
    if (result) {return result[1];}
    return inputString;
  };

  public checkValidSearch = (searchString: string) => {return dataManager.enumTable[this.enumType].find((entry) => {return entry[0] === searchString;}) !== undefined;};
  public parseSearchValue = (searchString: string) => {return searchString;};
  public checkSearchValue = regexMatchBinary;
  public is9State = () => {return false;};
  public checkWidth = (width: number) => {return true;};
}

// #region Format Fixed Point
// Fixed point is a special case format that takes in an offset and sign
export class FixedPointValueFormat implements ValueFormat {
  public id: string;
  public rightJustify: boolean = false;
  public symbolText: string = "dec";
  private padStart: string = "";
  private padEnd: string = "";
  private intBits: number = 0;
  private multiplier: number = 1;

  constructor(
    public offset: number,
    public signed: boolean,
    width: number
  ) {
    this.offset = offset;
    this.signed = signed;
    this.id = "fixedpoint_" + (signed ? "s" : "u") + "_" + offset.toString();
    this.intBits = Math.max(0, width - this.offset);
    this.multiplier = 2 ** -this.offset;
  }

  public formatString = (binaryString: string, width: number, is2State: boolean) => {
    if (!is2State) {
      return formatBinaryString(binaryString);
    }

    let value = parseInt(binaryString, 2);
    if (this.signed && binaryString[0] === '1') {
      value -= (1 << width);
    }

    return (value * this.multiplier).toString();
  };

  public checkValidSearch(searchString: string) {
    if (searchString.match(/^-?[0-9xzXZ_,]+(\.\d+)?$/)) {return true;}
    else {return false;}
  }

  public parseSearchValue(searchString: string) {return searchString.replace(/[,_]/g, '');}
  public checkSearchValue = regexMatchString;
  public is9State = valueIs9State;
  public checkWidth = (width: number) => {return width > 1;};
}

export const valueFormatList: ValueFormat[] = [
  formatBinary,
  formatHex,
  formatDecimal,
  formatOctal,
  formatSignedInt,
  formatFloat4,
  formatFloat8,
  formatFloat16,
  formatFloat32,
  formatFloat64,
  formatBFloat16,
  formatTensorFloat32,
  formatAscii,
  formatEpochTime,
  formatString
];

export function getNumberFormatById(netlistData: NetlistVariable | CustomVariable, numberFormatId: string): ValueFormat {
  const valueFormat = valueFormatList.find((format) => format.id === numberFormatId);
  if (valueFormat !== undefined) {return valueFormat;}

  // special handling for enum and fixed point
  if (numberFormatId === "enum") {
    const enumType = netlistData.enumType;
    if (enumType !== undefined && enumType !== "") {
      return new EnumValueFormat(enumType);
    }
  }
  if (numberFormatId.startsWith("fixedpoint_")) {
    const args = numberFormatId.split("_");
    if (args.length !== 3) {return formatDecimal;}
    const signed = args[1] === "s";
    const offset = parseInt(args[2]);
    return new FixedPointValueFormat(offset, signed, netlistData.signalWidth);
  }
  // RISC-V disassembly and value alias formats (extra_formats.ts)
  const extraFormat = getExtraValueFormat(numberFormatId);
  if (extraFormat !== undefined) {return extraFormat;}

  vscodeWrapper.showMessage(WindowMessageType.Warning, "Unknown number format: " + numberFormatId);
  vscodeWrapper.outputLog("Unknown number format: " + numberFormatId);
  return formatBinary;
}

// Profiling code:
//let vectors = []
//for (let i = 0; i < 1; i++) {
//    let s = ""; 
//    for (let i = 0; i < 64; i++) {
//        s += Math.round(Math.random()).toString();
//    }
//    vectors.push(s);
//}
//
//a = performance.now();
//vectors.forEach(v => {formatString(v, 64, true)});
//performance.now() - a