// The vault (issue #558, design.md "The vault"): a user's secrets, set in the UI and never read back, sealed in the
// user's store under the token key (src/secrets/sealer.ts, bound to `vault:<id>/value`). Nothing here logs, answers or
// appends a value: a set or a removal is an event naming the secret and who did it, never what it holds. A template's
// operation profiles (issue #584) are approved in access, the one record of them: a read profile with the template, a
// write, sync or apply profile only by its own explicit approval; a narrowing or a removal revokes what it dropped.
// A secret may instead be kept in a vault backend (issue #585): the hopper keeps only where, and reads it there at delivery.
import { randomUUID } from 'node:crypto';
import type { AttachedMachine } from '../domain/machines.ts';
import { machineOfLane } from '../domain/raised-by.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import { SecretUnreadable } from '../secrets/sealer.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import { profileProblem, TEMPLATE_NAME, type OperationProfile, type TemplateApprovals } from '../domain/access.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS } from '../domain/blast-radius.ts';
import { givesOf, templateView, VAULT_REFERENCE_MAX, VAULT_SCOPE_MAX, VAULT_SECRET_NAME, VAULT_VALUE_MAX, type ConfiguredBackend, type Template, type TemplateView, type VaultBackendView, type VaultSecret, type VaultView } from '../domain/vault.ts';
import { highRadius, rateTemplate, type TemplateScope } from '../blast-radius/template.ts';
import type { RadiusRules } from '../domain/blast-radius.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { TOKEN_KEY_VARIABLE } from '../secrets/token-box.ts';

/** Where a vault secret is kept: the context it is sealed for. Its id, so a fold into another user keeps it. */
export const vaultContext = (id: string): string => `vault:${id}/value`;

export type VaultResult = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'unavailable'; error: string };

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
  /** Removes a template and revokes every approval access holds for it. */
  removeTemplate(name: string, by: string): Promise<VaultResult>;
  /** A person approves a template as it is now: its image, its whole scope, and every read profile; never a write, sync or apply profile. */
  approveTemplate(name: string, by: string): Promise<VaultResult>;
  /** A person approves one of the template's operation profiles explicitly: the gate for a write, sync or apply profile (issue #584). */
  approveProfile(name: string, profile: OperationProfile, by: string): Promise<VaultResult>;
  /** What a machine's boxes may be given now: its template's approved scope; nothing for a machine of no template. */
  scopeOf(machine: string): { template?: string; secrets: string[] };
  /** Each attached machine that joined as a box of a template, and that template: what Access writes as an instance (issue #581). */
  boxes(): { machine: string; template: string }[];
  /**
   * A machine's ask (slice 3), already proven to be the machine's (its link's signature): one secret, for the job whose
   * proxy token it shows. The value, or why not; every outcome recorded, never with the value.
   */
  deliver(ask: { name: string; token: string }, machineKey: string): Promise<{ value: string } | { refused: string }>;
  /** Each template's scope as its rating reads it, with this user's blast-radius rules: what access rates it from (issue #584). */
  templateScopes(): { name: string; scope: TemplateScope; rules: RadiusRules }[];
  /** Seals again, under the current key, every secret an older key sealed. How many it sealed again. */
  resealAll(): number;
}

/** A secret to set: its value, or (issue #585) the vault backend that keeps it and where. */
export type SetSecret = { name: string; scope?: string } & ({ value: string } | { backend: string; reference: string });

/** The statuses a job is given vault secrets in: it holds its pane. Ended, failed or parked: nothing. */
const AT_WORK = ['running', 'waiting_answer'];

const fail = (code: 'invalid' | 'not_found' | 'unavailable', error: string): VaultResult => ({ ok: false, code, error });

export function createVaultService(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'settings'>;
  keys: SealerState;
  clock: Clock;
  idGen: () => string;
  /** Access, where a template's operation profiles are approved (issue #584). Absent: no profile can be approved. */
  access?: TemplateApprovals;
  logger: { warn(line: string): void };
  /** The attached machines now: a client target's key and the template it joined as (its join line named it). */
  targets?: () => AttachedMachine[];
  /** Whether a job's proxy token is one this user's link key gives it (issue #563). */
  holds?: (parts: ProxyTokenParts) => boolean;
  /** The vault backends the plugins config names now (issue #585); none when absent. */
  backends?: () => ConfiguredBackend[];
}): VaultService {
  const clientOf = (match: (m: { name: string; key: string }) => boolean) =>
    (o.targets?.() ?? []).flatMap((m) => ('client' in m && match({ name: m.name, key: m.client.key }) ? [{ name: m.name, template: m.client.template }] : []))[0];
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

  function scopeOf(machine: string): { template?: string; secrets: string[] } {
    const name = clientOf((m) => m.name === machine)?.template;
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
    view: () => ({
      secrets: vault.list(), templates: vault.templates().map(viewOf), backends: (o.backends?.() ?? []).map(backendView),
      ...(sealer ? {} : { problem: unavailable() }),
    }),

    set(s, by) {
      const { name, scope } = s;
      if (!VAULT_SECRET_NAME.test(name)) return fail('invalid', 'name must be a letter, then letters, digits, `_`, `.` or `-`, at most 64');
      const said = scope?.trim();
      if (said !== undefined && (said.length > VAULT_SCOPE_MAX || /[\n\r]/.test(said))) return fail('invalid', `scope must be one line of at most ${VAULT_SCOPE_MAX} characters`);
      const at = o.clock.now().toISOString();
      return o.store.tx(() => {
        const was = vault.get(name);
        const kept = keptOf(s, was?.id ?? o.idGen());
        if ('ok' in kept) return kept;
        const scoped = said ? { scope: said } : {};
        const where = kept.backend ? { backend: kept.backend } : {};
        if (was) {
          const { scope: _old, backend: _was, ...rest } = was;
          vault.replace({ ...rest, ...(scope === undefined && was.scope ? { scope: was.scope } : scoped), ...where, changedBy: by, changedAt: at }, kept.sealed);
        } else {
          vault.add({ id: kept.id, name, ...scoped, ...where, setBy: by, createdAt: at, changedBy: by, changedAt: at }, kept.sealed);
        }
        events.append({ type: 'vault.secret_set', data: { name, by, replaced: was !== undefined, ...(kept.backend ? { backend: kept.backend.name } : {}) } });
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
    boxes: () => (o.targets?.() ?? []).flatMap((m) => ('client' in m && m.client.template !== undefined ? [{ machine: m.name, template: m.client.template }] : [])),

    templateScopes: () => vault.templates().map((t) => ({ name: t.name, scope: scopeOfTemplate(t), rules: rules() })),

    async deliver(ask, machineKey) {
      const m = clientOf((x) => x.key === machineKey);
      const parts = parseProxyToken(ask.token);
      const job = parts && parts.userId !== undefined ? o.store.jobs.get(parts.jobId) : undefined;
      const at = o.clock.now().toISOString();
      const machine = m?.name ?? 'a machine that is gone';
      const refuse = (reason: string, backend?: string): { refused: string } => {
        events.append({
          type: 'vault.refused', ...(job ? { jobId: job.id } : {}), ...(m ? { machineId: m.name } : {}),
          data: { name: ask.name, machine, ...(m?.template ? { template: m.template } : {}), ...(job ? { job: job.id } : {}), ...(backend ? { backend } : {}), reason },
        });
        return { refused: reason };
      };
      if (!m) return refuse('no joined machine holds that key');
      if (!parts || !o.holds?.(parts)) return refuse('not a token the hopper gave a job of this user');
      if (!job || !AT_WORK.includes(job.status)) return refuse(`the job is not at work (${job?.status ?? 'no such job'}): a vault secret is given only while it runs`);
      if ((machineOfLane(job.laneId) ?? job.resumeOn) !== m.name) return refuse(`the job does not run on ${m.name}`);
      if (!m.template) return refuse(`${m.name} is no box of a template: only a box joined with a template's line gets vault secrets`);
      if (!scopeOf(m.name).secrets.includes(ask.name)) return refuse(`${m.template} is not approved for ${ask.name}: a person adds it to the template and approves it`);
      const secret = vault.get(ask.name);
      if (!secret) return refuse(`the vault holds no secret ${ask.name}`);
      let value: string;
      const { backend } = secret;
      if (backend) {
        const r = await readBackend({ ...secret, backend });
        if ('refused' in r) return refuse(r.refused, backend.name);
        // The read took a while: the job must still be at work now.
        const still = o.store.jobs.get(job.id)?.status;
        if (!still || !AT_WORK.includes(still)) return refuse(`the job is not at work (${still ?? 'no such job'}): a vault secret is given only while it runs`, backend.name);
        value = r.value;
      } else {
        if (!sealer) return refuse(unavailable());
        try {
          value = sealer.open(vault.sealed(secret.id) ?? '', vaultContext(secret.id));
        } catch (e) {
          if (!(e instanceof SecretUnreadable)) throw e;
          o.logger.warn(`hopper: vault secret ${ask.name}: ${e.message}`);
          return refuse(`the vault secret ${ask.name} cannot be opened: set it again`);
        }
      }
      o.store.tx(() => {
        const now = vault.get(ask.name);
        if (now?.id === secret.id) vault.replace({ ...now, lastUsed: { at, machine: m.name, job: job.id } }, vault.sealed(secret.id) ?? null);
        events.append({ type: 'vault.delivered', jobId: job.id, machineId: m.name, data: { name: ask.name, template: m.template!, machine: m.name, job: job.id, ...(backend ? { backend: backend.name } : {}) } });
      });
      return { value };
    },

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
export function openVault(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'settings'>; access?: TemplateApprovals; keys: SealerState; clock: Clock;
  logger: { info(line: string): void; warn(line: string): void }; targets: () => AttachedMachine[]; holds: (parts: ProxyTokenParts) => boolean;
  backends: () => ConfiguredBackend[];
}): VaultService {
  const vault = createVaultService({ ...o, idGen: randomUUID });
  const n = vault.resealAll();
  if (n > 0) o.logger.info(`hopper: ${n} vault secret(s) sealed again under the current ${TOKEN_KEY_VARIABLE}`);
  return vault;
}
