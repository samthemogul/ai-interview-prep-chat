import type { ChatMessage } from '../ollama/OllamaClient';
import { languageForPath } from '../context/fileFilters';
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
 * Rebuilds an assistant turn for the model's history, putting each edit back as a real
 * code block.
 *
 * The edit's code is extracted from the visible text into a `%%EDIT:id%%` placeholder. If
 * history showed only a note where the code had been ("I edited pyserver.py", or the old
 * "[Proposed edit …]" tag), the turn read as "described an edit but gave no code" — and
 * models (7B included) faithfully copy that shape on the next turn: they narrate an edit
 * and never emit code. Reconstructing the code block from the edit's own diff keeps the
 * learned pattern correct: making a change means writing a real code block in the edit
 * format. Edits that changed nothing (rejected, reverted, failed) contribute no block.
 */
export function describeEdits(text: string, edits: UiEdit[] | undefined): string {
  const out = text.replace(/^%%EDIT:([\w-]+)%%$/gm, (_m, id: string) => {
    const e = edits?.find((x) => x.id === id);
    if (!e || e.status === 'rejected' || e.status === 'reverted' || e.status === 'expired') return '';
    const added = e.preview.filter((l) => l.t === '+').map((l) => l.s);
    if (!added.length) return e.status === 'failed' ? '' : `${e.path}`;
    const lang = languageForPath(e.path);
    return `${e.path}\n\`\`\`${lang}\n${added.join('\n')}\n\`\`\``;
  });
  // Collapse blank lines left where placeholders were removed.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
