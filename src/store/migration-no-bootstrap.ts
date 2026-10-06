// Instance migration 24 (issue #238, design.md "No bootstrap login"): no bootstrap user. A new store
// ends with no user at all: the default admin account migrations 17 and 21 make on the way is dropped
// with its user schema, which holds nothing yet. The first sign-in makes the first user. An install from
// before keeps `admin` and everything it holds; no sign-in, which signed in as `admin` there, is linked to
// it, so it still does.
import type { Db } from './db.ts';
import { quoteIdent, userSchemaName } from './tenant-migrations.ts';

const ADMIN = 'admin';
/** No sign-in's identity (src/auth NO_SIGN_IN_IDENTITY): realm and subject. */
const NO_SIGN_IN = ['none', 'anonymous'] as const;

/** Migration 24. `from`: the version the store had when this migration run began (0: a new store). */
export function noBootstrapUser(db: Db, from: number): void {
  if (!db.get('SELECT 1 FROM users WHERE id = ?', ADMIN)) return;
  if (from === 0) {
    const instance = String(db.get('SELECT current_schema() AS s')!.s);
    db.run('DELETE FROM users WHERE id = ?', ADMIN);
    db.exec(`DROP SCHEMA ${quoteIdent(userSchemaName(instance, ADMIN))} CASCADE`);
    return;
  }
  db.run('INSERT INTO user_identities (realm, subject, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', ...NO_SIGN_IN, ADMIN);
}
