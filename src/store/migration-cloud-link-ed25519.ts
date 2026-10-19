// Migration 52 (issue #2039): the cloud link key is Ed25519, so it signs hopper.io's challenge. A key from before is
// X25519, which cannot sign, and no connection ever used it: the link record drops it. The next mint (Rotate key) replaces
// the vault's row, and the build before reads a record with no key as one from before the key (issue #467 part 2).
import type { Db } from './db.ts';

/** Migration 52: a `cloudLink` record drops its `linkKey`. No record, or no key: nothing changes. */
export function cloudLinkEd25519(db: Db): void {
  const row = db.get("SELECT value FROM settings WHERE key = 'cloudLink'");
  if (!row) return;
  const { linkKey, ...link } = JSON.parse(String(row.value)) as { linkKey?: unknown };
  if (linkKey !== undefined) db.run("UPDATE settings SET value = ? WHERE key = 'cloudLink'", JSON.stringify(link));
}
