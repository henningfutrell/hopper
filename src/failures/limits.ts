// An account at its limit (issue #2897, design.md "Limit prompts"): what its problem keeps of the limit, and which open
// problem a new hit folds into. The prompt and the reset time come from the job's failure text. Pure.
import { LIMIT_RECHECK_MS, limitPromptOfFailure, limitResetOf } from '../domain/limit-prompts.ts';
import type { Job, Problem, ProblemLimit, UsageSourceReport } from '../domain/types.ts';
import { machineOf } from './evidence.ts';
import type { UserStore } from '../domain/ports.ts';

/** The limit a failure names, and when the account takes jobs again: the prompt's time, else after a while. */
export function limitOfFailure(job: Job, error: string, now: Date, account: string | undefined): ProblemLimit | undefined {
  const p = limitPromptOfFailure(error);
  if (!p) return undefined;
  const named = limitResetOf(p.prompt, now);
  return {
    ...p, resetsAt: named ?? new Date(now.getTime() + LIMIT_RECHECK_MS[p.family]).toISOString(), resetNamed: named !== undefined,
    ...(job.laneId ? { laneId: job.laneId } : {}), ...(account ? { account } : {}),
  };
}

/** The open problem of this account's limit: its machine and agent. */
export function limitOpenFor(open: readonly Problem[], machineId: string | undefined, executor: string): Problem | undefined {
  return open.find((p) => p.limit && p.scope.machineId === machineId && p.scope.executor === executor);
}

/** The account the machine's usage source reads for this agent (`GET /api/accounts`'s words); undefined: none reads it. */
export function toolAccountOf(sources: readonly UsageSourceReport[], machineId: string, executor: string): string | undefined {
  const a = sources.find((s) => s.account?.detail.machine === machineId && (s.executors === undefined || s.executors.includes(executor)))?.account;
  return a?.identity ? `${a.service}: ${a.identity}` : undefined;
}

/** What the hopper did with each job of the problem: the machine it was rerouted to, or the hold it waits in. */
export function limitDid(store: Pick<UserStore, 'failures' | 'jobs'>, p: Problem): string[] {
  return store.failures.list({ problemId: p.id }).map((r) => {
    const next = r.nextJobId ? store.jobs.get(r.nextJobId) : undefined;
    const to = next && machineOf(next);
    if (next?.holdReason) return `Job ${r.jobId}: held, ${next.holdReason}`;
    if (to) return `Job ${r.jobId}: rerouted to ${to}`;
    return r.outcome === 'held' ? `Job ${r.jobId}: held until the limit resets` : `Job ${r.jobId}: goes on another lane once one is free`;
  });
}
