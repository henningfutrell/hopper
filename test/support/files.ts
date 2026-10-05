// What a test app reads from its database, written before it starts or while it runs: config
// documents (design.md "Config documents") — owner's plugins.yaml and rules.md, the instance's
// auth.yaml — and owner's webhook subscriptions, which are rows (issue #78).
import { stringify } from 'yaml';
import type { ConfigDocumentName, InstanceStore, UserStore } from '../../src/domain/ports.ts';
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

/** Replace a document in the database of `dbPath` (whatever version it is at): auth.yaml the instance's, the others owner's. `doc`: text, or a value written as YAML. */
export function writeDocument(dbPath: string, name: ConfigDocumentName, doc: unknown): void {
  const text = typeof doc === 'string' ? doc : stringify(doc);
  withStores(dbPath, (instance, owner) => {
    if (name === 'auth.yaml') instance.documents.write(name, text, instance.documents.version(name));
    else owner.documents.write(name, text, owner.documents.version(name));
  });
}

/** A document in the database of `dbPath`, or undefined. */
export function readDocument(dbPath: string, name: ConfigDocumentName): string | undefined {
  return withStores(dbPath, (instance, owner) => (name === 'auth.yaml' ? instance.documents.read(name) : owner.documents.read(name)));
}

/** Add webhook subscriptions to owner's store in the database of `dbPath`. */
export function writeWebhooks(dbPath: string, webhooks: WebhookEntry[]): void {
  withStores(dbPath, (_instance, owner) => {
    for (const w of webhooks) owner.webhooks.add({ ...w, active: w.active ?? true });
  });
}
