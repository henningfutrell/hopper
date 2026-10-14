// Jev first in the failure assessor (issue #550, design.md "Decider calls"): a failure no known cause explains,
// which the rules hand to a person, is a decider call. Jev picks: run it again, or a person. Grouping stays the
// rules' own, from failures on several items. The pick runs the job again only when the decision point is active,
// Jev is sure enough, and nothing makes it consequential — a goal that deletes, sends, publishes, pays or changes
// permissions, or a machine the blast-radius gate keeps. Otherwise the hand-off to a person stands. A done-check miss
// (issue #637) is the same decision, asked in its own words: its source said not done three times, so whether it is
// done is GitHub's to say, never Jev's — Jev picks only run it again or a person.
import type { RerunBy } from '../domain/ports.ts';
import type { Job, MinorDecisionOption, JevFirst } from '../domain/types.ts';
import { consequentialOf } from '../minor-decisions/guard.ts';

const OPTIONS: MinorDecisionOption[] = [
  { id: 'retry', label: 'Run it again: the failure looks passing — a flake, a timeout, a lost connection, a busy machine' },
  { id: 'person', label: 'Hand it to a person: the failure needs a fix to the work, the repository or the machine, or a judgement' },
];
const INSTRUCTIONS = 'A job run by a coding agent failed, and no known cause explains the error. Pick what to do with it.';
const DONE_CHECK_OPTIONS: MinorDecisionOption[] = [
  { id: 'retry', label: 'Run it again: the work is not on GitHub — no pull request ready for review, the issue open —, and a new run can finish it' },
  { id: 'person', label: 'Hand it to a person: the work needs a judgement, a fix, or it was done some way GitHub cannot show' },
];
const DONE_CHECK_INSTRUCTIONS = 'A job run by a coding agent said it was done, but its GitHub issue, looked at three times, shows the work not done: the issue open, and no pull request that closes or references it ready for review or merged. Pick what to do with it.';
const TEXT_MAX = 2000;

/** A failed job the rules handed to a person with no known cause: what Jev is asked about. */
export interface JevCase { recordId: string; job: Job; error: string; attempt: number; ranMs?: number; machineId?: string; /** A done-check miss (issue #637). */ doneCheck?: boolean }

export interface JevStepDeps {
  first: JevFirst;
  live(): boolean;
  logger: { warn(line: string): void };
  gated(machineId: string): boolean;
  /** Run the record's job again, if it may run again now. */
  rerun(recordId: string, by: RerunBy, note: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

export async function askJev(d: JevStepDeps, c: JevCase): Promise<void> {
  const gatedMachine = c.machineId !== undefined && d.gated(c.machineId) ? c.machineId : undefined;
  const out = await d.first.decide({
    point: 'failure-assessment', jobId: c.job.id, instructions: c.doneCheck ? DONE_CHECK_INSTRUCTIONS : INSTRUCTIONS, options: c.doneCheck ? DONE_CHECK_OPTIONS : OPTIONS,
    state: {
      error: c.error.slice(0, TEXT_MAX), output: (c.job.errorTail ?? '').slice(-TEXT_MAX), goal: c.job.spec.goal ?? '', executor: c.job.spec.executor,
      attempt: c.attempt, ...(c.ranMs !== undefined ? { ranSeconds: Math.round(c.ranMs / 1000) } : {}),
    },
    consequential: consequentialOf([c.job.spec.goal ?? ''], gatedMachine ? { gatedMachine } : {}),
  });
  if (!d.live() || !out.asked || !out.applied || out.pick !== 'retry') return;
  const done = await d.rerun(c.recordId, 'assessor', 'run again: Jev picked it');
  if (!done.ok) d.logger.warn(`hopper: Jev's run again of job ${c.job.id} was refused: ${done.message}`);
}
