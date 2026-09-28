/**
 * Stops the model from "continuing the prompt".
 *
 * Context is sent as `<workspace_context> … </workspace_context>` followed by
 * `Candidate's message:`, with each item under a heading like `### Relevant snippet: …`.
 * A weak model, especially several turns in, sometimes stops answering and instead
 * autocompletes that format: it reprints the context headings, closes the tag, and writes a
 * fresh `Candidate's message:` — often turning snippet contents (env vars, other files'
 * code) into bogus edits along the way.
 *
 * This filter watches the raw stream and, the moment one of those scaffolding markers
 * appears, drops it and everything after and reports `tripped`, so the controller stops
 * generating. It sits before the edit extractor, so bogus edits after the marker never form.
 * The markers are strings the extension itself emits and that never belong in a real answer.
 */

/** Scaffolding strings that only appear when the model is echoing the prompt, not answering. */
const LEAK_MARKERS = [
  '<workspace_context>',
  '</workspace_context>',
  "Candidate's message:",
  'Relevant snippet:',
  'Current file:',
  'Selected code:',
  'Workspace structure:',
];

const MAX_MARKER_LEN = Math.max(...LEAK_MARKERS.map((m) => m.length));

export class PromptLeakFilter {
  private buffer = '';
  /** True once a scaffolding marker was seen; everything after it is dropped. */
  tripped = false;

  /** Earliest marker index in `text`, or -1. */
  private firstMarker(text: string): number {
    let at = -1;
    for (const m of LEAK_MARKERS) {
      const i = text.indexOf(m);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    return at;
  }

  push(chunk: string): string {
    if (this.tripped) return '';
    this.buffer += chunk;
    const at = this.firstMarker(this.buffer);
    if (at >= 0) {
      this.tripped = true;
      const out = this.buffer.slice(0, at);
      this.buffer = '';
      return out.replace(/\s+$/, '');
    }
    // Hold back a tail that could be the start of a marker split across chunks.
    if (this.buffer.length > MAX_MARKER_LEN) {
      const cut = this.buffer.length - (MAX_MARKER_LEN - 1);
      const out = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      return out;
    }
    return '';
  }

  /** Flushes whatever was held back (only when no marker was ever seen). */
  finish(): string {
    if (this.tripped) return '';
    const out = this.buffer;
    this.buffer = '';
    return out;
  }
}
