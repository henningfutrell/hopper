// The vault's edits (issue #558, design.md "The vault"), an admin's: set a secret — a new one, or a new value or scope
// for one —, or point one at where a vault backend keeps it (issue #585) —, or mark one a minting credential (issue #580) —, or remove it; save a template (its image, scope and operation profiles), remove it, approve it as it is now,
// or approve one of its operation profiles explicitly (issue #584: the gate for a write, sync or apply profile); give or
// decline a credential request (issue #583, "The dynamic vault"). Each answers the vault's view, never a value, and is not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_KINDS, OPERATIONS } from '../../domain/access.ts';
import { MINTS_FOR_KINDS } from '../../domain/minting.ts';
import { CREDENTIAL_NOTE_MAX, VAULT_REFERENCE_MAX, VAULT_VALUE_MAX } from '../../domain/vault.ts';
import { HttpError, parseWith } from '../errors.ts';
import { holdsTemplate, vaultView, type Vault } from '../../vault/service.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// The shape only: what the model can hold (an asset name's characters) the vault checks, and says why.
const profile = { operation: z.enum(OPERATIONS), asset: z.strictObject({ kind: z.enum(ASSET_KINDS), name: z.string().max(200) }) };
const mints = z.strictObject({ kind: z.enum(MINTS_FOR_KINDS), name: z.string().max(200) }).nullable().optional();

export const vaultEditBody = z.discriminatedUnion('action', [
  // A value, or (issue #585) the vault backend that keeps it and where: one of the two, never both. `mints` (issue #580):
  // the account or cluster it is a minting credential for; null makes it a plain secret again.
  z.strictObject({ action: z.literal('set'), name: z.string().max(64), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX), mints }),
  z.strictObject({ action: z.literal('set-in-backend'), name: z.string().max(64), scope: z.string().max(200).optional(), backend: z.string().max(64), reference: z.string().max(VAULT_REFERENCE_MAX), mints }),
  z.strictObject({ action: z.literal('remove'), name: z.string().max(64) }),
  z.strictObject({
    action: z.literal('save-template'), name: z.string().max(64), image: z.string().max(300), secrets: z.array(z.string().max(64)).max(256),
    profiles: z.array(z.strictObject(profile)).max(256).optional(),
  }),
  z.strictObject({ action: z.literal('remove-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('approve-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('approve-profile'), name: z.string().max(64), ...profile }),
  // A credential request (issue #583): give a credential — a new value, or a secret the vault holds — or decline it.
  z.strictObject({
    action: z.literal('give-credential'), request: z.string().max(64), name: z.string().max(64), kind: z.string().max(40),
    note: z.string().max(CREDENTIAL_NOTE_MAX).optional(), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX).optional(),
  }),
  z.strictObject({ action: z.literal('decline-credential'), request: z.string().max(64), reason: z.string().max(CREDENTIAL_NOTE_MAX) }),
]);

const STATUS = { invalid: 400, not_found: 404, conflict: 409, unavailable: 503 } as const;

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
    const said = { ...('scope' in edit && edit.scope !== undefined ? { scope: edit.scope } : {}), ...('mints' in edit && edit.mints !== undefined ? { mints: edit.mints } : {}) };
    const r = edit.action === 'set' ? await vault.set({ name: edit.name, value: edit.value, ...said }, by)
      : edit.action === 'set-in-backend' ? await vault.set({ name: edit.name, backend: edit.backend, reference: edit.reference, ...said }, by)
        : edit.action === 'remove' ? await vault.remove(edit.name, by)
          : edit.action === 'save-template' ? await vault.saveTemplate(edit, by)
            : edit.action === 'remove-template' ? await vault.removeTemplate(edit.name, by)
              : edit.action === 'approve-template' ? await vault.approveTemplate(edit.name, by)
                : edit.action === 'approve-profile' ? await vault.approveProfile(edit.name, { operation: edit.operation, asset: edit.asset }, by)
                  : edit.action === 'give-credential' ? await vault.give(edit.request, giveOf(edit), by)
                    : vault.decline(edit.request, edit.reason, by);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return await vaultView(vault);
  });
}

/**
 * A plugins edit (`POST /ui/api/plugins`) that sets a machine's template, refused unless the vault holds that template
 * (issue #604): no box points at a template that is not there. Any other edit passes unchanged.
 */
export function knownTemplate<E extends { action: string; role?: string; options?: Record<string, unknown> }>(vault: Pick<Vault, 'view'>, edit: E): E {
  const template = (edit.action === 'options' || edit.action === 'add') && edit.role === 'machine-source' ? edit.options?.template : undefined;
  if (template !== undefined && !(typeof template === 'string' && holdsTemplate(vault, template))) {
    throw new HttpError(404, `no template ${String(template)}: save it in Settings → Vault first`);
  }
  return edit;
}

/** The template a join line names (issue #558), refused unless the vault holds it. */
export function joinTemplate(vault: Pick<Vault, 'view'>, template: string | undefined): string | undefined {
  if (template !== undefined && !holdsTemplate(vault, template)) throw new HttpError(404, `no template ${template}`);
  return template;
}
