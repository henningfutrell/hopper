// The vault (issue #558, design.md "The vault"): a user's secrets, set in the UI and never read back, sealed in the
// user's store under the master key (src/secrets/sealer.ts, bound to `vault:<id>/value`). Nothing here logs, answers or
// appends a value: a set or a removal is an event naming the secret and who did it, never what it holds. A template's
// operation profiles (issue #584) are approved in access, the one record of them: a read profile with the template, a
// write, sync or apply profile only by its own explicit approval; a narrowing or a removal revokes what it dropped.
// A secret may instead be kept in a vault backend (issue #585): the hopper keeps only where, and reads it there at delivery.
// A minting credential (issue #580) is never delivered: the vault mints short-lived credentials from it (mint.ts).
// A system secret (issue #657, `system/<name>`, src/vault/system.ts) shares the table and is none of the vault's own: this
// service lists none, puts none in a template, reseals none, and refuses a job's ask for one after Access says no.
import { randomUUID } from 'node:crypto';
import type { AttachedMachine } from '../domain/machines.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { SecretUnreadable } from '../secrets/sealer.ts';
import type { Clock, CredentialMinter, UserStore } from '../domain/ports.ts';
import { profileProblem, TEMPLATE_NAME, type Asset, type OperationProfile, type VaultAccess } from '../domain/access.ts';
import { mintsForProblem } from '../domain/minting.ts';
import { AT_WORK, boxAsk, clientOf, type ClientTarget } from './box.ts';
import { createMinting, mintHere, type MintAsk, type MintFrom } from './mint.ts';
import { systemReadRefusal } from './system-read.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS, type RadiusRules, type TemplateRadius } from '../domain/blast-radius.ts';
import { givesOf, isSystemSecret, templateView, VAULT_REFERENCE_MAX, VAULT_SCOPE_MAX, VAULT_SECRET_NAME, VAULT_VALUE_MAX, type ConfiguredBackend, type Template, type TemplateView, type VaultBackendView, type VaultSecret, type VaultView } from '../domain/vault.ts';
import { highRadius, rateTemplate, type TemplateScope } from '../blast-radius/template.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { MASTER_KEY_VARIABLE } from '../secrets/token-box.ts';

/** Where a vault secret is kept: the context it is sealed for. Its id, so a fold into another user keeps it. */
export const vaultContext = (id: string): string => `vault:${id}/value`;

export type VaultResult = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'conflict' | 'unavailable'; error: string };

export interface VaultService {
  view(): VaultView;
  /**
   * Sets a secret, or a new value or scope for one: sealed, never kept or answered in clear. Or (issue #585) points it at
   * where a vault backend keeps it: `backend` and `reference` in place of `value`; the hopper then keeps no value.
   */
  set(s: SetSecret, by: string): VaultResult;
  remove(name: string, by: string): VaultResult;
  /**
   * Saves a template: its image, scope and operation profiles (absent: the ones it has). A widened scope, a new image or
   * a new profile waits for a person's approval; a profile dropped has its approval revoked.
   */
  saveTemplate(t: { name: string; image: string; secrets: readonly string[]; profiles?: readonly OperationProfile[] }, by: string): Promise<VaultResult>;
  /** Removes a template and revokes every approval access holds for it; refused, naming them, while boxes of it are attached (issue #604). */
  removeTemplate(name: string, by: string): Promise<VaultResult>;
  /** A person approves a template as it is now: its image, its whole scope, and every read profile; never a write, sync or apply profile. */
  approveTemplate(name: string, by: string): Promise<VaultResult>;
  /**
   * A person revokes a template's approval (issue #602): its boxes take no new job and are given nothing until a person
   * approves it again; every approval access holds for it is revoked with it.
   */
  revokeTemplate(name: string, by: string): Promise<VaultResult>;
  /** A person approves one of the template's operation profiles explicitly: the gate for a write, sync or apply profile (issue #584). */
  approveProfile(name: string, profile: OperationProfile, by: string): Promise<VaultResult>;
  /** What a machine's boxes may be given now: its template's approved scope; nothing for a machine of no template. */
  scopeOf(machine: string): { template?: string; secrets: string[] };
  /** A box's template and that template's rating now (issue #605): what the box's blast radius includes. Undefined: no box, or its template is gone. */
  boxRadius(machine: string): { name: string; radius: TemplateRadius } | undefined;
  /**
   * Each attached machine that joined as a box of a template, and that template: what Access writes as an instance (issue #581).
   * Only a template the vault holds (issue #604): a box of one that is not there is an instance of nothing.
   */
  boxes(): { machine: string; template: string }[];
  /**
   * A machine's ask (slice 3), already proven to be the machine's (its link's signature): one secret, for the job whose
   * proxy token it shows. The value, or why not; every outcome recorded, never with the value.
   */
  deliver(ask: { name: string; token: string }, machineKey: string): Promise<{ value: string } | { refused: string }>;
  /**
   * A machine's ask for a credential minted (issue #580): the same checks as a delivery, then Access decides, every time;
   * the minted credential as JSON, or why not. `from` mints from the minting credential: by default here (mintFrom).
   */
  mint(ask: MintAsk, machineKey: string, from?: MintFrom): Promise<{ value: string } | { refused: string }>;
  /** Mints from the minting credential `name` for `target`, here: its value opened or read in its backend, then STS or the Kubernetes API. */
  mintFrom: MintFrom;
  /** Each template's scope as its rating reads it, with this user's blast-radius rules: what access rates it from (issue #584). */
  templateScopes(): { name: string; scope: TemplateScope; rules: RadiusRules }[];
  /** Seals again, under the current key, every secret an older key sealed. How many it sealed again. */
  resealAll(): number;
}

export type { ClientTarget } from './box.ts';

/** The client targets among the attached machines. */
export const clientTargets = (machines: readonly AttachedMachine[]): ClientTarget[] =>
  machines.flatMap((m) => ('client' in m ? [{ name: m.name, key: m.client.key, ...(m.client.template !== undefined ? { template: m.client.template } : {}) }] : []));

/**
 * A secret to set: its value, or (issue #585) the vault backend that keeps it and where. `mints` (issue #580): the
 * account or cluster it is a minting credential for; null makes it a plain secret again; absent keeps it.
 */
export type SetSecret = { name: string; scope?: string; mints?: Asset | null } & ({ value: string } | { backend: string; reference: string });

const fail = (code: 'invalid' | 'not_found' | 'conflict' | 'unavailable', error: string): VaultResult => ({ ok: false, code, error });

export function createVaultService(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'settings'>;
  keys: SealerState;
  clock: Clock;
  idGen: () => string;
  /** Access, where a template's operation profiles are approved (issue #584) and every mint is decided (issue #580). Absent: none is. */
  access?: VaultAccess;
  /** The vault's user: Access names a job by its user and id. */
  userId?: string;
  /** Mints short-lived credentials (issue #580). Absent: the vault mints nothing. */
  minter?: CredentialMinter;
  logger: { warn(line: string): void };
  /** The client targets now: each one's key and the template it joined as (its join line named it). */
  targets?: () => ClientTarget[];
  /** Whether a job's proxy token is one this user's link key gives it (issue #563). */
  holds?: (parts: ProxyTokenParts) => boolean;
  /** The vault backends the plugins config names now (issue #585); none when absent. */
  backends?: () => ConfiguredBackend[];
}): VaultService {
  const { vault, events } = o.store;
  const { sealer } = o.keys;
  const unavailable = (): string => `the hopper cannot store a vault secret: ${o.keys.problem}`;
  const backendOf = (name: string): ConfiguredBackend | undefined => (o.backends?.() ?? []).find((b) => b.name === name);
  const backendView = ({ name, plugin, problem, setup }: ConfiguredBackend): VaultBackendView => ({ name, plugin, ...(problem ? { problem } : {}), ...(setup ? { setup } : {}) });

  /** Where a secret to set is kept: a sealed value, or a backend and reference with no value; or why not. */
  function keptOf(s: SetSecret, id: string): { id: string; sealed: string | null; backend?: VaultSecret['backend'] } | VaultResult {
    if ('value' in s) {
      if (s.value.length === 0 || s.value.length > VAULT_VALUE_MAX) return fail('invalid', `value must be 1 to ${VAULT_VALUE_MAX} characters`);
      if (!sealer) return fail('unavailable', unavailable());
      return { id, sealed: sealer.seal(s.value, vaultContext(id)) };
    }
    const b = backendOf(s.backend);
    if (!b) return fail('invalid', `no vault backend ${s.backend}: add it in Settings → Plugins first`);
    if (!b.backend) return fail('invalid', `the vault backend ${s.backend} cannot run: ${b.problem ?? 'unknown'}`);
    if (s.reference.length === 0 || s.reference.length > VAULT_REFERENCE_MAX) return fail('invalid', `reference must be 1 to ${VAULT_REFERENCE_MAX} characters`);
    const bad = b.backend.check(s.reference);
    if (bad) return fail('invalid', bad);
    return { id, sealed: null, backend: { name: b.name, reference: s.reference } };
  }

  /** The value of a secret kept in a backend, read there now; or why not. */
  async function readBackend(secret: VaultSecret & { backend: { name: string; reference: string } }): Promise<{ value: string } | { refused: string }> {
    const b = backendOf(secret.backend.name);
    if (!b) return { refused: `no vault backend ${secret.backend.name}: ${secret.name} is kept there; add the backend again in Settings → Plugins` };
    if (!b.backend) return { refused: `the vault backend ${b.name} cannot run: ${b.problem ?? 'unknown'}` };
    try {
      return { value: await b.backend.read(secret.backend.reference) };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      o.logger.warn(`hopper: vault backend ${b.name} cannot read ${secret.name}: ${why}`);
      return { refused: `the vault backend ${b.name} cannot read ${secret.name}: ${why}` };
    }
  }

  /** A secret's value now: opened by the key provider, or read in its vault backend; or why not. */
  async function valueOf(secret: VaultSecret): Promise<{ value: string } | { refused: string }> {
    const { backend } = secret;
    if (backend) return readBackend({ ...secret, backend });
    if (!sealer) return { refused: unavailable() };
    try {
      return { value: sealer.open(vault.sealed(secret.id) ?? '', vaultContext(secret.id)) };
    } catch (e) {
      if (!(e instanceof SecretUnreadable)) throw e;
      o.logger.warn(`hopper: vault secret ${secret.name}: ${e.message}`);
      return { refused: `the vault secret ${secret.name} cannot be opened: set it again` };
    }
  }

  const mintFrom = mintHere({ vault, valueOf, ...(o.minter ? { minter: o.minter } : {}) });

  const mint = createMinting({
    store: o.store, userId: o.userId ?? '', clock: o.clock,
    ...(o.access ? { access: o.access } : {}), ...(o.targets ? { targets: o.targets } : {}), ...(o.holds ? { holds: o.holds } : {}),
  });

  function scopeOf(machine: string): { template?: string; secrets: string[] } {
    const name = clientOf(o.targets, (m) => m.name === machine)?.template;
    const t = name === undefined ? undefined : vault.template(name);
    return { ...(name !== undefined ? { template: name } : {}), secrets: t ? givesOf(t).filter((n) => !isSystemSecret(n)) : [] };
  }

  const approvedOf = (name: string): OperationProfile[] => o.access?.approvedProfiles(name) ?? [];
  const rules = (): RadiusRules => (o.store.settings.getBlastRadius() ?? DEFAULT_BLAST_RADIUS_SETTINGS).rules;
  /** What the rating reads of a template: its secrets' names and scope lines, never a value, and its profiles. */
  const scopeOfTemplate = (t: Template): TemplateScope => ({
    secrets: t.secrets.filter((n) => !isSystemSecret(n)).map((n) => { const s = vault.get(n); return { name: n, ...(s?.scope ? { scope: s.scope } : {}) }; }),
    profiles: t.profiles ?? [],
  });
  const viewOf = (t: Template): TemplateView => {
    const approved = approvedOf(t.name);
    return templateView(t, approved, rateTemplate(scopeOfTemplate(t), approved, rules()));
  };
  const keyOf = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
  const declares = (t: Template, p: OperationProfile): boolean => (t.profiles ?? []).some((x) => keyOf(x) === keyOf(p));
  const approveIn = async (t: Template, p: OperationProfile, by: string): Promise<void> => {
    await o.access!.approve(t.name, p, by);
    events.append({ type: 'template.profile_approved', data: { template: t.name, operation: p.operation, asset: p.asset, level: highRadius(p) ? 'high' : 'low', by } });
  };
  const noAccess = (): VaultResult => fail('unavailable', 'access is not part of this hopper: no operation profile can be approved');

  return {
    view: () => ({
      secrets: vault.list().filter((s) => !isSystemSecret(s.name)), templates: vault.templates().map(viewOf), backends: (o.backends?.() ?? []).map(backendView),
      ...(sealer ? {} : { problem: unavailable() }),
    }),

    set(s, by) {
      const { name, scope, mints } = s;
      if (!VAULT_SECRET_NAME.test(name)) return fail('invalid', 'name must be a letter, then letters, digits, `_`, `.` or `-`, at most 64');
      const said = scope?.trim();
      if (said !== undefined && (said.length > VAULT_SCOPE_MAX || /[\n\r]/.test(said))) return fail('invalid', `scope must be one line of at most ${VAULT_SCOPE_MAX} characters`);
      const mintsProblem = mints ? mintsForProblem(mints) : undefined;
      if (mintsProblem) return fail('invalid', mintsProblem);
      if (mints && vault.templates().some((t) => t.secrets.includes(name))) return fail('invalid', `${name} is in a template's scope: take it out first, since a minting credential is never given out`);
      const at = o.clock.now().toISOString();
      return o.store.tx(() => {
        const was = vault.get(name);
        const kept = keptOf(s, was?.id ?? o.idGen());
        if ('ok' in kept) return kept;
        const scoped = said ? { scope: said } : {};
        const where = kept.backend ? { backend: kept.backend } : {};
        const mintsNow = mints === undefined ? was?.mints : mints ?? undefined;
        const minting = mintsNow ? { mints: { kind: mintsNow.kind, name: mintsNow.name } } : {};
        if (was) {
          const { scope: _old, backend: _was, mints: _mints, ...rest } = was;
          vault.replace({ ...rest, ...(scope === undefined && was.scope ? { scope: was.scope } : scoped), ...where, ...minting, changedBy: by, changedAt: at }, kept.sealed);
        } else {
          vault.add({ id: kept.id, name, ...scoped, ...where, ...minting, setBy: by, createdAt: at, changedBy: by, changedAt: at }, kept.sealed);
        }
        events.append({ type: 'vault.secret_set', data: { name, by, replaced: was !== undefined, ...(kept.backend ? { backend: kept.backend.name } : {}), ...minting } });
        return { ok: true } as const;
      });
    },

    remove(name, by) {
      if (isSystemSecret(name)) return fail('not_found', `the vault holds no secret ${name}`);
      return o.store.tx(() => {
        if (!vault.remove(name)) return fail('not_found', `the vault holds no secret ${name}`);
        events.append({ type: 'vault.secret_removed', data: { name, by } });
        return { ok: true } as const;
      });
    },

    async saveTemplate({ name, image, secrets, profiles }, by) {
      if (!TEMPLATE_NAME.test(name)) return fail('invalid', 'a template name is lowercase letters, digits, `.`, `_` or `-`, at most 64, starting with a letter or digit');
      if (!image.trim() || /\s/.test(image.trim()) || image.length > 300) return fail('invalid', 'image must be an image reference, as `podman run` takes it');
      const scope = [...new Set(secrets)];
      const system = scope.filter(isSystemSecret);
      if (system.length) return fail('invalid', `${system.join(', ')} is in the vault's system scope: the hopper keeps it for its own use, so it is in no template's scope`);
      const missing = scope.filter((n) => !vault.get(n));
      if (missing.length) return fail('invalid', `the vault holds no secret ${missing.join(', ')}`);
      const minting = scope.filter((n) => vault.get(n)?.mints);
      if (minting.length) return fail('invalid', `${minting.join(', ')} is a minting credential: the hopper mints from it and never gives it out, so it is in no template's scope`);
      const problem = (profiles ?? []).map(profileProblem).find((p) => p !== undefined);
      if (problem) return fail('invalid', problem);
      if (profiles?.length && !o.access) return noAccess();
      const was = vault.template(name);
      const declared = profiles ? [...new Map(profiles.map((p) => [keyOf(p), { operation: p.operation, asset: { kind: p.asset.kind, name: p.asset.name } }])).values()] : was?.profiles ?? [];
      o.store.tx(() => {
        vault.saveTemplate({
          name, image: image.trim(), secrets: scope, ...(declared.length ? { profiles: declared } : {}), savedBy: by, savedAt: o.clock.now().toISOString(),
          ...(was?.approval ? { approval: was.approval } : {}),
        });
        events.append({ type: 'template.saved', data: { template: name, image: image.trim(), secrets: scope, profiles: declared, by } });
      });
      // A profile dropped loses its approval: access holds none the template does not declare.
      for (const p of approvedOf(name)) if (!declared.some((d) => keyOf(d) === keyOf(p))) await o.access!.revokeProfile(name, p, by);
      return { ok: true } as const;
    },

    async removeTemplate(name, by) {
      const attached = (o.targets?.() ?? []).filter((m) => m.template === name).map((m) => m.name);
      if (attached.length && vault.template(name)) return fail('conflict', `${name} has boxes attached: ${attached.join(', ')}. Remove them in Machines first`);
      const removed = o.store.tx(() => {
        if (!vault.removeTemplate(name)) return false;
        events.append({ type: 'template.removed', data: { template: name, by } });
        return true;
      });
      if (!removed) return fail('not_found', `no template ${name}`);
      for (const p of approvedOf(name)) await o.access!.revokeProfile(name, p, by);
      return { ok: true } as const;
    },

    async approveTemplate(name, by) {
      const t = vault.template(name);
      if (!t) return fail('not_found', `no template ${name}`);
      const low = viewOf(t).pending.profiles.filter((p) => !highRadius(p));
      if (low.length && !o.access) return noAccess();
      o.store.tx(() => {
        vault.saveTemplate({ ...t, approval: { image: t.image, secrets: [...t.secrets], by, at: o.clock.now().toISOString() } });
        events.append({ type: 'vault.approved', data: { template: name, image: t.image, secrets: t.secrets, by } });
      });
      for (const p of low) await approveIn(t, p, by);
      return { ok: true } as const;
    },

    async revokeTemplate(name, by) {
      const t = vault.template(name);
      if (!t) return fail('not_found', `no template ${name}`);
      if (t.approval) {
        o.store.tx(() => {
          const { approval: _was, ...rest } = t;
          vault.saveTemplate(rest);
          events.append({ type: 'vault.revoked', data: { template: name, by } });
        });
      }
      for (const p of approvedOf(name)) await o.access!.revokeProfile(name, p, by);
      return { ok: true } as const;
    },

    async approveProfile(name, profile, by) {
      const t = vault.template(name);
      if (!t) return fail('not_found', `no template ${name}`);
      if (!declares(t, profile)) return fail('not_found', `${name} declares no profile ${profile.operation} on ${profile.asset.kind} ${profile.asset.name}: add it to the template first`);
      if (!o.access) return noAccess();
      await approveIn(t, profile, by);
      return { ok: true } as const;
    },

    scopeOf,
    boxRadius: (machine) => { const name = scopeOf(machine).template, t = name === undefined ? undefined : vault.template(name); return t ? { name: t.name, radius: viewOf(t).radius } : undefined; },
    boxes: () => (o.targets?.() ?? []).flatMap((m) => (m.template !== undefined && vault.template(m.template) ? [{ machine: m.name, template: m.template }] : [])),

    templateScopes: () => vault.templates().map((t) => ({ name: t.name, scope: scopeOfTemplate(t), rules: rules() })),

    async deliver(ask, machineKey) {
      const box = boxAsk({ ...o, job: (id) => o.store.jobs.get(id), holdsTemplate: (t) => vault.template(t) !== undefined }, ask.token, machineKey);
      const at = o.clock.now().toISOString();
      const refuse = (reason: string, backend?: string): { refused: string } => {
        const { machine: m, job } = box;
        events.append({
          type: 'vault.refused', ...(job ? { jobId: job.id } : {}), ...(m ? { machineId: m.name } : {}),
          data: { name: ask.name, machine: m?.name ?? 'a machine that is gone', ...(m?.template ? { template: m.template } : {}), ...(job ? { job: job.id } : {}), ...(backend ? { backend } : {}), reason },
        });
        return { refused: reason };
      };
      if ('refused' in box) return refuse(box.refused);
      const { machine: m, job } = box;
      if (isSystemSecret(ask.name)) return refuse(await systemReadRefusal(o.access, o.userId ?? '', job.id, ask.name));
      if (vault.get(ask.name)?.mints) return refuse(`${ask.name} is a minting credential: the hopper mints from it and never gives it out`);
      if (!scopeOf(m.name).secrets.includes(ask.name)) return refuse(`${m.template} is not approved for ${ask.name}: a person adds it to the template and approves it`);
      const secret = vault.get(ask.name);
      if (!secret) return refuse(`the vault holds no secret ${ask.name}`);
      const { backend } = secret;
      const r = await valueOf(secret);
      if ('refused' in r) return refuse(r.refused, backend?.name);
      if (backend) {
        // The read took a while: the job must still be at work now.
        const still = o.store.jobs.get(job.id)?.status;
        if (!still || !AT_WORK.includes(still)) return refuse(`the job is not at work (${still ?? 'no such job'}): a vault secret is given only while it runs`, backend.name);
      }
      o.store.tx(() => {
        const now = vault.get(ask.name);
        if (now?.id === secret.id) vault.replace({ ...now, lastUsed: { at, machine: m.name, job: job.id } }, vault.sealed(secret.id) ?? null);
        events.append({ type: 'vault.delivered', jobId: job.id, machineId: m.name, data: { name: ask.name, template: m.template, machine: m.name, job: job.id, ...(backend ? { backend: backend.name } : {}) } });
      });
      return { value: r.value };
    },

    mint: (ask, machineKey, from) => mint(ask, machineKey, from ?? mintFrom),
    mintFrom,

    resealAll() {
      if (!sealer) return 0;
      let n = 0;
      for (const s of vault.list()) {
        if (isSystemSecret(s.name)) continue;
        const sealed = vault.sealed(s.id);
        if (sealed === undefined || sealer.current(sealed)) continue;
        try {
          vault.replace(s, sealer.seal(sealer.open(sealed, vaultContext(s.id)), vaultContext(s.id)));
          n++;
        } catch (e) {
          o.logger.warn(`hopper: vault secret ${s.name}: ${(e as Error).message}`);
        }
      }
      return n;
    },
  };
}

/** A user's vault at start: every secret an older key sealed is sealed again under the current one now, said as a count. */
export function openVault(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'settings'>; userId?: string; access?: VaultAccess; minter?: CredentialMinter; keys: SealerState; clock: Clock;
  logger: { info(line: string): void; warn(line: string): void }; targets: () => ClientTarget[]; holds: (parts: ProxyTokenParts) => boolean;
  backends: () => ConfiguredBackend[];
}): VaultService {
  const vault = createVaultService({ ...o, idGen: randomUUID });
  const n = vault.resealAll();
  if (n > 0) o.logger.info(`hopper: ${n} vault secret(s) sealed again under the current ${MASTER_KEY_VARIABLE}`);
  return vault;
}
