// The vault's edits (issue #558, design.md "The vault"), an admin's: set a secret — a new one, or a new value or scope
// for one —, or remove it; save a template (its image, scope and operation profiles), remove it, approve it as it is now,
// or approve one of its operation profiles explicitly (issue #584: the gate for a write, sync or apply profile). Each
// answers the vault's view, never a value, and is not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_KINDS, OPERATIONS } from '../../domain/access.ts';
import { VAULT_VALUE_MAX } from '../../domain/vault.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// The shape only: what the model can hold (an asset name's characters) the vault checks, and says why.
const profile = { operation: z.enum(OPERATIONS), asset: z.strictObject({ kind: z.enum(ASSET_KINDS), name: z.string().max(200) }) };

export const vaultEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set'), name: z.string().max(64), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX) }),
  z.strictObject({ action: z.literal('remove'), name: z.string().max(64) }),
  z.strictObject({
    action: z.literal('save-template'), name: z.string().max(64), image: z.string().max(300), secrets: z.array(z.string().max(64)).max(256),
    profiles: z.array(z.strictObject(profile)).max(256).optional(),
  }),
  z.strictObject({ action: z.literal('remove-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('approve-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('approve-profile'), name: z.string().max(64), ...profile }),
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
    const r = edit.action === 'set' ? vault.set({ name: edit.name, value: edit.value, ...(edit.scope !== undefined ? { scope: edit.scope } : {}) }, by)
      : edit.action === 'remove' ? vault.remove(edit.name, by)
        : edit.action === 'save-template' ? await vault.saveTemplate(edit, by)
          : edit.action === 'remove-template' ? await vault.removeTemplate(edit.name, by)
            : edit.action === 'approve-template' ? await vault.approveTemplate(edit.name, by)
              : await vault.approveProfile(edit.name, { operation: edit.operation, asset: edit.asset }, by);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return vault.view();
  });
}
