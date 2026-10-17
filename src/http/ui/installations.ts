// Where the hopper's app is installed (issue #1250, design.md "Sign in with GitHub, and work through that connection"): the
// connected account's installations are kept in the database, and GET /api/connected-accounts answers from them, never
// from GitHub. Refresh reads GitHub again in the background and answers at once. A read, so an operator's: it changes no
// connection.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONNECTED_ACCOUNT_PROVIDERS, isConnectedAccountKey, type ConnectedAccountKey } from '../../domain/types.ts';
import { HttpError } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** `key`: a further connected account's (issue #1448); absent, the provider's first. */
export const installationsRefreshBody = z.strictObject({ provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), key: z.string().refine(isConnectedAccountKey, 'a connected account key: github, github-2, …').optional() });

/** Its part of the API reference (src/http/openapi.ts). */
export const INSTALLATIONS_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/connected-accounts/refresh', tag: 'Jobs', summary: 'Read where the app is installed again', description: 'Issue #1250: reads where the hopper\'s app is installed, and the repositories it reaches there, from GitHub again, in the background, with the connected account and conditional requests. Answers at once with the account as the database holds it, `installationsReading` while it reads; a read already under way is joined, not repeated. Nothing is read when no account is connected. `key` names a further account (issue #1448); absent: the first.', role: 'operator', body: installationsRefreshBody, returns: '`ConnectedAccountStatus`', errors: [400, 404] },
];

export function registerInstallationsRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/connected-accounts/refresh', o.operator, async (req) => {
    const b = parseWith(installationsRefreshBody, req.body), key = (b.key ?? b.provider) as ConnectedAccountKey;
    const { connectedAccounts } = o.tenant(req);
    if (!connectedAccounts.keys().includes(key)) throw new HttpError(404, `no connected account ${key}`);
    return connectedAccounts.refresh(key);
  });
}
