// The in-motion cycle (issue #985): the sync loop follows pull requests in rounds, not at every sync. Every cycle interval
// it follows only the pull requests in motion; every reconcile interval — and at once after a merge or close, at the first
// sync and at a sync a person asked for — it follows every one and reconciles. Each round asks the source for the pull
// requests it follows in one batch first (`readFollowed`). Between rounds, a sync follows none.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FollowUp, Job, PullRequestSeen } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, settle, type FakeSource, type World } from './sync-support.ts';

const MIN = 60_000;
const POLL = MIN;
const CYCLE = 3 * MIN;
const ALL = 15 * MIN;
let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await sync?.stop();
  sync = undefined;
});

/** A finished job of `repo` whose end is reported, following pull request `pr` (or `follow`), last seen as `seen`. */
function followingJob(world: World, id: string, seen: PullRequestSeen | undefined, follow = 'open'): Job {
  const job = {
    id, spec: { executor: 'test', payload: {} }, priority: 50, approved: true, attempts: 1, status: 'finished',
    createdAt: world.clock.now().toISOString(), updatedAt: world.clock.now().toISOString(), finishedAt: world.clock.now().toISOString(),
    source: { source: 'fake', kind: 'fake', key: `o/r#${id}`, repo: 'o/r', number: 1 },
    sourceState: { sync: { claimReported: true, finalReported: true }, source: { pullRequest: `https://github.com/o/r/pull/${id}`, follow, ...(seen ? { seen } : {}), mergeChecked: true } },
  } as unknown as Job;
  world.jobs.set(id, job);
  return job;
}

const pending: PullRequestSeen = { draft: false, conflicting: false, checks: 'pending' };
const idle: PullRequestSeen = { draft: false, conflicting: false, checks: 'passing' };

interface Seen { read: string[][]; followed: string[][]; reconciled: number }

function setUp(source: FakeSource) {
  const world = createWorld();
  const seen: Seen = { read: [], followed: [], reconciled: 0 };
  let round: string[] = [];
  source.readFollowed = async (jobs) => { round = []; seen.followed.push(round); seen.read.push(jobs.map((j) => j.id)); };
  source.follow ??= async (job) => { round.push(job.id); return undefined; };
  source.unfollowedPullRequests = async () => { seen.reconciled++; return []; };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => POLL, followEvery: () => ({ cycleMs: CYCLE, allMs: ALL }) });
  const pass = async (ms: number) => { world.clock.advance(ms); vi.advanceTimersByTime(ms); await settle(12); };
  return { world, sync, pass, seen };
}

describe('the in-motion cycle', () => {
  it('follows every pull request at the first sync, then only those in motion each cycle, and every one each reconcile interval', async () => {
    const source = createFakeSource();
    const { world, sync, pass, seen } = setUp(source);
    followingJob(world, 'motion', pending);
    followingJob(world, 'idle', idle);
    followingJob(world, 'merged', idle, 'merged');
    sync.start();
    await settle(12);
    expect(seen.read).toEqual([['motion', 'idle']]);
    expect(seen.followed.at(-1)!.sort()).toEqual(['idle', 'motion']);
    expect(seen.reconciled).toBe(1);
    await pass(POLL);
    await pass(POLL);
    expect(source.discovers).toBe(3);
    expect(seen.read).toHaveLength(1); // a sync between rounds follows none
    await pass(POLL);
    expect(seen.read.at(-1)).toEqual(['motion']); // the cycle: in motion only
    expect(seen.followed.at(-1)).toEqual(['motion']);
    expect(seen.reconciled).toBe(1);
    for (let t = 4; t < 15; t++) await pass(POLL);
    expect(seen.read.map((r) => r.join())).toEqual(['motion,idle', 'motion', 'motion', 'motion']);
    await pass(POLL);
    expect(seen.read.at(-1)).toEqual(['motion', 'idle']); // the reconcile interval: every one
    expect(seen.reconciled).toBe(2);
  });

  it('a cycle with nothing in motion asks nothing', async () => {
    const source = createFakeSource();
    const { world, sync, pass, seen } = setUp(source);
    followingJob(world, 'idle', idle);
    sync.start();
    await settle(12);
    for (let t = 1; t <= 6; t++) await pass(POLL);
    expect(seen.read).toEqual([['idle']]);
  });

  it('a sync a person asked for follows every one', async () => {
    const source = createFakeSource();
    const { world, sync, seen } = setUp(source);
    followingJob(world, 'idle', idle);
    sync.start();
    await settle(12);
    await sync.syncNow();
    await settle(12);
    expect(seen.read).toEqual([['idle'], ['idle']]);
    expect(seen.reconciled).toBe(2);
  });

  it('a merge syncs again at once and follows every one: the others are seen on the new base', async () => {
    const source = createFakeSource();
    let merged = false;
    let round: string[] = [];
    const followed: string[][] = [];
    source.follow = async (job) => {
      round.push(job.id);
      if (job.id !== 'motion' || merged) return undefined;
      merged = true;
      return { outcome: 'merged', pullRequest: 'https://github.com/o/r/pull/motion', part: false, byHopper: true, state: { ...job.sourceState?.source, follow: 'merged' } } satisfies FollowUp;
    };
    const { world, sync, pass, seen } = setUp(source);
    source.readFollowed = async (jobs) => { round = []; followed.push(round); seen.read.push(jobs.map((j) => j.id)); };
    followingJob(world, 'motion', pending);
    followingJob(world, 'idle', idle);
    sync.start();
    await settle(12);
    await pass(POLL);
    await pass(POLL);
    await pass(POLL); // the cycle merges `motion`
    await pass(0);
    expect(seen.read.slice(1)).toEqual([['motion'], ['idle']]);
    expect(source.discovers).toBe(5);
  });

  it('a batch that fails follows nothing that round; the next round asks again', async () => {
    const source = createFakeSource();
    const { world, sync, pass, seen } = setUp(source);
    let fail = true;
    const read = source.readFollowed!;
    source.readFollowed = async (jobs) => { if (fail) { fail = false; throw new Error('GitHub is down'); } return read(jobs); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    followingJob(world, 'motion', pending);
    sync.start();
    await settle(12);
    expect(seen.followed).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GitHub is down'));
    for (let t = 1; t <= 3; t++) await pass(POLL);
    expect(seen.followed).toEqual([['motion']]);
    warn.mockRestore();
  });
});
