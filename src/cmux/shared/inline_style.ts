// vscode-port (shared by the source link and the debugger, so the two never drift; mock v2 as the user approved
// it): values drawn after SystemVerilog lines as quiet text: the theme's CodeLens foreground (a real theme token, so
// high-contrast themes work) at 75% (about #7a7a7a on Dark Modern, the mock's tone), regular weight, a 2em gap, and no
// background, border or box (VS Code's own inline values draw yellow chips). "no value" is the same at 50%: it differs
// from a value by text and tone, never by a colour box. Text format: "name = value", entries two spaces apart, a change
// "name = a → b". (After-text has no opacity option; textDecoration is the only CSS hook.)
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';

export const INLINE_VALUE_STYLE: vscode.ThemableDecorationAttachmentRenderOptions = {
  color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em', textDecoration: 'none; opacity: 0.75',
};
export const INLINE_NO_VALUE_STYLE: vscode.ThemableDecorationAttachmentRenderOptions = {
  ...INLINE_VALUE_STYLE, textDecoration: 'none; opacity: 0.5',
};
/** Entries on one line are this far apart. */
export const INLINE_SEPARATOR = '  ';

// vscode-port: the no-value tag lives with the value formatter (no vscode import: unit-tested)
export { noValueTag, noValueInline, NO_VALUE_ENTRY } from './value_format';
