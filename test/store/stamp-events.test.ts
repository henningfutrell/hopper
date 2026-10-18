// The stamp as an event (issue #655 part 11): each stamp the job store signs from where a job's work came — at its
// making, for a new spec, at the backfill, for an origin judged later — is one `intake.stamped` event on the job's
// timeline, with the level, the reasons, who stamped it and the hash of the spec it covers. The MAC is never in it.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { specHashOf } from '../../src/domain/trust-stamp.ts';
import type { JobSourceRef } from '../../src/domain/types.ts';
import type { UserStore } from '../../src/domain/ports.ts';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = Buffer.alloc(32, 3);

const issue = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});
const stamped = (s: UserStore, jobId: string) => s.events.recent(1000, ['intake.stamped'], jobId).map((e) => e.data).reverse();

describe('intake.stamped (issue #655 part 11)', () => {
  it('the spec hash is the SHA-256 of the spec as canonical JSON, whatever its key order', () => {
    expect(specHashOf({ goal: 'g', executor: 'test', payload: { n: 1 } })).toBe(specHashOf(spec));
    expect(specHashOf(spec)).toBe(createHash('sha256').update('{"executor":"test","goal":"g","payload":{"n":1}}').digest('hex'));
  });

  it('a job made by intake: its level, reasons and spec hash, and no MAC', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue());
    expect(stamped(s, j.id)).toEqual([{ level: 'owner', reasons: ['origin:trusted', 'author:assignee'], by: 'intake', spec: specHashOf(spec) }]);
    expect(JSON.stringify(stamped(s, j.id))).not.toContain(j.stamp!.mac);
    s.close();
  });

  it('a job a job made: by job; a parent whose stamp does not verify gives no stamp and no event', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const parent = s.jobs.create(spec, 50, issue());
    const child = s.jobs.create(spec, 50, undefined, parent);
    expect(stamped(s, child.id)).toEqual([{ level: 'trusted', reasons: [`parent:${parent.id}`], by: 'job', spec: specHashOf(spec) }]);
    const forged = s.jobs.create(spec, 50, undefined, { ...parent, stamp: { ...parent.stamp!, mac: 'x' } });
    expect(stamped(s, forged.id)).toEqual([]);
    s.close();
  });

  it('a new spec: by respecify, from the level it had, with the new spec\'s hash', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue());
    const next = { ...spec, payload: { n: 2 } };
    s.jobs.respecify(j.id, next);
    expect(stamped(s, j.id).at(-1)).toEqual({ level: 'owner', reasons: ['origin:trusted', 'author:assignee'], by: 'respecify', from: 'owner', spec: specHashOf(next) });
    s.close();
  });

  it('with no key: no stamp, so no event', () => {
    const s = t.open(t.url());
    const j = s.jobs.create(spec, 50, issue());
    s.jobs.respecify(j.id, { ...spec, payload: { n: 2 } });
    expect(stamped(s, j.id)).toEqual([]);
    s.close();
  });

  it('the backfill: one event for each job it stamps, by backfill', () => {
    const s = t.open(t.url());
    const old = s.jobs.create(spec, 50);
    s.jobs.useStampKey(KEY);
    expect(stamped(s, old.id)).toEqual([{ level: 'approved', reasons: ['source:none'], by: 'backfill', spec: specHashOf(spec) }]);
    s.jobs.useStampKey(KEY);
    expect(stamped(s, old.id)).toHaveLength(1);
    s.close();
  });

  it('an origin judged later: by intake, from the level before; a quarantine kept shows as such', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue({ origin: undefined }));
    s.jobs.update(j.id, { source: { ...j.source!, origin: 'trusted' } });
    s.jobs.restamp(j.id);
    expect(stamped(s, j.id).at(-1)).toEqual({ level: 'owner', reasons: ['origin:trusted', 'author:assignee'], by: 'intake', from: 'untrusted', spec: specHashOf(spec) });
    s.jobs.quarantine(j.id);
    s.jobs.restamp(j.id);
    expect(stamped(s, j.id).at(-1)).toEqual({
      level: 'quarantined', reasons: ['origin:trusted', 'author:assignee', 'quarantined'], by: 'person', was: 'owner', from: 'quarantined', spec: specHashOf(spec),
    });
    s.close();
  });
});
