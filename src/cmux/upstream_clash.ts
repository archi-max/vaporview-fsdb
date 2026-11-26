// SPDX-License-Identifier: GPL-3.0-or-later
// vscode-port: VaporView FSDB keeps upstream VaporView's `vaporview.*` command and setting ids and its
// waveform editor id, so the two cannot both run in one VS Code. On activation, if upstream
// VaporView is installed AND enabled (disabled extensions are not in vscode.extensions), say so once, clearly, with a
// button that opens the Extensions view on each extension so the user can disable one.
// Runs first in activate(): upstream may already have registered the shared commands, and then our own registration
// fails part-way, so the message must come before that.
import * as vscode from 'vscode';

export const UPSTREAM_ID = 'lramseyer.vaporview';

// test-only: what was shown (read by the e2e suite through 'vaporview.e2e.upstreamClash' when VAPORVIEW_E2E=1)
let shown: { message: string; buttons: string[] } | null = null;

export function checkUpstreamClash(context: vscode.ExtensionContext): boolean {
  const ourId = context.extension.id;
  if (process.env.VAPORVIEW_E2E === '1') {
    try {
      context.subscriptions.push(vscode.commands.registerCommand('vaporview.e2e.upstreamClash', () => ({ shown, upstreamEnabled: !!vscode.extensions.getExtension(UPSTREAM_ID) })));
    } catch { /* already registered */ }
  }
  if (ourId.toLowerCase() === UPSTREAM_ID) { return false; }
  const upstream = vscode.extensions.getExtension(UPSTREAM_ID);
  if (!upstream) { return false; }
  // the product name (displayName "VaporView FSDB"); fall back to it if the manifest has none
  const ours = String(context.extension.packageJSON.displayName || 'VaporView FSDB');
  const theirs = `${upstream.packageJSON.displayName || 'VaporView'} (${UPSTREAM_ID})`;
  const message = `${ours} and ${theirs} are both enabled. They register the same commands, settings and waveform editor, ` +
    `so only one of them can work. Disable one of them, then reload the window.`;
  const showUpstream = `Show ${upstream.packageJSON.displayName || 'VaporView'}`;
  const showOurs = `Show ${ours}`;
  shown = { message, buttons: [showUpstream, showOurs] };
  void vscode.window.showWarningMessage(message, showUpstream, showOurs).then((pick) => {
    if (pick === showUpstream) { void vscode.commands.executeCommand('workbench.extensions.search', `@id:${UPSTREAM_ID}`); }
    else if (pick === showOurs) { void vscode.commands.executeCommand('workbench.extensions.search', `@id:${ourId}`); }
  });
  return true;
}
