// The shared secrets' edits (issue #718, design.md "Shared secrets"): the hopper's admin's alone, behind the `instance`
// guard. Share a secret with every user's agents, or with the users named; replace it; remove it. Each answers the
// session's user's vault view, never a value, and is not cached. Access (OpenFGA) decides each change too.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VAULT_VALUE_MAX } from '../../domain/vault.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { vaultView } from '../../vault/vault.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const sharedSecretBody = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('set'), name: z.string().max(71), value: z.string().max(VAULT_VALUE_MAX), scope: z.string().max(200).optional(),
    readers: z.array(z.string().max(128)).max(100).optional(),
  }),
  z.strictObject({ action: z.literal('remove'), name: z.string().max(71) }),
]);

const STATUS = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403, unavailable: 503 } as const;

export const SHARED_SECRET_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/vault/shared', tag: 'Vault', summary: 'Share a vault secret with agents, or remove a shared secret', description: 'Only the instance admin (issue #718). `set` keeps a shared secret — a name (bare, or as `shared/<name>`), its value, an optional `scope` line, and optional `readers` (user ids; absent: every user) — in the instance\'s vault, encrypted under the master key and never answered back; a second `set` replaces its value, scope and readers. Every user\'s `GET /api/vault` lists it under `shared` as `shared/<name>`, the name a template puts in its scope. A job on a box gets it only when the box\'s template names it, a person approved that, and Access (`shared_secret#can_read`, the readers told at each ask) allows the job\'s user. `remove` deletes it; 404 when there is none. Access decides each change as well (403 when it refuses; 503 when OpenFGA cannot be asked, or the runtime gives no `HOPPER_MASTER_KEY`). Not cached.', role: 'admin', body: sharedSecretBody, returns: 'the session\'s user\'s vault view, as GET /api/vault', errors: [400, 403, 404, 503] },
];

export function registerSharedSecretRoutes(app: FastifyInstance, o: { instance: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/vault/shared', o.instance, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to share a vault secret');
    const { vault } = o.tenant(req);
    if (!vault.shared) throw new HttpError(503, 'this hopper keeps no shared secrets');
    const edit = parseWith(sharedSecretBody, req.body);
    // The instance guard let only the hopper's admin in.
    const who = { userId: s.userId, admin: true, by: identityName(s.identity) };
    const r = edit.action === 'set'
      ? await vault.shared.set({ name: edit.name, value: edit.value, ...(edit.scope !== undefined ? { scope: edit.scope } : {}), ...(edit.readers ? { readers: edit.readers } : {}) }, who)
      : await vault.shared.remove(edit.name, who);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return await vaultView(vault);
  });
}
