// Quarantine in the job store (issue #655, part 2): a quarantined job is held and opens no door; its lift gives back the
// level it had. A new spec, or an origin judged later, leaves the quarantine in place.
import { describe, expect, it } from 'vitest';
import { QUARANTINED_HOLD } from '../../src/domain/trust-stamp.ts';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = Buffer.alloc(32, 3);

const issue = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});

describe('quarantine in the job store (issue #655)', () => {
  it('with no key, changes nothing, and every door opens', () => {
    const s = t.open(t.url());
    const j = s.jobs.create(spec, 50, issue());
    expect(s.jobs.quarantine(j.id).stamp).toBeUndefined();
    expect(s.jobs.opensDoors(j)).toBe(true);
    expect(s.jobs.trustLevel(j)).toBeUndefined();
    s.close();
  });

  it('quarantined: held, no door opens; lifted: the level it had, and the doors open again', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue());
    expect(s.jobs.opensDoors(j)).toBe(true);
    const q = s.jobs.quarantine(j.id);
    expect(q.stamp).toMatchObject({ level: 'quarantined', was: 'owner', by: 'person' });
    expect(s.jobs.trustLevel(s.jobs.get(j.id)!)).toBe('quarantined');
    expect(s.jobs.stampHold(s.jobs.get(j.id)!)).toBe(QUARANTINED_HOLD);
    expect(s.jobs.opensDoors(s.jobs.get(j.id)!)).toBe(false);
    const lifted = s.jobs.liftQuarantine(j.id);
    expect(lifted.stamp).toMatchObject({ level: 'owner', reasons: ['origin:trusted', 'author:assignee'], by: 'person' });
    expect(s.jobs.stampHold(lifted)).toBeUndefined();
    expect(s.jobs.opensDoors(lifted)).toBe(true);
    s.close();
  });

  it('a new spec keeps the quarantine', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue());
    s.jobs.quarantine(j.id);
    const next = s.jobs.respecify(j.id, { ...spec, payload: { n: 2 } });
    expect(next.stamp).toMatchObject({ level: 'quarantined', was: 'owner', by: 'respecify' });
    expect(s.jobs.stampHold(next)).toBe(QUARANTINED_HOLD);
    s.close();
  });

  it('an origin judged later keeps the quarantine, and its lift gives the rules\' level now', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue({ origin: undefined }));
    s.jobs.quarantine(j.id);
    s.jobs.update(j.id, { source: { ...j.source!, origin: 'trusted' } });
    expect(s.jobs.restamp(j.id).stamp).toMatchObject({ level: 'quarantined', was: 'owner' });
    expect(s.jobs.liftQuarantine(j.id).stamp?.level).toBe('owner');
    s.close();
  });
});
