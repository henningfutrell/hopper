// Issue #425 (tracking issue #424, part 1): the pointed job record. A pointed job points at work in a GitHub repository —
// an issue or a pull request — with a directive, a lane once it has one, and a status that moves only along the allowed
// transitions, each one an event. The jobs the hopper already has show as pointed jobs, their status read from the job.
// The daemon, store and HTTP edge are real.
//
// Feature: Pointed jobs
//   Scenario: a person makes a pointed job, reads it and lists it
//     When the person makes a pointed job on an issue of a repository
//     Then it is queued, with no lane, made by the API, and pointed_job.created is in the log
//     And it reads back by its id, and the list has it
//   Scenario: a pointed job moves through its statuses
//     Given a queued pointed job
//     When it is moved to running on a lane, then to awaiting review, then to merged
//     Then each move is a pointed_job.status_changed event with the status before and after
//     And the lane goes once it leaves running
//   Scenario: an illegal transition is refused
//     Given a merged pointed job
//     When it is moved to running
//     Then it is refused (409), and nothing is recorded
//   Scenario: the jobs the hopper already has show as pointed jobs
//     Given a finished job of an issue, and a job of no repository
//     Then the list has the finished job as a pointed job on its issue, merged, and not the other
//     And it cannot be moved through the pointed job API: its status follows its job
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import type { PointedJob } from '../../src/domain/pointed-jobs.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function start() {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({ dbPath: db.dbPath });
  apps.push(app);
  return { app, token: await app.login() };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const ISSUE = { repo: 'octo-org/hello', pointer: { kind: 'issue', number: 7, url: 'https://github.com/octo-org/hello/issues/7' }, directive: 'Fix the greeting' };

describe('Pointed jobs', () => {
  it('makes a pointed job, reads it and lists it', async () => {
    const { app, token } = await start();
    const r = await app.ui<PointedJob>('/ui/api/pointed-jobs', ISSUE, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ...ISSUE, status: 'queued', source: 'api' });
    expect(r.body.lane).toBeUndefined();
    expect(r.body.createdAt).toBe(r.body.updatedAt);
    expect(eventsOf(app, 'pointed_job.created').map((e) => e.data)).toEqual([{ id: r.body.id, repo: 'octo-org/hello', pointer: ISSUE.pointer, source: 'api', by: expect.any(String) }]);
    expect((await app.api('GET', `/api/pointed-jobs/${r.body.id}`)).body).toEqual(r.body);
    expect((await app.api('GET', '/api/pointed-jobs/no-such-id')).status).toBe(404);
    expect((await app.api('GET', '/api/pointed-jobs')).body.pointedJobs).toEqual([r.body]);
  });

  it('refuses a pointer that is not of the repository, or a directive that is empty', async () => {
    const { app, token } = await start();
    expect((await app.ui('/ui/api/pointed-jobs', { ...ISSUE, repo: 'not a repo' }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/pointed-jobs', { ...ISSUE, directive: ' ' }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/pointed-jobs', { ...ISSUE, pointer: { ...ISSUE.pointer, kind: 'commit' } }, { token })).status).toBe(400);
    expect((await app.api('GET', '/api/pointed-jobs')).body.pointedJobs).toEqual([]);
  });

  it('moves a pointed job through its statuses, each move an event', async () => {
    const { app, token } = await start();
    const { id } = (await app.ui<PointedJob>('/ui/api/pointed-jobs', { ...ISSUE, pointer: { kind: 'pull_request', number: 8, url: 'https://github.com/octo-org/hello/pull/8' } }, { token })).body;
    const move = (body: Record<string, unknown>) => app.ui<PointedJob>(`/ui/api/pointed-jobs/${id}/transition`, body, { token });
    const running = await move({ to: 'running', lane: 'local/lane-1' });
    expect(running.status).toBe(200);
    expect(running.body).toMatchObject({ status: 'running', lane: 'local/lane-1' });
    const review = await move({ to: 'awaiting_review' });
    expect(review.body.status).toBe('awaiting_review');
    expect(review.body.lane).toBeUndefined();
    expect((await move({ to: 'merged' })).body.status).toBe('merged');
    expect(eventsOf(app, 'pointed_job.status_changed').reverse().map((e) => [e.data.from, e.data.to, e.data.lane])).toEqual([
      ['queued', 'running', 'local/lane-1'], ['running', 'awaiting_review', undefined], ['awaiting_review', 'merged', undefined],
    ]);
  });

  it('refuses an illegal transition and records nothing', async () => {
    const { app, token } = await start();
    const { id } = (await app.ui<PointedJob>('/ui/api/pointed-jobs', ISSUE, { token })).body;
    const move = (to: string) => app.ui<{ error: string }>(`/ui/api/pointed-jobs/${id}/transition`, { to }, { token });
    const r = await move('merged');
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('queued');
    expect((await move('abandoned')).status).toBe(200);
    expect((await move('running')).status).toBe(409);
    expect((await move('sideways')).status).toBe(400);
    expect((await app.ui('/ui/api/pointed-jobs/no-such-id/transition', { to: 'running' }, { token })).status).toBe(404);
    expect(eventsOf(app, 'pointed_job.status_changed').map((e) => e.data.to)).toEqual(['abandoned']);
  });

  it('shows the jobs the hopper already has as pointed jobs, their status read from the job', async () => {
    const { app, token } = await start();
    const job = await app.pull({ op: 'echo' }, { title: 'Say hi', repo: 'octo-org/hello', number: 9, key: 'https://github.com/octo-org/hello/issues/9', url: 'https://github.com/octo-org/hello/issues/9' });
    await app.waitForStatus(job.id, 'finished');
    const other = await app.pull({ op: 'echo' }, { title: 'No repository' });
    await app.waitForStatus(other.id, 'finished');
    const list = (await app.api('GET', '/api/pointed-jobs')).body.pointedJobs as PointedJob[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: job.id, jobId: job.id, repo: 'octo-org/hello', pointer: { kind: 'issue', number: 9, url: 'https://github.com/octo-org/hello/issues/9' },
      directive: 'Say hi', status: 'merged', source: job.source!.source,
    });
    expect((await app.api('GET', `/api/pointed-jobs/${job.id}`)).body).toEqual(list[0]);
    const r = await app.ui<{ error: string }>(`/ui/api/pointed-jobs/${job.id}/transition`, { to: 'abandoned' }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('follows its job');
  });
});
