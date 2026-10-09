// Phase shifts (issue #548, design.md "Phase shifts"). A job is in one phase: doing the work, researching, or writing a
// proposal. A question it asks can be answered with a phase shift — Research this, Propose this — with a note scoping
// the aspect, in one of two modes. A fork spins off a separate job asked for research or a proposal about the aspect;
// its parent keeps waiting on its question (or is parked), and the fork's accepted result answers that question. A
// switch moves the same job, in its session, into the phase; once its report or proposal is accepted, the person picks
// whether it goes back to work with the result, ends, or — from research — goes on to a proposal. A job or an
// escalation level may suggest a shift; only a person, or a level the settings allow, makes one. A fork shows on its
// question (issue #570), and is told when the question is answered without it; its parent, that it still runs. Pure:
// no I/O. Re-exported from types.ts.
import { asksOfSpec, REVIEW_KINDS, REVIEW_SECTIONS, type ReviewItem, type ReviewKind, type ReviewStatus } from './review.ts';
import type { JobStatus } from './types.ts';

/** The phases a job is in: the work, or a review section's special job. */
export const JOB_PHASES = ['work', ...REVIEW_KINDS] as const;
export type JobPhase = typeof JOB_PHASES[number];

/** How a shift is made: a separate job about the aspect, or the same job moved into the phase. */
export const SHIFT_MODES = ['fork', 'switch'] as const;
export type ShiftMode = typeof SHIFT_MODES[number];

/** What a parent does while its fork runs: waits on its question, or is parked (where its executor can park). */
export const FORK_PARENT = ['wait', 'park'] as const;
export type ForkParent = typeof FORK_PARENT[number];

/** What a switched job does once its report or proposal is accepted: back to work, end, or on to a proposal (research only). */
export const SHIFT_THEN = ['work', 'end', 'proposal'] as const;
export type ShiftThen = typeof SHIFT_THEN[number];

/** The phase-shift settings, the user's, in the database and read at each shift. `levels`: the escalation levels that may shift a job themselves. */
export interface PhaseShiftSettings { defaultMode: ShiftMode; forkParent: ForkParent; levels: string[] }
export const DEFAULT_PHASE_SHIFT_SETTINGS: PhaseShiftSettings = { defaultMode: 'fork', forkParent: 'wait', levels: [] };

/** The settings, with what may be chosen for them: the escalation levels there are now. */
export interface PhaseShiftSettingsView extends PhaseShiftSettings { choices: { levels: string[] } }

/** A shift a job or a level suggests on a question: the card offers it as a one-click choice. `by`: `job`, or the level. */
export interface PhaseSuggestion { to: ReviewKind; note?: string; by: string }

/** A switch in force: the job moved into `to` from its question; cleared when it goes back to work. */
export interface PhaseSwitch { to: ReviewKind; questionId: string; note?: string; by: string; at: string }

/** A fork's link to its parent: the job and question it was forked from, what it was asked for, and the question as it was. */
export interface ForkOf {
  jobId: string;
  questionId: string;
  kind: ReviewKind;
  note?: string;
  /** The question's text when it was forked: the fork is told it. */
  question: string;
  /**
   * The parent's source item: where the fork came from, the repository its work tree holds, and the source whose
   * connection it acts through. The fork has no source of its own: the sync never reports it to the parent's item.
   */
  source?: { source: string; kind: string; key: string; url?: string; title?: string; repo?: string };
  /** Its question, answered without it while it runs (issue #570): the answer, who gave it, and once the fork was told. */
  answered?: ForkAnswered;
}

/** A forked-from question's answer, kept on the fork: it takes it into account. `told`: the fork has been given it. */
export interface ForkAnswered { answer: string; by: string; at: string; told?: true }

/**
 * A fork as its question shows it (issue #570): its job and what it was asked for, whether it still runs, and its
 * review item once it wrote one.
 */
export interface QuestionFork {
  jobId: string;
  kind: ReviewKind;
  note?: string;
  jobStatus: JobStatus;
  running: boolean;
  itemId?: string;
  itemStatus?: ReviewStatus;
}

/** A job's phase-shift fields (issue #548). */
export interface JobPhaseFields {
  /** Its phase, set by a phase shift; absent: phaseOf derives it from the spec. */
  phase?: JobPhase;
  /** The switch in force: the job moved into a research or proposal phase from its question. */
  shift?: PhaseSwitch;
  /** The job and question this one was forked from: a separate research or proposal job about one aspect. */
  forkOf?: ForkOf;
  /** The jobs forked from this one's questions, oldest first. */
  forks?: string[];
}

/** A question's: the phase shift the job or a level suggested on it; the card offers it as one click. */
export interface QuestionPhaseFields { suggestion?: PhaseSuggestion }

/** A question trail entry's: the phase shift the level suggested. */
export interface AttemptPhaseFields { suggest?: { to: ReviewKind; note?: string } }

/** What a question offers: the modes the server takes now (none: `refusal` says why), and the default. */
export interface QuestionShifts { modes: ShiftMode[]; defaultMode: ShiftMode; refusal?: string }

/** The job's phase: the one a shift set; else the special job its spec asks for, at the one it has reached; else the work. */
export function phaseOf(job: { phase?: JobPhase; spec: { proposal?: true; research?: true }; proposalId?: string }): JobPhase {
  if (job.phase) return job.phase;
  const asks = asksOfSpec(job.spec);
  if (asks.length === 0) return 'work';
  return asks.includes('proposal') && job.proposalId ? 'proposal' : asks[0]!;
}

/** A job as the routes answer it: with its phase always named (issue #548), derived where no shift set it. */
export const withPhase = <J extends { phase?: JobPhase; spec: { proposal?: true; research?: true }; proposalId?: string }>(job: J): J & { phase: JobPhase } => ({ ...job, phase: phaseOf(job) });

/** What a switched job may be told to do once its `kind` item is accepted. */
export const thenChoices = (kind: ReviewKind): ShiftThen[] => (kind === 'research' ? ['work', 'end', 'proposal'] : ['work', 'end']);

/** The words a person or a job names a shift with: `research`, `propose` / `proposal`. */
const SUGGEST = /^\s*suggest\s*:\s*(research|propos(?:e|al))\b\s*(?:[—–:-]\s*)?(.*)$/i;

/** A job's suggestion in its question: a line `Suggest: research — <aspect>` or `Suggest: proposal — <aspect>`. */
export function suggestionIn(text: string): PhaseSuggestion | undefined {
  for (const line of text.split('\n')) {
    const m = SUGGEST.exec(line);
    if (!m) continue;
    const note = m[2]!.trim();
    return { to: m[1]!.toLowerCase() === 'research' ? 'research' : 'proposal', ...(note ? { note } : {}), by: 'job' };
  }
  return undefined;
}

/** The protocol line every job is told: how to suggest a shift on its question. */
export const SUGGEST_PROTOCOL = 'If your question needs research or a proposal before it can be answered, say so on a line of its own before HOPPER_QUESTION: "Suggest: research — <the aspect>" or "Suggest: proposal — <the aspect>". A person decides.';

const aspect = (note: string | undefined): string => (note ? ` The aspect: ${note}` : '');

/** What a switched job is told in its session: research or propose first, then come back with the document. */
export function switchBrief(to: ReviewKind, note: string | undefined): string {
  return `[hopper phase] Your question is not answered yet: first ${to === 'research' ? 'research it' : 'write a proposal for it'}.${aspect(note)}\n${REVIEW_SECTIONS[to].ask.replace('This job asks you', 'You are asked')}`;
}

/** What a fork is told of its question answered without it: the answer, to take into account. */
const answeredLines = (f: ForkOf): string =>
  `The question was answered meanwhile, directly. Take that answer into account; your ${REVIEW_SECTIONS[f.kind].noun} still goes to review. The answer:\n${f.answered!.answer}`;

/** What a fork is told after its job rules: the question it was forked from, the aspect, and its answer if it has one. */
export function forkBrief(f: ForkOf): string {
  return `[hopper fork] This job was forked from another job's question, to ${f.kind === 'research' ? 'research' : 'write a proposal for'} one aspect of it.${aspect(f.note)}\nThe question was:\n${f.question}${f.answered ? `\n${answeredLines(f)}` : ''}`;
}

/** What a fork that started before its question was answered is told when it next resumes (issue #570). */
export const forkAnsweredBrief = (f: ForkOf): string => `[hopper fork] The question this job was forked from: ${answeredLines(f)}`;

/**
 * What a parent is told when it resumes from a question a fork of which still runs (issue #570): the fork is not the
 * answer it waits for any more, and its result goes to review on its own.
 */
export function forkRunningBrief(forkId: string, f: ForkOf): string {
  const t = REVIEW_SECTIONS[f.kind];
  return `[hopper fork] A ${t.noun} about ${f.note ?? 'your question'} was forked from your question and is still being written (job ${forkId}). Your question is answered now, so its result does not come to you: it goes to review on its own, and its reviewer is told your question was answered.`;
}

/** The accepted result of a fork, as its parent is told it: the answer to its question. */
export function forkAnswer(p: ReviewItem, f: ForkOf): string {
  const t = REVIEW_SECTIONS[p.kind];
  const notes = p.signOff?.notes ? `\nThe person's notes: ${p.signOff.notes}` : '';
  return `[hopper fork] A ${t.noun} was made about your question${f.note ? ` (${f.note})` : ''} and accepted. Use it as the answer, or as context for it:${notes}\n\n${p.versions.at(-1)!.text}`;
}

/** What a switched job is told when it goes back to work: its document's decision, with the document as context. */
export function backToWorkBrief(p: ReviewItem): string {
  const t = REVIEW_SECTIONS[p.kind];
  const how = p.status === 'accepted' ? 'was accepted' : 'was rejected';
  const notes = p.signOff?.notes ? ` Its notes: ${p.signOff.notes}` : '';
  return `[hopper phase] Your ${t.noun} ${how}.${notes}\nGo back to the work, in this session, with it as context. When the job is completely finished, end your message with a line containing only HOPPER_DONE.`;
}
