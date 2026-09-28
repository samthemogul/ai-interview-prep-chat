export type InterviewMode = 'guarded' | 'normal';

export const MODE_LABELS: Record<InterviewMode, string> = {
  guarded: 'Guarded Interview Mode',
  normal: 'Normal Mode',
};

export const MODE_SHORT_LABELS: Record<InterviewMode, string> = {
  guarded: 'Guarded',
  normal: 'Normal (unguarded)',
};

export const MODE_DESCRIPTIONS: Record<InterviewMode, string> = {
  guarded:
    'The AI explains code, errors and concepts, helps you navigate, and writes code only for approaches you describe. It will not solve the task for you.',
  normal:
    'The AI behaves like an ordinary coding assistant. Use this for learning, not for interview practice.',
};

export function otherMode(mode: InterviewMode): InterviewMode {
  return mode === 'guarded' ? 'normal' : 'guarded';
}

/** Switching away from guarded practice needs explicit confirmation (spec 9.4). */
export function requiresConfirmation(from: InterviewMode, to: InterviewMode): boolean {
  return from === 'guarded' && to === 'normal';
}
