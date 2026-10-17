// hopper.io's store (issue #463, docs/cloud-hosting-identity.md): Postgres through pg. It keeps only what sign-in
// needs: a **hopper.io account** per GitHub account, keyed by GitHub's numeric user id (never the login, which can be
// renamed), with the login and the avatar URL for display; a **hopper.io session**, only its token's hash; and a
// sign-in under way, only its state's hash and its PKCE verifier, for ten minutes, and the account it is to delete when
// it confirms a deletion; a **hopper.io record** of each act on the account, its kind and time only, for RECORD_MS
// (docs/hopper-io-security.md R6, R5). No GitHub token is kept. A deleted account takes its sessions and records with it.
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

/** What a hopper.io record says was done on the account. */
export type RecordKind = 'signed_in' | 'signed_out' | 'deletion_refused';
export interface CloudRecord { kind: RecordKind; at: Date }

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
  /** The account, its sessions, its records and its deletion sign-ins under way, in one statement. */
  deleteAccount(githubUserId: string): Promise<void>;
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
    async deleteAccount(githubUserId) {
      await q('WITH s AS (DELETE FROM sign_in WHERE deletes = $1) DELETE FROM account WHERE github_user_id = $1', [githubUserId]);
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
