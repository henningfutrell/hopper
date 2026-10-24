// Database reads (issue #2231, design.md "Database reads"): a job reads rows of a database through the hopper. For each
// read the vault mints a login role of its own in the database — SELECT only on the schemas its minting credential names,
// read-only by default, short timeouts, one or two connections, `VALID UNTIL` its TTL —, the hopper runs the job's one
// SELECT with it in a read-only transaction, answers the rows as CSV up to a cap, and drops the role. The role's password
// never leaves the hopper: no box, no job and no event holds it. The minting credential is the login that makes and drops
// these roles; a person sets it on Vault, and nothing but the vault reads it. On SQL Server (part 2) a database read role
// is a login and its user in the database, as SQL Server has no role that logs in. Pure: the types, the limits and the port.
import { ASSET_NAME } from './access.ts';

/** The engines a database read takes: Postgres (issue #2231 part 1) and SQL Server (part 2). */
export const DATABASE_ENGINES = ['postgres', 'sqlserver'] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];
/** The port each engine listens on unless the credential names another. */
const DEFAULT_PORT: Record<DatabaseEngine, number> = { postgres: 5432, sqlserver: 1433 };

/** How long a database read role lives at most: its `VALID UNTIL`, the backstop to the drop at the read's end. */
export const DATABASE_ROLE_TTL_SECONDS = 900;
/**
 * The start of each database read role's name: the sweep drops only roles of this name whose `VALID UNTIL` passed (on
 * SQL Server, which has no `VALID UNTIL`, whose login is older than the TTL).
 */
export const DATABASE_ROLE_PREFIX = 'hopper_read_';
/** The connections a database read role may hold at once. */
export const READ_CONNECTION_LIMIT = 2;
/** How long one statement of a database read role may run, and how long it may idle in a transaction. */
export const READ_STATEMENT_TIMEOUT_MS = 60_000;
export const READ_IDLE_IN_TRANSACTION_MS = 30_000;
/** The most a read answers: more rows or bytes is refused, never cut, so the job narrows or pages its query. */
export const READ_MAX_ROWS = 100_000;
export const READ_MAX_BYTES = 16 * 1024 * 1024;
/** The most SQL one read takes. */
export const SQL_MAX = 64 * 1024;
/** How long the hopper waits to connect to the database. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** How the hopper checks the database's TLS: its certificate and name (`verify-full`), TLS without the check, or none. */
export const SSL_MODES = ['verify-full', 'require', 'disable'] as const;
export type SslMode = (typeof SSL_MODES)[number];

/**
 * A database's minting credential (a vault secret that mints for `database/<name>`): where the database is, the login
 * that may create, grant and drop the database read roles, and what a database read role may SELECT from: every table of
 * the `schemas`, and the `tables` (`<schema>.<table>`) one at a time. At least one of the two names something.
 * `ca`: the PEM the database's certificate is checked against, when it is not one the system trusts.
 */
export interface DatabaseMintingCredential {
  engine: DatabaseEngine; host: string; port: number; database: string; user: string; password: string; sslmode: SslMode; ca?: string; schemas: string[]; tables: string[];
}

/** A schema's or a table's name as a database read role is granted it: a plain identifier, so no quoting can change what is granted. */
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/** A table's schema and name: `app.users` → `['app', 'users']`. */
export const tableParts = (table: string): [string, string] => table.split('.') as [string, string];
/** A host: a DNS name or an address. */
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,252})$/;

/** The minting credential's value read, or why it cannot be. Never says the value. */
export function databaseCredentialOf(value: string): DatabaseMintingCredential | string {
  let v: Record<string, unknown> = {};
  try { v = JSON.parse(value) as Record<string, unknown>; } catch { /* below */ }
  const str = (k: string): string | undefined => (typeof v[k] === 'string' && v[k] !== '' ? v[k] : undefined);
  const said = 'a database minting credential';
  const [engine, host, database, user, password] = [str('engine'), str('host'), str('database'), str('user'), str('password')];
  const list = (k: string): unknown[] | undefined => (v[k] === undefined ? [] : Array.isArray(v[k]) ? v[k] : undefined);
  const [schemas, tables] = [list('schemas'), list('tables')];
  if (!engine || !host || !database || !user || !password || !schemas || !tables) return `${said} holds JSON with engine (postgres or sqlserver), host, database, user, password, and schemas or tables (and port, sslmode or ca when it has them)`;
  if (!(DATABASE_ENGINES as readonly string[]).includes(engine)) return `${said}'s engine is ${DATABASE_ENGINES.join(' or ')}`;
  if (!HOST.test(host)) return `${said}'s host is a DNS name or an address`;
  const port = v.port === undefined ? DEFAULT_PORT[engine as DatabaseEngine] : v.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return `${said}'s port is 1 to 65535`;
  const sslmode = str('sslmode') ?? 'verify-full';
  if (!(SSL_MODES as readonly string[]).includes(sslmode)) return `${said}'s sslmode is ${SSL_MODES.join(', ').replace(/, (\w+)$/, ' or $1')}`;
  if (schemas.length + tables.length === 0) return `${said} names schemas or tables: what a database read role may SELECT from, at least one`;
  const bad = schemas.find((s) => typeof s !== 'string' || !SCHEMA.test(s));
  if (bad !== undefined) return `${said}'s schema ${JSON.stringify(bad)} is no plain schema name (letters, digits, _ and $)`;
  const badTable = tables.find((t) => typeof t !== 'string' || !TABLE.test(t));
  if (badTable !== undefined) return `${said}'s table ${JSON.stringify(badTable)} is no plain <schema>.<table> name (letters, digits, _ and $)`;
  const ca = str('ca');
  return { engine: engine as DatabaseEngine, host, port, database, user, password, sslmode: sslmode as SslMode, ...(ca ? { ca } : {}), schemas: [...new Set(schemas as string[])], tables: [...new Set(tables as string[])] };
}

/** A minting credential's asset for a database: its whole name, as an asset name (`<cluster>/<namespace>/<database>`). */
export const databaseNameProblem = (name: string): string | undefined => (ASSET_NAME.test(name) ? undefined : `database ${JSON.stringify(name)} is not a name a minting credential mints for (letters, digits and . _ / + = , -)`);

/** Why `sql` is not a read the hopper runs, or undefined. One statement is the database's own rule: the hopper sends it as one. */
export function sqlProblem(sql: string | undefined): string | undefined {
  if (sql === undefined || sql.trim() === '') return 'name the SELECT to run with --sql';
  if (Buffer.byteLength(sql) > SQL_MAX) return `--sql is at most ${SQL_MAX} bytes`;
  return undefined;
}

/** A database read role's name: the prefix and a random id, nothing of the job or the person. */
export const databaseRoleName = (id: string): string => `${DATABASE_ROLE_PREFIX}${id}`;

/** One CSV cell: NULL empty, a value quoted when it holds a comma, a quote or a line end, or is empty. */
const cell = (v: string | null): string => (v === null ? '' : v === '' || /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** One CSV line, ended. */
export const csvLine = (cells: readonly (string | null)[]): string => `${cells.map(cell).join(',')}\n`;
/** A whole answer: the header, then each row. */
export const csvOf = (fields: readonly string[], rows: readonly (readonly (string | null)[])[]): string => [fields, ...rows].map(csvLine).join('');

/** What a read answered: the rows as CSV with a header, how many, and how many bytes. */
export interface DatabaseReadResult { csv: string; rows: number; bytes: number }

/**
 * The database at its seam (`src/vault/postgres-reads.ts`, `src/vault/sqlserver-reads.ts`). Each call connects for itself and throws, with what the
 * database said, when it fails: never with a password in the message.
 */
export interface DatabaseReader {
  /**
   * Makes the database read role `role` with the login `password` (sent as a hash, never in clear), valid until
   * `validUntil`, then checks it can change nothing: a role that could is dropped, and the call throws.
   */
  mint(c: DatabaseMintingCredential, r: { role: string; password: string; validUntil: Date }): Promise<void>;
  /** Runs `sql` as `role` in a read-only transaction; the rows as CSV, or throws when they pass a cap. */
  read(c: DatabaseMintingCredential, r: { role: string; password: string; sql: string }): Promise<DatabaseReadResult>;
  /** Ends the role's sessions and drops it. A role already gone is no error. */
  drop(c: DatabaseMintingCredential, role: string): Promise<void>;
  /** Drops each database read role whose `VALID UNTIL` passed (a hopper that stopped mid-read left it): their names. */
  sweep(c: DatabaseMintingCredential): Promise<string[]>;
}

/** One reader for each engine: each call goes to the reader of its credential's engine. */
export function readerByEngine(readers: Record<DatabaseEngine, DatabaseReader>): DatabaseReader {
  return {
    mint: (c, r) => readers[c.engine].mint(c, r),
    read: (c, r) => readers[c.engine].read(c, r),
    drop: (c, role) => readers[c.engine].drop(c, role),
    sweep: (c) => readers[c.engine].sweep(c),
  };
}
