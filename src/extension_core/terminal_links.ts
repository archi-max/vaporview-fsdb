import * as vscode from 'vscode';
import type { WaveformViewerProvider, VaporviewDocumentDelegate } from './viewer_provider';
import { findTimeLinks, findPathLinks, terminalLinkProviders } from '../cmux/terminal_links'; // vscode-port: cmux's link patterns


interface CustomTerminalLink extends vscode.TerminalLink {data: string; type: string; time?: number; units?: string;} // vscode-port: time, units
export class TimestampLinkProvider implements vscode.TerminalLinkProvider {

  // Terminal link provider code
  // Detect UVM timestamps - ie: @ 1234
  private readonly uvmTimestampRegex  = /@\s+(\d+)/g;
  // Detect timestamps with units - ie: 1.234 ns
  // vscode-port: times with units are found by findTimeLinks (cmux pattern)
  // Detect surver URL - ie: http://192.168.1.100:8080
  private readonly surverUrlRegex     = /surfer\s+(https?:\/\/[^\s]+)/g;

  constructor(private readonly viewerProvider: WaveformViewerProvider) {terminalLinkProviders.timestamp = this;} // vscode-port: e2e

  provideTerminalLinks(context: vscode.TerminalLinkContext, token: vscode.CancellationToken) {

    // vscode-port: cmux's time patterns (src/cmux/terminal_links.ts): no times inside words, µ/μ, '@ N' in dump units
    const surverUrlMatches          = [...context.line.matchAll(this.surverUrlRegex)];
    const timeLinks = findTimeLinks(context.line).map((l) => ({
      startIndex: l.startIndex,
      length: l.length,
      tooltip: l.kind === 'uvm-timestamp' ? 'Go to time: ' + l.time + ' in waveform viewer' : 'Go to ' + l.time + ' ' + l.units + ' in waveform viewer',
      data: context.line.substr(l.startIndex, l.length),
      type: l.kind,
      time: l.time,
      units: l.units,
    } as CustomTerminalLink));

    const surverUrlLinks = surverUrlMatches.map(match => {
      const line       = context.line;
      const startIndex = match.index ?? line.indexOf(match[0]);

      return {
        startIndex,
        length: match[0].length,
        tooltip: 'Open remote viewer: ' + match[1],
        data: match[0],
        type: 'surver-url'
      } as CustomTerminalLink;
    });

    return [...timeLinks, ...surverUrlLinks]; // vscode-port
  }

  handleTerminalLink(link: CustomTerminalLink) {

    switch (link.type) {
      case 'uvm-timestamp': {
        const time = link.time ?? parseInt([...link.data.matchAll(this.uvmTimestampRegex)][0][1]); // vscode-port
        this.viewerProvider.log.appendLine('UVM Timestamp link clicked: ' + time);
        this.viewerProvider.setMarkerAtTime(time, 0);
        break;
      }
      case 'timestamp-with-units': {
        const time       = link.time!;  // vscode-port: parsed by findTimeLinks
        const units      = link.units!;
        this.viewerProvider.log.appendLine("Timestamp with units link clicked: " + time + '; units: ' + units);
        this.viewerProvider.setMarkerAtTimeWithUnits(time, units, 0);
        break;
      }
      case 'surver-url': {
        const url = [...link.data.matchAll(this.surverUrlRegex)][0][1];
        this.viewerProvider.log.appendLine("Surver URL link clicked: " + url);
        vscode.window.showInputBox({
          prompt: 'Enter bearer token (optional)',
          password: true,
          value: ''
        }).then(bearerToken => {
          this.viewerProvider.openRemoteViewer(url, bearerToken);
        });
        break;
      }
    }
  }
}

export class NetlistLinkProvider implements vscode.TerminalLinkProvider {

  // Terminal link provider code
  // Detect netlist elements in the terminal - ie: top.submodule.signal

  // vscode-port: cmux's instance-path pattern (src/cmux/terminal_links.ts): a path must start at one of the dump's
  // top scopes (however many), no '/', and `tb.sv`-style file names are not paths.
  constructor(
    private delegate: VaporviewDocumentDelegate,
    private scopeTop: string[]
  ) {
    terminalLinkProviders.netlist.add(this); // vscode-port: e2e
  }

  provideTerminalLinks(context: vscode.TerminalLinkContext, token: vscode.CancellationToken) {
    return findPathLinks(context.line, this.scopeTop).map((l) => ({
      startIndex: l.startIndex,
      length: l.length,
      tooltip: 'Add "' + l.path + '" to waveform viewer',
      data: l.path,
      type: 'netlist-element'
    } as CustomTerminalLink));
  }

  handleTerminalLink(link: CustomTerminalLink) {
    //console.log("Netlist element link clicked: " + link.data);
    this.delegate.addSignalByNameToDocument(link.data);
    this.delegate.logOutputChannel('Terminal link clicked: ' + link.data);
  }
}