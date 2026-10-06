// Instance migration 21 (issue #220, design.md "Users: one hopper, separate users"): the built-in user
// `owner` becomes the default admin account, `admin`. Everything owner held moves to it whole — the user
// schema (renamed: every table, sequence and index goes with it), its identity links, UI sessions and
// login codes, its work dir and its secret prefix — and the user `owner` is gone. A user already called
// `admin`, by id or by name, moves aside first with its work. UI sessions and login codes keep no
// default user: each names its own.
import type { Db } from './db.ts';
import { quoteIdent, userSchemaName } from './tenant-migrations.ts';

const OWNER = 'owner';
const ADMIN = 'admin';

/** The first of `base_2`, `base_3`, … in no row of `column`, compared without case. */
function free(db: Db, column: 'id' | 'name', base: string, sep: string): string {
  const taken = new Set(db.all(`SELECT ${column} AS v FROM users`).map((r) => String(r.v).toLowerCase()));
  for (let n = 2; ; n++) if (!taken.has(`${base}${sep}${n}`.toLowerCase())) return `${base}${sep}${n}`;
}

/** Give the user `from` the id `to`: its row (keeping its place, name, work dir and secret prefix), its references and its schema. */
function renameUser(db: Db, instance: string, from: string, to: string): void {
  db.run('UPDATE users SET id = ? WHERE id = ?', to, from);
  for (const table of ['user_identities', 'ui_sessions', 'login_codes']) db.run(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, to, from);
  db.exec(`ALTER SCHEMA ${quoteIdent(userSchemaName(instance, from))} RENAME TO ${quoteIdent(userSchemaName(instance, to))}`);
}

/** Migration 21. The identity links' foreign key is dropped while ids change, and comes back. */
export function ownerToAdmin(db: Db): void {
  db.exec(`
    ALTER TABLE ui_sessions ALTER COLUMN user_id DROP DEFAULT;
    ALTER TABLE login_codes ALTER COLUMN user_id DROP DEFAULT;
  `);
  if (!db.get('SELECT 1 FROM users WHERE id = ?', OWNER)) return;
  const instance = String(db.get('SELECT current_schema() AS s')!.s);
  db.exec('ALTER TABLE user_identities DROP CONSTRAINT user_identities_user_id_fkey');
  if (db.get('SELECT 1 FROM users WHERE id = ?', ADMIN)) renameUser(db, instance, ADMIN, free(db, 'id', ADMIN, '_'));
  const named = db.get('SELECT id, name FROM users WHERE lower(name) = ? AND id <> ?', ADMIN, OWNER);
  if (named) db.run('UPDATE users SET name = ? WHERE id = ?', free(db, 'name', String(named.name), ' '), String(named.id));
  renameUser(db, instance, OWNER, ADMIN);
  db.run('UPDATE users SET name = ? WHERE id = ? AND lower(name) = ?', ADMIN, ADMIN, OWNER);
  db.exec('ALTER TABLE user_identities ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)');
}
