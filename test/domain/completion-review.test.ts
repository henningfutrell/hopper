// Issue #2846: completion reviews. When a job ends, the hopper reviews its run from its events, its token ledger and its
// work item's jobs: where its time went, what went well, where it stalled, its restarts and waste signals, and the changes
// that would have helped. Which jobs are reviewed is the user's setting. Pure.
import { describe, expect, it } from 'vitest';
import {
  completionReviewOf, DEFAULT_COMPLETION_REVIEW, durationText, restartsOf, shouldReview, stageTimes, type CompletionReviewInput, type ReviewEvent,
} from '../../src/domain/completion-review.ts';
import type { TokenTotals } from '../../src/domain/token-usage.ts';

const T0 = Date.parse('2026-10-26T10:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, type: string, data?: unknown): ReviewEvent => ({ type, at: at(min), ...(data !== undefined ? { data } : {}) });
const totals = (o: Partial<TokenTotals>): TokenTotals => ({ turns: 10, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnown: true, ...o });
const input = (o: Partial<CompletionReviewInput> & { end?: number; status?: string } = {}): CompletionReviewInput => ({
  job: { id: 'j1', status: o.status ?? 'finished', createdAt: at(0), finishedAt: at(o.end ?? 60), updatedAt: at(o.end ?? 60), attempts: 1 },
  events: [], jobs: 1, at: at(70), ...o,
});

describe('completion reviews (issue #2846)', () => {
  it('is on by default for failed jobs and for work items of more than one job, from 5 minutes of run', () => {
    expect(DEFAULT_COMPLETION_REVIEW).toEqual({ on: true, outcomes: ['failed'], multiJob: true, minRunMinutes: 5 });
    const job = (status: string, ranMin: number, attempts = 1) => ({ status, attempts, startedAt: at(0), finishedAt: at(ranMin) });
    expect(shouldReview(DEFAULT_COMPLETION_REVIEW, job('failed', 30), 1)).toBe(true);
    expect(shouldReview(DEFAULT_COMPLETION_REVIEW, job('finished', 30), 1)).toBe(false);
    expect(shouldReview(DEFAULT_COMPLETION_REVIEW, job('finished', 30), 2)).toBe(true);
    // Trivial: a short first run is skipped; a second attempt is not trivial.
    expect(shouldReview(DEFAULT_COMPLETION_REVIEW, job('failed', 2), 1)).toBe(false);
    expect(shouldReview(DEFAULT_COMPLETION_REVIEW, job('failed', 2, 2), 1)).toBe(true);
    // Never a job that has not ended, nor a rejected one; off reviews none.
    expect(shouldReview(DEFAULT_COMPLETION_REVIEW, job('running', 30), 2)).toBe(false);
    expect(shouldReview(DEFAULT_COMPLETION_REVIEW, job('rejected', 30), 2)).toBe(false);
    expect(shouldReview({ ...DEFAULT_COMPLETION_REVIEW, on: false }, job('failed', 30), 2)).toBe(false);
    expect(shouldReview({ ...DEFAULT_COMPLETION_REVIEW, multiJob: false }, job('finished', 30), 2)).toBe(false);
  });

  it('splits the run into its stages, longest first', () => {
    const events = [
      ev(0, 'job.queued'), ev(20, 'job.claimed'), ev(21, 'job.started'), ev(30, 'question.asked'), ev(45, 'question.answered'),
      ev(50, 'job.waiting', { for: 'checks', on: { kind: 'pull_request', number: 3 } }), ev(55, 'job.wait_ended', { by: 'hopper' }),
    ];
    expect(stageTimes(at(0), at(60), events)).toEqual([
      { stage: 'queued', ms: 20 * 60_000 }, { stage: 'running', ms: 20 * 60_000 }, { stage: 'person', ms: 15 * 60_000 }, { stage: 'waiting', ms: 5 * 60_000 },
    ]);
    // A wait on a person's approval is a person's; a wait on its own command is running.
    expect(stageTimes(at(0), at(10), [ev(0, 'job.started'), ev(5, 'job.waiting', { for: 'x', on: { kind: 'approval', of: 'sandbox' } })]))
      .toEqual([{ stage: 'running', ms: 5 * 60_000 }, { stage: 'person', ms: 5 * 60_000 }]);
    expect(stageTimes(at(0), at(10), [ev(0, 'job.started'), ev(5, 'job.waiting', { for: 'x', ownCommand: true })])).toEqual([{ stage: 'running', ms: 10 * 60_000 }]);
  });

  it('counts the restarts with their causes; a park a preemption made, or a person made, is not one more', () => {
    const r = restartsOf([
      ev(1, 'job.preempted', { by: 'j2', byPriority: 75, priority: 50, reason: 'j2 waits' }), ev(1, 'job.parked', { from: 'running', auto: true }),
      ev(5, 'job.parked', { from: 'running', by: 'a person' }),
      ev(9, 'job.parked', { from: 'running', auto: true, why: 'its machine was lost' }),
      ev(10, 'job.requeued', { from: 'running', reason: 'lane gone' }), ev(11, 'job.requeued', { from: 'running', reason: 'lane gone' }),
      ev(12, 'job.link_lost', { machine: 'm1', since: at(12), failsAt: at(20) }),
    ]);
    expect(r).toEqual([
      { kind: 'requeued', count: 2, causes: ['lane gone'] },
      { kind: 'preempted', count: 1, causes: ['j2 waits'] },
      { kind: 'parked', count: 1, causes: ['its machine was lost'] },
      { kind: 'link_lost', count: 1, causes: ['the link to m1 was lost'] },
    ]);
  });

  it('says what went well for a quick clean run', () => {
    const review = completionReviewOf(input({
      events: [ev(0, 'job.queued'), ev(1, 'job.started'), ev(50, 'job.pull_request_merged', { pullRequest: 'o/r#1' })], tokens: totals({}),
    }));
    expect(review).toMatchObject({ jobId: 'j1', outcome: 'finished', durationMs: 60 * 60_000, jobs: 1, questions: 0, stalls: [], restarts: [], waste: [], suggestions: [] });
    expect(review.went).toEqual([
      'It finished the work.', 'Its pull request merged.', 'It ran in one go, with no restart.', 'It ran 59 min of its 1 h: little time went to waits.', 'Its token use shows no waste signal.',
    ]);
  });

  it('names the stalls, the restarts and the waste, and suggests changes for them', () => {
    const events = [
      ev(0, 'job.queued'), ev(40, 'job.started'),
      ...[45, 46, 47].map((m) => ev(m, 'question.asked')), ev(80, 'question.answered'),
      ev(81, 'job.preempted', { by: 'a', byPriority: 75, priority: 50, reason: 'a waits' }), ev(81, 'job.parked', { from: 'running', auto: true }), ev(82, 'job.unparked', { to: 'queued' }), ev(83, 'job.started'),
      ev(84, 'job.preempted', { by: 'b', byPriority: 75, priority: 50, reason: 'b waits' }), ev(84, 'job.parked', { from: 'running', auto: true }), ev(85, 'job.unparked', { to: 'queued' }), ev(86, 'job.started'),
      ev(90, 'job.oom_killed', { command: 'tsc' }),
    ];
    const review = completionReviewOf(input({ status: 'failed', end: 120, events, jobs: 3, tokens: totals({ turns: 200, failedTests: 6 }) }));
    expect(review.outcome).toBe('failed');
    expect(review.stalls).toEqual([
      'Waited for a lane 42 min.', 'Waited on a person 35 min (3 questions).',
      'Preempted 2 times: a waits; b waits.', 'A process was killed for memory once: tsc.', 'Its work item took 3 jobs.',
    ]);
    expect(review.waste.map((w) => w.kind)).toEqual(['no_progress', 'failing_tests']);
    expect(review.suggestions.map((s) => s.area)).toEqual(['lane', 'routing', 'prompt', 'prompt', 'template', 'config']);
    expect(review.went).toEqual([]);
  });

  it('counts a push as progress, so many turns with a push are no waste', () => {
    const push = ev(10, 'github_proxy.done', { op: 'git.push' });
    expect(completionReviewOf(input({ events: [push], tokens: totals({ turns: 200 }) })).waste).toEqual([]);
  });

  it('writes durations as people read them', () => {
    expect(durationText(20_000)).toBe('under a minute');
    expect(durationText(42 * 60_000)).toBe('42 min');
    expect(durationText(120 * 60_000)).toBe('2 h');
    expect(durationText(125 * 60_000)).toBe('2 h 5 min');
  });
});
