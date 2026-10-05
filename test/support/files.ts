// What a test app reads from its database, written before it starts or while it runs: config
// documents (design.md "Config documents") — plugins.yaml, rules.md, auth.yaml — and webhook
// subscriptions, which are rows (issue #78).
import { stringify } from 'yaml';
import type { ConfigDocumentName } from '../../src/domain/ports.ts';
import { openStore } from '../../src/store/index.ts';
import { databaseUrlFor } from './database.ts';

export interface WebhookEntry { name: string; url: string; events: string[]; secretEnv: string; active?: boolean }

/** Replace a document in the database of `dbPath` (whatever version it is at). `doc`: text, or a value written as YAML. */
export function writeDocument(dbPath: string, name: ConfigDocumentName, doc: unknown): void {
  const store = openStore({ url: databaseUrlFor(dbPath), clock: { now: () => new Date() } });
  try {
    store.documents.write(name, typeof doc === 'string' ? doc : stringify(doc), store.documents.version(name));
  } finally {
    store.close();
  }
}

/** A document in the database of `dbPath`, or undefined. */
export function readDocument(dbPath: string, name: ConfigDocumentName): string | undefined {
  const store = openStore({ url: databaseUrlFor(dbPath), clock: { now: () => new Date() } });
  try {
    return store.documents.read(name);
  } finally {
    store.close();
  }
}

/** Add webhook subscriptions to the database of `dbPath`. */
export function writeWebhooks(dbPath: string, webhooks: WebhookEntry[]): void {
  const store = openStore({ url: databaseUrlFor(dbPath), clock: { now: () => new Date() } });
  try {
    for (const w of webhooks) store.webhooks.add({ ...w, active: w.active ?? true });
  } finally {
    store.close();
  }
}
