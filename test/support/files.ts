// What a test app reads from its database, written before it starts or while it runs: config
// records (design.md "Config in the database") — admin's plugins and rules, the instance's sign-in — and
// admin's webhook subscriptions, which are rows (issue #78).
import type { ConfigName, InstanceStore, StoredSignIn, UserStore } from '../../src/domain/ports.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { databaseUrlFor, installFromBefore } from './database.ts';

export interface WebhookEntry { name: string; url: string; events: string[]; secretEnv: string; active?: boolean }

const userOf = (instance: InstanceStore, id: string) => {
  const user = instance.users.get(id);
  if (!user) throw new Error(`no user ${id} in the test database`);
  return user;
};

/** Run `fn` with the instance store of `dbPath`'s database, closing it after. */
export function withInstance<T>(dbPath: string, fn: (instance: InstanceStore) => T): T {
  const instance = openInstanceStore({ url: databaseUrlFor(dbPath), clock: { now: () => new Date() } });
  try {
    return fn(instance);
  } finally {
    instance.close();
  }
}

/** Run `fn` with the instance store of `dbPath`'s database and a user's store (default admin), closing both after. */
export function withStores<T>(dbPath: string, fn: (instance: InstanceStore, user: UserStore) => T, userId = ADMIN_ID): T {
  const instance = openInstanceStore({ url: databaseUrlFor(dbPath), clock: { now: () => new Date() } });
  try {
    const user = instance.userStore(userOf(instance, userId));
    try {
      return fn(instance, user);
    } finally {
      user.close();
    }
  } finally {
    instance.close();
  }
}

/**
 * Replace a config record in the database of `dbPath` (whatever version it is at): admin's plugins or
 * rules, or the instance's sign-in config.
 */
export function writeConfig(dbPath: string, name: ConfigName, value: unknown): void {
  if (name === 'sign-in') {
    withInstance(dbPath, (instance) => instance.signInConfig.write({ version: 1, realms: [], ...(value as object) } as StoredSignIn, instance.signInConfig.version()));
    return;
  }
  withStores(dbPath, (_instance, admin) => admin.config.write(name, value, admin.config.version(name)));
}

/** A config record in the database of `dbPath`, or undefined. */
export function readConfig(dbPath: string, name: ConfigName): unknown {
  if (name === 'sign-in') return withInstance(dbPath, (instance) => instance.signInConfig.read());
  return withStores(dbPath, (_instance, admin) => admin.config.read(name));
}

/** Add webhook subscriptions to admin's store in the database of `dbPath`. */
export function writeWebhooks(dbPath: string, webhooks: WebhookEntry[]): void {
  withStores(dbPath, (_instance, admin) => {
    for (const w of webhooks) admin.webhooks.add({ ...w, active: w.active ?? true });
  });
}

/** Owner's store in the database `url` names (its instance store closed with it). */
export function openAdminStore(url: string): UserStore {
  const instance = openInstanceStore({ url: installFromBefore(url), clock: { now: () => new Date() } });
  const admin = instance.userStore(userOf(instance, ADMIN_ID));
  return { ...admin, close: () => { admin.close(); instance.close(); } };
}
