// The vault (issue #558, design.md "The vault"): a user's secrets, set in the UI and never read back, sealed in the
// user's store under the token key (src/secrets/sealer.ts, bound to `vault:<id>/value`). Nothing here logs, answers or
// appends a value: a set or a removal is an event naming the secret and who did it, never what it holds. A template's
// operation profiles (issue #584) are approved in access, the one record of them: a read profile with the template, a
// write, sync or apply profile only by its own explicit approval; a narrowing or a removal revokes what it dropped.
// A minting credential (issue #580) is never delivered: the vault mints short-lived credentials from it (mint.ts).
import { randomUUID } from 'node:crypto';
import type { AttachedMachine } from '../domain/machines.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { SecretUnreadable } from '../secrets/sealer.ts';
import type { Clock, CredentialMinter, UserStore } from '../domain/ports.ts';
import { profileProblem, TEMPLATE_NAME, type Asset, type OperationProfile, type VaultAccess } from '../domain/access.ts';
import { mintsForProblem } from '../domain/minting.ts';
import { boxAsk, clientOf } from './box.ts';
import { createMinting, type MintAsk } from './mint.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS } from '../domain/blast-radius.ts';
import { givesOf, templateView, VAULT_SCOPE_MAX, VAULT_SECRET_NAME, VAULT_VALUE_MAX, type Template, type TemplateView, type VaultView } from '../domain/vault.ts';
import { highRadius, rateTemplate, type TemplateScope } from '../blast-radius/template.ts';
import type { RadiusRules } from '../domain/blast-radius.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { TOKEN_KEY_VARIABLE } from '../secrets/token-box.ts';

/** Where a vault secret is kept: the context it is sealed for. Its id, so a fold into another user keeps it. */
export const vaultContext = (id: string): string => `vault:${id}/value`;

export type VaultResult = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'unavailable'; error: string };

export interface VaultService {
  view(): VaultView;
  /** Sets a secret, or a new value or scope for one: sealed, never kept or answered in clear. */
  /** `mints`: the account or cluster it is a minting credential for (issue #580); null makes it a plain secret again; absent keeps it. */
  set(s: { name: string; scope?: string; value: string; mints?: Asset | null }, by: string): VaultResult;
  remove(name: string, by: string): VaultResult;
  /**
   * Saves a template: its image, scope and operation profiles (absent: the ones it has). A widened scope, a new image or
   * a new profile waits for a person's approval; a profile dropped has its approval revoked.
   */
  saveTemplate(t: { name: string; image: string; secrets: readonly string[]; profiles?: readonly OperationProfile[] }, by: string): Promise<VaultResult>;
  /** Removes a template and revokes every approval access holds for it. */
  removeTemplate(name: string, by: string): Promise<VaultResult>;
  /** A person approves a template as it is now: its image, its whole scope, and every read profile; never a write, sync or apply profile. */
  approveTemplate(name: string, by: string): Promise<VaultResult>;
  /** A person approves one of the template's operation profiles explicitly: the gate for a write, sync or apply profile (issue #584). */
  approveProfile(name: string, profile: OperationProfile, by: string): Promise<VaultResult>;
  /** What a machine's boxes may be given now: its template's approved scope; nothing for a machine of no template. */
  scopeOf(machine: string): { template?: string; secrets: string[] };
  /**
   * A machine's ask (slice 3), already proven to be the machine's (its link's signature): one secret, for the job whose
   * proxy token it shows. The value, or why not; every outcome recorded, never with the value.
   */
  deliver(ask: { name: string; token: string }, machineKey: string): { value: string } | { refused: string };
  /** A machine's ask for a credential minted (issue #580): Access decides first, every time; the minted credential as JSON, or why not. */
  mint(ask: MintAsk, machineKey: string): Promise<{ value: string } | { refused: string }>;
  /** Each template's scope as its rating reads it, with this user's blast-radius rules: what access rates it from (issue #584). */
  templateScopes(): { name: string; scope: TemplateScope; rules: RadiusRules }[];
  /** Seals again, under the current key, every secret an older key sealed. How many it sealed again. */
  resealAll(): number;
}

const fail = (code: 'invalid' | 'not_found' | 'unavailable', error: string): VaultResult => ({ ok: false, code, error });

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
  /** The attached machines now: a client target's key and the template it joined as (its join line named it). */
  targets?: () => AttachedMachine[];
  /** Whether a job's proxy token is one this user's link key gives it (issue #563). */
  holds?: (parts: ProxyTokenParts) => boolean;
}): VaultService {
  const { vault, events } = o.store;
  const { sealer } = o.keys;
  const unavailable = (): string => `the hopper cannot store a vault secret: ${o.keys.problem}`;

  function scopeOf(machine: string): { template?: string; secrets: string[] } {
    const name = clientOf(o.targets, (m) => m.name === machine)?.template;
    const t = name === undefined ? undefined : vault.template(name);
    return { ...(name !== undefined ? { template: name } : {}), secrets: t ? givesOf(t) : [] };
  }

  const approvedOf = (name: string): OperationProfile[] => o.access?.approvedProfiles(name) ?? [];
  const rules = (): RadiusRules => (o.store.settings.getBlastRadius() ?? DEFAULT_BLAST_RADIUS_SETTINGS).rules;
  /** What the rating reads of a template: its secrets' names and scope lines, never a value, and its profiles. */
  const scopeOfTemplate = (t: Template): TemplateScope => ({
    secrets: t.secrets.map((n) => { const s = vault.get(n); return { name: n, ...(s?.scope ? { scope: s.scope } : {}) }; }),
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
    view: () => ({ secrets: vault.list(), templates: vault.templates().map(viewOf), ...(sealer ? {} : { problem: unavailable() }) }),

    set({ name, scope, value, mints }, by) {
      if (!VAULT_SECRET_NAME.test(name)) return fail('invalid', 'name must be a letter, then letters, digits, `_`, `.` or `-`, at most 64');
      if (value.length === 0 || value.length > VAULT_VALUE_MAX) return fail('invalid', `value must be 1 to ${VAULT_VALUE_MAX} characters`);
      const said = scope?.trim();
      if (said !== undefined && (said.length > VAULT_SCOPE_MAX || /[\n\r]/.test(said))) return fail('invalid', `scope must be one line of at most ${VAULT_SCOPE_MAX} characters`);
      const mintsProblem = mints ? mintsForProblem(mints) : undefined;
      if (mintsProblem) return fail('invalid', mintsProblem);
      if (mints && o.store.vault.templates().some((t) => t.secrets.includes(name))) return fail('invalid', `${name} is in a template's scope: take it out first, since a minting credential is never given out`);
      if (!sealer) return fail('unavailable', unavailable());
      const at = o.clock.now().toISOString();
      return o.store.tx(() => {
        const was = vault.get(name);
        const scoped = said ? { scope: said } : {};
        const kept = mints === undefined ? was?.mints : mints ?? undefined;
        const minting = kept ? { mints: { kind: kept.kind, name: kept.name } } : {};
        if (was) {
          const { scope: _old, mints: _mints, ...rest } = was;
          vault.replace({ ...rest, ...(scope === undefined && was.scope ? { scope: was.scope } : scoped), ...minting, changedBy: by, changedAt: at }, sealer.seal(value, vaultContext(was.id)));
        } else {
          const id = o.idGen();
          vault.add({ id, name, ...scoped, ...minting, setBy: by, createdAt: at, changedBy: by, changedAt: at }, sealer.seal(value, vaultContext(id)));
        }
        events.append({ type: 'vault.secret_set', data: { name, by, replaced: was !== undefined, ...minting } });
        return { ok: true } as const;
      });
    },

    remove(name, by) {
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

    async approveProfile(name, profile, by) {
      const t = vault.template(name);
      if (!t) return fail('not_found', `no template ${name}`);
      if (!declares(t, profile)) return fail('not_found', `${name} declares no profile ${profile.operation} on ${profile.asset.kind} ${profile.asset.name}: add it to the template first`);
      if (!o.access) return noAccess();
      await approveIn(t, profile, by);
      return { ok: true } as const;
    },

    scopeOf,

    templateScopes: () => vault.templates().map((t) => ({ name: t.name, scope: scopeOfTemplate(t), rules: rules() })),

    deliver(ask, machineKey) {
      const box = boxAsk({ ...o, job: (id) => o.store.jobs.get(id) }, ask.token, machineKey);
      const at = o.clock.now().toISOString();
      const refuse = (reason: string): { refused: string } => {
        const { machine: m, job } = box;
        events.append({
          type: 'vault.refused', ...(job ? { jobId: job.id } : {}), ...(m ? { machineId: m.name } : {}),
          data: { name: ask.name, machine: m?.name ?? 'a machine that is gone', ...(m?.template ? { template: m.template } : {}), ...(job ? { job: job.id } : {}), reason },
        });
        return { refused: reason };
      };
      if ('refused' in box) return refuse(box.refused);
      const { machine: m, job } = box;
      if (vault.get(ask.name)?.mints) return refuse(`${ask.name} is a minting credential: the hopper mints from it and never gives it out`);
      if (!scopeOf(m.name).secrets.includes(ask.name)) return refuse(`${m.template} is not approved for ${ask.name}: a person adds it to the template and approves it`);
      const secret = vault.get(ask.name);
      if (!secret) return refuse(`the vault holds no secret ${ask.name}`);
      if (!sealer) return refuse(unavailable());
      let value: string;
      try {
        value = sealer.open(vault.sealed(secret.id) ?? '', vaultContext(secret.id));
      } catch (e) {
        if (!(e instanceof SecretUnreadable)) throw e;
        o.logger.warn(`hopper: vault secret ${ask.name}: ${e.message}`);
        return refuse(`the vault secret ${ask.name} cannot be opened: set it again`);
      }
      o.store.tx(() => {
        vault.replace({ ...secret, lastUsed: { at, machine: m.name, job: job.id } }, vault.sealed(secret.id)!);
        events.append({ type: 'vault.delivered', jobId: job.id, machineId: m.name, data: { name: ask.name, template: m.template, machine: m.name, job: job.id } });
      });
      return { value };
    },

    mint: createMinting({
      store: o.store, userId: o.userId ?? '', sealer, unavailable, clock: o.clock, logger: o.logger, context: vaultContext,
      ...(o.access ? { access: o.access } : {}), ...(o.minter ? { minter: o.minter } : {}), ...(o.targets ? { targets: o.targets } : {}), ...(o.holds ? { holds: o.holds } : {}),
    }),

    resealAll() {
      if (!sealer) return 0;
      let n = 0;
      for (const s of vault.list()) {
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
export function openVault(o: { store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'settings'>; userId?: string; access?: VaultAccess; minter?: CredentialMinter; keys: SealerState; clock: Clock; logger: { info(line: string): void; warn(line: string): void }; targets: () => AttachedMachine[]; holds: (parts: ProxyTokenParts) => boolean }): VaultService {
  const vault = createVaultService({ ...o, idGen: randomUUID });
  const n = vault.resealAll();
  if (n > 0) o.logger.info(`hopper: ${n} vault secret(s) sealed again under the current ${TOKEN_KEY_VARIABLE}`);
  return vault;
}
