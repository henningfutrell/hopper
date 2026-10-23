// The end of a herdr-claude job's pane (issues #371, #401, #410): Claude gets a moment to exit, the job's machine stops its
// scope and processes and reaps its scratch dir, and the pane closes. Split from executor.ts for its line budget.
import type { ExecutionOutcome, Reaped } from '../../domain/ports.ts';
import type { LaneId } from '../../domain/types.ts';
import { HerdrError, type HerdrClient } from './client.ts';
import type { Interrupt, Sleep } from './monitor.ts';
import { samePane, timeoutLiveness, type HeldPane, type Scratch, type Where } from './panes.ts';
import { labelNamesJob } from './pane-key.ts';
import { jobScratchOf } from './start.ts';

/** How long Claude has to exit by itself before the reap stops it with the job's other processes. */
const EXIT_WAIT_MS = 5000;

export interface PaneEndDeps {
  pollMs: number;
  sleep: Sleep;
  herdrOn: (w: Where) => HerdrClient;
  /** What the reap kept, by job, until cleanup answers it. */
  reaped: Map<string, Reaped>;
  /** The lanes and the panes they hold: a closed pane frees its lane. */
  lanes: Map<LaneId, HeldPane>;
  /** When each running job's pane output last changed (issue #630): at a timeout, its liveness. */
  outputAt: Map<string, number>;
}

/**
 * Whether the pane is still the job's own (issue #2676): its agent runs in it, or its tab's label names the job (the pane
 * key, issue #1569). Not when no pane has its id, or the pane is another job's: a pane id is herdr's, and a herdr that
 * started again gives the next job's pane the id again. Rejects when herdr is not reached.
 */
export async function ownPane(herdr: HerdrClient, pane: HeldPane): Promise<boolean> {
  if ((await herdr.getAgent(pane.agentName))?.paneId === pane.paneId) return true;
  const label = await herdr.tabLabel(pane.paneId);
  return label !== null && labelNamesJob(label, pane.jobId);
}

export function paneEnds(o: PaneEndDeps) {
  const { sleep, herdrOn, reaped, lanes } = o;
  /**
   * The reap (issues #401, #410): Claude gets a moment to exit by itself, then the job's machine — through
   * its own connection, never the pane — stops the job's scope and its processes, Claude among them if it
   * is still up, and removes its scratch dir unless it holds work not pushed — or keeps it (`scratch` false: a
   * parked job's, issue #501). Undefined when the machine could not be reached: the sweep reaps it later.
   */
  async function reap(herdr: HerdrClient, pane: HeldPane, scratch: Scratch = 'remove'): Promise<Reaped | undefined> {
    for (let waited = 0; waited < EXIT_WAIT_MS && await herdr.getAgent(pane.agentName).catch(() => null) !== null; waited += o.pollMs) {
      await sleep(o.pollMs, new AbortController().signal);
    }
    return herdr.reap(pane.jobId, scratch !== 'none' ? jobScratchOf(pane.cwd, pane.jobId) : undefined, scratch === 'keep');
  }

  /**
   * esc, ctrl+c twice, the reap, close. Never rejects: the pane may already be gone. Answers why the
   * pane may still be open — its herdr not reached, or the close refused — or undefined once it is
   * closed or gone (issue #371). `scratch` `none`: the reap does not look at the scratch dir (a parked job's, issue
   * #501); `keep`: it says what is there and keeps it (a timed-out job's, issue #630). A pane that is no longer the job's
   * (issue #2676: its id names another job's pane after its herdr started again) gets no key and stays open; the reap,
   * which acts by the job's id, runs all the same.
   */
  async function exitAndClose(pane: HeldPane, scratch: Scratch = 'remove'): Promise<string | undefined> {
    const close = async (herdr: HerdrClient): Promise<string | undefined> => {
      // Not known whose it is (its herdr not reached): no key and no close, but the reap; it is tried again.
      const own = await ownPane(herdr, pane).catch((e: unknown) => e as Error);
      if (own === true) {
        await herdr.sendKeys(pane.paneId, ['esc']).catch(() => {});
        await herdr.sendKeys(pane.paneId, ['ctrl+c', 'ctrl+c']).catch(() => {});
      }
      const said = await reap(herdr, pane, scratch).catch(() => undefined);
      if (said && scratch !== 'none') reaped.set(pane.jobId, said);
      if (own instanceof Error) return `herdr: ${own.message}`;
      if (!own) return undefined;
      return herdr.closePane(pane.paneId).then(() => undefined, (e: unknown) => (e instanceof HerdrError && e.code === 'pane_not_found' ? undefined : `herdr: ${(e as Error).message}`));
    };
    const open = await Promise.resolve().then(() => close(herdrOn(pane))).catch((e: unknown) => `herdr: ${(e as Error).message}`);
    for (const [lane, held] of lanes) if (samePane(held, pane) && held.jobId === pane.jobId) lanes.delete(lane);
    return open;
  }

  /** The outcome of a run that ended on `result`: an interrupt ends its pane, but a park's, which `park` ends. */
  async function settle(result: ExecutionOutcome | Interrupt, pane: HeldPane): Promise<ExecutionOutcome> {
    if (!('interrupt' in result)) return result;
    if (result.interrupt === 'shutdown') return { kind: 'failed', error: 'shutdown' };
    // The engine parks the job, then asks `park` to end its pane: nothing of it is closed here.
    if (result.interrupt === 'park') return { kind: 'failed', error: 'parked' };
    if (result.interrupt !== 'timeout') { await exitAndClose(pane); return { kind: 'failed', error: 'aborted' }; }
    // A timeout (issue #630): its scratch dir kept, as a park keeps it — it may go on there —, and its liveness said.
    await exitAndClose(pane, 'keep');
    return { kind: 'failed', error: 'timed out', liveness: timeoutLiveness(o.outputAt.get(pane.jobId), reaped.get(pane.jobId)) };
  }

  return { reap, exitAndClose, settle };
}
