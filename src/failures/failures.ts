// The failure assessor's interface (issue #509, design.md "Failure assessment"): what the user's runtime, the routes and
// the operator CLI ask of it. Its making is `service.ts`.
import type { ActingPerson, FailureSettings, FailuresView, HandoffView, Job, KnownCause, NamedCause, Problem, ProblemBlock } from '../domain/types.ts';
import type { BackfillResult } from './backfill.ts';
import type { HandoffResolve } from './handoffs.ts';

export type FailureAction<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'conflict'; message: string };

export interface Failures {
  /** Assess what a restart left unassessed, follow `job.failed`, start the sweep. Once. */
  start(): void;
  stop(): Promise<void>;
  /** The due runs again, the checks, the prune — now (tests, and after an action). */
  sweep(): Promise<void>;
  /** The failed jobs nothing waits on any more, dismissed now (issue #1123): the ids. The sweep and the start do it too. */
  dismissStale(): string[];
  /** The done-check backfill (issue #637): asked, one pass; `once`, at start, unless it completed before on this store. */
  backfill: { run(): Promise<BackfillResult>; once(): Promise<void> };
  view(): FailuresView;
  /** The open problems the decider reads; none while automatic hold is off. */
  blocks(): ProblemBlock[];
  settings(): FailureSettings;
  setSettings(patch: Partial<FailureSettings>): FailureSettings;
  /** A person resolves a problem, with a note if any: its held jobs run again, new jobs are no longer held for it. */
  resolve(problemId: string, by: ActingPerson, note?: string): FailureAction<Problem>;
  /** A person releases a problem's held jobs now: they run again through the normal queue, unless done at their source (issue #637). */
  release(problemId: string, by: ActingPerson): FailureAction<Problem>;
  /** A person runs a surfaced failure's job again; one done at its source is finished instead, and refused (issue #637). */
  retry(recordId: string, by: ActingPerson): Promise<FailureAction<Job>>;
  /** A person resolves a hand-off (issue #551), `by` the person signed in and the way: the hand-off and the job that follows, if any. */
  resolveHandoff(handoffId: string, input: HandoffResolve, by: ActingPerson): Promise<FailureAction<{ handoff: HandoffView; job?: Job }>>;
  nameCause(cause: NamedCause): KnownCause;
  forgetCause(signature: string): boolean;
}
