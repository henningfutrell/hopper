// The give-backs the failures service runs (issue #1194, design.md "Actions answer at once"): Failures' Retry, a
// hand-off's Continue and I fixed it, Push it on work not pushed, and Tend again, each checked now from what the act names
// — the failure record, the hand-off, the job — and the person's input, as its own button checks it. The sync loop asks it
// at the answer and again at the send of the act's GitHub outbox row (issue #1238 part 5), after a restart too, so the row
// names the run, never holds it.
import type { GiveBackCheck, GiveBackChecked, GiveBackRun } from '../domain/give-back.ts';
import type { RerunResult } from '../domain/ports.ts';
import type { ActingPerson, ContinuedBy, Job } from '../domain/types.ts';
import type { FailureAction, Failures } from './failures.ts';
import { pushable, pushKeptWork } from './kept-work.ts';
import type { TakesBack } from './view.ts';

export interface GiveBackChecksContext {
  failures: Pick<Failures, 'retryable' | 'retry' | 'handoffResolvable' | 'resolveHandoff'>;
  store: Parameters<typeof pushable>[0]['store'];
  resumable(job: Job): boolean;
  reopens(job: Job): boolean;
  takesBack: TakesBack;
  continueJob(jobId: string, brief: string, by: ContinuedBy): Promise<RerunResult>;
  /** Tend again, the sync loop's own check. */
  checkTendAgain(jobId: string, acting: ActingPerson): GiveBackChecked;
}

const checkedOf = (a: FailureAction<{ jobId: string }>, run: () => Promise<GiveBackRun>): GiveBackChecked => (a.ok ? { ok: true, jobId: a.value.jobId, run } : a);

export function giveBackChecks(c: GiveBackChecksContext): GiveBackCheck {
  const f = c.failures;
  const push = { store: c.store, resumable: c.resumable, reopens: c.reopens, takesBack: c.takesBack, continueJob: c.continueJob, resolveHandoff: f.resolveHandoff };
  return (act, id, acting, input) => {
    switch (act) {
      case 'continue': case 'fixed':
        return checkedOf(f.handoffResolvable(id, act), () => f.resolveHandoff(id, { action: act, ...input }, acting));
      case 'retry': return checkedOf(f.retryable(id), () => f.retry(id, acting));
      case 'push': {
        const allowed = pushable(push, id);
        return checkedOf(allowed.ok ? { ok: true, value: { jobId: id } } : allowed, () => pushKeptWork(push, id, input.note, acting));
      }
      case 'tend': return c.checkTendAgain(id, acting);
    }
  };
}
