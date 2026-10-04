// JOB_HOPPER_DATABASE_URL: which database the store opens (design.md "Database"). The Postgres
// cases run when JOB_HOPPER_TEST_POSTGRES_URL is set (scripts/test-postgres.sh), and are skipped
// otherwise; every other store test runs against whichever backend is under test.
import { describe, expect, it } from 'vitest';
import { numberPlaceholders, openDb, parseDatabaseUrl } from '../../src/store/db.ts';
import { testPostgres } from '../support/database.ts';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('parseDatabaseUrl', () => {
  it('reads sqlite:<path> and postgres URLs', () => {
    expect(parseDatabaseUrl('sqlite:/var/lib/jh/db.sqlite')).toEqual({ kind: 'sqlite', path: '/var/lib/jh/db.sqlite' });
    expect(parseDatabaseUrl('sqlite://data/db.sqlite')).toEqual({ kind: 'sqlite', path: 'data/db.sqlite' });
    expect(parseDatabaseUrl('postgres://u:p@db:5432/jh')).toEqual({ kind: 'postgres', url: 'postgres://u:p@db:5432/jh' });
    expect(parseDatabaseUrl('postgresql://u@db/jh')).toEqual({ kind: 'postgres', url: 'postgresql://u@db/jh' });
  });

  it('refuses anything else', () => {
    expect(() => parseDatabaseUrl('/home/x/db.sqlite')).toThrow(/sqlite:<path> or postgres:/);
    expect(() => parseDatabaseUrl('mysql://db/jh')).toThrow(/sqlite:<path> or postgres:/);
  });
});

describe('numberPlaceholders', () => {
  it('numbers ? in order', () => {
    expect(numberPlaceholders('SELECT a FROM t WHERE b = ? AND c IN (?, ?) LIMIT ?')).toBe('SELECT a FROM t WHERE b = $1 AND c IN ($2, $3) LIMIT $4');
  });
});

describe.runIf(testPostgres())('postgres', () => {
  it('keeps the store in the schema the URL names, created when absent', () => {
    const url = t.url();
    const s = t.open(url);
    const j = s.jobs.create(spec, 50);
    s.close();
    const schema = new URL(url).searchParams.get('schema')!;
    const db = openDb({ kind: 'postgres', url: testPostgres()! });
    expect(db.get('SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', schema, 'jobs')).toEqual({ n: 1 });
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
    const db = openDb({ kind: 'postgres', url: t.url() });
    db.exec('CREATE TABLE x (id TEXT PRIMARY KEY)');
    db.run('INSERT INTO x (id) VALUES (?)', 'a');
    expect(() => db.run('INSERT INTO x (id) VALUES (?)', 'a')).toThrow(/postgres: .*\(23505\)/);
    expect(db.all('SELECT id FROM x')).toEqual([{ id: 'a' }]);
    db.close();
  });

  it('connects again after the server drops the connection', () => {
    const url = t.url();
    const db = openDb({ kind: 'postgres', url });
    const pid = db.get('SELECT pg_backend_pid() AS pid')!.pid as number;
    const admin = openDb({ kind: 'postgres', url: testPostgres()! });
    admin.get('SELECT pg_terminate_backend(?)', pid);
    admin.close();
    // The call the drop broke may fail; the one after it connects again.
    try { db.get('SELECT 1 AS one'); } catch { /* the broken call */ }
    expect(db.get('SELECT 1 AS one')).toEqual({ one: 1 });
    db.close();
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
