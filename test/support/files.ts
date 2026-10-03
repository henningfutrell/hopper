// Config files a test app reads: <dataDir>/webhooks.yaml and <dataDir>/sources.yaml (the paths
// startTestApp points JOB_HOPPER_WEBHOOKS_FILE / JOB_HOPPER_SOURCES_FILE at).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';

export interface WebhookEntry { name: string; url: string; events: string[]; secret: string; active?: boolean }

export function writeWebhooksFile(dbPath: string, webhooks: WebhookEntry[]): string {
  const path = join(dirname(dbPath), 'webhooks.yaml');
  writeFileSync(path, stringify({ version: 1, webhooks }), { mode: 0o600 });
  return path;
}

export function writeSourcesFile(dbPath: string, doc: unknown): string {
  const path = join(dirname(dbPath), 'sources.yaml');
  writeFileSync(path, typeof doc === 'string' ? doc : stringify(doc), { mode: 0o600 });
  return path;
}
