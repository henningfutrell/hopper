// A job's pull request in a repository the hopper does not merge in (issue #2752 part 4): none of the job repositories, and
// no person named it on in yolo mode, so the hopper never merges it there. The issue says so: `hopper:needs-merge` in place of
// `hopper:pr-ready` (or `hopper:partly-done`). The job's report puts it on, the mirror keeps it, and Intake says why the issue
// keeps out. Once the repository merges (a person named it on), the mirror swaps it back for `hopper:pr-ready`.
import { describe, expect, it } from 'vitest';
import { NEEDS_MERGE, PR_READY } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO, jobForIssue, setup as sourceSetup } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const OTHER = 'owner/app';
const pr = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const open = (repo: string): Partial<WorkItem> => ({ state: 'pr_open', eventState: 'pr_open', jobId: 'job-1', pullRequest: pr(repo, 7) });
const done: Partial<WorkItem> = { state: 'done', eventState: 'done', jobId: 'job-1', issueState: 'open', pullRequest: pr(OTHER, 7) };

describe('the label mirror: hopper:needs-merge for a pull request the hopper does not merge (issue #2752)', () => {
  it('PR open in such a repository: Intake says it needs a merge there, and the mirror swaps hopper:pr-ready for hopper:needs-merge', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: open(OTHER) }, { needsMerge: [OTHER] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)).toMatchObject({ reason: NEEDS_MERGE, group: 'pr-waiting' });
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:needs-merge']);
    expect(edits()).toEqual([]);
  });

  it('a part in such a repository: hopper:needs-merge too', async () => {
    const { gh, source } = setup({ [url(1)]: open(OTHER) }, { needsMerge: [OTHER], parts: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:partly-done'] });
    await source.discover();
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:needs-merge']);
  });

  it('a repository the hopper merges in now: the mirror swaps hopper:needs-merge back for hopper:pr-ready', async () => {
    const { gh, source, reason } = setup({ [url(1)]: open(OTHER) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:needs-merge'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PR_READY);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('a done item whose report found its pull request waiting there: hopper:needs-merge', async () => {
    const { gh, source, reason } = setup({ [url(1)]: done }, { needsMerge: [OTHER], doneOpen: { [url(1)]: 'pr_open' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(NEEDS_MERGE);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:needs-merge']);
  });

  it('hopper:needs-merge taken off by hand is a Run again', async () => {
    const { gh, source, edits, later } = setup({ [url(1)]: open(OTHER) }, { needsMerge: [OTHER] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:needs-merge'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:needs-merge');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), label: 'hopper:needs-merge', means: 'run_again' })]);
  });
});

describe('the report: hopper:needs-merge for a pull request the hopper does not merge (issue #2752)', () => {
  it('a done job whose pull request is in such a repository: hopper:needs-merge, not hopper:pr-ready', async () => {
    const opened: string[] = [];
    const s = sourceSetup({}, { openedPullRequests: () => opened, needsMerge: (repo) => repo === OTHER });
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const made = s.gh.openUnlinkedPullRequest(OTHER, { createdAt: '2026-10-02T11:00:00.000Z', headRef: 'change' });
    opened.push(made.url);
    expect(await s.source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) })).toEqual({ follow: 'open', pullRequest: made.url });
    expect(s.gh.issue(REPO, 1).labels).toContain('hopper:needs-merge');
    expect(s.gh.issue(REPO, 1).labels).not.toContain('hopper:pr-ready');
  });

  it('one in the issue\'s own repository: hopper:pr-ready as before', async () => {
    const opened: string[] = [];
    const s = sourceSetup({}, { openedPullRequests: () => opened, needsMerge: (repo) => repo === OTHER });
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const made = s.gh.openUnlinkedPullRequest(REPO, { createdAt: '2026-10-02T11:00:00.000Z', headRef: 'change' });
    opened.push(made.url);
    await s.source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) });
    expect(s.gh.issue(REPO, 1).labels).toContain('hopper:pr-ready');
    expect(s.gh.issue(REPO, 1).labels).not.toContain('hopper:needs-merge');
  });
});
