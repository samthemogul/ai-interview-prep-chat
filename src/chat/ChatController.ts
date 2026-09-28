import type { ChatState, StoredMessage } from './ChatState';
import type {
  ChatMode,
  Chips,
  EditAction,
  HostToWebview,
  Mode,
  OllamaState,
  UiEdit,
  UiModel,
  ViewState,
} from './protocol';
import { EditBlockExtractor, type RawEdit } from '../agent/EditBlocks';
import { EditManager, type EditHost } from '../agent/EditManager';
import { APPROACH_LINE_CAP, GUARDED_REFUSAL_MAX_TOKENS } from '../interview/GuardedPrompt';
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
import {
  asksForTests,
  classifyRequest,
  isChangeRequest,
  isRefusalTurn,
  looksLikeTestCode,
  turnReminder,
} from '../interview/RequestClassifier';
import { shortenRefusal } from '../interview/Refusal';
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
  /** File access for Agent mode. Without it, proposed edits can't be applied. */
  edits?: EditHost;
}

const DROPPED_TESTS_NOTE = "Left out test code you didn't ask for. Ask for tests if you want them.";

const NO_EDIT_HOST: EditHost = {
  readFile: async () => {
    throw new Error('File editing is not available.');
  },
  writeFile: async () => {
    throw new Error('File editing is not available.');
  },
  deleteFile: async () => {
    throw new Error('File editing is not available.');
  },
  showDiff: async () => undefined,
  listFiles: async () => [],
};

/**
 * Owns the conversation, the Ollama connection state and the send/stop/retry flow.
 * It never runs commands. In Agent mode it only changes files through the EditManager,
 * and only after the user accepts a proposed edit.
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
  private chatMode: ChatMode;
  private readonly editManager: EditManager;
  /** Messages whose first proposed edit has already been opened as a diff. */
  private readonly autoOpened = new Set<string>();
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
    this.chatMode = this.host.getSettings().chatMode;
    this.editManager = new EditManager(deps.edits ?? NO_EDIT_HOST, () => this.host.newId());
  }

  get currentChatMode(): ChatMode {
    return this.chatMode;
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
      chatMode: this.chatMode,
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
        'Unguarded Mode removes the interview guard: the AI can write the solution for you, like the unguarded Code Repos assistant in real assessments. The switch is recorded in your practice transcript.',
        'Switch to Unguarded',
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

  async setChatMode(to: ChatMode): Promise<void> {
    if (to === this.chatMode) {
      this.postState();
      return;
    }
    this.chatMode = to;
    this.postState();
    await this.host.updateSetting('chatMode', to);
  }

  /** Keeps state in sync when settings are edited directly in the Settings UI. */
  async onSettingsChanged(changed: Array<keyof Settings>): Promise<void> {
    const s = this.host.getSettings();
    if (changed.includes('mode') && s.mode !== this.mode) await this.applyMode(this.mode, s.mode);
    if (changed.includes('chatMode')) this.chatMode = s.chatMode;
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
    const chatMode = this.chatMode;

    const classification = classifyRequest(text);
    const refs = parseReferences(classification.text);

    const user: StoredMessage = this.state.add({
      id: this.host.newId(),
      role: 'user',
      text,
      modelText: refs.text,
      chips,
      mode,
      chatMode,
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
      chatMode,
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
    // Agent mode: edit blocks are pulled out of the stream and proposed as reviewable edits.
    const queued: Array<{ id: string; raw: RawEdit }> = [];
    const proposals: Array<Promise<void>> = [];
    const refusal = mode === 'guarded' && chatMode !== 'plan' && isRefusalTurn(classification);
    const approachRequested = classification.describesApproach || classification.explicitImplement;
    // Plain code blocks become edits only when the user asked for a change (and, in Guarded
    // Mode, described the approach). Otherwise they stay as examples in the answer.
    const captureCodeBlocks =
      chatMode === 'agent' &&
      !refusal &&
      (mode === 'normal'
        ? isChangeRequest(classification.text) || classification.describesApproach
        : approachRequested);
    const wantsTests = asksForTests(classification.text);
    let droppedTests = false;
    const extractor =
      chatMode === 'agent'
        ? new EditBlockExtractor(
            (raw) => {
              // Do exactly what was asked: don't propose test code the user didn't ask for.
              if (!wantsTests && looksLikeTestCode(raw.code ?? raw.replace)) {
                droppedTests = true;
                return null;
              }
              const id = this.host.newId();
              queued.push({ id, raw });
              return id;
            },
            { captureCodeBlocks },
          )
        : undefined;
    let fallbackPath: string | undefined;
    let doneReason: string | undefined;
    // Guarded refusals are buffered and reduced to "refusal + one hint" before display.
    let refusalBuffer = '';
    const show = (text: string) => {
      if (!text) return;
      if (refusal) refusalBuffer += text;
      else this.appendText(assistant.id, text);
    };
    const emit = (raw: string) => {
      const text = extractor ? extractor.push(raw) : raw;
      show(text ? activeGuard.push(text) : '');
      this.drainEdits(
        assistant.id,
        queued,
        proposals,
        mode === 'normal' || approachRequested,
        mode,
        fallbackPath,
      );
    };
    const finishStream = () => {
      if (extractor) {
        const rest = extractor.finish();
        show(rest ? activeGuard.push(rest) : '');
      }
      show(activeGuard.finish());
      if (refusal) {
        this.appendText(assistant.id, shortenRefusal(refusalBuffer));
        refusalBuffer = '';
      }
      this.drainEdits(
        assistant.id,
        queued,
        proposals,
        mode === 'normal' || approachRequested,
        mode,
        fallbackPath,
      );
      if (droppedTests) {
        const m = this.state.get(assistant.id);
        if (m && !m.notes.includes(DROPPED_TESTS_NOTE)) {
          this.state.update(assistant.id, { notes: [...m.notes, DROPPED_TESTS_NOTE] });
          this.postMessage(assistant.id);
        }
      }
    };

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
      // If the model doesn't name a file, edits go to the file the user pointed at (or the best match).
      fallbackPath =
        bundle.items.find((i) => i.kind === 'selection' || i.kind === 'file' || i.kind === 'current-file')
          ?.relPath ?? bundle.items.find((i) => i.kind === 'snippet')?.relPath;

      // Agent mode: show code without line numbers so the model copies exact lines, and keep
      // history short so small models don't repeat an earlier answer.
      const contextItems =
        chatMode === 'agent'
          ? bundle.items.map((i) => ({ ...i, content: stripLineNumbers(i.content) }))
          : bundle.items;
      const history = this.state.historyForModel(user.id);
      const messages = buildMessages({
        mode,
        chatMode,
        history: chatMode === 'agent' ? history.slice(-4) : history,
        userText: refs.text,
        context: contextItems,
        turnNote: mode === 'guarded' ? turnReminder(classification, chatMode) : undefined,
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
      for await (const delta of this.host.createClient(endpoint).chatStream(
        {
          model,
          messages,
          temperature: settings.temperature,
          contextWindow: settings.contextWindow,
          // A guarded refusal only needs a sentence and a hint; cap it so the model can't ramble.
          maxTokens: refusal ? GUARDED_REFUSAL_MAX_TOKENS : undefined,
          onDone: (reason) => {
            doneReason = reason;
          },
        },
        signal,
      )) {
        emit(delta);
      }
      finishStream();
      this.deps.logger.debug(`Generation finished: ${doneReason ?? 'unknown'}`);
      await Promise.all(proposals);
      this.state.update(assistant.id, { status: 'done' });
    } catch (err) {
      finishStream();
      await Promise.allSettled(proposals);
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
      const madeEdits = (this.state.get(assistant.id)?.edits ?? []).some((e) => e.status !== 'failed');
      const final = this.state.update(assistant.id, {
        guardRemovals: report.removed.length,
        approach: report.approach || (mode === 'guarded' && approachRequested && madeEdits),
      })!;
      await this.recordTurn(
        user,
        final,
        classification,
        { ...report, approach: !!final.approach },
        bundle,
        errorCode,
      );
      await this.host.saveConversation(this.state.serialize());
      this.postState();
    }
  }

  /** Proposes queued edits now that the guard has seen the text before them. */
  private drainEdits(
    messageId: string,
    queued: Array<{ id: string; raw: RawEdit }>,
    proposals: Array<Promise<void>>,
    allowed: boolean,
    mode: Mode,
    fallbackPath: string | undefined,
  ): void {
    while (queued.length) {
      const { id, raw } = queued.shift()!;
      if (!allowed) {
        this.setEdit(
          messageId,
          this.editManager.block(
            messageId,
            raw,
            'Guarded Interview Mode only edits files to implement an approach you describe. Describe how to do it, or start your message with /implement.',
            id,
          ),
        );
        continue;
      }
      proposals.push(
        this.editManager
          .propose(messageId, raw, fallbackPath, id)
          .then((info) => {
            if (mode === 'guarded' && info.status === 'pending' && info.added > APPROACH_LINE_CAP) {
              info =
                this.editManager.fail(
                  info.id,
                  `Approach implementations are limited to ${APPROACH_LINE_CAP} new lines in Guarded Interview Mode. Split the approach into a smaller change.`,
                ) ?? info;
            }
            this.setEdit(messageId, info);
            // Show the first proposed change straight away, like an agent editing the file.
            if (info.status === 'pending' && !this.autoOpened.has(messageId)) {
              this.autoOpened.add(messageId);
              return this.editManager.openDiff(info.id).then((opened) => {
                if (opened) this.setEdit(messageId, opened);
              });
            }
            return undefined;
          })
          .catch((err: unknown) => {
            this.deps.logger.warn(`Proposing an edit failed: ${describeForLog(err)}`);
            this.setEdit(
              messageId,
              this.editManager.block(messageId, raw, "This edit couldn't be prepared.", id),
            );
          }),
      );
    }
  }

  private setEdit(messageId: string, edit: UiEdit): void {
    this.state.updateEdit(messageId, edit);
    this.postMessage(messageId);
  }

  /** Same as editAction, for commands that only know the edit (e.g. the diff editor's title bar). */
  async editActionById(editId: string, action: EditAction): Promise<void> {
    const messageId = this.editManager.messageIdOf(editId);
    if (messageId) await this.editAction(messageId, editId, action);
  }

  /** Review, accept, reject or revert an edit proposed in Agent mode. */
  async editAction(messageId: string, editId: string, action: EditAction): Promise<void> {
    let info;
    try {
      if (action === 'diff') info = await this.editManager.openDiff(editId);
      else if (action === 'accept') info = await this.editManager.accept(editId);
      else if (action === 'reject') info = this.editManager.reject(editId);
      else info = await this.editManager.revert(editId);
    } catch (err) {
      this.deps.logger.error(`Edit ${action} failed: ${describeForLog(err)}`);
      this.host.showError(`Couldn't ${action === 'diff' ? 'open the diff for' : action} this edit.`);
      return;
    }
    if (!info) return;
    this.setEdit(messageId, info);
    if (
      (action === 'accept' && info.status === 'accepted') ||
      (action === 'reject' && info.status === 'rejected') ||
      (action === 'revert' && info.status === 'reverted')
    ) {
      await this.recordEditDecision(
        info,
        action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'reverted',
      );
    }
    await this.host.saveConversation(this.state.serialize());
  }

  /** Unguarded Plan mode: switch to Agent and implement the agreed plan. */
  async implementPlan(): Promise<void> {
    if (this.mode !== 'normal') return;
    await this.setChatMode('agent');
    await this.send('Implement the plan above.', {
      currentFile: false,
      selection: false,
      diagnostics: false,
    });
  }

  private async recordEditDecision(
    info: UiEdit,
    action: 'accepted' | 'rejected' | 'reverted',
  ): Promise<void> {
    if (!this.host.getSettings().saveTranscripts) return;
    this.ensureTranscript();
    this.transcript!.events.push({
      type: 'edit',
      at: new Date().toISOString(),
      editId: info.id,
      path: info.path,
      action,
      reviewed: info.diffOpened,
      added: info.added,
      removed: info.removed,
    });
    await this.persistTranscript();
  }

  private appendText(id: string, text: string): void {
    this.state.appendText(id, text);
    this.host.post({ type: 'append', id, text });
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
    this.ensureTranscript();
    const flags = deriveFlags(assistant.mode, classification, report, assistant.text);
    const edits = (assistant.edits ?? []).map((e) => ({
      id: e.id,
      path: e.path,
      added: e.added,
      removed: e.removed,
      status: e.status,
    }));
    if (edits.some((e) => e.status !== 'failed')) flags.push('edits-proposed');
    this.transcript!.events.push({
      type: 'turn',
      at: user.createdAt,
      mode: assistant.mode,
      model: assistant.model ?? '',
      prompt: user.text,
      response: assistant.text,
      contextSources: bundle.sources,
      flags,
      removed: report.removed,
      chatMode: assistant.chatMode as ChatMode | undefined,
      edits: edits.length ? edits : undefined,
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
