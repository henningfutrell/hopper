// What stays to the labels by decision (issue #1892 part 38): an item a read of GitHub moved, not an event of the hopper's,
// is not judged by the label mirror, and Intake does not read the ledger for it. No record says what its issue carries.
import { describe, expect, it } from 'vitest';
import { applyEvent, applyRead, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';
import { labelsFor, type LabelFacts } from '../../src/sources/github/item-labels.ts';
import { ledgerReason } from '../../src/sources/github/discover.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const job: LedgerJob = { id: 'j1', key: KEY, kind: 'github', pullRequest: PR };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-13T10:${String(minute++).padStart(2, '0')}:00.000Z`, data });

/** An item in PR open: its job finished, its pull request followed. */
function prOpen(): WorkItem {
  let item: WorkItem | undefined;
  for (const [type, data] of [['job.queued', {}], ['job.finished', {}]] as const) item = applyEvent(item, ev(type, data), KEY, job) ?? item;
  return item!;
}

/** Every fact the mirror can ask, each way it can be. */
const FACTS: LabelFacts[] = [{}, { part: true }, { failureReported: true }, { fixingReported: true }, { failureReportWaits: true }, { partsLeft: true },
  { lastPartMerged: true }, { dropReported: 'none' }, { dropReported: 'pr_ready' }, ...(['closed', 'pr_open', 'part', 'no_pr'] as const).map((d) => ({ doneReported: d }))];

describe('left to the labels by decision (issue #1892 part 38)', () => {
  it('a done item a read of GitHub made done: its merge read with no follow\'s record is not judged, whatever the facts', () => {
    const read = applyRead(prOpen(), { kind: 'pull_request', url: PR, state: 'MERGED' })!;
    expect(read).toMatchObject({ state: 'done', eventState: 'pr_open', pullRequestState: 'merged' });
    expect(read.wholeMerged).toBeUndefined();
    for (const facts of FACTS) {
      expect(labelsFor(read, facts)).toBeUndefined();
      expect(ledgerReason(read, facts)).toBeUndefined();
    }
  });

  it('an item dropped by its issue closed as not planned is not judged, whatever the facts', () => {
    const closed = applyRead(prOpen(), { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'closed', reason: 'not_planned' })!;
    expect(closed).toMatchObject({ state: 'dropped', eventState: 'pr_open' });
    for (const facts of FACTS) {
      expect(labelsFor(closed, facts)).toBeUndefined();
      expect(ledgerReason(closed, facts)).toBeUndefined();
    }
  });

  it('a request card withdrawn by its source is not judged when no label kept it out', () => {
    let card: WorkItem | undefined;
    for (const [type, data] of [['source.request_opened', { key: KEY, source: 'github' }], ['source.request_withdrawn', { key: KEY, source: 'github' }]] as const) {
      card = applyEvent(card, ev(type, data), KEY) ?? card;
    }
    expect(card).toMatchObject({ state: 'dropped' });
    expect(card!.keptOut).toBeUndefined();
    expect(labelsFor(card!)).toBeUndefined();
    expect(ledgerReason(card!, {})).toBeUndefined();
  });
});
