/** Pure helpers for applying SEARCH/REPLACE edits and describing the change. */

export type MatchKind = 'exact' | 'whitespace' | 'indentation' | 'append' | 'create';

export type ApplyResult =
  | {
      ok: true;
      content: string;
      matched: MatchKind;
      startLine: number;
      searchLines: string[];
      replaceLines: string[];
    }
  | { ok: false; reason: string };

export interface PreviewLine {
  /** '+' added, '-' removed, ' ' unchanged context, '…' skipped lines. */
  t: '+' | '-' | ' ' | '…';
  s: string;
}

export interface EditSummary {
  added: number;
  removed: number;
  preview: PreviewLine[];
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

function leadingWs(s: string): string {
  return /^\s*/.exec(s)![0];
}

function findBlock(hay: string[], needle: string[], eq: (a: string, b: string) => boolean): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (!eq(hay[i + j]!, needle[j]!)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Re-indents replacement lines by the indentation difference between the model's search text and the file. */
function reindent(replace: string[], fromIndent: string, toIndent: string): string[] {
  if (fromIndent === toIndent) return replace;
  return replace.map((l) => {
    if (!l.trim()) return l;
    if (fromIndent && l.startsWith(fromIndent)) return toIndent + l.slice(fromIndent.length);
    if (!fromIndent) return toIndent + l;
    return l;
  });
}

/**
 * Applies one SEARCH/REPLACE edit.
 * - `original` undefined means the file doesn't exist: only an empty SEARCH (create) is allowed.
 * - An empty SEARCH on an existing file appends to the end.
 * - Matching falls back from exact, to trailing-whitespace-insensitive, to indentation-insensitive,
 *   because small models rarely reproduce whitespace perfectly.
 */
export function applySearchReplace(
  original: string | undefined,
  search: string,
  replace: string,
): ApplyResult {
  const replaceLines = trimBlankEdges(replace.replace(/\r\n/g, '\n').split('\n'));
  const searchLines = trimBlankEdges(search.replace(/\r\n/g, '\n').split('\n'));

  if (original === undefined) {
    if (searchLines.length) {
      return { ok: false, reason: "The file doesn't exist, so there is nothing to replace." };
    }
    return {
      ok: true,
      content: replaceLines.join('\n') + '\n',
      matched: 'create',
      startLine: 1,
      searchLines: [],
      replaceLines,
    };
  }

  const crlf = original.includes('\r\n');
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const lines = text.split('\n');
  const restore = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);

  if (searchLines.length === 0) {
    const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    const sep = base.trim() && !base.endsWith('\n\n') ? '\n' : '';
    const startLine = base.split('\n').length + (sep ? 1 : 0);
    return {
      ok: true,
      content: restore(`${base}${sep}${replaceLines.join('\n')}\n`),
      matched: 'append',
      startLine,
      searchLines: [],
      replaceLines,
    };
  }

  const strategies: Array<[MatchKind, (a: string, b: string) => boolean]> = [
    ['exact', (a, b) => a === b],
    ['whitespace', (a, b) => a.trimEnd() === b.trimEnd()],
    ['indentation', (a, b) => a.trim() === b.trim()],
  ];
  for (const [kind, eq] of strategies) {
    const at = findBlock(lines, searchLines, eq);
    if (at < 0) continue;
    let finalReplace = replaceLines;
    if (kind === 'indentation') {
      const firstIdx = searchLines.findIndex((l) => l.trim());
      finalReplace = reindent(
        replaceLines,
        leadingWs(searchLines[firstIdx]!),
        leadingWs(lines[at + firstIdx]!),
      );
    }
    const next = [...lines.slice(0, at), ...finalReplace, ...lines.slice(at + searchLines.length)];
    return {
      ok: true,
      content: restore(next.join('\n')),
      matched: kind,
      startLine: at + 1,
      searchLines: lines.slice(at, at + searchLines.length),
      replaceLines: finalReplace,
    };
  }
  return {
    ok: false,
    reason:
      "Couldn't find the code this edit is meant to replace. The file may differ from what the model saw.",
  };
}

/** Longest-common-subsequence line diff for small regions. */
export function diffLines(a: string[], b: string[]): PreviewLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) {
    return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: PreviewLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', s: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ t: '-', s: a[i++]! });
    } else {
      out.push({ t: '+', s: b[j++]! });
    }
  }
  while (i < n) out.push({ t: '-', s: a[i++]! });
  while (j < m) out.push({ t: '+', s: b[j++]! });
  return out;
}

/** Counts changes and builds a compact preview with at most `maxLines` lines. */
export function summarizeEdit(searchLines: string[], replaceLines: string[], maxLines = 40): EditSummary {
  const d = diffLines(searchLines, replaceLines);
  const added = d.filter((l) => l.t === '+').length;
  const removed = d.filter((l) => l.t === '-').length;
  // Collapse long runs of unchanged lines down to one line of context on each side.
  const preview: PreviewLine[] = [];
  for (let k = 0; k < d.length; k++) {
    const l = d[k]!;
    if (l.t !== ' ') {
      preview.push(l);
      continue;
    }
    const prevChanged = k > 0 && d[k - 1]!.t !== ' ';
    const nextChanged = k + 1 < d.length && d[k + 1]!.t !== ' ';
    if (prevChanged || nextChanged) preview.push(l);
    else if (preview.length && preview[preview.length - 1]!.t !== '…') preview.push({ t: '…', s: '' });
  }
  while (preview.length && preview[preview.length - 1]!.t === '…') preview.pop();
  if (preview.length > maxLines) {
    const hidden = preview.length - maxLines;
    return {
      added,
      removed,
      preview: [...preview.slice(0, maxLines), { t: '…', s: `${hidden} more lines` }],
    };
  }
  return { added, removed, preview };
}
