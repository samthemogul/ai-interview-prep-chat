import type { ContextItem } from './FileContext';
import { fileContextItem, truncateText } from './FileContext';
import type { EditorSelection } from './SelectionContext';
import { selectionContextItem } from './SelectionContext';
import type { DiagnosticEntry } from './DiagnosticsContext';
import { diagnosticsContextItem } from './DiagnosticsContext';
import type { ParsedReferences } from './References';
import { resolveFileReference, toSafeRelativePath } from './References';
import type { ContextRetriever, WorkspaceSource } from './ContextRetriever';
import {
  extractImportTargets,
  matchImportTargets,
  snippetToContextItem,
  summarizeTree,
} from './ContextRetriever';
import { LARGE_REPO_MESSAGE } from '../utils/errors';

export interface EditorState {
  activeFile?: { relPath: string; content: string };
  selection?: EditorSelection;
  /** Workspace-relative paths of visible/open text editors. */
  openFiles: string[];
}

export interface ContextRequest {
  refs: ParsedReferences;
  /** Composer chips / auto settings. */
  includeCurrentFile: boolean;
  includeSelection: boolean;
  includeDiagnostics: boolean;
  /** Automatic retrieval of relevant snippets for the question. */
  retrieve: boolean;
}

export interface ContextDeps {
  source: WorkspaceSource & { isLarge?(): boolean };
  retriever: ContextRetriever;
  editor: EditorState;
  getDiagnostics(): DiagnosticEntry[];
  maxContextFiles: number;
  maxContextCharacters: number;
  signal?: AbortSignal;
}

export interface ContextBundle {
  items: ContextItem[];
  /** Human-readable notes shown in the chat (missing files, large repo …). */
  notes: string[];
  /** Workspace-relative labels shown under "Using context from". */
  sources: string[];
  totalChars: number;
}

const DIAGNOSTICS_BUDGET = 3000;
const TREE_BUDGET = 2500;

/**
 * Assembles the context for one message within the character budget.
 * Priority: selection → explicit @file refs → current file → diagnostics → workspace tree
 * → automatically retrieved snippets.
 */
export async function buildContext(req: ContextRequest, deps: ContextDeps): Promise<ContextBundle> {
  const items: ContextItem[] = [];
  const notes: string[] = [];
  const included = new Set<string>();
  let remaining = deps.maxContextCharacters;
  const push = (item: ContextItem | undefined) => {
    if (!item || !item.content) return;
    items.push(item);
    remaining -= item.content.length;
    if (item.relPath && item.kind !== 'selection' && item.kind !== 'snippet') included.add(item.relPath);
  };

  // 1. Selection
  if (req.includeSelection || req.refs.selection) {
    if (deps.editor.selection && deps.editor.selection.text.trim()) {
      push(selectionContextItem(deps.editor.selection, Math.floor(remaining * 0.6)));
    } else {
      notes.push('No code is selected, so no selection was included.');
    }
  }

  // 2. Explicit file references
  const files = await deps.source.listFiles(deps.signal);
  const indexed = files.map((f) => f.relPath);
  const explicit = req.refs.files;
  for (let i = 0; i < explicit.length; i++) {
    const ref = explicit[i]!;
    const safe = toSafeRelativePath(ref);
    if (!safe) {
      notes.push(`\`${ref}\` is outside the workspace, so it wasn't included.`);
      continue;
    }
    const { match, candidates } = resolveFileReference(safe, indexed);
    const target = match ?? (candidates.length === 0 ? safe : undefined);
    if (!target) {
      notes.push(
        `\`${ref}\` matches several files (${candidates.slice(0, 4).join(', ')}). Use the full path.`,
      );
      continue;
    }
    if (included.has(target)) continue;
    const content = await deps.source.readFile(target);
    if (content === undefined) {
      notes.push(`Couldn't read \`${ref}\` (missing, binary, too large or ignored).`);
      continue;
    }
    const share = Math.floor(remaining / (explicit.length - i + 1));
    push(fileContextItem(target, content, Math.max(500, share)));
  }

  // 3. Current file
  if ((req.includeCurrentFile || req.refs.currentFile) && deps.editor.activeFile) {
    const { relPath, content } = deps.editor.activeFile;
    if (!included.has(relPath)) {
      push(fileContextItem(relPath, content, Math.max(500, Math.floor(remaining * 0.7)), 'current-file'));
    }
  } else if ((req.includeCurrentFile || req.refs.currentFile) && !deps.editor.activeFile) {
    notes.push('No file is open in the editor, so no current file was included.');
  }

  // 4. Diagnostics
  if (req.includeDiagnostics || req.refs.diagnostics) {
    const item = diagnosticsContextItem(deps.getDiagnostics());
    const { text, truncated } = truncateText(
      item.content,
      Math.min(DIAGNOSTICS_BUDGET, Math.max(300, remaining)),
    );
    push({ ...item, content: text, truncated });
  }

  // 5. Workspace structure
  if (req.refs.workspace) {
    const tree = summarizeTree(files);
    const { text } = truncateText(tree, Math.min(TREE_BUDGET, Math.max(300, remaining)));
    push({ kind: 'workspace', label: 'workspace tree', content: text });
  }

  if (deps.source.isLarge?.()) notes.push(LARGE_REPO_MESSAGE);

  // 6. Retrieval
  if (req.retrieve && remaining > 400 && deps.maxContextFiles > 0) {
    const boost = new Map<string, number>();
    for (const p of deps.editor.openFiles) boost.set(p, 1);
    if (deps.editor.activeFile) {
      const active = deps.editor.activeFile;
      boost.set(active.relPath, (boost.get(active.relPath) ?? 0) + 1.5);
      for (const p of matchImportTargets(extractImportTargets(active.relPath, active.content), indexed)) {
        boost.set(p, (boost.get(p) ?? 0) + 2);
      }
    }
    // When the user pointed at specific code, retrieve fewer extra files.
    const pointed = items.some(
      (i) => i.kind === 'selection' || i.kind === 'file' || i.kind === 'current-file',
    );
    const maxFiles = pointed ? Math.min(2, deps.maxContextFiles) : deps.maxContextFiles;
    const snippets = await deps.retriever.retrieve(req.refs.text, {
      maxFiles,
      maxChars: remaining,
      exclude: included,
      boost,
      signal: deps.signal,
    });
    for (const s of snippets) push(snippetToContextItem(s));
  }

  const sources = items.map((i) => i.label);
  const totalChars = items.reduce((n, i) => n + i.content.length, 0);
  return { items, notes, sources, totalChars };
}
