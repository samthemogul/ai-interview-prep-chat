import type { ContextItem } from './FileContext';
import { withLineNumbers } from './FileContext';
import { FULL_CONTENT_SEARCH_LIMIT, languageForPath } from './fileFilters';

export interface IndexedFile {
  relPath: string;
  size: number;
}

/** What the retriever needs from the workspace. Implemented by WorkspaceIndexer. */
export interface WorkspaceSource {
  listFiles(signal?: AbortSignal): Promise<IndexedFile[]>;
  /** Returns text content, or undefined for missing, binary or oversized files. */
  readFile(relPath: string): Promise<string | undefined>;
  /** Optional language-server symbol lookup; returns relative paths of files defining matches. */
  findSymbolFiles?(query: string, signal?: AbortSignal): Promise<string[]>;
}

export interface RetrieveOptions {
  maxFiles: number;
  maxChars: number;
  /** Files already included elsewhere (explicit refs, current file). */
  exclude?: ReadonlySet<string>;
  /** Files to favour, e.g. open editors and imports of the current file. */
  boost?: ReadonlyMap<string, number>;
  signal?: AbortSignal;
}

export interface RetrievedSnippet {
  relPath: string;
  score: number;
  startLine: number;
  endLine: number;
  content: string;
}

const STOPWORDS = new Set(
  (
    'the a an and or but if then else when where what which who whom whose why how is are was were be been ' +
    'being do does did doing have has had having this that these those there here it its of in on at to for ' +
    'from by with about into through over under again further once can could should would will shall may ' +
    'might must not no nor only own same so than too very just also any all both each few more most other ' +
    'some such me my we our you your he she they them their i am please explain tell show find give help ' +
    'look looking file files code function functions class method methods line lines work works working ' +
    'handled handle happen happens used use using does doing get got make makes like want need know think ' +
    'repository repo project codebase workspace hint issue problem question'
  ).split(/\s+/),
);

/** Splits camelCase, snake_case and kebab-case, lowercases, and drops stopwords. */
export function tokenizeQuery(query: string): string[] {
  const words = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    const stem = stemWord(w);
    if (stem !== w && stem.length >= 3) out.add(stem);
    const alias = ALIASES[w] ?? ALIASES[stem];
    if (alias) out.add(alias);
  }
  return [...out].slice(0, 14);
}

/** Common abbreviations used in code for words people type in questions. */
const ALIASES: Record<string, string> = {
  authentication: 'auth',
  authenticate: 'auth',
  authorization: 'auth',
  authorize: 'auth',
  configuration: 'config',
  configure: 'config',
  connection: 'conn',
  connections: 'conn',
  database: 'db',
  message: 'msg',
  messages: 'msg',
  request: 'req',
  requests: 'req',
  response: 'res',
  environment: 'env',
  middleware: 'middleware',
  password: 'passw',
  initialize: 'init',
  initialise: 'init',
};

function stemWord(w: string): string {
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ication') && w.length > 9) return w.slice(0, -7); // authentication -> authent
  if (w.endsWith('ation') && w.length > 7) return w.slice(0, -5);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

/** Scores a path by how many query terms appear in its file name and directories. */
export function scorePath(relPath: string, terms: string[]): number {
  const lower = relPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  let score = 0;
  for (const t of terms) {
    if (stem === t) score += 6;
    else if (containsTerm(base, t)) score += 4;
    else if (containsTerm(lower, t)) score += 2;
  }
  // Prefer source over tests/docs slightly when scores tie.
  if (score > 0 && /(^|\/)(test|tests|__tests__|spec|docs?)\//.test(lower)) score -= 0.5;
  return score;
}

const DEFINITION_RE =
  /\b(class|interface|struct|enum|trait|type|function|func|fn|def|module|namespace|impl|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Per-line term hits; definitions of matching names count triple. */
export function lineScores(content: string, terms: string[]): number[] {
  const lines = content.split('\n');
  return lines.map((line) => {
    const l = line.toLowerCase();
    let s = 0;
    for (const t of terms) if (containsTerm(l, t)) s += 1;
    if (s > 0) {
      const def = DEFINITION_RE.exec(line);
      if (def && terms.some((t) => def[2]!.toLowerCase().includes(t))) s *= 3;
    }
    return s;
  });
}

/**
 * Picks windows of lines around the strongest matches, merges overlapping windows and
 * returns them as numbered snippets that fit in `maxChars`.
 */
export function extractSnippets(
  content: string,
  terms: string[],
  maxChars: number,
  radius = 6,
): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const scores = lineScores(lines.join('\n'), terms);
  const ranked = scores
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);

  // No matches: show the top of the file (imports + first definitions are usually informative).
  if (ranked.length === 0) {
    const end = Math.min(lines.length, 40);
    const text = withLineNumbers(lines.slice(0, end).join('\n'), 1);
    return [{ startLine: 1, endLine: end, text: text.slice(0, maxChars) }];
  }

  const windows: Array<[number, number]> = [];
  let used = 0;
  for (const { i } of ranked) {
    if (windows.some(([a, b]) => i >= a && i <= b)) continue;
    const a = Math.max(0, i - radius);
    const b = Math.min(lines.length - 1, i + radius);
    const cost = lines.slice(a, b + 1).join('\n').length + 16;
    if (used + cost > maxChars && windows.length > 0) break;
    windows.push([a, b]);
    used += cost;
    if (windows.length >= 4) break;
  }
  windows.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  let budget = maxChars;
  const out: Array<{ startLine: number; endLine: number; text: string }> = [];
  for (const [a, b] of merged) {
    let text = withLineNumbers(lines.slice(a, b + 1).join('\n'), a + 1);
    if (text.length > budget) text = text.slice(0, Math.max(0, budget));
    if (!text) break;
    out.push({ startLine: a + 1, endLine: b + 1, text });
    budget -= text.length;
    if (budget <= 0) break;
  }
  return out;
}

const READ_BATCH = 16;

/** Retrieves the most relevant snippets for a question without reading the whole repo. */
export class ContextRetriever {
  constructor(private readonly source: WorkspaceSource) {}

  async retrieve(query: string, opts: RetrieveOptions): Promise<RetrievedSnippet[]> {
    if (opts.maxFiles <= 0 || opts.maxChars <= 0) return [];
    const terms = tokenizeQuery(query);
    const files = await this.source.listFiles(opts.signal);
    if (files.length === 0) return [];
    const exclude = opts.exclude ?? new Set<string>();

    const scores = new Map<string, number>();
    for (const f of files) {
      if (exclude.has(f.relPath)) continue;
      const s = terms.length ? scorePath(f.relPath, terms) * 3 : 0;
      const b = opts.boost?.get(f.relPath) ?? 0;
      if (s + b > 0) scores.set(f.relPath, s + b);
    }

    // The language-server symbol lookup can take a moment; run it alongside the content search.
    const symbols =
      this.source.findSymbolFiles && terms.length
        ? this.source.findSymbolFiles(terms.slice(0, 3).join(' '), opts.signal).catch(() => [] as string[])
        : Promise.resolve([] as string[]);
    const addSymbolScores = async () => {
      for (const p of await symbols) {
        if (!exclude.has(p)) scores.set(p, (scores.get(p) ?? 0) + 4);
      }
    };

    if (terms.length === 0) {
      await addSymbolScores();
      return this.snippetsFor(
        [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.maxFiles),
        terms,
        opts.maxChars,
      );
    }

    // Content search: whole repo when small, otherwise only path-matched candidates.
    const searchSet =
      files.length <= FULL_CONTENT_SEARCH_LIMIT
        ? files.filter((f) => !exclude.has(f.relPath)).map((f) => f.relPath)
        : [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 80)
            .map(([p]) => p);

    const docFreq = new Map<string, number>();
    const hits = new Map<string, Map<string, number>>();
    // Read files in parallel batches rather than one after another.
    const texts = new Map<string, string | undefined>();
    for (let k = 0; k < searchSet.length && !opts.signal?.aborted; k += READ_BATCH) {
      const batch = searchSet.slice(k, k + READ_BATCH);
      const read = await Promise.all(batch.map((p) => this.source.readFile(p).catch(() => undefined)));
      batch.forEach((p, idx) => texts.set(p, read[idx]));
    }
    for (const relPath of searchSet) {
      const text = texts.get(relPath);
      if (!text) continue;
      const lower = text.toLowerCase();
      const perTerm = new Map<string, number>();
      for (const t of terms) {
        const c = countTerm(lower, t, 25);
        if (c > 0) {
          perTerm.set(t, c);
          docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        }
      }
      if (perTerm.size) hits.set(relPath, perTerm);
    }

    await addSymbolScores();
    const n = Math.max(1, searchSet.length);
    for (const [relPath, perTerm] of hits) {
      let content = 0;
      for (const [t, c] of perTerm) {
        const idf = Math.log(1 + n / (docFreq.get(t) ?? 1));
        content += Math.min(c, 8) * idf;
      }
      // Reward files that match several distinct terms.
      content *= 1 + 0.5 * (perTerm.size - 1);
      scores.set(relPath, (scores.get(relPath) ?? 0) + content);
    }

    const ranked = [...scores.entries()]
      .filter(([, s]) => s > 0.5)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, opts.maxFiles);
    return this.snippetsFor(ranked, terms, opts.maxChars);
  }

  private async snippetsFor(
    ranked: Array<[string, number]>,
    terms: string[],
    maxChars: number,
  ): Promise<RetrievedSnippet[]> {
    const out: RetrievedSnippet[] = [];
    let remaining = maxChars;
    for (let i = 0; i < ranked.length && remaining > 200; i++) {
      const [relPath, score] = ranked[i]!;
      const text = await this.source.readFile(relPath);
      if (!text) continue;
      const share = Math.floor(remaining / (ranked.length - i));
      for (const s of extractSnippets(text, terms, share)) {
        out.push({ relPath, score, startLine: s.startLine, endLine: s.endLine, content: s.text });
        remaining -= s.text.length;
      }
    }
    return out;
  }
}

/** Short terms (auth, db, req) only count as whole words / identifier parts to avoid noise. */
function shortTermRegex(t: string): RegExp {
  return new RegExp(`(^|[^a-z])${t}([^a-z]|$)`, 'g');
}

function containsTerm(lowerLine: string, t: string): boolean {
  if (t.length >= 4) return lowerLine.includes(t);
  return shortTermRegex(t).test(lowerLine);
}

function countTerm(lower: string, t: string, cap: number): number {
  if (t.length >= 4) return countOccurrences(lower, t, cap);
  let n = 0;
  for (const _m of lower.matchAll(shortTermRegex(t))) {
    if (++n >= cap) break;
  }
  return n;
}

function countOccurrences(haystack: string, needle: string, cap: number): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && count < cap) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function snippetToContextItem(s: RetrievedSnippet): ContextItem {
  return {
    kind: 'snippet',
    label: `${s.relPath}:${s.startLine}-${s.endLine}`,
    relPath: s.relPath,
    language: languageForPath(s.relPath),
    content: s.content,
  };
}

/** A compact directory overview for @workspace (no file contents). */
export function summarizeTree(files: IndexedFile[], maxLines = 60): string {
  const dirCounts = new Map<string, number>();
  const topFiles: string[] = [];
  for (const f of files) {
    const parts = f.relPath.split('/');
    if (parts.length === 1) {
      topFiles.push(f.relPath);
      continue;
    }
    const d1 = parts[0]!;
    dirCounts.set(`${d1}/`, (dirCounts.get(`${d1}/`) ?? 0) + 1);
    if (parts.length > 2) {
      const d2 = `${d1}/${parts[1]}/`;
      dirCounts.set(d2, (dirCounts.get(d2) ?? 0) + 1);
    }
  }
  const lines: string[] = [`${files.length} source files indexed.`];
  const dirs = [...dirCounts.keys()].sort();
  for (const d of dirs) {
    const depth = d.split('/').length - 2;
    lines.push(`${'  '.repeat(depth)}${d} (${dirCounts.get(d)} files)`);
  }
  for (const f of topFiles.sort()) lines.push(f);
  if (lines.length > maxLines) {
    const hidden = lines.length - maxLines;
    return [...lines.slice(0, maxLines), `… ${hidden} more entries`].join('\n');
  }
  return lines.join('\n');
}

/** Finds relative-path imports in a file so related files can be boosted. */
export function extractImportTargets(fromRelPath: string, content: string): string[] {
  const dir = fromRelPath.includes('/') ? fromRelPath.slice(0, fromRelPath.lastIndexOf('/')) : '';
  const specs = new Set<string>();
  const patterns = [
    /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /#include\s+"([^"]+)"/g,
  ];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) specs.add(m[1]!);
  }
  const out: string[] = [];
  for (const spec of specs) {
    const parts = dir ? dir.split('/') : [];
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    out.push(parts.join('/'));
  }
  return out;
}

/** Maps import specifiers (which often omit extensions) onto indexed files. */
export function matchImportTargets(targets: string[], indexed: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of targets) {
    for (const p of indexed) {
      if (p === t || p.startsWith(`${t}.`) || p.startsWith(`${t}/index.`)) out.add(p);
    }
  }
  return [...out];
}
