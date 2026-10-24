// The label mirror (issues #1891, #1933): at each discover, the end labels of each issue listed are compared with its work
// item's state. The drift of each judged state is corrected through the GitHub outbox, in one coalesced change, once: the
// #465 case, where the item reconciler blocked an item whose issue still carried `hopper:pr-ready`, and the states a job
// works or a pull request is open in. An item that moved a moment ago, or that has outbox rows not sent, is not judged;
// nor is an issue the same discover takes as a new job (issue #1954): the new job moves the item.
import { describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const NOW = '2026-10-18T12:00:00.000Z';
const LONG_AGO = '2026-10-18T10:00:00.000Z';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

const itemOf = (key: string, o: Partial<WorkItem>): WorkItem => ({
  key, state: 'blocked', stateSince: LONG_AGO, eventState: o.state ?? 'blocked', eventAt: LONG_AGO, keptWork: [], version: 3, ...o,
});

function setup(items: Record<string, Partial<WorkItem>>, o: { parts?: string[]; outbox?: ReturnType<typeof memoryGitHubOutbox>; rerunnable?: string[] } = {}) {
  const gh = createFakeGitHub();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', whoami: 'owner', assignee: () => 'owner', config: githubConfig({}), api: gh,
    trust: testTrust(), ...(o.outbox ? { outbox: o.outbox } : {}), clock: { now: () => new Date(NOW) }, knownKeys: (keys) => new Set(keys.filter((k) => items[k])),
    ...(o.rerunnable ? { rerunnable: (keys: string[]) => new Set(keys.filter((k) => o.rerunnable!.includes(k))) } : {}),
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: LONG_AGO, changes: [] }), migrated: () => {},
      record: () => {}, requestOpened: () => false, requestsWaiting: () => [],
      workItem: (key) => (items[key] ? itemOf(key, items[key]) : undefined),
      partOpen: (key) => o.parts?.includes(key) ?? false,
    },
  });
  const writes = () => gh.calls.filter((c) => c.method === 'addLabels' || c.method === 'removeLabels').map((c) => [c.method, c.args[2]]);
  const drifts = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('differ from its work item'));
  return { gh, source, writes, drifts };
}

describe('labels mirror the database (issue #1891)', () => {
  it('#465: an item blocked past its deadline loses hopper:pr-ready and gets hopper:blocked, in one coalesced change', async () => {
    const { gh, source, writes, drifts } = setup({ [url(1)]: { blockedCause: 'stale' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(writes()).toEqual([]);
    expect(await source.flushOutbox!()).toEqual({ due: 2, wrote: [REPO] });
    expect(writes()).toEqual([['removeLabels', ['hopper:pr-ready']], ['addLabels', ['hopper:blocked']]]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:blocked']);
    expect(drifts()).toHaveLength(1);
    expect(drifts()[0]).toContain('corrected through the outbox');
  });

  it('blocked for want of a pull request (issue #2693): hopper:pr-ready and hopper:blocked come off, and none goes on', async () => {
    const { gh, source, writes } = setup({ [url(1)]: { blockedCause: 'no_pr' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready', 'hopper:blocked'] });
    await source.discover();
    await source.flushOutbox!();
    expect(writes()).toEqual([['removeLabels', ['hopper:pr-ready', 'hopper:blocked']]]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('idempotent: a second discover before the issue is listed again, and one after, add no row', async () => {
    const { gh, source, writes } = setup({ [url(1)]: { blockedCause: 'stale' } });
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

  it.each([
    ['queued', { state: 'queued', jobId: 'job-1' }, ['hopper', 'hopper:done'], ['removeLabels', ['hopper:done']]],
    ['working', { state: 'working', jobId: 'job-1' }, ['hopper', 'hopper:pr-ready', 'hopper:high'], ['removeLabels', ['hopper:pr-ready']]],
    ['waiting_outside', { state: 'waiting_outside', jobId: 'job-1' }, ['hopper', 'hopper:failed'], ['removeLabels', ['hopper:failed']]],
    ['pr_open', { state: 'pr_open', jobId: 'job-1' }, ['hopper', 'hopper:blocked', 'hopper:pr-ready'], ['removeLabels', ['hopper:blocked']]],
  ] as const)('%s: the drift is one coalesced change, once', async (state, item, labels, write) => {
    const { gh, source, writes, drifts } = setup({ [url(1)]: item });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: [...labels] });
    await source.discover();
    await source.discover();
    expect(await source.flushOutbox!()).toEqual({ due: 1, wrote: [REPO] });
    await source.discover();
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(writes()).toEqual([write]);
    expect(gh.issue(REPO, 1).labels).toEqual(labels.filter((l) => !write[1].includes(l as never)));
    expect(drifts()).toEqual([expect.stringMatching(new RegExp(`^hopper: github: .* ${state}: .*: corrected through the outbox$`))]);
  });

  it('PR open with no waiting label: hopper:pr-ready goes on, or hopper:partly-done for a part', async () => {
    const { gh, source, writes } = setup({ [url(1)]: { state: 'pr_open', jobId: 'job-1' }, [url(2)]: { state: 'pr_open', jobId: 'job-2' } }, { parts: [url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper', 'hopper:partly-done']);
    expect(writes()).toHaveLength(2);
  });

  it('an issue the discover takes as a new job is not judged: its end label is not put back (issue #1954)', async () => {
    // Its end label came off since the last discover (a give-back the hopper made, or a person; issue #1892: a Run again):
    // the discover runs it again.
    const { gh, source, drifts } = setup({ [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 1, jobId: 'job-1' } }, { rerunnable: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    expect(await source.discover()).toEqual([]);
    gh.removeLabel(REPO, 1, 'hopper:pr-closed');
    expect((await source.discover()).map((i) => i.key)).toEqual([url(1)]);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(drifts()).toEqual([]);
  });

  it('an item with outbox rows not sent is not judged', async () => {
    const outbox = memoryGitHubOutbox();
    outbox.add([{ source: 'github', act: 'take_in', key: url(1), repo: REPO, tag: '', change: { op: 'add_labels', labels: ['hopper'] } }], LONG_AGO);
    const { gh, source, drifts } = setup({ [url(1)]: { state: 'queued', jobId: 'job-1' } }, { outbox });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(outbox.open('github').filter((r) => r.act === 'mirror')).toEqual([]);
    expect(drifts()).toEqual([]);
  });

  it('an item that moved a moment ago is not judged: its own writes are on their way', async () => {
    const { gh, source, drifts } = setup({ [url(1)]: { blockedCause: 'no_pr', eventAt: '2026-10-18T11:59:30.000Z' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(drifts()).toEqual([]);
  });
});
