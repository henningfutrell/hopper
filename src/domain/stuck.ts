// Stuck work (issue #1010, design.md "Stuck work"): every item that waits on a person — an open hand-off, a failure, work
// not pushed, a pull request the hopper gave up on, a job whose own wait broke, an item left in PR open
// with no pull request to wait on (issue #1231), a job on a wait that names nothing it waits on (issue #1245), a job on a wait whose agent session ended (issue #1779), a job that waits for memory while no job runs (issue #2303) — in exactly one stuck cause, with its count, and one bulk action when the hopper takes it now for each item of the cause, else what a person
// does. A parked job is no stuck work (issue #2414): it waits by design, in Parked only. Nor is a job that only still waits,
// also past its deadline, nor an ended job's cleanup leftover: the cleanup worker owns it, and Machines counts it (issue #2684). The Failures view shows them first; `POST /ui/api/failures/stuck/:cause` runs a cause's bulk action. Pure.
// Re-exported from types.ts.
import type { Allowed, FailureRecordView, HandoffResolutionAction, HandoffView } from './failures.ts';
import type { KeptWorkView } from './kept-work.ts';
import type { PullRequestCard } from './pull-request-list.ts';
import type { Job } from './types.ts';
import { MEMORY_WAIT } from './memory-floor.ts';
import { waitsOnNothing } from './wait-on.ts';

/** The causes, bulk ones first, in the order the view shows them. */
export const STUCK_CAUSES = [
  'continue', 'run_again', 'wont_do', 'retry', 'push', 'tend', 'wait_unnamed', 'stranded',
  'memory_starved', 'done_by_hand', 'taken_soon', 'kept_work', 'checks', 'tend_refused', 'own_wait', 'pr_open_stale',
] as const;
export type StuckCauseId = typeof STUCK_CAUSES[number];

/** The causes with a bulk action. */
export const STUCK_BULK = ['continue', 'run_again', 'wont_do', 'retry', 'push', 'tend', 'wait_unnamed', 'stranded'] as const satisfies readonly StuckCauseId[];
export type StuckBulkCause = typeof STUCK_BULK[number];

/**
 * One stuck cause: `ids` its items — a hand-off's id (continue, run_again, wont_do, done_by_hand, taken_soon), a failure
 * record's (retry), else a job's —, `what` they are, `act` the bulk action's button, or `todo` what a person does.
 */
export interface StuckCause { cause: StuckCauseId; ids: string[]; what: string; act?: string; todo?: string }

/** What a bulk action did: the items it moved, and those refused with why. */
export interface StuckActResult { cause: StuckBulkCause; done: string[]; refused: { id: string; why: string }[] }

export interface StuckInputs {
  handoffs: HandoffView[];
  recent: FailureRecordView[];
  keptWork: KeptWorkView[];
  pullRequests: PullRequestCard[];
  /** Jobs on their own wait, and the waiting and running jobs (issue #2303: a job that waits for memory while none runs). */
  jobs: Job[];
  /** The jobs of the items blocked with no pull request to wait on, or with it closed without a merge (issues #1231, #1891, `blockedStuck`). */
  prOpen: string[];
}

const TEXT: Record<StuckCauseId, { what: string; act?: string; todo?: string }> = {
  continue: { what: 'Failed jobs that can go on in their work', act: 'Continue all' },
  run_again: { what: 'Failed jobs that can start again', act: 'Run again all' },
  wont_do: { what: 'Failed jobs with nothing left to do', act: 'Won\'t do all' },
  retry: { what: 'Failures that can run again', act: 'Run again all' },
  push: { what: 'Jobs with work not pushed that can push it', act: 'Push it all' },
  tend: { what: 'Pull requests the hopper stopped tending', act: 'Tend again all' },
  wait_unnamed: { what: 'Jobs waiting on nothing recorded', act: 'Resume all' },
  stranded: { what: 'Jobs on a wait whose agent session ended', act: 'Wake all' },
  memory_starved: { what: 'Jobs that wait for memory while no job runs', todo: 'Free memory on the machine: stop what else runs there. Or lower its memory floor or the memory for a job (its machine source\'s memoryFloorGiB and memoryPerJobGiB options). Its wait reason says what the machine has.' },
  done_by_hand: { what: 'Failed jobs with a ready PR or work done by hand', todo: 'Review and merge the PR, or do the work. Then press Done on its card in Needs a person.' },
  taken_soon: { what: 'Failed jobs the hopper runs again soon', todo: 'Nothing to do now. Look again in a minute.' },
  kept_work: { what: 'Jobs with work not pushed that cannot go on', todo: 'Press Discard in Work not pushed, or run its item again. Do not push on its machine: it holds no GitHub credentials.' },
  checks: { what: 'Pull requests whose checks still fail', todo: 'Look at the failing checks on GitHub. Fix them, or close the PR.' },
  tend_refused: { what: 'Pull requests the hopper cannot tend', todo: 'Read why on its card in Pull requests, and remove the block.' },
  own_wait: { what: 'Jobs whose own wait broke, past its deadline', todo: 'Read its last check on the job. Then end its wait or cancel it.' },
  pr_open_stale: { what: 'Items blocked with no pull request to wait on, with their pull request closed without a merge, or past their deadline with no move', todo: 'Look at its issue and its pull request on GitHub. Then, on its row in Intake, press Run again when work is left, else press Won\'t do.' },
};

/** An open hand-off's cause: its card's recommended resolution, or taken soon when that is refused for a short time. */
const HANDOFF_CAUSE: Record<HandoffResolutionAction, StuckCauseId> = { continue: 'continue', fixed: 'run_again', wont_do: 'wont_do', done_by_hand: 'done_by_hand' };
const ACTION_KEY = { continue: 'continue', fixed: 'fixed', done_by_hand: 'doneByHand', wont_do: 'wontDo' } as const;

function handoffCause(h: HandoffView): StuckCauseId {
  const allowed: Allowed = h.actions[ACTION_KEY[h.card.recommended]];
  return allowed.ok ? HANDOFF_CAUSE[h.card.recommended] : 'taken_soon';
}

function prCause(c: PullRequestCard): StuckCauseId | undefined {
  if (c.state !== 'open') return undefined;
  if (c.gaveUp) return c.waits === 'tend failed' ? 'tend' : 'checks';
  return c.queue && 'refused' in c.queue ? 'tend_refused' : undefined;
}

/**
 * Whether a job's own wait broke (issue #2684): its command flagged stuck, or past its deadline with a check that cannot
 * test its condition, or met before and not woken again. A wait past its deadline that its check still tests only waits.
 */
function waitBroke(j: Job): boolean {
  const check = j.wait?.check;
  return Boolean(j.wait?.stuckAt) || (check?.overdueAt !== undefined && (check.brokenAt !== undefined || check.repeat === true));
}

/** Every stuck item in one cause; the causes with an item, in `STUCK_CAUSES` order. */
export function stuckOf(i: StuckInputs): StuckCause[] {
  const by = new Map<StuckCauseId, string[]>();
  const add = (cause: StuckCauseId, id: string) => (by.get(cause) ?? by.set(cause, []).get(cause)!).push(id);
  // Work not pushed that Push it takes goes on through its hand-off: counted here, not with the hand-off.
  const pushed = new Set<string>();
  for (const k of i.keptWork) {
    add(k.actions.push.ok ? 'push' : 'kept_work', k.jobId);
    if (k.actions.push.ok && k.handoffId) pushed.add(k.handoffId);
  }
  const open = i.handoffs.filter((h) => h.status === 'open');
  for (const h of open) if (!pushed.has(h.id)) add(handoffCause(h), h.id);
  const counted = new Set(open.flatMap((h) => [h.id, ...(h.recordId ? [h.recordId] : [])]));
  for (const r of i.recent) if (r.actions.retry.ok && !counted.has(r.id) && !(r.handoffId && counted.has(r.handoffId))) add('retry', r.id);
  for (const c of i.pullRequests) {
    const cause = prCause(c);
    if (cause) add(cause, c.jobId);
  }
  const running = i.jobs.some((j) => j.status === 'claimed' || j.status === 'running');
  for (const j of i.jobs) {
    if (j.status === 'queued' && !running && j.waitReason?.startsWith(MEMORY_WAIT)) add('memory_starved', j.id);
    else if (waitsOnNothing(j)) add('wait_unnamed', j.id);
    else if (j.status === 'waiting_on' && j.wait?.strandedAt) add('stranded', j.id);
    else if (j.status === 'waiting_on' && waitBroke(j)) add('own_wait', j.id);
  }
  for (const id of i.prOpen) add('pr_open_stale', id);
  return STUCK_CAUSES.filter((c) => by.has(c)).map((cause) => ({ cause, ids: by.get(cause)!, ...TEXT[cause] }));
}
