// The work-item ledger's reducer (issue #1067): one item per source key, its state folded from the events in order and
// settled with what GitHub said of its issue and pull request. "Failed" is only the newest attempt's failure, nobody
// dismissed and nothing replaced; a finished job waits on its pull request until it merges.
import { describe, expect, it } from 'vitest';
import {
  applyEvent, applyRead, countStates, inFlightOf, inFlightPartOf, isFailureOf, isInFlight, issueClosedAsComplete, keptWorkShown, keyOfEvent, pullRequestWaitOf, requestsWaitingOf,
  type LedgerJob, type WorkItem,
} from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
const j2: LedgerJob = { id: 'j2', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-13T10:${String(minute++).padStart(2, '0')}:00.000Z`, data });

/** Fold `steps` from no item, each `[type, data, job]`. */
function fold(steps: [EventType, Record<string, unknown>?, LedgerJob?][]): WorkItem | undefined {
  let item: WorkItem | undefined;
  for (const [type, data, job] of steps) item = applyEvent(item, ev(type, data), KEY, job ?? j1) ?? item;
  return item;
}

describe('the work-item reducer', () => {
  it('follows a job from the queue to its pull request and the merge: no "ready for review", it waits on the merge', () => {
    const queued = fold([['job.queued']]);
    expect(queued).toMatchObject({ key: KEY, state: 'queued', jobId: 'j1', version: 1 });
    const working = fold([['job.queued'], ['job.claimed'], ['job.started']]);
    expect(working?.state).toBe('working');
    const open = fold([['job.queued'], ['job.started'], ['job.finished', { result: 'pull request ready for review' }], ['job.pull_request_followed', { pullRequest: PR, part: false }]]);
    expect(open).toMatchObject({ state: 'pr_open', pullRequest: PR, pullRequestState: 'open', waitingOn: 'its pull request: checks and the merge' });
    const merged = fold([['job.queued'], ['job.started'], ['job.finished', { result: 'pull request ready for review' }], ['job.pull_request_merged', { pullRequest: PR, part: false }]]);
    expect(merged).toMatchObject({ state: 'done', pullRequestState: 'merged' });
    expect(merged?.waitingOn).toBeUndefined();
  });

  it('a part merged is partly done until the next job takes the item', () => {
    const part = fold([['job.queued'], ['job.finished', { result: 'partly done', partlyDone: PR }], ['job.pull_request_merged', { pullRequest: PR, part: true }]]);
    expect(part).toMatchObject({ state: 'partly_done', waitingOn: 'the next part' });
    const next = fold([['job.queued'], ['job.finished', { result: 'partly done', partlyDone: PR }], ['job.pull_request_merged', { pullRequest: PR, part: true }], ['job.queued', {}, j2]]);
    expect(next).toMatchObject({ state: 'queued', jobId: 'j2' });
    expect(next?.pullRequest).toBeUndefined();
  });

  it('a failure counts only while it is the newest attempt and nobody dismissed it', () => {
    expect(fold([['job.queued'], ['job.started'], ['job.failed', { error: 'boom' }]])).toMatchObject({ state: 'failed', failedJobId: 'j1' });
    // A later job of the item takes its place: the older job's rerun and end move nothing.
    const replaced = fold([['job.queued'], ['job.failed', { error: 'boom' }], ['job.queued', {}, j2], ['job.rerun', { by: 'user' }], ['job.started', {}, j2]]);
    expect(replaced).toMatchObject({ state: 'working', jobId: 'j2' });
    expect(replaced?.failedJobId).toBeUndefined();
    expect(fold([['job.queued'], ['job.failed', { error: 'boom' }], ['job.dismissed', { by: 'user' }]])?.state).toBe('dropped');
    // The merge of the pull request a failed tend job worked settles it.
    const tended = fold([['job.queued'], ['job.finished', {}], ['job.queued', {}, j2], ['job.failed', { error: 'tend failed' }, j2], ['job.pull_request_merged', { pullRequest: PR, part: false }]]);
    expect(tended?.state).toBe('done');
  });

  it('a question for a person, a parked job and a hand-off need you; a wait outside names what it waits on', () => {
    expect(fold([['job.queued'], ['job.started'], ['question.escalated_to_human', { questionId: 'q1' }]])).toMatchObject({ state: 'needs_you', waitingOn: 'a question' });
    expect(fold([['job.queued'], ['job.started'], ['question.escalated_to_human'], ['job.requeued', { from: 'waiting_answer', reason: 'answered' }]])?.state).toBe('queued');
    expect(fold([['job.queued'], ['job.started'], ['job.parked', { from: 'running' }]])?.state).toBe('needs_you');
    expect(fold([['job.queued'], ['job.failed', { error: 'x' }], ['handoff.opened', {}]])).toMatchObject({ state: 'needs_you', waitingOn: 'a hand-off' });
    expect(fold([['job.queued'], ['job.failed', { error: 'x' }], ['handoff.opened', {}], ['handoff.closed', { handoffId: 'h', end: 'wont_do' }]])?.state).toBe('dropped');
    expect(fold([['job.queued'], ['job.started'], ['job.waiting', { for: 'write access' }]])).toMatchObject({ state: 'waiting_outside', waitingOn: 'write access' });
    expect(fold([['job.queued'], ['job.started'], ['job.waiting', { for: 'the build', ownCommand: true }]])).toMatchObject({ state: 'working', waitingOn: 'the build' });
    // Issue #1210: its command only polls hopper state: the ledger says what it waits on.
    expect(fold([['job.queued'], ['job.started'], ['job.waiting', { for: 'the build', ownCommand: true }], ['job.wait_polled', { on: { kind: 'pull_request', number: 8, about: 'merge' } }]]))
      .toMatchObject({ state: 'working', waitingOn: 'PR #8 to merge (it polls the hopper)' });
  });

  it('a proposal or a research report at a person needs you, never working (issue #1174); the decision moves it on', () => {
    const proposal = fold([['job.queued'], ['job.started'], ['proposal.submitted', { proposalId: 'p1' }], ['proposal.escalated_to_human', { proposalId: 'p1', reason: 'no reviewer levels configured' }]]);
    expect(proposal).toMatchObject({ state: 'needs_you', waitingOn: 'a proposal' });
    expect(inFlightOf([proposal!]).total).toBe(0);
    expect(countStates([proposal!]).needs_you).toBe(1);
    expect(fold([['job.queued'], ['job.started'], ['research.escalated_to_human', { researchId: 'r1' }]])).toMatchObject({ state: 'needs_you', waitingOn: 'a research report' });
    expect(fold([['job.queued'], ['job.started'], ['proposal.escalated_to_human'], ['job.requeued', { from: 'waiting_answer', reason: 'proposal sent back' }]])?.state).toBe('queued');
    expect(fold([['job.queued'], ['job.started'], ['proposal.escalated_to_human'], ['job.finished', { result: { proposal: { id: 'p1', decision: 'accept' } } }]])?.state).not.toBe('needs_you');
    // An older job's proposal moves nothing once a newer job holds the item.
    expect(fold([['job.queued'], ['job.queued', {}, j2], ['job.started', {}, j2], ['proposal.escalated_to_human', {}, j1]])?.state).toBe('working');
  });

  it('a stray pull request closed (issue #1143 part 4) moves nothing: its item waits as it did', () => {
    const other = 'https://github.com/o/r/pull/3';
    const handoff = fold([['job.queued'], ['job.failed', { error: 'x' }], ['handoff.opened', {}], ['job.pull_request_closed', { pullRequest: other, part: false, superseded: 'why', stray: true }]]);
    expect(handoff).toMatchObject({ state: 'needs_you', waitingOn: 'a hand-off' });
    expect(handoff?.pullRequest).toBeUndefined();
    // The item's own pull request: its state is kept, the item stays where it is.
    const own = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_followed', { pullRequest: PR, part: false }], ['job.queued', {}, j2],
      ['job.failed', { error: 'tend failed' }, j2], ['handoff.opened', {}, j2], ['job.pull_request_closed', { pullRequest: PR, part: false, superseded: 'why', stray: true }]]);
    expect(own).toMatchObject({ state: 'needs_you' });
  });

  it('a stray pull request merged or closed on GitHub (issue #1420) marks only its own state: its item waits as it did', () => {
    const handedOff: Parameters<typeof fold>[0] = [['job.queued'], ['job.finished', {}], ['job.pull_request_followed', { pullRequest: PR, part: false }], ['job.queued', {}, j2],
      ['job.failed', { error: 'tend failed' }, j2], ['handoff.opened', {}, j2]];
    const merged = fold([...handedOff, ['job.pull_request_merged', { pullRequest: PR, part: false, stray: true }]]);
    expect(merged).toMatchObject({ state: 'needs_you', waitingOn: 'a hand-off' });
    expect(merged?.wholeMerged).toBeUndefined();
    // The item's own pull request: only its state is marked; the item settles as GitHub has it — merged, done; closed, as it was.
    const followed: Parameters<typeof fold>[0] = [['job.queued'], ['job.finished', {}], ['job.pull_request_followed', { pullRequest: PR, part: false }]];
    const ownMerged = fold([...followed, ['job.pull_request_merged', { pullRequest: PR, part: false, stray: true }]]);
    expect(ownMerged).toMatchObject({ state: 'done', pullRequest: PR, pullRequestState: 'merged' });
    expect(ownMerged?.wholeMerged).toBeUndefined();
    const ownClosed = fold([...followed, ['job.pull_request_closed', { pullRequest: PR, part: false, stray: true }]]);
    expect(ownClosed).toMatchObject({ state: fold(followed)?.state, pullRequest: PR, pullRequestState: 'closed' });
  });

  it('a request card waits for approval; declined it is dropped', () => {
    const opened = applyEvent(undefined, ev('source.request_opened', { key: KEY }), KEY);
    expect(opened?.state).toBe('waiting_for_approval');
    expect(applyEvent(opened, ev('source.request_declined', { key: KEY }), KEY)?.state).toBe('dropped');
    expect(applyEvent(opened, ev('source.request_approved', { key: KEY }), KEY)?.state).toBe('queued');
  });

  it('cancelled, rejected, and a pull request a person closed without a merge are dropped; done-by-hand and a direct job are done', () => {
    expect(fold([['job.queued'], ['job.cancelled', { reason: 'r' }]])?.state).toBe('dropped');
    expect(fold([['job.queued'], ['job.rejected', { by: 'user', reason: 'r' }]])?.state).toBe('dropped');
    expect(fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false, person: 'p', via: 'ui' }]])?.state).toBe('dropped');
    expect(fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false, superseded: 'its issue was closed by another' }]])?.state).toBe('dropped');
    expect(fold([['job.queued'], ['job.failed', { error: 'x' }], ['job.finished', { result: { summary: 'done by hand' } }]])?.state).toBe('done');
    expect(fold([['job.queued', {}, { id: 'j1', key: KEY, kind: 'direct' }], ['job.finished', { result: 'ok' }, { id: 'j1', key: KEY, kind: 'direct' }]])?.state).toBe('done');
  });

  it('keeps which jobs hold work not pushed, whatever the item\'s state', () => {
    const kept = fold([['job.queued'], ['job.failed', { error: 'x' }], ['job.work_kept', { paths: ['/w'] }], ['job.queued', {}, j2]]);
    expect(kept?.keptWork).toEqual(['j1']);
    expect(fold([['job.queued'], ['job.work_kept', { paths: ['/w'] }], ['job.work_removed', { paths: ['/w'] }]])?.keptWork).toEqual([]);
  });

  it('an issue closed on GitHub settles an item no job acts on: completed is done, not planned is dropped', () => {
    const failed = fold([['job.queued'], ['job.failed', { error: 'x' }]])!;
    expect(applyRead(failed, { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'CLOSED', reason: 'COMPLETED' })?.state).toBe('done');
    expect(applyRead(failed, { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'closed', reason: 'not_planned' })?.state).toBe('dropped');
    // A read older than the item's newest event is old news; an item a job works keeps its state.
    expect(applyRead(failed, { kind: 'issue', at: '2026-10-01T00:00:00.000Z', state: 'closed' })).toBeUndefined();
    const working = fold([['job.queued'], ['job.started']])!;
    expect(applyRead(working, { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'closed' })?.state).toBe('working');
  });

  it('a pull request the issue graph read merged settles the item that opened it', () => {
    const open = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_followed', { pullRequest: PR, part: false }]])!;
    expect(applyRead(open, { kind: 'pull_request', url: PR, state: 'MERGED' })?.state).toBe('done');
    expect(applyRead(open, { kind: 'pull_request', url: 'https://github.com/o/r/pull/9', state: 'MERGED' })).toBeUndefined();
  });

  it('counts every state, zero included', () => {
    const counts = countStates([{ state: 'failed' }, { state: 'failed' }, { state: 'done' }]);
    expect(counts.failed).toBe(2);
    expect(counts.done).toBe(1);
    expect(counts.queued).toBe(0);
  });

  it('keeps the change kind of its pull request (issue #1076): its state stays; a new job clears it', () => {
    const open = [['job.queued'], ['job.started'], ['job.finished', { result: 'pull request ready for review' }], ['job.pull_request_followed', { pullRequest: PR, part: false }]] as [EventType, Record<string, unknown>?][];
    const classified = fold([...open, ['job.pull_request_classified', { pullRequest: PR, kind: 'docs', why: ['README.md: docs path (**/*.md)'] }]]);
    expect(classified).toMatchObject({ state: 'pr_open', changeKind: 'docs' });
    expect(fold([...open, ['job.pull_request_classified', { pullRequest: PR, kind: 'docs', why: [] }], ['job.queued', {}, j2]])?.changeKind).toBeUndefined();
  });
});

describe('what every view reads of an item (issue #1067, part 2)', () => {
  it('a job\'s failure is its item\'s only while the item is failed or handed to a person on it', () => {
    const failed = fold([['job.queued'], ['job.failed', { error: 'x' }]])!;
    expect(isFailureOf(failed, 'j1')).toBe(true);
    expect(isFailureOf(failed, 'j2')).toBe(false);
    const handed = fold([['job.queued'], ['job.failed', { error: 'x' }], ['handoff.opened', {}]])!;
    expect(isFailureOf(handed, 'j1')).toBe(true);
    // Dismissed, run again, or its issue closed: no failure any more.
    expect(isFailureOf(fold([['job.queued'], ['job.failed', { error: 'x' }], ['job.dismissed', {}]])!, 'j1')).toBe(false);
    expect(isFailureOf(fold([['job.queued'], ['job.failed', { error: 'x' }], ['job.queued', {}, j2]])!, 'j1')).toBe(false);
    expect(isFailureOf(applyRead(failed, { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'closed', reason: 'completed' })!, 'j1')).toBe(false);
    expect(isFailureOf(undefined, 'j1')).toBe(false);
  });

  it('kept work counts while nothing finished the item and no newer job works it', () => {
    const kept: [EventType, Record<string, unknown>?, LedgerJob?][] = [['job.queued'], ['job.failed', { error: 'x' }], ['job.work_kept', { paths: ['/w'] }]];
    expect(keptWorkShown(fold(kept)!)).toEqual(['j1']);
    // A newer job works the item: the older job's kept work is history.
    expect(keptWorkShown(fold([...kept, ['job.queued', {}, j2], ['job.started', {}, j2]])!)).toEqual([]);
    expect(keptWorkShown(fold([...kept, ['job.queued', {}, j2], ['job.finished', {}, j2], ['job.pull_request_followed', { pullRequest: PR }, j2]])!)).toEqual([]);
    // The newer job failed too: only its own kept work waits; the older job's stays history (issue #1457).
    expect(keptWorkShown(fold([...kept, ['job.queued', {}, j2], ['job.failed', { error: 'y' }, j2], ['job.work_kept', { paths: ['/v'] }, j2]])!)).toEqual(['j2']);
    // The item is done: its pull request merged, or its issue closed.
    expect(keptWorkShown(fold([...kept, ['job.pull_request_merged', { pullRequest: PR }]])!)).toEqual([]);
    const closed = applyRead(fold(kept)!, { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'closed', reason: 'completed' })!;
    expect(keptWorkShown(closed)).toEqual([]);
    expect(keptWorkShown(applyRead(fold(kept)!, { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'closed', reason: 'not_planned' })!)).toEqual([]);
    // A finished job of its own item with work not pushed: still to push.
    expect(keptWorkShown(fold([['job.queued'], ['job.finished', {}], ['job.work_kept', { paths: ['/w'] }]])!)).toEqual(['j1']);
    // Cancelled by a person: still to push or discard.
    expect(keptWorkShown(fold([['job.queued'], ['job.cancelled', {}], ['job.work_kept', { paths: ['/w'] }]])!)).toEqual(['j1']);
  });
});

describe('what GitHub says moves the item (issue #1067, part 3)', () => {
  const open: [EventType, Record<string, unknown>?, LedgerJob?][] = [['job.queued'], ['job.finished', {}], ['job.pull_request_followed', { pullRequest: PR, part: false }]];

  it('an open pull request names what it waits on: a draft, merge conflicts, failed checks, checks running, the merge', () => {
    expect(pullRequestWaitOf({ draft: true, conflicting: true, checks: 'failing' })).toBe('draft');
    expect(pullRequestWaitOf({ draft: false, conflicting: true, checks: 'failing' })).toBe('conflicts');
    expect(pullRequestWaitOf({ draft: false, conflicting: false, checks: 'failing' })).toBe('fixing_checks');
    expect(pullRequestWaitOf({ draft: false, conflicting: false, checks: 'pending' })).toBe('checks_running');
    expect(pullRequestWaitOf({ draft: false, conflicting: false, checks: 'passing' })).toBe('merge');
    expect(pullRequestWaitOf({ draft: false, conflicting: false, checks: 'none' })).toBe('merge');
  });

  it('what the follow saw of its pull request says what the item waits on, until it merges', () => {
    const running = fold([...open, ['job.pull_request_seen', { pullRequest: PR, wait: 'checks_running' }]]);
    expect(running).toMatchObject({ state: 'pr_open', pullRequestWait: 'checks_running', waitingOn: 'its checks to pass' });
    const fixing = fold([...open, ['job.pull_request_seen', { pullRequest: PR, wait: 'checks_running' }], ['job.pull_request_seen', { pullRequest: PR, wait: 'fixing_checks' }]]);
    expect(fixing).toMatchObject({ state: 'pr_open', pullRequestWait: 'fixing_checks', waitingOn: 'a fix of its failed checks' });
    expect(fold([...open, ['job.pull_request_seen', { pullRequest: PR, wait: 'merge' }]])?.waitingOn).toBe('the merge');
    // The same wait again moves nothing; another pull request's says nothing of this item.
    const item = fold([...open, ['job.pull_request_seen', { pullRequest: PR, wait: 'merge' }]])!;
    expect(applyEvent(item, ev('job.pull_request_seen', { pullRequest: PR, wait: 'merge' }), KEY, j1)).toBeUndefined();
    expect(applyEvent(item, ev('job.pull_request_seen', { pullRequest: 'https://github.com/o/r/pull/9', wait: 'draft' }), KEY, j1)).toBeUndefined();
    // Merged: done, and it waits on nothing.
    const merged = fold([...open, ['job.pull_request_seen', { pullRequest: PR, wait: 'merge' }], ['job.pull_request_merged', { pullRequest: PR, part: false }]]);
    expect(merged?.state).toBe('done');
    expect(merged?.pullRequestWait).toBeUndefined();
    expect(merged?.waitingOn).toBeUndefined();
    // A new job of the item: what the old pull request waited on is history.
    expect(fold([...open, ['job.pull_request_seen', { pullRequest: PR, wait: 'merge' }], ['job.queued', {}, j2]])?.pullRequestWait).toBeUndefined();
  });

  it('an issue closed or reopened on GitHub, as a delivery or a read said, moves the item that has its key', () => {
    expect(keyOfEvent({ type: 'work_item.issue_closed', data: { key: KEY, via: 'delivery' } })).toBe(KEY);
    const pr = fold(open)!;
    const closed = applyEvent(pr, ev('work_item.issue_closed', { key: KEY, reason: 'completed', via: 'delivery' }), KEY);
    expect(closed).toMatchObject({ state: 'done', issueState: 'closed', issueReason: 'completed' });
    const failed = fold([['job.queued'], ['job.failed', { error: 'x' }]])!;
    expect(applyEvent(failed, ev('work_item.issue_closed', { key: KEY, reason: 'not_planned', via: 'read' }), KEY)?.state).toBe('dropped');
    const reopened = applyEvent(applyEvent(failed, ev('work_item.issue_closed', { key: KEY, reason: 'completed', via: 'read' }), KEY)!, ev('work_item.issue_reopened', { key: KEY, via: 'delivery' }), KEY);
    expect(reopened).toMatchObject({ state: 'failed', issueState: 'open' });
    // A job at work keeps the item; no item: nothing to move.
    expect(applyEvent(fold([['job.queued'], ['job.started']]), ev('work_item.issue_closed', { key: KEY, reason: 'completed', via: 'delivery' }), KEY)?.state).toBe('working');
    expect(applyEvent(undefined, ev('work_item.issue_closed', { key: KEY, via: 'delivery' }), KEY)).toBeUndefined();
  });

  it('a request card names its source; one that left Intake with no approval or decline is withdrawn, and dropped (part 4)', () => {
    const opened = applyEvent(undefined, ev('source.request_opened', { source: 'github', key: KEY, hash: 'h1' }), KEY)!;
    expect(opened).toMatchObject({ state: 'waiting_for_approval', requestSource: 'github' });
    expect(keyOfEvent({ type: 'source.request_withdrawn', data: { source: 'github', key: KEY } })).toBe(KEY);
    const withdrawn = applyEvent(opened, ev('source.request_withdrawn', { source: 'github', key: KEY, hash: 'h1' }), KEY)!;
    expect(withdrawn.state).toBe('dropped');
    expect(withdrawn.requestSource).toBeUndefined();
    expect(withdrawn.waitingOn).toBeUndefined();
    // A withdraw of an item that waits for no approval moves nothing.
    expect(applyEvent(fold([['job.queued']]), ev('source.request_withdrawn', { source: 'github', key: KEY }), KEY)).toBeUndefined();
    // Back in Intake, it waits again.
    expect(applyEvent(withdrawn, ev('source.request_opened', { source: 'github', key: KEY, hash: 'h1' }), KEY)?.state).toBe('waiting_for_approval');
    // Approved or declined, it names no source.
    expect(applyEvent(opened, ev('source.request_approved', { source: 'github', key: KEY }), KEY)?.requestSource).toBeUndefined();
    expect(applyEvent(opened, ev('source.request_declined', { source: 'github', key: KEY }), KEY)?.requestSource).toBeUndefined();
  });

  it('the request cards of a source the ledger has waiting for approval: what Intake withdraws when the source no longer offers them', () => {
    const opened = (key: string, source: string) => applyEvent(undefined, ev('source.request_opened', { source, key, hash: 'h' }), key)!;
    const other = 'https://github.com/o/r/issues/2';
    const items = [opened(KEY, 'github'), opened(other, 'work'), fold([['job.queued']])!];
    expect(requestsWaitingOf(items, 'github')).toEqual([KEY]);
    expect(requestsWaitingOf(items, 'work')).toEqual([other]);
  });

  it('closed as complete is the ledger\'s answer: its issue closed, not as not planned or a duplicate', () => {
    const failed = fold([['job.queued'], ['job.failed', { error: 'x' }]])!;
    expect(issueClosedAsComplete(failed)).toBe(false);
    const closed = (reason?: string) => applyEvent(failed, ev('work_item.issue_closed', { key: KEY, ...(reason ? { reason } : {}), via: 'read' }), KEY)!;
    expect(issueClosedAsComplete(closed('completed'))).toBe(true);
    expect(issueClosedAsComplete(closed())).toBe(true);
    expect(issueClosedAsComplete(closed('not_planned'))).toBe(false);
    expect(issueClosedAsComplete(closed('duplicate'))).toBe(false);
    expect(issueClosedAsComplete(undefined)).toBe(false);
  });

  it('in flight (issue #1113): working, or its pull request open with its checks running, being fixed, or waiting on the merge', () => {
    const at = (state: WorkItem['state'], pullRequestWait?: WorkItem['pullRequestWait']) => ({ state, ...(pullRequestWait ? { pullRequestWait } : {}) });
    expect(isInFlight(at('working'))).toBe(true);
    expect(isInFlight(at('pr_open', 'checks_running'))).toBe(true);
    expect(isInFlight(at('pr_open', 'fixing_checks'))).toBe(true);
    expect(isInFlight(at('pr_open', 'merge'))).toBe(true);
    // A draft or merge conflicts wait on a fix, not on the run.
    expect(isInFlight(at('pr_open', 'draft'))).toBe(false);
    expect(isInFlight(at('pr_open', 'conflicts'))).toBe(false);
    for (const s of ['waiting_for_approval', 'queued', 'needs_you', 'waiting_outside', 'partly_done', 'done', 'failed', 'dropped'] as const) expect(isInFlight(at(s))).toBe(false);
  });

  it('in flight has one breakdown (issue #1164): running, on its own command, pull requests; a wait the follow never saw is not in flight', () => {
    const own = fold([['job.queued'], ['job.started'], ['job.waiting', { for: 'the test run', ownCommand: true }]])!;
    const outside = fold([['job.queued'], ['job.started'], ['job.waiting', { for: 'a review' }]])!;
    const running = fold([['job.queued'], ['job.started']])!;
    const unseen = fold([['job.queued'], ['job.started'], ['job.finished', { result: 'opened a pull request' }], ['job.pull_request_followed', { pullRequest: PR, part: false }]])!;
    expect([running.state, own.state, outside.state, unseen.state]).toEqual(['working', 'working', 'waiting_outside', 'pr_open']);
    expect(inFlightPartOf(running)).toBe('running');
    // A job on its own command holds its lane: in flight, not running.
    expect(inFlightPartOf(own)).toBe('ownCommand');
    // Any other own wait holds no lane.
    expect(inFlightPartOf(outside)).toBeUndefined();
    // Its pull request's wait never read: it is not counted until the follow reads one, so a stale item never inflates the count.
    expect(inFlightPartOf(unseen)).toBeUndefined();
    const pr = (pullRequestWait: WorkItem['pullRequestWait']) => ({ ...unseen, pullRequestWait });
    expect(inFlightPartOf(pr('checks_running'))).toBe('pullRequests');
    expect(inFlightPartOf(pr('conflicts'))).toBeUndefined();
    expect(inFlightOf([running, own, outside, unseen, pr('merge'), pr('fixing_checks'), pr('draft')])).toEqual({ total: 4, running: 1, ownCommand: 1, pullRequests: 2 });
    expect(inFlightOf([])).toEqual({ total: 0, running: 0, ownCommand: 0, pullRequests: 0 });
  });
});

describe('a state that needs a pull request (issue #1891)', () => {
  it('a job that ended done naming no pull request is blocked for want of one, never in PR open', () => {
    const unseen = fold([['job.queued'], ['job.started'], ['job.finished', { result: 'opened a pull request' }]])!;
    expect(unseen).toMatchObject({ state: 'blocked', blockedCause: 'no_pr', waitingOn: 'its pull request: none was found yet, so the hopper looks for one, then runs it again', noPullRequestEnds: 1 });
    expect(unseen.pullRequest).toBeUndefined();
  });

  it('the first look at its pull request, or its follow, names it: in PR open again, no longer blocked', () => {
    const seen = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_seen', { pullRequest: PR, wait: 'checks_running' }]])!;
    expect(seen).toMatchObject({ state: 'pr_open', pullRequest: PR, pullRequestState: 'open', waitingOn: 'its checks to pass' });
    expect(seen.blockedCause).toBeUndefined();
    const followed = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_followed', { pullRequest: PR, part: false }]])!;
    expect(followed).toMatchObject({ state: 'pr_open', pullRequest: PR });
    expect(followed.blockedCause).toBeUndefined();
  });

  it('a new job of the item, or its issue closed, ends the block', () => {
    expect(fold([['job.queued'], ['job.finished', {}], ['job.queued', {}, j2]])?.state).toBe('queued');
    const closed = applyRead(fold([['job.queued'], ['job.finished', {}]])!, { kind: 'issue', at: '2026-10-14T00:00:00.000Z', state: 'closed', reason: 'completed' });
    expect(closed?.state).toBe('done');
  });

  it('a block that its issue\'s close as completed hid does not come back when the issue is reopened (issue #1892): it is done', () => {
    const closed = applyRead(fold([['job.queued'], ['job.finished', {}]])!, { kind: 'issue', at: '2026-10-14T00:00:00.000Z', state: 'closed', reason: 'completed' })!;
    const reopened = applyRead(closed, { kind: 'issue', at: '2026-10-14T01:00:00.000Z', state: 'open' })!;
    expect(reopened).toMatchObject({ state: 'done', issueState: 'open' });
    expect(reopened.blockedCause).toBeUndefined();
    const notPlanned = applyRead(fold([['job.queued'], ['job.finished', {}]])!, { kind: 'issue', at: '2026-10-14T00:00:00.000Z', state: 'closed', reason: 'not_planned' })!;
    expect(applyRead(notPlanned, { kind: 'issue', at: '2026-10-14T01:00:00.000Z', state: 'open' })?.state).toBe('blocked');
  });
});

describe('the item reconciler\'s correction (issue #1891)', () => {
  it('folds an item queued after its job ended again from that end, once', () => {
    const finished = { result: 'opened a pull request', pullRequest: PR };
    const stale = fold([['job.queued'], ['job.started'], ['job.finished', finished], ['job.requeued']])!;
    expect(stale.state).toBe('queued');
    const withPr: LedgerJob = { ...j1, pullRequest: PR };
    const fixed = applyEvent(stale, ev('work_item.reconciled', { key: KEY, from: 'queued', jobId: 'j1', replay: { type: 'job.finished', data: finished } }), KEY, withPr)!;
    expect(fixed).toMatchObject({ state: 'pr_open', pullRequest: PR });
    // A second one finds it no longer queued: nothing moves.
    expect(applyEvent(fixed, ev('work_item.reconciled', { key: KEY, from: 'queued', jobId: 'j1', replay: { type: 'job.finished', data: finished } }), KEY, withPr)).toBeUndefined();
  });

  it('blocks an item as it says, only from the state it saw', () => {
    const open = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_followed', { pullRequest: PR, part: false }]])!;
    const blocked = applyEvent(open, ev('work_item.reconciled', { key: KEY, from: 'pr_open', cause: 'stale' }), KEY)!;
    expect(blocked).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
    expect(applyEvent(blocked, ev('work_item.reconciled', { key: KEY, from: 'pr_open', cause: 'stale' }), KEY)).toBeUndefined();
  });
});
