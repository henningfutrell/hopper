// A stuck cause's bulk action (issue #1010, design.md "Stuck work"): one press runs the cause's action on each of its
// items, read from the Failures view at the press, through the same path as the item's own button — a hand-off's
// resolution, a failure's Run again, Push it, Tend again —, each with who pressed it. An item refused meanwhile is
// skipped and said with why; the others go on.
import type { RerunResult } from '../domain/ports.ts';
import type { ActingPerson, FailuresView, HandoffView, Job, StuckActResult, StuckBulkCause } from '../domain/types.ts';
import type { HandoffResolve } from './handoffs.ts';
import type { FailureAction } from './failures.ts';

/** What a bulk action acts through. */
export interface StuckActs {
  view(): FailuresView;
  resolveHandoff(id: string, input: HandoffResolve, by: ActingPerson): Promise<FailureAction<{ handoff: HandoffView; job?: Job }>>;
  retry(recordId: string, by: ActingPerson): Promise<FailureAction<Job>>;
  push(jobId: string, by: ActingPerson): Promise<{ ok: true } | { ok: false; message: string }>;
  tendAgain(jobId: string, by: ActingPerson): Promise<RerunResult>;
}

type One = { ok: true } | { ok: false; message: string };

function oneOf(d: StuckActs, cause: StuckBulkCause, view: FailuresView, by: ActingPerson): (id: string) => Promise<One> {
  const handoff = (id: string) => view.handoffs.find((h) => h.id === id);
  switch (cause) {
    case 'continue': return (id) => d.resolveHandoff(id, { action: 'continue' }, by);
    case 'run_again': return (id) => d.resolveHandoff(id, { action: 'fixed' }, by);
    // Won't do says why: the card's why, as a person reads it.
    case 'wont_do': return (id) => d.resolveHandoff(id, { action: 'wont_do', note: handoff(id)?.card.why ?? 'Nothing is left to do.' }, by);
    case 'retry': return (id) => d.retry(id, by);
    case 'push': return (id) => d.push(id, by);
    case 'tend': return (id) => d.tendAgain(id, by);
  }
}

/** Runs the cause's bulk action on each of its items now, one after another. */
export async function actOnStuck(d: StuckActs, cause: StuckBulkCause, by: ActingPerson): Promise<StuckActResult> {
  const view = d.view();
  const ids = view.stuck.find((c) => c.cause === cause)?.ids ?? [];
  const one = oneOf(d, cause, view, by);
  const result: StuckActResult = { cause, done: [], refused: [] };
  for (const id of ids) {
    const r = await one(id);
    if (r.ok) result.done.push(id);
    else result.refused.push({ id, why: r.message });
  }
  return result;
}
