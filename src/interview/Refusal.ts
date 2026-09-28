/**
 * Guarded refusals, enforced in code.
 *
 * Small models often "refuse" by explaining the whole implementation first. For refusal
 * turns the controller buffers the reply and passes it through `shortenRefusal`, which
 * keeps a one-sentence refusal plus at most one guiding question or hint. Lists, code and
 * step-by-step explanations are dropped.
 */

export const STANDARD_REFUSAL = "I can't write that for you in Guarded Interview Mode.";
export const STANDARD_HINT =
  "Tell me how you'd do it (the steps, the data you'd use, what happens when something is missing) and I'll write the code for your approach.";

const REFUSAL_RE = /\b(can(?:no|')t|won'?t|will not|not (?:able|allowed|going) to|unable to|I'm not able)\b/i;
const STEP_RE = /^\s*(\d+[.)]|[-*•]|step\s+\d+)/i;
const SOLUTION_HINT_RE =
  /\b(we need to|you need to|you should|you can|we will|we'll|here'?s (?:the|how)|to implement|first,|then,|finally,|add a new|create a new|modify the)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .filter((l) => l.trim() && !STEP_RE.test(l) && !/^\s*#/.test(l) && !/^\s*>/.test(l))
    .join(' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

/** Reduces a guarded refusal to "one refusal sentence + one hint or question". */
export function shortenRefusal(reply: string): string {
  const all = sentences(reply);
  const refusal = all.find((s) => REFUSAL_RE.test(s) && s.length <= 200) ?? STANDARD_REFUSAL;
  // Prefer a guiding question; otherwise a short hint that doesn't walk through the solution.
  const question = all.find((s) => s.endsWith('?') && s !== refusal && s.length <= 220);
  const hint =
    question ??
    all.find(
      (s) =>
        s !== refusal &&
        /\bhint\b/i.test(s) &&
        !SOLUTION_HINT_RE.test(s.replace(/^hint:\s*/i, '')) &&
        s.length <= 220,
    ) ??
    STANDARD_HINT;
  return `${refusal} ${hint}`.trim();
}
