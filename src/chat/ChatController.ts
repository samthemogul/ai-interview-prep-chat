import type { ChatState, StoredMessage } from './ChatState';
import type { Chips, HostToWebview, Mode, OllamaState, UiModel, ViewState } from './protocol';
import { buildMessages } from './PromptBuilder';
import type { OllamaClient, OllamaModel } from '../ollama/OllamaClient';
import type { OllamaAvailability } from '../ollama/OllamaDetector';
import {
  formatBytes,
  isLikelyChatModel,
  resolveModel,
  sortModels,
  SUGGESTED_MODELS,
} from '../ollama/OllamaModels';
import type { Settings } from '../settings/settings';
import { isLocalEndpoint, normalizeEndpoint } from '../settings/settings';
import type { ContextBundle, EditorState } from '../context/ContextBuilder';
import { buildContext } from '../context/ContextBuilder';
import type { ContextRetriever, WorkspaceSource } from '../context/ContextRetriever';
import type { DiagnosticEntry } from '../context/DiagnosticsContext';
import { parseReferences } from '../context/References';
import type { GuardReport } from '../interview/OutputGuard';
import { OutputGuard, stripLineNumbers } from '../interview/OutputGuard';
import { classifyRequest, turnReminder } from '../interview/RequestClassifier';
import { requiresConfirmation, otherMode, MODE_LABELS } from '../interview/InterviewMode';
import type { TranscriptSession } from '../interview/Transcript';
import { deriveFlags, newSession } from '../interview/Transcript';
import { RequestTracker } from '../utils/cancellation';
import {
  describeForLog,
  isAbortError,
  LARGE_REPO_MESSAGE,
  toUserMessage,
  UserFacingError,
  USER_MESSAGES,
} from '../utils/errors';
import type { Logger } from '../utils/logger';
import { EXTENSION_DISPLAY_NAME, PRIVACY_STATEMENT } from '../constants';

/** Everything the controller needs from VS Code, so the chat logic can be unit tested. */
export interface ChatHost {
  getSettings(): Settings;
  updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
  confirm(message: string, detail: string, confirmLabel: string): Promise<boolean>;
  post(message: HostToWebview): void;
  getEditorState(): EditorState;
  getDiagnostics(): DiagnosticEntry[];
  hasWorkspace(): boolean;
  workspaceName(): string;
  createClient(endpoint: string): OllamaClient;
  detectOllama(endpoint: string, client: OllamaClient): Promise<OllamaAvailability>;
  saveConversation(data: unknown): Promise<void>;
  isOnboardingComplete(): boolean;
  setOnboardingComplete(): Promise<void>;
  saveTranscript(session: TranscriptSession): Promise<void>;
  newId(): string;
  showError(message: string): void;
}

export interface ChatControllerDeps {
  host: ChatHost;
  state: ChatState;
  source: WorkspaceSource & { isLarge?(): boolean };
  retriever: ContextRetriever;
  logger: Logger;
  /** How often to re-check Ollama while it isn't reachable (ms). 0 disables polling. */
  pollIntervalMs?: number;
}

/**
 * Owns the conversation, the Ollama connection state and the send/stop/retry flow.
 * It never touches files or runs commands; the model's output is only ever displayed.
 */
export class ChatController {
  private readonly host: ChatHost;
  private readonly state: ChatState;
  private readonly tracker = new RequestTracker();
  private ollamaState: OllamaState = 'checking';
  private ollamaVersion: string | undefined;
  private models: OllamaModel[] = [];
  private model: string | undefined;
  private modelMissing = false;
  private mode: Mode;
  private chips: Chips = { currentFile: false, selection: false, diagnostics: false };
  private transcript: TranscriptSession | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private refreshing: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: ChatControllerDeps) {
    this.host = deps.host;
    this.state = deps.state;
    this.mode = this.host.getSettings().mode;
  }

  // ---------------------------------------------------------------- view state

  get currentMode(): Mode {
    return this.mode;
  }

  get currentModel(): string | undefined {
    return this.model;
  }

  get isBusy(): boolean {
    return this.tracker.active;
  }

  get availableModels(): readonly OllamaModel[] {
    return this.models;
  }

  get connectionState(): OllamaState {
    return this.ollamaState;
  }

  buildViewState(): ViewState {
    const settings = this.host.getSettings();
    const editor = this.host.getEditorState();
    return {
      mode: this.mode,
      model: this.model,
      models: sortModels(this.models).map<UiModel>((m) => ({
        name: m.name,
        detail: [m.parameterSize, formatBytes(m.sizeBytes)].filter(Boolean).join(' · '),
        chat: isLikelyChatModel(m),
      })),
      ollama: {
        state: this.ollamaState,
        version: this.ollamaVersion,
        endpoint: settings.ollamaEndpoint,
        isLocal: isLocalEndpoint(settings.ollamaEndpoint),
      },
      modelMissing: this.modelMissing,
      showOnboarding: !this.host.isOnboardingComplete(),
      messages: this.state.toUi(),
      busy: this.tracker.active,
      chips: this.chips,
      activeFile: editor.activeFile?.relPath,
      hasSelection: !!editor.selection?.text.trim(),
      hasWorkspace: this.host.hasWorkspace(),
      transcriptsEnabled: settings.saveTranscripts,
      privacy: PRIVACY_STATEMENT,
      displayName: EXTENSION_DISPLAY_NAME,
      suggestedModels: SUGGESTED_MODELS,
    };
  }

  postState(): void {
    if (!this.disposed) this.host.post({ type: 'state', state: this.buildViewState() });
  }

  /** Called when the webview becomes visible or hidden. Ollama is only contacted once visible. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      void this.refreshOllama();
    } else {
      this.stopPolling();
    }
  }

  // ---------------------------------------------------------------- Ollama & models

  /** Re-checks Ollama and the model list. Concurrent calls share one check. */
  refreshOllama(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const settings = this.host.getSettings();
    const endpoint = normalizeEndpoint(settings.ollamaEndpoint);
    if (!endpoint) {
      this.ollamaState = 'invalid-endpoint';
      this.models = [];
      this.postState();
      return;
    }
    const client = this.host.createClient(endpoint);
    const availability = await this.host.detectOllama(endpoint, client);
    if (availability.state !== 'running') {
      this.ollamaState = availability.state;
      this.ollamaVersion = undefined;
      this.models = [];
      this.model = undefined;
      this.deps.logger.info(`Ollama not available at ${endpoint}: ${availability.state}`);
      this.postState();
      this.schedulePoll();
      return;
    }
    this.ollamaState = 'running';
    this.ollamaVersion = availability.version;
    this.stopPolling();
    try {
      this.models = await client.listModels();
    } catch (err) {
      this.deps.logger.warn(`Listing models failed: ${describeForLog(err)}`);
      this.models = [];
    }
    const { model, missing } = resolveModel(settings.model, this.models);
    this.modelMissing = missing;
    this.model = model;
    if (!missing && model && model !== settings.model && settings.model === '') {
      // Remember the automatically chosen model so it stays stable across sessions.
      await this.host.updateSetting('model', model);
    }
    this.deps.logger.debug(
      `Ollama ${availability.version}; ${this.models.length} models; using ${model ?? 'none'}`,
    );
    this.postState();
  }

  private schedulePoll(): void {
    const interval = this.deps.pollIntervalMs ?? 4000;
    if (!interval || !this.visible || this.pollTimer || this.disposed) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.visible && this.ollamaState !== 'running') void this.refreshOllama();
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  async selectModel(name: string): Promise<boolean> {
    if (!this.models.some((m) => m.name === name)) {
      this.host.showError(USER_MESSAGES['model-unavailable']);
      await this.refreshOllama();
      return false;
    }
    this.model = name;
    this.modelMissing = false;
    await this.host.updateSetting('model', name);
    this.postState();
    return true;
  }

  // ---------------------------------------------------------------- modes

  async setMode(to: Mode): Promise<boolean> {
    const from = this.mode;
    if (to === from) {
      this.postState();
      return true;
    }
    if (requiresConfirmation(from, to)) {
      const ok = await this.host.confirm(
        `Switch to ${MODE_LABELS.normal}?`,
        'Normal Mode removes the interview guard: the AI can write solutions for you. The switch is recorded in your practice transcript.',
        'Switch to Normal Mode',
      );
      if (!ok) {
        this.postState();
        return false;
      }
    }
    await this.applyMode(from, to);
    await this.host.updateSetting('mode', to);
    return true;
  }

  toggleMode(): Promise<boolean> {
    return this.setMode(otherMode(this.mode));
  }

  private async applyMode(from: Mode, to: Mode): Promise<void> {
    this.mode = to;
    this.postState();
    if (this.transcript || from === 'guarded') {
      this.ensureTranscript();
      this.transcript!.events.push({ type: 'mode-switch', at: new Date().toISOString(), from, to });
      await this.persistTranscript();
    }
  }

  /** Keeps state in sync when settings are edited directly in the Settings UI. */
  async onSettingsChanged(changed: Array<keyof Settings>): Promise<void> {
    const s = this.host.getSettings();
    if (changed.includes('mode') && s.mode !== this.mode) await this.applyMode(this.mode, s.mode);
    if (changed.includes('ollamaEndpoint') || changed.includes('model')) {
      await this.refreshOllama();
    } else {
      this.postState();
    }
  }

  // ---------------------------------------------------------------- onboarding & chips

  async completeOnboarding(mode: Mode): Promise<void> {
    await this.host.setOnboardingComplete();
    if (mode !== this.mode) {
      // Choosing the mode during onboarding is not a mid-session switch; no confirmation.
      this.mode = mode;
      await this.host.updateSetting('mode', mode);
    }
    this.postState();
  }

  setChip(chip: keyof Chips, value: boolean): void {
    this.chips = { ...this.chips, [chip]: value };
    this.postState();
  }

  // ---------------------------------------------------------------- conversation

  async newConversation(): Promise<void> {
    this.stop();
    this.state.clear(this.host.newId());
    this.transcript = undefined;
    this.chips = { currentFile: false, selection: false, diagnostics: false };
    await this.host.saveConversation(this.state.serialize());
    this.postState();
  }

  /** Clears the visible messages. The transcript of the session so far is kept. */
  async clearConversation(): Promise<void> {
    await this.newConversation();
  }

  stop(): void {
    this.tracker.cancel();
  }

  async retry(assistantId: string): Promise<void> {
    const user = this.state.lastUserBefore(assistantId);
    if (!user) return;
    const text = user.text;
    const chips = user.chips ?? { currentFile: false, selection: false, diagnostics: false };
    this.stop();
    this.state.truncateFrom(user.id);
    await this.send(text, chips);
  }

  /** Sends a message and streams the answer. Resolves when the answer is complete or stopped. */
  async send(rawText: string, chips: Chips = this.chips): Promise<void> {
    const text = rawText.trim();
    if (!text) return;

    const controller = this.tracker.begin();
    const signal = controller.signal;
    const settings = this.host.getSettings();
    const mode = this.mode;

    const classification = classifyRequest(text);
    const refs = parseReferences(classification.text);

    const user: StoredMessage = this.state.add({
      id: this.host.newId(),
      role: 'user',
      text,
      modelText: refs.text,
      chips,
      mode,
      status: 'done',
      sources: [],
      notes: [],
      createdAt: new Date().toISOString(),
    });
    const assistant: StoredMessage = this.state.add({
      id: this.host.newId(),
      role: 'assistant',
      text: '',
      mode,
      status: 'streaming',
      sources: [],
      notes: [],
      model: this.model,
      createdAt: new Date().toISOString(),
    });
    // Chips are one-shot: they apply to this message only.
    this.chips = { currentFile: false, selection: false, diagnostics: false };
    this.postState();

    let bundle: ContextBundle = { items: [], notes: [], sources: [], totalChars: 0 };
    let activeGuard = new OutputGuard({ enabled: false });
    let errorCode: string | undefined;

    try {
      if (this.ollamaState !== 'running' || !this.model) {
        await this.refreshOllama();
      }
      if (this.ollamaState !== 'running') {
        throw new UserFacingError(
          this.ollamaState === 'not-installed' ? 'ollama-not-installed' : 'ollama-not-running',
        );
      }
      if (!this.model) {
        throw new UserFacingError(this.models.length ? 'no-model-selected' : 'no-models');
      }
      const model = this.model;
      this.state.update(assistant.id, { model });

      bundle = await buildContext(
        {
          refs,
          includeCurrentFile: chips.currentFile || settings.autoIncludeCurrentFile,
          includeSelection: chips.selection,
          includeDiagnostics: chips.diagnostics || settings.includeDiagnostics,
          retrieve: this.host.hasWorkspace(),
        },
        {
          source: this.deps.source,
          retriever: this.deps.retriever,
          editor: this.host.getEditorState(),
          getDiagnostics: () => this.host.getDiagnostics(),
          maxContextFiles: settings.maxContextFiles,
          maxContextCharacters: settings.maxContextCharacters,
          signal,
        },
      );
      this.deps.logger.debug(
        `Context: ${bundle.sources.length} items, ${bundle.totalChars} chars [${bundle.sources.join(', ')}]`,
      );
      // The large-repository note is useful once per conversation, not on every message.
      if (this.state.all().some((m) => m.id !== assistant.id && m.notes.includes(LARGE_REPO_MESSAGE))) {
        bundle.notes = bundle.notes.filter((n) => n !== LARGE_REPO_MESSAGE);
      }
      this.state.update(assistant.id, { sources: bundle.sources, notes: bundle.notes });
      this.postMessage(assistant.id);

      const messages = buildMessages({
        mode,
        history: this.state.historyForModel(user.id),
        userText: refs.text,
        context: bundle.items,
        turnNote: mode === 'guarded' ? turnReminder(classification) : undefined,
      });

      activeGuard = new OutputGuard({
        enabled: mode === 'guarded',
        // The model's approach marker only counts if the request itself looked like an approach.
        allowApproach: classification.describesApproach || classification.explicitImplement,
        referenceTexts: bundle.items
          .filter(
            (i) =>
              i.kind === 'selection' ||
              i.kind === 'file' ||
              i.kind === 'current-file' ||
              i.kind === 'snippet',
          )
          .map((i) => stripLineNumbers(i.content)),
      });

      const endpoint = normalizeEndpoint(settings.ollamaEndpoint);
      if (!endpoint) throw new UserFacingError('invalid-endpoint');
      for await (const delta of this.host
        .createClient(endpoint)
        .chatStream(
          { model, messages, temperature: settings.temperature, contextWindow: settings.contextWindow },
          signal,
        )) {
        const safe = activeGuard.push(delta);
        if (safe) this.appendText(assistant.id, safe);
      }
      this.flushGuard(assistant.id, activeGuard);
      this.state.update(assistant.id, { status: 'done' });
    } catch (err) {
      this.flushGuard(assistant.id, activeGuard);
      if (isAbortError(err) || signal.aborted) {
        this.state.update(assistant.id, { status: 'stopped' });
      } else {
        this.deps.logger.error(`Generation failed: ${describeForLog(err)}`);
        errorCode = err instanceof UserFacingError ? err.code : 'generation-failed';
        this.state.update(assistant.id, { status: 'error', error: toUserMessage(err) });
        if (
          err instanceof UserFacingError &&
          (err.code === 'model-unavailable' || err.code === 'ollama-not-running')
        ) {
          void this.refreshOllama();
        }
      }
    } finally {
      this.tracker.end(controller);
      const report = activeGuard.report;
      const final = this.state.update(assistant.id, {
        guardRemovals: report.removed.length,
        approach: report.approach,
      })!;
      await this.recordTurn(user, final, classification, report, bundle, errorCode);
      await this.host.saveConversation(this.state.serialize());
      this.postState();
    }
  }

  private appendText(id: string, text: string): void {
    this.state.appendText(id, text);
    this.host.post({ type: 'append', id, text });
  }

  private flushGuard(id: string, guard: OutputGuard): void {
    const tail = guard.finish();
    if (tail) this.appendText(id, tail);
  }

  private postMessage(id: string): void {
    const ui = this.state.toUi().find((m) => m.id === id);
    if (ui) this.host.post({ type: 'message', message: ui });
  }

  // ---------------------------------------------------------------- transcript

  private ensureTranscript(): void {
    if (!this.transcript) {
      this.transcript = newSession(this.host.newId().replace(/[^\w-]/g, ''), this.host.workspaceName());
    }
  }

  private async recordTurn(
    user: StoredMessage,
    assistant: StoredMessage,
    classification: ReturnType<typeof classifyRequest>,
    report: GuardReport,
    bundle: ContextBundle,
    errorCode: string | undefined,
  ): Promise<void> {
    const settings = this.host.getSettings();
    if (!settings.saveTranscripts) return;
    // Record guarded sessions; once a session has been guarded, later unguarded turns are recorded too.
    if (assistant.mode !== 'guarded' && !this.transcript) return;
    this.ensureTranscript();
    this.transcript!.events.push({
      type: 'turn',
      at: user.createdAt,
      mode: assistant.mode,
      model: assistant.model ?? '',
      prompt: user.text,
      response: assistant.text,
      contextSources: bundle.sources,
      flags: deriveFlags(assistant.mode, classification, report, assistant.text),
      removed: report.removed,
      stopped: assistant.status === 'stopped' || undefined,
      error: errorCode,
    });
    await this.persistTranscript();
  }

  private async persistTranscript(): Promise<void> {
    if (!this.transcript) return;
    this.transcript.updatedAt = new Date().toISOString();
    try {
      await this.host.saveTranscript(this.transcript);
    } catch (err) {
      this.deps.logger.warn(`Saving transcript failed: ${describeForLog(err)}`);
    }
  }

  get currentTranscript(): TranscriptSession | undefined {
    return this.transcript;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.stopPolling();
  }
}
