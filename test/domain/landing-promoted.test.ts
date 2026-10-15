// Issue #1232: an item whose pull request merged into the landing branch and was promoted with its batch is done, and
// leaves Intake. Issue #1175 missed one path: the ledger kept one landing stage per item, so an earlier part's `promoted`
// stood for the item's next merge, which then looked promoted at once, and Intake offered it as a reopened card. Now each
// landing stage is of one pull request. A promoted one whose issue is still open is closed by the hopper, once. Pure.
//
// Feature: a promoted item is done
//   Scenario: a new merge of an item whose earlier part was promoted waits on its own batch
//   Scenario: a promoted item whose issue is still open is one the hopper closes, once; a person's reopen is no such item
//   Scenario: the stale card of a promoted item is withdrawn, and the item reads done
import { describe, expect, it } from 'vitest';
import { applyEvent, applyLandingEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import { awaitsBatch, promotedOpen } from '../../src/domain/work-item-landing.ts';
import type { EventType } from '../../src/domain/types.ts';

const REPO = 'owner/app';
const KEY = 'https://github.com/Owner/App/issues/1';
const PR = (n: number) => `https://github.com/Owner/App/pull/${n}`;
const TIP_A = 'a'.repeat(40);
const TIP_B = 'b'.repeat(40);
const NOW = Date.parse('2026-10-14T12:30:00.000Z');
const landingRepo = (repo: string) => repo === REPO;

let minute = 0;
const at = () => `2026-10-14T12:${String(minute++).padStart(2, '0')}:00.000Z`;
const landing = (type: EventType, data: Record<string, unknown>) => ({ type, at: at(), data: { repo: REPO, ...data } });
const job = (id: string): LedgerJob => ({ id, key: KEY });

/** The item after its job's pull request `n` merged as the whole item, promoted with batch `tip`. */
function promoted(n: number, tip: string, from?: WorkItem): WorkItem {
  let i = from ?? applyEvent(undefined, { type: 'job.queued', at: at(), data: {} }, KEY, job('j1'))!;
  i = applyEvent(i, { type: 'job.pull_request_merged', at: at(), data: { pullRequest: PR(n) } }, KEY, job(i.jobId ?? 'j1'))!;
  for (const e of [
    landing('landing_batch.pending', { merges: [n] }),
    landing('landing_batch.started', { tip, merges: [n], pullRequest: 900 + n, url: 'u' }),
    landing('landing_batch.promoted', { tip, pullRequest: 900 + n, url: 'u' }),
  ]) i = applyLandingEvent(i, e) ?? i;
  return i;
}

describe('each landing stage is of one pull request (issue #1232)', () => {
  it('the stage names its pull request', () => {
    expect(promoted(101, TIP_A).landing).toMatchObject({ repo: REPO, pullRequest: 101, stage: 'promoted' });
  });

  it('a new merge of an item whose earlier part was promoted waits on its own batch, not the earlier one', () => {
    const first = promoted(101, TIP_A);
    const merged = applyEvent(first, { type: 'job.pull_request_merged', at: at(), data: { pullRequest: PR(102) } }, KEY, job('j1'))!;
    expect(awaitsBatch(merged, landingRepo, NOW)).toBe(true);
    expect(promotedOpen(merged, landingRepo)).toBe(false);
    const pending = applyLandingEvent(merged, landing('landing_batch.pending', { merges: [102] }))!;
    expect(pending.landing).toMatchObject({ pullRequest: 102, stage: 'waiting' });
    expect(awaitsBatch(pending, landingRepo, NOW)).toBe(true);
    // The earlier batch's events move it no more.
    expect(applyLandingEvent(pending, landing('landing_batch.promoted', { tip: TIP_A, pullRequest: 901, url: 'u' }))).toBeUndefined();
  });
});

describe('a promoted item whose issue is still open is done (issue #1232)', () => {
  it('is one the hopper closes: promoted, its issue not closed', () => {
    const i = promoted(101, TIP_A);
    expect(i.state).toBe('done');
    expect(awaitsBatch(i, landingRepo, NOW)).toBe(false);
    expect(promotedOpen(i, landingRepo)).toBe(true);
    expect(promotedOpen(i, () => false)).toBe(false);
  });

  it('a stale card on it is no person\'s reopen: still one the hopper closes', () => {
    const card = applyEvent(promoted(101, TIP_A), { type: 'source.request_opened', at: at(), data: { source: 'github', key: KEY } }, KEY)!;
    expect(card.state).toBe('waiting_for_approval');
    expect(promotedOpen(card, landingRepo)).toBe(true);
  });

  it('once its close is recorded, it is no more; withdrawn, its card leaves the item done, not dropped', () => {
    const card = applyEvent(promoted(101, TIP_A), { type: 'source.request_opened', at: at(), data: { source: 'github', key: KEY } }, KEY)!;
    const closed = applyEvent(card, { type: 'work_item.issue_closed', at: at(), data: { key: KEY, reason: 'completed', via: 'landing' } }, KEY)!;
    expect(promotedOpen(closed, landingRepo)).toBe(false);
    const withdrawn = applyEvent(closed, { type: 'source.request_withdrawn', at: at(), data: { source: 'github', key: KEY } }, KEY)!;
    expect(withdrawn.state).toBe('done');
  });

  it('a reopen after its close is a person\'s: the landing stage is history, and the hopper does not close it again', () => {
    const i = promoted(101, TIP_A);
    const closed = applyEvent(i, { type: 'work_item.issue_closed', at: at(), data: { key: KEY, reason: 'completed', via: 'delivery' } }, KEY)!;
    const reopened = applyEvent(closed, { type: 'work_item.issue_reopened', at: at(), data: { key: KEY, via: 'delivery' } }, KEY)!;
    expect(reopened.landing).toBeUndefined();
    expect(promotedOpen(reopened, landingRepo)).toBe(false);
    expect(awaitsBatch(reopened, landingRepo, NOW + 2 * 60 * 60_000)).toBe(false);
  });

  it('a part, a culprit or one still on its way is not', () => {
    const part = applyEvent(promoted(101, TIP_A), { type: 'job.pull_request_merged', at: at(), data: { pullRequest: PR(103), part: true } }, KEY, job('j1'))!;
    expect(promotedOpen(part, landingRepo)).toBe(false);
    const onItsWay = { ...promoted(101, TIP_B), landing: { repo: REPO, pullRequest: 101, stage: 'batch_run' as const, since: at() } };
    expect(promotedOpen(onItsWay, landingRepo)).toBe(false);
    const culprit = { ...promoted(101, TIP_B), landing: { repo: REPO, pullRequest: 101, stage: 'culprit' as const, since: at() } };
    expect(promotedOpen(culprit, landingRepo)).toBe(false);
  });
});
