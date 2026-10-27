// Issue #2845, part 5: item grades. The issue asks for a grade of each finished "saga": the whole work of one issue,
// over every job of its work item (its parts, its runs again). An item that ended done or failed gets an automatic grade
// from the facts of its jobs' grades summed — the same signals, weights and lines as a job's —, and the rollups sum the
// items as they sum the jobs. Pure.
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRADE_SETTINGS, type GradeFacts, type GradeRow } from '../../src/domain/grades.ts';
import { itemFactsOf, itemGradeOf } from '../../src/domain/item-grades.ts';

const KEY = 'https://github.com/octo/shed/issues/7';
const facts = (o: Partial<GradeFacts> = {}): GradeFacts => ({ status: 'finished', fixChecks: 0, reworks: 0, reruns: 0, attempts: 1, ...o });
const row = (jobId: string, endedAt: string, f: GradeFacts, o: Partial<GradeRow> = {}): GradeRow =>
  ({ jobId, endedAt, executor: 'claude', repo: 'octo/shed', kind: 'code', facts: f, auto: { score: 50, lines: [] }, ...o });
const PR1 = 'https://github.com/octo/shed/pull/11', PR2 = 'https://github.com/octo/shed/pull/12';

describe('the facts of an item (issue #2845 part 5)', () => {
  it('sums its jobs\' rework, cost and time, and takes the outcome from the item', () => {
    const f = itemFactsOf('done', [
      row('j1', '2026-10-02T00:00:00.000Z', facts({ status: 'failed', attempts: 2, costUsd: 1, wallMs: 60_000, queueMs: 1000, reruns: 1 })),
      row('j2', '2026-10-03T00:00:00.000Z', facts({ pullRequest: { url: PR1, state: 'merged', mergedAt: '2026-10-03T00:00:00.000Z' }, fixChecks: 1, costUsd: 2, wallMs: 120_000, queueMs: 2000, reopens: 1 })),
    ]);
    expect(f).toEqual({
      status: 'finished', pullRequest: { url: PR1, state: 'merged', mergedAt: '2026-10-03T00:00:00.000Z' }, fixChecks: 1, reworks: 0, reruns: 1, attempts: 2,
      reopens: 1, costUsd: 3, queueMs: 3000, wallMs: 180_000,
    });
    expect(itemFactsOf('failed', [row('j1', '2026-10-02T00:00:00.000Z', facts())]).status).toBe('failed');
  });

  it('takes a reverted pull request of any job over a later merged one, and drops the cost when one job has none', () => {
    const reverted = { url: PR1, state: 'merged' as const, mergedAt: '2026-10-02T00:00:00.000Z', reverted: { at: '2026-10-03T00:00:00.000Z', url: PR2 } };
    const f = itemFactsOf('done', [
      row('j1', '2026-10-02T00:00:00.000Z', facts({ pullRequest: reverted, costUsd: 1, waste: ['retries'] })),
      row('j2', '2026-10-04T00:00:00.000Z', facts({ pullRequest: { url: PR2, state: 'merged', mergedAt: '2026-10-04T00:00:00.000Z' } })),
    ]);
    expect(f.pullRequest).toEqual(reverted);
    expect(f).not.toHaveProperty('costUsd');
    expect(f.waste).toEqual(['retries']);
  });
});

describe('the automatic grade of an item (issue #2845 part 5)', () => {
  it('grades the summed facts with the grade settings, keyed by its newest job, and lists its jobs oldest first', () => {
    const rows = [
      row('j2', '2026-10-03T00:00:00.000Z', facts({ pullRequest: { url: PR1, state: 'merged', mergedAt: '2026-10-03T00:00:00.000Z' } }), { executor: 'codex', model: 'gpt', machine: 'm2', auto: { score: 90, lines: [] } }),
      row('j1', '2026-10-02T00:00:00.000Z', facts({ status: 'failed' }), { auto: { score: 10, lines: [] } }),
    ];
    const g = itemGradeOf({ key: KEY, state: 'done', stateSince: '2026-10-05T00:00:00.000Z' }, rows, DEFAULT_GRADE_SETTINGS, new Date('2026-10-06T00:00:00.000Z'));
    expect(g).toMatchObject({
      key: KEY, endedAt: '2026-10-05T00:00:00.000Z', state: 'done', executor: 'codex', model: 'gpt', repo: 'octo/shed', kind: 'code', machine: 'm2',
      jobs: [{ jobId: 'j1', score: 10 }, { jobId: 'j2', score: 90 }], gradedAt: '2026-10-06T00:00:00.000Z',
    });
    expect(g!.auto.lines.map((l) => l.signal)).toEqual(['outcome', 'checks', 'pull_request', 'rework']);
    expect(g!.auto.lines.find((l) => l.signal === 'rework')).toMatchObject({ value: 1 });
  });

  it('grades no item with no graded job', () => {
    expect(itemGradeOf({ key: KEY, state: 'failed', stateSince: '2026-10-05T00:00:00.000Z' }, [], DEFAULT_GRADE_SETTINGS, new Date())).toBeUndefined();
  });
});
