/**
 * Messages exchanged between the extension host and the chat webview.
 * This file is imported by both bundles, so it must not import anything else.
 */

export type Mode = 'guarded' | 'normal';

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
}

export interface Chips {
  currentFile: boolean;
  selection: boolean;
  diagnostics: boolean;
}

export interface ViewState {
  mode: Mode;
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
