// Completion reviews (issue #2846, design.md "Completion reviews") over the real HTTP server and database: an admin says
// which ended jobs are reviewed, the change is an event; the review pass reviews an ended job the settings name, once, and
// keeps the review, which GET /api/jobs/:id/completion-review answers; a job the settings skip gets none.
import { afterEach, describe, expect, it } from 'vitest';
import type { CompletionReview, CompletionReviewSettings } from '../../src/domain/completion-review.ts';
import { createCompletionReviews } from '../../src/engine/completion-reviews.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

const set = (a: TestApp, token: string, body: Partial<CompletionReviewSettings>) => a.ui<CompletionReviewSettings>('/ui/api/completion-review', body, { token });
/** A pass as if it ran two minutes from now: the jobs that just ended have settled. */
const later = (): Date => new Date(Date.now() + 120_000);

describe('completion reviews', () => {
  it('are on by default for failed jobs; an admin changes which, and the change is an event', async () => {
    const a = await boot();
    const token = await a.login();
    const defaults = { on: true, outcomes: ['failed'], multiJob: true, minRunMinutes: 5, modelReview: { on: false, model: 'haiku', dailyCostUsd: 1 } };
    expect((await a.api('GET', '/api/completion-review')).body).toEqual(defaults);
    const r = await set(a, token, { outcomes: ['cancelled', 'failed'], minRunMinutes: 0 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...defaults, outcomes: ['failed', 'cancelled'], minRunMinutes: 0 });
    expect((await a.api('GET', '/api/completion-review')).body).toEqual(r.body);
    expect((await a.events('types=completion_review.settings_changed'))[0]!.data).toMatchObject({ from: defaults, to: r.body });
    expect((await set(a, token, {})).status).toBe(400);
    expect((await set(a, token, { minRunMinutes: -1 })).status).toBe(400);
    expect((await set(a, token, { outcomes: ['rejected' as 'failed'] })).status).toBe(400);
  });

  it('reviews an ended job the settings name, once, and the job page reads it; a job they skip gets none', async () => {
    const a = await boot();
    const token = await a.login();
    await set(a, token, { minRunMinutes: 0 });
    const failed = await a.pull({ op: 'fail', message: 'boom' });
    const done = await a.pull({ op: 'echo', message: 'ok' });
    await a.waitForStatus(failed.id, 'failed');
    await a.waitForStatus(done.id, 'finished');
    const pass = createCompletionReviews(a.user().store);
    expect(pass(new Date())).toEqual([]); // not settled yet
    const kept = pass(later());
    expect(kept.map((k) => k.jobId)).toEqual([failed.id]);
    expect(pass(later())).toEqual([]); // once

    const r = await a.api<{ review?: CompletionReview }>('GET', `/api/jobs/${failed.id}/completion-review`);
    expect(r.status).toBe(200);
    expect(r.body.review).toMatchObject({ jobId: failed.id, outcome: 'failed', jobs: 1, questions: 0, restarts: [], waste: [] });
    expect(r.body.review!.stages.map((s) => s.stage)).toContain('running');
    expect((await a.api('GET', `/api/jobs/${done.id}/completion-review`)).body).toEqual({});
    expect((await a.api('GET', '/api/jobs/nope/completion-review')).status).toBe(404);
  });

  it('reviews none while off', async () => {
    const a = await boot();
    const token = await a.login();
    await set(a, token, { on: false, minRunMinutes: 0 });
    const failed = await a.pull({ op: 'fail', message: 'boom' });
    await a.waitForStatus(failed.id, 'failed');
    expect(createCompletionReviews(a.user().store)(later())).toEqual([]);
  });
});
