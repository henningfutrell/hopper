// Config documents a test app reads (design.md "Config documents"): plugins.yaml, webhooks.yaml and
// rules.md, written into the test app's database before it starts, or while it runs.
import { stringify } from 'yaml';
import type { ConfigDocumentName } from '../../src/domain/ports.ts';
import { openStore } from '../../src/store/index.ts';
import { databaseUrlFor } from './database.ts';

export interface WebhookEntry { name: string; url: string; events: string[]; secret?: string; secretEnv?: string; active?: boolean }

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

export function writeWebhooksFile(dbPath: string, webhooks: WebhookEntry[]): void {
  writeDocument(dbPath, 'webhooks.yaml', { version: 1, webhooks });
}
