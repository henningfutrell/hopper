// Issue #2231 part 2: the SQL Server side of a database read, against a real SQL Server. A database read role is a login
// and its user, minted with SELECT only on the schemas and tables its minting credential names, its password sent as a
// hash; every write is refused, also in a transaction it opens itself; it reaches neither another schema nor another
// database; a role that could change something through `public` is never handed out; a read answers one result set as CSV
// up to a cap and changes nothing; a drop ends its sessions; the sweep drops a role older than the TTL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlServerReader, sqlServerPasswordHash } from '../../src/vault/sqlserver-reads.ts';
import { DATABASE_ROLE_TTL_SECONDS } from '../../src/domain/database-read.ts';
import { sqlServerDatabases, type SqlServerDatabases } from '../support/sqlserver-read.ts';

let dbs: SqlServerDatabases;
beforeAll(async () => { dbs = await sqlServerDatabases(); }, 240_000);
afterAll(async () => { await dbs?.close(); }, 60_000);

const reader = createSqlServerReader();
let n = 0;
const role = (): string => `hopper_read_t${process.pid}x${(n++).toString(16)}${Date.now().toString(16)}`;
const soon = (): Date => new Date(Date.now() + DATABASE_ROLE_TTL_SECONDS * 1000);
const PASSWORD = 'pw-of-the-read-role';

const minted = async (credential = dbs.credential): Promise<string> => {
  const r = role();
  await reader.mint(credential, { role: r, password: PASSWORD, validUntil: soon() });
  return r;
};
const exists = async (r: string): Promise<{ login: boolean; user: boolean }> => {
  const [x] = await dbs.admin<{ login: number; usr: number }>(`SELECT (SELECT COUNT(*) FROM sys.server_principals WHERE name = '${r}') AS login, (SELECT COUNT(*) FROM sys.database_principals WHERE name = '${r}') AS usr`);
  return { login: x!.login > 0, user: x!.usr > 0 };
};
const refusal = async (r: string, batch: string, db?: string): Promise<string> => {
  let pool: Awaited<ReturnType<SqlServerDatabases['connectAs']>> | undefined;
  try {
    pool = await dbs.connectAs(r, PASSWORD, db ?? dbs.a);
    await pool.request().batch(batch);
    return 'no refusal';
  } catch (e) {
    return (e as Error).message;
  } finally {
    await pool?.close().catch(() => {});
  }
};

describe('a SQL Server database read role (issue #2231)', () => {
  it('is a login and its user, with no password policy, its default database the credential\'s', async () => {
    const r = await minted();
    const [l] = await dbs.admin<{ is_disabled: boolean; is_policy_checked: boolean; default_database_name: string }>(`SELECT is_disabled, is_policy_checked, default_database_name FROM sys.sql_logins WHERE name = '${r}'`);
    expect(l).toEqual({ is_disabled: false, is_policy_checked: false, default_database_name: dbs.a });
    expect(await exists(r)).toEqual({ login: true, user: true });
  });

  it('reads the schema it was granted', async () => {
    const r = await minted();
    const pool = await dbs.connectAs(r, PASSWORD, dbs.a);
    expect((await pool.request().query('SELECT COUNT(*) AS n FROM app.users')).recordset).toEqual([{ n: 2 }]);
    await pool.close();
  });

  it('is refused every write, also in a transaction it opens itself', async () => {
    const r = await minted();
    expect(await refusal(r, "INSERT INTO app.users (id) VALUES (3)")).toBe('The INSERT permission was denied on the object \'users\', database \'' + dbs.a + '\', schema \'app\'.');
    expect(await refusal(r, "UPDATE app.users SET email = N'x'")).toBe('The UPDATE permission was denied on the object \'users\', database \'' + dbs.a + '\', schema \'app\'.');
    expect(await refusal(r, 'DELETE FROM app.users')).toBe('The DELETE permission was denied on the object \'users\', database \'' + dbs.a + '\', schema \'app\'.');
    expect(await refusal(r, 'CREATE TABLE app.made (id int)')).toBe('CREATE TABLE permission denied in database \'' + dbs.a + '\'.');
    expect(await refusal(r, 'BEGIN TRANSACTION; INSERT INTO app.users (id) VALUES (3); COMMIT')).toBe('The INSERT permission was denied on the object \'users\', database \'' + dbs.a + '\', schema \'app\'.');
    expect(await dbs.admin('SELECT COUNT(*) AS n FROM app.users')).toEqual([{ n: 2 }]);
  });

  it('reads no schema its credential does not name, and reaches no other database', async () => {
    const r = await minted();
    expect(await refusal(r, 'SELECT * FROM private.keys')).toBe('The SELECT permission was denied on the object \'keys\', database \'' + dbs.a + '\', schema \'private\'.');
    expect(await refusal(r, 'SELECT 1', dbs.b)).toMatch(/Cannot open database|Login failed/);
  });

  it('reads only the tables its credential names, when it names tables', async () => {
    const r = await minted({ ...dbs.credential, schemas: [], tables: ['app.contacts'] });
    expect(await refusal(r, 'SELECT phone FROM app.contacts')).toBe('no refusal');
    expect(await refusal(r, 'SELECT * FROM app.users')).toBe('The SELECT permission was denied on the object \'users\', database \'' + dbs.a + '\', schema \'app\'.');
  });

  it('is never handed out when it could change something: a person takes the permission from public first', async () => {
    await dbs.admin('CREATE TABLE app.open_t (id int); GRANT INSERT ON app.open_t TO public');
    try {
      const r = role();
      await expect(reader.mint(dbs.credential, { role: r, password: PASSWORD, validUntil: soon() })).rejects.toThrow('the database read role could change [app].[open_t]: take that permission from public, or name other schemas or tables');
      expect(await exists(r)).toEqual({ login: false, user: false });
    } finally {
      await dbs.admin('DROP TABLE app.open_t');
    }
    await dbs.admin("EXEC('CREATE PROCEDURE app.wipe AS DELETE FROM app.users'); GRANT EXECUTE ON app.wipe TO public");
    try {
      await expect(reader.mint(dbs.credential, { role: role(), password: PASSWORD, validUntil: soon() })).rejects.toThrow('the database read role could change [app].[wipe]');
    } finally {
      await dbs.admin('DROP PROCEDURE app.wipe');
    }
  });

  it('is sent as a hash, never the password', () => {
    const h = sqlServerPasswordHash('pencil', Buffer.from('salt'));
    expect(h).toMatch(/^0x0200[0-9A-F]{8}[0-9A-F]{128}$/);
    expect(h.slice(6, 14)).toBe(Buffer.from('salt').toString('hex').toUpperCase());
    expect(h).not.toContain(Buffer.from('pencil', 'utf16le').toString('hex').toUpperCase());
  });
});

describe('a SQL Server read (issue #2231)', () => {
  it('answers the SELECT as CSV with a header', async () => {
    const r = await minted();
    expect(await reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT id, email, note, seen, active FROM app.users ORDER BY id;' }))
      .toEqual({ csv: 'id,email,note,seen,active\n1,a@example.test,,2026-10-20T12:00:00.000Z,1\n2,b@example.test,"say ""hi"", twice",,0\n', rows: 2, bytes: 111 });
  });

  it('reads a join of two tables', async () => {
    const r = await minted();
    expect((await reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT u.email, c.phone FROM app.users u JOIN app.contacts c ON c.user_id = u.id' })).csv)
      .toBe('email,phone\na@example.test,555-0100\n');
  });

  it('answers one result set only, and changes nothing', async () => {
    const r = await minted();
    await expect(reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT 1 AS a; SELECT 2 AS b' })).rejects.toThrow('the statement answered more than one result set: a database read runs one SELECT');
    await expect(reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT 1 AS a; DELETE FROM app.users' })).rejects.toThrow("The DELETE permission was denied on the object 'users'");
    await expect(reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'DECLARE @x int = 1' })).rejects.toThrow('the statement answered no result set: a database read runs one SELECT');
    expect(await dbs.admin('SELECT COUNT(*) AS n FROM app.users')).toEqual([{ n: 2 }]);
  });

  it('is refused past its cap, never cut', async () => {
    const r = await minted();
    await expect(createSqlServerReader({ maxRows: 1 }).read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT id FROM app.users' }))
      .rejects.toThrow('the answer passed 1 rows: narrow the query, or page it (WHERE on a key, ORDER BY and OFFSET … FETCH)');
    await expect(createSqlServerReader({ maxBytes: 10 }).read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT email FROM app.users' }))
      .rejects.toThrow('the answer passed 10 bytes');
  });
});

describe('the end of a SQL Server database read role (issue #2231)', () => {
  it('drops its login and its user, and ends its sessions', async () => {
    const r = await minted();
    const held = await dbs.connectAs(r, PASSWORD, dbs.a);
    await reader.drop(dbs.credential, r);
    expect(await exists(r)).toEqual({ login: false, user: false });
    await expect(held.request().query('SELECT 1')).rejects.toThrow();
    await held.close().catch(() => {});
    await reader.drop(dbs.credential, r);
  });

  it('sweeps a role older than the TTL and a user whose login is gone, and leaves a new one', async () => {
    const old = await minted(), orphan = await minted();
    await dbs.admin(`DROP LOGIN [${orphan}]`, 'master');
    await new Promise((r) => setTimeout(r, 2500));
    const kept = await minted();
    // SQL Server has no VALID UNTIL: the sweep goes by the login's age, here a TTL of 2 s.
    const swept = await createSqlServerReader({ ttlSeconds: 2 }).sweep(dbs.credential);
    expect(swept).toEqual(expect.arrayContaining([old, orphan]));
    expect(swept).not.toContain(kept);
    expect(await exists(old)).toEqual({ login: false, user: false });
    expect(await exists(orphan)).toEqual({ login: false, user: false });
    expect(await exists(kept)).toEqual({ login: true, user: true });
  });
});
