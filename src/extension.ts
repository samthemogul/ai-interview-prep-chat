import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatController } from './chat/ChatController';
import { ChatState } from './chat/ChatState';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { registerCommands, TranscriptContentProvider } from './commands/commands';
import { ContextRetriever } from './context/ContextRetriever';
import { WorkspaceIndexer } from './context/WorkspaceIndexer';
import { VscodeHost, readSettings } from './host/VscodeHost';
import { VscodeEditHost } from './host/VscodeEditHost';
import { TranscriptStore } from './interview/TranscriptStore';
import type { Settings } from './settings/settings';
import { SETTING_KEYS, isLocalEndpoint } from './settings/settings';
import { ChannelLogger } from './utils/logger';
import { EXTENSION_DISPLAY_NAME, ID, STATE_KEYS, TRANSCRIPT_SCHEME } from './constants';

let controller: ChatController | undefined;

/**
 * Activation is lazy: VS Code activates the extension when the chat view is opened or a
 * command runs. Nothing here contacts Ollama or indexes files; that starts when the view
 * becomes visible or the user sends a message.
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(EXTENSION_DISPLAY_NAME);
  const logger = new ChannelLogger(channel, () => readSettings().debugLogging);
  context.subscriptions.push(channel);
  logger.info(`${EXTENSION_DISPLAY_NAME} ${context.extension.packageJSON.version ?? ''} activated`);

  const indexer = new WorkspaceIndexer(logger);
  const transcriptDir = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'transcripts');
  const transcripts = new TranscriptStore(transcriptDir);
  const host = new VscodeHost(context, indexer, transcripts, logger);
  const state = ChatState.restore(context.workspaceState.get(STATE_KEYS.conversation), () => randomUUID());

  const editHost = new VscodeEditHost(indexer);
  context.subscriptions.push(editHost);

  controller = new ChatController({
    host,
    state,
    source: indexer,
    retriever: new ContextRetriever(indexer),
    logger,
    edits: editHost,
  });

  const provider = new ChatViewProvider(context.extensionUri, controller, host, indexer, logger);
  context.subscriptions.push(
    indexer,
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      TRANSCRIPT_SCHEME,
      new TranscriptContentProvider(transcripts),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(ID)) return;
      const changed = SETTING_KEYS.filter((k) => e.affectsConfiguration(`${ID}.${k}`)) as Array<
        keyof Settings
      >;
      if (changed.includes('ollamaEndpoint')) warnIfRemote();
      void controller?.onSettingsChanged(changed);
    }),
    { dispose: () => controller?.dispose() },
  );

  registerCommands({ context, controller, provider, indexer, transcripts, logger });
  warnIfRemote();
}

/** The whole point is local processing, so make a non-local endpoint impossible to miss. */
function warnIfRemote(): void {
  const endpoint = readSettings().ollamaEndpoint;
  if (!isLocalEndpoint(endpoint)) {
    void vscode.window.showWarningMessage(
      `${EXTENSION_DISPLAY_NAME}: the Ollama endpoint (${endpoint}) is not on this machine. Your code and questions will be sent to that server.`,
    );
  }
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
