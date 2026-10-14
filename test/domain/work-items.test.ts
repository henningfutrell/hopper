// The work-item ledger's reducer (issue #1067): one item per source key, its state folded from the events in order and
// settled with what GitHub said of its issue and pull request. "Failed" is only the newest attempt's failure, nobody
// dismissed and nothing replaced; a finished job waits on its pull request until it merges.
import { describe, expect, it } from 'vitest';
import { applyEvent, applyRead, countStates, isFailureOf, keptWorkShown, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
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
  });

  it('a request card waits for approval; declined it is dropped', () => {
    const opened = applyEvent(undefined, ev('source.request_opened', { key: KEY }), KEY);
    expect(opened?.state).toBe('waiting_for_approval');
    expect(applyEvent(opened, ev('source.request_declined', { key: KEY }), KEY)?.state).toBe('dropped');
    expect(applyEvent(opened, ev('source.request_approved', { key: KEY }), KEY)?.state).toBe('queued');
  });

  it('cancelled, rejected, and a pull request closed without a merge are dropped; done-by-hand and a direct job are done', () => {
    expect(fold([['job.queued'], ['job.cancelled', { reason: 'r' }]])?.state).toBe('dropped');
    expect(fold([['job.queued'], ['job.rejected', { by: 'user', reason: 'r' }]])?.state).toBe('dropped');
    expect(fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }]])?.state).toBe('dropped');
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
    // The newer job failed too: both are left to look at.
    expect(keptWorkShown(fold([...kept, ['job.queued', {}, j2], ['job.failed', { error: 'y' }, j2], ['job.work_kept', { paths: ['/v'] }, j2]])!)).toEqual(['j1', 'j2']);
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
