// Labels are a mirror of the ledger (issue #1892, milestone 2). Intake's reason for an item the ledger mirrors comes from
// its work item's state, not from the labels on the issue; the labels decide only for an issue the hopper does not know,
// or a state the mirror does not judge yet. An end label a person takes off by hand on GitHub is a person's event
// (`work_item.label_edited`): the end label its state wants, seen on the issue at the last discover and gone now, with the
// item not moved since and no write of the hopper's own on its way, is a Run again. It is never read back as state: a label
// that is not on the issue at its first sight is put back, and the item stays where the ledger has it.
import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../../src/sources/github/index.ts';
import { memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import { memoryListings } from '../../src/sources/github/listing.ts';
import { BLOCKED, BLOCKED_STALE, DONE_OPEN, FAILED, PARTLY_DONE, PR_CLOSED, PR_READY } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { RECONCILE_GRACE_MS } from '../../src/domain/item-lifecycle.ts';
import { REPO, jobForIssue } from './fixtures/github-support.ts';
import { LONG_AGO, labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

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

describe('a failed item: hopper:failed mirrors the ledger once its failure was reported (issue #1892)', () => {
  it('Intake\'s reason is the ledger\'s, and the mirror corrects the labels: hopper:failed on, any other end label off', async () => {
    const reported = [url(1), url(2)];
    const { gh, source, reason } = setup({ [url(1)]: { state: 'failed', jobId: 'job-1', failedJobId: 'job-1' }, [url(2)]: { state: 'failed', jobId: 'job-2', failedJobId: 'job-2' } }, { reported, rerunnable: reported });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    expect(await source.discover()).toEqual([]);
    expect(reason(1)?.reason).toBe(FAILED);
    expect(reason(2)?.reason).toBe(FAILED);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper', 'hopper:failed']);
  });

  it('hopper:failed taken off by hand is its Run again: recorded once, the discover runs it, the label is not put back', async () => {
    const { gh, source, edits, later } = setup({ [url(1)]: { state: 'failed', jobId: 'job-1', failedJobId: 'job-1' } }, { reported: [url(1)], rerunnable: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    expect(await source.discover()).toEqual([]);
    gh.removeLabel(REPO, 1, 'hopper:failed');
    later(60_000);
    expect((await source.discover()).map((i) => i.key)).toEqual([url(1)]);
    expect(edits()).toEqual([{ source: 'github', key: url(1), jobId: 'job-1', from: 'failed', label: 'hopper:failed', means: 'run_again' }]);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('a failure not reported as failed (the hopper fixes it, or its report waits), or a reverted culprit not of a whole merge (part 33 judges that one): not judged, the labels decide', async () => {
    const { gh, source, reason, edits } = setup({
      [url(1)]: { state: 'failed', jobId: 'job-1', failedJobId: 'job-1' },
      [url(2)]: { state: 'failed', eventState: 'done', jobId: 'job-2' },
    }, { reported: [url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:claimed'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).not.toBe(FAILED);
    expect(reason(2)?.reason).toBe(DONE_OPEN);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(edits()).toEqual([]);
  });
});

describe('a done item: hopper:done mirrors the ledger once its pull request merged as the whole item (issue #1892)', () => {
  const merged = (n: number): Partial<WorkItem> => ({ state: 'done', jobId: `job-${n}`, pullRequest: `https://github.com/${REPO}/pull/${n + 10}`, pullRequestState: 'merged', wholeMerged: true });

  it('Intake\'s reason is the ledger\'s, and the mirror corrects the labels: hopper:done on, any other end label off', async () => {
    const { gh, source, reason } = setup({ [url(1)]: merged(1), [url(2)]: merged(2) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    expect(await source.discover()).toEqual([]);
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    expect(reason(2)?.reason).toBe(DONE_OPEN);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper', 'hopper:done']);
  });

  it('hopper:done taken off by hand is its Run again: recorded once, the discover runs it, the label is not put back', async () => {
    const { gh, source, edits, later } = setup({ [url(1)]: merged(1) }, { rerunnable: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    expect(await source.discover()).toEqual([]);
    gh.removeLabel(REPO, 1, 'hopper:done');
    later(60_000);
    expect((await source.discover()).map((i) => i.key)).toEqual([url(1)]);
    expect(edits()).toEqual([{ source: 'github', key: url(1), jobId: 'job-1', from: 'done', label: 'hopper:done', means: 'run_again' }]);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('done by a job\'s end with no merge, or by a pull request merged as a part: not judged, the labels decide', async () => {
    const { gh, source, reason, edits } = setup({
      [url(1)]: { state: 'done', jobId: 'job-1' },
      [url(2)]: { state: 'done', jobId: 'job-2', pullRequest: `https://github.com/${REPO}/pull/12`, pullRequestState: 'merged' },
    });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(BLOCKED);
    expect(reason(2)?.reason).toBe(PR_READY);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(edits()).toEqual([]);
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

  it('a label taken off while the hopper was stopped: the next start reads what the listing cache kept, and it is a Run again', async () => {
    const gh = createFakeGitHub();
    const listings = memoryListings();
    const items: Record<string, Partial<WorkItem>> = { [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2, jobId: 'job-1' } };
    const before = setup(items, { gh, listings, rerunnable: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    await before.source.discover();
    gh.removeLabel(REPO, 1, 'hopper:pr-closed');
    const after = setup(items, { gh, listings, rerunnable: [url(1)], at: '2026-10-18T12:30:00.000Z' });
    expect((await after.source.discover()).map((i) => i.key)).toEqual([url(1)]);
    expect(after.edits()).toEqual([{ source: 'github', key: url(1), jobId: 'job-1', from: 'blocked', label: 'hopper:pr-closed', means: 'run_again' }]);
    expect(await after.source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('after a start, an item that moved since the cached listing, or a label the cache never held: no edit, the label is put back', async () => {
    const gh = createFakeGitHub();
    const listings = memoryListings();
    const items: Record<string, Partial<WorkItem>> = { [url(1)]: { blockedCause: 'no_pr', jobId: 'job-1' }, [url(2)]: { blockedCause: 'no_pr', jobId: 'job-2' } };
    const before = setup(items, { gh, listings });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await before.source.discover();
    gh.removeLabel(REPO, 1, 'hopper:blocked');
    items[url(1)] = { ...items[url(1)], eventAt: '2026-10-18T12:05:00.000Z', stateSince: '2026-10-18T12:05:00.000Z' };
    const fresh = memoryListings();
    for (const l of [listings, fresh]) {
      const after = setup(items, { gh, listings: l, at: '2026-10-18T12:30:00.000Z' });
      await after.source.discover();
      expect(after.edits()).toEqual([]);
    }
  });

  it('a Run again drops the mirror\'s label change not sent yet: the label the give-back took off stays off', async () => {
    const outbox = memoryGitHubOutbox();
    const { gh, source } = setup({ [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2, jobId: 'job-1' } }, { outbox });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    const unsent = () => outbox.of('github', url(1)).filter((r) => r.state !== 'sent').map((r) => r.act);
    expect(unsent()).toEqual(['mirror']);
    await source.rerun!(jobForIssue(1, { id: 'job-1', status: 'finished', result: 'ok' }));
    expect(unsent()).toEqual([]);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).not.toContain('hopper:pr-closed');
  });

  it('a discover just after a Run again, before the new job moves the item: the mirror puts back no label the give-back took off', async () => {
    const outbox = memoryGitHubOutbox();
    const { gh, source, later } = setup({ [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2, jobId: 'job-1' } }, { outbox });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    await source.rerun!(jobForIssue(1, { id: 'job-1', status: 'finished', result: 'ok' }));
    expect(gh.issue(REPO, 1).labels).not.toContain('hopper:pr-closed');
    const unsent = () => outbox.of('github', url(1)).filter((r) => r.state !== 'sent').map((r) => r.act);
    await source.discover();
    expect(unsent()).toEqual([]);
    // No new job came: after the grace the item is judged again, and its label put back.
    later(RECONCILE_GRACE_MS + 1);
    await source.discover();
    expect(unsent()).toEqual(['mirror']);
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
