// Completion reviews (issue #2846, design.md "Completion reviews"): when a job ends, the hopper reviews its run from what it
// kept — the job's events, its token ledger and its chain of runs — and keeps the review with the job. Where its time went
// (each stage, longest first), what went well, where it stalled, its restarts and their causes, its waste signals (issue
// #2302, `token-waste.ts`), and the changes of config, routing, lanes, templates or prompts that would have helped. Rules
// only: no model reads the run. The settings say which jobs are reviewed. Pure: the pass (src/engine/completion-reviews.ts)
// gathers the facts and keeps the review.
import type { WaitOnKind } from './wait-on.ts';
import { tokenWaste, type TokenWaste } from './token-waste.ts';
import type { TokenTotals } from './token-usage.ts';

/** The ends of a job a completion review may follow: `finished` (done, or partly done), `failed` and `cancelled`. */
export const REVIEW_OUTCOMES = ['finished', 'failed', 'cancelled'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/**
 * Which ended jobs are reviewed. `on`: off, none is. `outcomes`: the ends reviewed. `multiJob`: a job of a work item that had
 * more than one job is reviewed whatever its end. `minRunMinutes`: a job that ran less than this, on its first run, is
 * trivial and not reviewed.
 */
export interface CompletionReviewSettings { on: boolean; outcomes: ReviewOutcome[]; multiJob: boolean; minRunMinutes: number }

/** Default: on, for failed jobs and for the jobs of work items with more than one job, from 5 minutes of run. */
export const DEFAULT_COMPLETION_REVIEW: CompletionReviewSettings = { on: true, outcomes: ['failed'], multiJob: true, minRunMinutes: 5 };

/** The longest minimum run time, a day in minutes. */
export const MAX_REVIEW_MIN_RUN_MINUTES = 24 * 60;

export const completionReviewSettingsOf = (s: Partial<CompletionReviewSettings> | undefined): CompletionReviewSettings => ({ ...DEFAULT_COMPLETION_REVIEW, ...s });

/**
 * Where a job's time went: `queued` (waiting for a lane, held too), `running` (on a lane), `person` (waiting on a person: a
 * question, or its own wait on an approval, a grant or an infra plan), `waiting` (its own wait on anything else) and `parked`.
 */
export const REVIEW_STAGES = ['queued', 'running', 'person', 'waiting', 'parked'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/** What stopped a run before its end: each kind once, with how often and the causes the events gave. */
export const RESTART_KINDS = ['requeued', 'preempted', 'parked', 'link_lost', 'oom_killed', 'heap_retry'] as const;
export type RestartKind = (typeof RESTART_KINDS)[number];

/** Where a suggested change goes. */
export const SUGGESTION_AREAS = ['config', 'routing', 'lane', 'template', 'prompt'] as const;
export type SuggestionArea = (typeof SUGGESTION_AREAS)[number];

export interface StageTime { stage: ReviewStage; ms: number }
export interface Restart { kind: RestartKind; count: number; causes: string[] }
export interface Suggestion { area: SuggestionArea; text: string }

/** A completion review: kept with its job (table `completion_reviews`), made once, after the job ended. */
export interface CompletionReview {
  jobId: string;
  outcome: ReviewOutcome;
  reviewedAt: string;
  /** From the job's creation to its end. */
  durationMs: number;
  /** Each stage it spent time in, longest first. */
  stages: StageTime[];
  /** The jobs of its work item, this one too; 1: it was the only one. */
  jobs: number;
  /** The questions it asked. */
  questions: number;
  went: string[];
  stalls: string[];
  restarts: Restart[];
  waste: TokenWaste[];
  suggestions: Suggestion[];
}

/** One event of the job, as the review reads it. */
export interface ReviewEvent { type: string; at: string; data?: unknown }

export interface CompletionReviewInput {
  job: { id: string; status: string; createdAt: string; finishedAt?: string; updatedAt: string; attempts: number; partlyDone?: string; commits?: number };
  /** The job's events, oldest first. */
  events: readonly ReviewEvent[];
  /** Its token ledger summed; absent: none read. */
  tokens?: TokenTotals;
  /** The jobs of its work item, itself too. */
  jobs: number;
  at: string;
}

const MINUTE = 60_000;
/** A stage other than running that takes at least this long, and this share of the run, is a stall. */
const STALL_MS = 10 * MINUTE;
const STALL_SHARE = 0.2;
/** At most this many causes are kept per restart kind. */
const MAX_CAUSES = 3;

const PERSON_WAITS: readonly WaitOnKind[] = ['question', 'approval', 'grant', 'plan'];

export const isReviewOutcome = (s: string): s is ReviewOutcome => (REVIEW_OUTCOMES as readonly string[]).includes(s);

/** Minutes and hours, as people read them. */
export function durationText(ms: number): string {
  const min = Math.round(ms / MINUTE);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The stage each event moves the job to; undefined: it stays where it is. */
function stageAfter(e: ReviewEvent): ReviewStage | undefined {
  const d = (e.data ?? {}) as { on?: { kind?: WaitOnKind }; ownCommand?: boolean; to?: string };
  switch (e.type) {
    case 'job.queued': case 'job.requeued': case 'job.held': return 'queued';
    case 'job.claimed': case 'job.started': case 'question.answered': case 'job.wait_ended': return 'running';
    case 'question.asked': return 'person';
    case 'job.waiting': return d.ownCommand ? 'running' : d.on?.kind && PERSON_WAITS.includes(d.on.kind) ? 'person' : 'waiting';
    case 'job.parked': return 'parked';
    case 'job.unparked': return d.to === 'waiting_answer' ? 'person' : 'queued';
    default: return undefined;
  }
}

/** The time in each stage, from the job's creation (queued) to its end, longest first. */
export function stageTimes(createdAt: string, endAt: string, events: readonly ReviewEvent[]): StageTime[] {
  const ms = new Map<ReviewStage, number>();
  let stage: ReviewStage = 'queued', since = Date.parse(createdAt);
  const end = Date.parse(endAt);
  for (const e of events) {
    const next = stageAfter(e);
    if (next === undefined) continue;
    const at = Math.min(Math.max(Date.parse(e.at), since), end);
    ms.set(stage, (ms.get(stage) ?? 0) + (at - since));
    stage = next; since = at;
  }
  ms.set(stage, (ms.get(stage) ?? 0) + Math.max(0, end - since));
  return [...ms].filter(([, n]) => n > 0).map(([s, n]) => ({ stage: s, ms: n })).sort((a, b) => b.ms - a.ms || REVIEW_STAGES.indexOf(a.stage) - REVIEW_STAGES.indexOf(b.stage));
}

/** Why each restart event stopped the run, as it said. */
function causeOf(e: ReviewEvent): string | undefined {
  const d = (e.data ?? {}) as { reason?: string; why?: string; command?: string; machine?: string };
  if (e.type === 'job.parked') return d.why ?? d.reason;
  if (e.type === 'job.link_lost') return d.machine ? `the link to ${d.machine} was lost` : undefined;
  if (e.type === 'job.oom_killed' || e.type === 'job.heap_retry') return d.command;
  return d.reason;
}

/** The restarts of the run: each kind with how often and its first causes. A park a preemption made counts as the preemption. */
export function restartsOf(events: readonly ReviewEvent[]): Restart[] {
  const by = new Map<RestartKind, Restart>();
  let preempted = false;
  for (const e of events) {
    const kind = e.type.slice('job.'.length) as RestartKind;
    if (!e.type.startsWith('job.') || !RESTART_KINDS.includes(kind)) continue;
    if (kind === 'parked' && preempted) { preempted = false; continue; }
    preempted = kind === 'preempted';
    // A park a person made is no restart of the hopper's: only an auto park counts.
    if (kind === 'parked' && (e.data as { auto?: boolean } | undefined)?.auto !== true) continue;
    const r = by.get(kind) ?? { kind, count: 0, causes: [] };
    r.count++;
    const cause = causeOf(e);
    if (cause && !r.causes.includes(cause) && r.causes.length < MAX_CAUSES) r.causes.push(cause);
    by.set(kind, r);
  }
  return RESTART_KINDS.flatMap((k) => (by.has(k) ? [by.get(k)!] : []));
}

const STAGE_WORDS: Record<Exclude<ReviewStage, 'running'>, string> = {
  queued: 'Waited for a lane', person: 'Waited on a person', waiting: 'Waited on its own waits', parked: 'Was parked',
};

/** The changes that would have helped, from its stalls, restarts and waste signals. */
function suggestionsOf(stages: readonly StageTime[], durationMs: number, restarts: readonly Restart[], waste: readonly TokenWaste[], questions: number): Suggestion[] {
  const out: Suggestion[] = [];
  const time = (s: ReviewStage) => stages.find((t) => t.stage === s)?.ms ?? 0;
  const count = (k: RestartKind) => restarts.find((r) => r.kind === k)?.count ?? 0;
  const stalled = (s: ReviewStage) => time(s) >= STALL_MS && time(s) >= durationMs * STALL_SHARE;
  if (stalled('queued')) out.push({ area: 'lane', text: `It waited ${durationText(time('queued'))} for a lane: add a lane or a machine, or give its jobs a higher priority.` });
  if (count('preempted') >= 2) out.push({ area: 'routing', text: `Jobs of higher priority took its lane ${count('preempted')} times: give it a higher priority, or a lane of its own.` });
  if (questions >= 3) out.push({ area: 'prompt', text: `It asked ${questions} questions: write their answers in the issue or the job rules, so the next job does not ask them.` });
  if (stalled('person') && questions < 3) out.push({ area: 'config', text: `It waited ${durationText(time('person'))} on a person: approve such asks ahead (a template, a read policy, a grant), or answer them sooner.` });
  for (const w of waste) {
    if (w.kind === 'failing_tests') out.push({ area: 'template', text: 'Its test runs failed again and again: give its machine or template the services the tests need, or write in the job rules how to run them.' });
    if (w.kind === 'no_progress') out.push({ area: 'prompt', text: 'It took many turns with no commit and no push: split the issue into smaller parts, each with a clear test of done.' });
    if (w.kind === 'cache_churn') out.push({ area: 'prompt', text: 'Its agent wrote the cache again and again: keep its sessions shorter, for example by smaller parts.' });
  }
  if (count('link_lost') > 0 || waste.some((w) => w.kind === 'resume_loop')) out.push({ area: 'config', text: 'It lost its machine or started again many times: look at the link and the health of the machines it ran on.' });
  if (count('oom_killed') + count('heap_retry') > 0) out.push({ area: 'config', text: 'It ran out of memory: raise its machine\'s job memory limit, or run its heavy steps through the heavy-step gate.' });
  return out;
}

/** Whether `job` is reviewed under `s`: its end, a work item with more than one job, and not trivial. */
export function shouldReview(s: CompletionReviewSettings, job: { status: string; attempts: number; startedAt?: string; finishedAt?: string }, jobs: number): boolean {
  if (!s.on || !isReviewOutcome(job.status)) return false;
  const multi = s.multiJob && jobs > 1;
  if (!multi && !s.outcomes.includes(job.status)) return false;
  const ranMs = job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : 0;
  return multi || job.attempts > 1 || ranMs >= s.minRunMinutes * MINUTE;
}

/** The completion review of an ended job. */
export function completionReviewOf(i: CompletionReviewInput): CompletionReview {
  const outcome: ReviewOutcome = isReviewOutcome(i.job.status) ? i.job.status : 'cancelled';
  const end = i.job.finishedAt ?? i.job.updatedAt;
  const durationMs = Math.max(0, Date.parse(end) - Date.parse(i.job.createdAt));
  const stages = stageTimes(i.job.createdAt, end, i.events);
  const restarts = restartsOf(i.events);
  const questions = i.events.filter((e) => e.type === 'question.asked').length;
  const pushes = i.events.filter((e) => (e.type === 'github_proxy.done' || e.type === 'gitlab_proxy.done') && (e.data as { op?: unknown } | undefined)?.op === 'git.push').length;
  const waste = i.tokens && i.tokens.turns > 0 ? tokenWaste(i.tokens, { pushes, commits: i.job.commits ?? 0, attempts: i.job.attempts }) : [];
  const running = stages.find((s) => s.stage === 'running')?.ms ?? 0;
  const went: string[] = [];
  if (outcome === 'finished') went.push(i.job.partlyDone ? 'It finished part of the work.' : 'It finished the work.');
  if (i.events.some((e) => e.type === 'job.pull_request_merged')) went.push('Its pull request merged.');
  if (restarts.length === 0 && i.job.attempts <= 1) went.push('It ran in one go, with no restart.');
  if (durationMs > 0 && running >= durationMs * 0.8) went.push(`It ran ${durationText(running)} of its ${durationText(durationMs)}: little time went to waits.`);
  if (i.tokens && i.tokens.turns > 0 && waste.length === 0) went.push('Its token use shows no waste signal.');
  const stalls = stages.filter((s) => s.stage !== 'running' && s.ms >= STALL_MS && s.ms >= durationMs * STALL_SHARE)
    .map((s) => `${STAGE_WORDS[s.stage as Exclude<ReviewStage, 'running'>]} ${durationText(s.ms)}${s.stage === 'person' && questions > 0 ? ` (${questions} question${questions === 1 ? '' : 's'})` : ''}.`);
  for (const r of restarts) stalls.push(`${restartWords(r)}${r.causes.length ? `: ${r.causes.join('; ')}` : ''}.`);
  if (i.jobs > 1) stalls.push(`Its work item took ${i.jobs} jobs.`);
  return {
    jobId: i.job.id, outcome, reviewedAt: i.at, durationMs, stages, jobs: i.jobs, questions, went, stalls, restarts, waste,
    suggestions: suggestionsOf(stages, durationMs, restarts, waste, questions),
  };
}

const RESTART_WORDS: Record<RestartKind, string> = {
  requeued: 'Queued again', preempted: 'Preempted', parked: 'Parked by the hopper', link_lost: 'Lost the link to its machine',
  oom_killed: 'A process was killed for memory', heap_retry: 'Ran again with a larger heap',
};

export const restartWords = (r: Restart): string => `${RESTART_WORDS[r.kind]} ${r.count === 1 ? 'once' : `${r.count} times`}`;

/** The kept reviews (table `completion_reviews`): one per job. */
export interface CompletionReviewRepository {
  keep(review: CompletionReview): void;
  get(jobId: string): CompletionReview | undefined;
  /** Of `jobIds`, those with a kept review. */
  reviewed(jobIds: readonly string[]): Set<string>;
}
