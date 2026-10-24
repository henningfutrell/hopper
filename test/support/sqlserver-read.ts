// A SQL Server database to read (issue #2231 part 2): the server HOPPER_TEST_SQLSERVER_URL names
// (`mssql://sa:<password>@<host>:<port>`, its admin login), else a throwaway SQL Server container (testcontainers),
// removed after the file's tests. In it, two fresh databases: `a` with the schemas `app` (users and contacts tables) and
// `private`, and `b`; and a minting login set up as help/vault.md says a person sets it up: ALTER ANY LOGIN, ALTER ANY
// CONNECTION and VIEW SERVER STATE on the server, a user in `a` with ALTER ANY USER, and SELECT on the schema `app` and
// on the table `app.contacts`, each with the grant option. It has no user in `b`, and `b` has no guest.
import { randomBytes } from 'node:crypto';
import sql from 'mssql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { DatabaseMintingCredential } from '../../src/domain/database-read.ts';
import { containerLabels } from './sweep.ts';

export const SQLSERVER_IMAGE = 'mcr.microsoft.com/mssql/server:2022-CU27-ubuntu-22.04';

export interface SqlServerDatabases {
  /** The minting credential for database `a`, schema `app`. */
  credential: DatabaseMintingCredential;
  /** Names of the two databases. */
  a: string; b: string;
  /** Runs a batch as the server's admin in database `a` (or `b`); the first result set. */
  admin<T = Record<string, unknown>>(batch: string, db?: string): Promise<T[]>;
  /** A pool of one connection to database `db` logged in as `user`. */
  connectAs(user: string, password: string, db: string): Promise<sql.ConnectionPool>;
  /** Removes the databases, the minting login and every database read role left. */
  close(): Promise<void>;
}

/** A password SQL Server's policy takes. */
const password = (): string => `${randomBytes(12).toString('hex')}Aa1!`;

async function server(): Promise<{ host: string; port: number; user: string; password: string; stop(): Promise<void> }> {
  const given = process.env.HOPPER_TEST_SQLSERVER_URL;
  if (given) {
    const u = new URL(given);
    return { host: u.hostname, port: Number(u.port || 1433), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), stop: async () => {} };
  }
  const sa = password();
  const c: StartedTestContainer = await new GenericContainer(process.env.SQLSERVER_IMAGE ?? SQLSERVER_IMAGE)
    .withEnvironment({ ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: sa, MSSQL_MEMORY_LIMIT_MB: '2048' })
    .withExposedPorts(1433)
    .withLabels(containerLabels())
    .withWaitStrategy(Wait.forLogMessage('SQL Server is now ready for client connections'))
    .withStartupTimeout(180_000)
    .start();
  return { host: '127.0.0.1', port: c.getMappedPort(1433), user: 'sa', password: sa, stop: async () => { await c.stop(); } };
}

export async function sqlServerDatabases(): Promise<SqlServerDatabases> {
  const s = await server();
  const connect = async (user: string, pw: string, database: string): Promise<sql.ConnectionPool> => {
    const pool = new sql.ConnectionPool({ server: s.host, port: s.port, database, user, password: pw, options: { encrypt: false, trustServerCertificate: true }, pool: { min: 0, max: 1 }, connectionTimeout: 30_000 });
    pool.on('error', () => {});
    return pool.connect();
  };
  // The server may take logins a few seconds after it says it is ready.
  let admin: sql.ConnectionPool | undefined;
  for (let i = 0; !admin; i++) {
    try { admin = await connect(s.user, s.password, 'master'); } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  const run = async <T>(batch: string, db = 'master'): Promise<T[]> => (await admin.request().batch<T>(`USE [${db}];\n${batch}`)).recordset ?? [];
  const id = randomBytes(5).toString('hex');
  const a = `reads_a_${id}`, b = `reads_b_${id}`, minter = `minter_${id}`, minterPassword = password();
  await run(`CREATE DATABASE [${a}]; CREATE DATABASE [${b}]`);
  await run(`CREATE LOGIN [${minter}] WITH PASSWORD = '${minterPassword}'; GRANT ALTER ANY LOGIN, ALTER ANY CONNECTION, VIEW SERVER STATE TO [${minter}]`);
  await run('EXEC(\'CREATE SCHEMA app\'); EXEC(\'CREATE SCHEMA private\')', a);
  await run([
    'CREATE TABLE app.users (id int PRIMARY KEY, email nvarchar(100), note nvarchar(100), seen datetime2, active bit)',
    "INSERT INTO app.users VALUES (1, N'a@example.test', NULL, '2026-10-20T12:00:00', 1), (2, N'b@example.test', N'say \"hi\", twice', NULL, 0)",
    'CREATE TABLE app.contacts (id int PRIMARY KEY, user_id int, phone nvarchar(20))',
    "INSERT INTO app.contacts VALUES (10, 1, N'555-0100')",
    'CREATE TABLE private.keys (id int)', 'INSERT INTO private.keys VALUES (7)',
    `CREATE USER [${minter}] FOR LOGIN [${minter}]`, `GRANT ALTER ANY USER TO [${minter}]`,
    `GRANT SELECT ON SCHEMA::app TO [${minter}] WITH GRANT OPTION`,
    // A table named one at a time needs the grant option on the table itself: the schema's does not let it grant one table.
    `GRANT SELECT ON app.contacts TO [${minter}] WITH GRANT OPTION`,
  ].join(';\n'), a);
  await run('CREATE TABLE things (id int); INSERT INTO things VALUES (1)', b);
  const credential: DatabaseMintingCredential = { engine: 'sqlserver', host: s.host, port: s.port, database: a, user: minter, password: minterPassword, sslmode: 'disable', schemas: ['app'], tables: [] };
  return {
    credential, a, b,
    admin: (batch, db = a) => run(batch, db),
    connectAs: (user, pw, db) => connect(user, pw, db),
    async close() {
      await run(`
        DECLARE @n sysname, @s nvarchar(max);
        DECLARE k CURSOR LOCAL FOR SELECT session_id FROM sys.dm_exec_sessions WHERE login_name LIKE 'hopper[_]read[_]%' OR login_name = '${minter}';
        OPEN k; DECLARE @id int; FETCH k INTO @id; WHILE @@FETCH_STATUS = 0 BEGIN SET @s = 'KILL ' + CAST(@id AS nvarchar); EXEC(@s); FETCH k INTO @id; END;
        ALTER DATABASE [${a}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${a}];
        ALTER DATABASE [${b}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${b}];
        DECLARE l CURSOR LOCAL FOR SELECT name FROM sys.server_principals WHERE name LIKE 'hopper[_]read[_]%' OR name = '${minter}';
        OPEN l; FETCH l INTO @n; WHILE @@FETCH_STATUS = 0 BEGIN SET @s = 'DROP LOGIN ' + QUOTENAME(@n); EXEC(@s); FETCH l INTO @n; END;`).catch(() => {});
      await admin.close();
      await s.stop();
    },
  };
}
