// Description: This file contains the extension logic for the VaporView extension
import * as vscode from 'vscode';

import { TimestampLinkProvider, NetlistLinkProvider } from './terminal_links';
import { registerVaporviewCommands } from './commands';
import { WaveformViewerProvider, VaporviewDocumentCollection } from './viewer_provider';
import { WCPServer } from './wcp_server';
import { registerE2EHook } from './e2e/hook'; // vscode-port
import { checkUpstreamClash } from '../cmux/upstream_clash'; // vscode-port
import { registerWaveformDebugger } from '../cmux/dap/index'; // vscode-port P4: waveform debugger (DAP)
import { registerSourceLink } from '../cmux/link'; // vscode-port: P5 editor <-> waveform link
import { registerTrace } from '../cmux/trace/index'; // vscode-port
import { activateCmux } from '../cmux'; // vscode-port: cmux bridge, formats, alias files
import type {
  VaporviewApi,
  OpenFileArgs,
  VariableActionArgs,
  SetMarkerArgs,
  GetViewerStateArgs,
  LoadViewerStateArgs,
  GetValuesAtTimeArgs,
  AddVariableByPathArgs,
  ViewerState,
} from '../../packages/vaporview-api/types';

// #region activate()
export async function activate(context: vscode.ExtensionContext): Promise<VaporviewApi> {
  // vscode-port: upstream VaporView enabled too -> same command/editor ids; tell the user and stay out of
  // its way (activating would fail part-way on the shared command ids). Disabling one and reloading resolves it.
  if (checkUpstreamClash(context)) { return undefined as unknown as VaporviewApi; }

  // Load the Wasm module
  const binaryFile = vscode.Uri.joinPath(context.extensionUri, 'target', 'wasm32-unknown-unknown', 'release', 'filehandler.wasm');
  const binaryData = await vscode.workspace.fs.readFile(binaryFile);
  const wasmModule = await WebAssembly.compile(new Uint8Array(binaryData));

  // create an output channel for logging
  const outputLog = vscode.window.createOutputChannel('VaporView FSDB', { log: true })  // vscode-port: name;
  context.subscriptions.push(outputLog);

  // Register Custom Editor Provider (The viewer window)
  // See package.json for more details
  const documentCollection = new VaporviewDocumentCollection(outputLog);
  const viewerProvider     = new WaveformViewerProvider(context, outputLog, wasmModule, documentCollection);

  vscode.window.registerCustomEditorProvider(
    'vaporview.waveformViewer',
    viewerProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    }
  );

  // Initialize WCP Server
  const wcpServer = new WCPServer(viewerProvider, context);
  context.subscriptions.push(wcpServer);

  // Listen for configuration changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('vaporview.wcp.enabled') || e.affectsConfiguration('vaporview.wcp.port')) {
      void wcpServer.updateConfiguration();
    }

    if (e.affectsConfiguration('workbench.colorTheme')) {
      documentCollection.getTokenColorsForTheme();
    }

    // TODO: Check if configuration changes affect vaporview
    documentCollection.updateConfiguration(e);
  }));

  vscode.window.registerTerminalLinkProvider(new TimestampLinkProvider(viewerProvider));

  //vscode.workspace.onDidChangeConfiguration((e) => {viewerProvider.updateConfiguration(e);});
  const markerSetEvent = WaveformViewerProvider.markerSetEventEmitter.event;
  const signalSelectEvent = WaveformViewerProvider.signalSelectEventEmitter.event;
  const addVariableEvent = WaveformViewerProvider.addVariableEventEmitter.event;
  const removeVariableEvent = WaveformViewerProvider.removeVariableEventEmitter.event;
  const valueLinkEvent = WaveformViewerProvider.valueLinkEventEmitter.event;
  const externalDropEvent = WaveformViewerProvider.externalDropEventEmitter.event;

  // Register commands (there are a lot of commands, so we register them in a separate file for cleanliness)
  registerVaporviewCommands(context, outputLog, viewerProvider, documentCollection, wcpServer);
  registerE2EHook(context, () => viewerProvider.e2ePanel(), (uri) => viewerProvider.getDocumentFromUri(uri)); // vscode-port
  const sourceLink = registerSourceLink(context, viewerProvider, outputLog, { onDidSetMarker: markerSetEvent, onDidAddVariable: addVariableEvent }); // vscode-port: P5
  registerWaveformDebugger(context, viewerProvider, WaveformViewerProvider.markerSetEventEmitter.event, sourceLink); // vscode-port P4 (line breakpoints use the P5 link's slang lookups)
  registerTrace(context, viewerProvider, sourceLink); // vscode-port: Trace Driver, Trace to Root (the design: the link's slang design unless trace.designArgs is set)
  activateCmux(context, viewerProvider, outputLog); // vscode-port
  await wcpServer.updateConfiguration();

  outputLog.appendLine('VaporView FSDB Activated');

  vscode.commands.executeCommand('setContext', 'vaporview.activated', true);

  const api: VaporviewApi = {
    // Events
    onDidSetMarker: markerSetEvent,
    onDidSelectSignal: signalSelectEvent,
    onDidAddVariable: addVariableEvent,
    onDidRemoveVariable: removeVariableEvent,
    onDidDropInWaveformViewer: externalDropEvent,
    onDidClickSignalValueLink: valueLinkEvent,

    // Commands
    async openFile(args: OpenFileArgs) {
      await viewerProvider.openFileCommand(args);
    },
    async addVariable(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "add");
    },
    async removeVariable(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "remove");
    },
    async revealInNetlistView(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "reveal");
    },
    async addSignalValueLink(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "addLink");
    },
    setMarker(args: SetMarkerArgs) {
      viewerProvider.markerCommandHandler(args);
    },
    async getOpenDocuments() {
      return viewerProvider.getAllDocumentUris();
    },
    async getViewerState(args?: GetViewerStateArgs) {
      const document = viewerProvider.getDocumentFromOptionalUri(args?.uri);
      if (!document) {return undefined;}
      return document.getWebviewSession() as unknown as ViewerState;
    },
    async loadViewerState(args: LoadViewerStateArgs) {
      await viewerProvider.loadViewerStateCommand(args);
    },
    async getValuesAtTime(args: GetValuesAtTimeArgs) {
      const document = viewerProvider.getDocumentFromOptionalUri(args.uri);
      if (!document) {return [];}
      return document.getValuesAtTime(args);
    },
    async addVariableByInstancePath(args: AddVariableByPathArgs) {
      viewerProvider.addVariableByInstancePathToDocument(args);
    },
    sourceLink, // vscode-port: P5 link API (src/cmux/link/index.ts SourceLinkApi)
  } as VaporviewApi;
  return api;
}

export default WaveformViewerProvider;

export function deactivate() {
  // WCP server cleanup is handled by context subscriptions
  // All resources registered with context.subscriptions are automatically disposed
  vscode.commands.executeCommand('setContext', 'vaporview.activated', undefined);
}
