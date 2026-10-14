// Issue #1073 part 3: a work item's landing stage. A job's pull request merged into the landing branch waits for a batch
// run; the batch run carries it, and green moves it to the tested branch. A red batch bisects it; the culprit is reverted.
// The stage is folded from the repository's `landing_batch.*` events into each item whose pull request they name. Pure.
//
// Feature: the landing stage of a work item
//   Scenario: a merge waits for a batch run, is in one, and is promoted with it
//   Scenario: a red batch bisects its pull requests; the culprit is reverted and has a fix issue; the rest wait again
//   Scenario: a culprit stays a culprit when later batches name its merge again
//   Scenario: an event of another repository or another tip leaves the item as it is
//   Scenario: a new job of the item takes it over: its landing stage is history
//   Scenario: the Landing list shows the items in motion, and a revert for a week
import { describe, expect, it } from 'vitest';
import { applyEvent, type WorkItem } from '../../src/domain/work-items.ts';
import { applyLanding, landingCards, landingTargets, LANDING_LEDGER_EVENTS } from '../../src/domain/work-item-landing.ts';
import type { EventType } from '../../src/domain/types.ts';

const REPO = 'owner/app';
const TIP = '0123456789abcdef0123456789abcdef01234567';
const TIP2 = 'fedcba9876543210fedcba9876543210fedcba98';
const item = (n: number, over: Partial<WorkItem> = {}): WorkItem => ({
  key: `https://github.com/Owner/App/issues/${n}`, state: 'done', stateSince: '2026-10-14T09:00:00.000Z', eventState: 'done', eventAt: '2026-10-14T09:00:00.000Z',
  jobId: `j${n}`, pullRequest: `https://github.com/Owner/App/pull/${n}`, pullRequestState: 'merged', keptWork: [], version: 3, ...over,
});

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown>) => ({ type, at: `2026-10-14T10:${String(minute++).padStart(2, '0')}:00.000Z`, data: { repo: REPO, ...data } });

/** Fold `steps` into `i`, as the store does: each event moves the item or leaves it. */
function fold(i: WorkItem, steps: [EventType, Record<string, unknown>][]): WorkItem {
  for (const [type, data] of steps) i = applyLanding(i, ev(type, data)) ?? i;
  return i;
}

describe('the landing stage of a work item (issue #1073)', () => {
  it('a merge waits for a batch run, is in one, and is promoted with it; the item stays done', () => {
    const waiting = fold(item(12), [['landing_batch.pending', { tip: TIP, merges: [12, 14] }]]);
    expect(waiting).toMatchObject({ state: 'done', version: 4, landing: { repo: REPO, stage: 'waiting' } });
    const running = fold(waiting, [['landing_batch.started', { tip: TIP, merges: [12, 14], pullRequest: 100, url: 'u' }]]);
    expect(running.landing).toMatchObject({ stage: 'batch_run', tip: TIP, batch: 100 });
    const promoted = fold(running, [['landing_batch.promoted', { tip: TIP, pullRequest: 100, url: 'u' }]]);
    expect(promoted).toMatchObject({ state: 'done', landing: { stage: 'promoted', tip: TIP, batch: 100 } });
    // The same stage again moves nothing: no new version.
    expect(applyLanding(waiting, ev('landing_batch.pending', { tip: TIP, merges: [12] }))).toBeUndefined();
  });

  it('a red batch bisects its pull requests; the culprit is reverted and has a fix issue; the rest wait again', () => {
    const red: [EventType, Record<string, unknown>][] = [
      ['landing_batch.started', { tip: TIP, merges: [12, 14], pullRequest: 100, url: 'u' }],
      ['landing_batch.failed', { tip: TIP, pullRequest: 100, url: 'u', reason: 'checks failed: test' }],
      ['landing_batch.bisect_started', { tip: TIP, points: [{ sha: 'a', pullRequest: 12 }, { sha: 'b', pullRequest: 14 }], pullRequest: 100 }],
    ];
    expect(fold(item(12), red).landing).toMatchObject({ stage: 'bisecting', tip: TIP });
    const ended = [...red, ['landing_batch.culprit', { tip: TIP, sha: 'b', pullRequest: 14 }]] as typeof red;
    expect(fold(item(12), ended).landing).toMatchObject({ stage: 'waiting', tip: TIP });
    const culprit = fold(item(14), ended);
    expect(culprit.landing).toMatchObject({ stage: 'culprit', tip: TIP });
    const reverted = fold(culprit, [
      ['landing_batch.revert_opened', { tip: TIP, sha: 'b', culpritPullRequest: 14, pullRequest: 101, url: 'r' }],
      ['landing_batch.reverted', { tip: TIP, sha: 'b', pullRequest: 101, url: 'r' }],
      ['landing_batch.fix_filed', { tip: TIP, sha: 'b', issue: 105, url: 'https://github.com/owner/app/issues/105' }],
    ]);
    expect(reverted.landing).toMatchObject({ stage: 'reverted', revert: 101, fixIssue: 'https://github.com/owner/app/issues/105' });
    // A bisect with no verdict: its pull requests wait for the next batch run.
    expect(fold(item(12), [...red, ['landing_batch.bisect_tested', { tip: TIP, index: 0, sha: 'a', outcome: 'unknown' }]]).landing?.stage).toBe('waiting');
  });

  it('a culprit found only by its sha is named by its revert', () => {
    const steps: [EventType, Record<string, unknown>][] = [
      ['landing_batch.started', { tip: TIP, merges: [14], pullRequest: 100, url: 'u' }],
      ['landing_batch.failed', { tip: TIP, pullRequest: 100, url: 'u' }],
      ['landing_batch.culprit', { tip: TIP, sha: 'b' }],
      ['landing_batch.revert_opened', { tip: TIP, sha: 'b', culpritPullRequest: 14, pullRequest: 101, url: 'r' }],
    ];
    expect(fold(item(14), steps).landing).toMatchObject({ stage: 'culprit', revert: 101 });
  });

  it('a culprit stays a culprit when later batches name its merge again', () => {
    const reverted = item(14, { landing: { repo: REPO, stage: 'reverted', since: 'x', tip: TIP, revert: 101 } });
    expect(applyLanding(reverted, ev('landing_batch.pending', { tip: TIP2, merges: [14, 15] }))).toBeUndefined();
    expect(applyLanding(reverted, ev('landing_batch.started', { tip: TIP2, merges: [14, 15], pullRequest: 102, url: 'u' }))).toBeUndefined();
    expect(applyLanding(reverted, ev('landing_batch.promoted', { tip: TIP2, pullRequest: 102, url: 'u' }))).toBeUndefined();
  });

  it('an event of another repository or another tip leaves the item as it is', () => {
    const running = fold(item(12), [['landing_batch.started', { tip: TIP, merges: [12], pullRequest: 100, url: 'u' }]]);
    expect(applyLanding(item(12), { ...ev('landing_batch.started', { tip: TIP, merges: [12], pullRequest: 100 }), data: { repo: 'other/app', tip: TIP, merges: [12] } })).toBeUndefined();
    expect(applyLanding(running, ev('landing_batch.promoted', { tip: TIP2, pullRequest: 102, url: 'u' }))).toBeUndefined();
    // An item with no merged pull request is in no batch.
    expect(applyLanding(item(12, { pullRequestState: 'open' }), ev('landing_batch.pending', { tip: TIP, merges: [12] }))).toBeUndefined();
  });

  it('a new job of the item takes it over: its landing stage is history', () => {
    const promoted = item(12, { landing: { repo: REPO, stage: 'promoted', since: 'x', tip: TIP } });
    const next = applyEvent(promoted, { type: 'job.queued', at: '2026-10-14T11:00:00.000Z', data: {} }, promoted.key, { id: 'j99', key: promoted.key });
    expect(next?.landing).toBeUndefined();
  });

  it('names the pull requests and the tip an event moves, for the store to find their items', () => {
    expect(landingTargets(ev('landing_batch.started', { tip: TIP, merges: [12, 14], pullRequest: 100 }))).toEqual({ repo: REPO, pullRequests: [12, 14], tip: TIP });
    expect(landingTargets(ev('landing_batch.revert_opened', { tip: TIP, culpritPullRequest: 14, pullRequest: 101 }))).toEqual({ repo: REPO, pullRequests: [14], tip: TIP });
    expect(landingTargets(ev('landing_batch.bisect_started', { tip: TIP, points: [{ sha: 'a', pullRequest: 12 }, { sha: 'b' }], pullRequest: 100 }))).toEqual({ repo: REPO, pullRequests: [12], tip: TIP });
    expect(landingTargets({ type: 'landing_batch.retargeted', at: 'x', data: { repo: REPO, pullRequest: 9 } })).toBeUndefined();
    expect(LANDING_LEDGER_EVENTS.has('landing_batch.pending')).toBe(true);
  });

  it('the Landing list shows the items in motion and a revert for a week, newest first', () => {
    const now = Date.parse('2026-10-20T00:00:00.000Z');
    const items = [
      item(12, { landing: { repo: REPO, stage: 'batch_run', since: '2026-10-19T10:00:00.000Z', tip: TIP, batch: 100 } }),
      item(13, { landing: { repo: REPO, stage: 'promoted', since: '2026-10-19T11:00:00.000Z', tip: TIP } }),
      item(14, { landing: { repo: REPO, stage: 'reverted', since: '2026-10-19T12:00:00.000Z', tip: TIP, revert: 101 } }),
      item(15, { landing: { repo: REPO, stage: 'reverted', since: '2026-10-01T12:00:00.000Z', tip: TIP, revert: 99 } }),
      item(16),
    ];
    const cards = landingCards(items, now);
    expect(cards.map((c) => c.pullRequest.number)).toEqual([14, 12]);
    expect(cards[1]).toMatchObject({ repo: REPO, stage: 'batch_run', batch: 100, issue: items[0]!.key, jobId: 'j12', pullRequest: { url: 'https://github.com/Owner/App/pull/12' } });
  });
});
