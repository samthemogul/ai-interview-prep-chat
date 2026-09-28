import type { ChatMessage } from '../ollama/OllamaClient';
import type { ChatMode, Chips, Mode, UiEdit, UiMessage } from './protocol';

/** A conversation message as stored. Never contains repository context. */
export interface StoredMessage extends UiMessage {
  /** For user messages: the text sent to the model (references rewritten, marker removed). */
  modelText?: string;
  /** For user messages: the context chips that were on, so Retry reproduces the request. */
  chips?: Chips;
  createdAt: string;
}

export interface StoredConversation {
  version: 1;
  id: string;
  messages: StoredMessage[];
}

const MAX_STORED_MESSAGES = 200;

/** In-memory conversation with (de)serialisation for VS Code's local workspace storage. */
export class ChatState {
  private messages: StoredMessage[] = [];

  constructor(public id: string) {}

  static restore(raw: unknown, newId: () => string): ChatState {
    const data = raw as Partial<StoredConversation> | undefined;
    const state = new ChatState(typeof data?.id === 'string' ? data.id : newId());
    if (data?.version === 1 && Array.isArray(data.messages)) {
      state.messages = data.messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
        .map((m) => (m.status === 'streaming' ? { ...m, status: 'stopped' as const } : m))
        // Pending edit proposals can't survive a reload: their proposed content isn't stored.
        .map((m) =>
          m.edits
            ? {
                ...m,
                edits: m.edits.map((e) =>
                  e.status === 'pending' ? { ...e, status: 'expired' as const } : e,
                ),
              }
            : m,
        );
    }
    return state;
  }

  serialize(): StoredConversation {
    return { version: 1, id: this.id, messages: this.messages.slice(-MAX_STORED_MESSAGES) };
  }

  all(): readonly StoredMessage[] {
    return this.messages;
  }

  get(id: string): StoredMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  add(message: StoredMessage): StoredMessage {
    this.messages.push(message);
    return message;
  }

  update(id: string, patch: Partial<StoredMessage>): StoredMessage | undefined {
    const m = this.get(id);
    if (m) Object.assign(m, patch);
    return m;
  }

  appendText(id: string, text: string): void {
    const m = this.get(id);
    if (m) m.text += text;
  }

  /** Removes the message with `id` and everything after it. */
  truncateFrom(id: string): void {
    const i = this.messages.findIndex((m) => m.id === id);
    if (i >= 0) this.messages.splice(i);
  }

  clear(newId: string): void {
    this.messages = [];
    this.id = newId;
  }

  lastUserBefore(id: string): StoredMessage | undefined {
    const i = this.messages.findIndex((m) => m.id === id);
    for (let j = (i < 0 ? this.messages.length : i) - 1; j >= 0; j--) {
      if (this.messages[j]!.role === 'user') return this.messages[j];
    }
    return undefined;
  }

  /** Completed turns for the model, oldest first. Stopped/errored answers are skipped. */
  historyForModel(excludeFromId?: string): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of this.messages) {
      if (m.id === excludeFromId) break;
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.modelText ?? m.text });
      } else if (m.status === 'done' && m.text.trim()) {
        out.push({ role: 'assistant', content: describeEdits(m.text, m.edits) });
      } else {
        // Drop the unanswered user turn so roles keep alternating.
        if (out.length && out[out.length - 1]!.role === 'user') out.pop();
      }
    }
    if (out.length && out[out.length - 1]!.role === 'user') out.pop();
    return out;
  }

  /** UI view with only the last assistant message marked retryable. */
  toUi(): UiMessage[] {
    let lastAssistant = -1;
    this.messages.forEach((m, i) => {
      if (m.role === 'assistant') lastAssistant = i;
    });
    return this.messages.map((m, i) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      mode: m.mode as Mode,
      chatMode: m.chatMode as ChatMode | undefined,
      status: m.status,
      sources: m.sources,
      notes: m.notes,
      error: m.error,
      guardRemovals: m.guardRemovals,
      approach: m.approach,
      model: m.model,
      retryable: i === lastAssistant && m.status !== 'streaming',
      edits: m.edits,
    }));
  }

  updateEdit(messageId: string, edit: UiEdit): void {
    const m = this.get(messageId);
    if (!m) return;
    const edits = m.edits ?? [];
    const i = edits.findIndex((e) => e.id === edit.id);
    if (i >= 0) edits[i] = edit;
    else edits.push(edit);
    m.edits = edits;
  }
}

/**
 * Replaces edit-card placeholders in an assistant turn with a short natural note, for the
 * model's history. This is deliberately NOT the structured "[Proposed edit … : accepted]"
 * form the UI uses: small models copy a machine-looking tag verbatim on the next turn
 * instead of writing new code, so past edits read as plain narration here. The current file
 * contents (sent fresh as context each turn) are what tell the model what actually changed.
 */
export function describeEdits(text: string, edits: UiEdit[] | undefined): string {
  const out = text.replace(/^%%EDIT:([\w-]+)%%$/gm, (_m, id: string) => {
    const e = edits?.find((x) => x.id === id);
    if (!e) return '';
    switch (e.status) {
      case 'accepted':
        return `(I edited ${e.path}.)`;
      case 'pending':
        return `(I proposed a change to ${e.path}.)`;
      case 'failed':
        return `(My change to ${e.path} could not be applied.)`;
      default:
        // rejected, reverted, expired: nothing was kept, so say nothing.
        return '';
    }
  });
  // Collapse blank lines left where placeholders were removed.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
