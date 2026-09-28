import type { RawEdit } from './EditBlocks';
import type { PreviewLine } from './applyEdit';
import type { ApplyResult } from './applyEdit';
import { applySearchReplace, summarizeEdit } from './applyEdit';
import { applyBlock, pathFromCodeComment, stripLineNumberPrefixes } from './placeBlock';
import { resolveFileReference, toSafeRelativePath } from '../context/References';
import { isBinaryPath, isInIgnoredDir } from '../context/fileFilters';

export type EditStatus = 'pending' | 'accepted' | 'rejected' | 'failed' | 'reverted' | 'expired';

/** What the UI and transcript need to know about an edit. */
export interface EditInfo {
  id: string;
  path: string;
  status: EditStatus;
  isNew: boolean;
  /** True when the model didn't name the file and it was inferred from context. */
  inferredPath: boolean;
  added: number;
  removed: number;
  preview: PreviewLine[];
  diffOpened: boolean;
  error?: string;
  /** True for code blocks that turned out to change nothing; the UI doesn't show them. */
  hidden?: boolean;
  /** Short note about parts of the model's code that were left out. */
  note?: string;
}

/** Applies either a SEARCH/REPLACE edit or a plain code block to a file's content. */
export function applyRawEdit(original: string | undefined, raw: RawEdit): ApplyResult {
  if (raw.code !== undefined) {
    return applyBlock(original, raw.code, { request: raw.request, keepComments: raw.keepComments });
  }
  const strip = (t: string) => stripLineNumberPrefixes(t.split('\n')).join('\n');
  return applySearchReplace(original, strip(raw.search), strip(raw.replace));
}

/** File access the manager needs. Implemented with the VS Code API in the extension. */
export interface EditHost {
  /** Current text of a workspace file (editor buffer if open), or undefined if it doesn't exist. */
  readFile(relPath: string): Promise<string | undefined>;
  /** Writes (and saves) a workspace file, creating it if needed. */
  writeFile(relPath: string, content: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  showDiff(edit: {
    id: string;
    path: string;
    original: string;
    proposed: string;
    isNew: boolean;
  }): Promise<void>;
  /** Closes the diff view for an edit, if it is open. */
  closeDiff?(id: string): Promise<void>;
  /** Indexed workspace files, used to resolve short paths like "pyserver.py". */
  listFiles(): Promise<string[]>;
}

interface ManagedEdit extends EditInfo {
  messageId: string;
  search: string;
  replace: string;
  raw: RawEdit;
  original?: string;
  proposed?: string;
  applied?: string;
}

/** Paths the agent may never edit, even with approval. */
export function isEditablePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (lower === '.git' || lower.startsWith('.git/') || lower.includes('/.git/')) return false;
  return !isInIgnoredDir(relPath) && !isBinaryPath(relPath);
}

/**
 * Tracks proposed edits. Nothing is written until the user accepts; a proposal is
 * re-applied against the file's current content at accept time, so edits made in the
 * meantime are never overwritten silently.
 */
export class EditManager {
  private readonly edits = new Map<string, ManagedEdit>();

  constructor(
    private readonly host: EditHost,
    private readonly newId: () => string,
  ) {}

  get(id: string): EditInfo | undefined {
    const e = this.edits.get(id);
    return e ? this.info(e) : undefined;
  }

  messageIdOf(id: string): string | undefined {
    return this.edits.get(id)?.messageId;
  }

  forMessage(messageId: string): EditInfo[] {
    return [...this.edits.values()].filter((e) => e.messageId === messageId).map((e) => this.info(e));
  }

  /** Records an edit that was blocked before it could be proposed (e.g. by Guarded Mode). */
  block(messageId: string, raw: RawEdit, reason: string, id = this.newId()): EditInfo {
    const e: ManagedEdit = {
      id,
      messageId,
      path: raw.path ?? '(unknown file)',
      status: 'failed',
      isNew: false,
      inferredPath: !raw.path,
      added: 0,
      removed: 0,
      preview: [],
      diffOpened: false,
      error: reason,
      search: '',
      replace: '',
      raw,
    };
    this.edits.set(e.id, e);
    return this.info(e);
  }

  async propose(
    messageId: string,
    raw: RawEdit,
    fallbackPath?: string,
    id = this.newId(),
  ): Promise<EditInfo> {
    const base: ManagedEdit = {
      id,
      messageId,
      path: raw.path ?? fallbackPath ?? '(unknown file)',
      status: 'failed',
      isNew: false,
      inferredPath: !raw.path && !!fallbackPath,
      added: 0,
      removed: 0,
      preview: [],
      diffOpened: false,
      search: raw.search,
      replace: raw.replace,
      raw,
    };
    this.edits.set(id, base);
    const fail = (error: string) => {
      base.error = error;
      base.status = 'failed';
      return this.info(base);
    };

    if (raw.incomplete) return fail('The response ended before this edit was complete.');
    // A code block can name its file in a first-line comment, e.g. "# pyserver.py:78-84".
    const firstCodeLine = raw.code?.split('\n').find((l) => l.trim());
    const commentPath = firstCodeLine ? pathFromCodeComment(firstCodeLine) : undefined;
    const requested = commentPath ?? raw.path ?? fallbackPath;
    if (!raw.path && commentPath) base.inferredPath = false;
    if (!requested) return fail("The model didn't say which file to change.");
    const safe = toSafeRelativePath(requested);
    if (!safe) return fail(`\`${requested}\` is outside the workspace.`);

    const indexed = await this.host.listFiles();
    const { match } = resolveFileReference(safe, indexed);
    const path = match ?? safe;
    base.path = path;
    if (!isEditablePath(path)) return fail(`\`${path}\` is in a folder or file type the agent may not edit.`);

    const original = await this.host.readFile(path);
    if (original === undefined && raw.code !== undefined && !commentPath && !raw.path) {
      return fail("The model didn't say which file this code belongs in.");
    }
    const result = applyRawEdit(original, raw);
    if (!result.ok) {
      if (result.reason.startsWith('NOOP')) {
        base.hidden = true;
        return fail('This code is already in the file.');
      }
      return fail(result.reason);
    }

    const summary = summarizeEdit(result.searchLines, result.replaceLines);
    base.isNew = original === undefined;
    base.original = original ?? '';
    base.proposed = result.content;
    base.added = summary.added;
    base.removed = summary.removed;
    base.preview = summary.preview;
    base.note = result.note;
    if (base.added === 0 && base.removed === 0) return fail('This edit would not change the file.');
    base.status = 'pending';
    base.error = undefined;
    return this.info(base);
  }

  async openDiff(id: string): Promise<EditInfo | undefined> {
    const e = this.edits.get(id);
    if (!e || e.original === undefined || e.proposed === undefined) return undefined;
    e.diffOpened = true;
    await this.host.showDiff({
      id,
      path: e.path,
      original: e.original,
      proposed: e.proposed,
      isNew: e.isNew,
    });
    return this.info(e);
  }

  async accept(id: string): Promise<EditInfo | undefined> {
    const e = this.edits.get(id);
    if (!e || e.status !== 'pending') return e ? this.info(e) : undefined;
    const current = await this.host.readFile(e.path);
    let content = e.proposed!;
    if (e.isNew) {
      if (current !== undefined) {
        e.status = 'failed';
        e.error = `\`${e.path}\` was created in the meantime, so the edit was not applied.`;
        return this.info(e);
      }
    } else if (current !== e.original) {
      // The file changed since the proposal: re-apply against what's there now.
      const again = applyRawEdit(current, e.raw);
      if (!again.ok) {
        e.status = 'failed';
        e.error = 'The file changed since this edit was proposed and it no longer applies.';
        return this.info(e);
      }
      e.original = current ?? '';
      content = again.content;
    }
    await this.host.writeFile(e.path, content);
    e.applied = content;
    e.status = 'accepted';
    await this.host.closeDiff?.(e.id);
    return this.info(e);
  }

  /** Marks a proposal as not allowed (for example over Guarded Mode's size limit). */
  fail(id: string, reason: string): EditInfo | undefined {
    const e = this.edits.get(id);
    if (!e) return undefined;
    e.status = 'failed';
    e.error = reason;
    return this.info(e);
  }

  reject(id: string): EditInfo | undefined {
    const e = this.edits.get(id);
    if (!e) return undefined;
    if (e.status === 'pending') {
      e.status = 'rejected';
      void this.host.closeDiff?.(e.id);
    }
    return this.info(e);
  }

  async revert(id: string): Promise<EditInfo | undefined> {
    const e = this.edits.get(id);
    if (!e || e.status !== 'accepted') return e ? this.info(e) : undefined;
    const current = await this.host.readFile(e.path);
    if (current !== e.applied) {
      e.error =
        'The file has changed since the edit was applied, so it was not reverted. Use Undo in the editor instead.';
      return this.info(e);
    }
    if (e.isNew) await this.host.deleteFile(e.path);
    else await this.host.writeFile(e.path, e.original ?? '');
    e.status = 'reverted';
    e.error = undefined;
    return this.info(e);
  }

  /** Pending proposals from a previous session can't be applied (their content is gone). */
  static expire(info: EditInfo): EditInfo {
    return info.status === 'pending' ? { ...info, status: 'expired' } : info;
  }

  private info(e: ManagedEdit): EditInfo {
    return {
      id: e.id,
      path: e.path,
      status: e.status,
      isNew: e.isNew,
      inferredPath: e.inferredPath,
      added: e.added,
      removed: e.removed,
      preview: e.preview,
      diffOpened: e.diffOpened,
      error: e.error,
      hidden: e.hidden || undefined,
      note: e.note,
    };
  }
}
