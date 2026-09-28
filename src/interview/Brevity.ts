/**
 * Light, non-destructive cleanup of assistant prose (display only).
 *
 * Short answers are asked for in the system prompt, not forced by cutting the model off:
 * this never truncates by length and never stops generation, so a code block or edit that
 * comes after some text is always delivered. All it removes, while streaming, is:
 *
 *  - filler one-liners ("I hope this helps", "Let me know if…");
 *  - whole labelled sections the user said they don't want — "Explanation", "How it works",
 *    "Summary", "Testing" and the like — up to the next heading, code block or edit card.
 *
 * Code blocks and edit-card placeholders always pass through untouched. If the user asked
 * for detail, the controller skips this entirely.
 */
import type { ChatMode } from './GuardedPrompt';

/** The user asked for a longer explanation, so no cleanup is applied. */
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
  /^\s*(?:#{1,6}\s*|\*\*)?(?:explanation|how it works|how this works|what (?:this|it) does|what changed|summary|in summary|testing|how to test|example usage|additional notes|breakdown|walkthrough|conclusion)s?\b\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const ANY_HEADING = /^\s*#{1,6}\s+\S/;

export interface LimiterOptions {
  chatMode: ChatMode;
}

/**
 * Streams text through, dropping filler lines and labelled noise sections. It buffers only
 * whole lines (and a partial line it hasn't decided on yet), so it adds no latency to code.
 */
export class ProseLimiter {
  private pending = '';
  private released = 0;
  private inFence = false;
  private fenceMarker = '';
  private inNoiseSection = false;
  /** True once anything was removed. */
  trimmed = false;

  // Retained so existing callers referencing these compile; always false/0 now that nothing
  // is truncated or counted for an early stop.
  readonly suppressed = 0;

  constructor(_options: LimiterOptions = { chatMode: 'ask' }) {}

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

  /** Streams part of the current line once it's clearly ordinary prose (not a fence, filler or section header). */
  private partial(): string {
    if (this.inFence) {
      if (this.pending.length > this.released && !FENCE.test(this.pending)) {
        const s = this.pending.slice(this.released);
        this.released = this.pending.length;
        return s;
      }
      return '';
    }
    if (this.inNoiseSection) return '';
    const t = this.pending;
    if (t.length <= this.released) return '';
    // Wait until the line is long enough to tell it isn't a header/fence/filler line.
    if (t.trimStart().length < 24) return '';
    if (/^\s*[`~%#<=>]/.test(t) || NOISE_SECTION.test(t) || FILLER.test(t)) return '';
    const s = t.slice(this.released);
    this.released = t.length;
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
      this.inFence = true;
      this.fenceMarker = fence[1]!;
      this.inNoiseSection = false;
      return rest + nl;
    }
    if (PLACEHOLDER.test(line.trim())) {
      this.inNoiseSection = false;
      return rest + nl;
    }
    if (!line.trim()) {
      return this.inNoiseSection ? '' : rest + nl;
    }
    if (NOISE_SECTION.test(line)) {
      this.inNoiseSection = true;
      this.trimmed = true;
      return '';
    }
    if (ANY_HEADING.test(line)) this.inNoiseSection = false;
    if (this.inNoiseSection || FILLER.test(line)) {
      this.trimmed = true;
      return '';
    }
    return rest + nl;
  }
}

/** Removes filler and labelled sections from finished text (used for buffered replies). */
export function limitProse(text: string, options: LimiterOptions = { chatMode: 'ask' }): string {
  const l = new ProseLimiter(options);
  return (l.push(text) + l.finish()).replace(/\n{3,}/g, '\n\n').trim();
}
