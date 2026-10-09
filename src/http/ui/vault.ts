// The vault's edits (issue #558, design.md "The vault"), an admin's: set a secret — a new one, or a new value or scope
// for one —, or remove it. Each answers the vault's view, never a value, and is not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VAULT_VALUE_MAX } from '../../domain/vault.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const vaultEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set'), name: z.string().max(64), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX) }),
  z.strictObject({ action: z.literal('remove'), name: z.string().max(64) }),
]);

const STATUS = { invalid: 400, not_found: 404, unavailable: 503 } as const;

export function registerVaultRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/vault', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the vault');
    const by = identityName(s.identity);
    const { vault } = o.tenant(req);
    const edit = parseWith(vaultEditBody, req.body);
    const r = edit.action === 'set'
      ? vault.set({ name: edit.name, value: edit.value, ...(edit.scope !== undefined ? { scope: edit.scope } : {}) }, by)
      : vault.remove(edit.name, by);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return vault.view();
  });
}
