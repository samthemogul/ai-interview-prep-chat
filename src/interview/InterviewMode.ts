import type { ChatMode } from './GuardedPrompt';

export type InterviewMode = 'guarded' | 'normal';
export type { ChatMode };

export const MODE_LABELS: Record<InterviewMode, string> = {
  guarded: 'Guarded Interview Mode',
  normal: 'Unguarded Mode',
};

export const MODE_SHORT_LABELS: Record<InterviewMode, string> = {
  guarded: 'Guarded',
  normal: 'Unguarded',
};

export const MODE_DESCRIPTIONS: Record<InterviewMode, string> = {
  guarded:
    'The AI explains code, errors and concepts, helps you navigate, and writes code only for approaches you describe. It will not solve the task for you.',
  normal:
    'The AI behaves like an ordinary coding assistant and can solve the task, like the unguarded Code Repos assistant in real assessments.',
};

export const CHAT_MODES: ChatMode[] = ['ask', 'plan', 'agent'];

export const CHAT_MODE_LABELS: Record<ChatMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Agent',
};

export const CHAT_MODE_DESCRIPTIONS: Record<ChatMode, string> = {
  ask: 'Questions and answers in the chat. The AI never touches your files.',
  plan: 'Build and refine an implementation plan before writing code.',
  agent: 'The AI proposes file edits. You review each one as a diff and accept or reject it.',
};

export function isChatMode(v: unknown): v is ChatMode {
  return v === 'ask' || v === 'plan' || v === 'agent';
}

export function otherMode(mode: InterviewMode): InterviewMode {
  return mode === 'guarded' ? 'normal' : 'guarded';
}

/** Switching away from guarded practice needs explicit confirmation (spec 9.4). */
export function requiresConfirmation(from: InterviewMode, to: InterviewMode): boolean {
  return from === 'guarded' && to === 'normal';
}
