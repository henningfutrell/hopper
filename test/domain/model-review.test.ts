// Issue #2846 part 3: the model review of a completion review. Its settings merge on the defaults (off, `haiku`, a daily cap
// of $1), the prompt carries the rule review and the job's timeline, the model's answer is cut to size, and the cap reads the
// cost of the model reviews of the last day. Pure.
import { describe, expect, it } from 'vitest';
import { completionReviewSettingsOf, type CompletionReview } from '../../src/domain/completion-review.ts';
import { awaitingModel, modelCostOfDay, modelReviewAnswer, modelReviewPrompt, TIMELINE_EVENTS } from '../../src/domain/model-review.ts';

const T0 = Date.parse('2026-10-26T10:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const review = (o: Partial<CompletionReview> = {}): CompletionReview => ({
  jobId: 'j1', outcome: 'failed', reviewedAt: at(70), durationMs: 60 * 60_000, stages: [{ stage: 'running', ms: 40 * 60_000 }, { stage: 'queued', ms: 20 * 60_000 }],
  jobs: 2, questions: 1, went: [], stalls: ['Waited for a lane 20 min.'], restarts: [{ kind: 'requeued', count: 2, causes: ['lost lane'] }],
  waste: [{ kind: 'failing_tests', why: '6 test runs failed.' }], suggestions: [{ area: 'template', text: 'Give its template the services.' }], ...o,
});

describe('the model review (issue #2846 part 3)', () => {
  it('is off by default; a setting saved before it existed reads its defaults, and each part merges', () => {
    expect(completionReviewSettingsOf(undefined).modelReview).toEqual({ on: false, model: 'haiku', dailyCostUsd: 1 });
    expect(completionReviewSettingsOf({ on: true, outcomes: ['failed'], multiJob: true, minRunMinutes: 0 }).modelReview).toEqual({ on: false, model: 'haiku', dailyCostUsd: 1 });
    expect(completionReviewSettingsOf({ modelReview: { on: true } as never }).modelReview).toEqual({ on: true, model: 'haiku', dailyCostUsd: 1 });
  });

  it('asks with the job, its failure, its rule review and its timeline, the first and last events of a long one', () => {
    const timeline = Array.from({ length: 100 }, (_, i) => ({ type: i === 0 ? 'job.queued' : `e.${i}`, at: at(i / 2) }));
    const p = modelReviewPrompt({ title: 'Fix the parser', executor: 'claude', failure: 'tests failed' }, review(), at(0), timeline);
    expect(p).toContain('Job: Fix the parser');
    expect(p).toContain('Executor: claude');
    expect(p).toContain('Outcome: failed, after 1 h; 2 job(s) of its work item; 1 question(s).');
    expect(p).toContain('Failure: tests failed');
    expect(p).toContain('Time per stage: running 40 min, queued 20 min');
    expect(p).toContain('- Queued again 2 times: lost lane');
    expect(p).toContain('- failing_tests');
    expect(p).toContain('- template: Give its template the services.');
    expect(p).toContain(`Timeline (minutes from creation, 100 events, the first and last ${TIMELINE_EVENTS}):`);
    expect(p).toContain('- 0 job.queued');
    expect(p).toContain('- 50 e.99');
    expect(p).not.toContain('e.50\n');
    expect(modelReviewPrompt({ title: 't', executor: 'x' }, review({ restarts: [], waste: [] }), at(0), [])).not.toContain('Failure:');
  });

  it('keeps the answer to size: lines cut, empty ones and an empty defect left out', () => {
    const long = 'x'.repeat(900);
    const a = modelReviewAnswer.parse({
      summary: ` ${long} `, went: ['a', ' ', 'b', 'c', 'd', 'e', 'f', 'g'], stalls: [], suggestions: [{ area: 'lane', text: '' }, { area: 'prompt', text: 'Split it.' }], hopperDefect: ' ',
    });
    expect(a.summary).toHaveLength(500);
    expect(a.went).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(a.suggestions).toEqual([{ area: 'prompt', text: 'Split it.' }]);
    expect(a).not.toHaveProperty('hopperDefect');
    expect(modelReviewAnswer.safeParse({ summary: 's', went: [], stalls: [], suggestions: [{ area: 'nope', text: 't' }] }).success).toBe(false);
  });

  it('sums the cost of the model reviews of the last day, and lists the reviews that wait for one, oldest first', () => {
    const now = new Date(at(24 * 60 + 30));
    const mr = (min: number, costUsd?: number) => ({ summary: 's', went: [], stalls: [], suggestions: [], at: at(min), ...(costUsd !== undefined ? { costUsd } : {}) });
    const kept = [
      review({ jobId: 'old', modelReview: mr(10, 5) }), // more than a day ago
      review({ jobId: 'a', modelReview: mr(60, 0.25) }), review({ jobId: 'b', modelReview: mr(70) }),
      review({ jobId: 'c', reviewedAt: at(90) }), review({ jobId: 'd', reviewedAt: at(80) }),
      review({ jobId: 'e', modelFailed: { error: 'x', at: at(85) } }),
    ];
    expect(modelCostOfDay(kept, now)).toBe(0.25);
    expect(awaitingModel(kept).map((r) => r.jobId)).toEqual(['d', 'c']);
  });
});
