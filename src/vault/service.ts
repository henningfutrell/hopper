// The vault (issue #558, design.md "The vault"): a user's secrets, set in the UI and never read back, sealed in the
// user's store under the token key (src/secrets/sealer.ts, bound to `vault:<id>/value`). Nothing here logs, answers or
// appends a value: a set or a removal is an event naming the secret and who did it, never what it holds.
import { randomUUID } from 'node:crypto';
import type { Clock, UserStore } from '../domain/ports.ts';
import { BOX_TEMPLATE_NAME, templateView, VAULT_SCOPE_MAX, VAULT_SECRET_NAME, VAULT_VALUE_MAX, type VaultView } from '../domain/vault.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { TOKEN_KEY_VARIABLE } from '../secrets/token-box.ts';

/** Where a vault secret is kept: the context it is sealed for. Its id, so a fold into another user keeps it. */
export const vaultContext = (id: string): string => `vault:${id}/value`;

export type VaultResult = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'unavailable'; error: string };

export interface VaultService {
  view(): VaultView;
  /** Sets a secret, or a new value or scope for one: sealed, never kept or answered in clear. */
  set(s: { name: string; scope?: string; value: string }, by: string): VaultResult;
  remove(name: string, by: string): VaultResult;
  /** Saves a box template: its image and scope. A widened scope or a new image waits for a person's approval. */
  saveTemplate(t: { name: string; image: string; secrets: readonly string[] }, by: string): VaultResult;
  removeTemplate(name: string, by: string): VaultResult;
  /** A person approves a box template as it is now: its image and its whole scope. */
  approveTemplate(name: string, by: string): VaultResult;
  /** What a machine's boxes may be given now: its template's approved scope; nothing for a machine of no template. */
  scopeOf(machine: string): { template?: string; secrets: string[] };
  /** Seals again, under the current key, every secret an older key sealed. How many it sealed again. */
  resealAll(): number;
}

const fail = (code: 'invalid' | 'not_found' | 'unavailable', error: string): VaultResult => ({ ok: false, code, error });

export function createVaultService(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx'>;
  keys: SealerState;
  clock: Clock;
  idGen: () => string;
  logger: { warn(line: string): void };
  /** The box template a machine joined as (its join line named it); undefined for a machine of none. */
  templateOf?: (machine: string) => string | undefined;
}): VaultService {
  const { vault, events } = o.store;
  const { sealer } = o.keys;
  const unavailable = (): string => `the hopper cannot store a vault secret: ${o.keys.problem}`;

  return {
    view: () => ({ secrets: vault.list(), templates: vault.templates().map(templateView), ...(sealer ? {} : { problem: unavailable() }) }),

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
      if (!BOX_TEMPLATE_NAME.test(name)) return fail('invalid', 'a template name is letters, digits, `_` or `-`, at most 40, starting with a letter or digit');
      if (!image.trim() || /\s/.test(image.trim()) || image.length > 300) return fail('invalid', 'image must be an image reference, as `podman run` takes it');
      const scope = [...new Set(secrets)];
      const missing = scope.filter((n) => !vault.get(n));
      if (missing.length) return fail('invalid', `the vault holds no secret ${missing.join(', ')}`);
      return o.store.tx(() => {
        const was = vault.template(name);
        vault.saveTemplate({ name, image: image.trim(), secrets: scope, savedBy: by, savedAt: o.clock.now().toISOString(), ...(was?.approval ? { approval: was.approval } : {}) });
        events.append({ type: 'box_template.saved', data: { template: name, image: image.trim(), secrets: scope, by } });
        return { ok: true } as const;
      });
    },

    removeTemplate(name, by) {
      return o.store.tx(() => {
        if (!vault.removeTemplate(name)) return fail('not_found', `no box template ${name}`);
        events.append({ type: 'box_template.removed', data: { template: name, by } });
        return { ok: true } as const;
      });
    },

    approveTemplate(name, by) {
      return o.store.tx(() => {
        const t = vault.template(name);
        if (!t) return fail('not_found', `no box template ${name}`);
        vault.saveTemplate({ ...t, approval: { image: t.image, secrets: [...t.secrets], by, at: o.clock.now().toISOString() } });
        events.append({ type: 'vault.approved', data: { template: name, image: t.image, secrets: t.secrets, by } });
        return { ok: true } as const;
      });
    },

    scopeOf(machine) {
      const name = o.templateOf?.(machine);
      const t = name === undefined ? undefined : vault.template(name);
      return { ...(name !== undefined ? { template: name } : {}), secrets: t ? templateView(t).gives : [] };
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
export function openVault(o: { store: Pick<UserStore, 'vault' | 'events' | 'tx'>; keys: SealerState; clock: Clock; logger: { info(line: string): void; warn(line: string): void }; templateOf: (machine: string) => string | undefined }): VaultService {
  const vault = createVaultService({ ...o, idGen: randomUUID });
  const n = vault.resealAll();
  if (n > 0) o.logger.info(`hopper: ${n} vault secret(s) sealed again under the current ${TOKEN_KEY_VARIABLE}`);
  return vault;
}
