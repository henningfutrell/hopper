// Settings → Contribution (issue #429, design.md "The contribution flow"): whether a job of a repository its user cannot
// push to may work through a fork — the hopper forks the repository into the user's account, the job pushes there and
// opens its pull request upstream from the fork. Off unless an admin turns it on; read at each request a job makes, so a
// change applies without a restart. Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_CONTRIBUTION, type ContributionSettings } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const contributionBody = z.strictObject({ on: z.boolean() });

const settingsOf = (t: Pick<TenantParts, 'store'>): ContributionSettings => t.store.settings.getContribution() ?? DEFAULT_CONTRIBUTION;

export const CONTRIBUTION_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/contribution', tag: 'Jobs', summary: 'Contribution', description: 'Issue #429: whether a job of a repository its user cannot push to may work through a fork — `hopper-gh repo fork` forks it into the user\'s account, the job pushes its branch there and opens its pull request on the repository from the fork, and files its issue on the fork when the repository takes none. `on`: false, the default.', returns: '`{ on: boolean }`' },
  { method: 'post', path: '/ui/api/contribution', tag: 'Jobs', summary: 'Turn Contribution on or off', description: 'Recorded as `contribution.changed` when it changes. Applies to the next request a job makes, without a restart: a fork made before stays, but nothing is pushed to it or opened from it while it is off.', role: 'admin', body: contributionBody, returns: '`{ on: boolean }`', errors: [400] },
];

export function registerContributionRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/contribution', async (req) => settingsOf(o.tenant(req)));
  app.post('/ui/api/contribution', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change Contribution');
    const t = o.tenant(req);
    const to = parseWith(contributionBody, req.body);
    t.store.tx(() => {
      const from = settingsOf(t);
      if (from.on === to.on) return;
      t.store.settings.setContribution(to);
      t.store.events.append({ type: 'contribution.changed', data: { from, to, by: identityName(s.identity) } });
    });
    return settingsOf(t);
  });
}
