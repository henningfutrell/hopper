// The vault (issue #558, design.md "The vault"): a user's secrets, set in the UI and never read back, sealed in the
// user's store under the token key (src/secrets/sealer.ts, bound to `vault:<id>/value`). Nothing here logs, answers or
// appends a value: a set or a removal is an event naming the secret and who did it, never what it holds.
import { randomUUID } from 'node:crypto';
import type { AttachedMachine } from '../domain/machines.ts';
import { machineOfLane } from '../domain/raised-by.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import { SecretUnreadable } from '../secrets/sealer.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import { TEMPLATE_NAME } from '../domain/access.ts';
import { templateView, VAULT_SCOPE_MAX, VAULT_SECRET_NAME, VAULT_VALUE_MAX, type VaultView } from '../domain/vault.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { TOKEN_KEY_VARIABLE } from '../secrets/token-box.ts';
import { createCredentialRequests, type Asker, type CredentialAsk, type Give, type NeedAnswer } from './requests.ts';

/** Where a vault secret is kept: the context it is sealed for. Its id, so a fold into another user keeps it. */
export const vaultContext = (id: string): string => `vault:${id}/value`;

export type VaultResult = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'unavailable'; error: string };

export interface VaultService {
  view(): VaultView;
  /** Sets a secret, or a new value or scope for one: sealed, never kept or answered in clear. */
  set(s: { name: string; scope?: string; value: string }, by: string): VaultResult;
  remove(name: string, by: string): VaultResult;
  /** Saves a template: its image and scope. A widened scope or a new image waits for a person's approval. */
  saveTemplate(t: { name: string; image: string; secrets: readonly string[] }, by: string): VaultResult;
  removeTemplate(name: string, by: string): VaultResult;
  /** A person approves a template as it is now: its image and its whole scope. */
  approveTemplate(name: string, by: string): VaultResult;
  /** What a machine's boxes may be given now: its template's approved scope; nothing for a machine of no template. */
  scopeOf(machine: string): { template?: string; secrets: string[] };
  /**
   * A machine's ask (slice 3), already proven to be the machine's (its link's signature): one secret, for the job whose
   * proxy token it shows. The value, or why not; every outcome recorded, never with the value.
   */
  deliver(ask: { name: string; token: string }, machineKey: string): { value: string } | { refused: string };
  /**
   * A job on a box loaded a skill whose credential its template does not give (issue #583, the skill broker proved who
   * asks): a person is asked — a credential request, opened or joined — or the job is told they declined.
   */
  need(ask: CredentialAsk, asker: Asker): NeedAnswer;
  /** A person gives a credential for a request: a vault secret, added to its template's scope. */
  give(id: string, g: Give, by: string): VaultResult;
  /** A person declines a request: each job that waits on it is told why. */
  decline(id: string, reason: string, by: string): VaultResult;
  /** Seals again, under the current key, every secret an older key sealed. How many it sealed again. */
  resealAll(): number;
}

/** The statuses a job is given vault secrets in: it holds its pane. Ended, failed or parked: nothing. */
const AT_WORK = ['running', 'waiting_answer'];

const fail = (code: 'invalid' | 'not_found' | 'unavailable', error: string): VaultResult => ({ ok: false, code, error });

export function createVaultService(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>;
  keys: SealerState;
  clock: Clock;
  idGen: () => string;
  logger: { warn(line: string): void };
  /** The attached machines now: a client target's key and the template it joined as (its join line named it). */
  targets?: () => AttachedMachine[];
  /** Whether a job's proxy token is one this user's link key gives it (issue #563). */
  holds?: (parts: ProxyTokenParts) => boolean;
}): VaultService {
  const clientOf = (match: (m: { name: string; key: string }) => boolean) =>
    (o.targets?.() ?? []).flatMap((m) => ('client' in m && match({ name: m.name, key: m.client.key }) ? [{ name: m.name, template: m.client.template }] : []))[0];
  const { vault, events } = o.store;
  const { sealer } = o.keys;
  const unavailable = (): string => `the hopper cannot store a vault secret: ${o.keys.problem}`;

  function scopeOf(machine: string): { template?: string; secrets: string[] } {
    const name = clientOf((m) => m.name === machine)?.template;
    const t = name === undefined ? undefined : vault.template(name);
    return { ...(name !== undefined ? { template: name } : {}), secrets: t ? templateView(t).gives : [] };
  }

  const requests = createCredentialRequests({ store: o.store, clock: o.clock, idGen: o.idGen, set: (x, by) => service.set(x, by) });

  const service: VaultService = {
    view: () => ({ secrets: vault.list(), templates: vault.templates().map(templateView), requests: requests.list(), ...(sealer ? {} : { problem: unavailable() }) }),

    set({ name, scope, value }, by) {
      if (!VAULT_SECRET_NAME.test(name)) return fail('invalid', 'name must be a letter, then letters, digits, `_`, `.` or `-`, at most 64');
      if (value.length === 0 || value.length > VAULT_VALUE_MAX) return fail('invalid', `value must be 1 to ${VAULT_VALUE_MAX} characters`);
      const said = scope?.trim();
      if (said !== undefined && (said.length > VAULT_SCOPE_MAX || /[\n\r]/.test(said))) return fail('invalid', `scope must be one line of at most ${VAULT_SCOPE_MAX} characters`);
      if (!sealer) return fail('unavailable', unavailable());
      const at = o.clock.now().toISOString();
      return o.store.tx(() => {
        const was = vault.get(name);
        const scoped = said ? { scope: said } : {};
        if (was) {
          const { scope: _old, ...rest } = was;
          vault.replace({ ...rest, ...(scope === undefined && was.scope ? { scope: was.scope } : scoped), changedBy: by, changedAt: at }, sealer.seal(value, vaultContext(was.id)));
        } else {
          const id = o.idGen();
          vault.add({ id, name, ...scoped, setBy: by, createdAt: at, changedBy: by, changedAt: at }, sealer.seal(value, vaultContext(id)));
        }
        events.append({ type: 'vault.secret_set', data: { name, by, replaced: was !== undefined } });
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

    saveTemplate({ name, image, secrets }, by) {
      if (!TEMPLATE_NAME.test(name)) return fail('invalid', 'a template name is lowercase letters, digits, `.`, `_` or `-`, at most 64, starting with a letter or digit');
      if (!image.trim() || /\s/.test(image.trim()) || image.length > 300) return fail('invalid', 'image must be an image reference, as `podman run` takes it');
      const scope = [...new Set(secrets)];
      const missing = scope.filter((n) => !vault.get(n));
      if (missing.length) return fail('invalid', `the vault holds no secret ${missing.join(', ')}`);
      return o.store.tx(() => {
        const was = vault.template(name);
        vault.saveTemplate({ name, image: image.trim(), secrets: scope, savedBy: by, savedAt: o.clock.now().toISOString(), ...(was?.approval ? { approval: was.approval } : {}) });
        events.append({ type: 'template.saved', data: { template: name, image: image.trim(), secrets: scope, by } });
        return { ok: true } as const;
      });
    },

    removeTemplate(name, by) {
      return o.store.tx(() => {
        if (!vault.removeTemplate(name)) return fail('not_found', `no template ${name}`);
        events.append({ type: 'template.removed', data: { template: name, by } });
        return { ok: true } as const;
      });
    },

    approveTemplate(name, by) {
      return o.store.tx(() => {
        const t = vault.template(name);
        if (!t) return fail('not_found', `no template ${name}`);
        vault.saveTemplate({ ...t, approval: { image: t.image, secrets: [...t.secrets], by, at: o.clock.now().toISOString() } });
        events.append({ type: 'vault.approved', data: { template: name, image: t.image, secrets: t.secrets, by } });
        return { ok: true } as const;
      });
    },

    scopeOf,

    need: (ask, asker) => requests.need(ask, asker),
    give: (id, g, by) => (sealer || g.value === undefined ? requests.give(id, g, by) : fail('unavailable', unavailable())),
    decline: (id, reason, by) => requests.decline(id, reason, by),

    deliver(ask, machineKey) {
      const m = clientOf((x) => x.key === machineKey);
      const parts = parseProxyToken(ask.token);
      const job = parts && parts.userId !== undefined ? o.store.jobs.get(parts.jobId) : undefined;
      const at = o.clock.now().toISOString();
      const machine = m?.name ?? 'a machine that is gone';
      const refuse = (reason: string): { refused: string } => {
        events.append({
          type: 'vault.refused', ...(job ? { jobId: job.id } : {}), ...(m ? { machineId: m.name } : {}),
          data: { name: ask.name, machine, ...(m?.template ? { template: m.template } : {}), ...(job ? { job: job.id } : {}), reason },
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
        events.append({ type: 'vault.delivered', jobId: job.id, machineId: m.name, data: { name: ask.name, template: m.template!, machine: m.name, job: job.id } });
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
  return service;
}

/** A user's vault at start: every secret an older key sealed is sealed again under the current one now, said as a count. */
export function openVault(o: { store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>; keys: SealerState; clock: Clock; logger: { info(line: string): void; warn(line: string): void }; targets: () => AttachedMachine[]; holds: (parts: ProxyTokenParts) => boolean }): VaultService {
  const vault = createVaultService({ ...o, idGen: randomUUID });
  const n = vault.resealAll();
  if (n > 0) o.logger.info(`hopper: ${n} vault secret(s) sealed again under the current ${TOKEN_KEY_VARIABLE}`);
  return vault;
}
