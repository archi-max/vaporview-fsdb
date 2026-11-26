// cmux: exact value search, as Verdi searches. Upstream's numeric checkSearchValue
// (regexMatchBinary in value_format.ts) tests the parsed search as an unanchored regex
// over the value's bits, so hex 5 ("0101") also matches 0x15, 0x50 and 0x55. Here the
// same regex is anchored to the whole value: the search must be the value, with as many
// leading zeros as it needs (or ones, for a negative signed value: sign extension).
// Wildcards ('.', hex/decimal x and z) and regexes still work, now over the whole value,
// so ".*0101.*" is still a substring search. A search longer than the signal matches when
// its extra high bits are what the value extends with (hex 05 on a 4-bit signal is 5).

const cache = new Map<string, RegExp | null>();

function anchored(pattern: string, pad: string): RegExp | null {
  const key = pad + pattern;
  let re = cache.get(key);
  if (re === undefined) {
    try {re = new RegExp('^' + pad + '*(?:' + pattern + ')$', 'i');} catch {re = null;}
    if (cache.size > 64) {cache.clear();}
    cache.set(key, re);
  }
  return re;
}

// `signed`: the pattern is two's complement (signedSearchBits) and is sign-extended by its
// first bit; the value is too when the pattern is longer.
export function matchBinaryExact(pattern: string, binaryString: string, signed = false): boolean {
  if (pattern === '.*') {return true;}
  const pad = signed && pattern[0] === '1' ? '1' : '0';
  const extra = pattern.length - binaryString.length;
  const value = extra > 0 ? (signed && binaryString[0] === '1' ? '1' : '0').repeat(extra) + binaryString : binaryString;
  const re = anchored(pattern, pad);
  return re !== null && re.test(value);
}

// The signed format's parsed search: the minimal two's complement bits (a sign bit
// included, so +5 is "0101", not -3's "101"), or ".*" for an x/z digit. Negative values
// as upstream's parseSearchValue computes them.
export function signedSearchBits(searchString: string): string {
  const result = searchString.replace(/[,_]/g, '');
  if (result.match(/[xXzZ]/)) {return '.*';}
  if (result[0] === '-') {
    const positive = BigInt(result.slice(1));
    const length = positive.toString(2).length + 1;
    return (BigInt(2) ** BigInt(length) - positive).toString(2);
  }
  const bits = BigInt(result).toString(2);
  return bits === '0' ? '0' : '0' + bits;
}
