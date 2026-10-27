// The model review of a completion review (issue #2846 part 3) over the real HTTP server and database, the model a double at
// its seam: an admin turns it on and names the model and the daily cost cap; the sweep asks the model for each kept review,
// keeps its answer with the review (GET /api/jobs/:id/completion-review), records it as an event, and asks no more once the
// day's cost reaches the cap; a failed answer is kept and not asked again; off, it asks nothing. The kept review also feeds
// the job's grade (the `review` signal).
import { afterEach, describe, expect, it } from 'vitest';
import type { CompletionReview, CompletionReviewSettings } from '../../src/domain/completion-review.ts';
import type { ModelReviewWriter } from '../../src/domain/model-review.ts';
import { createCompletionReviews } from '../../src/engine/completion-reviews.ts';
import { gradeOf } from '../../src/engine/grades.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

interface Call { prompt: string; model: string }

async function boot(answer: (n: number) => Awaited<ReturnType<ModelReviewWriter>>): Promise<{ a: TestApp; calls: Call[]; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const calls: Call[] = [];
  const writer: ModelReviewWriter = async (prompt, model) => { calls.push({ prompt, model }); return answer(calls.length); };
  const a = await startTestApp({ dbPath: db.dbPath, seams: { modelReviewWriter: writer } });
  apps.push(a);
  const token = await a.login();
  return { a, calls, token };
}

const set = (a: TestApp, token: string, body: unknown) => a.ui<CompletionReviewSettings>('/ui/api/completion-review', body, { token });
const later = (): Date => new Date(Date.now() + 120_000);
const ANSWER = { summary: 'It failed on its first step.', went: [], stalls: ['It stopped at once.'], suggestions: [{ area: 'prompt' as const, text: 'Say how to run it.' }] };

/** Failed jobs, ended and reviewed by the rules. */
async function failedJobs(a: TestApp, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const j = await a.pull({ op: 'fail', message: `boom ${i}` });
    await a.waitForStatus(j.id, 'failed');
    ids.push(j.id);
  }
  createCompletionReviews(a.user().store)(later());
  return ids;
}

const reviewOf = async (a: TestApp, id: string) => (await a.api<{ review?: CompletionReview }>('GET', `/api/jobs/${id}/completion-review`)).body.review;

describe('the model review of a completion review', () => {
  it('asks nothing while off (the default)', async () => {
    const { a, calls } = await boot(() => ({ ...ANSWER, costUsd: 0.01 }));
    await set(a, await a.login(), { minRunMinutes: 0 });
    const [id] = await failedJobs(a, 1);
    await a.user().modelReviews.sweep();
    expect(calls).toEqual([]);
    expect(await reviewOf(a, id!)).not.toHaveProperty('modelReview');
  });

  it('an admin turns it on with a model and a cap; the model review is kept beside the rule review, until the cap', async () => {
    const { a, calls, token } = await boot((n) => ({ ...ANSWER, model: 'claude-test-1', costUsd: n === 1 ? 0.3 : 0.25 }));
    const r = await set(a, token, { minRunMinutes: 0, modelReview: { on: true, model: 'sonnet', dailyCostUsd: 0.5 } });
    expect(r.status).toBe(200);
    expect(r.body.modelReview).toEqual({ on: true, model: 'sonnet', dailyCostUsd: 0.5 });
    expect((await set(a, token, { modelReview: { model: 'two words' } })).status).toBe(400);
    expect((await set(a, token, { modelReview: { dailyCostUsd: 101 } })).status).toBe(400);
    // One part changed keeps the others.
    expect((await set(a, token, { modelReview: { dailyCostUsd: 0.5 } })).body.modelReview).toEqual({ on: true, model: 'sonnet', dailyCostUsd: 0.5 });

    const ids = await failedJobs(a, 3);
    await a.user().modelReviews.sweep();
    // $0.30 then $0.25: the day's cost reached the cap of $0.50, so the third waits.
    expect(calls.map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
    expect(calls[0]!.prompt).toContain('Outcome: failed');
    expect(calls[0]!.prompt).toContain('job.failed');
    const reviews = await Promise.all(ids.map((id) => reviewOf(a, id)));
    expect(reviews.filter((r) => r?.modelReview)).toHaveLength(2);
    expect(reviews.find((r) => r?.modelReview?.costUsd === 0.3)).toMatchObject({ outcome: 'failed', modelReview: { ...ANSWER, model: 'claude-test-1', costUsd: 0.3 } });
    const events = await a.events('types=completion_review.model_reviewed');
    expect(events.map((e) => e.data)).toEqual(expect.arrayContaining([{ model: 'claude-test-1', costUsd: 0.3 }, { model: 'claude-test-1', costUsd: 0.25 }]));
    await a.user().modelReviews.sweep();
    expect(calls).toHaveLength(2); // still capped

    // The kept rule review feeds the grade: a `review` line.
    expect(gradeOf(a.user().store, ids[2]!, new Date())?.auto.lines.find((l) => l.signal === 'review')).toMatchObject({ value: 1, why: 'its completion review found no waste' });
    expect((await a.events('types=completion_review.kept')).length).toBe(3);
  });

  it('keeps a failed answer and does not ask again for it', async () => {
    const { a, calls, token } = await boot(() => ({ error: 'claude exited 1: not signed in' }));
    await set(a, token, { minRunMinutes: 0, modelReview: { on: true } });
    const [id] = await failedJobs(a, 1);
    await a.user().modelReviews.sweep();
    await a.user().modelReviews.sweep();
    expect(calls).toHaveLength(1);
    expect((await reviewOf(a, id!))?.modelFailed).toMatchObject({ error: 'claude exited 1: not signed in' });
    expect((await a.events('types=completion_review.model_reviewed'))[0]!.data).toEqual({ model: 'haiku', error: 'claude exited 1: not signed in' });
  });
});
