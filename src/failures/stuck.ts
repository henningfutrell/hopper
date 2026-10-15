// A stuck cause's bulk action (issue #1010, design.md "Stuck work"): one press runs the cause's action on each of its
// items, read from the Failures view at the press, through the same path as the item's own button — a hand-off's
// resolution, a failure's Run again, Push it, Tend again —, each with who pressed it. An item refused meanwhile is
// skipped and said with why; the others go on. It answers at once (issue #1194): each give-back is checked now and runs
// after the answer, as its own button's does; Won't do is the hopper's alone, and is resolved now.
import type { GiveBackAct, GiveBackAnswer } from '../domain/give-back.ts';
import type { ActingPerson, FailuresView, HandoffView, Job, StuckActResult, StuckBulkCause } from '../domain/types.ts';
import type { HandoffResolve } from './handoffs.ts';
import type { FailureAction } from './failures.ts';

/** What a bulk action acts through. */
export interface StuckActs {
  view(): FailuresView;
  /** Won't do: the hand-off resolved now. */
  resolveHandoff(id: string, input: HandoffResolve, by: ActingPerson): Promise<FailureAction<{ handoff: HandoffView; job?: Job }>>;
  /** The item's own button's give-back, checked now and answered; its give-back runs after (issue #1194). */
  giveBack(act: GiveBackAct, id: string, by: ActingPerson): GiveBackAnswer;
}

type One = { ok: true } | { ok: false; message: string };

/** The give-back of each cause that gives its items back. */
const GIVE_BACK: Record<Exclude<StuckBulkCause, 'wont_do'>, GiveBackAct> = { continue: 'continue', run_again: 'fixed', retry: 'retry', push: 'push', tend: 'tend' };

function oneOf(d: StuckActs, cause: StuckBulkCause, view: FailuresView, by: ActingPerson): (id: string) => Promise<One> {
  // Won't do says why: the card's why, as a person reads it.
  if (cause === 'wont_do') {
    return (id) => d.resolveHandoff(id, { action: 'wont_do', note: view.handoffs.find((h) => h.id === id)?.card.why ?? 'Nothing is left to do.' }, by);
  }
  const act = GIVE_BACK[cause];
  return async (id) => d.giveBack(act, id, by);
}

/** Runs the cause's bulk action on each of its items now; answered once each is checked, its give-back running. */
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
