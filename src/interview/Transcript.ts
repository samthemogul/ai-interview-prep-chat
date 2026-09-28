import type { ChatMode, InterviewMode } from './InterviewMode';
import { CHAT_MODE_LABELS, MODE_LABELS } from './InterviewMode';
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
  | 'unguarded'
  | 'edits-proposed';

export const FLAG_LABELS: Record<TurnFlag, string> = {
  'solution-request': 'Asked for code or a solution',
  'task-statement': 'Pasted the task statement',
  'bypass-attempt': 'Tried to change or get around the rules',
  'marker-injection': 'Typed the internal approach marker',
  'guard-removed-code': 'Output guard removed code',
  'approach-implemented': 'AI implemented the candidate’s approach',
  'asked-for-decision': 'AI asked for a missing design decision',
  'refused-outcome-request': 'AI declined an outcome-only request',
  unguarded: 'Asked in Unguarded Mode',
  'edits-proposed': 'AI proposed file edits',
};

/** Flags a reviewer would read as pushing against the guard. */
export const NEGATIVE_FLAGS: ReadonlySet<TurnFlag> = new Set<TurnFlag>([
  'solution-request',
  'task-statement',
  'bypass-attempt',
  'marker-injection',
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
  chatMode?: ChatMode;
  /** Edits the AI proposed in this turn (decisions are separate 'edit' events). */
  edits?: Array<{ id: string; path: string; added: number; removed: number; status: string }>;
}

export interface TranscriptEditDecision {
  type: 'edit';
  at: string;
  editId: string;
  path: string;
  action: 'accepted' | 'rejected' | 'reverted';
  /** Whether the candidate opened the diff before deciding. */
  reviewed: boolean;
  added: number;
  removed: number;
}

export interface TranscriptModeSwitch {
  type: 'mode-switch';
  at: string;
  from: InterviewMode;
  to: InterviewMode;
}

export type TranscriptEvent = TranscriptTurn | TranscriptModeSwitch | TranscriptEditDecision;

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
  if (mode === 'guarded') {
    if (c.likelySolutionRequest && !guard.approach && !c.describesApproach) flags.add('solution-request');
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
  editsProposed: number;
  editsAccepted: number;
  editsRejected: number;
  /** Accepted edits whose diff was never opened: a reviewer would notice this. */
  acceptedWithoutReview: number;
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
    editsProposed: 0,
    editsAccepted: 0,
    editsRejected: 0,
    acceptedWithoutReview: 0,
    flagCounts: {},
  };
  for (const e of session.events) {
    if (e.type === 'mode-switch') {
      s.modeSwitches++;
      continue;
    }
    if (e.type === 'edit') {
      if (e.action === 'accepted') {
        s.editsAccepted++;
        if (!e.reviewed) s.acceptedWithoutReview++;
      } else if (e.action === 'rejected') {
        s.editsRejected++;
      }
      continue;
    }
    s.editsProposed += e.edits?.filter((x) => x.status !== 'failed').length ?? 0;
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
  if (s.editsProposed || s.editsAccepted) {
    out.push(
      `| File edits | ${s.editsProposed} proposed, ${s.editsAccepted} accepted, ${s.editsRejected} rejected |`,
    );
    out.push(`| Edits accepted without opening the diff | ${s.acceptedWithoutReview} |`);
  }
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
    '_On assessment platforms, reviewers see every prompt, response and applied edit. In guarded rounds, repeated attempts to get the answer directly are a negative signal and describing your own approach is a positive one. In unguarded rounds, reviewers look at how well you direct and check the AI: planning first, reviewing diffs and verifying the result._',
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
    if (e.type === 'edit') {
      const verb = e.action === 'accepted' ? 'Accepted' : e.action === 'rejected' ? 'Rejected' : 'Reverted';
      const review =
        e.action === 'accepted'
          ? e.reviewed
            ? ' after reviewing the diff'
            : ' ⚠️ without opening the diff'
          : '';
      out.push(`**${e.at}** — ${verb} edit to \`${e.path}\` (+${e.added} −${e.removed})${review}.`);
      continue;
    }
    n++;
    out.push(`### Turn ${n} · ${MODE_LABELS[e.mode]} · ${CHAT_MODE_LABELS[e.chatMode ?? 'ask']} · ${e.at}`);
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
    out.push(e.response.trim() ? e.response.trim().replace(/^%%EDIT:[\w-]+%%$/gm, '') : '_(no response)_');
    if (e.edits?.length) {
      out.push('');
      out.push('**Proposed edits**');
      out.push('');
      for (const x of e.edits) out.push(`- \`${x.path}\` (+${x.added} −${x.removed}) — ${x.status}`);
    }
  }
  out.push('');
  return out.join('\n');
}
