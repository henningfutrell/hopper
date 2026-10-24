// The report's labels come from the ledger's state (issue #1892 part 15): how a job's report ends its item names the state
// the item moves to, `labelsFor` that state names the end labels, and the change goes out through the GitHub outbox (act
// `report`), kept as rows before it is sent, never as a call of the report's own. The claim goes the same way.
import { describe, expect, it } from 'vitest';
import { reportLabels } from '../../src/sources/github/item-labels.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const labelCalls = (calls: { method: string }[]) => calls.filter((c) => c.method === 'removeLabels' || c.method === 'addLabels').map((c) => c.method);

describe('reportLabels: the end labels of the state a report moves the item to', () => {
  it('a pull request waits: PR open, hopper:pr-ready for a whole, hopper:partly-done for a part, every other end label off', () => {
    expect(reportLabels({ end: 'pr_open', part: false }, ['hopper', 'hopper:failed'])).toEqual({ remove: ['hopper:failed'], add: ['hopper:pr-ready'] });
    expect(reportLabels({ end: 'pr_open', part: true }, ['hopper', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:pr-ready'], add: ['hopper:partly-done'] });
    expect(reportLabels({ end: 'pr_open', part: false }, ['hopper', 'hopper:pr-ready'])).toEqual({ remove: [], add: [] });
  });

  it('no pull request open: no end label (issue #2693)', () => {
    expect(reportLabels({ end: 'no_pr' }, ['hopper'])).toEqual({ remove: [], add: [] });
  });

  it('the issue closed as complete: hopper:done', () => {
    expect(reportLabels({ end: 'closed' }, ['hopper', 'hopper:failed', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:failed', 'hopper:pr-ready'], add: ['hopper:done'] });
  });

  it('failed: hopper:failed; the issue not read, so nothing comes off', () => {
    expect(reportLabels({ end: 'failed' })).toEqual({ remove: [], add: ['hopper:failed'] });
  });

  it('cancelled or rejected: no end label; a tend job cancelled by no person: its pull request waits, hopper:pr-ready', () => {
    expect(reportLabels({ end: 'cancelled', tendAgain: false })).toEqual({ remove: [], add: [] });
    expect(reportLabels({ end: 'cancelled', tendAgain: true })).toEqual({ remove: [], add: ['hopper:pr-ready'] });
    expect(reportLabels({ end: 'rejected' })).toEqual({ remove: [], add: [] });
  });
});

describe('the report\'s label change goes through the GitHub outbox', () => {
  function withIssue() {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    return s;
  }
  const pending = (source: ReturnType<typeof setup>['source']) => (source.describe() as { writeBehindPending?: number }).writeBehindPending;

  it('claimed, then finished: each sent at once, and nothing is left on the way', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: 'x' });
    await source.report({ kind: 'claimed', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:claimed']);
    gh.openPullRequest(REPO, 1, { createdAt: '2026-10-02T11:00:00.000Z' });
    gh.calls.length = 0;
    await source.report({ kind: 'finished', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
    expect(labelCalls(gh.calls)).toEqual(['removeLabels', 'addLabels']);
    expect(pending(source)).toBeUndefined();
  });

  it('GitHub refuses the end labels for now: the report still ends, its rows wait, and a report again sends them once', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed' });
    await source.report({ kind: 'claimed', job });
    gh.failNext('removeLabels', new TypeError('fetch failed'));
    expect(await source.report({ kind: 'failed', job })).toEqual({});
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:claimed']);
    expect(pending(source)).toBe(2);
    // The same report sent again (a stop before its record): its rows are sent again, and none is kept twice.
    gh.calls.length = 0;
    await source.report({ kind: 'failed', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(labelCalls(gh.calls)).toEqual(['removeLabels', 'addLabels']);
    expect(pending(source)).toBeUndefined();
    await source.flushOutbox!();
    expect(labelCalls(gh.calls)).toHaveLength(2);
  });

  it('a claim refused for now and the job\'s end after it: the claim not sent is dropped, so it never lands after the end', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed' });
    gh.failNext('addLabels', new TypeError('fetch failed'));
    await source.report({ kind: 'claimed', job });
    expect(pending(source)).toBe(1);
    gh.calls.length = 0;
    await source.report({ kind: 'failed', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(gh.calls.filter((c) => c.method === 'addLabels').map((c) => c.args)).toEqual([[REPO, 1, ['hopper:failed']]]);
    expect(pending(source)).toBeUndefined();
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
  });

  it('a Run again drops the end labels not sent yet: they were for the state the item left', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed' });
    await source.report({ kind: 'claimed', job });
    gh.failNext('removeLabels', new TypeError('fetch failed'));
    await source.report({ kind: 'failed', job });
    await source.rerun!(job);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(pending(source)).toBeUndefined();
  });
});
