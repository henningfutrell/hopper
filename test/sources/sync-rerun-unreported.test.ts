// Issue #2932: Run again just after a Cancel was refused with 409 "its end is not reported to its source yet" until the
// next sync told the source. Now Run again tells the job's end to its source first, on the job's report chain, and then
// gives the item back. Only when the source still does not take the report is Run again refused, with that reason.
import { afterEach, describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle, type FakeSource } from './sync-support.ts';

const REPO = 'owner/repo';
const KEY = `https://github.com/${REPO}/issues/9`;
const transient = () => new SourceError('GitHub did not answer', false);

describe('Run again before the end is reported (issue #2932)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  /** A cancelled job whose end report failed `failures` times: once at the sync's start, the rest at Run again. */
  async function setup(failures: number) {
    const world = createWorld();
    const given: string[] = [];
    const source: FakeSource = Object.assign(createFakeSource('github-app'), {
      async rerun(job: Job) { given.push(job.id); return item(KEY, { repo: REPO }); },
    });
    source.reportErrors = Array.from({ length: failures }, transient);
    world.jobs.set('j', {
      id: 'j', spec: { executor: 'test', payload: {} }, priority: 50, status: 'cancelled', approved: false, attempts: 1,
      createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
      source: { source: 'github-app', kind: 'github-app', key: KEY, url: KEY, repo: REPO, number: 9 },
      sourceState: { sync: { claimReported: true, finalReported: false } },
    } as Job);
    const sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
    stop = () => sync.stop();
    sync.start();
    await settle();
    return { world, sync, source, given };
  }

  it('the end is told first, then the item is given back and the new job is made', async () => {
    const { world, sync, source, given } = await setup(1);
    expect(world.store.jobs.get('j')!.sourceState?.sync).toMatchObject({ finalReported: false });
    const r = await sync.rerun('j');
    expect(r.ok).toBe(true);
    expect(source.reports.map((x) => x.kind)).toEqual(['cancelled']);
    expect(given).toEqual(['j']);
    expect(world.store.jobs.getBySourceKey(KEY)!.id).not.toBe('j');
  });

  it('a person\'s Run again is taken, not refused; its give-back runs after the end is told', async () => {
    const { world, sync, source } = await setup(1);
    expect(sync.giveBack('j', { kind: 'rerun' })).toMatchObject({ ok: true, giveBack: 'rerun' });
    await settle(20);
    expect(source.reports.map((x) => x.kind)).toEqual(['cancelled']);
    expect(world.store.jobs.getBySourceKey(KEY)!.id).not.toBe('j');
  });

  it('the source still does not take the end: refused with why, and the item is not given back', async () => {
    const { sync, given } = await setup(2);
    const r = await sync.rerun('j');
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(r.ok ? '' : r.message).toContain('its end is not reported to its source yet');
    expect(given).toEqual([]);
  });
});
