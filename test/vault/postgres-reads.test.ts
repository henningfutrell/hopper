// Issue #2231: the Postgres side of a database read, against a real Postgres. A read role is minted with SELECT only on
// the schemas its minting credential names, read-only by default, short timeouts, two connections, VALID UNTIL its TTL;
// every write is refused, also after it turns the read-only default off; it reaches neither another schema nor another
// database; a read answers CSV up to a cap; a drop ends its sessions; the sweep drops a role whose VALID UNTIL passed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresReader, scramVerifier } from '../../src/vault/postgres-reads.ts';
import { READ_CONNECTION_LIMIT, READ_ROLE_TTL_SECONDS } from '../../src/domain/database-read.ts';
import { readDatabases, type ReadDatabases } from '../support/database-read.ts';

let dbs: ReadDatabases;
beforeAll(async () => { dbs = await readDatabases(); }, 60_000);
afterAll(async () => { await dbs?.close(); });

const reader = createPostgresReader();
let n = 0;
const role = (): string => `hopper_read_t${process.pid}x${(n++).toString(16)}${Date.now().toString(16)}`;
const soon = (): Date => new Date(Date.now() + READ_ROLE_TTL_SECONDS * 1000);
const PASSWORD = 'pw-of-the-read-role';

const minted = async (): Promise<string> => {
  const r = role();
  await reader.mint(dbs.credential, { role: r, password: PASSWORD, validUntil: soon() });
  return r;
};
const exists = async (r: string): Promise<boolean> => (await dbs.admin('SELECT 1 FROM pg_roles WHERE rolname = $1', [r])).rowCount === 1;
const refusal = async (r: string, sql: string | string[], db?: string): Promise<string> => {
  let c: Awaited<ReturnType<ReadDatabases['connectAs']>> | undefined;
  try {
    c = await dbs.connectAs(r, PASSWORD, db ?? dbs.a);
    for (const s of [sql].flat()) await c.query(s);
    return 'no refusal';
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c?.end().catch(() => {});
  }
};

describe('a read role (issue #2231)', () => {
  it('is a login of its own: two connections, VALID UNTIL within the TTL, nothing it may create', async () => {
    const before = Date.now();
    const r = await minted();
    const { rows: [a] } = await dbs.admin('SELECT rolcanlogin, rolconnlimit, rolvaliduntil, rolsuper, rolcreaterole, rolcreatedb, rolinherit FROM pg_roles WHERE rolname = $1', [r]);
    expect(a).toMatchObject({ rolcanlogin: true, rolconnlimit: READ_CONNECTION_LIMIT, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false });
    expect(new Date(a.rolvaliduntil).getTime()).toBeLessThanOrEqual(before + READ_ROLE_TTL_SECONDS * 1000 + 1000);
    const { rows: [s] } = await dbs.admin('SELECT setconfig FROM pg_db_role_setting WHERE setrole = (SELECT oid FROM pg_roles WHERE rolname = $1)', [r]);
    expect(s.setconfig).toEqual(expect.arrayContaining(['default_transaction_read_only=on', 'statement_timeout=60000', 'idle_in_transaction_session_timeout=30000']));
  });

  it('reads the schema it was granted', async () => {
    const r = await minted();
    const c = await dbs.connectAs(r, PASSWORD, dbs.a);
    expect((await c.query('SELECT count(*)::int AS n FROM app.users')).rows).toEqual([{ n: 2 }]);
    await c.end();
  });

  it('is refused every write, also with the read-only default turned off', async () => {
    const r = await minted();
    expect(await refusal(r, "INSERT INTO app.users VALUES (3, 'c', NULL)")).toBe('cannot execute INSERT in a read-only transaction');
    expect(await refusal(r, "UPDATE app.users SET email = 'x'")).toBe('cannot execute UPDATE in a read-only transaction');
    expect(await refusal(r, 'DELETE FROM app.users')).toBe('cannot execute DELETE in a read-only transaction');
    expect(await refusal(r, 'CREATE TABLE app.made (id int)')).toBe('cannot execute CREATE TABLE in a read-only transaction');
    expect(await refusal(r, ['SET default_transaction_read_only = off', "INSERT INTO app.users VALUES (3, 'c', NULL)"])).toBe('permission denied for table users');
    expect(await refusal(r, ['SET default_transaction_read_only = off', 'DELETE FROM app.users'])).toBe('permission denied for table users');
    expect(await refusal(r, ['SET default_transaction_read_only = off', 'CREATE TABLE app.made (id int)'])).toBe('permission denied for schema app');
    expect(await refusal(r, ['SET default_transaction_read_only = off', 'CREATE TABLE public.made (id int)'])).toBe('permission denied for schema public');
    expect(await refusal(r, ['BEGIN READ WRITE', "INSERT INTO app.users VALUES (3, 'c', NULL)"])).toBe('permission denied for table users');
    expect((await dbs.admin('SELECT count(*)::int AS n FROM app.users')).rows).toEqual([{ n: 2 }]);
  });

  it('reads no schema its credential does not name, and reaches no other database', async () => {
    const r = await minted();
    expect(await refusal(r, 'SELECT * FROM private.keys')).toBe('permission denied for schema private');
    expect(await refusal(r, 'SELECT 1', dbs.b)).toMatch(/permission denied for database|does not have CONNECT privilege/);
  });

  it('is never made when it could change something: a person takes the grant from PUBLIC first', async () => {
    await dbs.admin('CREATE TABLE app.open (id int); GRANT INSERT ON app.open TO PUBLIC');
    try {
      const r = role();
      await expect(reader.mint(dbs.credential, { role: r, password: PASSWORD, validUntil: soon() })).rejects.toThrow('the read role could change app.open: take that grant from PUBLIC, or name other schemas');
      expect(await exists(r)).toBe(false);
    } finally {
      await dbs.admin('DROP TABLE app.open');
    }
  });

  it('is sent as a SCRAM verifier, never the password', async () => {
    const v = scramVerifier('pencil', Buffer.from('salt-of-sixteen!'), 4096);
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:c2FsdC1vZi1zaXh0ZWVuIQ==\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    expect(v).not.toContain('pencil');
  });
});

describe('a read (issue #2231)', () => {
  it('answers the SELECT as CSV with a header', async () => {
    const r = await minted();
    expect(await reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT id, email, note FROM app.users ORDER BY id;' }))
      .toEqual({ csv: 'id,email,note\n1,a@example.test,\n2,b@example.test,"say ""hi"", twice"\n', rows: 2, bytes: 69 });
  });

  it('runs one SELECT only, in a read-only transaction', async () => {
    const r = await minted();
    await expect(reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT 1; DELETE FROM app.users' })).rejects.toThrow('cannot insert multiple commands into a prepared statement');
    await expect(reader.read(dbs.credential, { role: r, password: PASSWORD, sql: 'DELETE FROM app.users RETURNING id' })).rejects.toThrow(/syntax error/);
  });

  it('is refused past its cap, never cut', async () => {
    const r = await minted();
    const small = createPostgresReader({ maxRows: 1 });
    await expect(small.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT id FROM app.users' })).rejects.toThrow('the answer passed 1 rows: narrow the query, or page it (WHERE on a key, ORDER BY and LIMIT)');
    const tiny = createPostgresReader({ maxBytes: 10 });
    await expect(tiny.read(dbs.credential, { role: r, password: PASSWORD, sql: 'SELECT email FROM app.users' })).rejects.toThrow('the answer passed 10 bytes: narrow the query, or page it (WHERE on a key, ORDER BY and LIMIT)');
  });
});

describe('the end of a read role (issue #2231)', () => {
  it('drops it and ends its sessions', async () => {
    const r = await minted();
    const held = await dbs.connectAs(r, PASSWORD, dbs.a);
    await reader.drop(dbs.credential, r);
    expect(await exists(r)).toBe(false);
    await expect(held.query('SELECT 1')).rejects.toThrow();
    await reader.drop(dbs.credential, r);
  });

  it('sweeps a role whose VALID UNTIL passed, and leaves one that is still valid', async () => {
    const gone = role(), kept = await minted();
    await reader.mint(dbs.credential, { role: gone, password: PASSWORD, validUntil: new Date(Date.now() + 1000) });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await reader.sweep(dbs.credential)).toContain(gone);
    expect(await exists(gone)).toBe(false);
    expect(await exists(kept)).toBe(true);
  });
});
