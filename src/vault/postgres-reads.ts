// A database read on Postgres (issue #2231, design.md "Database reads"): the `DatabaseReader` seam with `pg`. The
// minting login makes each database read role: LOGIN, NOINHERIT, its connections limited, `VALID UNTIL` its TTL, its password as
// a SCRAM verifier (the clear password never reaches the server or its log), read-only by default with short timeouts,
// CONNECT on the credential's database, and USAGE and SELECT on the named schemas and tables only. Before it is used, the minting
// login checks the role can change nothing — through a grant to PUBLIC too —, and drops it when it could. The read runs
// the job's one statement as a cursor in a read-only transaction, so it is a SELECT and nothing else, and answers its rows
// as CSV up to the caps. The drop ends the role's sessions; the sweep drops each database read role whose `VALID UNTIL` passed.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  CONNECT_TIMEOUT_MS, csvLine, READ_CONNECTION_LIMIT, READ_IDLE_IN_TRANSACTION_MS, READ_MAX_BYTES, READ_MAX_ROWS, DATABASE_ROLE_PREFIX, READ_STATEMENT_TIMEOUT_MS,
  tableParts, type DatabaseMintingCredential, type DatabaseReader,
} from '../domain/database-read.ts';

/** The rows a read fetches at a time. */
const FETCH_ROWS = 1000;
/** Each value as Postgres sends it, as text: the CSV says what the database says, never a number JavaScript rounded. */
const RAW = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;

/**
 * A SCRAM-SHA-256 verifier of `password` (RFC 5802, RFC 7677), as Postgres keeps it: `CREATE ROLE … PASSWORD` takes it,
 * and the server never sees the password itself.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const ident = (s: string): string => pg.escapeIdentifier(s);
const lit = (s: string): string => pg.escapeLiteral(s);

/** The TLS the client asks for: none, TLS, or TLS with the certificate and the host's name checked. */
const sslOf = (c: DatabaseMintingCredential): pg.ClientConfig['ssl'] => (c.sslmode === 'disable' ? false : { rejectUnauthorized: c.sslmode === 'verify-full', ...(c.ca ? { ca: c.ca } : {}) });

/** One connection to the credential's database as `user`, for `fn`; closed after it, whatever happens. */
async function connected<T>(c: DatabaseMintingCredential, login: { user: string; password: string }, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ host: c.host, port: c.port, database: c.database, ...login, ssl: sslOf(c), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, types: RAW, application_name: 'hopper' });
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

const asMinter = <T>(c: DatabaseMintingCredential, fn: (client: pg.Client) => Promise<T>): Promise<T> => connected(c, { user: c.user, password: c.password }, fn);

/** What the role could change, through its own grants or PUBLIC's: tables, sequences, schemas, the database. At most 5. */
const CHANGES = `
  SELECT format('%I.%I', n.nspname, c.relname) AS what FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND ((c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (has_table_privilege($1, c.oid, 'INSERT') OR has_table_privilege($1, c.oid, 'UPDATE')
       OR has_table_privilege($1, c.oid, 'DELETE') OR has_table_privilege($1, c.oid, 'TRUNCATE')))
      OR (c.relkind = 'S' AND (has_sequence_privilege($1, c.oid, 'UPDATE') OR has_sequence_privilege($1, c.oid, 'USAGE'))))
  UNION ALL SELECT format('schema %I', nspname) FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_%' AND has_schema_privilege($1, oid, 'CREATE')
  UNION ALL SELECT format('database %I', datname) FROM pg_database WHERE datname = current_database() AND has_database_privilege($1, oid, 'CREATE')
  LIMIT 5`;

/** The end of a database read role: no new login, its sessions ended, its grants taken back, then the role itself. */
async function dropRole(client: pg.Client, role: string): Promise<void> {
  const known = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (known.rowCount === 0) return;
  const r = ident(role);
  await client.query(`ALTER ROLE ${r} NOLOGIN`);
  await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [role]);
  await client.query(`DROP OWNED BY ${r}`);
  await client.query(`DROP ROLE ${r}`);
}

/** Why a read stops: its answer passed a cap. */
const passed = (what: string): Error => new Error(`the answer passed ${what}: narrow the query, or page it (WHERE on a key, ORDER BY and LIMIT)`);

export function createPostgresReader(o: { maxRows?: number; maxBytes?: number } = {}): DatabaseReader {
  const maxRows = o.maxRows ?? READ_MAX_ROWS, maxBytes = o.maxBytes ?? READ_MAX_BYTES;
  return {
    async mint(c, { role, password, validUntil }) {
      await asMinter(c, async (client) => {
        const r = ident(role);
        await client.query(`CREATE ROLE ${r} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT ${READ_CONNECTION_LIMIT} VALID UNTIL ${lit(validUntil.toISOString())} PASSWORD ${lit(scramVerifier(password))}`);
        try {
          // The minting login takes the role's privileges too (a subset of its own), so it may end the role's sessions
          // and take its grants back.
          await client.query(`GRANT ${r} TO CURRENT_USER`);
          for (const [k, v] of [['default_transaction_read_only', 'on'], ['statement_timeout', String(READ_STATEMENT_TIMEOUT_MS)], ['idle_in_transaction_session_timeout', String(READ_IDLE_IN_TRANSACTION_MS)]]) {
            await client.query(`ALTER ROLE ${r} SET ${k} = ${lit(v!)}`);
          }
          await client.query(`GRANT CONNECT ON DATABASE ${ident(c.database)} TO ${r}`);
          for (const s of new Set([...c.schemas, ...c.tables.map((t) => tableParts(t)[0])])) await client.query(`GRANT USAGE ON SCHEMA ${ident(s)} TO ${r}`);
          for (const s of c.schemas) await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(s)} TO ${r}`);
          for (const t of c.tables) await client.query(`GRANT SELECT ON TABLE ${tableParts(t).map(ident).join('.')} TO ${r}`);
          const changes = (await client.query<{ what: string }>(CHANGES, [role])).rows.map((x) => x.what);
          if (changes.length) throw new Error(`the database read role could change ${changes.join(', ')}: take that grant from PUBLIC, or name other schemas`);
        } catch (e) {
          await dropRole(client, role).catch(() => {});
          throw e;
        }
      });
    },

    async read(c, { role, password, sql }) {
      return connected(c, { user: role, password }, async (client) => {
        await client.query('BEGIN READ ONLY');
        try {
          // One statement: the extended protocol takes no second one, and a cursor is a query's only.
          const text = `DECLARE hopper_read NO SCROLL CURSOR FOR ${sql.trim().replace(/;+\s*$/, '')}`;
          await client.query({ text, queryMode: 'extended' } as pg.QueryConfig);
          let csv = '', rows = 0, bytes = 0, head = false;
          for (;;) {
            const got = await client.query<string[]>({ text: `FETCH ${FETCH_ROWS} FROM hopper_read`, rowMode: 'array' });
            if (!head) {
              const line = csvLine(got.fields.map((f) => f.name));
              csv += line; bytes += Buffer.byteLength(line); head = true;
            }
            for (const row of got.rows) {
              if (++rows > maxRows) throw passed(`${maxRows} rows`);
              const line = csvLine(row as (string | null)[]);
              bytes += Buffer.byteLength(line);
              if (bytes > maxBytes) throw passed(`${maxBytes} bytes`);
              csv += line;
            }
            if (got.rows.length < FETCH_ROWS) return { csv, rows, bytes };
          }
        } finally {
          await client.query('ROLLBACK').catch(() => {});
        }
      });
    },

    async drop(c, role) {
      await asMinter(c, (client) => dropRole(client, role));
    },

    async sweep(c) {
      return asMinter(c, async (client) => {
        const due = await client.query<{ rolname: string }>(
          "SELECT rolname FROM pg_roles WHERE rolname LIKE $1 AND rolvaliduntil < now() AND pg_has_role(current_user, oid, 'USAGE') ORDER BY rolname",
          [`${DATABASE_ROLE_PREFIX.replace(/_/g, '\\_')}%`],
        );
        const dropped: string[] = [];
        for (const { rolname } of due.rows) {
          try { await dropRole(client, rolname); dropped.push(rolname); } catch { /* the next sweep tries again */ }
        }
        return dropped;
      });
    },
  };
}
