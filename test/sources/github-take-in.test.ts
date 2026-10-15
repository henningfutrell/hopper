// Take into Intake (issue #1176): an untracked pull request whose issue is not in Intake offers that issue to Intake. The
// person's act gives the issue the source's label and assigns it to the connected account, as Assign to me does; the next
// sync lists it in Intake (a request card when the label is not a trusted actor's). Only an issue the last census listed so.
import { describe, expect, it } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import type { GitHubSourceOptions } from '../../src/sources/github/index.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const AT = '2026-10-08T09:00:00.000Z';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

function setup() {
  const gh = createFakeGitHub();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const options: GitHubSourceOptions = {
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config: githubConfig({}), api: gh,
    trust: testTrust(undefined, { assignedHere: (k) => events.some((e) => e.type === 'source.issues_assigned' && (e.data.keys as string[]).includes(k)) }),
    clock: { now: () => new Date('2026-10-08T10:00:00.000Z') },
    knownKeys: () => new Set(),
    landingBranch: () => 'main',
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: AT, changes: [] }), migrated: () => {},
      record: (type, data) => { events.push({ type, data }); }, requestOpened: () => false, requestsWaiting: () => [],
    },
  };
  return { gh, events, source: createGitHubSource(options) };
}

const notTracked = { tracked: () => false, issueTracked: () => false, followedOf: () => undefined };

describe('take into Intake (issue #1176)', () => {
  it('labels and assigns the issue of an untracked pull request that is not in Intake; the next sync lists it in Intake', async () => {
    const { gh, events, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'], assignees: ['someone'] });
    gh.createIssue({ repo: REPO, body: 'No label.' });
    const pr = gh.openPullRequest(REPO, 2, { createdAt: AT, base: 'main' });
    await source.discover();
    await source.censusPullRequests!({ ...notTracked, issueTracked: (u) => u === url(1) });
    expect(source.describe().untrackedPullRequests).toEqual([expect.objectContaining({ url: pr.url, reason: 'issue_not_in_intake', offer: 'take_in' })]);
    expect(await source.intakeAction?.({ kind: 'take_in', keys: [url(2)] })).toEqual({ done: [url(2)], failed: {} });
    // The writes are outbox rows (issue #1238), sent after the answer: the label and the assignment, two calls.
    await source.flushOutbox?.();
    await source.discover();
    expect(gh.issue(REPO, 2).labels).toContain('hopper');
    expect(gh.issue(REPO, 2).assignees).toEqual(['owner']);
    expect(events).toContainEqual({ type: 'source.issue_taken_in', data: { source: 'github', key: url(2), pullRequest: pr.url, assignee: 'owner' } });
    expect(source.intake?.().map((x) => x.key)).toContain(url(2));
  });

  it('only an issue the last census listed as not in Intake', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, body: 'No label, no pull request.' });
    await source.discover();
    await source.censusPullRequests!(notTracked);
    expect(await source.intakeAction?.({ kind: 'take_in', keys: [url(1), url(2)] }))
      .toEqual({ done: [], failed: { [url(1)]: 'not offered: no untracked pull request closes it', [url(2)]: 'not offered: no untracked pull request closes it' } });
    expect(gh.issue(REPO, 2).labels).toEqual([]);
  });
});
