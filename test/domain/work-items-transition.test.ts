// Each transition of a work item names its owner and sets its next check and its deadline (issue #1892, milestone 3). The
// item keeps who made its last move (`movedBy`, `transitionOwner`); a mark that moves nothing keeps it. The deadline and
// the next check run from that move (`eventAt`), not from the item's first entry to its state: a move within a state is a
// move, so "past its deadline with no move" counts from the last one.
import { describe, expect, it } from 'vitest';
import { checkOf, correctionOf } from '../../src/domain/item-lifecycle.ts';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github', pullRequest: PR };
const T0 = '2026-10-21T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function fold(steps: [EventType, number, Record<string, unknown>?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, minute, data] of steps) item = applyEvent(item, { type, at: at(minute), data: data ?? {} }, KEY, j1) ?? item;
  return item;
}

describe('each transition names its owner (issue #1892)', () => {
  it('the item keeps the owner of its last move', () => {
    expect(fold([['job.queued', 0]])?.movedBy).toBe('scheduler');
    expect(fold([['job.queued', 0], ['job.started', 1]])?.movedBy).toBe('lane_worker');
    const open = fold([['job.queued', 0], ['job.started', 1], ['job.finished', 2, { result: 'pull request ready for review' }]]);
    expect(open).toMatchObject({ state: 'pr_open', movedBy: 'lane_worker' });
    expect(fold([['job.pull_request_merged', 3, { pullRequest: PR }]], open)).toMatchObject({ state: 'done', movedBy: 'github_observer' });
    expect(fold([['job.failed', 2], ['handoff.opened', 3]], open)).toMatchObject({ state: 'needs_you', movedBy: 'assessor' });
    expect(fold([['job.failed', 2], ['handoff.opened', 3], ['handoff.closed', 4, { end: 'wont_do' }]], open)).toMatchObject({ state: 'dropped', movedBy: 'person' });
  });

  it('a mark that moves nothing keeps the owner of the last move', () => {
    const open = fold([['job.queued', 0], ['job.finished', 2, { result: 'pull request ready for review' }]]);
    expect(fold([['job.pull_request_classified', 3, { pullRequest: PR, kind: 'feature' }]], open)?.movedBy).toBe('lane_worker');
  });

  it('the item reconciler\'s moves are its own, a replay of a job\'s end too', () => {
    const queued = fold([['job.queued', 0]]);
    expect(fold([['work_item.reconciled', 70, { from: 'queued', cause: 'stale' }]], queued)).toMatchObject({ state: 'blocked', movedBy: 'reconciler' });
    const replayed = fold([['work_item.reconciled', 70, { from: 'queued', replay: { type: 'job.failed', data: { error: 'boom' } } }]], queued);
    expect(replayed).toMatchObject({ state: 'failed', movedBy: 'reconciler' });
  });
});

describe('each transition sets the next check and the deadline (issue #1892)', () => {
  it('a move within a state starts its deadline again', () => {
    // Working since minute 1; its job waits on its own command at minute 50 and works on at minute 55: moves, not a stay.
    const working = fold([['job.queued', 0], ['job.started', 1], ['job.waiting', 50, { for: 'a build', ownCommand: true }], ['job.wait_ended', 55]]);
    expect(working).toMatchObject({ state: 'working', stateSince: at(1), eventAt: at(55) });
    expect(checkOf(working!.state, working!.eventAt)).toEqual({ owner: 'lane_worker', nextCheckAt: at(60), deadline: at(115) });
    // No job of it found: stale only an hour after its last move, not an hour after it began to work.
    expect(correctionOf(working!, undefined, false, at(62))).toBeUndefined();
    expect(correctionOf(working!, undefined, false, at(115))).toEqual({ kind: 'block', key: KEY, from: 'working', cause: 'stale' });
  });

  it('a mark is no move: the deadline stays where the last move set it', () => {
    const open = fold([['job.queued', 0], ['job.finished', 2, { result: 'pull request ready for review' }], ['job.pull_request_classified', 30, { pullRequest: PR, kind: 'feature' }]]);
    expect(open).toMatchObject({ state: 'pr_open', eventAt: at(2) });
    expect(correctionOf(open!, undefined, false, at(62))).toEqual({ kind: 'block', key: KEY, from: 'pr_open', cause: 'stale' });
  });
});
