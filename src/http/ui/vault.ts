// The vault's edits (issue #558, design.md "The vault"), an admin's: set a secret — a new one, or a new value or scope
// for one —, or point one at where a vault backend keeps it (issue #585) —, or mark one a minting credential (issue #580) —, or remove it; save a template (its image, scope and operation profiles), remove it, approve it as it is now,
// or approve one of its operation profiles explicitly (issue #584: the gate for a write, sync or apply profile); give or
// decline a credential request (issue #583, "The dynamic vault"); keep a system secret of the user's in a vault backend
// (issue #658); set the read policy (issue #716); run a template's read-only check again (issue #716); ask for the
// template some needs name, as a running job does (issue #718, "Templates on request"). Each answers the vault's view,
// never a value, and is not cached. An API token's approval of a write, sync or apply profile is a person's to confirm
// (issue #909): asked, not done.
import { rememberApproval } from '../../domain/remembered-writes.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_KINDS, OPERATIONS } from '../../domain/access.ts';
import { MINTS_FOR_KINDS } from '../../domain/minting.ts';
import { readPolicyProblem } from '../../domain/read-policy.ts';
import type { UserStore } from '../../domain/ports.ts';
import { CREDENTIAL_NOTE_MAX, systemBackendRefusal, VAULT_REFERENCE_MAX, VAULT_VALUE_MAX, type SystemSecretName } from '../../domain/vault.ts';
import type { SystemChanger, SystemResult } from '../../vault/system.ts';
import { HttpError, parseWith } from '../errors.ts';
import { previewTemplate, requestTemplate } from '../../skills/template-request.ts';
import { holdsTemplate, type Vault } from '../../vault/vault.ts';
import { templateRequestUser, vaultAnswer } from '../vault.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { profileAsk, profileNeedsPerson, profileRef } from '../../domain/confirmation-asks.ts';
import { askerOf, askPerson, byApiToken } from './confirmation-asks.ts';
import { templateNames } from '../../domain/delegates.ts';
import type { ApiGrants } from './api-grants.ts';
import { approverOf, delegateOf, refuseDenied } from './delegates.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// The shape only: what the model can hold (an asset name's characters) the vault checks, and says why.
// A terraform workspace need's state backend (issue #715): the read-only check probes it.
const stateBackend = z.strictObject({ bucket: z.string().max(63), region: z.string().max(32), keyPrefix: z.string().max(200).optional() });
const profile = { operation: z.enum(OPERATIONS), asset: z.strictObject({ kind: z.enum(ASSET_KINDS), name: z.string().max(200) }) };
const mints = z.strictObject({ kind: z.enum(MINTS_FOR_KINDS), name: z.string().max(200) }).nullable().optional();

/** A template's limits (issue #708): the defaults and maximums a launch of it may ask for; checked by the vault. */
const range = z.strictObject({ default: z.number().positive(), max: z.number().positive() });
const templateLimits = z.strictObject({ cpus: range.optional(), memoryMb: range.optional() });

export const vaultEditBody = z.discriminatedUnion('action', [
  // A value, or (issue #585) the vault backend that keeps it and where: one of the two, never both. `mints` (issue #580):
  // the account or cluster it is a minting credential for; null makes it a plain secret again.
  z.strictObject({ action: z.literal('set'), name: z.string().max(64), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX), mints }),
  z.strictObject({ action: z.literal('set-in-backend'), name: z.string().max(64), scope: z.string().max(200).optional(), backend: z.string().max(64), reference: z.string().max(VAULT_REFERENCE_MAX), mints }),
  z.strictObject({ action: z.literal('remove'), name: z.string().max(64) }),
  // A system secret of the user's that a person gives (issue #658, requirement 6): kept in a vault backend in place of the hopper.
  z.strictObject({ action: z.literal('system-in-backend'), name: z.string().max(200), backend: z.string().max(64), reference: z.string().max(VAULT_REFERENCE_MAX) }),
  z.strictObject({
    action: z.literal('save-template'), name: z.string().max(64), image: z.string().max(300), secrets: z.array(z.string().max(64)).max(256),
    profiles: z.array(z.strictObject({ ...profile, backend: stateBackend.optional() })).max(256).optional(), limits: templateLimits.optional(), tools: z.array(z.string().max(32)).max(16).optional(),
    // The hosts its boxes may reach through the egress proxy (issue #1875): `host:port`. Absent keeps them; `[]` drops them.
    egress: z.array(z.string().max(260)).max(32).optional(),
    // The targets a bastion of it may forward to (issue #2146 part 3). Absent keeps them; `[]` drops them.
    bastionTargets: z.array(z.string().max(400)).max(32).optional(),
    // One of its secrets its boxes' agent signs in with (issue #708, part 10): absent keeps it, null names none.
    agentCredential: z.string().max(64).nullable().optional(),
    // A person's marks on its read probes (issue #916): probe id → `expect-denied` or `skip`. Absent keeps them; `{}` drops them.
    probeMarks: z.record(z.string().max(64), z.string().max(32)).optional(),
  }),
  z.strictObject({ action: z.literal('remove-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('approve-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('revoke-template'), name: z.string().max(64) }),
  z.strictObject({ action: z.literal('approve-profile'), name: z.string().max(64), ...profile }),
  // The read-only check (issue #716): run it again on the template as it is now, at the next check pass.
  z.strictObject({ action: z.literal('check-template'), name: z.string().max(64) }),
  // A credential request (issue #583): give a credential — a new value, or a secret the vault holds — or decline it.
  z.strictObject({
    action: z.literal('give-credential'), request: z.string().max(64), name: z.string().max(64), kind: z.string().max(40),
    note: z.string().max(CREDENTIAL_NOTE_MAX).optional(), scope: z.string().max(200).optional(), value: z.string().max(VAULT_VALUE_MAX).optional(),
  }),
  z.strictObject({ action: z.literal('decline-credential'), request: z.string().max(64), reason: z.string().max(CREDENTIAL_NOTE_MAX) }),
  // The read policy (issue #716): the assets read is approved on with no person, for a template a job asks for.
  z.strictObject({ action: z.literal('set-read-policy'), assets: z.array(z.string().max(220)).max(256) }),
  // A template request (issue #718): the needs, as a job's `sandbox-template --needs` says them.
  z.strictObject({ action: z.literal('request-template'), needs: z.string().max(4000) }),
  // The template request on the page (issue #708, part 9): the template those needs make, shown before it is made. Saves nothing.
  z.strictObject({ action: z.literal('preview-template'), needs: z.string().max(4000) }),
]);

const STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;

type GiveEdit = Extract<z.infer<typeof vaultEditBody>, { action: 'give-credential' }>;
/** The person's answer to a credential request: an empty value is none (the secret named is one the vault holds). */
const giveOf = (e: GiveEdit) => ({
  name: e.name, kind: e.kind, ...(e.note !== undefined ? { note: e.note } : {}), ...(e.scope !== undefined ? { scope: e.scope } : {}),
  ...(e.value ? { value: e.value } : {}),
});

export function registerVaultRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts; grants: Pick<ApiGrants, 'live'> }): void {
  app.post('/ui/api/vault', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the vault');
    const parts = o.tenant(req);
    const { vault } = parts;
    const edit = parseWith(vaultEditBody, req.body);
    // A delegate approver (issue #1138) approves a template only where its approver policy names nothing of it.
    const delegate = delegateOf(o.grants, s);
    const by = approverOf(delegate, s);
    if (delegate && edit.action === 'approve-template') {
      const t = vault.view().templates.find((x) => x.name === edit.name);
      refuseDenied(delegate, t ? templateNames(t) : [edit.name], `approving the template ${edit.name}`);
    }
    if (edit.action === 'approve-profile' && byApiToken(s) && profileNeedsPerson(edit)) {
      const profile = { operation: edit.operation, asset: edit.asset };
      const waits = vault.view().templates.find((t) => t.name === edit.name)?.pending.profiles.some((p) => profileRef(edit.name, p) === profileRef(edit.name, profile));
      if (waits) return askPerson(parts.store, reply, profileAsk(edit.name, profile, askerOf(s)));
    }
    if (edit.action === 'set-read-policy') {
      const assets = [...new Set(edit.assets.map((x) => x.trim()).filter((x) => x !== ''))];
      const problem = readPolicyProblem(assets);
      if (problem) throw new HttpError(400, problem);
      parts.store.tx(() => {
        parts.store.settings.setReadPolicy({ assets });
        parts.store.events.append({ type: 'vault.read_policy_set', data: { assets, by } });
      });
      return await vaultAnswer(parts);
    }
    if (edit.action === 'system-in-backend') {
      const r = await systemInBackend(vault, parts.store, edit, { userId: s.userId, admin: s.role === 'admin', by });
      if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
      return await vaultAnswer(parts);
    }
    if (edit.action === 'preview-template') {
      const preview = previewTemplate(templateRequestUser(parts), { needs: edit.needs });
      if (typeof preview === 'string') throw new HttpError(400, preview);
      return { preview };
    }
    if (edit.action === 'request-template') {
      const r = await requestTemplate(templateRequestUser(parts), { needs: edit.needs }, by);
      if ('reason' in r) throw new HttpError(r.status, r.reason);
      return { ...await vaultAnswer(parts), request: { template: r.template, ready: r.status === 200, text: r.text } };
    }
    const said = { ...('scope' in edit && edit.scope !== undefined ? { scope: edit.scope } : {}), ...('mints' in edit && edit.mints !== undefined ? { mints: edit.mints } : {}) };
    const r = edit.action === 'set' ? await vault.set({ name: edit.name, value: edit.value, ...said }, by)
      : edit.action === 'set-in-backend' ? await vault.set({ name: edit.name, backend: edit.backend, reference: edit.reference, ...said }, by)
        : edit.action === 'remove' ? await vault.remove(edit.name, by)
          : edit.action === 'save-template' ? await vault.saveTemplate(edit, by)
            : edit.action === 'remove-template' ? await vault.removeTemplate(edit.name, by)
              : edit.action === 'approve-template' ? await vault.approveTemplate(edit.name, by)
                : edit.action === 'revoke-template' ? await vault.revokeTemplate(edit.name, by)
                : edit.action === 'approve-profile' ? await vault.approveProfile(edit.name, { operation: edit.operation, asset: edit.asset }, by)
                : edit.action === 'check-template' ? vault.checkTemplate(edit.name, by)
                  : edit.action === 'give-credential' ? await vault.give(edit.request, giveOf(edit), by)
                    : vault.decline(edit.request, edit.reason, by);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    // Issue #1001: a person's approval of a write, sync or apply is remembered for its asset and access.
    if (edit.action === 'approve-profile') rememberApproval(parts.store.settings, { operation: edit.operation, asset: edit.asset }, by, new Date());
    return await vaultAnswer(parts);
  });
}

/** Keeps a user's system secret in a vault backend: a webhook's only while its subscription is there. */
async function systemInBackend(
  vault: Vault, store: Pick<UserStore, 'webhooks'>, e: { name: string; backend: string; reference: string }, who: SystemChanger,
): Promise<SystemResult> {
  const refused = systemBackendRefusal(e.name);
  if (refused) return { ok: false, code: 'invalid', error: refused };
  const hook = /^webhook\.([^.]+)\.signing-secret$/.exec(e.name)?.[1];
  if (hook !== undefined && !store.webhooks.get(hook)) return { ok: false, code: 'not_found', error: `no webhook subscription ${hook}` };
  if (!vault.systemInBackend) return { ok: false, code: 'unavailable', error: 'the vault\'s system scope is not part of this hopper' };
  return vault.systemInBackend(e.name as SystemSecretName, e.backend, e.reference, who);
}

/**
 * A plugins edit (`POST /ui/api/plugins`) that sets a machine's template, refused unless the vault holds that template
 * (issue #604): no box points at a template that is not there. Any other edit passes unchanged.
 */
export function knownTemplate<E extends { action: string; role?: string; options?: Record<string, unknown> }>(vault: Pick<Vault, 'view'>, edit: E): E {
  const template = (edit.action === 'options' || edit.action === 'add') && edit.role === 'machine-source' ? edit.options?.template : undefined;
  if (template !== undefined && !(typeof template === 'string' && holdsTemplate(vault, template))) {
    throw new HttpError(404, `no template ${String(template)}: save it in Vault first`);
  }
  return edit;
}

/** The template a join line names (issue #558), refused unless the vault holds it. */
export function joinTemplate(vault: Pick<Vault, 'view'>, template: string | undefined): string | undefined {
  if (template !== undefined && !holdsTemplate(vault, template)) throw new HttpError(404, `no template ${template}`);
  return template;
}
