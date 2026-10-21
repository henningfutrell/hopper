// Labels are a mirror of the ledger (issue #1892, milestone 2). Intake's reason for an item the ledger mirrors comes from
// its work item's state, not from the labels on the issue; the labels decide only for an issue the hopper does not know,
// or a state the mirror does not judge yet. An end label a person takes off by hand on GitHub is a person's event
// (`work_item.label_edited`): the end label its state wants, seen on the issue at the last discover and gone now, with the
// item not moved since and no write of the hopper's own on its way, is a Run again. It is never read back as state: a label
// that is not on the issue at its first sight is put back, and the item stays where the ledger has it.
import { describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import { BLOCKED, BLOCKED_STALE, FAILED, PARTLY_DONE, PR_CLOSED, PR_READY } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO, githubConfig, jobForIssue, testTrust } from './fixtures/github-support.ts';

const LONG_AGO = '2026-10-18T10:00:00.000Z';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

const itemOf = (key: string, o: Partial<WorkItem>): WorkItem => ({
  key, state: 'blocked', stateSince: LONG_AGO, eventState: o.state ?? 'blocked', eventAt: LONG_AGO, keptWork: [], version: 3, ...o,
});

function setup(items: Record<string, Partial<WorkItem>>, o: { parts?: string[]; outbox?: ReturnType<typeof memoryGitHubOutbox>; rerunnable?: string[] } = {}) {
  const gh = createFakeGitHub();
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recorded: { type: string; data: Record<string, unknown> }[] = [];
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', whoami: 'owner', assignee: () => 'owner', config: githubConfig({}), api: gh,
    trust: testTrust(), ...(o.outbox ? { outbox: o.outbox } : {}), clock: { now: () => new Date(now) }, knownKeys: (keys) => new Set(keys.filter((k) => items[k])),
    rerunnable: (keys: string[]) => new Set(keys.filter((k) => o.rerunnable?.includes(k))),
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: LONG_AGO, changes: [] }), migrated: () => {},
      // The ledger folds the person's event into the item: its Run again is asked, its state stays.
      record: (type, data) => {
        recorded.push({ type, data });
        if (type === 'work_item.label_edited') items[String(data.key)] = { ...items[String(data.key)], runAgainAsked: String(data.label) };
      },
      requestOpened: () => false, requestsWaiting: () => [],
      workItem: (key) => (items[key] ? itemOf(key, items[key]) : undefined),
      partOpen: (key) => o.parts?.includes(key) ?? false,
    },
  });
  const edits = () => recorded.filter((r) => r.type === 'work_item.label_edited').map((r) => r.data);
  const reason = (n: number) => source.intake!().find((x) => x.key === url(n));
  const later = (ms: number) => { now += ms; };
  return { gh, source, edits, reason, later, recorded };
}

describe('Intake reads the ledger (issue #1892)', () => {
  it('a job at work with a stale end label on its issue: no reason from the label', async () => {
    const { gh, source, reason } = setup({ [url(1)]: { state: 'working', jobId: 'job-1' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).toBeUndefined();
  });

  it('PR open with no waiting label on its issue: its pull request waits for review, or the part does', async () => {
    const { gh, source, reason } = setup({ [url(1)]: { state: 'pr_open', jobId: 'job-1', pullRequest: `https://github.com/${REPO}/pull/9` }, [url(2)]: { state: 'pr_open', jobId: 'job-2', pullRequest: `https://github.com/${REPO}/pull/10` } }, { parts: [url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    expect(await source.discover()).toEqual([]);
    expect(reason(1)).toMatchObject({ reason: PR_READY, group: 'pr-waiting' });
    expect(reason(2)).toMatchObject({ reason: PARTLY_DONE, group: 'partly-done' });
  });

  it('blocked: the reason names its cause, with Won\'t do, whatever end label the issue carries', async () => {
    const { gh, source, reason } = setup({ [url(1)]: { blockedCause: 'stale', jobId: 'job-1' }, [url(2)]: { blockedCause: 'no_pr', jobId: 'job-2' }, [url(3)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2, jobId: 'job-3' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    expect(reason(1)).toMatchObject({ reason: BLOCKED_STALE, action: 'wont_do' });
    expect(reason(2)).toMatchObject({ reason: BLOCKED, action: 'wont_do' });
    expect(reason(3)).toMatchObject({ reason: PR_CLOSED, action: 'wont_do' });
  });

  it('an issue the hopper does not know, or a state the mirror does not judge yet: the labels decide', async () => {
    const { gh, source, reason } = setup({ [url(2)]: { state: 'failed', jobId: 'job-2' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PR_READY);
    expect(reason(2)?.reason).toBe(FAILED);
  });
});

describe('a label edited by hand on GitHub is a person\'s event (issue #1892)', () => {
  it('hopper:pr-closed taken off a blocked item is its Run again: recorded once, the discover runs it, the label is not put back', async () => {
    const { gh, source, edits, later } = setup({ [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2, jobId: 'job-1' } }, { rerunnable: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    expect(await source.discover()).toEqual([]);
    gh.removeLabel(REPO, 1, 'hopper:pr-closed');
    later(60_000);
    expect((await source.discover()).map((i) => i.key)).toEqual([url(1)]);
    expect(edits()).toEqual([{ source: 'github', key: url(1), jobId: 'job-1', from: 'blocked', label: 'hopper:pr-closed', means: 'run_again' }]);
    await source.discover();
    expect(edits()).toHaveLength(1);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('PR open: hopper:pr-ready taken off is its Run again; a swap for hopper:partly-done is none', async () => {
    const { gh, source, edits, later } = setup({ [url(1)]: { state: 'pr_open', jobId: 'job-1', pullRequest: `https://github.com/${REPO}/pull/9` }, [url(2)]: { state: 'pr_open', jobId: 'job-2', pullRequest: `https://github.com/${REPO}/pull/10` } }, { rerunnable: [url(1), url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:pr-ready');
    gh.removeLabel(REPO, 2, 'hopper:pr-ready');
    gh.addLabel(REPO, 2, 'hopper:partly-done');
    later(60_000);
    expect((await source.discover()).map((i) => i.key)).toEqual([url(1)]);
    expect(edits().map((e) => [e.key, e.label])).toEqual([[url(1), 'hopper:pr-ready']]);
  });

  it('no label at its first sight is not read back as a Run again: the item stays blocked and its label is put back', async () => {
    const { gh, source, edits } = setup({ [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2, jobId: 'job-1' } }, { rerunnable: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    expect(await source.discover()).toEqual([]);
    await source.flushOutbox!();
    expect(edits()).toEqual([]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-closed']);
  });

  it('an item that moved since the label was seen, or with the hopper\'s own writes on their way: no edit', async () => {
    const outbox = memoryGitHubOutbox();
    const items: Record<string, Partial<WorkItem>> = { [url(1)]: { blockedCause: 'no_pr', jobId: 'job-1' }, [url(2)]: { blockedCause: 'no_pr', jobId: 'job-2' } };
    const { gh, source, edits, later } = setup(items, { outbox });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:blocked');
    gh.removeLabel(REPO, 2, 'hopper:blocked');
    later(10 * 60_000);
    items[url(1)] = { ...items[url(1)], eventAt: '2026-10-18T12:05:00.000Z', stateSince: '2026-10-18T12:05:00.000Z' };
    outbox.add([{ source: 'github', act: 'wont_do', key: url(2), repo: REPO, tag: '', change: { op: 'remove_labels', labels: ['hopper:blocked'] } }], LONG_AGO);
    await source.discover();
    expect(edits()).toEqual([]);
  });
});

describe('the report tells the ledger of a close it found (issue #1892)', () => {
  it('a job ends on an issue closed as completed already: hopper:done goes on, and the ledger reads the close', async () => {
    const { gh, source, recorded } = setup({ [url(1)]: { state: 'working', jobId: 'job-1' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-18T11:00:00.000Z', mergedAt: '2026-10-18T11:30:00.000Z' });
    await source.report({ kind: 'finished', job: jobForIssue(1, { id: 'job-1', status: 'finished', result: 'ok' }) });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(recorded).toEqual([{ type: 'work_item.issue_closed', data: { key: url(1), reason: 'completed', via: 'read' } }]);
  });

  it('a close the ledger holds already is not recorded again', async () => {
    const { gh, source, recorded } = setup({ [url(1)]: { state: 'working', jobId: 'job-1', issueState: 'closed', issueReason: 'completed' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-18T11:00:00.000Z', mergedAt: '2026-10-18T11:30:00.000Z' });
    await source.report({ kind: 'finished', job: jobForIssue(1, { id: 'job-1', status: 'finished', result: 'ok' }) });
    expect(recorded).toEqual([]);
  });
});
