// The pane a herdr-claude job leaves on a machine it moved off (issue #1569, design.md "The lost-machine move"): what of its
// executor state names that pane, and its end once that machine answers. Split from executor.ts for its line budget.
import type { Executor } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import { HerdrError, type HerdrClient } from './client.ts';
import { ownPane } from './pane-ends.ts';
import { heldOf, paneStateOf, samePane, type HeldPane, type Scratch, type Where } from './panes.ts';

/** A job that holds its pane: at work, or waiting on its pane. */
const AT_WORK: readonly Job['status'][] = ['claimed', 'running', 'waiting_answer', 'waiting_on'];

export function paneLeft(herdrOn: (w: Where) => HerdrClient, exitAndClose: (pane: HeldPane, scratch: Scratch) => Promise<string | undefined>): Required<Pick<Executor, 'leftOf' | 'endLeft'>> {
  return {
    // The pane's place and agent, no more: never the text a turn sent.
    leftOf(job) {
      const s = paneStateOf(job);
      return s ? { ...heldOf(s, job.id) } : undefined;
    },
    // Claude exits, its scope stops, the pane closes; the work tree stays. Back on that machine, the job's scope is its new
    // run's: only the old pane closes. Still the pane of the job at work (its move not recorded yet): tried again later.
    async endLeft(job, left) {
      const old = paneStateOf({ ...job, executorState: left });
      if (!old) return;
      const now = !job.parked && !job.waitReleased && AT_WORK.includes(job.status) ? paneStateOf(job) : undefined;
      if (now && samePane({ ...now, paneId: old.paneId }, old)) {
        if (now.paneId === old.paneId) throw new Error(`pane ${old.paneId} is still the one job ${job.id} works in`);
        // Only while it is the job's own (issue #2676): its id may name another job's pane by now.
        const herdr = herdrOn(old);
        if (!(await ownPane(herdr, heldOf(old, job.id)))) return;
        await herdr.closePane(old.paneId).catch((e: unknown) => { if (!(e instanceof HerdrError && e.code === 'pane_not_found')) throw e; });
        return;
      }
      const open = await exitAndClose(heldOf(old, job.id), 'none');
      if (open) throw new Error(`pane ${old.paneId} may still be open: ${open}`);
    },
  };
}
