import { APPROACH_LINE_CAP, GUARDED_EXAMPLE_BLOCK_CAP, GUARDED_EXAMPLE_LINE_CAP } from './GuardedPrompt';

export type RemovalReason = 'too-long' | 'too-many-blocks' | 'rewrite' | 'diff' | 'approach-limit';

export interface GuardReport {
  /** True when the model opened its response with the approach marker. */
  approach: boolean;
  removed: RemovalReason[];
  shownBlocks: number;
}

export interface OutputGuardOptions {
  /** False in Normal Mode: text passes through untouched. */
  enabled: boolean;
  /** The candidate's own code (selection, open file, referenced files) for rewrite detection. */
  referenceTexts?: string[];
  /**
   * Whether the request looked like an approach to the extension (or used /implement).
   * The model's marker only unlocks code when this is true, so a small model that adds the
   * marker to every answer can't unlock solutions for outcome-only requests. Default true.
   */
  allowApproach?: boolean;
}

const NOTICES: Record<RemovalReason, string> = {
  'too-long': `Code removed: Guarded Interview Mode only allows short generic examples (up to ${GUARDED_EXAMPLE_LINE_CAP} lines). Describe how to do it (steps, data structures, control flow), or start your message with /implement, to get code for your approach.`,
  'too-many-blocks': 'Code removed: Guarded Interview Mode allows one short example per answer.',
  rewrite:
    "Code removed: Guarded Interview Mode doesn't rewrite your code. Describe the change you want to make and the AI can implement your approach.",
  diff: 'Code removed: Guarded Interview Mode never shows diffs or patches.',
  'approach-limit': `Code removed: approach implementations are limited to ${APPROACH_LINE_CAP} lines. Split the approach into a smaller change.`,
};

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
/** The marker at the start of a line, optionally wrapped in Markdown emphasis and followed by text. */
const LEADING_MARKER = /^\s*[*_`]{0,3}\[\s*approach\s*\][*_`]{0,3}\s*[:\-\u2013\u2014]?\s*/i;
/** The marker anywhere in a line. */
const ANY_MARKER = /[*_`]{0,3}\[\s*approach\s*\][*_`]{0,3}[ \t]*/gi;

/**
 * Enforces Guarded Interview Mode limits on streamed model output (spec 10A).
 *
 * Text outside code blocks is released as soon as it's safe; fenced code blocks are held
 * back until they close (or overflow the cap) and are then shown or replaced by a notice,
 * so code is never displayed and then removed.
 */
export class OutputGuard {
  private pending = '';
  /** Characters of `pending` already released to the UI. */
  private released = 0;
  private sawContent = false;
  private approach = false;
  private inCode = false;
  private fenceChar = '';
  private fenceLen = 0;
  private fenceLang = '';
  private openLine = '';
  private codeLines: string[] = [];
  private overflow = false;
  private shownBlocks = 0;
  private approachLinesUsed = 0;
  private readonly removed: RemovalReason[] = [];
  private readonly referenceTokens: Array<Set<string>>;
  private readonly referenceLines: Set<string>;

  constructor(private readonly opts: OutputGuardOptions) {
    const refs = (opts.referenceTexts ?? []).map(stripLineNumbers);
    this.referenceTokens = refs.map((r) => new Set(significantTokens(r)));
    this.referenceLines = new Set(
      refs.flatMap((r) =>
        r
          .split('\n')
          .map(normalizeLine)
          .filter((l) => l.length >= 12),
      ),
    );
  }

  get report(): GuardReport {
    return { approach: this.approach, removed: [...this.removed], shownBlocks: this.shownBlocks };
  }

  /** Feeds a streamed chunk; returns the text that is now safe to display. */
  push(chunk: string): string {
    if (!this.opts.enabled) return chunk;
    this.pending += chunk;
    let out = '';
    let nl: number;
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl);
      const alreadyReleased = this.released;
      this.pending = this.pending.slice(nl + 1);
      this.released = 0;
      out += this.processLine(line, alreadyReleased, true);
    }
    if (!this.inCode && this.pending.length > this.released && this.canReleasePartial(this.pending)) {
      out += this.pending.slice(this.released);
      this.released = this.pending.length;
      this.sawContent = this.sawContent || this.pending.trim().length > 0;
    }
    return out;
  }

  /** Flushes the remainder when the stream ends or is stopped. */
  finish(): string {
    if (!this.opts.enabled) return '';
    let out = '';
    if (this.pending.length) {
      const line = this.pending;
      const alreadyReleased = this.released;
      this.pending = '';
      this.released = 0;
      out += this.processLine(line, alreadyReleased, false);
    }
    if (this.inCode) out += this.closeBlock();
    return out;
  }

  private canReleasePartial(partial: string): boolean {
    const t = partial.trimStart();
    if (!t) return false;
    // Could still become a fence or a marker line: wait for the newline.
    if (t.startsWith('`') || t.startsWith('~')) return false;
    if (t.startsWith('[') || t.startsWith('*') || t.startsWith('_')) return false;
    return true;
  }

  private processLine(line: string, alreadyReleased: number, hadNewline: boolean): string {
    const nl = hadNewline ? '\n' : '';
    if (this.inCode) {
      if (this.isClosingFence(line)) {
        this.inCode = false;
        return this.closeBlock();
      }
      this.codeLines.push(line);
      if (this.codeLines.length > this.currentLineCap()) this.overflow = true;
      return '';
    }

    // Small models often write "[APPROACH] Here is…" on one line instead of a line of its own.
    const marker = LEADING_MARKER.exec(line);
    if (marker) {
      // Only a marker at the very start of the response counts, and only when the request
      // looked like an approach. Stray or unearned markers are simply removed.
      if (!this.sawContent && this.opts.allowApproach !== false) this.approach = true;
      line = line.slice(marker[0].length);
      alreadyReleased = 0;
      if (!line.trim()) return '';
    }
    const trimmed = line.trim();

    const open = FENCE_OPEN.exec(line);
    if (open) {
      this.inCode = true;
      this.fenceChar = open[1]![0]!;
      this.fenceLen = open[1]!.length;
      this.fenceLang = (open[2] ?? '').toLowerCase();
      this.openLine = line;
      this.codeLines = [];
      this.overflow = false;
      this.sawContent = true;
      return '';
    }

    if (trimmed) this.sawContent = true;
    return line.slice(alreadyReleased).replace(ANY_MARKER, '') + nl;
  }

  private isClosingFence(line: string): boolean {
    const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    return !!m && m[1]![0] === this.fenceChar && m[1]!.length >= this.fenceLen;
  }

  private currentLineCap(): number {
    return this.approach ? APPROACH_LINE_CAP - this.approachLinesUsed : GUARDED_EXAMPLE_LINE_CAP;
  }

  private closeBlock(): string {
    this.inCode = false;
    const reason = this.evaluate();
    const lines = this.codeLines;
    this.codeLines = [];
    if (reason) {
      this.removed.push(reason);
      return `\n> ${NOTICES[reason]}\n\n`;
    }
    this.shownBlocks++;
    if (this.approach) this.approachLinesUsed += lines.length;
    // Unclosed blocks (stream ended or stopped) get a closing fence so Markdown stays valid.
    const fence = this.fenceChar.repeat(this.fenceLen);
    return `${this.openLine}\n${lines.join('\n')}${lines.length ? '\n' : ''}${fence}\n`;
  }

  private evaluate(): RemovalReason | undefined {
    const lines = this.codeLines;
    if (this.fenceLang === 'diff' || this.fenceLang === 'patch' || isDiff(lines)) return 'diff';
    if (this.overflow) return this.approach ? 'approach-limit' : 'too-long';
    if (this.approach) return undefined;
    if (this.shownBlocks >= GUARDED_EXAMPLE_BLOCK_CAP) return 'too-many-blocks';
    if (this.isRewrite(lines)) return 'rewrite';
    return undefined;
  }

  private isRewrite(lines: string[]): boolean {
    if (this.referenceTokens.length === 0) return false;
    const tokens = new Set(significantTokens(lines.join('\n')));
    if (tokens.size < 4) return false;
    const sharedLine = lines.some((l) => {
      const n = normalizeLine(l);
      return n.length >= 12 && this.referenceLines.has(n);
    });
    for (const ref of this.referenceTokens) {
      let common = 0;
      for (const t of tokens) if (ref.has(t)) common++;
      const overlap = common / tokens.size;
      if ((overlap >= 0.75 && sharedLine) || (overlap >= 0.9 && tokens.size >= 6)) return true;
    }
    return false;
  }
}

/** Detects unified-diff style output: hunk headers or mostly +/- prefixed lines. */
export function isDiff(lines: string[]): boolean {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return false;
  if (nonEmpty.some((l) => /^@@ .* @@/.test(l) || /^(\+\+\+|---) [ab/]/.test(l))) return true;
  const plus = nonEmpty.filter((l) => /^\+(?!\+)/.test(l)).length;
  const minus = nonEmpty.filter((l) => /^-(?!-|\d)/.test(l)).length;
  return plus >= 1 && minus >= 1 && (plus + minus) / nonEmpty.length >= 0.5;
}

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue class public private ' +
    'protected static void int long float double bool boolean string char new this self def import from as ' +
    'export default true false null none nil undefined async await try catch finally throw throws raise ' +
    'except pass in of is not and or fn func go defer struct type interface impl use mut pub let elif end'
  ).split(/\s+/),
);

export function significantTokens(text: string): string[] {
  return (text.match(/[A-Za-z_$][\w$]*|\d+/g) ?? []).filter(
    (t) => t.length >= 2 && !KEYWORDS.has(t.toLowerCase()),
  );
}

function normalizeLine(l: string): string {
  return l.replace(/\s+/g, ' ').trim();
}

/** Removes the "  12 | " prefixes added by withLineNumbers. */
export function stripLineNumbers(text: string): string {
  return text.replace(/^ *\d+ \| /gm, '');
}
