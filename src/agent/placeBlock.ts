/**
 * Turns an ordinary code block from the model into a file edit.
 *
 * Small local models rarely follow a strict edit format. They write the new or changed
 * function in a normal code block instead. This module works out where that code belongs:
 *
 *  1. The block redefines something that exists (same first line, or same function/class
 *     name) → replace that definition.
 *  2. The block's first and last lines both exist in the file → replace that range.
 *  3. Nothing in the block exists yet → insert it after the last similar top-level block
 *     (for example after the last `@app.get` route), before a `__main__` guard, or at the end.
 *
 * A block with several top-level parts (often the whole file repeated with one function
 * added) is split up first and only the affected parts are applied; see chunks.ts.
 */
import type { ApplyResult } from './applyEdit';
import { COMMENT_LINE, applyOps, fuzzy, planChunks, splitTopLevel } from './chunks';

export interface PlaceOptions {
  /** The user's request, used to tell requested changes from incidental rewrites. */
  request?: string;
  /** Keep comments the model added (only when the user asked for comments). */
  keepComments?: boolean;
}

const LINE_NO_PREFIX = /^\s*\d+\s*\|\s?/;

/** Removes "  12 | " prefixes when the model copied the numbered context it was shown. */
export function stripLineNumberPrefixes(lines: string[]): string[] {
  const nonBlank = lines.filter((l) => l.trim());
  if (!nonBlank.length) return lines;
  const numbered = nonBlank.filter((l) => LINE_NO_PREFIX.test(l)).length;
  if (numbered / nonBlank.length < 0.6) return lines;
  return lines.map((l) => l.replace(LINE_NO_PREFIX, ''));
}

/** A leading comment that names the file, e.g. "# pyserver.py:78-84" or "// src/a.ts". */
export function pathFromCodeComment(line: string): string | undefined {
  const m =
    /^\s*(?:#|\/\/|--|\/\*|<!--)\s*(?:file(?:name)?\s*:\s*)?([\w@.\-/\\]+\.[A-Za-z0-9]{1,10})(?::\d+(?:-\d+)?)?\s*(?:\*\/|-->)?\s*$/i.exec(
      line,
    );
  return m ? m[1] : undefined;
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

const norm = (s: string) => s.trim();
const indentOf = (s: string) => /^\s*/.exec(s)![0].replace(/\t/g, '    ').length;
const isComment = (s: string) => /^\s*(#|\/\/|\/\*|\*|--)/.test(s);

const DEF_START =
  /^\s*(@[\w.]+|(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function|func|fn|interface|struct|enum|impl|trait)\b|(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\(|function)|(?:public|private|protected|static|internal)\b|pub\s+fn\b|\w+\.(?:get|post|put|patch|delete|use|route)\s*\()/;

const DEF_NAME =
  /\b(?:def|class|function|func|fn|interface|struct|enum)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

function defName(line: string): string | undefined {
  const m = DEF_NAME.exec(line);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** Whether a definition starting at `start` uses braces (C-like) rather than indentation. */
function usesBraces(lines: string[], start: number): boolean {
  for (let i = start; i < Math.min(lines.length, start + 6); i++) {
    const l = lines[i]!;
    if (/\{\s*(\/\/.*)?$/.test(l)) return true;
    if (/:\s*(#.*)?$/.test(l) && !/^\s*@/.test(l)) return false;
  }
  return false;
}

function bracesBalanced(block: string[]): boolean {
  let depth = 0;
  for (const raw of block) {
    const l = raw.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
    for (const ch of l) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Last line index of the definition (with decorators) starting at `start`. */
export function definitionEnd(lines: string[], start: number): number {
  if (usesBraces(lines, start)) {
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i++) {
      const l = lines[i]!.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
      for (const ch of l) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') {
          depth--;
        }
      }
      if (opened && depth <= 0) return i;
    }
    return lines.length - 1;
  }
  // Indentation based (Python and similar): skip decorators to the header line.
  let header = start;
  while (header < lines.length - 1 && /^\s*@/.test(lines[header]!)) header++;
  const base = indentOf(lines[header]!);
  let end = header;
  for (let i = header + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    if (indentOf(l) <= base) break;
    end = i;
  }
  return end;
}

/** Start of the definition containing a header at `i`, including decorators above it. */
function withDecorators(lines: string[], i: number): number {
  let s = i;
  while (s > 0 && /^\s*@/.test(lines[s - 1]!)) s--;
  return s;
}

function findLine(lines: string[], target: string, from = 0, skipComments = true): number {
  const t = norm(target);
  if (!t) return -1;
  for (let i = from; i < lines.length; i++) {
    if (skipComments && isComment(lines[i]!)) continue;
    if (norm(lines[i]!) === t) return i;
  }
  return -1;
}

function ok(
  fileLines: string[],
  start: number,
  endExclusive: number,
  replacement: string[],
  crlf: boolean,
): ApplyResult {
  const next = [...fileLines.slice(0, start), ...replacement, ...fileLines.slice(endExclusive)];
  const text = next.join('\n');
  return {
    ok: true,
    content: crlf ? text.replace(/\n/g, '\r\n') : text,
    matched: 'exact',
    startLine: start + 1,
    searchLines: fileLines.slice(start, endExclusive),
    replaceLines: replacement,
  };
}

/** Number of blank lines the file uses between top-level definitions (1 or 2). */
function topLevelGap(lines: string[]): number {
  let twos = 0;
  let ones = 0;
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i]!.trim() || indentOf(lines[i]!) > 0 || !DEF_START.test(lines[i]!)) continue;
    if (!lines[i - 1]!.trim() && !lines[i - 2]!.trim()) twos++;
    else if (!lines[i - 1]!.trim()) ones++;
  }
  return twos > ones ? 2 : 1;
}

/** Result covering only the lines that differ between `before` and `after`. */
function spanResult(before: string[], after: string[], crlf: boolean, note?: string): ApplyResult {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let q = 0;
  while (
    q < before.length - p &&
    q < after.length - p &&
    before[before.length - 1 - q] === after[after.length - 1 - q]
  ) {
    q++;
  }
  const text = after.join('\n');
  return {
    ok: true,
    content: crlf ? text.replace(/\n/g, '\r\n') : text,
    matched: 'exact',
    startLine: p + 1,
    searchLines: before.slice(p, before.length - q),
    replaceLines: after.slice(p, after.length - q),
    note,
  };
}

/** Index after which new top-level code goes: after similar code, before `__main__`, or at the end. */
function insertionPoint(lines: string[], first: string): number {
  const prefix =
    /^\s*(@\w+\.?|def |async def |class |function |export |func |fn |pub fn |\w+\.(?:get|post|put|patch|delete)\()/.exec(
      first,
    )?.[1];
  if (prefix && indentOf(first) === 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (indentOf(l) === 0 && !isComment(l) && l.startsWith(prefix.trimStart())) {
        return definitionEnd(lines, withDecorators(lines, i));
      }
    }
  }
  const main = lines.findIndex((l) => /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(l));
  if (main > 0) {
    let before = main - 1;
    while (before >= 0 && !lines[before]!.trim()) before--;
    return before;
  }
  let lastLine = lines.length - 1;
  while (lastLine >= 0 && !lines[lastLine]!.trim()) lastLine--;
  return lastLine;
}

/** Drops full-line comments the model added (comments already in the file are kept). */
function dropAddedComments(block: string[], known: Set<string>): string[] {
  return block.filter((l) => !COMMENT_LINE.test(l) || known.has(fuzzy(l)));
}

/** Applies a code block as an edit. See the module comment for the placement rules. */
export function applyBlock(original: string | undefined, code: string, opts: PlaceOptions = {}): ApplyResult {
  let block = trimBlankEdges(stripLineNumberPrefixes(code.replace(/\r\n/g, '\n').split('\n')));
  if (block.length && pathFromCodeComment(block[0]!)) block = trimBlankEdges(block.slice(1));
  if (!block.length) return { ok: false, reason: 'The code block was empty.' };

  if (original === undefined) {
    if (!opts.keepComments) block = trimBlankEdges(dropAddedComments(block, new Set()));
    return {
      ok: true,
      content: block.join('\n') + '\n',
      matched: 'create',
      startLine: 1,
      searchLines: [],
      replaceLines: block,
    };
  }

  const crlf = original.includes('\r\n');
  const lines = (crlf ? original.replace(/\r\n/g, '\n') : original).split('\n');
  const noop: ApplyResult = { ok: false, reason: 'NOOP: the code is already in the file.' };
  const fuzzyKnown = new Set(lines.map(fuzzy).filter(Boolean));
  if (!opts.keepComments) block = trimBlankEdges(dropAddedComments(block, fuzzyKnown));
  // Collapse runs of blank lines left behind by removed comments.
  block = block.filter((l, i) => l.trim() || i < 2 || block[i - 1]!.trim() || block[i - 2]!.trim());
  const nonBlank = block.filter((l) => l.trim());
  if (!nonBlank.length) return noop;
  const first = nonBlank[0]!;
  const last = nonBlank[nonBlank.length - 1]!;

  const same = (a: string[], b: string[]) =>
    a
      .filter((l) => l.trim())
      .map(norm)
      .join('\n') ===
    b
      .filter((l) => l.trim())
      .map(norm)
      .join('\n');

  // Code that is entirely already in the file (including commented-out code) is an echo,
  // not a change, however it is positioned.
  if (nonBlank.every((l) => fuzzyKnown.has(fuzzy(l)))) return noop;

  // Several top-level parts (often the whole file repeated): apply only the affected parts.
  if (indentOf(first) === 0) {
    const chunks = splitTopLevel(block);
    const plan = chunks
      ? planChunks(lines, chunks, {
          request: opts.request,
          gap: topLevelGap(lines),
          insertAt: (firstLine) => insertionPoint(lines, firstLine) + 1,
        })
      : undefined;
    if (plan) {
      const next = plan.ops.length ? applyOps(lines, plan.ops) : lines;
      if (next) {
        const notes: string[] = [];
        if (plan.alsoChanged.length) {
          notes.push(
            `Also updated ${plan.alsoChanged.map((n) => `\`${n}\``).join(', ')} (the model changed it too).`,
          );
        }
        if (plan.keptUnchanged.length) {
          notes.push(
            `Left ${plan.keptUnchanged.map((n) => `\`${n}\``).join(', ')} as it was (not part of your request).`,
          );
        }
        const note = notes.length ? notes.join(' ') : undefined;
        if (next === lines || next.join('\n') === lines.join('\n')) return noop;
        return spanResult(lines, next, crlf, note);
      }
    }
  }

  const incomplete: ApplyResult = {
    ok: false,
    reason:
      'This code looks incomplete (it would remove most of the existing definition), so it was not applied.',
  };

  // 1. The block starts with a definition that already exists → replace that definition
  //    (and any following definitions from the block that also exist, contiguously).
  let start = findLine(lines, first);
  if (start < 0) {
    const name = defName(
      nonBlank.find((l) => /\b(def|class|function|func|fn)\b|=\s*(async\s*)?\(/.test(l)) ?? '',
    );
    if (name) {
      const re = new RegExp(
        `\\b(?:def|class|function|func|fn|interface|struct)\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=`,
      );
      const at = lines.findIndex((l) => !isComment(l) && re.test(l));
      if (at >= 0) start = withDecorators(lines, at);
    }
  }
  if (start >= 0 && DEF_START.test(lines[start]!)) {
    let end = definitionEnd(lines, start);
    // Extend over later definitions in the block that directly follow in the file.
    let probe = end + 1;
    while (probe < lines.length && !lines[probe]!.trim()) probe++;
    while (
      probe < lines.length &&
      DEF_START.test(lines[probe]!) &&
      indentOf(lines[probe]!) === indentOf(lines[start]!)
    ) {
      const header = lines[probe]!;
      if (!block.some((b) => norm(b) === norm(header))) break;
      end = definitionEnd(lines, probe);
      probe = end + 1;
      while (probe < lines.length && !lines[probe]!.trim()) probe++;
    }
    const region = lines.slice(start, end + 1);
    if (same(region, block)) return noop;
    // Safety: a partial snippet (unbalanced braces, or much shorter than what it would
    // replace) must never overwrite a whole definition.
    if (usesBraces(lines, start) && !bracesBalanced(block)) return incomplete;
    const regionSize = region.filter((l) => l.trim()).length;
    if (regionSize >= 6 && nonBlank.length < regionSize * 0.4) return incomplete;
    return ok(lines, start, end + 1, block, crlf);
  }

  // 2. First and last lines both exist, in order, not too far apart → replace that range.
  if (start >= 0) {
    const distinctive =
      norm(last).length >= 8 && !/^[\s})\];,]*$/.test(last) && !/^return\b/.test(norm(last));
    const endAt = distinctive ? findLine(lines, last, start) : -1;
    if (endAt >= start && endAt - start + 1 <= block.length * 2 + 10) {
      const region = lines.slice(start, endAt + 1);
      if (same(region, block)) return noop;
      return ok(lines, start, endAt + 1, block, crlf);
    }
  }

  // If most of the block already exists but we couldn't anchor it, don't guess.
  // Commented-out code counts as "already there": echoing it back is not a change.
  const knownCount = nonBlank.filter((l) => fuzzyKnown.has(fuzzy(l))).length;
  if (knownCount === nonBlank.length) return noop;
  if (knownCount / nonBlank.length >= 0.5) {
    return {
      ok: false,
      reason:
        "Couldn't work out where this code goes in the file. Try asking for just the new or changed function.",
    };
  }

  // 3. New code → insert after the last similar top-level block, before a __main__ guard, or at the end.
  const gap = topLevelGap(lines);
  const insertAfter = insertionPoint(lines, first);
  const pad = Array.from({ length: gap }, () => '');
  // Keep the blank lines that already followed the insertion point after the new block.
  let after = insertAfter + 1;
  while (after < lines.length && !lines[after]!.trim()) after++;
  const trailing = after < lines.length ? pad : [''];
  const replacement = [...(insertAfter >= 0 ? pad : []), ...block, ...trailing];
  return ok(lines, insertAfter + 1, after, replacement, crlf);
}
