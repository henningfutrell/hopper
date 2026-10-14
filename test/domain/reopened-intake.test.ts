// A reopened issue re-enters Intake (issue #1126): its work item, done, waits for approval again while its reopened card
// is in Intake, and is done again when the card leaves with no approval. A card opens again after an approval of the same
// text, and its history names the item's jobs, newest first, and its pull request.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import { itemHistory, requestOpenedSince } from '../../src/domain/intake.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-14T10:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?][]): WorkItem | undefined {
  let item: WorkItem | undefined;
  for (const [type, data] of steps) item = applyEvent(item, ev(type, data), KEY, j1) ?? item;
  return item;
}

const DONE: [EventType, Record<string, unknown>?][] = [
  ['job.queued'], ['job.started'], ['job.finished', { result: 'pull request ready for review' }], ['job.pull_request_merged', { pullRequest: PR, part: false }],
];

describe('the ledger of a reopened item (issue #1126)', () => {
  it('a done item whose reopened card opens waits for approval', () => {
    expect(fold(DONE)?.state).toBe('done');
    expect(fold([...DONE, ['source.request_opened', { source: 'github', key: KEY, hash: 'h' }]])).toMatchObject({ state: 'waiting_for_approval', requestSource: 'github' });
  });

  it('approved, it is queued; declined or withdrawn, it is done again', () => {
    const opened: [EventType, Record<string, unknown>?][] = [...DONE, ['source.request_opened', { source: 'github', key: KEY, hash: 'h' }]];
    expect(fold([...opened, ['source.request_approved', { key: KEY }]])?.state).toBe('queued');
    expect(fold([...opened, ['source.request_declined', { key: KEY }]])?.state).toBe('done');
    expect(fold([...opened, ['source.request_withdrawn', { key: KEY }]])?.state).toBe('done');
  });
});

describe('a request card opens again (issue #1126)', () => {
  const e = (type: string, hash?: string) => ({ type, data: { key: KEY, ...(hash ? { hash } : {}) } });
  it('opened with this text since its last withdraw or approval', () => {
    expect(requestOpenedSince([e('source.request_opened', 'h')], 'h')).toBe(true);
    expect(requestOpenedSince([e('source.request_opened', 'h')], 'h2')).toBe(false);
    expect(requestOpenedSince([e('source.request_opened', 'h'), e('source.request_withdrawn')], 'h')).toBe(false);
    expect(requestOpenedSince([e('source.request_opened', 'h'), e('source.request_approved', 'h')], 'h')).toBe(false);
    expect(requestOpenedSince([e('source.request_opened', 'h'), e('source.request_approved', 'h'), e('source.request_opened', 'h')], 'h')).toBe(true);
  });
});

describe('the history of a reopened item (issue #1126)', () => {
  it('names its jobs, newest first, by the job each ran again, and its pull request', () => {
    const jobs = new Map([
      ['j3', { id: 'j3', status: 'finished', rerunOf: 'j2' }],
      ['j2', { id: 'j2', status: 'failed', rerunOf: 'j1' }],
      ['j1', { id: 'j1', status: 'failed' }],
    ]);
    expect(itemHistory(jobs.get('j3'), (id) => jobs.get(id), PR)).toEqual({ jobs: [{ id: 'j3', status: 'finished' }, { id: 'j2', status: 'failed' }, { id: 'j1', status: 'failed' }], pullRequest: PR });
    expect(itemHistory(undefined, (id) => jobs.get(id), PR)).toBeUndefined();
  });

  it('names at most ten jobs, and never one twice', () => {
    const loop = new Map([['a', { id: 'a', status: 'finished', rerunOf: 'b' }], ['b', { id: 'b', status: 'failed', rerunOf: 'a' }]]);
    expect(itemHistory(loop.get('a'), (id) => loop.get(id))?.jobs.map((j) => j.id)).toEqual(['a', 'b']);
    const long = new Map(Array.from({ length: 15 }, (_, i) => [`j${i}`, { id: `j${i}`, status: 'failed', ...(i > 0 ? { rerunOf: `j${i - 1}` } : {}) }]));
    expect(itemHistory(long.get('j14'), (id) => long.get(id))?.jobs).toHaveLength(10);
  });
});
