// The review after a daemon restart (issue #1608, design.md "Recovery at startup"): an open item goes on at its stored
// reviewer level, so no level below it reviews it again, and a reviewer level's call in flight is on the item until its
// review is recorded. The real store, the EscalationLevel seam faked.
import { describe, expect, it } from 'vitest';
import type { EscalationLevel, ReviewReply, UserStore } from '../../src/domain/ports.ts';
import { REVIEW_SECTIONS, reviewDocument, type ReviewItem } from '../../src/domain/types.ts';
import { createReviewService } from '../../src/review/service.ts';
import { fixedClock, spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();

const REPORT = ['Question: What can a machine reach?', 'Findings: the probe reads PATH', 'Sources and evidence: src/machines/probe.ts', 'Confidence: high', 'Open threads: none', 'Next step: none'].join('\n');

/** A reviewer that escalates, or one whose call never ends until it is aborted. */
const level = (name: string, asked: string[], reply: ReviewReply | 'hang'): EscalationLevel => ({
  name, answer: async () => ({ error: 'not a question' }),
  review: (_req, signal) => {
    asked.push(name);
    if (reply === 'hang') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    return Promise.resolve(reply);
  },
});

function service(store: UserStore, levels: EscalationLevel[]) {
  return createReviewService('research', {
    store, clock: { now: () => new Date('2026-10-02T10:00:00.000Z') }, levels: () => levels, stageTimeoutMs: 60_000,
    config: { read: () => undefined, version: () => 'missing', write: () => false }, onDecided: () => {}, onRevise: () => {},
  });
}

function item(store: UserStore): ReviewItem {
  store.settings.setReviewSettings('research', { reviewers: ['low', 'high'], signOff: 'owner', levelRevisions: 1 });
  const job = store.jobs.create(spec, 5);
  const p = store.reviews.research.create({ jobId: job.id, stage: 'low', version: { number: 1, text: REPORT, ...reviewDocument('research', REPORT), recentOutput: '', at: '2026-10-02T10:00:00.000Z' } });
  // The job waits on it, as the engine leaves it: recovery's sweep keeps the item open.
  store.jobs.update(job.id, { status: 'waiting_answer', [REVIEW_SECTIONS.research.jobField]: p.id });
  return p;
}

const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };

describe('review recovery (issue #1608)', () => {
  it('stopped during the level-2 call: after the start the level-1 review is not asked again', async () => {
    const s = t.open(t.url(), fixedClock());
    const p = item(s);
    const before: string[] = [];
    const first = service(s, [level('low', before, { verdict: 'approve', notes: 'fine' }), level('high', before, 'hang')]);
    first.handle(p.id);
    await until(() => before.length === 2);
    expect(s.reviews.research.get(p.id)!.call).toMatchObject({ stage: 'high', version: 1 });
    await first.stop();
    const stopped = s.reviews.research.get(p.id)!;
    expect(stopped).toMatchObject({ status: 'open', stage: 'high' });
    expect(stopped.call?.stage).toBe('high');
    expect(stopped.reviews.map((r) => [r.stage, r.verdict])).toEqual([['low', 'approve']]);

    const after: string[] = [];
    const second = service(s, [level('low', after, { verdict: 'approve', notes: 'fine' }), level('high', after, { verdict: 'escalate', notes: 'a person decides' })]);
    second.recover();
    await until(() => s.reviews.research.get(p.id)!.stage === 'human');
    await second.stop();
    expect(after).toEqual(['high']);
    const done = s.reviews.research.get(p.id)!;
    expect(done.call).toBeUndefined();
    expect(done.reviews.map((r) => [r.stage, r.verdict])).toEqual([['low', 'approve'], ['high', 'escalate']]);
    expect(done.reviews[1]!.callKey).toBeTruthy();
    s.close();
  });

  it('a level whose review of this version is kept is not asked again: the next level is', async () => {
    const s = t.open(t.url(), fixedClock());
    const p = item(s);
    s.reviews.research.addReview(p.id, { version: 1, stage: 'low', role: 'level', verdict: 'approve', notes: 'fine', startedAt: 'a', finishedAt: 'b' });
    const asked: string[] = [];
    const svc = service(s, [level('low', asked, { verdict: 'approve', notes: 'fine' }), level('high', asked, { verdict: 'escalate', notes: 'a person decides' })]);
    svc.recover();
    await until(() => s.reviews.research.get(p.id)!.stage === 'human');
    await svc.stop();
    expect(asked).toEqual(['high']);
    s.close();
  });
});
