import { languageForPath } from './fileFilters';

export type ContextKind = 'selection' | 'file' | 'current-file' | 'snippet' | 'diagnostics' | 'workspace';

/** One piece of context sent to the model. Paths are always workspace-relative. */
export interface ContextItem {
  kind: ContextKind;
  /** Short label shown in the UI, e.g. "src/auth.ts:10-42". */
  label: string;
  relPath?: string;
  language?: string;
  content: string;
  truncated?: boolean;
}

/** Prefixes each line with its 1-based number so the model can refer to exact lines. */
export function withLineNumbers(text: string, startLine = 1): string {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width, ' ')} | ${l}`).join('\n');
}

/** Cuts text to `maxChars`, preferring a line boundary, and reports whether it was cut. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= 0) return { text: '', truncated: true };
  const cut = text.slice(0, maxChars);
  const lastNl = cut.lastIndexOf('\n');
  const body = lastNl > maxChars * 0.6 ? cut.slice(0, lastNl) : cut;
  return { text: body, truncated: true };
}

/** Builds a context item for a whole file, truncated to the character budget. */
export function fileContextItem(
  relPath: string,
  content: string,
  maxChars: number,
  kind: 'file' | 'current-file' = 'file',
): ContextItem {
  const numbered = withLineNumbers(content.replace(/\r\n/g, '\n'));
  const { text, truncated } = truncateText(numbered, maxChars);
  return {
    kind,
    label: relPath,
    relPath,
    language: languageForPath(relPath),
    content: truncated ? `${text}\n… [file truncated to fit the context budget]` : text,
    truncated,
  };
}
