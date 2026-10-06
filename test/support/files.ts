// What a test app reads from its database, written before it starts or while it runs: config
// records (design.md "Config in the database") — owner's plugins and rules, the instance's sign-in —
// and owner's webhook subscriptions, which are rows (issue #78).
import type { ConfigName, InstanceStore, UserStore } from '../../src/domain/ports.ts';
import { OWNER_ID } from '../../src/domain/types.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { databaseUrlFor } from './database.ts';

export interface WebhookEntry { name: string; url: string; events: string[]; secretEnv: string; active?: boolean }

/** Run `fn` with the instance store of `dbPath`'s database and a user's store (default owner), closing both after. */
export function withStores<T>(dbPath: string, fn: (instance: InstanceStore, user: UserStore) => T, userId = OWNER_ID): T {
  const instance = openInstanceStore({ url: databaseUrlFor(dbPath), clock: { now: () => new Date() } });
  try {
    const user = instance.userStore(instance.users.get(userId) ?? instance.users.owner());
    try {
      return fn(instance, user);
    } finally {
      user.close();
    }
  } finally {
    instance.close();
  }
}

/** Replace a config record in the database of `dbPath` (whatever version it is at): sign-in the instance's, the others owner's. */
export function writeConfig(dbPath: string, name: ConfigName, value: unknown): void {
  withStores(dbPath, (instance, owner) => {
    if (name === 'sign-in') instance.config.write(name, value, instance.config.version(name));
    else owner.config.write(name, value, owner.config.version(name));
  });
}

/** A config record in the database of `dbPath`, or undefined. */
export function readConfig(dbPath: string, name: ConfigName): unknown {
  return withStores(dbPath, (instance, owner) => (name === 'sign-in' ? instance.config.read(name) : owner.config.read(name)));
}

/** Add webhook subscriptions to owner's store in the database of `dbPath`. */
export function writeWebhooks(dbPath: string, webhooks: WebhookEntry[]): void {
  withStores(dbPath, (_instance, owner) => {
    for (const w of webhooks) owner.webhooks.add({ ...w, active: w.active ?? true });
  });
}

/** Owner's store in the database `url` names (its instance store closed with it). */
export function openOwnerStore(url: string): UserStore {
  const instance = openInstanceStore({ url, clock: { now: () => new Date() } });
  const owner = instance.userStore(instance.users.owner());
  return { ...owner, close: () => { owner.close(); instance.close(); } };
}
