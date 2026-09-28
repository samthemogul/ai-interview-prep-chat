import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ChatController } from './ChatController';
import type { Chips, HostToWebview, Mode, WebviewToHost } from './protocol';
import type { VscodeHost } from '../host/VscodeHost';
import type { WorkspaceIndexer } from '../context/WorkspaceIndexer';
import {
  CHAT_VIEW_ID,
  COMMANDS,
  EXTENSION_DISPLAY_NAME,
  OLLAMA_DOWNLOAD_URL,
  OLLAMA_LIBRARY_URL,
} from '../constants';
import { toSafeRelativePath } from '../context/References';
import type { Logger } from '../utils/logger';

const CHIP_KEYS: ReadonlyArray<keyof Chips> = ['currentFile', 'selection', 'diagnostics'];

/** Hosts the chat webview in the sidebar and routes its messages. */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = CHAT_VIEW_ID;

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private queue: HostToWebview[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private editorTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly host: VscodeHost,
    private readonly indexer: WorkspaceIndexer,
    private readonly logger: Logger,
  ) {
    host.setPoster((m) => this.post(m));
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleEditorUpdate()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleEditorUpdate()),
    );
  }

  dispose(): void {
    if (this.editorTimer) clearTimeout(this.editorTimer);
    for (const d of this.disposables) d.dispose();
    this.host.setPoster(undefined);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m), null, this.disposables);
    view.onDidChangeVisibility(() => this.controller.setVisible(view.visible), null, this.disposables);
    view.onDidDispose(
      () => {
        this.view = undefined;
        this.ready = false;
        this.controller.setVisible(false);
      },
      null,
      this.disposables,
    );
    this.indexer.warmUp();
  }

  /** Reveals the chat view, creating it if necessary. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }

  post(message: HostToWebview): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    } else if (message.type === 'prefill' || message.type === 'focusInput') {
      this.queue.push(message);
    }
  }

  /** Puts text in the composer, optionally sending it right away. */
  async prefill(text: string, send = false): Promise<void> {
    await this.reveal();
    if (send && this.ready) {
      await this.controller.send(text, { currentFile: false, selection: false, diagnostics: false });
      return;
    }
    this.post({ type: 'prefill', text, send });
  }

  private scheduleEditorUpdate(): void {
    if (!this.view || !this.ready) return;
    if (this.editorTimer) clearTimeout(this.editorTimer);
    this.editorTimer = setTimeout(() => {
      const e = this.host.getEditorState();
      this.post({
        type: 'editor',
        activeFile: e.activeFile?.relPath,
        hasSelection: !!e.selection?.text.trim(),
      });
    }, 150);
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
    const m = raw as WebviewToHost;
    try {
      switch (m.type) {
        case 'ready': {
          this.ready = true;
          this.controller.postState();
          this.controller.setVisible(this.view?.visible ?? true);
          const queued = this.queue;
          this.queue = [];
          for (const q of queued) {
            if (q.type === 'prefill' && q.send) {
              await this.controller.send(q.text, {
                currentFile: false,
                selection: false,
                diagnostics: false,
              });
            } else {
              this.post(q);
            }
          }
          break;
        }
        case 'send':
          if (typeof m.text === 'string') {
            await this.controller.send(m.text.slice(0, 50_000), sanitizeChips(m.chips));
          }
          break;
        case 'stop':
          this.controller.stop();
          break;
        case 'retry':
          if (typeof m.id === 'string') await this.controller.retry(m.id);
          break;
        case 'clear':
          await this.controller.clearConversation();
          break;
        case 'newConversation':
          await this.controller.newConversation();
          break;
        case 'selectModel':
          if (typeof m.name === 'string') await this.controller.selectModel(m.name);
          break;
        case 'refreshModels':
        case 'checkOllama':
          await this.controller.refreshOllama();
          break;
        case 'setMode':
          if (isMode(m.mode)) await this.controller.setMode(m.mode);
          break;
        case 'setChip':
          if (CHIP_KEYS.includes(m.chip)) this.controller.setChip(m.chip, m.value === true);
          break;
        case 'completeOnboarding':
          if (isMode(m.mode)) await this.controller.completeOnboarding(m.mode);
          break;
        case 'openInstallPage':
          await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD_URL));
          break;
        case 'openModelLibrary':
          await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_LIBRARY_URL));
          break;
        case 'downloadModel':
          await vscode.commands.executeCommand(
            COMMANDS.downloadModel,
            typeof m.name === 'string' ? m.name : undefined,
          );
          break;
        case 'openSettings':
          await vscode.commands.executeCommand(COMMANDS.openSettings);
          break;
        case 'viewLogs':
          await vscode.commands.executeCommand(COMMANDS.viewLogs);
          break;
        case 'reviewTranscript':
          await vscode.commands.executeCommand(COMMANDS.reviewTranscript);
          break;
        case 'copy':
          if (typeof m.text === 'string') await vscode.env.clipboard.writeText(m.text);
          break;
        case 'openFile':
          await this.openFile(m.relPath, m.line);
          break;
      }
    } catch (err) {
      this.logger.error(
        `Webview message "${m.type}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Opens a workspace file referenced in a chat message. Paths outside the workspace are refused. */
  private async openFile(relPath: unknown, line: unknown): Promise<void> {
    if (typeof relPath !== 'string' || !toSafeRelativePath(relPath)) return;
    const uri = this.indexer.resolve(relPath);
    if (!uri) return;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showInformationMessage(
        `${EXTENSION_DISPLAY_NAME}: \`${relPath}\` was not found in the workspace.`,
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const n = typeof line === 'number' && line > 0 ? Math.min(line, doc.lineCount) - 1 : 0;
    const pos = new vscode.Position(n, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...p));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('media', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${asset('dist', 'webview.css')}">
<title>${EXTENSION_DISPLAY_NAME}</title>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
}

function isMode(v: unknown): v is Mode {
  return v === 'guarded' || v === 'normal';
}

function sanitizeChips(c: unknown): Chips {
  const o = (c ?? {}) as Record<string, unknown>;
  return {
    currentFile: o.currentFile === true,
    selection: o.selection === true,
    diagnostics: o.diagnostics === true,
  };
}
