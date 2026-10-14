// The ledger-vs-GitHub watcher (issue #1077): it samples the work-item ledger, reads those issues and pull requests on
// GitHub in batches, and answers the drift. With no GitHub connection the check fails and says why.
import { describe, expect, it } from 'vitest';
import { ledgerGitHubWatcher } from '../../src/component-watchers/ledger-github.ts';
import type { GitHubItemState } from '../../src/domain/drift.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const row: WorkItem = {
  key: 'https://github.com/o/r/issues/1', state: 'pr_open', stateSince: '2026-10-13T09:00:00.000Z', eventState: 'pr_open', eventAt: '2026-10-13T09:00:00.000Z',
  pullRequest: 'https://github.com/o/r/pull/2', pullRequestState: 'open', keptWork: [], version: 3,
};

describe('the ledger-vs-GitHub watcher', () => {
  it('finds a ledger row that disagrees with GitHub, reading GitHub in batches', async () => {
    const asked: string[][] = [];
    const w = ledgerGitHubWatcher({
      ledger: { list: () => [row] },
      github: () => ({
        async states(urls) {
          asked.push(urls);
          return new Map<string, GitHubItemState>([[row.pullRequest!, { url: row.pullRequest!, state: 'merged', changedAt: '2026-10-13T10:00:00.000Z' }]]);
        },
      }),
      now: () => NOW,
    });
    expect(await w.check()).toEqual([{ watcher: 'ledger-github', kind: 'pr_open_but_ended', items: [{ key: row.key, ledger: 'pr_open', github: 'pull request merged', since: '2026-10-13T10:00:00.000Z' }] }]);
    expect(asked).toEqual([[row.key, row.pullRequest]]);
  });

  it('fails the check with no GitHub connection', async () => {
    const w = ledgerGitHubWatcher({ ledger: { list: () => [row] }, github: () => ({ problem: 'your GitHub is not connected' }), now: () => NOW });
    await expect(w.check()).rejects.toThrow('your GitHub is not connected');
  });
});
