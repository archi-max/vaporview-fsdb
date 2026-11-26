// vscode-port: the cmux page strings (media/cmux/strings.js, generated from cmux's WaveformViewerStrings.swift by
// tools/import-cmux-modules.sh) for messages the extension shows itself, so the page and the host say the same thing.
// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'fs';
import * as path from 'path';

let cached: Record<string, string> | undefined;

export function pageStrings(extensionPath: string): Record<string, string> {
  if (!cached) {
    const text = fs.readFileSync(path.join(extensionPath, 'media', 'cmux', 'strings.js'), 'utf8');
    cached = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, string>;
  }
  return cached;
}

/** cmux's `%@` placeholders, filled in order. */
export function formatString(text: string, ...args: (string | number)[]): string {
  let i = 0;
  return text.replace(/%(?:(\d+)\$)?@/g, (_m, n?: string) => String(args[n ? Number(n) - 1 : i++] ?? ''));
}
