// Instance migration 17 (issue #158, design.md "Users: one hopper, separate users"): several users.
// The instance keeps users, identity links, UI sessions, login codes, auth.yaml and its own settings;
// everything else becomes the first user's, `owner`, in a user schema of its own.
import type { Db } from './db.ts';
import { TENANT_BASE_VERSION, TENANT_TABLES, quoteIdent, userSchemaName } from './tenant-migrations.ts';

/** The instance settings; every other key (routerMode) is a user's. */
const INSTANCE_SETTINGS = ['updateChannel', 'autoUpdate', 'pluginInstalls'];

/**
 * Migration 17. The users and their identity links; the user `owner`; its user schema, into which
 * every tenant table moves whole (ALTER TABLE … SET SCHEMA: the table's sequence and indexes move
 * with it, so nothing is copied and seq continues); the user's documents and settings; owner's
 * sessions and login codes; and every identity seen in a stored session linked to owner.
 */
export function usersAndOwner(db: Db): void {
  const instance = String(db.get('SELECT current_schema() AS s')!.s);
  const owner = quoteIdent(userSchemaName(instance, 'owner'));
  db.exec(`
    CREATE TABLE users (seq BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, work_dir TEXT NOT NULL, secret_prefix TEXT NOT NULL);
    CREATE TABLE user_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users (id), PRIMARY KEY (provider, subject));
    CREATE SCHEMA ${owner};
  `);
  db.run("INSERT INTO users (id, name, created_at, work_dir, secret_prefix) VALUES ('owner', 'owner', ?, '', '')", new Date().toISOString());
  for (const table of TENANT_TABLES) db.exec(`ALTER TABLE ${table} SET SCHEMA ${owner}`);
  const keys = INSTANCE_SETTINGS.map((k) => `'${k}'`).join(', ');
  db.exec(`
    CREATE TABLE ${owner}.settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO ${owner}.settings (key, value) SELECT key, value FROM settings WHERE key NOT IN (${keys});
    DELETE FROM settings WHERE key NOT IN (${keys});
    CREATE TABLE ${owner}.config_documents (name TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO ${owner}.config_documents (name, text, updated_at) SELECT name, text, updated_at FROM config_documents WHERE name <> 'auth.yaml';
    DELETE FROM config_documents WHERE name <> 'auth.yaml';
    CREATE TABLE ${owner}.schema_version (version INTEGER NOT NULL);
    INSERT INTO ${owner}.schema_version (version) VALUES (${TENANT_BASE_VERSION});
    ALTER TABLE ui_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
    ALTER TABLE login_codes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
  `);
  for (const r of db.all('SELECT identity FROM ui_sessions')) {
    const who = JSON.parse(String(r.identity)) as { provider?: unknown; subject?: unknown };
    if (typeof who.provider !== 'string' || typeof who.subject !== 'string') continue;
    db.run("INSERT INTO user_identities (provider, subject, user_id) VALUES (?, ?, 'owner') ON CONFLICT DO NOTHING", who.provider, who.subject);
  }
}
