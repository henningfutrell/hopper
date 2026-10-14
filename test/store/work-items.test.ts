// The work-item ledger in the database (issue #1067, tenant migration 55): the event log folds each event into its item
// in the append's transaction, a read of the issue graph settles it, a rebuild replays the same history to the same rows,
// and the migration fills the ledger from what the store holds already.
import { describe, expect, it } from 'vitest';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { migrateTenant, TENANT_SCHEMA_VERSION } from '../../src/store/tenant-migrations.ts';
import { RECENT_TENANT_MIGRATIONS } from '../../src/store/tenant-migrations-recent.ts';
import { workItemLedger } from '../../src/store/work-items.ts';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/1';
const KEY2 = 'https://github.com/o/r/issues/2';
const PR = 'https://github.com/o/r/pull/3';
const ref = (key: string, number: number): JobSourceRef => ({ source: 'github', kind: 'github', key, repo: 'o/r', number });

describe('the work-item ledger in the database', () => {
  it('moves each item in the transaction of its event, and a rebuild replays the same rows', () => {
    const store = t.open(t.url());
    const a = store.jobs.create(spec, 50, ref(KEY, 1));
    store.events.append({ type: 'job.queued', jobId: a.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.started', jobId: a.id, data: {} });
    store.events.append({ type: 'job.failed', jobId: a.id, data: { error: 'boom' } });
    const b = store.jobs.create(spec, 50, ref(KEY2, 2));
    store.events.append({ type: 'job.queued', jobId: b.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.finished', jobId: b.id, data: { result: 'pull request ready for review' } });
    store.events.append({ type: 'job.pull_request_followed', jobId: b.id, data: { pullRequest: PR, part: false } });

    expect(store.workItems.get(KEY)).toMatchObject({ state: 'failed', failedJobId: a.id });
    expect(store.workItems.get(KEY2)).toMatchObject({ state: 'pr_open', pullRequest: PR });
    expect(store.workItems.counts()).toMatchObject({ failed: 1, pr_open: 1, done: 0 });
    expect(store.workItems.list({ state: ['failed'] }).map((i) => i.key)).toEqual([KEY]);
    // A job's repo query of a pull request finds its item by the pull request (issue #1074).
    expect(store.workItems.byPullRequest(PR)?.key).toBe(KEY2);
    expect(store.workItems.byPullRequest('https://github.com/o/r/pull/99')).toBeUndefined();

    const live = store.workItems.list();
    expect(store.workItems.rebuild()).toBe(2);
    expect(store.workItems.list()).toEqual(live);
    store.close();
  });

  it('an event that fails rolls its item back with it', () => {
    const store = t.open(t.url());
    const a = store.jobs.create(spec, 50, ref(KEY, 1));
    store.events.append({ type: 'job.queued', jobId: a.id, data: { spec, priority: 50 } });
    expect(() => store.tx(() => {
      store.events.append({ type: 'job.failed', jobId: a.id, data: { error: 'boom' } });
      throw new Error('after the append');
    })).toThrow('after the append');
    expect(store.workItems.get(KEY)?.state).toBe('queued');
    store.close();
  });

  it('a read of the issue graph settles an item no job acts on', () => {
    const store = t.open(t.url());
    const a = store.jobs.create(spec, 50, ref(KEY, 1));
    store.events.append({ type: 'job.queued', jobId: a.id, data: { spec, priority: 50 }, at: '2026-10-13T10:00:00.000Z' });
    store.events.append({ type: 'job.failed', jobId: a.id, data: { error: 'boom' }, at: '2026-10-13T10:01:00.000Z' });
    store.issueGraph.record(KEY, { nodes: [{ id: KEY, kind: 'issue', attrs: { state: 'CLOSED', stateReason: 'COMPLETED' } }], edges: [] }, '2026-10-13T11:00:00.000Z');
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'done', issueState: 'closed', issueReason: 'completed' });
    const live = store.workItems.list();
    store.workItems.rebuild();
    expect(store.workItems.list()).toEqual(live);
    store.close();
  });

  it('a store opened with an event the ledger missed — the build before appended it — is rebuilt at open', () => {
    const url = t.url();
    const first = t.open(url);
    const a = first.jobs.create(spec, 50, ref(KEY, 1));
    first.events.append({ type: 'job.queued', jobId: a.id, data: { spec, priority: 50 } });
    first.close();
    // The build before writes the event and no ledger.
    const db = t.tenantAt(url, TENANT_SCHEMA_VERSION);
    db.run('INSERT INTO events (id, type, at, job_id, data) VALUES (?, ?, ?, ?, ?)', 'e-before', 'job.failed', '2026-10-13T10:05:00.000Z', a.id, '{"error":"boom"}');
    expect(db.get('SELECT state FROM work_items WHERE key = ?', KEY)).toEqual({ state: 'queued' });
    db.close();
    const again = t.open(url);
    expect(again.workItems.get(KEY)?.state).toBe('failed');
    again.close();
  });

  it('the migration fills the ledger from the jobs, the events and the issue graph already kept', () => {
    const url = t.url();
    // The version before the ledger's migration, wherever it lands in the list.
    const before = TENANT_SCHEMA_VERSION - (RECENT_TENANT_MIGRATIONS.length - RECENT_TENANT_MIGRATIONS.indexOf(workItemLedger));
    const db = t.tenantAt(url, before);
    db.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)', 'j1', 'failed', '2026-10-13T10:00:00.000Z', KEY, JSON.stringify({ id: 'j1', source: ref(KEY, 1) }));
    db.run('INSERT INTO events (id, type, at, job_id, data) VALUES (?, ?, ?, ?, ?)', 'e1', 'job.queued', '2026-10-13T10:00:00.000Z', 'j1', '{}');
    db.run('INSERT INTO events (id, type, at, job_id, data) VALUES (?, ?, ?, ?, ?)', 'e2', 'job.failed', '2026-10-13T10:01:00.000Z', 'j1', '{"error":"boom"}');
    db.run('INSERT INTO events (id, type, at, job_id, data) VALUES (?, ?, ?, ?, ?)', 'e3', 'job.dismissed', '2026-10-13T10:02:00.000Z', 'j1', '{"by":"user"}');
    migrateTenant(db);
    expect(db.all('SELECT key, state FROM work_items')).toEqual([{ key: KEY, state: 'dropped' }]);
    db.close();
  });
});
