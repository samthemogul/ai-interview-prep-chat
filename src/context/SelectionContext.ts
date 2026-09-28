import type { ContextItem } from './FileContext';
import { truncateText, withLineNumbers } from './FileContext';
import { languageForPath } from './fileFilters';

export interface EditorSelection {
  relPath: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

export function selectionContextItem(sel: EditorSelection, maxChars: number): ContextItem | undefined {
  const body = sel.text.replace(/\r\n/g, '\n');
  if (!body.trim()) return undefined;
  const { text, truncated } = truncateText(withLineNumbers(body, sel.startLine), maxChars);
  const range = sel.startLine === sel.endLine ? `${sel.startLine}` : `${sel.startLine}-${sel.endLine}`;
  return {
    kind: 'selection',
    label: `${sel.relPath}:${range} (selection)`,
    relPath: sel.relPath,
    language: languageForPath(sel.relPath),
    content: truncated ? `${text}\n… [selection truncated]` : text,
    truncated,
  };
}
