import * as vscode from 'vscode';
import * as os from 'node:os';
import type { ChatController } from '../chat/ChatController';
import type { ChatViewProvider } from '../chat/ChatViewProvider';
import type { WorkspaceIndexer } from '../context/WorkspaceIndexer';
import type { TranscriptStore } from '../interview/TranscriptStore';
import type { TranscriptSession } from '../interview/Transcript';
import { renderTranscriptMarkdown, summarize } from '../interview/Transcript';
import {
  CHAT_MODE_DESCRIPTIONS,
  CHAT_MODE_LABELS,
  CHAT_MODES,
  MODE_LABELS,
} from '../interview/InterviewMode';
import { isValidModelName, SUGGESTED_MODELS, formatBytes } from '../ollama/OllamaModels';
import { OllamaClient } from '../ollama/OllamaClient';
import { normalizeEndpoint } from '../settings/settings';
import { readSettings } from '../host/VscodeHost';
import {
  COMMANDS,
  EXTENSION_DISPLAY_NAME,
  OLLAMA_DOWNLOAD_URL,
  OLLAMA_LIBRARY_URL,
  PROPOSED_EDIT_SCHEME,
  TRANSCRIPT_SCHEME,
} from '../constants';
import type { ChannelLogger } from '../utils/logger';
import { describeForLog, isAbortError, toUserMessage, USER_MESSAGES } from '../utils/errors';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  controller: ChatController;
  provider: ChatViewProvider;
  indexer: WorkspaceIndexer;
  transcripts: TranscriptStore;
  logger: ChannelLogger;
}

const NO_CHIPS = { currentFile: false, selection: false, diagnostics: false };

/** Read-only virtual documents for transcripts, so reviewing never creates files. */
export class TranscriptContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: TranscriptStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const id = uri.path.replace(/^\//, '').replace(/\.md$/, '');
    const session = await this.store.load(id);
    return session ? renderTranscriptMarkdown(session) : '# Transcript not found\n';
  }
}

function fileRef(relPath: string): string {
  return /\s/.test(relPath) ? `@file:"${relPath}"` : `@file:${relPath}`;
}

export function registerCommands(d: CommandDeps): void {
  const { context, controller, provider, indexer, transcripts, logger } = d;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          logger.error(`Command ${id} failed: ${describeForLog(err)}`);
          void vscode.window
            .showErrorMessage(`${EXTENSION_DISPLAY_NAME}: ${toUserMessage(err)}`, 'View Logs')
            .then((c) => {
              if (c) logger.show();
            });
        }
      }),
    );

  const requireSelection = (): boolean => {
    const e = vscode.window.activeTextEditor;
    if (!e || e.selection.isEmpty) {
      void vscode.window.showInformationMessage(`${EXTENSION_DISPLAY_NAME}: select some code first.`);
      return false;
    }
    if (!indexer.toRelative(e.document.uri)) {
      void vscode.window.showInformationMessage(
        `${EXTENSION_DISPLAY_NAME} only uses files inside the open workspace.`,
      );
      return false;
    }
    return true;
  };

  const sendNow = async (text: string) => {
    await provider.reveal();
    await controller.send(text, NO_CHIPS);
  };

  reg(COMMANDS.openChat, () => provider.reveal());
  reg(COMMANDS.newConversation, () => controller.newConversation());
  reg(COMMANDS.clearConversation, () => controller.clearConversation());

  reg(COMMANDS.explainSelection, async () => {
    if (requireSelection()) await sendNow('Explain what @selection does.');
  });
  reg(COMMANDS.askAboutSelection, async () => {
    if (requireSelection()) await provider.prefill('@selection ');
  });
  reg(COMMANDS.findPotentialIssues, async () => {
    if (!requireSelection()) return;
    if (controller.currentMode === 'guarded') {
      await sendNow(
        'Ask me a few guiding questions that would help me find problems in @selection myself. Do not point out the problems directly.',
      );
    } else {
      await sendNow('What potential bugs, edge cases or issues do you see in @selection?');
    }
  });
  reg(COMMANDS.askGuidingQuestions, async () => {
    if (requireSelection()) {
      await sendNow(
        'Ask me a few guiding questions that would help me find problems in @selection myself. Do not point out the problems directly.',
      );
    }
  });
  reg(COMMANDS.explainCurrentFile, async () => {
    const e = vscode.window.activeTextEditor;
    const rel = e ? indexer.toRelative(e.document.uri) : undefined;
    if (!rel) {
      void vscode.window.showInformationMessage(
        `${EXTENSION_DISPLAY_NAME}: open a file from the workspace first.`,
      );
      return;
    }
    await sendNow(
      `Explain ${fileRef(rel)}: its purpose, its main parts and how it connects to the rest of the codebase.`,
    );
  });
  reg(COMMANDS.explainFile, async (uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    const rel = target ? indexer.toRelative(target) : undefined;
    if (!rel) return;
    await sendNow(
      `Explain ${fileRef(rel)}: its purpose, its main parts and how it connects to the rest of the codebase.`,
    );
  });
  reg(COMMANDS.askAboutFile, async (uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    const rel = target ? indexer.toRelative(target) : undefined;
    if (rel) await provider.prefill(`${fileRef(rel)} `);
  });
  reg(COMMANDS.askAboutWorkspace, () => provider.prefill('@workspace '));

  // Accept / Reject from the diff editor's title bar. The diff's right side carries the edit id.
  const editIdFrom = (arg: unknown): string | undefined => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== PROPOSED_EDIT_SCHEME) return undefined;
    return uri.query.replace(/-original$/, '');
  };
  reg(COMMANDS.acceptEdit, async (arg) => {
    const id = editIdFrom(arg);
    if (id) await controller.editActionById(id, 'accept');
  });
  reg(COMMANDS.rejectEdit, async (arg) => {
    const id = editIdFrom(arg);
    if (id) await controller.editActionById(id, 'reject');
  });

  reg(COMMANDS.switchChatMode, async () => {
    const pick = await vscode.window.showQuickPick(
      CHAT_MODES.map((m) => ({
        label: `${m === 'ask' ? '$(comment)' : m === 'plan' ? '$(checklist)' : '$(tools)'} ${CHAT_MODE_LABELS[m]}`,
        description: m === controller.currentChatMode ? 'current' : undefined,
        detail: CHAT_MODE_DESCRIPTIONS[m],
        mode: m,
      })),
      { title: `${EXTENSION_DISPLAY_NAME}: Chat Mode` },
    );
    if (pick) await controller.setChatMode(pick.mode);
  });

  reg(COMMANDS.toggleInterviewMode, async () => {
    const changed = await controller.toggleMode();
    if (changed) {
      void vscode.window.showInformationMessage(
        `${EXTENSION_DISPLAY_NAME}: ${MODE_LABELS[controller.currentMode]} is on.`,
      );
    }
  });

  reg(COMMANDS.selectModel, async () => {
    await controller.refreshOllama();
    if (controller.connectionState !== 'running') {
      await vscode.commands.executeCommand(COMMANDS.checkOllama);
      return;
    }
    const models = controller.availableModels;
    const items: Array<vscode.QuickPickItem & { name?: string }> = models.map((m) => ({
      label: m.name,
      name: m.name,
      description: [m.parameterSize, formatBytes(m.sizeBytes)].filter(Boolean).join(' · '),
      picked: m.name === controller.currentModel,
      detail: m.name === controller.currentModel ? 'Current model' : undefined,
    }));
    items.push({ label: '$(cloud-download) Download a model…', alwaysShow: true });
    const pick = await vscode.window.showQuickPick(items, {
      title: `${EXTENSION_DISPLAY_NAME}: Select Model`,
      placeHolder: models.length ? 'Choose an installed Ollama model' : USER_MESSAGES['no-models'],
    });
    if (!pick) return;
    if (!pick.name) {
      await vscode.commands.executeCommand(COMMANDS.downloadModel);
      return;
    }
    await controller.selectModel(pick.name);
  });

  reg(COMMANDS.downloadModel, async (preset) => {
    const endpoint = normalizeEndpoint(readSettings().ollamaEndpoint);
    if (!endpoint) {
      void vscode.window.showErrorMessage(USER_MESSAGES['invalid-endpoint']);
      return;
    }
    await controller.refreshOllama();
    if (controller.connectionState !== 'running') {
      await vscode.commands.executeCommand(COMMANDS.checkOllama);
      return;
    }
    let name = typeof preset === 'string' && isValidModelName(preset) ? preset : undefined;
    let size = SUGGESTED_MODELS.find((m) => m.name === name)?.approxSize;
    if (!name) {
      const items: Array<vscode.QuickPickItem & { value?: string; size?: string }> = SUGGESTED_MODELS.map(
        (m) => ({
          label: m.name,
          description: m.approxSize,
          detail: m.description,
          value: m.name,
          size: m.approxSize,
        }),
      );
      items.push({ label: '$(edit) Enter another model name…', value: '' });
      items.push({ label: '$(link-external) Browse the Ollama model library', value: '__library' });
      const pick = await vscode.window.showQuickPick(items, {
        title: 'Download an Ollama model',
        placeHolder: 'Models are downloaded by your local Ollama and stay on this machine',
      });
      if (!pick) return;
      if (pick.value === '__library') {
        await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_LIBRARY_URL));
        return;
      }
      if (pick.value) {
        name = pick.value;
        size = pick.size;
      } else {
        const typed = await vscode.window.showInputBox({
          title: 'Model name',
          prompt: 'For example qwen2.5-coder:7b or llama3.2:3b',
          validateInput: (v) => (isValidModelName(v) ? undefined : 'Enter a valid Ollama model name'),
        });
        if (!typed) return;
        name = typed.trim();
      }
    }
    // Never download multi-gigabyte files without explicit confirmation (spec 4.8).
    const ok = await vscode.window.showWarningMessage(
      `Download ${name}?`,
      {
        modal: true,
        detail: `Ollama will download ${size ? `about ${size.replace('~', '')}` : 'this model (it can be several gigabytes)'} from the Ollama registry to this machine. After that, ${EXTENSION_DISPLAY_NAME} works offline.`,
      },
      'Download',
    );
    if (ok !== 'Download') return;

    const client = new OllamaClient(endpoint, undefined, logger);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${name}`, cancellable: true },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        let lastPct = 0;
        try {
          await client.pullModel(
            name!,
            (p) => {
              if (p.total && p.completed !== undefined) {
                const pct = Math.floor((p.completed / p.total) * 100);
                progress.report({ message: `${p.status} ${pct}%`, increment: Math.max(0, pct - lastPct) });
                lastPct = pct;
              } else if (p.status) {
                progress.report({ message: p.status });
              }
            },
            ac.signal,
          );
        } catch (err) {
          if (isAbortError(err)) return;
          throw err;
        }
        await controller.refreshOllama();
        if (controller.availableModels.some((m) => m.name === name || m.name === `${name}:latest`)) {
          await controller.selectModel(
            controller.availableModels.find((m) => m.name === name || m.name === `${name}:latest`)!.name,
          );
          void vscode.window.showInformationMessage(`${EXTENSION_DISPLAY_NAME}: ${name} is ready.`);
        }
      },
    );
  });

  reg(COMMANDS.checkOllama, async () => {
    await controller.refreshOllama();
    const state = controller.connectionState;
    if (state === 'running') {
      const n = controller.availableModels.length;
      const msg = n
        ? `Ollama is running with ${n} model${n === 1 ? '' : 's'} installed. Using ${controller.currentModel ?? 'no model yet'}.`
        : `Ollama is running. ${USER_MESSAGES['no-models']}`;
      const action = await vscode.window.showInformationMessage(
        `${EXTENSION_DISPLAY_NAME}: ${msg}`,
        ...(n ? [] : ['Download a Model']),
      );
      if (action) await vscode.commands.executeCommand(COMMANDS.downloadModel);
      return;
    }
    const msg =
      state === 'not-installed'
        ? USER_MESSAGES['ollama-not-installed']
        : state === 'invalid-endpoint'
          ? USER_MESSAGES['invalid-endpoint']
          : `${USER_MESSAGES['ollama-not-running']} Start the Ollama app (or run \`ollama serve\`) and try again.`;
    const actions =
      state === 'not-installed' ? ['Install Ollama', 'View Logs'] : ['Open Settings', 'View Logs'];
    const choice = await vscode.window.showWarningMessage(msg, ...actions);
    if (choice === 'Install Ollama') await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD_URL));
    if (choice === 'Open Settings') await vscode.commands.executeCommand(COMMANDS.openSettings);
    if (choice === 'View Logs') logger.show();
  });

  reg(COMMANDS.openSettings, () =>
    vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
  );

  const pickSession = async (purpose: string): Promise<TranscriptSession | undefined> => {
    const current = controller.currentTranscript;
    const sessions = await transcripts.list();
    if (current && current.events.length && !sessions.some((s) => s.id === current.id)) {
      sessions.unshift(current);
    }
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(
        `${EXTENSION_DISPLAY_NAME}: no transcripts yet. Transcripts are recorded for Guarded Interview Mode sessions.`,
      );
      return undefined;
    }
    if (sessions.length === 1) return sessions[0];
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => {
        const sum = summarize(s);
        return {
          label: `${s.workspaceName} · ${new Date(s.startedAt).toLocaleString()}`,
          description: `${sum.turns} turns · ${sum.flaggedTurns} flagged`,
          detail: s.id === current?.id ? 'Current session' : undefined,
          session: s,
        };
      }),
      { title: purpose },
    );
    return pick?.session;
  };

  reg(COMMANDS.reviewTranscript, async () => {
    const s = await pickSession('Review which session?');
    if (!s) return;
    if (s.id === controller.currentTranscript?.id) await transcripts.save(s);
    const uri = vscode.Uri.from({ scheme: TRANSCRIPT_SCHEME, path: `/${s.id}.md` });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  reg(COMMANDS.exportTranscript, async () => {
    const s = await pickSession('Export which session?');
    if (!s) return;
    const date = s.startedAt.slice(0, 10);
    const safeName = s.workspaceName.replace(/[^\w.-]+/g, '-');
    const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(base, `${safeName}-interview-transcript-${date}.md`),
      filters: { Markdown: ['md'] },
      saveLabel: 'Export Transcript',
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(renderTranscriptMarkdown(s)));
    void vscode.window.showInformationMessage(`${EXTENSION_DISPLAY_NAME}: transcript exported.`);
  });

  reg(COMMANDS.deleteTranscripts, async () => {
    const ok = await vscode.window.showWarningMessage(
      'Delete all practice transcripts?',
      {
        modal: true,
        detail: 'This removes every transcript stored by the extension on this machine. It cannot be undone.',
      },
      'Delete',
    );
    if (ok !== 'Delete') return;
    const n = await transcripts.deleteAll();
    void vscode.window.showInformationMessage(
      `${EXTENSION_DISPLAY_NAME}: deleted ${n} transcript file${n === 1 ? '' : 's'}.`,
    );
  });

  reg(COMMANDS.viewLogs, () => logger.show());
}
