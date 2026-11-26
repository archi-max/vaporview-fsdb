// vscode-port: registers the cmux additions (page-module bridge, RISC-V and alias value formats, alias files).
// GPL-3.0. Called once from extension.ts.
import * as vscode from 'vscode';
import type { WaveformViewerProvider } from '../extension_core/viewer_provider';
import { cmuxBridge, registerDefaultNativeHandlers, setBridgeLog } from './bridge_host';
import { aliasFormatsOf, registerAliases } from './aliases';
import { waveformData } from './data';
import { terminalLinkProviders } from './terminal_links';

// The viewer's RISC-V instruction formats (src/webview/extra_formats.ts).
const FORMAT_COMMANDS: Record<string, string> = {
  'vaporview.displayAsRiscv': 'riscv',
  'vaporview.displayAsRiscvNumeric': 'riscv_numeric',
  'vaporview.displayAsRiscvNoAlias': 'riscv_noalias',
  'vaporview.displayAsRiscvNumericNoAlias': 'riscv_numeric_noalias',
  'vaporview.removeValueAlias': 'hexadecimal',
};

export function activateCmux(context: vscode.ExtensionContext, provider: WaveformViewerProvider, log: vscode.OutputChannel) {
  const logLine = (s: string) => log.appendLine(s);
  setBridgeLog(logLine);
  registerDefaultNativeHandlers(context);
  registerAliases(context, logLine);
  const reg = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  for (const [id, format] of Object.entries(FORMAT_COMMANDS)) {
    reg(id, (e: any) => provider.setValueFormat(e, undefined, { valueFormat: format }));
  }
  // Format Values > Alias Table...: the tables of the alias files loaded into this viewer.
  reg('vaporview.displayAsAliasTable', async (e: any) => {
    let format: string | undefined = e && typeof e.aliasFormat === 'string' ? e.aliasFormat : undefined;
    if (!format) {
      const document = cmuxBridge.activeDocument();
      const formats = document ? aliasFormatsOf(document) : [];
      if (!formats.length) { vscode.window.showInformationMessage('No value alias tables are loaded. Use Load Value Alias File... first.'); return; }
      const pick = await vscode.window.showQuickPick(formats.map((f) => ({ label: f.replace(/^alias:/, ''), format: f })), { placeHolder: 'Alias table' });
      format = pick && pick.format;
    }
    if (format) { provider.setValueFormat(e, undefined, { valueFormat: format.startsWith('alias:') ? format : 'alias:' + format }); }
  });

  // Test-only: run a function in the active webview page (VAPORVIEW_E2E=1, set by test/e2e/run.mjs).
  if (process.env.VAPORVIEW_E2E === '1') {
    reg('vaporview.e2e.cmuxEval', async (source: string, args?: unknown) => {
      const panel = cmuxBridge.activePanel();
      if (!panel) { return { error: 'no viewer' }; }
      try { return { result: await cmuxBridge.evalInPage(panel, String(source), args) }; } catch (err) { return { error: String(err) }; }
    });
    // bridge-ready: from the moment `uri`'s document exists (before its webview's first 'ready'), read `refs` again and
    // again (cold: the read cache is cleared each round) for `ms`, and say whether a read saw "reloaded", the data
    // generation moved, and the first 'ready' landed inside the loop (so the reads straddled it).
    reg('vaporview.e2e.cmuxReadyProbe', async (uri: string, refs: string[], ms: number) => {
      const t0 = Date.now();
      let document: ReturnType<typeof provider.getDocumentFromUri>;
      while (!(document = provider.getDocumentFromUri(uri))) {
        if (Date.now() - t0 > 30000) { return { error: 'no document for ' + uri }; }
        await new Promise((r) => setTimeout(r, 2));
      }
      const data = waveformData(document);
      const g0 = data.generation, ready0 = cmuxBridge.readyCount(document);
      const errors: string[] = [];
      let ok = 0, readsBeforeReady = 0, okAfterReady = 0;
      const tEnd = Date.now() + ms;
      while (Date.now() < tEnd) {
        (data as unknown as { cache: Map<number, unknown> }).cache.clear();
        const before = cmuxBridge.readyCount(document) === 0;
        try {
          for (const r of refs) { await data.signalChanges(r); }
          ok++;
          if (before) { readsBeforeReady++; } else { okAfterReady++; }
        } catch (err) {
          const m = String(err);
          if (/reloaded/.test(m)) { errors.push(m); } else if (!/no variable|not loaded|no netlist/i.test(m)) { errors.push(m); }
          await new Promise((r) => setTimeout(r, 2));
        }
      }
      return { result: { g0, g1: data.generation, ready0, ready1: cmuxBridge.readyCount(document), ok, readsBeforeReady, okAfterReady, errors: errors.slice(0, 5), nErrors: errors.length } };
    });
    reg('vaporview.e2e.cmuxData', async (method: string, ...args: unknown[]) => {
      const document = cmuxBridge.activeDocument();
      if (!document) { return { error: 'no viewer' }; }
      const data = waveformData(document) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      try {
        const r = await data[method](...args);
        // Typed arrays don't survive executeCommand's JSON: send them as plain arrays.
        const plain = (v: any): any => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
        return { result: plain(r) };
      } catch (err) { return { error: String(err) }; }
    });
    // Terminal links: the registered providers' links for `line`, and the one covering `column` handled as a
    // click would (VS Code has no API to click a terminal link from a test).
    reg('vaporview.e2e.terminalLink', async (line: string, column?: number) => {
      const providers = [terminalLinkProviders.timestamp, ...terminalLinkProviders.netlist] as any[];
      const context = { line: String(line), terminal: undefined } as unknown as vscode.TerminalLinkContext;
      const found: { provider: any; link: any }[] = [];
      for (const p of providers) {
        if (!p) { continue; }
        for (const link of (await p.provideTerminalLinks(context, new vscode.CancellationTokenSource().token)) || []) { found.push({ provider: p, link }); }
      }
      const hit = typeof column === 'number' ? found.find((f) => column >= f.link.startIndex && column < f.link.startIndex + f.link.length) : undefined;
      if (hit) { await hit.provider.handleTerminalLink(hit.link); }
      return { links: found.map((f) => ({ type: f.link.type, text: String(line).substr(f.link.startIndex, f.link.length) })), handled: hit ? hit.link.type : null };
    });
    // Perf baseline (test/e2e/suite/bridge-perf.test.cjs): a data.ts read timed in the extension host.
    reg('vaporview.e2e.cmuxDataTimed', async (method: string, ...args: unknown[]) => {
      const document = cmuxBridge.activeDocument();
      if (!document) { return { error: 'no viewer' }; }
      const data = waveformData(document) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      try {
        const t0 = performance.now();
        const r = await data[method](...args);
        return { ms: performance.now() - t0, ok: !!r };
      } catch (err) { return { error: String(err) }; }
    });
  }
}
