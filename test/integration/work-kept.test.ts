// The reap at a job's end (issue #401): what it kept for uncommitted or unpushed work is flagged on the
// job's trail as job.work_kept, never removed silently; a reap that kept nothing records nothing. What the job's scope
// used (issue #2498) is recorded as job.resources_used, and each heap abort it read (issue #2722) as job.heap_aborted;
// each core dump and OOM kill of its processes (part 3) as job.core_dumped and job.oom_killed; a scope that did not stop
// (part 6) as job.scope_not_stopped. A job that ended well keeps a note of them (part 7) for its cards.
import { afterEach, describe, expect, it } from 'vitest';
import type { Reaped } from '../../src/domain/ports.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createStickyExecutor } from '../support/doubles.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

let app: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
  cleanup?.();
});

async function cancelled(kept?: string[], removed?: Reaped['removed'], tips?: Reaped['tips'], heads?: string[], used?: Reaped['used'], heap?: Reaped['heap'], crashes: Pick<Reaped, 'cores' | 'oomKilled' | 'scopeNotStopped'> = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const sticky = createStickyExecutor({ ...(kept ? { kept } : {}), ...(tips ? { tips } : {}), ...(removed ? { removed } : {}), ...(used ? { used } : {}), ...(heap ? { heap } : {}), ...crashes });
  app = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [sticky] } });
  const job = await app.pull({}, { executor: 'sticky' });
  await app.waitForStatus(job.id, 'running');
  // Its push through the hopper (issue #2087): the commits it moved its branch to.
  if (heads) app.user().store.events.append({ type: 'github_proxy.done', jobId: job.id, data: { requestId: 'r1', op: 'git.push', repo: 'o/r', refs: ['refs/heads/x'], heads } });
  expect((await app.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: await app.login() })).status).toBe(200);
  await app.waitForStatus(job.id, 'cancelled');
  await waitFor(() => sticky.cleaned.includes(job.id));
  return { a: app, job };
}

describe('work the reap kept (issue #401)', () => {
  it('flags each kept repository on the job: job.work_kept with its paths', async () => {
    const { a, job } = await cancelled(['/w/.worktrees/@scratch/j/repo']);
    await waitFor(async () => (await a.events('types=job.work_kept')).length === 1);
    const [e] = await a.events('types=job.work_kept');
    expect(e).toMatchObject({ jobId: job.id, data: { paths: ['/w/.worktrees/@scratch/j/repo'] } });
  });

  it('records nothing when each tip of the kept work is a commit the hopper pushed for the job (issue #2087)', async () => {
    const repo = '/w/.worktrees/@scratch/j/repo';
    const { a } = await cancelled([repo], undefined, { [repo]: ['c0ffee'] }, ['c0ffee']);
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.work_kept')).toEqual([]);
  });

  it('flags it when a tip is one the hopper did not push (issue #2087)', async () => {
    const repo = '/w/.worktrees/@scratch/j/repo';
    const { a } = await cancelled([repo], undefined, { [repo]: ['c0ffee', 'beef'] }, ['c0ffee']);
    await waitFor(async () => (await a.events('types=job.work_kept')).length === 1);
  });

  it('records nothing when the reap kept nothing', async () => {
    const { a } = await cancelled([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.work_kept')).toEqual([]);
  });
});

describe('the containers and volumes the reap removed (issue #1120)', () => {
  it('are recorded on the job: job.containers_removed with each one', async () => {
    const details = [{ id: 'c0ffee01', name: 'db-1', image: 'postgres:16', startedAt: '2026-10-01T00:05:00.000Z' }];
    const { a, job } = await cancelled(undefined, { containers: ['c0ffee01'], volumes: ['vol-db'], details });
    await waitFor(async () => (await a.events('types=job.containers_removed')).length === 1);
    const [e] = await a.events('types=job.containers_removed');
    expect(e).toMatchObject({ jobId: job.id, data: { containers: ['c0ffee01'], volumes: ['vol-db'], details } });
  });

  it('records nothing when it removed none', async () => {
    const { a } = await cancelled(undefined, { containers: [], volumes: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.containers_removed')).toEqual([]);
  });
});

describe('what the job\'s scope used (issue #2498)', () => {
  it('is recorded on the job: job.resources_used with its machine', async () => {
    const used = { memoryPeakBytes: 3221225472, cpuSeconds: 754.5, oomKills: 1, diskBytes: 1073741824 };
    const { a, job } = await cancelled(undefined, undefined, undefined, undefined, used);
    await waitFor(async () => (await a.events('types=job.resources_used')).length === 1);
    const [e] = await a.events('types=job.resources_used');
    expect(e).toMatchObject({ jobId: job.id, data: used });
  });

  it('records nothing when the reap read none', async () => {
    const { a } = await cancelled([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.resources_used')).toEqual([]);
  });
});

describe('the heap aborts the reap read (issue #2722)', () => {
  it('are recorded on the job: job.heap_aborted for each, with its command and no path', async () => {
    const heap = [{ commandLine: ['node', '/w/node_modules/typescript/bin/tsc', '--noEmit'], heapLimitBytes: 2248146944, rssPeakBytes: 2400000000, abortedAtMs: Date.parse('2026-10-24T10:41:00.000Z') }, {}];
    const { a, job } = await cancelled(undefined, undefined, undefined, undefined, undefined, heap);
    await waitFor(async () => (await a.events('types=job.heap_aborted')).length === 2);
    const events = await a.events('types=job.heap_aborted');
    expect(events.map((e) => e.data)).toEqual(expect.arrayContaining([
      { command: 'tsc --noEmit', heapLimitBytes: 2248146944, rssPeakBytes: 2400000000, abortedAt: '2026-10-24T10:41:00.000Z' }, { command: 'node' },
    ]));
    expect(events.every((e) => e.jobId === job.id)).toBe(true);
  });
});

describe('the core dumps and OOM kills the reap read (issue #2722 part 3)', () => {
  it('are recorded on the job: job.core_dumped and job.oom_killed, with the command and no path', async () => {
    const at = Date.parse('2026-10-24T10:41:00.000Z');
    const crashes = { cores: [{ pid: 41, signal: 11, commandLine: '/usr/bin/cc1plus -O2 big.cpp', dumpedAtMs: at }], oomKilled: [{ pid: 3001, task: 'tsc', killedAtMs: at }] };
    const { a, job } = await cancelled(undefined, undefined, undefined, undefined, undefined, undefined, crashes);
    await waitFor(async () => (await a.events('types=job.oom_killed')).length === 1);
    const [core] = await a.events('types=job.core_dumped'), [oom] = await a.events('types=job.oom_killed');
    expect(core).toMatchObject({ jobId: job.id, data: { command: 'cc1plus -O2 big.cpp', signal: 'SIGSEGV', dumpedAt: '2026-10-24T10:41:00.000Z' } });
    expect(oom).toMatchObject({ jobId: job.id, data: { command: 'tsc', killedAt: '2026-10-24T10:41:00.000Z' } });
  });
});

describe('a scope the reap could not stop (issue #2722 part 6)', () => {
  it('is recorded on the job: job.scope_not_stopped, with its state and the processes in it', async () => {
    const { a, job } = await cancelled(undefined, undefined, undefined, undefined, undefined, undefined, { scopeNotStopped: { state: 'failed', processes: 2 } });
    await waitFor(async () => (await a.events('types=job.scope_not_stopped')).length === 1);
    expect((await a.events('types=job.scope_not_stopped'))[0]).toMatchObject({ jobId: job.id, data: { state: 'failed', processes: 2 } });
  });
});

describe('a job that ended well, with a process of it that failed (issue #2722 part 7)', () => {
  it('keeps the note its cards show: what failed, and its scope that did not stop', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const sticky = createStickyExecutor({ finish: true, heap: [{ commandLine: ['node', '/w/node_modules/typescript/bin/tsc', '--noEmit'] }], scopeNotStopped: { state: 'failed' } });
    app = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [sticky] } });
    const job = await app.pull({}, { executor: 'sticky' });
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => app!.user().store.jobs.get(job.id)?.failedProcesses !== undefined);
    expect(app.user().store.jobs.get(job.id)?.failedProcesses).toEqual({ said: 'a process of the job failed: tsc ran out of heap, and its scope did not stop (failed)', processes: 1 });
  });

  it('keeps none when no process of it failed', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const sticky = createStickyExecutor({ finish: true, kept: [] });
    app = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [sticky] } });
    const job = await app.pull({}, { executor: 'sticky' });
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => sticky.cleaned.includes(job.id));
    expect(app.user().store.jobs.get(job.id)?.failedProcesses).toBeUndefined();
  });
});
