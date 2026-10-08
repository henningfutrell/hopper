import type { Clock, ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createFakeHerdrClient, createHerdrClaudeExecutor } from '../../src/executors/herdr/index.ts';
import type { FakeHerdrOptions } from '../../src/executors/herdr/index.ts';

export const JOB_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
export const CWD = '/tmp/jh-work';
export const LANE = 'local/lane-1';
export const LOCAL: MachineSnapshot = { id: 'local', label: 'server', maxLanes: 4, online: true, executors: ['herdr-claude'] };
export const LAPTOP: MachineSnapshot = { id: 'laptop', label: 'laptop', maxLanes: 2, online: true, executors: ['herdr-claude'], ssh: 'laptop', herdr: { session: 'jh-there' } };

/** A clock that only moves when the executor sleeps; each sleep yields one macrotask. */
export function fakeClock(start = Date.parse('2026-10-02T12:00:00Z')) {
  let t = start;
  const clock: Clock & { elapsed(): number } = { now: () => new Date(t), elapsed: () => t - start };
  const sleep = async (ms: number): Promise<void> => {
    t += ms;
    await new Promise((r) => setImmediate(r));
  };
  return { clock, sleep };
}

export function jobWith(payload: Record<string, unknown>, extra: Partial<Job> = {}): Job {
  return {
    id: JOB_ID, spec: { executor: 'herdr-claude', payload }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1, ...extra,
  };
}

export function contextFor(job: Job, laneId = LANE, machine: MachineSnapshot = LOCAL) {
  const ac = new AbortController();
  const progress: { fraction: number; message?: string }[] = [];
  const saved: Record<string, unknown>[] = [];
  const workTrees: string[] = [];
  const ctx: ExecutionContext = {
    job, laneId, machine, signal: ac.signal,
    progress: (fraction, message) => progress.push({ fraction, message }),
    saveState: (s) => saved.push(s),
    workTree: (path) => workTrees.push(path),
  };
  return { ctx, ac, progress, saved, workTrees };
}

export function setup(
  fakeOptions: FakeHerdrOptions = {},
  overrides: { defaultCwd?: string; trustWorkdir?: boolean; yolo?: boolean; jobWorktrees?: boolean; idleNudgeMs?: number; claudeArgs?: string[]; remote?: Record<string, FakeHerdrOptions>; local?: Record<string, FakeHerdrOptions> } = {},
) {
  const herdr = createFakeHerdrClient({ session: 'jh-test', ...fakeOptions });
  const remotes = new Map(Object.entries(overrides.remote ?? {}).map(([target, fo]) => [target, createFakeHerdrClient({ session: 'jh-there', ...fo })]));
  const locals = new Map(Object.entries(overrides.local ?? {}).map(([session, fo]) => [session, createFakeHerdrClient({ session, ...fo })]));
  const reached: unknown[] = [];
  const { clock, sleep } = fakeClock();
  const executor = createHerdrClaudeExecutor({
    herdr, clock, sleep,
    local: (session) => {
      const l = locals.get(session);
      if (!l) throw new Error(`no fake herdr session ${session}`);
      return l;
    },
    remote: (there) => {
      reached.push(there);
      const key = 'client' in there ? there.client.machine : there.ssh;
      const r = remotes.get(key);
      if (!r) throw new Error(`no fake herdr for ${key}`);
      return r;
    },
    defaultCwd: overrides.defaultCwd ?? CWD, claudeArgs: overrides.claudeArgs ?? ['--dangerously-skip-permissions'],
    trustWorkdir: overrides.trustWorkdir ?? true, yolo: overrides.yolo ?? true, jobWorktrees: overrides.jobWorktrees ?? false, pollMs: 1000, idleNudgeMs: overrides.idleNudgeMs ?? 20000,
  });
  return { herdr, remotes, locals, reached, clock, executor };
}

/** Yield macrotasks until cond holds (the executor loop advances one poll per yield). */
export async function until(cond: () => boolean, max = 2000): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('condition never held');
}
