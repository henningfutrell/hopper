// The token ledger's reads (issue #2302, design.md "The token ledger"): GET /api/jobs/:id/tokens, one job's token use
// and estimated cost, and GET /api/usage/tokens, the request's user's ledger summed by job, issue, repository, machine,
// lane, account, model or day, with the top spenders. Counts and metadata only: no text of a session. Read only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobTokenView, sumTokenUse, TOKEN_GROUPS, tokenRollup, type JobTokenFacts, type JobTokenView, type TokenRollupRow, type TokenTotals } from '../domain/token-usage.ts';
import { HttpError, parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

/** How many jobs the top spenders list. */
const TOP = 10;

export const tokenLedgerQuery = z.object({
  by: z.enum(TOKEN_GROUPS).default('repo'),
  job: z.string().min(1).optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  since: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
});

export const TOKEN_LEDGER_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/jobs/:id/tokens', tag: 'Jobs', summary: 'A job\'s token use and estimated cost', description: 'What the job\'s agent spent (issue #2302, the token ledger), read from its agent session\'s log — the usage block of each assistant message — at each checkpoint and once more as each run ends, so a job that resumed on another machine keeps it. `total`: `turns` (assistant messages), `input`, `output`, `cacheRead`, `cacheWrite` (of which `cacheWrite1h` to the one-hour cache), `costUsd` (estimated at list price) and `costKnown` (false: a model in it has no known price, and its share counts nothing). `models`: the same per model, the costliest first. `sessions`: its agent sessions read; `machines` and `accounts`: where they were read last and who its Claude was signed in as; `first` and `last`: its first and last counted message. Counts only: never the text of a session. A job of an executor that keeps no agent session has none (`sessions` 0). 404: no such job.', returns: '`JobTokenView`', errors: [404] },
  { method: 'get', path: '/api/usage/tokens', tag: 'Machines and usage', summary: 'The token ledger: token use and cost by job, repository, machine, lane, account, model or day', description: 'The request\'s user\'s token ledger (issue #2302) summed per group, the costliest first. `by`: `job`, `issue` (`owner/name#N`), `repo`, `machine`, `lane`, `account` (who the machine\'s Claude was signed in as), `model` or `day` (the UTC day of a session\'s last counted message); default `repo`. A group the ledger cannot name is `(none)`. Filters: `job` (one job\'s id), `repo` (`owner/name`), `since` (a date or a time: sessions whose last counted message is at or after it). `total`: every row the filters keep; each group\'s `jobs`: how many jobs it holds. `top`: the jobs that cost most, at most ten, with their title and repository. Counts only. 400: a bad query.', query: tokenLedgerQuery, returns: '`TokenLedgerRollup` `{ by, total, groups: TokenRollupRow[], top: (TokenTotals & { jobId, title?, repo? })[] }`', errors: [400] },
];

export interface TokenLedgerRollup { by: string; total: TokenTotals; groups: TokenRollupRow[]; top: (TokenTotals & { jobId: string; title?: string; repo?: string })[] }

export function tokenLedgerRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/jobs/:id/tokens', async (req): Promise<JobTokenView> => {
    const { id } = parseWith(z.object({ id: z.string() }), req.params);
    const { store } = o.tenant(req);
    if (!store.jobs.get(id)) throw new HttpError(404, `job ${id} not found`);
    return jobTokenView(id, store.tokenLedger.list({ jobId: id }));
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
    return { by: q.by, total: sumTokenUse(entries), groups: tokenRollup(entries, q.by, factsOf), top };
  });
}
