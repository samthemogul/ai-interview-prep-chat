/**
 * Applies only the affected parts of a large code block.
 *
 * Small models often answer "add an endpoint" by repeating the whole file: the imports
 * (sometimes rewritten), the setup code, every existing function and any commented-out
 * code, with the new function somewhere in the middle. Inserting that block would
 * duplicate everything. Instead the block is split into top-level chunks and each chunk is
 * compared with the file:
 *
 *  - unchanged definitions, setup lines and comments are skipped;
 *  - new definitions are inserted next to their neighbours from the block;
 *  - changed definitions are applied only when they are part of the request (see below);
 *  - imports are merged: only names the applied code actually uses are added, into the
 *    existing import line when there is one.
 *
 * A changed definition is treated as part of the request when the block adds nothing new
 * (it is purely a modification), or when the request names it. Otherwise it is an
 * incidental rewrite (for example `from pymongo import MongoClient` turned into
 * `import pymongo`) and is left alone.
 */

/** Python and C-like comment lines. "#include", "#!" and CSS "#id" selectors are not comments. */
export const COMMENT_LINE = /^\s*(#(\s|$)|\/\/)/;

const IMPORT_START =
  /^(from\s+[\w.]+\s+import\b|import\b|(?:const|let|var)\s+[\w{}\s,]+=\s*require\(|using\s+[\w.]+;|#include\b|use\s+[\w:]+)/;

const DECORATOR = /^@[\w.]/;

const DEF_HEADER =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function\*?|func|fn|interface|struct|enum|impl|trait|type)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|function\b|[A-Za-z_$][\w$]*\s*=>)|^pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)|^if\s+__name__\s*==\s*['"]__main__['"]\s*:/;

const ASSIGNMENT = /^(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$.]*)\s*(?::[^=]+)?=(?!=)/;

export type ChunkKind = 'import' | 'def' | 'assign' | 'comment' | 'other';

export interface Chunk {
  kind: ChunkKind;
  /** Code lines, including decorators and comments directly above a definition. */
  lines: string[];
  name?: string;
}

const indentOf = (s: string) => /^\s*/.exec(s)![0].replace(/\t/g, '    ').length;

/** Normalises a line for "is this the same code" comparisons. */
export function fuzzy(s: string): string {
  return s
    .trim()
    .replace(/'/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/\s*([()[\]{}:,=+\-*/<>])\s*/g, '$1')
    .replace(/,([)\]}])/g, '$1');
}

function defHeaderName(line: string): string | undefined {
  const m = DEF_HEADER.exec(line.trim());
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3] ?? '__main__';
}

function bracketDepth(line: string): number {
  const l = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/(#|\/\/).*$/, '');
  let d = 0;
  for (const ch of l) {
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
  }
  return d;
}

/**
 * End (inclusive) of a top-level statement starting at `start`: indented continuation
 * lines, lines inside open brackets, and a closing bracket line at column 0.
 */
function statementEnd(lines: string[], start: number): number {
  let depth = bracketDepth(lines[start]!);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) {
      if (depth > 0) continue;
      // A blank line inside an indented body (Python) doesn't end the statement.
      const next = lines.slice(i + 1).find((x) => x.trim());
      if (next !== undefined && indentOf(next) > 0 && !COMMENT_LINE.test(next)) continue;
      break;
    }
    if (depth > 0 || indentOf(l) > 0 || /^[)\]}]/.test(l.trim())) {
      depth += bracketDepth(l);
      end = i;
      continue;
    }
    break;
  }
  return end;
}

/**
 * Splits a block into top-level chunks. Returns undefined when the block isn't a sequence
 * of top-level statements (for example an indented method body).
 */
export function splitTopLevel(block: string[]): Chunk[] | undefined {
  const chunks: Chunk[] = [];
  let i = 0;
  let pendingComments: string[] = [];
  const flushComments = () => {
    if (pendingComments.length) chunks.push({ kind: 'comment', lines: pendingComments });
    pendingComments = [];
  };
  while (i < block.length) {
    const line = block[i]!;
    if (!line.trim()) {
      flushComments();
      i++;
      continue;
    }
    if (indentOf(line) > 0 && !COMMENT_LINE.test(line)) return undefined;
    if (COMMENT_LINE.test(line)) {
      pendingComments.push(line);
      i++;
      continue;
    }
    const t = line.trim();
    if (IMPORT_START.test(t)) {
      flushComments();
      const end = statementEnd(block, i);
      chunks.push({ kind: 'import', lines: block.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (DECORATOR.test(t) || DEF_HEADER.test(t)) {
      let header = i;
      while (header < block.length - 1 && DECORATOR.test(block[header]!.trim())) {
        header = statementEnd(block, header) + 1;
      }
      const name = defHeaderName(block[header] ?? '');
      const end = name ? statementEnd(block, header) : statementEnd(block, i);
      // Comments directly above a definition belong to it.
      chunks.push({ kind: 'def', lines: [...pendingComments, ...block.slice(i, end + 1)], name });
      pendingComments = [];
      i = end + 1;
      continue;
    }
    flushComments();
    const end = statementEnd(block, i);
    const assign = ASSIGNMENT.exec(t);
    chunks.push(
      assign
        ? { kind: 'assign', lines: block.slice(i, end + 1), name: assign[1] }
        : { kind: 'other', lines: block.slice(i, end + 1) },
    );
    i = end + 1;
  }
  flushComments();
  return chunks;
}

// ---------------------------------------------------------------------------------------
// Finding chunks in the file

interface Region {
  start: number;
  /** Inclusive. */
  end: number;
}

function withDecorators(lines: string[], i: number): number {
  let s = i;
  while (s > 0 && DECORATOR.test(lines[s - 1]!.trim())) s--;
  return s;
}

function findDefinition(lines: string[], name: string): Region | undefined {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (indentOf(l) > 0 || COMMENT_LINE.test(l)) continue;
    if (defHeaderName(l) === name) {
      return { start: withDecorators(lines, i), end: statementEnd(lines, i) };
    }
  }
  return undefined;
}

function findAssignment(lines: string[], name: string): Region | undefined {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (indentOf(l) > 0 || COMMENT_LINE.test(l)) continue;
    const m = ASSIGNMENT.exec(l.trim());
    if (m && m[1] === name && !DEF_HEADER.test(l.trim())) return { start: i, end: statementEnd(lines, i) };
  }
  return undefined;
}

const codeOnly = (ls: string[]) => ls.filter((l) => l.trim() && !COMMENT_LINE.test(l)).map(fuzzy);
const sameCode = (a: string[], b: string[]) => codeOnly(a).join('\n') === codeOnly(b).join('\n');

// ---------------------------------------------------------------------------------------
// Imports

interface ParsedImport {
  module: string;
  /** Imported names as written ("a", "b as c"); empty for a whole-module import. */
  names: string[];
  /** Names the import binds in the file's scope. */
  bound: string[];
  style: 'py-from' | 'py-import' | 'js-named' | 'js-default' | 'other';
}

function parseImport(text: string): ParsedImport | undefined {
  const t = text.replace(/\s+/g, ' ').trim();
  let m = /^from ([\w.]+) import \(?([^)]*)\)?$/.exec(t);
  if (m) {
    const names = m[2]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      module: m[1]!,
      names,
      bound: names.map((n) =>
        n
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      ),
      style: 'py-from',
    };
  }
  m = /^import ([\w.]+)(?: as (\w+))?$/.exec(t);
  if (m) return { module: m[1]!, names: [], bound: [m[2] ?? m[1]!.split('.')[0]!], style: 'py-import' };
  m = /^import (?:(\w+)\s*,\s*)?\{([^}]*)\} from ['"]([^'"]+)['"];?$/.exec(t);
  if (m) {
    const names = m[2]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      module: m[3]!,
      names,
      bound: [
        ...(m[1] ? [m[1]] : []),
        ...names.map((n) =>
          n
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        ),
      ],
      style: 'js-named',
    };
  }
  m = /^import (?:\* as )?(\w+) from ['"]([^'"]+)['"];?$/.exec(t);
  if (m) return { module: m[2]!, names: [], bound: [m[1]!], style: 'js-default' };
  return undefined;
}

const uses = (code: string, name: string) =>
  new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\b`).test(code);

interface Op {
  start: number;
  /** Exclusive. */
  end: number;
  lines: string[];
}

function lastImportLine(lines: string[]): number {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || COMMENT_LINE.test(l) || /^["']{3}/.test(l.trim())) continue;
    if (indentOf(l) === 0 && IMPORT_START.test(l.trim())) {
      last = statementEnd(lines, i);
      i = last;
      continue;
    }
    if (indentOf(l) === 0 && last >= 0) break;
  }
  return last;
}

function importOps(lines: string[], imports: Chunk[], appliedCode: string): Op[] {
  const ops: Op[] = [];
  const toAdd: string[] = [];
  const fileImports: Array<{ i: number; parsed: ParsedImport }> = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (indentOf(l) > 0 || !IMPORT_START.test(l.trim())) continue;
    const parsed = parseImport(l);
    if (parsed) fileImports.push({ i, parsed });
  }
  const knownLines = new Set(lines.map(fuzzy));
  const modified = new Map<number, string[]>();

  for (const chunk of imports) {
    const text = chunk.lines.join(' ');
    if (chunk.lines.every((l) => knownLines.has(fuzzy(l)))) continue;
    const imp = parseImport(text);
    if (!imp) continue;
    const usedBound = imp.bound.filter((b) => uses(appliedCode, b));
    if (!usedBound.length) continue;
    const sameModule = fileImports.filter((f) => f.parsed.module === imp.module);
    const alreadyBound = new Set(fileImports.flatMap((f) => f.parsed.bound));
    const missing = imp.names.filter((n) => {
      const b = n
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      return usedBound.includes(b) && !alreadyBound.has(b);
    });

    if (imp.style === 'py-from' || imp.style === 'js-named') {
      if (!missing.length) continue;
      const target = sameModule.find((f) => f.parsed.style === imp.style);
      if (target) {
        const current = modified.get(target.i)?.[0] ?? lines[target.i]!;
        const merged =
          imp.style === 'py-from'
            ? current.replace(/(\S)\s*$/, `$1, ${missing.join(', ')}`)
            : current.replace(/\s*\}/, `, ${missing.join(', ')} }`);
        modified.set(target.i, [merged]);
      } else {
        toAdd.push(
          imp.style === 'py-from'
            ? `from ${imp.module} import ${missing.join(', ')}`
            : text.replace(/\{[^}]*\}/, `{ ${missing.join(', ')} }`),
        );
      }
      continue;
    }
    // Whole-module imports: add only if nothing in the file binds that name yet.
    if (usedBound.every((b) => alreadyBound.has(b))) continue;
    toAdd.push(chunk.lines.join('\n'));
  }

  for (const [i, replacement] of modified) ops.push({ start: i, end: i + 1, lines: replacement });
  if (toAdd.length) {
    const after = lastImportLine(lines);
    const addLines = toAdd.flatMap((t) => t.split('\n'));
    if (after >= 0) {
      ops.push({ start: after + 1, end: after + 1, lines: addLines });
    } else {
      // No imports yet: put them at the top (after a shebang, encoding line or docstring is
      // too fiddly; the top is fine for the files this is used on).
      ops.push({ start: 0, end: 0, lines: [...addLines, ''] });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------------------
// Planning

export interface ChunkPlan {
  ops: Op[];
  /** Names of changed definitions that were left alone because they weren't requested. */
  keptUnchanged: string[];
}

function mentioned(request: string | undefined, chunk: Chunk): boolean {
  if (!request || !chunk.name) return false;
  const req = request.toLowerCase();
  const name = chunk.name.toLowerCase().replace(/^.*\./, '');
  if (new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(req)) return true;
  // Routes are often named by their path: "update the /create endpoint".
  const route = /@\w+\.\w+\(\s*["']([^"']+)["']/.exec(chunk.lines.join('\n'))?.[1];
  return !!route && route !== '/' && req.includes(route.toLowerCase());
}

/**
 * Plans the edits for a multi-chunk block, or returns undefined when the block should be
 * handled as a single piece of code.
 */
export function planChunks(
  lines: string[],
  chunks: Chunk[],
  opts: { request?: string; gap: number; insertAt: (firstLine: string) => number },
): ChunkPlan | undefined {
  const code = chunks.filter((c) => c.kind !== 'comment');
  if (code.length < 2 && !chunks.some((c) => c.kind === 'import')) return undefined;

  type Status = 'same' | 'changed' | 'new' | 'skip';
  const knownLines = new Set(lines.map(fuzzy).filter(Boolean));
  const located: Array<{ chunk: Chunk; status: Status; region?: Region }> = chunks.map((chunk) => {
    if (chunk.kind === 'comment' || chunk.kind === 'import') return { chunk, status: 'skip' };
    const region =
      chunk.kind === 'def' && chunk.name
        ? findDefinition(lines, chunk.name)
        : chunk.kind === 'assign' && chunk.name
          ? findAssignment(lines, chunk.name)
          : undefined;
    if (region) {
      const same = sameCode(lines.slice(region.start, region.end + 1), chunk.lines);
      return { chunk, status: same ? 'same' : 'changed', region };
    }
    if (chunk.lines.every((l) => !l.trim() || knownLines.has(fuzzy(l)))) {
      // Unchanged top-level statement (e.g. an existing route): remember where it is so new
      // code can go next to it.
      const head = fuzzy(chunk.lines.find((l) => l.trim() && !COMMENT_LINE.test(l)) ?? '');
      const at = head
        ? lines.findIndex((l) => indentOf(l) === 0 && !COMMENT_LINE.test(l) && fuzzy(l) === head)
        : -1;
      return at >= 0
        ? { chunk, status: 'same', region: { start: at, end: statementEnd(lines, at) } }
        : { chunk, status: 'same' };
    }
    return { chunk, status: 'new' };
  });

  // Nothing in the block exists in the file: it's all new code; let the caller insert it.
  if (!located.some((l) => l.status === 'same' || l.status === 'changed')) {
    if (!chunks.some((c) => c.kind === 'import')) return undefined;
  }

  const hasNew = located.some((l) => l.status === 'new');
  const changed = located.filter((l) => l.status === 'changed');
  const named = changed.filter((l) => mentioned(opts.request, l.chunk));
  // Without anything new, a pure modification applies, unless the request was to add
  // something (then the block is an echo with incidental rewrites) or it names what to change.
  const asksToAdd = !!opts.request && /\b(add|create|new|implement|write|insert)\b/i.test(opts.request);
  const applyChanged = hasNew || asksToAdd ? named : named.length ? named : changed;
  const keptUnchanged = changed
    .filter((l) => !applyChanged.includes(l))
    .map((l) => l.chunk.name!)
    .filter(Boolean);

  const ops: Op[] = [];
  const applied: string[] = [];
  for (const l of applyChanged) {
    ops.push({ start: l.region!.start, end: l.region!.end + 1, lines: l.chunk.lines });
    applied.push(...l.chunk.lines);
  }

  // Insert runs of consecutive new chunks after the nearest preceding chunk that exists in
  // the file (or before the next one), keeping the model's ordering.
  const pad = Array.from({ length: opts.gap }, () => '');
  for (let k = 0; k < located.length; k++) {
    if (located[k]!.status !== 'new') continue;
    const run: Chunk[] = [];
    let j = k;
    while (j < located.length && (located[j]!.status === 'new' || located[j]!.status === 'skip')) {
      if (located[j]!.status === 'new') run.push(located[j]!.chunk);
      j++;
    }
    const runLines: string[] = [];
    for (const c of run) {
      if (runLines.length) runLines.push(...pad);
      runLines.push(...c.lines);
    }
    applied.push(...runLines);

    let before = -1;
    for (let p = k - 1; p >= 0; p--) {
      const r = located[p]!.region;
      if (r && located[p]!.chunk.kind !== 'import') {
        before = r.end;
        break;
      }
    }
    let at: number;
    let replacement: string[];
    if (before >= 0) {
      at = before + 1;
      replacement = [...pad, ...runLines];
    } else {
      const next = located.slice(j).find((l) => l.region && l.chunk.kind !== 'import')?.region;
      if (next) {
        at = next.start;
        replacement = [...runLines, ...pad];
      } else {
        at = opts.insertAt(run[0]!.lines.find((l) => l.trim() && !COMMENT_LINE.test(l)) ?? '');
        replacement = [...(at > 0 ? pad : []), ...runLines];
      }
    }
    ops.push({ start: at, end: at, lines: replacement });
    k = j - 1;
  }

  ops.push(
    ...importOps(
      lines,
      chunks.filter((c) => c.kind === 'import'),
      applied.join('\n'),
    ),
  );
  return { ops, keptUnchanged };
}

/** Applies non-overlapping operations (bottom-up so indices stay valid). */
export function applyOps(lines: string[], ops: Op[]): string[] | undefined {
  // Bottom-up; for inserts at the same point, the later op goes in first so the original
  // order is kept.
  const sorted = ops
    .map((op, idx) => ({ op, idx }))
    .sort((a, b) => b.op.start - a.op.start || b.op.end - a.op.end || b.idx - a.idx)
    .map((x) => x.op);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k]!.end > sorted[k - 1]!.start) return undefined;
  }
  const out = [...lines];
  for (const op of sorted) out.splice(op.start, op.end - op.start, ...op.lines);
  return out;
}
