// A filtered job or failure list makes Postgres parse no body (issue #1154): each filter on a field of the JSON body
// cast every row's body to JSON, about 20 KB a job, on every list, while the event loop waited. The fields filtered on
// are generated columns now, which Postgres keeps at each write of the row, whoever writes it.
import { describe, expect, it } from 'vitest';
import type { Db, Param } from '../../src/store/db.ts';
import { createContext } from '../../src/store/context.ts';
import { createJobRepository } from '../../src/store/jobs.ts';
import { createFailureRepository } from '../../src/store/failures.ts';
import { JOB_FILTER_COLUMNS } from '../../src/store/job-filter-columns.ts';
import { migrateTenant, TENANT_SCHEMA_VERSION } from '../../src/store/tenant-migrations.ts';
import { RECENT_TENANT_MIGRATIONS } from '../../src/store/tenant-migrations-recent.ts';
import type { FailureRecord } from '../../src/domain/types.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();
/** The tenant version that adds the columns. */
const VERSION = TENANT_SCHEMA_VERSION - RECENT_TENANT_MIGRATIONS.length + RECENT_TENANT_MIGRATIONS.indexOf(JOB_FILTER_COLUMNS) + 1;

function open(db: Db) {
  const sent: string[] = [];
  const spied: Db = {
    ...db,
    get: (sql: string, ...p: Param[]) => { sent.push(sql); return db.get(sql, ...p); },
    all: (sql: string, ...p: Param[]) => { sent.push(sql); return db.all(sql, ...p); },
    run: (sql: string, ...p: Param[]) => { sent.push(sql); return db.run(sql, ...p); },
  };
  let n = 0;
  const ctx = createContext({ db: spied, clock: fixedClock(), idGen: () => `i${++n}` });
  return { jobs: createJobRepository(ctx), failures: createFailureRepository(ctx), sent };
}

/** A job row as the build before writes it: status and body only. */
function writeBody(db: Db, id: string, change: (b: Record<string, unknown>) => Record<string, unknown>): void {
  const body = JSON.parse(String(db.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as Record<string, unknown>;
  db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(change(body)), id);
}
const follow = (f: string | undefined, pr?: string) => (b: Record<string, unknown>) =>
  ({ ...b, sourceState: { source: { ...(f ? { follow: f } : {}), ...(pr ? { pullRequest: pr } : {}) } } });

/** Five jobs, j1 to j5, with each filtered field set on one of them or more. */
function seed(db: Db): void {
  const { jobs } = open(db);
  for (let i = 0; i < 5; i++) jobs.create(spec, i);
  writeBody(db, 'i1', follow('open', 'https://x/pull/1'));
  writeBody(db, 'i2', follow('merged', 'https://x/pull/2'));
  writeBody(db, 'i3', (b) => ({ ...follow(undefined, 'https://x/pull/3')(b), assessment: { kind: 'x' } }));
  writeBody(db, 'i4', (b) => ({ ...follow('tended')(b), dismissedAt: '2026-10-15T00:00:00.000Z', assessment: null }));
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

function expectFilters(db: Db): void {
  const { jobs, sent } = open(db);
  expect(ids(jobs.list({ followed: true }))).toEqual(['i1', 'i4']);
  expect(ids(jobs.list({ namesPullRequest: true }))).toEqual(['i1', 'i3']);
  // A JSON null is a value: the job is assessed, as before.
  expect(ids(jobs.list({ unassessed: true }))).toEqual(['i1', 'i2', 'i5']);
  expect(ids(jobs.list({ undismissed: true }))).toEqual(['i1', 'i2', 'i3', 'i5']);
  expect(sent.filter((s) => s.includes('::jsonb'))).toEqual([]);
}

describe('job and failure filters read columns, not bodies (issue #1154)', () => {
  it('rows written before the migration are filtered as before', () => {
    const db = t.tenantAt(t.url(), VERSION - 1);
    seed(db);
    migrateTenant(db, VERSION);
    expectFilters(db);
    db.close();
  });

  it('a row written after it, by this build or the build before, is filtered by its newest body', () => {
    const db = t.tenantAt(t.url(), TENANT_SCHEMA_VERSION);
    seed(db);
    expectFilters(db);
    writeBody(db, 'i2', follow('closed', 'https://x/pull/2'));
    open(db).jobs.update('i1', { sourceState: { source: { follow: 'merged', pullRequest: 'https://x/pull/1' } } } as never);
    const { jobs } = open(db);
    expect(ids(jobs.list({ followed: true }))).toEqual(['i2', 'i4']);
    expect(ids(jobs.list({ namesPullRequest: true }))).toEqual(['i2', 'i3']);
    db.close();
  });

  it('a failure list by problem and outcome makes Postgres parse no body', () => {
    const db = t.tenantAt(t.url(), TENANT_SCHEMA_VERSION);
    const { failures, sent } = open(db);
    const base = { signature: 's', at: '2026-10-15T00:00:00.000Z' } as Omit<FailureRecord, 'id' | 'jobId'>;
    failures.create({ ...base, jobId: 'a', problemId: 'p1', outcome: 'retried' } as never);
    failures.create({ ...base, jobId: 'b', problemId: 'p1' } as never);
    failures.create({ ...base, jobId: 'c', problemId: 'p2', outcome: 'held' } as never);
    const jobsOf = (xs: FailureRecord[]) => xs.map((x) => x.jobId).sort();
    expect(jobsOf(failures.list({ problemId: 'p1' }))).toEqual(['a', 'b']);
    expect(jobsOf(failures.list({ outcome: ['held', 'retried'] }))).toEqual(['a', 'c']);
    expect(jobsOf(failures.list({ notOutcome: ['held'] }))).toEqual(['a', 'b']);
    failures.update(failures.list({ problemId: 'p2' })[0]!.id, { problemId: 'p1' } as never);
    expect(jobsOf(failures.list({ problemId: 'p1' }))).toEqual(['a', 'b', 'c']);
    expect(sent.filter((s) => s.includes('::jsonb'))).toEqual([]);
    db.close();
  });
});
