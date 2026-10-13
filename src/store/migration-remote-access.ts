// Migration 39 (issue #968): remote access names its provider. A record from before is ngrok's.
import type { Db } from './db.ts';

/** Migration 39: a `remoteAccess` record from before issue #968 is ngrok's, its domain the one its tunnel runs at. */
export function remoteAccessProvider(db: Db): void {
  const row = db.get("SELECT value FROM settings WHERE key = 'remoteAccess'");
  if (!row) return;
  const before = JSON.parse(String(row.value)) as { enabled?: boolean; provider?: string; domain?: string; restartedAt?: string };
  if (before.provider !== undefined) return;
  const after = { ...before, provider: 'ngrok', ...(before.domain ? { provisioned: { provider: 'ngrok', domain: before.domain } } : {}) };
  db.run("UPDATE settings SET value = ? WHERE key = 'remoteAccess'", JSON.stringify(after));
}
