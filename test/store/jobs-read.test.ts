// A job list reads only the rows that changed since this store last read them (issue #1154): every list of the
// whole table sent each job's body and parsed it on the event loop, about one a second.
import { describe, expect, it } from 'vitest';
import type { Db, Param } from '../../src/store/db.ts';
import { createContext } from '../../src/store/context.ts';
import { createJobRepository } from '../../src/store/jobs.ts';
import { TENANT_SCHEMA_VERSION } from '../../src/store/tenant-migrations.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();

/** The tenant schema, migrated, and every statement the repository sends, kept. */
function openJobs() {
  const db = t.tenantAt(t.url(), TENANT_SCHEMA_VERSION);
  const sent: string[] = [];
  const spied: Db = {
    ...db,
    get: (sql: string, ...p: Param[]) => { sent.push(sql); return db.get(sql, ...p); },
    all: (sql: string, ...p: Param[]) => { sent.push(sql); return db.all(sql, ...p); },
    run: (sql: string, ...p: Param[]) => { sent.push(sql); return db.run(sql, ...p); },
  };
  let n = 0;
  const ctx = createContext({ db: spied, clock: fixedClock(), idGen: () => `j${++n}` });
  return { jobs: createJobRepository(ctx), ctx, db, sent };
}

const bodiesRead = (sent: string[]) => sent.filter((s) => /\bbody\b/.test(s.split(/\bFROM\b/)[0]!)).length;

describe('job reads (issue #1154)', () => {
  it('a second list of unchanged jobs reads no body', () => {
    const { jobs, db, sent } = openJobs();
    jobs.create(spec, 1);
    jobs.create(spec, 2);
    expect(jobs.list().map((j) => j.id)).toEqual(['j2', 'j1']);
    sent.length = 0;
    expect(jobs.list().map((j) => j.id)).toEqual(['j2', 'j1']);
    expect(jobs.list({ status: ['queued'] })).toHaveLength(2);
    expect(bodiesRead(sent)).toBe(0);
    db.close();
  });

  it('a list sees an update, its own or one written past the repository', () => {
    const { jobs, db } = openJobs();
    const a = jobs.create(spec, 1);
    jobs.list();
    jobs.update(a.id, { status: 'running' });
    expect(jobs.list()[0]).toMatchObject({ status: 'running' });
    const body = JSON.parse(String(db.get('SELECT body FROM jobs WHERE id = ?', a.id)!.body)) as Record<string, unknown>;
    db.run('UPDATE jobs SET status = ?, body = ? WHERE id = ?', 'finished', JSON.stringify({ ...body, status: 'finished' }), a.id);
    expect(jobs.list()[0]).toMatchObject({ status: 'finished' });
    expect(jobs.get(a.id)).toMatchObject({ status: 'finished' });
    db.close();
  });

  it('two updates in one transaction, and a rolled back one, read right after', () => {
    const { jobs, ctx, db } = openJobs();
    const a = jobs.create(spec, 1);
    ctx.tx(() => {
      jobs.update(a.id, { status: 'running' });
      expect(jobs.list()[0]).toMatchObject({ status: 'running' });
      jobs.update(a.id, { status: 'finished' });
      expect(jobs.list()[0]).toMatchObject({ status: 'finished' });
    });
    expect(jobs.list()[0]).toMatchObject({ status: 'finished' });
    expect(() => ctx.tx(() => {
      jobs.update(a.id, { status: 'failed' });
      expect(jobs.list()[0]).toMatchObject({ status: 'failed' });
      throw new Error('roll back');
    })).toThrow('roll back');
    expect(jobs.list()[0]).toMatchObject({ status: 'finished' });
    expect(jobs.get(a.id)).toMatchObject({ status: 'finished' });
    db.close();
  });

  it('a job deleted under the store leaves the list', () => {
    const { jobs, db } = openJobs();
    const a = jobs.create(spec, 1);
    jobs.create(spec, 2);
    jobs.list();
    db.run('DELETE FROM jobs WHERE id = ?', a.id);
    expect(jobs.list().map((j) => j.id)).toEqual(['j2']);
    expect(jobs.get(a.id)).toBeUndefined();
    db.close();
  });
});
