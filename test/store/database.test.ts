// HOPPER_DATABASE_URL: the Postgres the store opens (design.md "Database"). Postgres is the only
// store (issue #53): there is one implementation, and anything that is not a Postgres URL is refused.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StoreError } from '../../src/domain/store-error.ts';
import { numberPlaceholders, openDb, parseDatabaseUrl } from '../../src/store/db.ts';
import { testPostgres } from '../support/database.ts';
import { stallingProxy } from '../support/stalling-proxy.ts';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('parseDatabaseUrl', () => {
  it('reads postgres URLs', () => {
    expect(parseDatabaseUrl('postgres://u:p@db:5432/jh')).toBe('postgres://u:p@db:5432/jh');
    expect(parseDatabaseUrl('postgresql://u@db/jh?sslmode=require')).toBe('postgresql://u@db/jh?sslmode=require');
  });

  it('refuses anything else, a SQLite file included', () => {
    for (const url of ['sqlite:/var/lib/jh/db.sqlite', 'sqlite://data/db.sqlite', '/home/x/db.sqlite', 'mysql://db/jh']) {
      expect(() => parseDatabaseUrl(url)).toThrow(/must be postgres:\/\//);
    }
  });
});

describe('one store implementation', () => {
  it('no source file opens SQLite', () => {
    const root = join(import.meta.dirname, '..', '..', 'src');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /node:sqlite|DatabaseSync/.test(readFileSync(join(root, f), 'utf8')))).toEqual([]);
  });
});

describe('numberPlaceholders', () => {
  it('numbers ? in order', () => {
    expect(numberPlaceholders('SELECT a FROM t WHERE b = ? AND c IN (?, ?) LIMIT ?')).toBe('SELECT a FROM t WHERE b = $1 AND c IN ($2, $3) LIMIT $4');
  });
});

describe('postgres', () => {
  it('keeps the store in the schema the URL names, created when absent, and each user\'s tables in a schema beside it', () => {
    const url = t.url();
    const s = t.open(url);
    const j = s.jobs.create(spec, 50);
    s.close();
    const schema = new URL(url).searchParams.get('schema')!;
    const db = openDb(testPostgres());
    expect(db.get('SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', schema, 'users')).toEqual({ n: 1 });
    expect(db.get('SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', `${schema}_u_admin`, 'jobs')).toEqual({ n: 1 });
    db.close();
    const again = t.open(url);
    expect(again.jobs.get(j.id)).toEqual(j);
    again.close();
  });

  it('two stores open at once keep their own databases and transactions', () => {
    const a = t.open(t.url());
    const b = t.open(t.url());
    const ja = a.jobs.create(spec, 1);
    expect(() => b.tx(() => { b.jobs.create(spec, 2); throw new Error('b rolls back'); })).toThrow('b rolls back');
    a.close();
    expect(b.jobs.list()).toEqual([]);
    expect(() => a.jobs.get(ja.id)).toThrow(/closed/);
    b.close();
  });

  it('a seq comes back as a number', () => {
    const s = t.open(t.url());
    const e = s.events.append({ type: 'job.queued', data: {} });
    expect(typeof e.seq).toBe('number');
    expect(s.events.since(0)[0]!.seq).toBe(e.seq);
    s.close();
  });

  it('a failing statement names postgres and its code, and the connection stays usable', () => {
    const db = openDb(t.url());
    db.exec('CREATE TABLE x (id TEXT PRIMARY KEY)');
    db.run('INSERT INTO x (id) VALUES (?)', 'a');
    expect(() => db.run('INSERT INTO x (id) VALUES (?)', 'a')).toThrow(/postgres: .*\(23505\)/);
    // A StoreError (issue #1961): the failure sweep tells the store's failure from one of the data it assesses.
    expect(() => db.run('INSERT INTO x (id) VALUES (?)', 'a')).toThrow(StoreError);
    expect(db.all('SELECT id FROM x')).toEqual([{ id: 'a' }]);
    db.close();
  });

  it('connects again after the server drops the connection', () => {
    const url = t.url();
    const db = openDb(url);
    const pid = db.get('SELECT pg_backend_pid() AS pid')!.pid as number;
    const admin = openDb(testPostgres());
    admin.get('SELECT pg_terminate_backend(?)', pid);
    admin.close();
    // The call the drop broke may fail; the one after it connects again.
    try { db.get('SELECT 1 AS one'); } catch { /* the broken call */ }
    expect(db.get('SELECT 1 AS one')).toEqual({ one: 1 });
    db.close();
  });

  // Issue #1003: a call that waited for no answer left its connection busy, so every call after it
  // waited its full time too, and the daemon answered no request while its timers still ran.
  it('a statement that waits on a lock fails in its time, and the next call on the connection answers at once', () => {
    const url = t.url();
    const holder = openDb(url);
    holder.exec('CREATE TABLE x (id TEXT PRIMARY KEY, n INTEGER)');
    holder.run('INSERT INTO x (id, n) VALUES (?, ?)', 'a', 0);
    holder.exec('BEGIN');
    holder.run('UPDATE x SET n = 1 WHERE id = ?', 'a');
    const db = openDb(url, { timeoutMs: 1000 });
    let started = performance.now();
    expect(() => db.run('UPDATE x SET n = 2 WHERE id = ?', 'a')).toThrow(/postgres: .*\(57014\)/);
    expect(() => db.run('UPDATE x SET n = 2 WHERE id = ?', 'a')).toThrow(StoreError);
    expect(performance.now() - started).toBeLessThan(5000);
    started = performance.now();
    expect(db.get('SELECT 1 AS one')).toEqual({ one: 1 });
    expect(performance.now() - started).toBeLessThan(1000);
    holder.exec('ROLLBACK');
    holder.close();
    db.close();
  });

  it('a connection that stops answering is dropped in its time, and the next call connects again', async () => {
    const proxy = await stallingProxy(t.url());
    try {
      const db = openDb(proxy.url, { timeoutMs: 1000 });
      expect(db.get('SELECT 1 AS one')).toEqual({ one: 1 });
      await proxy.stall(true);
      let started = performance.now();
      expect(() => db.get('SELECT 2 AS two')).toThrow(/postgres: no answer in 1\.1 s/);
      expect(performance.now() - started).toBeLessThan(5000);
      await proxy.stall(false);
      started = performance.now();
      expect(db.get('SELECT 3 AS three')).toEqual({ three: 3 });
      expect(performance.now() - started).toBeLessThan(1000);
      db.close();
    } finally {
      await proxy.close();
    }
  });

  it('a connection dropped inside a transaction fails the transaction, and the store works after its rollback', async () => {
    const proxy = await stallingProxy(t.url());
    try {
      const db = openDb(proxy.url, { timeoutMs: 1000 });
      db.exec('CREATE TABLE x (id TEXT PRIMARY KEY)');
      db.exec('BEGIN');
      db.run('INSERT INTO x (id) VALUES (?)', 'a');
      await proxy.stall(true);
      expect(() => db.run('INSERT INTO x (id) VALUES (?)', 'b')).toThrow(/postgres: no answer/);
      await proxy.stall(false);
      expect(() => db.run('INSERT INTO x (id) VALUES (?)', 'c')).toThrow(/lost inside a transaction/);
      db.exec('ROLLBACK');
      expect(db.all('SELECT id FROM x')).toEqual([]);
      db.close();
    } finally {
      await proxy.close();
    }
  });

  it('a transaction rolled back leaves nothing, a committed one everything', () => {
    const s = t.open(t.url());
    expect(() => s.tx(() => { s.jobs.create(spec, 1); throw new Error('no'); })).toThrow('no');
    expect(s.jobs.list()).toEqual([]);
    s.tx(() => { s.jobs.create(spec, 1); s.lanes.open('m'); });
    expect(s.jobs.list()).toHaveLength(1);
    expect(s.lanes.list()).toHaveLength(1);
    s.close();
  });
});
