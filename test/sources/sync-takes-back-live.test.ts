// Issue #1777: a job that is live again (a Continue or a resume took it back to the queue) has no end to report to its
// source. Its Run again check says it is queued again, not "its end is not reported to its source yet", and not soon: that
// reason is for an ended job only (issue #186), and it clears once the end is reported.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle, type FakeSource } from './sync-support.ts';

const REPO = 'owner/repo';
const KEY = `https://github.com/${REPO}/issues/8`;

describe('Run again on a job that is live again (issue #1777)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  async function setup() {
    const world = createWorld();
    const source: FakeSource = Object.assign(createFakeSource('github-app'), { async rerun() { return item(KEY, { repo: REPO }); } });
    world.jobs.set('j', {
      id: 'j', spec: { executor: 'test', payload: {} }, priority: 50, status: 'failed', approved: false, attempts: 1,
      createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
      source: { source: 'github-app', kind: 'github-app', key: KEY, url: KEY, repo: REPO, number: 8 },
      sourceState: { sync: { claimReported: true, finalReported: false } },
    } as Job);
    const sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
    stop = () => sync.stop();
    sync.start();
    await settle();
    return { world, sync };
  }

  it('an ended job whose end is not reported yet: not reported, soon; reported: taken', async () => {
    const { world, sync } = await setup();
    world.patchJob('j', { sourceState: { sync: { claimReported: true, finalReported: false } } });
    expect(sync.takesBack('j')).toEqual({ ok: false, why: 'its end is not reported to its source yet', soon: true });
    world.patchJob('j', { sourceState: { sync: { claimReported: true, finalReported: true } } });
    expect(sync.takesBack('j')).toEqual({ ok: true });
  });

  it('queued again: says so, and is not soon', async () => {
    const { world, sync } = await setup();
    world.patchJob('j', { status: 'queued', sourceState: { sync: { claimReported: false, finalReported: false } } });
    expect(sync.takesBack('j')).toEqual({ ok: false, why: 'it is already queued again: it runs when a lane is free' });
  });

  it('running again: says so, and is not soon', async () => {
    const { world, sync } = await setup();
    world.patchJob('j', { status: 'running', sourceState: { sync: { claimReported: true, finalReported: false } } });
    expect(sync.takesBack('j')).toEqual({ ok: false, why: 'it is already running again: it is not ended' });
  });
});
