// The budget pause (issue #2302, part 3, design.md "The token ledger"): after a checkpoint keeps a running job's token use,
// a job whose spend reached its budget — the user's token budget, or its model route's (issue #2848) — is parked as the Park button parks it — its lane freed, its pane and
// agent ended, its work tree and agent session kept —, marked `budgetPaused` with why, so Needs you lists it. Not killed:
// a person's pick up lets it go on, and its budget then counts from what it had spent (`budgetFrom`, set by the unpark).
// Issue #2848 part 3: a cheap job whose waste signals say it stalled is paused the same way, `stalled`; a job near its
// budget is checkpointed each minute; a print-mode job gets what is left of its cost budget as its CLI's own cap.
import { budgetNear, budgetReached, dayBudgetHold, dayBudgetOn, daySpendOf, spendOf, tokenBudgetOf, type JobBudgetPaused, type TokenSpend, type TokenBudgetSettings } from '../domain/token-budget.ts';
import { sumTokenUse, type TokenTotals } from '../domain/token-usage.ts';
import { cheapStallOf, escalateOnPickUp, jobBudgetOf, modelRoutingOf } from '../domain/model-routing.ts';
import { tokenWaste } from '../domain/token-waste.ts';
import { PROXY_PUSH_EVENTS, PUSHES_READ } from '../domain/kept-work.ts';
import type { UserStore } from '../domain/ports.ts';
import type { Job, JobId } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';

/** What the job has spent in all, as its token ledger holds it. */
export const jobSpend = (store: Pick<UserStore, 'tokenLedger'>, jobId: string): TokenSpend => spendOf(sumTokenUse(store.tokenLedger.list({ jobId })));

/** The caps that hold for a job: a person's job budget, else its model route's (issue #2848), over the user's job caps. */
const capsOf = (store: Pick<UserStore, 'settings'>, job: Job): TokenBudgetSettings => jobBudgetOf(job.spec.modelRoute, tokenBudgetOf(store.settings.getTokenBudget()), job.jobBudget);

/** A cheap job's stall (issue #2848 part 3): why its waste signals pause it, or undefined. Reads its pushes only for a cheap job. */
function stallOf(store: UserStore, job: Job, totals: TokenTotals): string | undefined {
  const routing = modelRoutingOf(store.settings.getModelRouting());
  if (!routing.on || !routing.escalate) return undefined;
  const pushes = store.events.recent(PUSHES_READ, [...PROXY_PUSH_EVENTS], job.id).filter((e) => (e.data as { op?: unknown }).op === 'git.push').length;
  return cheapStallOf(routing, job.spec.modelRoute, tokenWaste(totals, { pushes, commits: job.checkpoint?.commits.length ?? 0, attempts: job.attempts }));
}

/**
 * The pause a running job's spend calls for, or undefined: not running, not paused already, under its budget and not a
 * stalled cheap job. `near`: under its budget, but at BUDGET_NEAR of a cap.
 */
export function budgetPauseOf(c: Pick<EngineContext, 'store' | 'clock'>, jobId: string): JobBudgetPaused | { near: boolean } | undefined {
  const { store } = c;
  const job = store.jobs.get(jobId);
  if (job?.status !== 'running' || job.budgetPaused) return undefined;
  const budget = capsOf(store, job);
  const routed = job.spec.modelRoute?.choice === 'cheap';
  if (budget.jobTokens <= 0 && budget.jobCostUsd <= 0 && !routed) return undefined;
  const totals = sumTokenUse(store.tokenLedger.list({ jobId }));
  const spend = spendOf(totals);
  const why = budgetReached(spend, job.budgetFrom, budget);
  if (why) return { at: nowIso(c), ...spend, why };
  const stalled = routed ? stallOf(store, job, totals) : undefined;
  return stalled ? { at: nowIso(c), ...spend, why: stalled, stalled: true } : { near: budgetNear(spend, job.budgetFrom, budget) };
}

/**
 * Pause the job when its spend reached its budget, or a cheap job stalled: marked, then parked by its run (here, or relayed
 * to the hopper that runs it), which records the park with the mark's why. The mark goes again when no run takes the park.
 * Whether the job is near its budget, so its next checkpoint comes sooner. Never throws.
 */
export function pauseForBudget(c: Pick<EngineContext, 'store' | 'clock'>, jobId: string, park: (jobId: string) => boolean): boolean {
  try {
    let near = false;
    const marked = c.store.tx(() => {
      const paused = budgetPauseOf(c, jobId);
      if (paused && 'near' in paused) near = paused.near;
      return paused && !('near' in paused) ? c.store.jobs.update(jobId, { budgetPaused: paused }) : undefined;
    });
    if (!marked || park(jobId)) return near;
    c.store.tx(() => { if (c.store.jobs.get(jobId)?.status === 'running') c.store.jobs.update(jobId, { budgetPaused: undefined }); });
    console.warn(`hopper: job ${jobId} reached its token budget, but no run here or elsewhere took the park; the next checkpoint tries again`);
    return true;
  } catch (e) {
    console.warn(`hopper: the token budget of job ${jobId} could not be checked: ${(e as Error).message}`);
    return false;
  }
}

/**
 * What is left of a job's cost budget (issue #2848 part 3), for a print-mode turn's own cap: undefined with no cost cap, 0
 * when it is spent. A token cap has no such cap in the CLI.
 */
export function budgetLeftUsd(c: Pick<EngineContext, 'store'>, jobId: string): number | undefined {
  const job = c.store.jobs.get(jobId);
  if (!job) return undefined;
  const { jobCostUsd } = capsOf(c.store, job);
  if (jobCostUsd <= 0) return undefined;
  return Math.max(0, jobCostUsd - (jobSpend(c.store, jobId).costUsd - (job.budgetFrom?.costUsd ?? 0)));
}

/**
 * A cheap job a person picks up after its budget paused it (issue #2848, part 2): a stalled cheap run goes on on the strong
 * model, not on the cheap one again — its route, its model, and so the `--model` its resumed agent gets, and
 * `job.model_escalated` with the job itself as `after`. The item's later jobs stay on the strong model. In the pick up's
 * transaction.
 */
export function escalateStalled(c: Pick<EngineContext, 'store'>, job: Job): void {
  const { store } = c;
  const to = escalateOnPickUp(modelRoutingOf(store.settings.getModelRouting()), job.spec.modelRoute, job.id, job.source?.repo, job.budgetPaused?.stalled === true);
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
