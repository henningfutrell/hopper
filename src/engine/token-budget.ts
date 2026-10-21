// The budget pause (issue #2302, part 3, design.md "The token ledger"): after a checkpoint keeps a running job's token use,
// a job whose spend reached the user's token budget is parked as the Park button parks it — its lane freed, its pane and
// agent ended, its work tree and agent session kept —, marked `budgetPaused` with why, so Needs you lists it. Not killed:
// a person's pick up lets it go on, and its budget then counts from what it had spent (`budgetFrom`, set by the unpark).
import { budgetReached, spendOf, tokenBudgetOf, type JobBudgetPaused, type TokenSpend } from '../domain/token-budget.ts';
import { sumTokenUse } from '../domain/token-usage.ts';
import type { UserStore } from '../domain/ports.ts';
import { nowIso, type EngineContext } from './context.ts';

/** What the job has spent in all, as its token ledger holds it. */
export const jobSpend = (store: Pick<UserStore, 'tokenLedger'>, jobId: string): TokenSpend => spendOf(sumTokenUse(store.tokenLedger.list({ jobId })));

/** The pause a running job's spend calls for, or undefined: not running, not paused already, or under its budget. */
export function budgetPauseOf(c: Pick<EngineContext, 'store' | 'clock'>, jobId: string): JobBudgetPaused | undefined {
  const { store } = c;
  const job = store.jobs.get(jobId);
  if (job?.status !== 'running' || job.budgetPaused) return undefined;
  const budget = tokenBudgetOf(store.settings.getTokenBudget());
  if (budget.jobTokens <= 0 && budget.jobCostUsd <= 0) return undefined;
  const spend = jobSpend(store, jobId);
  const why = budgetReached(spend, job.budgetFrom, budget);
  return why ? { at: nowIso(c), ...spend, why } : undefined;
}

/**
 * Pause the job when its spend reached its budget: marked, then parked by its run (here, or relayed to the hopper that
 * runs it), which records the park with the mark's why. The mark goes again when no run takes the park. Never throws.
 */
export function pauseForBudget(c: Pick<EngineContext, 'store' | 'clock'>, jobId: string, park: (jobId: string) => boolean): void {
  try {
    const marked = c.store.tx(() => {
      const paused = budgetPauseOf(c, jobId);
      return paused ? c.store.jobs.update(jobId, { budgetPaused: paused }) : undefined;
    });
    if (!marked || park(jobId)) return;
    c.store.tx(() => { if (c.store.jobs.get(jobId)?.status === 'running') c.store.jobs.update(jobId, { budgetPaused: undefined }); });
    console.warn(`hopper: job ${jobId} reached its token budget, but no run here or elsewhere took the park; the next checkpoint tries again`);
  } catch (e) {
    console.warn(`hopper: the token budget of job ${jobId} could not be checked: ${(e as Error).message}`);
  }
}
