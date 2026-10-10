// The vault's system scope for tests (issue #658): a user's system secrets over their store, sealed under `key` (default
// TEST_KEY), and a connected account kept or read through it, as the hopper keeps one — its row in `connected_accounts`,
// its tokens in the vault.
import { randomBytes } from 'node:crypto';
import { createAtRest } from '../../src/connected-accounts/at-rest.ts';
import type { ConnectedAccount, StoredAccount, UserStore } from '../../src/domain/ports.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createSystemSecrets, type SystemSecrets } from '../../src/vault/system.ts';

/** The master key the tests seal with unless they name another (issue #659: no secret is ever kept in clear). */
export const TEST_KEY = randomBytes(32).toString('hex');
/** What the sealer says without a master key (src/secrets/sealer.ts sealerOf). */
export const NO_KEY_PROBLEM = 'the master key is missing: the hopper is limited until it is given as HOPPER_MASTER_KEY at launch (docs/deploy.md "The master key")';

let n = 0;
/** `key`: the master key (default TEST_KEY); null: none, the hopper limited. */
export function systemOf(s: Pick<UserStore, 'vault' | 'events' | 'tx'>, key: string | null = TEST_KEY, previous: string[] = []): SystemSecrets {
  return createSystemSecrets({
    store: s, keys: key ? { sealer: createSealer(key, previous) } : { problem: NO_KEY_PROBLEM }, userId: 'admin',
    clock: { now: () => new Date() }, idGen: () => `system-${process.pid}-${++n}-${Math.random().toString(36).slice(2)}`, logger: { warn: () => {} },
  });
}

/** Keeps `a` as the hopper does: its row, and its tokens in the vault. */
export function putAccount(s: Pick<UserStore, 'connectedAccounts' | 'vault' | 'events' | 'tx'>, a: ConnectedAccount, key: string = TEST_KEY): void {
  createAtRest(s, systemOf(s, key)).put(a);
}

/** The account with its tokens opened; undefined when none is kept. Throws when its tokens cannot be opened. */
export function accountOf(s: UserStore, key: string = TEST_KEY): ConnectedAccount | undefined {
  const r = createAtRest(s, systemOf(s, key)).read('github');
  if (!r) return undefined;
  if ('unreadable' in r) throw new Error(r.unreadable);
  return r.account;
}

/**
 * A user's store in memory with what a connected account needs: its row, the vault its tokens are kept in, the event
 * log and transactions. `record`: an account kept before the test (its tokens in the vault, under TEST_KEY).
 */
export function memoryAccountStore(record?: ConnectedAccount, extra: Record<string, unknown> = {}) {
  const rows = new Map<string, StoredAccount>();
  const secrets = new Map<string, { secret: VaultSecret; sealed: string | null }>();
  const events: NewEvent[] = [];
  const vault = {
    list: () => [...secrets.values()].map((v) => v.secret),
    get: (name: string) => secrets.get(name)?.secret,
    add: (secret: VaultSecret, sealed: string | null) => { if (secrets.has(secret.name)) return false; secrets.set(secret.name, { secret, sealed }); return true; },
    replace: (secret: VaultSecret, sealed: string | null) => { if (!secrets.has(secret.name)) return false; secrets.set(secret.name, { secret, sealed }); return true; },
    sealed: (id: string) => [...secrets.values()].find((v) => v.secret.id === id)?.sealed ?? undefined,
    remove: (name: string) => secrets.delete(name),
  };
  const store = {
    connectedAccounts: {
      get: (p: string) => rows.get(p),
      put: (a: StoredAccount & { accessToken?: string; refreshToken?: string }) => { const { accessToken: _a, refreshToken: _r, ...row } = a; rows.set(a.provider, row); },
      lockRow: (p: string) => rows.has(p),
      legacyTokens: () => undefined, dropLegacyTokens: () => undefined,
      lock: () => true, unlock: () => undefined,
      delete: (p: string) => rows.delete(p),
    },
    vault, events: { append: (e: NewEvent) => { events.push(e); return e; } },
    tx: <T>(fn: () => T): T => fn(),
    ...extra,
  };
  if (record) putAccount(store as unknown as UserStore, record);
  return { store: store as unknown as UserStore, events, secrets };
}
