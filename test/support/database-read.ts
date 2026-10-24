// A database to read (issue #2231): two fresh databases in the test Postgres, `a` with the schemas `app` (a users table)
// and `private`, and `b`; and a minting login set up as docs/help/vault.md says a person sets it up: it may create roles,
// and holds CONNECT on `a`, USAGE on `app` and SELECT on its tables, each with the grant option. `b` is closed to PUBLIC,
// as the help says to close every other database. The test Postgres's own login is the superuser that sets it up.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { DatabaseMintingCredential } from '../../src/domain/database-read.ts';
import { testPostgres } from './database.ts';

export interface ReadDatabases {
  /** The minting credential for database `a`, schema `app`. */
  credential: DatabaseMintingCredential;
  /** Names of the two databases. */
  a: string; b: string;
  /** Runs SQL as the test Postgres's superuser in database `a` (or `b`). */
  admin(sql: string, values?: unknown[], db?: string): Promise<pg.QueryResult>;
  /** A client of database `db` logged in as `user`. */
  connectAs(user: string, password: string, db: string): Promise<pg.Client>;
  /** Removes the databases and the minting login. */
  close(): Promise<void>;
}

const ident = (s: string): string => pg.escapeIdentifier(s);

async function run(url: string, sql: string, values?: unknown[]): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await c.query(sql, values); } finally { await c.end(); }
}

export async function readDatabases(): Promise<ReadDatabases> {
  const id = randomBytes(5).toString('hex');
  const base = new URL(testPostgres());
  base.searchParams.delete('schema');
  const urlOf = (db: string): string => { const u = new URL(base); u.pathname = `/${db}`; return u.toString(); };
  const a = `reads_a_${id}`, b = `reads_b_${id}`, minter = `minter_${id}`, password = randomBytes(12).toString('hex');
  await run(base.toString(), `CREATE DATABASE ${ident(a)}`);
  await run(base.toString(), `CREATE DATABASE ${ident(b)}`);
  await run(base.toString(), `CREATE ROLE ${ident(minter)} LOGIN CREATEROLE PASSWORD '${password}'`);
  await run(base.toString(), `REVOKE CONNECT ON DATABASE ${ident(b)} FROM PUBLIC`);
  await run(urlOf(a), [
    'CREATE SCHEMA app', 'CREATE SCHEMA private',
    'CREATE TABLE app.users (id int PRIMARY KEY, email text, note text)',
    "INSERT INTO app.users VALUES (1, 'a@example.test', NULL), (2, 'b@example.test', 'say \"hi\", twice')",
    'CREATE TABLE private.keys (id int)', 'INSERT INTO private.keys VALUES (7)',
    `GRANT CONNECT ON DATABASE ${ident(a)} TO ${ident(minter)} WITH GRANT OPTION`,
    `GRANT USAGE ON SCHEMA app TO ${ident(minter)} WITH GRANT OPTION`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA app TO ${ident(minter)} WITH GRANT OPTION`,
  ].join(';\n'));
  await run(urlOf(b), 'CREATE TABLE things (id int); INSERT INTO things VALUES (1)');
  const credential: DatabaseMintingCredential = {
    engine: 'postgres', host: base.hostname, port: Number(base.port || 5432), database: a, user: minter, password, sslmode: 'disable', schemas: ['app'], tables: [],
  };
  return {
    credential, a, b,
    admin: (sql, values, db = a) => run(urlOf(db), sql, values),
    async connectAs(user, pw, db) {
      const c = new pg.Client({ host: base.hostname, port: Number(base.port || 5432), database: db, user, password: pw });
      c.on('error', () => {});
      await c.connect();
      return c;
    },
    async close() {
      const roles = await run(base.toString(), "SELECT rolname FROM pg_roles WHERE rolname LIKE 'hopper\\_read\\_%' AND pg_has_role($1, oid, 'USAGE')", [minter]).catch(() => ({ rows: [] }));
      for (const db of [a, b]) await run(base.toString(), `DROP DATABASE IF EXISTS ${ident(db)} WITH (FORCE)`);
      for (const r of [...roles.rows.map((x: { rolname: string }) => x.rolname), minter]) await run(base.toString(), `DROP ROLE IF EXISTS ${ident(r)}`).catch(() => {});
    },
  };
}
