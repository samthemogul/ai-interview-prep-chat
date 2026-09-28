import type { InterviewMode } from './InterviewMode';
import { MODE_LABELS } from './InterviewMode';
import type { Classification } from './RequestClassifier';
import type { GuardReport, RemovalReason } from './OutputGuard';
import { EXTENSION_DISPLAY_NAME } from '../constants';

export type TurnFlag =
  | 'solution-request'
  | 'task-statement'
  | 'bypass-attempt'
  | 'marker-injection'
  | 'guard-removed-code'
  | 'approach-implemented'
  | 'asked-for-decision'
  | 'refused-outcome-request'
  | 'unguarded';

export const FLAG_LABELS: Record<TurnFlag, string> = {
  'solution-request': 'Asked for code or a solution',
  'task-statement': 'Pasted the task statement',
  'bypass-attempt': 'Tried to change or get around the rules',
  'marker-injection': 'Typed the internal approach marker',
  'guard-removed-code': 'Output guard removed code',
  'approach-implemented': 'AI implemented the candidate’s approach',
  'asked-for-decision': 'AI asked for a missing design decision',
  'refused-outcome-request': 'AI declined an outcome-only request',
  unguarded: 'Asked in Normal Mode (unguarded)',
};

/** Flags a reviewer would read as pushing against the guard. */
export const NEGATIVE_FLAGS: ReadonlySet<TurnFlag> = new Set<TurnFlag>([
  'solution-request',
  'task-statement',
  'bypass-attempt',
  'marker-injection',
  'unguarded',
]);

export interface TranscriptTurn {
  type: 'turn';
  at: string;
  mode: InterviewMode;
  model: string;
  prompt: string;
  response: string;
  contextSources: string[];
  flags: TurnFlag[];
  removed: RemovalReason[];
  stopped?: boolean;
  error?: string;
}

export interface TranscriptModeSwitch {
  type: 'mode-switch';
  at: string;
  from: InterviewMode;
  to: InterviewMode;
}

export type TranscriptEvent = TranscriptTurn | TranscriptModeSwitch;

export interface TranscriptSession {
  version: 1;
  id: string;
  startedAt: string;
  updatedAt: string;
  workspaceName: string;
  events: TranscriptEvent[];
}

export function newSession(id: string, workspaceName: string, now = new Date()): TranscriptSession {
  const at = now.toISOString();
  return { version: 1, id, startedAt: at, updatedAt: at, workspaceName, events: [] };
}

export function deriveFlags(
  mode: InterviewMode,
  c: Classification,
  guard: GuardReport,
  response: string,
): TurnFlag[] {
  const flags = new Set<TurnFlag>();
  if (mode === 'normal') flags.add('unguarded');
  if (c.markerStripped) flags.add('marker-injection');
  if (c.bypassAttempt) flags.add('bypass-attempt');
  if (c.looksLikeTaskStatement) flags.add('task-statement');
  if (c.likelySolutionRequest && !guard.approach && !c.describesApproach) flags.add('solution-request');
  if (mode === 'guarded') {
    if (guard.removed.length) flags.add('guard-removed-code');
    if (guard.approach) flags.add('approach-implemented');
    const hasCode = /```|~~~/.test(response);
    const tail = response.trim().slice(-300);
    if ((c.describesApproach || c.explicitImplement) && !guard.approach && !hasCode && tail.includes('?')) {
      flags.add('asked-for-decision');
    }
    if (c.likelySolutionRequest && !guard.approach && !c.describesApproach && !c.explicitImplement) {
      flags.add('refused-outcome-request');
    }
  }
  return [...flags];
}

export interface TranscriptSummary {
  turns: number;
  guardedTurns: number;
  unguardedTurns: number;
  flaggedTurns: number;
  approachTurns: number;
  guardRemovals: number;
  modeSwitches: number;
  flagCounts: Partial<Record<TurnFlag, number>>;
}

export function summarize(session: TranscriptSession): TranscriptSummary {
  const s: TranscriptSummary = {
    turns: 0,
    guardedTurns: 0,
    unguardedTurns: 0,
    flaggedTurns: 0,
    approachTurns: 0,
    guardRemovals: 0,
    modeSwitches: 0,
    flagCounts: {},
  };
  for (const e of session.events) {
    if (e.type === 'mode-switch') {
      s.modeSwitches++;
      continue;
    }
    s.turns++;
    if (e.mode === 'guarded') s.guardedTurns++;
    else s.unguardedTurns++;
    if (e.flags.some((f) => NEGATIVE_FLAGS.has(f))) s.flaggedTurns++;
    if (e.flags.includes('approach-implemented')) s.approachTurns++;
    s.guardRemovals += e.removed.length;
    for (const f of e.flags) s.flagCounts[f] = (s.flagCounts[f] ?? 0) + 1;
  }
  return s;
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Renders a session as the read-only Markdown a reviewer would see. */
export function renderTranscriptMarkdown(session: TranscriptSession): string {
  const s = summarize(session);
  const out: string[] = [];
  out.push(`# ${EXTENSION_DISPLAY_NAME} practice transcript`);
  out.push('');
  out.push(`- Workspace: ${session.workspaceName}`);
  out.push(`- Started: ${session.startedAt}`);
  out.push(`- Last activity: ${session.updatedAt}`);
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`| | |`);
  out.push(`|---|---|`);
  out.push(`| Turns | ${s.turns} (${s.guardedTurns} guarded, ${s.unguardedTurns} unguarded) |`);
  out.push(`| Flagged turns | ${s.flaggedTurns} |`);
  out.push(`| Approaches implemented | ${s.approachTurns} |`);
  out.push(`| Code removed by the guard | ${s.guardRemovals} |`);
  out.push(`| Mode switches | ${s.modeSwitches} |`);
  out.push('');
  const flagEntries = Object.entries(s.flagCounts) as Array<[TurnFlag, number]>;
  if (flagEntries.length) {
    out.push('Flags:');
    out.push('');
    for (const [f, n] of flagEntries) {
      out.push(`- ${NEGATIVE_FLAGS.has(f) ? '⚠️ ' : ''}${FLAG_LABELS[f]}: ${n}`);
    }
    out.push('');
  }
  out.push(
    '_On assessment platforms, reviewers see every prompt and response. Repeated attempts to get the answer directly are a negative signal; describing your own approach is a positive one._',
  );
  out.push('');
  out.push('## Timeline');
  let n = 0;
  for (const e of session.events) {
    out.push('');
    if (e.type === 'mode-switch') {
      out.push(`**${e.at}** — Switched from ${MODE_LABELS[e.from]} to ${MODE_LABELS[e.to]}.`);
      continue;
    }
    n++;
    out.push(`### Turn ${n} · ${MODE_LABELS[e.mode]} · ${e.at}`);
    if (e.flags.length) {
      out.push('');
      out.push(e.flags.map((f) => `${NEGATIVE_FLAGS.has(f) ? '⚠️' : '•'} ${FLAG_LABELS[f]}`).join('  \n'));
    }
    if (e.contextSources.length) {
      out.push('');
      out.push(`Context: ${e.contextSources.map((p) => `\`${p}\``).join(', ')}`);
    }
    out.push('');
    out.push('**Candidate**');
    out.push('');
    out.push(quoteBlock(e.prompt));
    out.push('');
    out.push(`**AI**${e.stopped ? ' (stopped)' : ''}${e.error ? ` (error: ${e.error})` : ''}`);
    out.push('');
    out.push(e.response.trim() ? e.response.trim() : '_(no response)_');
  }
  out.push('');
  return out.join('\n');
}
