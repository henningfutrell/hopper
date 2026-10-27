// Grades (issue #2845, design.md "Grades") over the real HTTP server and database: the grade pass grades each job that
// ended done or failed, and grades it again when a later event comes — its pull request merged, then reverted by a
// landing batch inside the window —; GET /api/jobs/:id/grade answers its automatic grade with the breakdown, and its user
// grade with the history; a person gives and edits a user grade, kept across a restart; GET /api/grades rolls them up.
//
// Feature: grades over the API
//   Scenario: a finished and a failed job get an automatic grade with a line per signal; the finished one grades higher
//   Scenario: a merge raises the grade, and a revert inside the window lowers it again
//   Scenario: a person gives a user grade with a note, edits it, and both stay in its history after a restart
//   Scenario: the rollup by harness counts the jobs, the mean of each grade and the disagreements
//   Scenario: a bad score, an unknown job and a job that has not ended are refused
import { afterEach, describe, expect, it } from 'vitest';
import type { GradeLine } from '../../src/domain/grades.ts';
import type { EventType } from '../../src/domain/types.ts';
import { keepGrades } from '../../src/engine/grades.ts';
import type { GradesView, JobGradeView } from '../../src/http/grades.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const PR = 'https://github.com/octo/shed/pull/11';

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

const add = (a: TestApp, type: EventType, data: Record<string, unknown>, jobId?: string) =>
  a.user().store.events.append({ type, data, ...(jobId ? { jobId } : {}) });
const gradeOf = async (a: TestApp, id: string) => (await a.api<JobGradeView>('GET', `/api/jobs/${id}/grade`)).body;
const lineOf = (v: JobGradeView, signal: string): GradeLine | undefined => v.grade?.auto.lines.find((l) => l.signal === signal);

async function ended(a: TestApp): Promise<{ done: string; failed: string }> {
  const done = await a.pull({ op: 'echo', message: 'hi' });
  const failed = await a.pull({ op: 'fail' });
  await a.waitForStatus(done.id, 'finished');
  await a.waitForStatus(failed.id, 'failed');
  return { done: done.id, failed: failed.id };
}

describe('grades over the API', () => {
  it('grades a finished and a failed job, then again at a merge and at a revert inside the window', async () => {
    const { a } = await boot();
    const { done, failed } = await ended(a);
    keepGrades(a.user().store, new Date());
    const first = await gradeOf(a, done);
    expect(first.grade).toMatchObject({ jobId: done, harness: 'test', kind: 'code', facts: { status: 'finished' } });
    expect(first.grade!.auto.lines.map((l) => l.signal)).toEqual(['outcome', 'rework', 'time']);
    expect((await gradeOf(a, failed)).grade!.auto.score).toBeLessThan(first.grade!.auto.score);

    add(a, 'job.pull_request_followed', { pullRequest: PR, part: false }, done);
    add(a, 'job.pull_request_merged', { pullRequest: PR, part: false }, done);
    expect(keepGrades(a.user().store, new Date())).toBe(1);
    const merged = await gradeOf(a, done);
    expect(lineOf(merged, 'pull_request')).toMatchObject({ value: 1, why: 'merged' });

    add(a, 'landing_batch.revert_opened', { repo: 'octo/shed', tip: 't', sha: 's', culpritPullRequest: 11, pullRequest: 20, url: 'https://github.com/octo/shed/pull/20' });
    add(a, 'landing_batch.reverted', { repo: 'octo/shed', tip: 't', sha: 's', pullRequest: 20, url: 'https://github.com/octo/shed/pull/20' });
    expect(keepGrades(a.user().store, new Date())).toBe(1);
    const reverted = await gradeOf(a, done);
    expect(lineOf(reverted, 'pull_request')).toMatchObject({ value: 0, why: 'merged, then reverted by https://github.com/octo/shed/pull/20' });
    expect(reverted.grade!.auto.score).toBeLessThan(merged.grade!.auto.score);
    expect(keepGrades(a.user().store, new Date())).toBe(0);
  });

  it('keeps a user grade and its edits across a restart, and rolls the grades up', async () => {
    const { a, dbPath } = await boot();
    const { done, failed } = await ended(a);
    keepGrades(a.user().store, new Date());
    const token = await a.login();
    const r = await a.ui<JobGradeView>(`/ui/api/jobs/${done}/grade`, { score: 2, note: 'missed the point' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ score: 2, note: 'missed the point', by: expect.any(String) });
    await new Promise((res) => setTimeout(res, 5));
    expect((await a.ui(`/ui/api/jobs/${done}/grade`, { score: 1 }, { token })).status).toBe(200);
    await a.stop();
    apps.splice(apps.indexOf(a), 1);

    const { a: b } = await boot(dbPath);
    const v = await gradeOf(b, done);
    expect(v.user).toMatchObject({ score: 1 });
    expect(v.user).not.toHaveProperty('note');
    expect(v.history.map((h) => h.score)).toEqual([1, 2]);
    expect(v.disagree).toBe(v.grade!.auto.score >= 40);

    const roll = (await b.api<GradesView>('GET', '/api/grades?by=harness')).body;
    expect(roll.by).toBe('harness');
    expect(roll.groups).toEqual([expect.objectContaining({ key: 'test', jobs: 2, userGraded: 1, user: 1 })]);
    expect(roll.total).toMatchObject({ jobs: 2, userGraded: 1 });
    expect(roll.jobs.map((j) => j.jobId).sort()).toEqual([done, failed].sort());
  });

  it('refuses a bad score, an unknown job and a job that has not ended', async () => {
    const { a } = await boot();
    const token = await a.login();
    const { done } = await ended(a);
    const running = await a.pull({ op: 'sleep', ms: 60_000 });
    await a.waitForStatus(running.id, 'running');
    expect((await a.ui(`/ui/api/jobs/${done}/grade`, { score: 6 }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/jobs/nope/grade', { score: 3 }, { token })).status).toBe(404);
    expect((await a.ui(`/ui/api/jobs/${running.id}/grade`, { score: 3 }, { token })).status).toBe(409);
    expect((await a.api('GET', '/api/jobs/nope/grade')).status).toBe(404);
    expect((await a.api('GET', '/api/grades?by=colour')).status).toBe(400);
    expect((await gradeOf(a, running.id)).grade).toBeUndefined();
  });
});
