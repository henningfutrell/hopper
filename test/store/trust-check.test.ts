// Jev's trust check in the job store (issue #655 part 4): the check is written only while it is due; a new spec is checked
// again; a person approves the trust of a job the check lowered, and of no other.
import { describe, expect, it } from 'vitest';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = Buffer.alloc(32, 3);

const issue = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'stranger', assignee: 'ada', origin: 'approved', ...over,
});
const lower = { asked: true as const, pickId: 'p', pick: 'lower:untrusted:destructive', confidence: 0.9, applied: true };
const keep = { asked: true as const, pickId: 'p', pick: 'keep', confidence: 0.9, applied: true };

describe('Jev\'s trust check in the job store (issue #655 part 4)', () => {
  it('with no key: no check is due, and none is written', () => {
    const s = t.open(t.url());
    const j = s.jobs.create(spec, 50, issue());
    expect(s.jobs.checkDue(j)).toBe(false);
    expect(s.jobs.checkTrust(j.id, keep)).toBeUndefined();
    s.close();
  });

  it('writes the check once; a new spec is checked again; a person approves only a lowered job', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue());
    expect(s.jobs.checkDue(j)).toBe(true);
    expect(s.jobs.approveTrust(j.id)).toBeUndefined();
    const kept = s.jobs.checkTrust(j.id, keep)!;
    expect(kept.stamp).toMatchObject({ level: 'approved', by: 'jev', check: { pick: 'keep', applied: true } });
    // Another hopper's answer after it: nothing is written.
    expect(s.jobs.checkTrust(j.id, lower)).toBeUndefined();
    expect(s.jobs.trustLevel(s.jobs.get(j.id)!)).toBe('approved');
    const respecified = s.jobs.respecify(j.id, { ...spec, goal: 'new text' });
    expect(respecified.stamp).toMatchObject({ level: 'approved', by: 'respecify' });
    expect(respecified.stamp!.check).toBeUndefined();
    expect(s.jobs.checkDue(respecified)).toBe(true);
    const low = s.jobs.checkTrust(j.id, lower)!;
    expect(s.jobs.trustLevel(low)).toBe('untrusted');
    expect(s.jobs.stampHold(low)).toContain('it deletes, overwrites or force-pushes');
    const ok = s.jobs.approveTrust(j.id)!;
    expect(ok.stamp).toMatchObject({ level: 'approved', by: 'person' });
    expect(s.jobs.stampHold(ok)).toBeUndefined();
    expect(s.jobs.checkDue(ok)).toBe(false);
    s.close();
  });
});
