// vscode-port: entry point of the SystemVerilog editor <-> waveform link and its small API for other features.
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import type { WaveformViewerProvider } from '../../extension_core/viewer_provider';
import { SourceLink, LinkedInstance, InlineValue } from './source_link';

/**
 * What the debugger and other features use. All methods are safe to call when no waveform or
 * slang-server is available: they resolve to empty / undefined.
 */
export interface SourceLinkApi {
  /** Signals the given source line assigns (assignment targets, e.g. `x <= ...`, `assign y = ...`), each with its
   *  design path (slang) and its dump path in the current waveform. */
  signalsAssignedOnLine(uri: vscode.Uri, line: number): Promise<{ name: string; designPath: string; dumpPath: string }[]>;
  /** The design instance and dump scope the editor `uri` shows (for `position`: the module around it). */
  instanceAt(uri: vscode.Uri, position?: vscode.Position): Promise<LinkedInstance | undefined>;
  /** Dump path for a design path (mapping: user rules first, then inferred). */
  dumpPathOf(designPath: string, waveformUri?: string): Promise<string | undefined>;
  /** Design path for a dump path. */
  designPathOf(dumpPath: string, waveformUri?: string): Promise<string | undefined>;
  /** Declaration of a dump signal in the source, without asking the user anything (no elaboration). */
  declarationOf(dumpPath: string, waveformUri?: string): Promise<vscode.Location | undefined>;
  /** Lines assigning a declared signal in its declaration's file. */
  driversOf(declaration: vscode.Location): Promise<vscode.Location[]>;
  /** slang arguments for the design the waveform's root compiles (see SourceLink.designForTrace). */
  designForTrace(waveformUri: string, opts?: { waitMs?: number }): Promise<{ args: string[]; root: string; source: string; rebuilt?: boolean } | undefined>;
  /** The module (and its file) to offer as top level for a waveform with no design. */
  topLevelCandidate(waveformUri: string): Promise<{ module: string; file: string } | undefined>;
  /** Last inline values computed for an open editor. */
  inlineValues(uri: vscode.Uri): InlineValue[];
  /** Fires with an editor URI after its inline values were recomputed (marker moved, scroll, mapping change). */
  onDidRefreshInlineValues: vscode.Event<string>;
}

export function registerSourceLink(context: vscode.ExtensionContext, provider: WaveformViewerProvider,
  log: vscode.OutputChannel, events: { onDidSetMarker: vscode.Event<any>; onDidAddVariable: vscode.Event<any> }): SourceLinkApi {
  const link = new SourceLink(context, provider, log, events);
  context.subscriptions.push(link);
  return {
    signalsAssignedOnLine: (uri, line) => link.signalsAssignedOnLine(uri, line).catch(() => []),
    instanceAt: (uri, position) => link.instanceAt(uri, position).catch(() => undefined),
    async dumpPathOf(designPath, waveformUri) {
      const wave = link.waveform.document(waveformUri);
      return wave ? (await link.mapping(wave)).dumpPath(designPath) : undefined;
    },
    async designPathOf(dumpPath, waveformUri) {
      const wave = link.waveform.document(waveformUri);
      return wave ? (await link.mapping(wave)).designPath(dumpPath) : undefined;
    },
    async declarationOf(dumpPath, waveformUri) {
      const wave = link.waveform.document(waveformUri);
      return wave ? link.declaration(dumpPath, wave, false).catch(() => undefined) : undefined;
    },
    driversOf: (decl) => link.drivers(decl).catch(() => []),
    async designForTrace(waveformUri, opts) { const wave = link.waveform.document(waveformUri); return wave ? link.designForTrace(wave, opts) : undefined; },
    async topLevelCandidate(waveformUri) { const wave = link.waveform.document(waveformUri); return wave ? link.topLevelCandidate(wave).catch(() => undefined) : undefined; },
    inlineValues: (uri) => (link as any).inlineByEditor.get(uri.toString()) ?? [],
    onDidRefreshInlineValues: link.onDidRefreshInlineValues,
  };
}

export type { LinkedInstance, InlineValue };
