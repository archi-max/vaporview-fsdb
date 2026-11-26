// vscode-port P4: minimal Debug Adapter Protocol plumbing for an inline adapter (vscode.DebugAdapterInlineImplementation),
// so the extension needs no @vscode/debugadapter dependency.
import * as vscode from 'vscode';

export type Request = { seq: number; type: 'request'; command: string; arguments?: any };

export abstract class InlineAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private seq = 1;

  protected abstract dispatch(command: string, args: any, request: Request): Promise<any>;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const m = message as any;
    if (m.type !== 'request') { return; }
    const request = m as Request;
    this.dispatch(request.command, request.arguments || {}, request).then(
      (body) => this.respond(request, true, body),
      (error) => this.respond(request, false, undefined, error instanceof Error ? error.message : String(error)));
  }

  protected respond(request: Request, success: boolean, body?: any, message?: string) {
    this.emitter.fire({ seq: this.seq++, type: 'response', request_seq: request.seq, command: request.command, success, message,
      body: success ? (body ?? {}) : { error: { id: 1, format: message || 'error', showUser: false } } } as any);
  }

  sendEvent(event: string, body?: any) {
    this.emitter.fire({ seq: this.seq++, type: 'event', event, body: body ?? {} } as any);
  }

  output(text: string, category: 'console' | 'stdout' | 'stderr' | 'important' = 'console') {
    this.sendEvent('output', { category, output: text.endsWith('\n') ? text : text + '\n' });
  }

  dispose() { this.emitter.dispose(); }
}
