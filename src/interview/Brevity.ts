/**
 * Keeps explanations short, enforced in code.
 *
 * Prompts ask for brief answers, but models (large and small) like to add "Explanation",
 * "How it works" and "Let me know if…" sections. `ProseLimiter` sits at the end of the
 * output pipeline and, while streaming:
 *
 *  - counts sentences and list items outside code blocks and stops showing prose once the
 *    budget for the chat mode is used up;
 *  - drops filler ("I hope this helps", "Let me know if…") and whole trailing sections such
 *    as "Explanation:", "How it works", "Testing" or "Summary";
 *  - always passes code blocks and edit cards through (code is the answer).
 *
 * It also tells the controller when generation can stop early because everything still to
 * come would be hidden anyway, which saves the time a local model spends writing it.
 */
import type { ChatMode } from './GuardedPrompt';

/** Sentence (or list item) budgets for prose outside code. */
export const PROSE_BUDGET: Record<ChatMode, number> = { ask: 5, agent: 3, plan: 10 };

/** The user asked for a longer explanation, so no budget applies. */
export function wantsDetail(text: string): boolean {
  return /\b(in (?:more )?detail|detailed|elaborate|explain (?:more|further|fully|thoroughly|everything)|step[- ]by[- ]step|walk me through|deep ?dive|in depth|thorough(?:ly)?|longer answer|explain (?:it |this )?like)\b/i.test(
    text,
  );
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const PLACEHOLDER = /^%%EDIT:[\w-]+%%$/;
const FILLER =
  /^\s*(?:[-*]\s*)?(?:i hope (?:this|that) helps|let me know\b|feel free to\b|if you (?:have|need) any (?:more |other |further )?(?:questions|help)|happy coding|good luck|hope this (?:helps|clarifies)|is there anything else)/i;
const NOISE_SECTION =
  /^\s*(?:#{1,6}\s*|\*\*)?(?:explanation|how it works|how this works|what (?:this|it) does|what changed|summary|in summary|notes?|testing|how to test|usage|example usage|additional notes|key (?:points|changes)|breakdown|walkthrough|conclusion)s?\b\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const ANY_HEADING = /^\s*#{1,6}\s+\S/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;

/** Counts sentence ends in a piece of prose (inline code is ignored). */
function sentenceEnds(text: string): number {
  const t = text.replace(/`[^`]*`/g, 'x').replace(/\b(?:e\.g|i\.e|etc|vs|approx|Mr|Dr)\./gi, 'x');
  return (t.match(/[.?!](?=\s|$)/g) ?? []).length;
}

export interface LimiterOptions {
  chatMode: ChatMode;
  /** Undefined means no budget (the user asked for detail). */
  budget?: number;
}

export class ProseLimiter {
  private pending = '';
  private released = 0;
  private inFence = false;
  private fenceMarker = '';
  private used = 0;
  private inNoiseSection = false;
  private lineHeld = false;
  /** Sentences hidden after the budget ran out. */
  suppressed = 0;
  /** Lines or sentences hidden since the last code block or edit card. */
  suppressedSinceCode = 0;
  /** True once some prose was hidden. */
  trimmed = false;

  constructor(private readonly options: LimiterOptions) {}

  /** Whether prose is currently being hidden (the budget is used up, or a noise section). */
  get exhausted(): boolean {
    return this.options.budget !== undefined && this.used >= this.options.budget;
  }

  get insideCode(): boolean {
    return this.inFence;
  }

  push(chunk: string): string {
    this.pending += chunk;
    let out = '';
    let nl: number;
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl);
      const already = this.released;
      this.pending = this.pending.slice(nl + 1);
      this.released = 0;
      this.lineHeld = false;
      out += this.line(line, already, true);
    }
    out += this.partial();
    return out;
  }

  finish(): string {
    if (!this.pending) return '';
    const line = this.pending;
    const already = this.released;
    this.pending = '';
    this.released = 0;
    return this.line(line, already, false);
  }

  /**
   * Streams part of the current line when it is safe to: long enough to know it isn't a
   * heading, filler or a fence, and within the budget.
   */
  private partial(): string {
    if (this.inFence) {
      // Code streams straight through.
      if (this.pending.length > this.released && !FENCE.test(this.pending) && this.pending.length > 3) {
        const s = this.pending.slice(this.released);
        this.released = this.pending.length;
        return s;
      }
      return '';
    }
    if (this.inNoiseSection || this.exhausted) return '';
    const t = this.pending;
    if (t.length <= this.released) return '';
    if (!this.lineHeld && t.trimStart().length < 24) return '';
    if (/^\s*[`~%#<=>]/.test(t) || NOISE_SECTION.test(t) || FILLER.test(t)) return '';
    this.lineHeld = true;
    // Release up to the end of the last sentence that still fits in the budget.
    let end = t.length;
    if (this.options.budget !== undefined) {
      const cut = cutAfterSentences(t, this.options.budget - this.used, LIST_ITEM.test(t));
      if (cut !== undefined) end = cut;
    }
    if (end <= this.released) return '';
    const s = t.slice(this.released, end);
    this.released = end;
    return s;
  }

  private line(line: string, already: number, hadNewline: boolean): string {
    const nl = hadNewline ? '\n' : '';
    const rest = line.slice(already);
    const fence = FENCE.exec(line);
    if (this.inFence) {
      if (fence && fence[1]![0] === this.fenceMarker[0] && fence[1]!.length >= this.fenceMarker.length) {
        this.inFence = false;
      }
      return rest + nl;
    }
    if (fence) {
      this.suppressedSinceCode = 0;
      this.inFence = true;
      this.fenceMarker = fence[1]!;
      this.inNoiseSection = false;
      return rest + nl;
    }
    if (PLACEHOLDER.test(line.trim())) {
      this.suppressedSinceCode = 0;
      this.inNoiseSection = false;
      return rest + nl;
    }
    if (!line.trim()) {
      return this.exhausted || this.inNoiseSection ? '' : rest + nl;
    }
    if (NOISE_SECTION.test(line)) {
      this.inNoiseSection = true;
      this.trimmed = true;
      this.suppressedSinceCode++;
      return '';
    }
    if (ANY_HEADING.test(line)) this.inNoiseSection = false;
    if (this.inNoiseSection || FILLER.test(line)) {
      this.trimmed = true;
      this.suppressedSinceCode++;
      return '';
    }

    const isItem = LIST_ITEM.test(line);
    const count = isItem ? 1 : Math.max(1, sentenceEnds(line.replace(/[.?!]\s*$/, '.')));
    const budget = this.options.budget;
    if (budget === undefined) return rest + nl;
    if (this.used >= budget) {
      this.used += count;
      this.suppressed += count;
      this.suppressedSinceCode += count;
      this.trimmed = true;
      return '';
    }
    const room = budget - this.used;
    this.used += count;
    if (count <= room) return rest + nl;
    // Keep only the sentences that fit.
    this.trimmed = true;
    this.suppressed += count - room;
    this.suppressedSinceCode += count - room;
    const cut = cutAfterSentences(line, room, isItem) ?? line.length;
    const kept = line.slice(0, cut);
    if (kept.length <= already) return nl && already ? nl : '';
    return kept.slice(already).trimEnd() + nl;
  }
}

/**
 * Index just after the `n`th sentence end in `text`, or undefined if there are fewer.
 * A list item counts as a single sentence.
 */
function cutAfterSentences(text: string, n: number, isItem: boolean): number | undefined {
  if (isItem) return n >= 1 ? undefined : 0;
  if (n <= 0) return 0;
  const masked = text
    .replace(/`[^`]*`/g, (m) => 'x'.repeat(m.length))
    .replace(/\b(?:e\.g|i\.e|etc|vs|approx|Mr|Dr)\./gi, (m) => 'x'.repeat(m.length));
  const re = /[.?!](?=\s|$)/g;
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    seen++;
    if (seen === n) return m.index + 1;
  }
  return undefined;
}

/** Removes filler and noise sections from finished text (used for buffered replies). */
export function limitProse(text: string, options: LimiterOptions): string {
  const l = new ProseLimiter(options);
  return (l.push(text) + l.finish()).replace(/\n{3,}/g, '\n\n').trim();
}
