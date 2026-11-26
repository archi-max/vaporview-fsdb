// vscode-port #13
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';

/** vscode-port (#13): a read slower than 300 ms says so in the status bar ("Reading N signals from the dump…"), so a
 *  reader's one-time first touch of each signal (CVA6 FSDB: ~7 s for 276 signals; later reads in ms) is not mistaken
 *  for a hang. Count of shown notes for the e2e hook. */
export const readingNotes = { shown: 0, last: '' };
export async function withReadingNote<T>(n: number, p: Promise<T>): Promise<T> {
  let note: vscode.Disposable | null = null;
  const timer = setTimeout(() => {
    readingNotes.shown++; readingNotes.last = `$(sync~spin) Reading ${n} signal${n === 1 ? '' : 's'} from the dump…`;
    note = vscode.window.setStatusBarMessage(readingNotes.last);
  }, 300);
  try { return await p; } finally { clearTimeout(timer); (note as vscode.Disposable | null)?.dispose(); }
}
