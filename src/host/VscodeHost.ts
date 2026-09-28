import * as vscode from 'vscode';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChatHost } from '../chat/ChatController';
import type { HostToWebview } from '../chat/protocol';
import type { EditorState } from '../context/ContextBuilder';
import type { DiagnosticEntry, DiagnosticSeverity } from '../context/DiagnosticsContext';
import type { WorkspaceIndexer } from '../context/WorkspaceIndexer';
import { OllamaClient } from '../ollama/OllamaClient';
import { detectOllama } from '../ollama/OllamaDetector';
import type { Settings } from '../settings/settings';
import { normalizeSettings, SETTING_KEYS } from '../settings/settings';
import type { TranscriptStore } from '../interview/TranscriptStore';
import type { TranscriptSession } from '../interview/Transcript';
import { COMMANDS, ID, STATE_KEYS } from '../constants';
import type { Logger } from '../utils/logger';

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration(ID);
  const raw: Partial<Record<keyof Settings, unknown>> = {};
  for (const key of SETTING_KEYS) raw[key] = cfg.get(key);
  return normalizeSettings(raw);
}

const SEVERITY: Record<vscode.DiagnosticSeverity, DiagnosticSeverity> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

/** Implements ChatHost on top of the VS Code API. */
export class VscodeHost implements ChatHost {
  private poster: ((m: HostToWebview) => void) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly indexer: WorkspaceIndexer,
    private readonly transcripts: TranscriptStore,
    private readonly logger: Logger,
  ) {}

  setPoster(poster: ((m: HostToWebview) => void) | undefined): void {
    this.poster = poster;
  }

  post(message: HostToWebview): void {
    this.poster?.(message);
  }

  getSettings(): Settings {
    return readSettings();
  }

  async updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(ID);
    const inspect = cfg.inspect(key);
    // Write where the user already set it; default to user (global) settings.
    const target =
      inspect?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspect?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await cfg.update(key, value, target);
  }

  async confirm(message: string, detail: string, confirmLabel: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel);
    return choice === confirmLabel;
  }

  getEditorState(): EditorState {
    const editor = vscode.window.activeTextEditor;
    const state: EditorState = { openFiles: [] };
    for (const e of vscode.window.visibleTextEditors) {
      const rel = this.indexer.toRelative(e.document.uri);
      if (rel && !state.openFiles.includes(rel)) state.openFiles.push(rel);
    }
    if (!editor) return state;
    const rel = this.indexer.toRelative(editor.document.uri);
    // Only files inside the workspace are ever sent as context.
    if (!rel) return state;
    state.activeFile = { relPath: rel, content: editor.document.getText() };
    const sel = editor.selection;
    if (!sel.isEmpty) {
      state.selection = {
        relPath: rel,
        startLine: sel.start.line + 1,
        endLine: sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1),
        text: editor.document.getText(sel),
      };
    }
    return state;
  }

  getDiagnostics(): DiagnosticEntry[] {
    const out: DiagnosticEntry[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const rel = this.indexer.toRelative(uri);
      if (!rel) continue;
      for (const d of diags) {
        out.push({
          relPath: rel,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: SEVERITY[d.severity],
          message: d.message,
          source: d.source,
          code:
            typeof d.code === 'object'
              ? String(d.code.value)
              : d.code !== undefined
                ? String(d.code)
                : undefined,
        });
      }
    }
    return out;
  }

  hasWorkspace(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  }

  workspaceName(): string {
    return vscode.workspace.name ?? 'No workspace';
  }

  createClient(endpoint: string): OllamaClient {
    return new OllamaClient(endpoint, undefined, this.logger);
  }

  detectOllama(endpoint: string, client: OllamaClient) {
    return detectOllama(endpoint, () => client.checkConnection(), {
      platform: process.platform,
      env: process.env,
      homedir: os.homedir(),
      exists: async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  async saveConversation(data: unknown): Promise<void> {
    await this.context.workspaceState.update(STATE_KEYS.conversation, data);
  }

  isOnboardingComplete(): boolean {
    return this.context.globalState.get<boolean>(STATE_KEYS.onboardingComplete) === true;
  }

  async setOnboardingComplete(): Promise<void> {
    await this.context.globalState.update(STATE_KEYS.onboardingComplete, true);
  }

  async saveTranscript(session: TranscriptSession): Promise<void> {
    await this.transcripts.save(session);
  }

  newId(): string {
    return randomUUID();
  }

  showError(message: string): void {
    void vscode.window.showErrorMessage(message, 'View Logs').then((choice) => {
      if (choice === 'View Logs') void vscode.commands.executeCommand(COMMANDS.viewLogs);
    });
  }
}
