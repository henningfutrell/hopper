// Issue #1175: a job's pull request merges into the landing branch, but GitHub closes its issue only on a merge into the
// default branch (the tested branch). So the issue stays open until its batch run reaches the tested branch. Meanwhile the
// item is done and waits on its batch, and Intake neither offers it again nor starts a job for it; a batch run's pull
// request closes the issues of its job pull requests; a culprit and its revert leave their item not done. Pure.
//
// Feature: issues fixed on the landing branch
//   Scenario: a merge on the landing branch waits on its batch until a batch run promotes it, or it turns out a culprit
//   Scenario: a culprit and a reverted one are failed in the ledger; a new job takes the item over
//   Scenario: a batch run's pull request closes the issues of the job pull requests in it, not a part or a culprit
//   Scenario: a job pull request's own closing keywords are closed by its batch run, whatever its job does now (issue #1356)
import { describe, expect, it } from 'vitest';
import { applyEvent, applyLandingEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import { awaitsBatch, batchClosingIssues, LANDING_UNSEEN_MS, promotedOpen } from '../../src/domain/work-item-landing.ts';
import { batchBody, closingReferences } from '../../src/domain/landing-batches.ts';
import type { EventType } from '../../src/domain/types.ts';

const REPO = 'owner/app';
const TIP = '0123456789abcdef0123456789abcdef01234567';
const NOW = Date.parse('2026-10-14T10:30:00.000Z');
const item = (n: number, over: Partial<WorkItem> = {}): WorkItem => ({
  key: `https://github.com/Owner/App/issues/${n}`, state: 'done', stateSince: '2026-10-14T10:00:00.000Z', eventState: 'done', eventAt: '2026-10-14T10:00:00.000Z',
  jobId: `j${n}`, pullRequest: `https://github.com/Owner/App/pull/${n + 100}`, pullRequestState: 'merged', keptWork: [], version: 3, ...over,
});

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown>) => ({ type, at: `2026-10-14T11:${String(minute++).padStart(2, '0')}:00.000Z`, data: { repo: REPO, ...data } });
function fold(i: WorkItem, steps: [EventType, Record<string, unknown>][]): WorkItem {
  for (const [type, data] of steps) i = applyLandingEvent(i, ev(type, data)) ?? i;
  return i;
}
const landingRepo = (repo: string) => repo === REPO;

describe('a merge on the landing branch waits on its batch (issue #1175)', () => {
  it('waits while no batch run carried it, or one is at work or bisects it', () => {
    expect(awaitsBatch(item(1), landingRepo, NOW)).toBe(true);
    for (const stage of ['waiting', 'batch_run', 'bisecting'] as const) {
      expect(awaitsBatch(item(1, { landing: { repo: REPO, stage, since: '2026-10-14T10:01:00.000Z' } }), landingRepo, NOW)).toBe(true);
    }
  });

  it('waits no more once promoted, a culprit or reverted, or in a repository with no landing batches', () => {
    for (const stage of ['promoted', 'culprit', 'reverted'] as const) {
      expect(awaitsBatch(item(1, { landing: { repo: REPO, stage, since: '2026-10-14T10:01:00.000Z' } }), landingRepo, NOW)).toBe(false);
    }
    expect(awaitsBatch(item(1), () => false, NOW)).toBe(false);
  });

  it('a merge no landing event named in an hour is no wait: it predates the batches, so a reopen of its issue counts', () => {
    expect(awaitsBatch(item(1), landingRepo, Date.parse('2026-10-14T10:00:00.000Z') + LANDING_UNSEEN_MS + 1)).toBe(false);
  });

  it('only a done item whose pull request merged waits', () => {
    expect(awaitsBatch(item(1, { state: 'pr_open', pullRequestState: 'open' }), landingRepo, NOW)).toBe(false);
    expect(awaitsBatch(item(1, { state: 'partly_done', eventState: 'partly_done' }), landingRepo, NOW)).toBe(false);
    expect(awaitsBatch(undefined, landingRepo, NOW)).toBe(false);
  });
});

describe('a culprit and a reverted one are not done (issue #1175)', () => {
  const RED: [EventType, Record<string, unknown>][] = [
    ['landing_batch.started', { tip: TIP, merges: [101, 102], pullRequest: 200, url: 'u' }],
    ['landing_batch.failed', { tip: TIP, pullRequest: 200, url: 'u', reason: 'checks failed: test' }],
    ['landing_batch.bisect_started', { tip: TIP, points: [{ sha: 'a', pullRequest: 101 }, { sha: 'b', pullRequest: 102 }], pullRequest: 200 }],
    ['landing_batch.culprit', { tip: TIP, sha: 'b', pullRequest: 102 }],
  ];

  it('the culprit is failed; the rest of its batch stays done', () => {
    expect(fold(item(2), RED)).toMatchObject({ state: 'failed', landing: { stage: 'culprit' } });
    expect(fold(item(1), RED)).toMatchObject({ state: 'done', landing: { stage: 'waiting' } });
  });

  it('reverted, it stays failed, linked to its fix issue', () => {
    const reverted = fold(item(2), [...RED,
      ['landing_batch.revert_opened', { tip: TIP, sha: 'b', culpritPullRequest: 102, pullRequest: 201, url: 'r' }],
      ['landing_batch.reverted', { tip: TIP, sha: 'b', pullRequest: 201, url: 'r' }],
      ['landing_batch.fix_filed', { tip: TIP, sha: 'b', issue: 205, url: 'https://github.com/owner/app/issues/205' }],
    ]);
    expect(reverted).toMatchObject({ state: 'failed', landing: { stage: 'reverted', fixIssue: 'https://github.com/owner/app/issues/205' } });
    // A new job of the item takes it over: the landing stage is history.
    const job: LedgerJob = { id: 'j9', key: reverted.key };
    expect(applyEvent(reverted, ev('job.queued', {}), reverted.key, job)).toMatchObject({ state: 'queued' });
  });

  it('promoted, it stays done', () => {
    expect(fold(item(1), [
      ['landing_batch.started', { tip: TIP, merges: [101], pullRequest: 200, url: 'u' }],
      ['landing_batch.promoted', { tip: TIP, pullRequest: 200, url: 'u' }],
    ])).toMatchObject({ state: 'done', landing: { stage: 'promoted' } });
  });
});

describe('a batch run closes the issues of its job pull requests (issue #1175)', () => {
  it('names each issue a merged job pull request of the batch closes, oldest pull request first', () => {
    const items = [
      item(2), item(1),
      item(3, { state: 'partly_done', eventState: 'partly_done' }),
      item(4, { state: 'failed', landing: { repo: REPO, stage: 'reverted', since: '2026-10-14T10:01:00.000Z' } }),
      item(5, { issueState: 'closed', issueReason: 'completed' }),
      item(6),
      item(7, { key: 'https://github.com/Owner/Other/issues/7' }),
    ];
    expect(batchClosingIssues(items, REPO, [101, 102, 103, 104, 105, 107])).toEqual(['#1', '#2', 'Owner/Other#7']);
  });

  it('the batch run\'s text carries a closing keyword for each', () => {
    const body = batchBody({ landing: 'main', tested: 'dev', tip: TIP, merges: [101, 102], closes: ['#1', '#2'] });
    expect(body).toContain('- #101\n- #102');
    expect(body).toMatch(/\nCloses #1\nCloses #2$/);
    expect(batchBody({ landing: 'main', tested: 'dev', tip: TIP, merges: [101] })).not.toContain('Closes');
  });
});

describe('an item whose job still waits after its merge (issue #1356)', () => {
  const waiting = (n: number, over: Partial<WorkItem> = {}) => item(n, { state: 'waiting_outside', eventState: 'waiting_outside', waitingOn: `issue #${n} closed`, wholeMerged: true, ...over });
  const promoted = { landing: { repo: REPO, pullRequest: 101, stage: 'promoted' as const, since: '2026-10-14T10:05:00.000Z' } };

  it('its batch run closes its issue: the job waits on that close', () => {
    expect(batchClosingIssues([waiting(1), waiting(2, { wholeMerged: undefined })], REPO, [101, 102])).toEqual(['#1']);
  });

  it('promoted with its issue open, the hopper closes the issue', () => {
    expect(promotedOpen(waiting(1, promoted), landingRepo)).toBe(true);
    expect(promotedOpen(waiting(1, { ...promoted, wholeMerged: undefined }), landingRepo)).toBe(false);
    expect(promotedOpen(waiting(1, { ...promoted, issueState: 'closed' }), landingRepo)).toBe(false);
    expect(promotedOpen(item(1, { ...promoted, state: 'pr_open', eventState: 'pr_open' }), landingRepo)).toBe(false);
  });

  it('the ledger keeps a whole merge while its job acts on the item, past a later part, and a new job forgets it', () => {
    const job: LedgerJob = { id: 'j1', key: waiting(1).key };
    const at = { at: '2026-10-14T12:00:00.000Z' };
    const open = item(1, { state: 'working', eventState: 'working', pullRequestState: 'open' });
    const part = applyEvent(open, { type: 'job.pull_request_merged', ...at, data: { pullRequest: open.pullRequest, part: true } }, open.key, job)!;
    expect(part).toMatchObject({ state: 'working', pullRequestState: 'merged' });
    expect(part.wholeMerged).toBeUndefined();
    const whole = applyEvent(open, { type: 'job.pull_request_merged', ...at, data: { pullRequest: open.pullRequest, part: false } }, open.key, job)!;
    expect(whole).toMatchObject({ state: 'working', wholeMerged: true });
    const later = applyEvent(whole, { type: 'job.pull_request_merged', ...at, data: { pullRequest: 'https://github.com/Owner/App/pull/300', part: true } }, open.key, job)!;
    expect(later.wholeMerged).toBe(true);
    expect(applyEvent(whole, { type: 'job.queued', ...at, data: {} }, open.key, { id: 'j2', key: open.key })!.wholeMerged).toBeUndefined();
  });
});

describe('the issues a pull request\'s text closes (issue #1356)', () => {
  it('reads GitHub\'s closing keywords, each issue once, as references from the repository', () => {
    const body = 'Closes #1264\nFixes: #7\nresolved owner/APP#9, closes Other/repo#3\nCloses https://github.com/owner/app/issues/12\nPart of #44\nfixes #7';
    expect(closingReferences(body, REPO)).toEqual(['#1264', '#7', '#9', 'Other/repo#3', '#12']);
  });

  it('names nothing for a part, a mention or no text', () => {
    expect(closingReferences('Part of #1356\nSee #12. Disclosed #3', REPO)).toEqual([]);
    expect(closingReferences('', REPO)).toEqual([]);
  });
});
