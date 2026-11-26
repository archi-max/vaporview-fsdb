// vscode-port: loaded after the cmux modules. Their toasts become VS Code notifications. GPL-3.0.
(function () {
  'use strict';
  const host = window.cmuxWaveform.host;
  if (window.cmuxUI) {
    window.cmuxUI.toast = (message, kind) => host.toNative({ type: 'toast', message: String(message || ''), kind: kind || 'info' });
  }
  host.toNative({ type: 'modulesLoaded', modules: Object.keys(window.cmuxWaveform).sort() });
})();
