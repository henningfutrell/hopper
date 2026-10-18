// hopper.io's store (issue #463, docs/cloud-hosting-identity.md): Postgres through pg. It keeps only what sign-in
// needs: a **hopper.io account** per GitHub account, keyed by GitHub's numeric user id (never the login, which can be
// renamed), with the login and the avatar URL for display; a **hopper.io session**, only its token's hash; and a
// sign-in under way, only its state's hash and its PKCE verifier, for ten minutes, and the account it is to delete when
// it confirms a deletion; a **hopper.io record** of each act on the account, its kind and time only, for RECORD_MS
// (docs/hopper-io-security.md R6, R5); a **registration** of each instance the account registered, its instance id only;
// with the name its owner gave it and when the instance last said hello, one per instance id (issue #465);
// and a **registration tombstone** per registration a deletion or its owner removed, the instance id and the time only, for
// TOMBSTONE_MS, so the instance learns it at its next hello (cloud/link.ts). No GitHub token is kept. A deleted account
// takes its sessions, records and registrations with it.
// What each column holds, why and for how long is the privacy note (cloud/privacy.ts), column for column.
// Schema changes are migrations, appended to MIGRATIONS: the accounts are the users' saved data.
import { createHash } from 'node:crypto';
import pg from 'pg';

export interface CloudAccount { githubUserId: string; login: string; avatarUrl?: string }

/** How long a hopper.io session lasts. */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a sign-in may stay at GitHub before its state is no longer taken. */
export const SIGN_IN_MS = 10 * 60 * 1000;
/** How long a hopper.io record is kept; then it is deleted. */
export const RECORD_MS = 90 * 24 * 60 * 60 * 1000;
/** How long a registration tombstone is kept; then the instance gets no answer, as one hopper.io never knew. */
export const TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;

/** What a hopper.io record says was done on the account. */
export type RecordKind = 'signed_in' | 'signed_out' | 'deletion_refused'
  | 'instance_registered' | 'instance_renamed' | 'instance_removed' | 'instance_unlinked' | 'instance_moved';
export interface CloudRecord { kind: RecordKind; at: Date }
/** One registration as its account's owner reads it: the name is theirs, the last-seen time the instance's last hello. */
export interface CloudInstance { installId: string; name?: string; registeredAt: Date; seenAt?: Date }
/** The most characters of an instance's name at hopper.io. */
export const INSTANCE_NAME_MAX = 64;

const MIGRATIONS: string[] = [
  `CREATE TABLE account (
     github_user_id bigint PRIMARY KEY, login text NOT NULL, avatar_url text,
     created_at timestamptz NOT NULL DEFAULT now(), seen_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE session (
     token_hash text PRIMARY KEY, account_id bigint NOT NULL REFERENCES account (github_user_id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);
   CREATE INDEX session_account ON session (account_id);
   CREATE TABLE sign_in (state_hash text PRIMARY KEY, verifier text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`,
  // A sign-in that confirms an account deletion names the account (decision 5).
  'ALTER TABLE sign_in ADD COLUMN deletes bigint',
  // hopper.io records (R6): kind and time only, no address or browser (R5).
  `CREATE TABLE record (
     id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account (github_user_id) ON DELETE CASCADE,
     kind text NOT NULL CHECK (kind IN ('signed_in', 'signed_out', 'deletion_refused')), at timestamptz NOT NULL);
   CREATE INDEX record_account ON record (account_id, at);`,
  // Registrations (issue #465) and the tombstones an account deletion leaves (decision 5): no account in a tombstone.
  `CREATE TABLE registration (
     account_id bigint NOT NULL REFERENCES account (github_user_id) ON DELETE CASCADE,
     install_id text NOT NULL CHECK (install_id ~ '^[0-9a-f]{16}$'), created_at timestamptz NOT NULL, PRIMARY KEY (account_id, install_id));
   CREATE INDEX registration_install ON registration (install_id);
   CREATE TABLE registration_tombstone (install_id text PRIMARY KEY, removed_at timestamptz NOT NULL);`,
  // One registration per instance id (issue #465 item 3): of two, the newer stays. Its owner's name and its last hello.
  `ALTER TABLE registration ADD COLUMN name text CHECK (char_length(name) BETWEEN 1 AND 64), ADD COLUMN seen_at timestamptz;
   DELETE FROM registration r USING registration n
     WHERE r.install_id = n.install_id AND (r.created_at, r.account_id) < (n.created_at, n.account_id);
   DROP INDEX registration_install;
   CREATE UNIQUE INDEX registration_install ON registration (install_id);
   ALTER TABLE record DROP CONSTRAINT record_kind_check, ADD CONSTRAINT record_kind_check CHECK (kind IN ('signed_in',
     'signed_out', 'deletion_refused', 'instance_registered', 'instance_renamed', 'instance_removed', 'instance_unlinked', 'instance_moved'));`,
];

export const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SignInUnderWay { verifier: string; deletes?: string }

export interface CloudStore {
  /** Keeps the account GitHub named, by its numeric id: a new one, or the same one with its login and avatar now. */
  signedIn(a: CloudAccount): Promise<void>;
  account(githubUserId: string): Promise<CloudAccount | undefined>;
  openSession(token: string, githubUserId: string, now: Date): Promise<void>;
  /** The account of a session that has not ended. */
  sessionAccount(token: string, now: Date): Promise<CloudAccount | undefined>;
  /** The account of the session it ended, if one was open. */
  endSession(token: string): Promise<string | undefined>;
  /** Keeps a hopper.io record on the account, and deletes every record older than RECORD_MS. */
  record(githubUserId: string, kind: RecordKind, now: Date): Promise<void>;
  /** The account's records, newest first, at most 100. */
  records(githubUserId: string, now: Date): Promise<CloudRecord[]>;
  /** `deletes`: the account this sign-in confirms the deletion of. */
  startSignIn(state: string, verifier: string, deletes?: string): Promise<void>;
  /** A sign-in started within SIGN_IN_MS, taken once. */
  takeSignIn(state: string, now: Date): Promise<SignInUnderWay | undefined>;
  /** Keeps the instance as the registration of the account, one per instance id, and drops a tombstone of the
   * instance. A registration under another account is replaced, with its name and last-seen time. The account it was
   * registered under before, if any. */
  register(githubUserId: string, installId: string, now: Date): Promise<string | undefined>;
  /** The instance said hello now: its registration's last-seen time. */
  seen(installId: string, now: Date): Promise<void>;
  /** The account's registrations, the oldest first. */
  instances(githubUserId: string): Promise<CloudInstance[]>;
  /** Names the account's own instance; undefined clears the name. False: the account has no such instance. */
  rename(githubUserId: string, installId: string, name: string | undefined): Promise<boolean>;
  /** Removes the account's own instance, with a tombstone so its next hello is answered `unregister`. False: no such. */
  remove(githubUserId: string, installId: string, now: Date): Promise<boolean>;
  /** Removes the instance's registration when its account's login is `login`, with no tombstone: the instance unlinked.
   * The account it was registered under, if it was removed. */
  unlinked(installId: string, login: string): Promise<string | undefined>;
  /** Whether the instance is a registration of any account, a tombstone younger than TOMBSTONE_MS, or neither. */
  registrationOf(installId: string, now: Date): Promise<'registered' | 'removed' | 'unknown'>;
  /** The account, its sessions, its records, its registrations and its deletion sign-ins under way, in one statement,
   * which leaves a tombstone for each registration; and every tombstone older than TOMBSTONE_MS goes. */
  deleteAccount(githubUserId: string, now: Date): Promise<void>;
  close(): Promise<void>;
}

/** `?schema=<name>`, as the instance's store takes it (src/store/postgres-worker.ts): the schema, made if absent. */
function split(raw: string): { connectionString: string; schema?: string } {
  const u = new URL(raw);
  const schema = u.searchParams.get('schema') ?? undefined;
  u.searchParams.delete('schema');
  return { connectionString: u.toString(), ...(schema ? { schema } : {}) };
}

const accountOf = (r: Record<string, unknown>): CloudAccount => ({
  githubUserId: String(r.github_user_id), login: String(r.login), ...(r.avatar_url ? { avatarUrl: String(r.avatar_url) } : {}),
});

export async function openCloudStore(url: string): Promise<CloudStore> {
  const { connectionString, schema } = split(url);
  const id = schema ? `"${schema.replaceAll('"', '""')}"` : undefined;
  const pool = new pg.Pool({ connectionString, application_name: 'hopper-io', max: 10, ...(id ? { options: `-c search_path=${id}` } : {}) });
  await migrate(pool, id);
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  return {
    async signedIn(a) {
      await q(`INSERT INTO account (github_user_id, login, avatar_url) VALUES ($1, $2, $3)
               ON CONFLICT (github_user_id) DO UPDATE SET login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url, seen_at = now()`,
      [a.githubUserId, a.login, a.avatarUrl ?? null]);
    },
    async account(githubUserId) {
      const r = await q('SELECT * FROM account WHERE github_user_id = $1', [githubUserId]);
      return r.rows[0] ? accountOf(r.rows[0]) : undefined;
    },
    async openSession(token, githubUserId, now) {
      await q('INSERT INTO session (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [hashOf(token), githubUserId, new Date(now.getTime() + SESSION_MS)]);
    },
    async sessionAccount(token, now) {
      const r = await q('SELECT a.* FROM session s JOIN account a ON a.github_user_id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > $2', [hashOf(token), now]);
      return r.rows[0] ? accountOf(r.rows[0]) : undefined;
    },
    async endSession(token) {
      const r = await q('DELETE FROM session WHERE token_hash = $1 RETURNING account_id', [hashOf(token)]);
      return r.rows[0] ? String(r.rows[0].account_id) : undefined;
    },
    async record(githubUserId, kind, now) {
      await q('DELETE FROM record WHERE at <= $1', [new Date(now.getTime() - RECORD_MS)]);
      await q('INSERT INTO record (account_id, kind, at) VALUES ($1, $2, $3)', [githubUserId, kind, now]);
    },
    async records(githubUserId, now) {
      const r = await q('SELECT kind, at FROM record WHERE account_id = $1 AND at > $2 ORDER BY at DESC, id DESC LIMIT 100',
        [githubUserId, new Date(now.getTime() - RECORD_MS)]);
      return r.rows.map((x) => ({ kind: x.kind as RecordKind, at: new Date(x.at as string) }));
    },
    async startSignIn(state, verifier, deletes) {
      await q('INSERT INTO sign_in (state_hash, verifier, deletes) VALUES ($1, $2, $3)', [hashOf(state), verifier, deletes ?? null]);
    },
    async takeSignIn(state, now) {
      await q('DELETE FROM sign_in WHERE created_at <= $1', [new Date(now.getTime() - SIGN_IN_MS)]);
      const r = await q('DELETE FROM sign_in WHERE state_hash = $1 RETURNING verifier, deletes', [hashOf(state)]);
      const row = r.rows[0];
      return row ? { verifier: String(row.verifier), ...(row.deletes ? { deletes: String(row.deletes) } : {}) } : undefined;
    },
    async register(githubUserId, installId, now) {
      const r = await q(`WITH t AS (DELETE FROM registration_tombstone WHERE install_id = $2),
               old AS (SELECT account_id FROM registration WHERE install_id = $2)
               INSERT INTO registration (account_id, install_id, created_at) VALUES ($1, $2, $3)
               ON CONFLICT (install_id) DO UPDATE SET account_id = EXCLUDED.account_id,
                 created_at = CASE WHEN registration.account_id = EXCLUDED.account_id THEN registration.created_at ELSE EXCLUDED.created_at END,
                 name = CASE WHEN registration.account_id = EXCLUDED.account_id THEN registration.name END,
                 seen_at = CASE WHEN registration.account_id = EXCLUDED.account_id THEN registration.seen_at END
               RETURNING (SELECT account_id FROM old) AS before`, [githubUserId, installId, now]);
      const before = r.rows[0]?.before;
      return before === null || before === undefined ? undefined : String(before);
    },
    async seen(installId, now) {
      await q('UPDATE registration SET seen_at = $2 WHERE install_id = $1', [installId, now]);
    },
    async instances(githubUserId) {
      const r = await q('SELECT install_id, name, created_at, seen_at FROM registration WHERE account_id = $1 ORDER BY created_at, install_id', [githubUserId]);
      return r.rows.map((x) => ({
        installId: String(x.install_id), ...(x.name ? { name: String(x.name) } : {}), registeredAt: new Date(x.created_at as string),
        ...(x.seen_at ? { seenAt: new Date(x.seen_at as string) } : {}),
      }));
    },
    async rename(githubUserId, installId, name) {
      const r = await q('UPDATE registration SET name = $3 WHERE account_id = $1 AND install_id = $2', [githubUserId, installId, name ?? null]);
      return (r.rowCount ?? 0) > 0;
    },
    async remove(githubUserId, installId, now) {
      const r = await q(`WITH r AS (DELETE FROM registration WHERE account_id = $1 AND install_id = $2 RETURNING install_id),
               t AS (INSERT INTO registration_tombstone (install_id, removed_at) SELECT install_id, $3 FROM r
                     ON CONFLICT (install_id) DO UPDATE SET removed_at = EXCLUDED.removed_at)
               SELECT count(*)::int AS n FROM r`, [githubUserId, installId, now]);
      return r.rows[0].n > 0;
    },
    async unlinked(installId, login) {
      const r = await q(`DELETE FROM registration WHERE install_id = $1
               AND account_id = (SELECT github_user_id FROM account WHERE lower(login) = $2) RETURNING account_id`, [installId, login]);
      return r.rows[0] ? String(r.rows[0].account_id) : undefined;
    },
    async registrationOf(installId, now) {
      const r = await q(`SELECT EXISTS (SELECT 1 FROM registration WHERE install_id = $1) AS registered,
                                EXISTS (SELECT 1 FROM registration_tombstone WHERE install_id = $1 AND removed_at > $2) AS removed`,
      [installId, new Date(now.getTime() - TOMBSTONE_MS)]);
      return r.rows[0].registered ? 'registered' : r.rows[0].removed ? 'removed' : 'unknown';
    },
    async deleteAccount(githubUserId, now) {
      await q('DELETE FROM registration_tombstone WHERE removed_at <= $1', [new Date(now.getTime() - TOMBSTONE_MS)]);
      await q(`WITH s AS (DELETE FROM sign_in WHERE deletes = $1),
               t AS (INSERT INTO registration_tombstone (install_id, removed_at)
                     SELECT install_id, $2 FROM registration WHERE account_id = $1
                     ON CONFLICT (install_id) DO UPDATE SET removed_at = EXCLUDED.removed_at)
               DELETE FROM account WHERE github_user_id = $1`, [githubUserId, now]);
    },
    close: () => pool.end(),
  };
}

/** Every migration not yet applied, in order, each in its own transaction; one process at a time (an advisory lock). */
async function migrate(pool: pg.Pool, schema: string | undefined): Promise<void> {
  const c = await pool.connect();
  try {
    if (schema) await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await c.query("SELECT pg_advisory_lock(hashtext('hopper-io-migrations'))");
    await c.query('CREATE TABLE IF NOT EXISTS cloud_migration (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT version FROM cloud_migration')).rows.map((r) => Number(r.version)));
    for (const [i, sql] of MIGRATIONS.entries()) {
      if (done.has(i + 1)) continue;
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO cloud_migration (version) VALUES ($1)', [i + 1]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('hopper-io-migrations'))").catch(() => undefined);
    c.release();
  }
}
