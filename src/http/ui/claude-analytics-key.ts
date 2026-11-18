// The Claude Analytics API key (issue #2966, design.md "Daily usage from the Analytics API"): the key the `claude-analytics`
// usage source reads daily usage with. Its view, and an admin's set — checked once against the Analytics API, then kept in
// the vault's system scope — or remove. The key reads the usage of a whole organization, so least role admin, then Access
// decides. Answered as its view, never the key, not cached. `hopper claude-analytics-key` reads and posts here.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VAULT_VALUE_MAX, type AnalyticsKeyView } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const analyticsKeyBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set'), value: z.string().max(VAULT_VALUE_MAX) }),
  z.strictObject({ action: z.literal('remove') }),
]);
const KEY_STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;

export const ANALYTICS_KEY_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/claude-analytics-key', tag: 'Machines and usage', summary: 'The Claude Analytics API key', description: 'Issue #2966: the key the `claude-analytics` usage source reads daily usage with — `set`, its `last4` characters, `setAt` and `setBy`, never the key; `problem` when none can be kept or opened. `hopper claude-analytics-key` reads it. Not cached.', returns: '`AnalyticsKeyView`' },
  { method: 'post', path: '/ui/api/claude-analytics-key', tag: 'Machines and usage', summary: 'Set or remove the Claude Analytics API key', description: 'Issue #2966. `set` checks `value` once against the Analytics API (one page of one user of `/v1/organizations/analytics/users`, at the `baseUrl` of the user\'s `claude-analytics` usage source, else the Claude API), then keeps it in the vault\'s system scope, sealed under `HOPPER_MASTER_KEY`, in place of any key kept (`vault.secret_set`, name `system/claude-analytics-key`); a key the API refuses, or a check that cannot reach it, is not kept, and the 400 says why with the key masked. `remove` deletes it (`vault.secret_removed`); 404 when none is set. The source reads with the change at its next read, without a restart. The key reads a whole organization\'s usage: an admin\'s, then Access (OpenFGA, `system_secret#can_change`) decides; 403 when it does not. 503 when Access cannot be asked, or the runtime gives no `HOPPER_MASTER_KEY`. The answer is the key\'s view (`AnalyticsKeyView`), never the key. Not cached. `hopper claude-analytics-key set|remove` posts here.', role: 'admin', body: analyticsKeyBody, returns: '`AnalyticsKeyView`', errors: [400, 403, 404, 503] },
];

export function registerAnalyticsKeyRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/claude-analytics-key', async (req, reply): Promise<AnalyticsKeyView> => {
    reply.header('cache-control', 'no-store');
    return o.tenant(req).analyticsKey.view();
  });
  app.post('/ui/api/claude-analytics-key', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the analytics key');
    const { analyticsKey } = o.tenant(req);
    const edit = parseWith(analyticsKeyBody, req.body);
    const who = { userId: s.userId, admin: s.role === 'admin', by: personOf(s) };
    const r = edit.action === 'set' ? await analyticsKey.set(edit.value, who) : await analyticsKey.remove(who);
    if (!r.ok) throw new HttpError(KEY_STATUS[r.code], r.error);
    return r.view;
  });
}
