// vscode-port: hooks document.ts calls around sessions, filled in by src/cmux (no imports here, so document.ts
// can import this without a cycle). Default: no change.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const sessionHooks = {
  /** Called with the session object getWebviewSession() builds; returns it (cmux adds cmuxValueAliases). */
  extendSession: <T>(_document: any, session: T): T => session,
  /** Called first in applySessionState (before 'apply-state' is posted). */
  beforeApplySession: (_document: any, _session: any, _stateChangeType: number): void => {},
  /** Called first in document.reload() (a real file reload; the bridge bumps the data generation). */
  onReload: (_document: any): void => {},
};
