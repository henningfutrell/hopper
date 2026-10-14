// Drift between the work-item ledger and GitHub (issue #1077): the items the ledger-vs-GitHub watcher reads, and the drift
// it finds — an item the ledger says failed or waits on its pull request while GitHub says it finished, and a pull request
// or issue state the ledger holds that GitHub does not. A change on GitHub newer than the grace is not drift yet: the
// hopper's own follow may not have seen it. The drift issue names no item: each is a short hash of its key.
import { describe, expect, it } from 'vitest';
import {
  DRIFT_MARKER, driftIssue, driftItemRef, driftKey, ledgerGitHubDrift, ledgerGitHubSample, type GitHubItemState,
} from '../../src/domain/drift.ts';
import type { WorkItem, WorkItemState } from '../../src/domain/work-items.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const HOUR_AGO = '2026-10-13T11:00:00.000Z';
const MINUTE_AGO = '2026-10-13T11:59:00.000Z';
const GRACE = 10 * 60_000;

const item = (n: number, state: WorkItemState, extra: Partial<WorkItem> = {}): WorkItem => ({
  key: `https://github.com/o/r/issues/${n}`, state, stateSince: '2026-10-13T09:00:00.000Z', eventState: state, eventAt: '2026-10-13T09:00:00.000Z',
  keptWork: [], version: 1, ...extra,
});
const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
const reads = (...r: GitHubItemState[]) => new Map(r.map((x) => [x.url, x]));

describe('the ledger-vs-GitHub sample', () => {
  it('reads the issue and the pull request of each item no job or person acts on, the ones that can be stuck first', () => {
    const items = [
      item(1, 'done', { stateSince: '2026-10-13T11:00:00.000Z', pullRequest: pr(11) }),
      item(2, 'working'),
      item(3, 'failed'),
      item(4, 'pr_open', { pullRequest: pr(14) }),
      { ...item(5, 'done'), key: 'direct:abc' },
      item(6, 'dropped', { stateSince: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(ledgerGitHubSample(items, NOW)).toEqual([
      `https://github.com/o/r/issues/4`, pr(14), `https://github.com/o/r/issues/3`, `https://github.com/o/r/issues/1`, pr(11),
    ]);
  });

  it('reads at most the limit of items', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i + 1, 'failed'));
    expect(ledgerGitHubSample(items, NOW, { limit: 3 })).toHaveLength(3);
  });
});

describe('ledger-vs-GitHub drift', () => {
  it('finds a failed item whose pull request merged, or whose issue closed as completed, on GitHub', () => {
    const drift = ledgerGitHubDrift([
      item(1, 'failed', { pullRequest: pr(11), pullRequestState: 'open' }),
      item(2, 'failed'),
      item(3, 'failed'),
    ], reads(
      { url: pr(11), state: 'merged', changedAt: HOUR_AGO },
      { url: 'https://github.com/o/r/issues/2', state: 'closed', stateReason: 'completed', changedAt: HOUR_AGO },
      { url: 'https://github.com/o/r/issues/3', state: 'closed', stateReason: 'not_planned', changedAt: HOUR_AGO },
    ), NOW, GRACE);
    expect(drift).toEqual([{
      watcher: 'ledger-github', kind: 'failed_but_finished',
      items: [
        { key: 'https://github.com/o/r/issues/1', ledger: 'failed', github: 'pull request merged', since: HOUR_AGO },
        { key: 'https://github.com/o/r/issues/2', ledger: 'failed', github: 'issue closed (completed)', since: HOUR_AGO },
      ],
    }]);
  });

  it('finds an item waiting on its pull request when GitHub says it merged or closed', () => {
    const drift = ledgerGitHubDrift([item(4, 'pr_open', { pullRequest: pr(14), pullRequestState: 'open' })], reads({ url: pr(14), state: 'closed', changedAt: HOUR_AGO }), NOW, GRACE);
    expect(drift).toEqual([{ watcher: 'ledger-github', kind: 'pr_open_but_ended', items: [{ key: 'https://github.com/o/r/issues/4', ledger: 'pr_open', github: 'pull request closed', since: HOUR_AGO }] }]);
  });

  it('finds a pull request or issue state the ledger holds that GitHub does not', () => {
    const drift = ledgerGitHubDrift([
      item(5, 'done', { pullRequest: pr(15), pullRequestState: 'merged' }),
      item(6, 'done', { issueState: 'closed', issueReason: 'completed' }),
    ], reads({ url: pr(15), state: 'open' }, { url: 'https://github.com/o/r/issues/6', state: 'open' }), NOW, GRACE);
    expect(drift.map((d) => [d.kind, d.items.map((i) => [i.ledger, i.github])])).toEqual([
      ['pull_request_state', [['done, pull request merged', 'pull request open']]],
      ['issue_state', [['done, issue closed', 'issue open']]],
    ]);
  });

  it('finds no drift while a job or a person acts on the item, when GitHub agrees, or when the change on GitHub is newer than the grace', () => {
    expect(ledgerGitHubDrift([
      item(1, 'working', { pullRequest: pr(11), pullRequestState: 'open' }),
      item(2, 'done', { pullRequest: pr(12), pullRequestState: 'merged' }),
      item(3, 'pr_open', { pullRequest: pr(13), pullRequestState: 'open' }),
      item(4, 'failed'),
    ], reads(
      { url: pr(11), state: 'merged', changedAt: HOUR_AGO },
      { url: pr(12), state: 'merged', changedAt: HOUR_AGO },
      { url: pr(13), state: 'merged', changedAt: MINUTE_AGO },
    ), NOW, GRACE)).toEqual([]);
  });
});

describe('the drift issue', () => {
  const drift = { watcher: 'ledger-github', kind: 'failed_but_finished', items: [{ key: 'https://github.com/o/r/issues/1', ledger: 'failed', github: 'pull request merged', since: HOUR_AGO }] };

  it('carries its drift key, so the next check finds it and updates it instead of filing again', () => {
    const issue = driftIssue(drift, { firstSeen: NOW });
    expect(driftKey(drift)).toBe('ledger-github/failed_but_finished');
    expect(issue.body).toContain(`${DRIFT_MARKER}ledger-github/failed_but_finished`);
    expect(issue.title).toBe('Drift: ledger vs GitHub: failed in the ledger, finished on GitHub');
  });

  it('names no item, repository or person: each item is a short hash of its key', () => {
    const issue = driftIssue(drift, { firstSeen: NOW });
    expect(issue.body).not.toContain('o/r');
    expect(driftItemRef(drift.items[0]!.key)).toMatch(/^[0-9a-f]{12}$/);
    expect(issue.body).toContain(driftItemRef(drift.items[0]!.key));
    expect(issue.body).toContain('failed');
    expect(issue.body).toContain('pull request merged');
  });

  it('says so when no item is in the drift any more', () => {
    expect(driftIssue({ ...drift, items: [] }, { firstSeen: NOW, clearedAt: NOW }).body).toContain('No item is in this drift now');
  });
});
