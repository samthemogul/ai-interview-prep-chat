/**
 * Messages exchanged between the extension host and the chat webview.
 * This file is imported by both bundles, so it must not import anything else.
 */

export type Mode = 'guarded' | 'normal';
export type ChatMode = 'ask' | 'plan' | 'agent';

export type EditStatus = 'pending' | 'accepted' | 'rejected' | 'failed' | 'reverted' | 'expired';

/** A file edit proposed by the AI in Agent mode, as shown in an edit card. */
export interface UiEdit {
  id: string;
  path: string;
  status: EditStatus;
  isNew: boolean;
  inferredPath: boolean;
  added: number;
  removed: number;
  preview: Array<{ t: '+' | '-' | ' ' | '…'; s: string }>;
  diffOpened: boolean;
  error?: string;
  /** Code blocks that changed nothing (e.g. the model echoed existing code) aren't shown. */
  hidden?: boolean;
  /** Short note about parts of the model's code that were left out. */
  note?: string;
}

export type EditAction = 'diff' | 'accept' | 'reject' | 'revert';

export type OllamaState =
  | 'checking'
  | 'running'
  | 'installed-not-running'
  | 'not-installed'
  | 'unreachable-remote'
  | 'invalid-endpoint';

export interface UiModel {
  name: string;
  detail: string;
  chat: boolean;
}

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  mode: Mode;
  chatMode?: ChatMode;
  status: MessageStatus;
  /** Context labels ("Using context from"). Assistant messages only. */
  sources: string[];
  notes: string[];
  error?: string;
  /** Number of code blocks the guard removed. */
  guardRemovals?: number;
  /** True when the AI implemented the candidate's described approach. */
  approach?: boolean;
  model?: string;
  /** True for the most recent assistant message (retry is offered there). */
  retryable?: boolean;
  /** File edits proposed in this message (Agent mode). Placeholders in `text` point at them. */
  edits?: UiEdit[];
}

export interface Chips {
  currentFile: boolean;
  selection: boolean;
  diagnostics: boolean;
}

export interface ViewState {
  mode: Mode;
  chatMode: ChatMode;
  model: string | undefined;
  models: UiModel[];
  ollama: { state: OllamaState; version?: string; endpoint: string; isLocal: boolean };
  modelMissing: boolean;
  showOnboarding: boolean;
  messages: UiMessage[];
  busy: boolean;
  chips: Chips;
  activeFile?: string;
  hasSelection: boolean;
  hasWorkspace: boolean;
  transcriptsEnabled: boolean;
  privacy: string;
  displayName: string;
  suggestedModels: Array<{ name: string; approxSize: string; description: string }>;
}

export type HostToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'append'; id: string; text: string }
  | { type: 'message'; message: UiMessage }
  | { type: 'editor'; activeFile?: string; hasSelection: boolean }
  | { type: 'prefill'; text: string; send?: boolean }
  | { type: 'focusInput' };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string; chips: Chips }
  | { type: 'stop' }
  | { type: 'retry'; id: string }
  | { type: 'clear' }
  | { type: 'newConversation' }
  | { type: 'selectModel'; name: string }
  | { type: 'refreshModels' }
  | { type: 'setMode'; mode: Mode }
  | { type: 'setChatMode'; chatMode: ChatMode }
  | { type: 'editAction'; messageId: string; editId: string; action: EditAction }
  | { type: 'implementPlan'; messageId: string }
  | { type: 'setChip'; chip: keyof Chips; value: boolean }
  | { type: 'completeOnboarding'; mode: Mode }
  | { type: 'checkOllama' }
  | { type: 'openInstallPage' }
  | { type: 'openModelLibrary' }
  | { type: 'downloadModel'; name?: string }
  | { type: 'openSettings' }
  | { type: 'viewLogs' }
  | { type: 'reviewTranscript' }
  | { type: 'copy'; text: string }
  | { type: 'openFile'; relPath: string; line?: number };
