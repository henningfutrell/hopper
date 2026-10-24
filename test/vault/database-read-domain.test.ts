// Issue #2231: a database read. The asset kind `database` takes read only; its read is high radius, so only its own
// approval approves it and the read policy never holds it. Its minting credential is one JSON value: where the database
// is, the login that mints the database read roles, and the schemas a database read role may SELECT from.
import { describe, expect, it } from 'vitest';
import { profileProblem } from '../../src/domain/access.ts';
import { highRadius } from '../../src/blast-radius/template.ts';
import { inReadPolicy, readPolicyProblem } from '../../src/domain/read-policy.ts';
import { mintingValueProblem, mintsForProblem } from '../../src/domain/minting.ts';
import { csvOf, databaseCredentialOf, DATABASE_ROLE_PREFIX, databaseRoleName, sqlProblem } from '../../src/domain/database-read.ts';

const DB = { kind: 'database', name: 'lab/apps/orders' } as const;
const value = (v: Record<string, unknown>): string => JSON.stringify({ engine: 'postgres', host: 'db.lab.internal', database: 'orders', user: 'hopper_minter', password: 'p', schemas: ['public'], ...v });

describe('the database asset kind (issue #2231)', () => {
  it('takes read only', () => {
    expect(profileProblem({ operation: 'read', asset: DB })).toBeUndefined();
    expect(profileProblem({ operation: 'write', asset: DB })).toBe('database lab/apps/orders takes read only, not write: the hopper reads a database, never changes it');
    expect(profileProblem({ operation: 'observe', asset: DB })).toContain('takes read only');
  });

  it('is high radius: its read reads rows of data, so only its own approval approves it', () => {
    expect(highRadius({ operation: 'read', asset: DB })).toBe(true);
    expect(highRadius({ operation: 'read', asset: { kind: 'cluster', name: 'lab' } })).toBe(false);
  });

  it('is never held by the read policy', () => {
    expect(inReadPolicy({ assets: ['database/*'] }, DB)).toBe(false);
    expect(readPolicyProblem(['database/lab/*'])).toBe('database/lab/*: the read policy holds no database: a person approves each database read');
  });

  it('is what a minting credential mints for, by its whole name', () => {
    expect(mintsForProblem(DB)).toBeUndefined();
    expect(mintsForProblem({ kind: 'database', name: 'lab apps' })).toContain('is not a name');
  });
});

describe('a database minting credential (issue #2231)', () => {
  it('is read with its defaults: port 5432, TLS checked', () => {
    expect(databaseCredentialOf(value({}))).toEqual({ engine: 'postgres', host: 'db.lab.internal', port: 5432, database: 'orders', user: 'hopper_minter', password: 'p', sslmode: 'verify-full', schemas: ['public'] });
  });

  it('keeps a port, a TLS mode and a CA', () => {
    expect(databaseCredentialOf(value({ port: 6432, sslmode: 'require', ca: '-----BEGIN CERTIFICATE-----' }))).toMatchObject({ port: 6432, sslmode: 'require', ca: '-----BEGIN CERTIFICATE-----' });
  });

  it('says what is wrong, never the value', () => {
    expect(databaseCredentialOf('nope')).toBe('a database minting credential holds JSON with engine (postgres), host, database, user, password and schemas (and port, sslmode or ca when it has them)');
    expect(databaseCredentialOf(value({ engine: 'mysql' }))).toBe('a database minting credential\'s engine is postgres');
    expect(databaseCredentialOf(value({ schemas: [] }))).toBe('a database minting credential names schemas: the schemas a database read role may SELECT from, at least one');
    expect(databaseCredentialOf(value({ schemas: ['a"b'] }))).toBe('a database minting credential\'s schema "a\\"b" is no plain schema name (letters, digits, _ and $)');
    expect(databaseCredentialOf(value({ port: 0 }))).toBe('a database minting credential\'s port is 1 to 65535');
    expect(databaseCredentialOf(value({ sslmode: 'prefer' }))).toBe('a database minting credential\'s sslmode is verify-full, require or disable');
    expect(databaseCredentialOf(value({ password: 'secret-value', host: '' }))).not.toContain('secret-value');
  });

  it('is checked when a person saves it', () => {
    expect(mintingValueProblem(DB, value({}))).toBeUndefined();
    expect(mintingValueProblem(DB, '{}')).toMatch(/^mints for database lab\/apps\/orders: a database minting credential holds JSON/);
  });
});

describe('a read (issue #2231)', () => {
  it('is one statement of SQL, at most 64 KiB', () => {
    expect(sqlProblem('SELECT 1')).toBeUndefined();
    expect(sqlProblem('  ')).toBe('name the SELECT to run with --sql');
    expect(sqlProblem('x'.repeat(64 * 1024 + 1))).toBe('--sql is at most 65536 bytes');
  });

  it('runs as a role of its own, named for nothing but a random id', () => {
    expect(databaseRoleName('0123456789abcdef')).toBe(`${DATABASE_ROLE_PREFIX}0123456789abcdef`);
    expect(DATABASE_ROLE_PREFIX).toBe('hopper_read_');
  });

  it('answers CSV with a header: NULL empty, an empty string quoted', () => {
    expect(csvOf(['id', 'name', 'note'], [['1', 'a,b', null], ['2', 'say "hi"', ''], ['3', 'two\nlines', 'x']])).toBe('id,name,note\n1,"a,b",\n2,"say ""hi""",""\n3,"two\nlines",x\n');
  });
});
