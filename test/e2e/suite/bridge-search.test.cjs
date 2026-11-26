// vscode-port P1 : exact value search (cmux value_search.ts), driven through the viewer's own search
// bar and next/previous buttons. top.bus in search.vcd:
//   t:  0    10   20   30   40   50        60        70          80   90
//   v:  05   15   50   55   05   0000x101  zzzz0101  FB (= -5)   05   15
// Upstream VaporView matched the search bits as an unanchored regex, so hex 5 ("0101") also hit 0x15, 0x50, 0x55.
const { vscode, assert, until, open, closeAll } = require('./helpers.cjs');
const { cmuxData, page, pageReady } = require('./bridge-helpers.cjs');

const FORMAT = { hexadecimal: 'vaporview.displayAsHexadecimal', decimal: 'vaporview.displayAsDecimal',
  binary: 'vaporview.displayAsBinary', signed: 'vaporview.displayAsDecimalSigned' };

async function setup() {
  // only this suite's viewer: another one left open (a big dump still loading) would share the page bridge's host
  const docs = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
  const list = Array.isArray(docs) ? docs : (docs && docs.documents) || [];
  if (list.some((u) => !/search\.[a-z]+$/i.test(String(u)))) { await closeAll(); }
  const uri = String(await open('search.vcd'));
  await pageReady();
  await vscode.commands.executeCommand('waveformViewer.addVariable', { uri, instancePath: 'top.bus' });
  const bus = await until(() => cmuxData('findItem', 'top.bus'), 'top.bus');
  await until(() => page((c, a) => !!c.host.viewerContext.webview && (c.host.viewerContext.webview.displayedSignals || []).some((d) => d.netlistId === a.id), { id: bus.netlistId }), 'row shown');
  return { uri, bus };
}
// Type `text` into the value search with `format`, starting at marker `from`; press Next (dir 1) or Previous (-1)
// `steps` times; return the marker after each press.
async function search(ctx, format, text, from, dir, steps) {
  await vscode.commands.executeCommand(FORMAT[format], { netlistId: ctx.bus.netlistId });
  // the format reaches the webview as a message: wait until the row has it, or the search parses with the old one
  await until(() => page((c, a) => (c.host.viewerContext.webview.displayedSignals || []).some((d) => d.netlistId === a.id && d.numberFormat === a.f),
    { id: ctx.bus.netlistId, f: format }), 'format ' + format);
  await vscode.commands.executeCommand('waveformViewer.setMarker', { uri: ctx.uri, time: from });
  await until(() => page((c, a) => c.host.viewerContext.webview.markerTime === a.t, { t: from }), 'marker ' + from);
  return page(async (c, a) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    c.host.toWebview({ command: 'setSelectedSignal', netlistId: a.id });
    await sleep(100);
    document.getElementById('value-equals-button').click();
    const bar = document.getElementById('search-bar');
    bar.value = a.text;
    bar.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
    const button = document.getElementById(a.dir === 1 ? 'next-button' : 'previous-button');
    const out = [];
    for (let i = 0; i < a.steps; i++) {
      button.click();
      await sleep(150);
      out.push(c.host.viewerContext.webview.markerTime);
    }
    const invalid = document.getElementById('search-container').classList.contains('is-invalid');
    return { marks: out, invalid };
  }, { id: ctx.bus.netlistId, text, dir, steps });
}
const marks = async (...a) => { const r = await search(...a); assert.ok(!r.invalid, 'search accepted: ' + a[2]); return r.marks; };

module.exports = {
  'a format change applies while the search bar has focus, and the search is parsed again': async () => {
    const ctx = await setup();
    // hex 5 typed, bar keeps focus; switching the row to binary turns '5' invalid, decimal makes it 5 again
    const r = await search(ctx, 'hexadecimal', '5', 0, 1, 1);
    assert.deepStrictEqual(r.marks, [40]);
    // The state under test is the viewer's own "search bar in focus" (search-container.is-focused, set by the bar's focus
    // event), not OS focus: a test window without OS focus (Mac installed runs) gets no focus event from bar.focus(),
    // so the event is sent to the bar then.
    assert.ok(await page(() => {
      const bar = document.getElementById('search-bar');
      const box = document.getElementById('search-container');
      if (!box.classList.contains('is-focused')) { bar.focus(); }
      if (!box.classList.contains('is-focused')) { bar.dispatchEvent(new FocusEvent('focus')); }
      return box.classList.contains('is-focused');
    }), 'search bar in focus (viewer state)');
    try {
      await vscode.commands.executeCommand(FORMAT.binary, { netlistId: ctx.bus.netlistId });
      await until(() => page((c, a) => (c.host.viewerContext.webview.displayedSignals || []).some((d) => d.netlistId === a.id && d.numberFormat === 'binary'), { id: ctx.bus.netlistId }), 'binary applied with the bar focused');
      assert.ok(await page(() => document.getElementById('search-container').classList.contains('is-invalid')), "'5' is not a binary search");
      await vscode.commands.executeCommand(FORMAT.decimal, { netlistId: ctx.bus.netlistId });
      await until(() => page(() => !document.getElementById('search-container').classList.contains('is-invalid')), 'valid again as decimal');
    } finally {
      // the next tests reuse this viewer: leave the bar, so a failure here can't hold the focus for them
      await page(() => {
        const bar = document.getElementById('search-bar');
        bar.blur();
        if (document.getElementById('search-container').classList.contains('is-focused')) { bar.dispatchEvent(new FocusEvent('blur')); }
        return true;
      });
    }
  },

  'hex 5 finds only 0x05, forward and backward (not 0x15, 0x50, 0x55)': async () => {
    const ctx = await setup();
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '5', 0, 1, 3), [40, 80, 80], 'forward from 0: 40, 80, then stays');
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '5', 90, -1, 3), [80, 40, 0], 'backward from 90');
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '15', 0, 1, 2), [10, 90]);
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '0x05', 0, 1, 1), [40], 'leading zeros and 0x prefix');
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '50', 0, 1, 1), [20]);
  },

  'decimal, binary and signed searches are exact too': async () => {
    const ctx = await setup();
    assert.deepStrictEqual(await marks(ctx, 'decimal', '5', 0, 1, 2), [40, 80], 'dec 5 skips 21, 80, 85');
    assert.deepStrictEqual(await marks(ctx, 'decimal', '21', 0, 1, 2), [10, 90]);
    assert.deepStrictEqual(await marks(ctx, 'decimal', '85', 90, -1, 1), [30]);
    assert.deepStrictEqual(await marks(ctx, 'binary', '101', 0, 1, 2), [40, 80], 'bin 101 is the value 5, not a substring');
    assert.deepStrictEqual(await marks(ctx, 'binary', '0101_0000', 0, 1, 1), [20]);
    assert.deepStrictEqual(await marks(ctx, 'signed', '-5', 0, 1, 1), [70], 'signed -5 = 0xFB');
    assert.deepStrictEqual(await marks(ctx, 'signed', '5', 0, 1, 2), [40, 80], 'signed +5 is not -3/-5');
    assert.deepStrictEqual(await marks(ctx, 'signed', '-5', 80, -1, 1), [70]);
  },

  'x/z: binary x and z are literal digits; a hex x digit is a any-nibble wildcard': async () => {
    const ctx = await setup();
    assert.deepStrictEqual(await marks(ctx, 'binary', 'x101', 0, 1, 1), [50], 'bin x101 = the value 0000x101 only');
    assert.deepStrictEqual(await marks(ctx, 'binary', 'zzzz0101', 0, 1, 1), [60]);
    assert.deepStrictEqual(await marks(ctx, 'binary', '101', 40, 1, 1), [80], 'bin 101 skips 0000x101 and zzzz0101');
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '5', 40, 1, 1), [80], 'hex 5 skips x/z values');
    // a hex x digit stands for any nibble (0-f, x or z), still over the whole value
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', 'x5', 0, 1, 6), [10, 30, 40, 60, 80, 90]);
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '5x', 0, 1, 2), [20, 30]);
    // binary d is a one-bit don't-care
    assert.deepStrictEqual(await marks(ctx, 'binary', '1d1', 0, 1, 2), [40, 80]);
  },

  "upstream's bit-substring match is gone": async () => {
    const ctx = await setup();
    // the old rule: hex 5 -> /0101/ anywhere in the bits; it would stop at 10 (00010101) first
    const old = (bits) => /0101/i.test(bits);
    assert.ok(old('00010101') && old('01010000'), 'the old rule matches 0x15 and 0x50');
    assert.deepStrictEqual(await marks(ctx, 'hexadecimal', '5', 0, 1, 1), [40]);
    assert.deepStrictEqual(await marks(ctx, 'binary', '0101', 0, 1, 1), [40], 'bin 0101 is the value, not a substring');
  },
};
