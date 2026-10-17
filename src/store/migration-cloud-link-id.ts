// Migration 45 (issue #465): the cloud link's `installId` is the instance id, so a link again is the same instance at
// hopper.io. A record from before took a random id at its link; it takes the instance id, made here when there is none.
import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';

/** Migration 45: a `cloudLink` record from before takes the instance id. No record: nothing changes. */
export function cloudLinkInstanceId(db: Db): void {
  const row = db.get("SELECT value FROM settings WHERE key = 'cloudLink'");
  if (!row) return;
  db.run("INSERT INTO settings (key, value) VALUES ('instanceId', ?) ON CONFLICT (key) DO NOTHING", randomBytes(8).toString('hex'));
  const instanceId = String(db.get("SELECT value FROM settings WHERE key = 'instanceId'")!.value);
  db.run("UPDATE settings SET value = ? WHERE key = 'cloudLink'", JSON.stringify({ ...JSON.parse(String(row.value)) as object, installId: instanceId }));
}
