/**
 * Parses context references typed into the chat:
 *   @file:src/server.cpp   @file src/server.cpp   @file:"path with spaces.ts"
 *   @selection   @workspace   @diagnostics   @currentFile
 */
export interface ParsedReferences {
  /** The message with reference tokens rewritten into natural text for the model. */
  text: string;
  files: string[];
  selection: boolean;
  workspace: boolean;
  diagnostics: boolean;
  currentFile: boolean;
}

const REF_RE =
  /(^|\s)@(file:"[^"]+"|file:'[^']+'|file:\S+|file\s+"[^"]+"|file\s+'[^']+'|file\s+(?!@)\S+|selection|workspace|diagnostics|currentFile)(?=$|\s|[.,;:!?)])/g;

export function parseReferences(input: string): ParsedReferences {
  const result: ParsedReferences = {
    text: input,
    files: [],
    selection: false,
    workspace: false,
    diagnostics: false,
    currentFile: false,
  };
  result.text = input.replace(REF_RE, (_m, lead: string, body: string) => {
    if (body.startsWith('file')) {
      const raw = body.replace(/^file[:\s]\s*/, '');
      const file = stripQuotes(raw).replace(/[.,;:!?)]+$/, '');
      if (file && !result.files.includes(file)) result.files.push(file);
      return `${lead}${file}`;
    }
    switch (body) {
      case 'selection':
        result.selection = true;
        return `${lead}the selected code`;
      case 'workspace':
        result.workspace = true;
        return `${lead}this workspace`;
      case 'diagnostics':
        result.diagnostics = true;
        return `${lead}the current diagnostics`;
      case 'currentFile':
        result.currentFile = true;
        return `${lead}the current file`;
      default:
        return `${lead}${body}`;
    }
  });
  result.text = result.text.trim();
  return result;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Normalises a user-supplied path to a workspace-relative POSIX path.
 * Returns undefined for absolute paths or paths that escape the workspace.
 */
export function toSafeRelativePath(input: string): string | undefined {
  const p = input.trim().replace(/\\/g, '/');
  if (!p) return undefined;
  if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p) || p.startsWith('~')) return undefined;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return undefined;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : undefined;
}

/**
 * Resolves a reference against the indexed file list: exact path first, then a unique
 * path suffix (e.g. "server.cpp" or "auth/login.ts"). Returns matches for disambiguation.
 */
export function resolveFileReference(
  reference: string,
  indexed: readonly string[],
): { match?: string; candidates: string[] } {
  const safe = toSafeRelativePath(reference);
  if (!safe) return { candidates: [] };
  if (indexed.includes(safe)) return { match: safe, candidates: [safe] };
  const lower = safe.toLowerCase();
  const suffix = indexed.filter((p) => {
    const l = p.toLowerCase();
    return l === lower || l.endsWith('/' + lower);
  });
  if (suffix.length === 1) return { match: suffix[0], candidates: suffix };
  return { candidates: suffix.slice(0, 10) };
}
