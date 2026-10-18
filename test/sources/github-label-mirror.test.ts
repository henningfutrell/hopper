// The label mirror (issue #1891): at each discover, the end labels of each issue listed are compared with its work item's
// state. A blocked item's labels are corrected through the GitHub outbox, in one coalesced change, once: the #465 case,
// where the item reconciler blocked an item whose issue still carried `hopper:pr-ready`. Any other drift is only logged
// and counted. An item that moved a moment ago, or that has outbox rows not sent, is not judged.
import { describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const NOW = '2026-10-18T12:00:00.000Z';
const LONG_AGO = '2026-10-18T10:00:00.000Z';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

const itemOf = (key: string, o: Partial<WorkItem>): WorkItem => ({
  key, state: 'blocked', stateSince: LONG_AGO, eventState: o.state ?? 'blocked', eventAt: LONG_AGO, keptWork: [], version: 3, ...o,
});

function setup(items: Record<string, Partial<WorkItem>>) {
  const gh = createFakeGitHub();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', whoami: 'owner', assignee: () => 'owner', config: githubConfig({}), api: gh,
    trust: testTrust(), clock: { now: () => new Date(NOW) }, knownKeys: (keys) => new Set(keys.filter((k) => items[k])),
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: LONG_AGO, changes: [] }), migrated: () => {},
      record: () => {}, requestOpened: () => false, requestsWaiting: () => [],
      workItem: (key) => (items[key] ? itemOf(key, items[key]) : undefined),
    },
  });
  const writes = () => gh.calls.filter((c) => c.method === 'addLabels' || c.method === 'removeLabels').map((c) => [c.method, c.args[2]]);
  const drifts = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('differ from its work item'));
  return { gh, source, writes, drifts };
}

describe('labels mirror the database (issue #1891)', () => {
  it('#465: an item blocked for want of a pull request loses hopper:pr-ready and gets hopper:blocked, in one coalesced change', async () => {
    const { gh, source, writes, drifts } = setup({ [url(1)]: { blockedCause: 'no_pr' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(writes()).toEqual([]);
    expect(await source.flushOutbox!()).toEqual({ due: 2, wrote: [REPO] });
    expect(writes()).toEqual([['removeLabels', ['hopper:pr-ready']], ['addLabels', ['hopper:blocked']]]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:blocked']);
    expect(drifts()).toHaveLength(1);
    expect(drifts()[0]).toContain('corrected through the outbox');
  });

  it('idempotent: a second discover before the issue is listed again, and one after, add no row', async () => {
    const { gh, source, writes } = setup({ [url(1)]: { blockedCause: 'no_pr' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    await source.discover();
    await source.flushOutbox!();
    await source.discover();
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(writes()).toHaveLength(2);
  });

  it('a second close of its pull request: hopper:pr-closed in place of hopper:blocked', async () => {
    const { gh, source } = setup({ [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2 } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    await source.discover();
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-closed']);
  });

  it('a drift of another state is logged and counted once, and not corrected', async () => {
    const { gh, source, writes, drifts } = setup({ [url(1)]: { state: 'queued', jobId: 'job-1' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    await source.discover();
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(writes()).toEqual([]);
    expect(drifts()).toEqual([expect.stringContaining('queued: hopper:done on the issue')]);
  });

  it('an item that moved a moment ago is not judged: its own writes are on their way', async () => {
    const { gh, source, drifts } = setup({ [url(1)]: { blockedCause: 'no_pr', eventAt: '2026-10-18T11:59:30.000Z' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(drifts()).toEqual([]);
  });
});
