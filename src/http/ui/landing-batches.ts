// Landing batches (issue #1073, design.md "Landing batches"): per repository, the tested branch a green batch run moves
// and when a batch run starts (after N merges, or a timer), and each configured repository's batch state. The settings
// are the user's, in the database, changed by an admin; the runner reads them at each pass, so a change applies with no
// restart. A job's pull request lands on the landing branch the settings name (`main` when left out, issue #1142).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_LANDING_BATCHES, patchLandingBatches, type LandingBatchesView } from '../../domain/landing-batches.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const repoName = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200);
const branchName = z.string().regex(/^[A-Za-z0-9._/-]+$/, 'a branch name').max(200);
/** Per repository: the parts to set (a new one names its `tested` branch), or `null` to take its landing batches away. */
export const landingBatchesBody = z.strictObject({
  repos: z.record(repoName, z.strictObject({
    tested: branchName.optional(),
    landing: branchName.optional(),
    everyMerges: z.number().int().min(1).max(100).optional(),
    everyMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    canaryHours: z.number().int().min(1).max(30 * 24).nullable().optional(),
  }).nullable()),
});

/** The repository whose landing batch a person restarts (issue #1333). */
export const restartLandingBatchBody = z.strictObject({ repo: repoName });

export const LANDING_BATCH_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/landing-batches', tag: 'Jobs', summary: 'Landing batches', description: 'Issue #1073: per repository (`owner/repo`, lowercased), the `landing` branch a batch run tests (issue #1142; `main` when left out), the `tested` branch a green batch run moves, and when a batch run starts (`everyMerges` merges, or `everyMinutes` since the last one; none while nothing is new). `repos`: each configured repository\'s state — the batch run at work, the last tip tested and promoted, how the last run ended, a red batch\'s bisect and culprit, the `backMerge` after merge conflicts and its `backMergeIssue` (part 4), the `canary` candidate (part 5) —, and what the last pass found: `why` no run started, or the `problem`, and of the canary `canary.why` or `canary.problem`. `choices.repos` the job repositories. Not cached.', returns: '`LandingBatchesView`' },
  { method: 'post', path: '/ui/api/landing-batches', tag: 'Jobs', summary: 'Change the landing batches', description: 'Issue #1073: `repos` sets each named repository\'s parts (a new one names its `tested` branch; `landing` `main`, `everyMerges` 5 and `everyMinutes` 60 when left out; `canaryHours` the canary window, part 5, `null` for no canary step), or `null` to take its landing batches away (`landing_batches.changed`). The landing branch is this setting, whatever the repository\'s default branch on GitHub (issue #1142). Applies at the next pass, with no restart; a save that changes nothing records nothing.', role: 'admin', body: landingBatchesBody, returns: '`LandingBatchesView`', errors: [400] },
  { method: 'post', path: '/ui/api/landing-batches/restart', tag: 'Jobs', summary: 'Restart a landing batch', description: 'Issue #1333: the way out of a stuck landing pass, with no hand edit on GitHub. Records `landing_batch.restarted` at once, which ends the batch run and the bisect at work of `repo`; then, after the answer, their pull requests are closed and their branches removed, and a pass starts a new batch run at the landing branch\'s tip, the same tip too. 404: `repo` has no landing batches; 409: no GitHub connection.', role: 'admin', body: restartLandingBatchBody, returns: '`LandingBatchesView`', errors: [400, 404, 409] },
];

export function landingBatchesView(t: Pick<TenantParts, 'store' | 'githubProxy'>): LandingBatchesView {
  return {
    settings: t.store.settings.getLandingBatches() ?? DEFAULT_LANDING_BATCHES,
    choices: { repos: t.store.settings.getJobRepositories('github') },
    ...t.githubProxy.landingBatches.view(),
  };
}

export function landingBatchReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/landing-batches', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return landingBatchesView(o.tenant(req));
  });
}

export function registerLandingBatchRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/landing-batches', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the landing batches');
    const t = o.tenant(req);
    const patch = parseWith(landingBatchesBody, req.body);
    t.store.tx(() => {
      const from = t.store.settings.getLandingBatches() ?? DEFAULT_LANDING_BATCHES;
      const to = patchLandingBatches(from, patch);
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setLandingBatches(to);
      t.store.events.append({ type: 'landing_batches.changed', data: { from, to, by: personOf(s) } });
    });
    void t.githubProxy.landingBatches.pass().catch(() => undefined);
    return landingBatchesView(t);
  });
  app.post('/ui/api/landing-batches/restart', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to restart a landing batch');
    const t = o.tenant(req);
    const { repo } = parseWith(restartLandingBatchBody, req.body);
    if (!(t.store.settings.getLandingBatches() ?? DEFAULT_LANDING_BATCHES).repos[repo.toLowerCase()]) throw new HttpError(404, `${repo} has no landing batches`);
    let done: Promise<void>;
    try {
      ({ done } = t.githubProxy.landingBatches.restart(repo, personOf(s)));
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    // The GitHub work runs after the answer (issue #1194).
    void done.catch(() => undefined);
    return landingBatchesView(t);
  });
}
