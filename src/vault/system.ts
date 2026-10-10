// The vault's system scope (issue #657, design.md "The vault's system scope"): secrets the hopper keeps for its own use
// for one user — their TypeSafe API key —, in the vault's table as `system/<name>`, sealed with the hopper's sealer under
// the token key (src/secrets/sealer.ts, bound to `vault:<id>/value`) wherever the vault's own secrets are kept. Only the
// hopper opens one, in its own process, at the moment it uses it. A change is the user's or an admin's, decided by Access
// (OpenFGA) each time; the vault's own operations list none and give none to a job (service.ts). Nothing here logs,
// answers or appends a value: a set or a removal is an event naming the secret and who did it.
import type { Requester, VaultAccess } from '../domain/access.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import { isSystemSecret, systemSecretRow, VAULT_VALUE_MAX, type SystemSecretName } from '../domain/vault.ts';
import { SecretUnreadable, type SealerState } from '../secrets/sealer.ts';
import { vaultContext, type VaultResult } from './service.ts';

/** Who asks to change a system secret: the user signed in, and whether as an admin; `by` names them in the event. */
export interface SystemChanger { userId: string; admin: boolean; by: string }

/** A system secret's metadata: who set it and when. Never its value. */
export interface SystemSecretMeta { setBy: string; setAt: string }

export interface SystemSecrets {
  /** Its value, opened now; undefined when none is stored. Throws SecretUnreadable when one is stored and cannot be opened. */
  open(name: SystemSecretName): string | undefined;
  meta(name: SystemSecretName): SystemSecretMeta | undefined;
  /** Seals and keeps `value`, after Access allows the change. */
  set(name: SystemSecretName, value: string, who: SystemChanger): Promise<SystemResult>;
  /** Removes it, after Access allows the change. */
  remove(name: SystemSecretName, who: SystemChanger): Promise<SystemResult>;
  /** Keeps `value` as the hopper itself (a one-time import at start): no Access ask, since no person asks. */
  keep(name: SystemSecretName, value: string, by: string): SystemResult;
  /** Why none can be stored or opened now (no token key); undefined when one can. */
  problem(): string | undefined;
  /** Seals again, under the current token key, every system secret an older one sealed. How many. */
  resealAll(): number;
}

/** A vault result, or Access refusing the change. */
export type SystemResult = VaultResult | { ok: false; code: 'forbidden'; error: string };

const fail = (code: 'invalid' | 'not_found' | 'forbidden' | 'unavailable', error: string): SystemResult => ({ ok: false, code, error });

export function createSystemSecrets(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx'>;
  /** The hopper's sealer under the token key: the vault's own key provider may be another. */
  keys: SealerState;
  userId: string;
  access?: VaultAccess;
  clock: Clock;
  idGen: () => string;
  logger: { warn(line: string): void };
}): SystemSecrets {
  const { vault, events } = o.store;
  const { sealer } = o.keys;
  const unavailable = (): string => `the hopper cannot store a system secret: ${o.keys.problem}`;

  /** Access's answer for a change; a deny when there is no Access. */
  async function allowed(name: SystemSecretName, who: SystemChanger): Promise<SystemResult> {
    if (!o.access) return fail('unavailable', 'access is not part of this hopper: no system secret can be changed');
    const requester: Requester = { kind: 'user', userId: who.userId };
    const d = await o.access.decideSystemSecret({ requester, owner: o.userId, name, action: 'change', admin: who.admin });
    return d.allowed ? { ok: true } : fail('forbidden', `access refused: ${d.reason}`);
  }

  function keep(name: SystemSecretName, value: string, by: string): SystemResult {
    if (value.length === 0 || value.length > VAULT_VALUE_MAX) return fail('invalid', `the value must be 1 to ${VAULT_VALUE_MAX} characters`);
    if (!sealer) return fail('unavailable', unavailable());
    const row = systemSecretRow(name);
    const at = o.clock.now().toISOString();
    return o.store.tx(() => {
      const was = vault.get(row);
      const id = was?.id ?? o.idGen();
      const sealed = sealer.seal(value, vaultContext(id));
      if (was) vault.replace({ ...was, changedBy: by, changedAt: at }, sealed);
      else vault.add({ id, name: row, setBy: by, createdAt: at, changedBy: by, changedAt: at }, sealed);
      events.append({ type: 'vault.secret_set', data: { name: row, by, replaced: was !== undefined } });
      return { ok: true } as const;
    });
  }

  return {
    open(name) {
      const s = vault.get(systemSecretRow(name));
      if (!s) return undefined;
      if (!sealer) throw new SecretUnreadable(`the ${name} system secret cannot be opened: ${o.keys.problem}`);
      return sealer.open(vault.sealed(s.id) ?? '', vaultContext(s.id));
    },
    meta(name) {
      const s = vault.get(systemSecretRow(name));
      return s ? { setBy: s.changedBy, setAt: s.changedAt } : undefined;
    },
    async set(name, value, who) {
      if (value.length === 0 || value.length > VAULT_VALUE_MAX) return fail('invalid', `the value must be 1 to ${VAULT_VALUE_MAX} characters`);
      const may = await allowed(name, who);
      return may.ok ? keep(name, value, who.by) : may;
    },
    async remove(name, who) {
      const row = systemSecretRow(name);
      if (!vault.get(row)) return fail('not_found', `no ${name} is set`);
      const may = await allowed(name, who);
      if (!may.ok) return may;
      return o.store.tx(() => {
        if (!vault.remove(row)) return fail('not_found', `no ${name} is set`);
        events.append({ type: 'vault.secret_removed', data: { name: row, by: who.by } });
        return { ok: true } as const;
      });
    },
    keep,
    problem: () => (sealer ? undefined : unavailable()),
    resealAll() {
      if (!sealer) return 0;
      let n = 0;
      for (const s of vault.list()) {
        if (!isSystemSecret(s.name)) continue;
        const sealed = vault.sealed(s.id);
        if (sealed === undefined || sealer.current(sealed)) continue;
        try {
          vault.replace(s, sealer.seal(sealer.open(sealed, vaultContext(s.id)), vaultContext(s.id)));
          n++;
        } catch (e) {
          o.logger.warn(`hopper: system secret ${s.name}: ${(e as Error).message}`);
        }
      }
      return n;
    },
  };
}
