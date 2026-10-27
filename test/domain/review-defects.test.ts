// Issue #2846 part 2: a completion review names the hopper defect a run hit, by fixed rules, with a signature that is the
// same for the same defect on every job: the hopper's own causes (the sweep, a lost way to the hopper) and a requeue loop.
// A hard task — a failure of the job's own work — is no defect. Pure.
import { describe, expect, it } from 'vitest';
import { completionReviewOf, type CompletionReviewInput, type ReviewEvent } from '../../src/domain/completion-review.ts';
import { causeSlug, defectOf, REQUEUE_LOOP } from '../../src/domain/review-defects.ts';

const T0 = Date.parse('2026-10-26T10:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, type: string, data?: unknown): ReviewEvent => ({ type, at: at(min), ...(data !== undefined ? { data } : {}) });
const input = (o: Partial<CompletionReviewInput> = {}): CompletionReviewInput => ({
  job: { id: 'j1', status: 'failed', createdAt: at(0), finishedAt: at(60), updatedAt: at(60), attempts: 1 }, events: [], jobs: 1, at: at(70), ...o,
});

describe('bug-report recommendations of completion reviews (issue #2846 part 2)', () => {
  it('names a failure of the hopper\'s own cause as a defect, its signature the cause', () => {
    const swept = completionReviewOf(input({ failure: { causeId: 'swept' } })).defect;
    expect(swept).toMatchObject({ signature: 'cause:swept', title: expect.stringContaining('sweep') });
    expect(completionReviewOf(input({ failure: { causeId: 'no-way-to-hopper' } })).defect?.signature).toBe('cause:no-way-to-hopper');
  });

  it('names no defect for a failure of the job\'s own work, or of an outside cause', () => {
    expect(completionReviewOf(input()).defect).toBeUndefined();
    expect(completionReviewOf(input({ failure: { causeId: 'login-expired' } })).defect).toBeUndefined();
    expect(completionReviewOf(input({ failure: {} })).defect).toBeUndefined();
  });

  it('names a requeue loop, its signature the first cause without its numbers and ids', () => {
    const requeues = (n: number, reason: string) => Array.from({ length: n }, (_, k) => ev(k + 1, 'job.requeued', { reason }));
    const review = completionReviewOf(input({ events: requeues(REQUEUE_LOOP, 'the lease of machine-7 ended at 3f9a1c2d') }));
    expect(review.defect?.signature).toBe('requeue-loop:the-lease-of-machine-ended-at');
    expect(review.defect?.description).toContain(`${REQUEUE_LOOP} times`);
    // The same loop on another job, other numbers: one signature.
    expect(completionReviewOf(input({ events: requeues(5, 'the lease of machine-2 ended at 77aa1b0c') })).defect?.signature).toBe(review.defect?.signature);
    expect(completionReviewOf(input({ events: requeues(REQUEUE_LOOP - 1, 'the lease ended') })).defect).toBeUndefined();
  });

  it('takes the hopper\'s cause before a requeue loop', () => {
    expect(defectOf({ failure: { causeId: 'swept' }, restarts: [{ kind: 'requeued', count: 9, causes: [] }] })?.signature).toBe('cause:swept');
    expect(defectOf({ restarts: [{ kind: 'requeued', count: 9, causes: [] }] })?.signature).toBe('requeue-loop');
  });

  it('makes a cause slug of words only', () => {
    expect(causeSlug('Lost: 12 tries, id 0a1b2c3d!')).toBe('lost-tries-id');
    expect(causeSlug('x'.repeat(80))).toHaveLength(60);
  });
});
