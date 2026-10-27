// The budget pause (issue #2302, part 3, design.md "The token ledger"): after a checkpoint keeps a running job's token use,
// a job whose spend reached its budget — the user's token budget, or its model route's (issue #2848) — is parked as the Park button parks it — its lane freed, its pane and
// agent ended, its work tree and agent session kept —, marked `budgetPaused` with why, so Needs you lists it. Not killed:
// a person's pick up lets it go on, and its budget then counts from what it had spent (`budgetFrom`, set by the unpark).
import { budgetReached, dayBudgetHold, dayBudgetOn, daySpendOf, spendOf, tokenBudgetOf, type JobBudgetPaused, type TokenSpend } from '../domain/token-budget.ts';
import { sumTokenUse } from '../domain/token-usage.ts';
import { escalateOnPickUp, jobBudgetOf, modelRoutingOf } from '../domain/model-routing.ts';
import type { UserStore } from '../domain/ports.ts';
import type { Job, JobId } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';

/** What the job has spent in all, as its token ledger holds it. */
export const jobSpend = (store: Pick<UserStore, 'tokenLedger'>, jobId: string): TokenSpend => spendOf(sumTokenUse(store.tokenLedger.list({ jobId })));

/** The pause a running job's spend calls for, or undefined: not running, not paused already, or under its budget. */
export function budgetPauseOf(c: Pick<EngineContext, 'store' | 'clock'>, jobId: string): JobBudgetPaused | undefined {
  const { store } = c;
  const job = store.jobs.get(jobId);
  if (job?.status !== 'running' || job.budgetPaused) return undefined;
  // A person's job budget, else its model route's (issue #2848), over the user's job caps.
  const budget = jobBudgetOf(job.spec.modelRoute, tokenBudgetOf(store.settings.getTokenBudget()), job.jobBudget);
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

/**
 * A cheap job a person picks up after its budget paused it (issue #2848, part 2): a stalled cheap run goes on on the strong
 * model, not on the cheap one again — its route, its model, and so the `--model` its resumed agent gets, and
 * `job.model_escalated` with the job itself as `after`. The item's later jobs stay on the strong model. In the pick up's
 * transaction.
 */
export function escalateStalled(c: Pick<EngineContext, 'store'>, job: Job): void {
  const { store } = c;
  const to = escalateOnPickUp(modelRoutingOf(store.settings.getModelRouting()), job.spec.modelRoute, job.id, job.source?.repo);
  if (!to) return;
  const { model: _cheap, ...payload } = job.spec.payload;
  const spec = { ...job.spec, modelRoute: to, payload: to.model ? { ...payload, model: to.model } : payload };
  store.jobs.respecify(job.id, spec);
  if (job.fromConfig) { const { model: _was, ...was } = job.fromConfig; store.jobs.update(job.id, { fromConfig: to.model ? { ...was, model: to.model } : was }); }
  store.events.append({ type: 'job.model_escalated', jobId: job.id, data: { from: 'cheap', to: 'strong', model: to.model, after: job.id, why: to.why } });
}

/**
 * Part 5: the waiting jobs a day budget holds, with why — a Decision's input, so admission holds them as it holds a job for
 * its usage or memory. Reads the ledger only while a day cap is on and a job waits. A job's repository is its item's.
 */
export function budgetHeldOf(c: Pick<EngineContext, 'store' | 'clock'>, waiting: readonly Job[]): { jobId: JobId; reason: string }[] {
  if (waiting.length === 0) return [];
  const budget = tokenBudgetOf(c.store.settings.getTokenBudget());
  if (!dayBudgetOn(budget)) return [];
  const day = nowIso(c).slice(0, 10);
  const entries = c.store.tokenLedger.list({ since: `${day}T00:00:00.000Z` });
  const jobs = c.store.jobs.getMany([...new Set(entries.map((e) => e.jobId))]);
  const spend = daySpendOf(entries, day, (id) => jobs.get(id)?.source?.repo);
  return waiting.flatMap((j) => { const reason = dayBudgetHold(j.source?.repo, spend, budget); return reason ? [{ jobId: j.id, reason }] : []; });
}
