// The vault's edits (issue #558, design.md "The vault"), an admin's: set a secret — a new one, or a new value or scope
// for one —, or remove it; save a template (its image and scope), remove it, or approve it as it is now; give or decline
// a credential request (issue #583, "The dynamic vault"). Each answers the vault's view, never a value, and is not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CREDENTIAL_NOTE_MAX, VAULT_VALUE_MAX } from '../../domain/vault.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const vaultEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set'), name: z.string().max(64), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX) }),
  z.strictObject({ action: z.literal('remove'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('save-template'), name: z.string().max(64), image: z.string().max(300), secrets: z.array(z.string().max(64)).max(256) }),
  z.strictObject({ action: z.literal('remove-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('approve-template'), name: z.string().max(64) }),
  // A credential request (issue #583): give a credential — a new value, or a secret the vault holds — or decline it.
  z.strictObject({
    action: z.literal('give-credential'), request: z.string().max(64), name: z.string().max(64), kind: z.string().max(40),
    note: z.string().max(CREDENTIAL_NOTE_MAX).optional(), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX).optional(),
  }),
  z.strictObject({ action: z.literal('decline-credential'), request: z.string().max(64), reason: z.string().max(CREDENTIAL_NOTE_MAX) }),
]);

const STATUS = { invalid: 400, not_found: 404, unavailable: 503 } as const;

type GiveEdit = Extract<z.infer<typeof vaultEditBody>, { action: 'give-credential' }>;
/** The person's answer to a credential request: an empty value is none (the secret named is one the vault holds). */
const giveOf = (e: GiveEdit) => ({
  name: e.name, kind: e.kind, ...(e.note !== undefined ? { note: e.note } : {}), ...(e.scope !== undefined ? { scope: e.scope } : {}),
  ...(e.value ? { value: e.value } : {}),
});

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
        : edit.action === 'save-template' ? vault.saveTemplate(edit, by)
          : edit.action === 'remove-template' ? vault.removeTemplate(edit.name, by)
            : edit.action === 'approve-template' ? vault.approveTemplate(edit.name, by)
              : edit.action === 'give-credential' ? vault.give(edit.request, giveOf(edit), by)
                : vault.decline(edit.request, edit.reason, by);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return vault.view();
  });
}
