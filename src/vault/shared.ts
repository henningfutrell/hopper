// Shared secrets (issue #718, design.md "Shared secrets"): vault secrets the hopper's admin shares with the agents of
// every user, or of the users named, in place of a copy in each user's vault. Rows of the instance's vault named
// `shared/<name>`, sealed with the hopper's sealer under the master key (bound to `vault:<id>/value`), never in clear:
// without the master key none is kept or opened. Access (OpenFGA, `shared_secret`) decides each change — the hopper's
// admin's alone — and each read, told the readers at each ask. Nothing here logs, answers or appends a value: a set or a
// removal is an event naming the row and who did it.
import { ACCESS_UNAVAILABLE, type SharedSecretAsk, type VaultAccess } from '../domain/access.ts';
import type { Clock, VaultRepository } from '../domain/ports.ts';
import type { NewEvent } from '../domain/types.ts';
import { isSharedSecret, sharedSecretName, sharedSecretRow, VAULT_SCOPE_MAX, VAULT_SECRET_NAME, VAULT_VALUE_MAX, type SharedSecretView, type VaultSecret } from '../domain/vault.ts';
import { SecretUnreadable, type SealerState } from '../secrets/sealer.ts';
import { resealRows, vaultContext } from './reseal.ts';
import type { SystemResult } from './system.ts';

/** Who changes a shared secret: the user signed in, whether as the hopper's admin, and their name for the event. */
export interface SharedChanger { userId: string; admin: boolean; by: string }

/** A shared secret to set: its name (bare, or its row name), its value, what it reaches, and whom it is shared with (absent: every user). */
export interface SetShared { name: string; value: string; scope?: string; readers?: readonly string[] }

export interface SharedSecrets {
  list(): SharedSecretView[];
  /** The shared secret a row name names, as metadata; undefined when the hopper holds none. */
  get(row: string): VaultSecret | undefined;
  set(s: SetShared, who: SharedChanger): Promise<SystemResult>;
  remove(name: string, who: SharedChanger): Promise<SystemResult>;
  /** Whether the job's user may read it now (Access), and its value: or why not. Records nothing: the caller does. */
  read(row: string, userId: string): Promise<{ value: string } | { refused: string }>;
  /** Seals again, under the current master key, every shared secret an older one sealed. How many. */
  resealAll(): number;
}

const fail = (code: 'invalid' | 'not_found' | 'forbidden' | 'unavailable', error: string): SystemResult => ({ ok: false, code, error });
/** A user id as Access names it: OpenFGA takes no space, `:` or `#` in an id. */
const READER = /^[^\s:#]{1,128}$/;
const MAX_READERS = 100;

export function createSharedSecrets(o: {
  store: { vault: Pick<VaultRepository, 'list' | 'get' | 'add' | 'replace' | 'sealed' | 'remove'>; events: { append(e: NewEvent): unknown }; tx<T>(fn: () => T): T };
  /** The hopper's sealer under the master key: shared secrets are never in a vault container or under a KMS's key. */
  keys: SealerState;
  access?: VaultAccess;
  clock: Clock;
  idGen: () => string;
  logger: { warn(line: string): void };
}): SharedSecrets {
  const { vault, events } = o.store;
  const { sealer } = o.keys;
  const unavailable = (): string => `the hopper cannot store a shared secret: ${o.keys.problem}`;

  /** Access's answer, as a result: OpenFGA not asked is `unavailable` (a 503), never a refusal (issue #696). */
  async function decide(ask: SharedSecretAsk): Promise<SystemResult> {
    if (!o.access) return fail('unavailable', 'access is not part of this hopper: no shared secret can be changed or read');
    const d = await o.access.decideSharedSecret(ask);
    if (d.unavailable) return fail('unavailable', `${ACCESS_UNAVAILABLE}: ${d.reason}`);
    return d.allowed ? { ok: true } : fail('forbidden', `access refused: ${d.reason}`);
  }

  const shared = (row: string): VaultSecret | undefined => (isSharedSecret(row) ? vault.get(row) : undefined);
  const view = ({ name, scope, readers, setBy, createdAt, changedBy, changedAt }: VaultSecret): SharedSecretView =>
    ({ name, ...(scope ? { scope } : {}), ...(readers ? { readers } : {}), setBy, createdAt, changedBy, changedAt });

  return {
    list: () => vault.list().filter((s) => isSharedSecret(s.name)).map(view),
    get: shared,

    async set({ name: given, value, scope, readers }, who) {
      const name = sharedSecretName(given);
      if (!VAULT_SECRET_NAME.test(name)) return fail('invalid', 'name must be a letter, then letters, digits, `_`, `.` or `-`, at most 64');
      if (value.length === 0 || value.length > VAULT_VALUE_MAX) return fail('invalid', `value must be 1 to ${VAULT_VALUE_MAX} characters`);
      const said = scope?.trim();
      if (said !== undefined && (said.length > VAULT_SCOPE_MAX || /[\n\r]/.test(said))) return fail('invalid', `scope must be one line of at most ${VAULT_SCOPE_MAX} characters`);
      if (readers && (readers.length === 0 || readers.length > MAX_READERS || readers.some((r) => !READER.test(r)))) {
        return fail('invalid', `readers must be 1 to ${MAX_READERS} user ids, each with no space, \`:\` or \`#\`; leave them out to share with every user`);
      }
      if (!sealer) return fail('unavailable', unavailable());
      const may = await decide({ userId: who.userId, name, action: 'change', admin: who.admin });
      if (!may.ok) return may;
      const row = sharedSecretRow(name);
      const at = o.clock.now().toISOString();
      return o.store.tx(() => {
        const was = vault.get(row);
        const id = was?.id ?? o.idGen();
        const sealed = sealer.seal(value, vaultContext(id));
        const meta = { ...(said ? { scope: said } : {}), ...(readers ? { readers: [...new Set(readers)] } : {}) };
        if (was) {
          const { scope: _s, readers: _r, ...rest } = was;
          vault.replace({ ...rest, ...meta, changedBy: who.by, changedAt: at }, sealed);
        } else {
          vault.add({ id, name: row, ...meta, setBy: who.by, createdAt: at, changedBy: who.by, changedAt: at }, sealed);
        }
        events.append({ type: 'vault.secret_set', data: { name: row, by: who.by, replaced: was !== undefined } });
        return { ok: true } as const;
      });
    },

    async remove(given, who) {
      const row = sharedSecretRow(sharedSecretName(given));
      if (!vault.get(row)) return fail('not_found', `the hopper holds no shared secret ${row}`);
      const may = await decide({ userId: who.userId, name: sharedSecretName(row), action: 'change', admin: who.admin });
      if (!may.ok) return may;
      return o.store.tx(() => {
        if (!vault.remove(row)) return fail('not_found', `the hopper holds no shared secret ${row}`);
        events.append({ type: 'vault.secret_removed', data: { name: row, by: who.by } });
        return { ok: true } as const;
      });
    },

    async read(row, userId) {
      const s = shared(row);
      if (!s) return { refused: `the hopper holds no shared secret ${row}` };
      const may = await decide({ userId, name: sharedSecretName(row), action: 'read', ...(s.readers ? { readers: s.readers } : {}) });
      if (!may.ok) return { refused: may.error };
      if (!sealer) return { refused: unavailable() };
      try {
        return { value: sealer.open(vault.sealed(s.id) ?? '', vaultContext(s.id)) };
      } catch (e) {
        if (!(e instanceof SecretUnreadable)) throw e;
        o.logger.warn(`hopper: shared secret ${row}: ${e.message}`);
        return { refused: `the shared secret ${row} cannot be opened: the hopper's admin sets it again` };
      }
    },

    resealAll: () => resealRows({ vault, sealer, mine: isSharedSecret, what: 'shared secret', logger: o.logger }),
  };
}
