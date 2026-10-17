// Trust stamps in the job store (issue #655, part 1): once the store has its user's stamp key, each job it creates is
// stamped by the rules, a job a job made gets at most its parent's level, a new spec is stamped again (never higher),
// and a row changed outside the store shows as a mismatch. A job without a stamp is stamped once, at the key's start.
import { describe, expect, it } from 'vitest';
import { STAMP_MISMATCH, STAMP_MISSING } from '../../src/domain/trust-stamp.ts';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { openDb } from '../../src/store/db.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = Buffer.alloc(32, 3);

const issue = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});

describe('trust stamps in the job store (issue #655)', () => {
  it('with no key, stamps nothing and checks nothing', () => {
    const s = t.open(t.url());
    const j = s.jobs.create(spec, 50, issue());
    expect(j.stamp).toBeUndefined();
    expect(s.jobs.stampHold(j)).toBeUndefined();
    s.close();
  });

  it('stamps each job it creates by the rules', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue());
    expect(j.stamp).toMatchObject({ v: 1, level: 'owner', by: 'intake', reasons: ['origin:trusted', 'author:assignee'], at: '2026-10-02T10:00:00.000Z' });
    expect(s.jobs.get(j.id)!.stamp).toEqual(j.stamp);
    expect(s.jobs.stampHold(s.jobs.get(j.id)!)).toBeUndefined();
    const stranger = s.jobs.create(spec, 50, issue({ key: 'k2', author: 'stranger', origin: 'approved' }));
    expect(stranger.stamp?.level).toBe('approved');
    s.close();
  });

  it('a job a job made: at most its parent\'s level, never owner; a parent with a bad stamp gives none', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const parent = s.jobs.create(spec, 50, issue());
    const child = s.jobs.create(spec, 50, undefined, parent);
    expect(child.stamp).toMatchObject({ level: 'trusted', by: 'job', reasons: [`parent:${parent.id}`] });
    const approved = s.jobs.create(spec, 50, issue({ key: 'k3', origin: 'approved' }));
    expect(s.jobs.create(spec, 50, issue({ key: 'k3' }), approved).stamp?.level).toBe('approved');
    const forged = s.jobs.create(spec, 50, undefined, { ...parent, stamp: { ...parent.stamp!, level: 'owner', mac: 'x' } });
    expect(forged.stamp).toBeUndefined();
    expect(s.jobs.stampHold(forged)).toBe(STAMP_MISSING);
    s.close();
  });

  it('a new spec is stamped again, at the level it had or lower', () => {
    const clock = fixedClock();
    const s = t.open(t.url(), clock);
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue());
    clock.set('2026-10-02T11:00:00.000Z');
    const next = s.jobs.respecify(j.id, { ...spec, payload: { n: 2 } });
    expect(next.stamp).toMatchObject({ level: 'owner', by: 'respecify', at: '2026-10-02T11:00:00.000Z' });
    expect(s.jobs.stampHold(next)).toBeUndefined();
    s.close();
  });

  it('a row changed outside the store: a mismatch; a stamp removed: missing', () => {
    const url = t.url();
    const s = t.open(url);
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue({ origin: 'approved', author: 'stranger' }));
    const db = openDb(userSchema(url));
    const raised = { ...j, stamp: { ...j.stamp!, level: 'owner' } };
    db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(raised), j.id);
    expect(s.jobs.stampHold(s.jobs.get(j.id)!)).toBe(STAMP_MISMATCH);
    const { stamp: _s, ...bare } = j;
    db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(bare), j.id);
    expect(s.jobs.stampHold(s.jobs.get(j.id)!)).toBe(STAMP_MISSING);
    db.close();
    s.close();
  });

  it('the key\'s start stamps each job that has not ended and has none, by the rules, and says which', () => {
    const s = t.open(t.url());
    const queued = s.jobs.create(spec, 50, issue());
    const ended = s.jobs.update(s.jobs.create(spec, 50, issue({ key: 'k4' })).id, { status: 'finished' });
    expect(s.jobs.useStampKey(KEY)).toEqual([queued.id]);
    expect(s.jobs.get(queued.id)!.stamp).toMatchObject({ level: 'owner', by: 'backfill' });
    expect(s.jobs.get(ended.id)!.stamp).toBeUndefined();
    // Once each: a second start stamps nothing more.
    expect(s.jobs.useStampKey(KEY)).toEqual([]);
    s.close();
  });
});

/** The user `admin`'s own schema, as the store opens it. */
function userSchema(url: string): string {
  const u = new URL(url);
  u.searchParams.set('schema', `${u.searchParams.get('schema')!}_u_admin`);
  return u.toString();
}

describe('a job whose origin is judged after it was made (issue #652, the backfill)', () => {
  it('is stamped again by the rules', () => {
    const s = t.open(t.url());
    s.jobs.useStampKey(KEY);
    const j = s.jobs.create(spec, 50, issue({ origin: undefined }));
    expect(j.stamp?.level).toBe('untrusted');
    s.jobs.update(j.id, { source: { ...j.source!, origin: 'trusted' } });
    expect(s.jobs.restamp(j.id).stamp).toMatchObject({ level: 'owner', by: 'intake' });
    expect(s.jobs.stampHold(s.jobs.get(j.id)!)).toBeUndefined();
    s.close();
  });
});
