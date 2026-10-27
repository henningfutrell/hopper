// The token ledger's reads (issue #2302, design.md "The token ledger"): GET /api/jobs/:id/tokens, one job's token use
// and estimated cost, and GET /api/usage/tokens, the request's user's ledger summed by job, issue, repository, machine,
// lane, account, model or day, with the top spenders; with their waste signals and tokens per merged pull request (part 4).
// Counts and metadata only: no text of a session. Read only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DomainEvent } from '../domain/types.ts';
import { jobTokenView, sumTokenUse, TOKEN_GROUPS, tokenRollup, type JobTokenFacts, type JobTokenView, type TokenRollupRow, type TokenTotals } from '../domain/token-usage.ts';
import { perMergedPullRequest, tokenWaste, type PerMergedPullRequest, type TokenWaste, type TokenWasteLine } from '../domain/token-waste.ts';
import type { UserStore } from '../domain/ports.ts';
import { HttpError, parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';
import { TOKEN_BUDGET_OPERATIONS } from './ui/token-budget.ts'; import { MODEL_ROUTING_OPERATIONS } from './ui/model-routing.ts';

/** How many jobs the top spenders list. */
const TOP = 10;
/** How many flagged jobs the waste list holds. */
const WASTE_TOP = 20;
/** The events that hold a job's pushes through the hopper. */
const PROXY_DONE = ['github_proxy.done', 'gitlab_proxy.done'] as const;
const isPush = (e: DomainEvent): boolean => (e.data as { op?: unknown }).op === 'git.push';

export const tokenLedgerQuery = z.object({
  by: z.enum(TOKEN_GROUPS).default('repo'),
  split: z.enum(TOKEN_GROUPS).optional(),
  job: z.string().min(1).optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  since: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
});

export const TOKEN_LEDGER_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/jobs/:id/tokens', tag: 'Jobs', summary: 'A job\'s token use and estimated cost', description: 'What the job\'s agent spent (issue #2302, the token ledger), read from its agent session\'s log — the usage block of each assistant message — at each checkpoint and once more as each run ends, so a job that resumed on another machine keeps it. `total`: `turns` (assistant messages), `input`, `output`, `cacheRead`, `cacheWrite` (of which `cacheWrite1h` to the one-hour cache), `costUsd` (estimated at list price) and `costKnown` (false: a model in it has no known price, and its share counts nothing). `models`: the same per model, the costliest first. `sessions`: its agent sessions read; `machines` and `accounts`: where they were read last and who its Claude was signed in as; `first` and `last`: its first and last counted message. Counts only: never the text of a session. A job of an executor that keeps no agent session has none (`sessions` 0). `total.failedTests`: the local test runs its agent started that failed (absent: none). `waste`: its waste signals (`kind` `no_progress`: many turns with no commit and no push; `failing_tests`: repeated failing test runs; `resume_loop`: started again and again; `cache_churn`: much written to the cache, little read back; each with `why`). Signals only: nothing is paused for one. 404: no such job.', returns: '`JobTokenView`', errors: [404] },
  { method: 'get', path: '/api/usage/tokens', tag: 'Machines and usage', summary: 'The token ledger: token use and cost by job, repository, machine, lane, account, model or day', description: 'The request\'s user\'s token ledger (issue #2302) summed per group, the costliest first. `by`: `job`, `issue` (`owner/name#N`), `repo`, `machine`, `lane`, `account` (who the machine\'s Claude was signed in as), `model` or `day` (the UTC day of a session\'s last counted message); default `repo`. A group the ledger cannot name is `(none)`. `split` (one of the same groups): each group also has `parts`, its rows summed per that second group, which sum to it — `by=day&split=repo` or `split=account` is the Dashboard\'s tokens over time, stacked. Filters: `job` (one job\'s id), `repo` (`owner/name`), `since` (a date or a time: sessions whose last counted message is at or after it). `total`: every row the filters keep; each group\'s `jobs`: how many jobs it holds. `top`: the jobs that cost most, at most ten, with their title and repository. `waste`: the jobs with a waste signal, the costliest first, at most twenty, each with its `signals` (as on `GET /api/jobs/:id/tokens`). `perMerged`: the efficiency number — `pullRequests` merged in the range (from `since`, else from the ledger\'s first message; of the `job` or `repo` filter), and every token and the estimated cost divided by them (`tokens`, `costUsd`; absent when none was merged). Counts only. 400: a bad query.', query: tokenLedgerQuery, returns: '`TokenLedgerRollup` `{ by, total, groups: TokenRollupRow[] (with `parts` when split), top: (TokenTotals & { jobId, title?, repo? })[], waste: TokenWasteLine[], perMerged: { pullRequests, tokens?, costUsd? } }`', errors: [400] },
  ...TOKEN_BUDGET_OPERATIONS, ...MODEL_ROUTING_OPERATIONS,
];

export interface TokenLedgerRollup {
  by: string; total: TokenTotals; groups: TokenRollupRow[]; top: (TokenTotals & { jobId: string; title?: string; repo?: string })[];
  waste: TokenWasteLine[]; perMerged: PerMergedPullRequest;
}

/** A job's waste signals from its totals: its pushes (from `pushes`, the job's own when absent), last checkpoint's commits and claims. */
function wasteOf(store: UserStore, jobId: string, t: TokenTotals, pushes?: number): TokenWaste[] {
  const job = store.jobs.get(jobId);
  if (!job) return [];
  const pushed = pushes ?? store.events.recent(1000, [...PROXY_DONE], jobId).filter(isPush).length;
  return tokenWaste(t, { pushes: pushed, commits: job.checkpoint?.commits.length ?? 0, attempts: job.attempts });
}

export function tokenLedgerRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/jobs/:id/tokens', async (req): Promise<JobTokenView> => {
    const { id } = parseWith(z.object({ id: z.string() }), req.params);
    const { store } = o.tenant(req);
    if (!store.jobs.get(id)) throw new HttpError(404, `job ${id} not found`);
    const view = jobTokenView(id, store.tokenLedger.list({ jobId: id }));
    return { ...view, waste: view.sessions > 0 ? wasteOf(store, id, view.total) : [] };
  });

  app.get('/api/usage/tokens', async (req): Promise<TokenLedgerRollup> => {
    const q = parseWith(tokenLedgerQuery, req.query);
    const { store } = o.tenant(req);
    const facts = new Map<string, (JobTokenFacts & { title?: string }) | undefined>();
    const factsOf = (jobId: string) => {
      if (!facts.has(jobId)) {
        const s = store.jobs.get(jobId)?.source;
        facts.set(jobId, s ? { repo: s.repo, issue: s.repo && s.number !== undefined ? `${s.repo}#${s.number}` : undefined, title: s.title } : undefined);
      }
      return facts.get(jobId);
    };
    const since = q.since && q.since.length === 10 ? `${q.since}T00:00:00.000Z` : q.since;
    const entries = store.tokenLedger.list({ ...(q.job ? { jobId: q.job } : {}), ...(since && !q.job ? { since } : {}) })
      .filter((e) => (!since || (e.last ?? e.readAt) >= since) && (!q.repo || factsOf(e.jobId)?.repo === q.repo));
    const top = tokenRollup(entries, 'job', factsOf).slice(0, TOP).map(({ key, jobs: _, ...t }) => {
      const f = factsOf(key);
      return { jobId: key, ...(f?.title ? { title: f.title } : {}), ...(f?.repo ? { repo: f.repo } : {}), ...t };
    });
    const total = sumTokenUse(entries);
    // The pushes are read from the first message of the range's jobs, so a push before `since` still counts as progress;
    // the merges over the range: the filter's, else the ledger's own, from its first message.
    const first = entries.reduce<string | undefined>((m, e) => { const at = e.first ?? e.readAt; return !m || at < m ? at : m; }, undefined);
    const pushes = new Map<string, number>();
    const merged = new Set<string>();
    if (first !== undefined) {
      for (const e of store.events.between([...PROXY_DONE], first)) if (e.jobId && isPush(e)) pushes.set(e.jobId, (pushes.get(e.jobId) ?? 0) + 1);
      for (const e of store.events.between(['job.pull_request_merged'], since ?? first)) {
        if (!e.jobId || (q.job && e.jobId !== q.job) || (q.repo && factsOf(e.jobId)?.repo !== q.repo)) continue;
        merged.add((e.data as { pullRequest: string }).pullRequest);
      }
    }
    const waste = tokenRollup(entries, 'job', factsOf).flatMap(({ key, jobs: _, ...t }) => {
      const signals = wasteOf(store, key, t, pushes.get(key) ?? 0);
      if (signals.length === 0) return [];
      const f = factsOf(key);
      return [{ jobId: key, ...(f?.title ? { title: f.title } : {}), ...(f?.repo ? { repo: f.repo } : {}), ...t, signals }];
    }).slice(0, WASTE_TOP);
    return { by: q.by, total, groups: tokenRollup(entries, q.by, factsOf, q.split), top, waste, perMerged: perMergedPullRequest(total, merged.size) };
  });
}
