// Issue #967: tending starts on GitHub's events, not only on each sync. Between syncs the sync loop asks the source
// whether a pull request or a branch of a repository it follows moved (`JobSource.moved`); one moved starts a sync at
// once. A sync that recorded a merge or a close syncs again at once, so the other pull requests are tended on the new base.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FollowUp, Job } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, settle, type FakeSource, type World } from './sync-support.ts';

const POLL = 60_000;
const WATCH = 1_000;
let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await sync?.stop();
  sync = undefined;
});

/** A finished job of `repo` whose end is reported, following pull request `pr` (or `follow`). */
function followingJob(world: World, id: string, repo: string, pr: string, follow = 'open'): Job {
  const job = {
    id, spec: { executor: 'test', payload: {} }, priority: 50, approved: true, attempts: 1, status: 'finished',
    createdAt: world.clock.now().toISOString(), updatedAt: world.clock.now().toISOString(), finishedAt: world.clock.now().toISOString(),
    source: { source: 'fake', kind: 'fake', key: `${repo}#${id}`, repo, number: 1 },
    sourceState: { sync: { claimReported: true, finalReported: true }, source: { pullRequest: pr, follow } },
  } as unknown as Job;
  world.jobs.set(id, job);
  return job;
}

function setUp(source: FakeSource) {
  const world = createWorld();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => POLL, watchMs: WATCH });
  const pass = async (ms: number) => { world.clock.advance(ms); vi.advanceTimersByTime(ms); await settle(); };
  return { world, sync, pass };
}

describe('a sync on GitHub events', () => {
  it('starts a sync at once when a followed repository moved, before the poll timer', async () => {
    const source = createFakeSource();
    const asked: string[][] = [];
    let moved = false;
    source.moved = async (repos) => { asked.push(repos); return moved; };
    const { world, sync, pass } = setUp(source);
    followingJob(world, 'job-1', 'o/r', 'https://github.com/o/r/pull/7');
    sync.start();
    await settle();
    expect(source.discovers).toBe(1);
    await pass(WATCH);
    expect(asked.at(-1)).toEqual(['o/r']);
    expect(source.discovers).toBe(1); // nothing moved: no sync
    moved = true;
    await pass(WATCH);
    expect(source.discovers).toBe(2); // moved: a sync at once
    expect(Date.parse(sync.statuses()[0]!.nextSyncAt!)).toBe(world.clock.now().getTime() + POLL);
  });

  it('asks only of the repositories whose pull requests it follows or tends, and of none when it follows none', async () => {
    const source = createFakeSource();
    const asked: string[][] = [];
    source.moved = async (repos) => { asked.push(repos); return false; };
    const { world, sync, pass } = setUp(source);
    sync.start();
    await settle();
    await pass(WATCH);
    expect(asked).toEqual([]); // nothing followed: GitHub is not asked
    followingJob(world, 'job-1', 'o/a', 'https://github.com/o/a/pull/1');
    followingJob(world, 'job-2', 'o/b', 'https://github.com/o/b/pull/2', 'tended');
    followingJob(world, 'job-3', 'o/c', 'https://github.com/o/c/pull/3', 'merged');
    followingJob(world, 'job-4', 'O/A', 'https://github.com/o/a/pull/4');
    await pass(WATCH);
    expect(asked.at(-1)).toEqual(['o/a', 'o/b']);
  });

  it('a failed ask is no sync, and the next tick asks again', async () => {
    const source = createFakeSource();
    let calls = 0;
    source.moved = async () => { calls++; if (calls === 1) throw new Error('GitHub is down'); return true; };
    const { world, sync, pass } = setUp(source);
    followingJob(world, 'job-1', 'o/r', 'https://github.com/o/r/pull/7');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sync.start();
    await settle();
    await pass(WATCH);
    expect(source.discovers).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GitHub is down'));
    await pass(WATCH);
    expect(source.discovers).toBe(2);
    warn.mockRestore();
  });
});

describe('a sync again after a merge', () => {
  it('a sync that recorded a merge syncs again at once; one that merged nothing waits for the timer', async () => {
    const source = createFakeSource();
    const pr = 'https://github.com/o/r/pull/7';
    let merged = false;
    source.follow = async (job) => {
      if (merged) return undefined;
      merged = true;
      const s = job.sourceState?.source ?? {};
      return { outcome: 'merged', pullRequest: pr, part: false, byHopper: true, state: { ...s, follow: 'merged' } } satisfies FollowUp;
    };
    const { world, sync, pass } = setUp(source);
    followingJob(world, 'job-1', 'o/r', pr);
    sync.start();
    await settle(12);
    await pass(0);
    expect(source.discovers).toBe(2); // the merge's sync, then one at once on the new base
    await pass(WATCH);
    expect(source.discovers).toBe(2); // the second merged nothing: the timer decides
    await pass(POLL);
    expect(source.discovers).toBe(3);
  });
});
