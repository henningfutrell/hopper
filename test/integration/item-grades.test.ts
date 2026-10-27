// Item grades (issue #2845 part 5, design.md "Item grades") over the real HTTP server and database: the grade pass grades
// each work item that ended done or failed from its jobs' grades, and grades it again when one of its jobs is graded
// again; GET /api/grades/item answers its grade, its user grade and the history; a person gives and edits an item's user
// grade, kept across a restart; GET /api/grades/items rolls the items up.
//
// Feature: item grades over the API
//   Scenario: a failed item gets the grade of its one job; a rework of that job grades the item again, lower
//   Scenario: an item that has not ended done or failed has no grade
//   Scenario: a person gives an item a user grade with a note, edits it, and both stay after a restart; the rollup counts it
//   Scenario: an unknown item, an item not ended and a bad score are refused
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobGradeView } from '../../src/domain/grades.ts';
import type { ItemGradesView, ItemGradeView } from '../../src/domain/item-grades.ts';
import { keepGrades } from '../../src/engine/grades.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(dbPath?: string): Promise<{ a: TestApp; dbPath: string }> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  const a = await startTestApp({ dbPath: path });
  apps.push(a);
  return { a, dbPath: path };
}

const itemOf = async (a: TestApp, key: string) => (await a.api<ItemGradeView>('GET', `/api/grades/item?key=${encodeURIComponent(key)}`)).body;

/** A failed job's item, its hand-off cleared, so the item ended failed. */
async function failedItem(a: TestApp): Promise<{ jobId: string; key: string }> {
  const job = await a.pull({ op: 'fail' });
  await a.waitForStatus(job.id, 'failed', 20_000);
  await vi.waitFor(() => expect(a.user().store.workItems.get(job.source!.key)?.state).toBe('needs_you'), { timeout: 10_000 });
  a.user().store.events.append({ type: 'handoff.closed', jobId: job.id, data: { handoffId: 'h1', end: 'cleared' } });
  expect(a.user().store.workItems.get(job.source!.key)?.state).toBe('failed');
  return { jobId: job.id, key: job.source!.key };
}

describe('item grades over the API', () => {
  it('grades a failed item from its job, again at a rework of that job, and not an item that has not ended', async () => {
    const { a } = await boot();
    const { jobId, key } = await failedItem(a);
    const done = await a.pull({ op: 'echo', message: 'hi' });
    await a.waitForStatus(done.id, 'finished', 20_000);
    keepGrades(a.user().store, new Date());

    const job = (await a.api<JobGradeView>('GET', `/api/jobs/${jobId}/grade`)).body;
    const first = await itemOf(a, key);
    expect(first.grade).toMatchObject({ key, state: 'failed', executor: 'scripted', kind: 'code', jobs: [{ jobId, score: job.grade!.auto.score }] });
    expect(first.grade!.auto).toEqual(job.grade!.auto);
    expect(a.user().store.workItems.get(done.source!.key)?.state).not.toMatch(/^(done|failed)$/);
    expect((await itemOf(a, done.source!.key)).grade).toBeUndefined();

    a.user().store.events.append({ type: 'job.rework_requested', jobId, data: { pullRequest: 'https://github.com/octo/shed/pull/11', notes: 'again', nextJobId: 'j-next' } });
    keepGrades(a.user().store, new Date());
    const again = await itemOf(a, key);
    expect(again.grade!.auto.lines.find((l) => l.signal === 'rework')).toMatchObject({ value: 0.5 });
    expect(again.grade!.auto.score).toBeLessThan(first.grade!.auto.score);
  });

  it('keeps an item\'s user grade and its edits across a restart, and rolls the items up', async () => {
    const { a, dbPath } = await boot();
    const { key } = await failedItem(a);
    keepGrades(a.user().store, new Date());
    const token = await a.login();
    const r = await a.ui<ItemGradeView>('/ui/api/grades/item', { key, score: 4, note: 'the whole issue went well' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ score: 4, note: 'the whole issue went well', by: expect.any(String) });
    await new Promise((res) => setTimeout(res, 5));
    expect((await a.ui('/ui/api/grades/item', { key, score: 5 }, { token })).status).toBe(200);
    await a.stop();
    apps.splice(apps.indexOf(a), 1);

    const { a: b } = await boot(dbPath);
    const v = await itemOf(b, key);
    expect(v.user).toMatchObject({ score: 5 });
    expect(v.history.map((h) => h.score)).toEqual([5, 4]);
    expect(v.disagree).toBe(Math.abs(v.grade!.auto.score - 100) >= 40);

    const roll = (await b.api<ItemGradesView>('GET', '/api/grades/items?by=executor')).body;
    expect(roll.groups).toEqual([expect.objectContaining({ key: 'scripted', jobs: 1, userGraded: 1, user: 5 })]);
    expect(roll.items).toEqual([expect.objectContaining({ key, state: 'failed', jobs: 1, user: 5 })]);
  });

  it('refuses an unknown item, an item that has not ended and a bad score', async () => {
    const { a } = await boot();
    const token = await a.login();
    const { key } = await failedItem(a);
    const running = await a.pull({ op: 'sleep', ms: 60_000 });
    await a.waitForStatus(running.id, 'running');
    const unknown = 'https://github.com/octo/shed/issues/999';
    expect((await a.ui('/ui/api/grades/item', { key, score: 0 }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/grades/item', { key: unknown, score: 3 }, { token })).status).toBe(404);
    expect((await a.ui('/ui/api/grades/item', { key: running.source!.key, score: 3 }, { token })).status).toBe(409);
    expect((await a.api('GET', `/api/grades/item?key=${encodeURIComponent(unknown)}`)).status).toBe(404);
    expect((await a.api('GET', '/api/grades/items?by=colour')).status).toBe(400);
  });
});
