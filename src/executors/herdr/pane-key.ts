// The pane key (issue #1569, design.md "The pane key"): a job's tab is found again by its label after a create whose answer
// was lost, so a retry makes no second tab. Apart from start.ts for its size.
import type { ExecutionContext } from '../../domain/ports.ts';
import type { HerdrTab } from './client.ts';
import type { StartDeps } from './start.ts';

/**
 * The pane key (issue #1569): the job, its attempt (each claim) and the pane of the run, in the tab's label. A create of the
 * tab whose answer was lost is tried again, and the tab it made is found by that key, so no second tab is made.
 */
export const paneKeyOf = (ctx: ExecutionContext, pane: number): string => `${ctx.job.id.slice(0, 8)} · ${ctx.job.attempts}.${pane}`;

/** Whether a tab's label, `<lane> · <pane key>`, names the job (issue #2676): the pane key's first part is its id's start. */
export const labelNamesJob = (label: string, jobId: string): boolean => label.split(' · ')[1] === jobId.slice(0, 8);

/** The panes each run opened, for the pane key: a start tried again, or a pane herdr restored, opens the next. */
const panesOpened = new WeakMap<ExecutionContext, number>();

/** The pane key of the next pane this run opens. */
export function nextPaneKey(ctx: ExecutionContext): string {
  const pane = (panesOpened.get(ctx) ?? 0) + 1;
  panesOpened.set(ctx, pane);
  return paneKeyOf(ctx, pane);
}

/** Tries of one tab's create (issue #1569), and the pause before each next one. */
const TAB_TRIES = 3;
const TAB_RETRY_MS = 2000;

/**
 * The tab of the job's pane (issue #1569): created, or, after a create that failed, found by its pane key when the
 * create made it all the same (its answer was lost). Each next try looks for it first. Rejects as the last create did.
 */
export async function createKeyedTab(d: Pick<StartDeps, 'herdr' | 'sleep'>, ctx: ExecutionContext, o: { workspaceId: string; cwd: string; label: string; env: Record<string, string> }): Promise<HerdrTab> {
  let last: unknown;
  for (let i = 0; i < TAB_TRIES; i++) {
    if (i > 0) {
      await d.sleep(TAB_RETRY_MS, ctx.signal);
      if (ctx.signal.aborted) break;
      // A pane an agent runs in is no pane a create just made: never taken.
      const found = await d.herdr.findTab({ workspaceId: o.workspaceId, label: o.label }).catch(() => null);
      if (found && !found.agent) {
        ctx.progress(`found the job's pane by its key after herdr's answer to its create was lost: ${(last as Error).message}`);
        return { tabId: found.tabId, paneId: found.paneId, ...(found.terminalId ? { terminalId: found.terminalId } : {}) };
      }
    }
    try {
      return await d.herdr.createTab(o);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
