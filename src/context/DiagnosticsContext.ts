import type { ContextItem } from './FileContext';

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface DiagnosticEntry {
  relPath: string;
  /** 1-based. */
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string;
}

export const MAX_DIAGNOSTICS = 50;
const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Errors first, then warnings; info/hints are dropped unless nothing else exists. */
export function selectDiagnostics(entries: DiagnosticEntry[], max = MAX_DIAGNOSTICS): DiagnosticEntry[] {
  const important = entries.filter((d) => d.severity === 'error' || d.severity === 'warning');
  const pool = important.length ? important : entries;
  return [...pool]
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.relPath.localeCompare(b.relPath) ||
        a.line - b.line,
    )
    .slice(0, max);
}

export function formatDiagnostics(entries: DiagnosticEntry[]): string {
  return entries
    .map((d) => {
      const src = d.source ? ` [${d.source}${d.code ? ` ${d.code}` : ''}]` : '';
      const msg = d.message.replace(/\s+/g, ' ').trim();
      return `${d.severity.toUpperCase()} ${d.relPath}:${d.line}:${d.column}${src} ${msg}`;
    })
    .join('\n');
}

export function diagnosticsContextItem(entries: DiagnosticEntry[]): ContextItem {
  const selected = selectDiagnostics(entries);
  const errors = selected.filter((d) => d.severity === 'error').length;
  const warnings = selected.filter((d) => d.severity === 'warning').length;
  const omitted = entries.length - selected.length;
  const content = selected.length
    ? formatDiagnostics(selected) + (omitted > 0 ? `\n… ${omitted} more not shown` : '')
    : 'No errors or warnings are currently reported.';
  return {
    kind: 'diagnostics',
    label: `Diagnostics (${errors} errors, ${warnings} warnings)`,
    content,
  };
}
