// Issue #2845, part 1: grades. Each ended job gets an automatic grade — a score of 0 to 100 from its signals (its outcome,
// its checks, its pull request, the rework it needed, its cost and its time), each weighted, with the breakdown —, and a
// person may give it a user grade of 1 to 5 with a note. Grades roll up by harness, model, repository, work kind or
// machine. Pure.
import { describe, expect, it } from 'vitest';
import {
  autoGradeOf, DEFAULT_GRADE_SETTINGS, disagreesOf, gradeFactsOf, gradeRollup, revertsOf, userPointsOf,
  type GradeFacts, type GradeRow,
} from '../../src/domain/grades.ts';
import type { DomainEvent, Job } from '../../src/domain/types.ts';

let seq = 0;
const ev = (type: string, data: object, at: string, jobId?: string): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at, data, ...(jobId ? { jobId } : {}) }) as unknown as DomainEvent;

const PR = 'https://github.com/owner/repo/pull/14';
const facts = (o: Partial<GradeFacts> = {}): GradeFacts => ({ status: 'finished', fixChecks: 0, reworks: 0, reruns: 0, attempts: 1, ...o });
const line = (f: GradeFacts, signal: string) => autoGradeOf(f, DEFAULT_GRADE_SETTINGS).lines.find((l) => l.signal === signal);

describe('the automatic grade (issue #2845)', () => {
  it('scores a job done well near 100, with a line for each signal it has', () => {
    const g = autoGradeOf(facts({ pullRequest: { url: PR, state: 'merged', mergedAt: '2026-10-02T00:00:00.000Z' }, costUsd: 0, wallMs: 0 }), DEFAULT_GRADE_SETTINGS);
    expect(g.score).toBe(100);
    expect(g.lines.map((l) => l.signal)).toEqual(['outcome', 'checks', 'pull_request', 'rework', 'cost', 'time']);
    for (const l of g.lines) expect(l.why.length).toBeGreaterThan(0);
  });

  it('scores a failed job low, and leaves out the signals it has no facts for', () => {
    const g = autoGradeOf(facts({ status: 'failed', attempts: 3 }), DEFAULT_GRADE_SETTINGS);
    expect(g.lines.map((l) => l.signal)).toEqual(['outcome', 'rework']);
    expect(g.score).toBeLessThan(30);
  });

  it('gives a pull request merged then reverted no points, and counts a merge after failing checks as half', () => {
    const merged = { url: PR, state: 'merged' as const, mergedAt: '2026-10-02T00:00:00.000Z' };
    expect(line(facts({ pullRequest: merged }), 'pull_request')?.value).toBe(1);
    expect(line(facts({ pullRequest: { ...merged, reverted: { at: '2026-10-03T00:00:00.000Z', url: 'https://github.com/owner/repo/pull/20' } } }), 'pull_request')?.value).toBe(0);
    expect(line(facts({ pullRequest: { url: PR, state: 'closed' } }), 'pull_request')?.value).toBe(0);
    expect(line(facts({ pullRequest: { url: PR, state: 'open' } }), 'pull_request')).toBeUndefined();
    expect(line(facts({ pullRequest: merged, fixChecks: 1 }), 'checks')?.value).toBe(0.5);
    expect(line(facts({ pullRequest: { url: PR, state: 'closed' }, fixChecks: 2 }), 'checks')?.value).toBe(0);
  });

  it('lowers the rework signal with each rework, run again and extra attempt', () => {
    expect(line(facts(), 'rework')?.value).toBe(1);
    expect(line(facts({ reworks: 1 }), 'rework')?.value).toBe(0.5);
    expect(line(facts({ reruns: 1, attempts: 2 }), 'rework')?.value).toBeCloseTo(1 / 3, 9);
  });

  it('halves the cost and time signals at their scales', () => {
    expect(line(facts({ costUsd: DEFAULT_GRADE_SETTINGS.costScaleUsd }), 'cost')?.value).toBe(0.5);
    expect(line(facts({ wallMs: DEFAULT_GRADE_SETTINGS.timeScaleMinutes * 60_000, queueMs: 5000 }), 'time')?.value).toBe(0.5);
  });

  it('weighs each signal by the settings, and a weight of 0 leaves it out', () => {
    const f = facts({ status: 'failed', costUsd: 0 });
    const only = { ...DEFAULT_GRADE_SETTINGS, weights: { outcome: 0, checks: 0, pull_request: 0, rework: 0, cost: 1, time: 0 } };
    expect(autoGradeOf(f, only)).toMatchObject({ score: 100, lines: [{ signal: 'cost', weight: 1 }] });
  });
});

describe('the facts of a job (issue #2845)', () => {
  const job = { id: 'j1', status: 'finished', attempts: 2, createdAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:10:00.000Z', finishedAt: '2026-10-01T01:10:00.000Z' } as Job;

  it('folds its events and its cost', () => {
    const events = [
      ev('job.pull_request_followed', { pullRequest: PR, part: false }, '2026-10-01T01:00:00.000Z', 'j1'),
      ev('job.pull_request_tended', { pullRequest: PR, step: 'fix_checks', nextJobId: 'j2' }, '2026-10-01T02:00:00.000Z', 'j1'),
      ev('job.rework_requested', { pullRequest: PR, notes: 'n', nextJobId: 'j3' }, '2026-10-01T03:00:00.000Z', 'j1'),
      ev('job.pull_request_merged', { pullRequest: PR, part: false }, '2026-10-02T00:00:00.000Z', 'j1'),
    ];
    expect(gradeFactsOf(job, events, { costUsd: 1.5, costKnown: true }, new Map())).toEqual({
      status: 'finished', attempts: 2, fixChecks: 1, reworks: 1, reruns: 0, costUsd: 1.5, queueMs: 600_000, wallMs: 3_600_000,
      pullRequest: { url: PR, state: 'merged', mergedAt: '2026-10-02T00:00:00.000Z' },
    });
  });

  it('marks a revert of its pull request inside the window, and not one after it', () => {
    const events = [ev('job.pull_request_merged', { pullRequest: PR, part: false }, '2026-10-02T00:00:00.000Z', 'j1')];
    const revert = (at: string) => revertsOf([
      ev('landing_batch.revert_opened', { repo: 'owner/repo', tip: 't', sha: 's', culpritPullRequest: 14, pullRequest: 20, url: 'https://github.com/owner/repo/pull/20' }, at),
      ev('landing_batch.reverted', { repo: 'owner/repo', tip: 't', sha: 's', pullRequest: 20, url: 'https://github.com/owner/repo/pull/20' }, at),
    ]);
    const inside = gradeFactsOf(job, events, undefined, revert('2026-10-03T00:00:00.000Z'), 7);
    expect(inside.pullRequest?.reverted).toEqual({ at: '2026-10-03T00:00:00.000Z', url: 'https://github.com/owner/repo/pull/20' });
    expect(gradeFactsOf(job, events, undefined, revert('2026-10-20T00:00:00.000Z'), 7).pullRequest).not.toHaveProperty('reverted');
  });

  it('counts a run again of the job, and a partly done end', () => {
    const f = gradeFactsOf({ ...job, partlyDone: PR }, [ev('job.rerun', { by: 'user', nextJobId: 'j4' }, '2026-10-02T00:00:00.000Z', 'j1')], undefined, new Map());
    expect(f).toMatchObject({ reruns: 1, partlyDone: true });
    expect(f).not.toHaveProperty('costUsd');
  });
});

describe('user grades and rollups (issue #2845)', () => {
  it('maps 1 to 5 on 0 to 100 and says when the two grades disagree', () => {
    expect([1, 2, 3, 4, 5].map(userPointsOf)).toEqual([0, 25, 50, 75, 100]);
    expect(disagreesOf(90, 1)).toBe(true);
    expect(disagreesOf(90, 4)).toBe(false);
  });

  const row = (jobId: string, harness: string, score: number, user?: number): GradeRow => ({
    jobId, endedAt: '2026-10-01T00:00:00.000Z', harness, kind: 'code', repo: 'owner/repo',
    auto: { score, lines: [] }, ...(user !== undefined ? { user: { score: user, by: 'p', at: '2026-10-02T00:00:00.000Z' } } : {}),
  });

  it('rolls up by a group: jobs, the mean of each grade and the disagreements, the best first', () => {
    const rows = [row('a', 'herdr-claude', 80, 5), row('b', 'herdr-claude', 60), row('c', 'codex', 90, 1)];
    expect(gradeRollup(rows, 'harness')).toEqual([
      { key: 'codex', jobs: 1, auto: 90, userGraded: 1, user: 1, disagreements: 1 },
      { key: 'herdr-claude', jobs: 2, auto: 70, userGraded: 1, user: 5, disagreements: 0 },
    ]);
    expect(gradeRollup(rows, 'model')).toEqual([{ key: '(none)', jobs: 3, auto: 76.7, userGraded: 2, user: 3, disagreements: 1 }]);
  });
});
