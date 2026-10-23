// A job's resource ledger (issue #2504): what its executor saved that it made — its scratch dir, job worktree and job scope —
// is recorded on its machine as it runs, and the cleanup at its end closes each entry as the reap says: reaped, kept with
// work not pushed, or failed with why. The parts list shows the cleanup status and each entry. Real database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, ExecutionOutcome, Reaped } from '../../src/domain/ports.ts';
import type { FailuresView, JobBom } from '../../src/domain/types.ts';
import type { MachineView } from '../../src/engine/queries.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

let app: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
  cleanup?.();
});

/**
 * Saves the state a herdr-claude job saves, then ends as its payload's `end` says (`finished`, `failed`), or runs until
 * stopped; reaps as `said` (a function of the job id) says.
 */
function ledgered(said: (jobId: string) => Reaped, session?: string) {
  const cleaned: string[] = [];
  const executor: Executor = {
    name: 'ledgered', idempotent: false, validate: () => null,
    run(ctx) {
      ctx.saveState({ cwd: '/w', jobWorktree: `/w/.worktrees/app/${ctx.job.id}`, scope: `hopper-job-${ctx.job.id}.scope`, paneId: 'p1' });
      if (session) ctx.agentSession?.(session);
      // The test op travels as the prompt's first line (support/app.ts `pull`).
      const end = (JSON.parse(String((ctx.job.spec.payload as { prompt?: unknown }).prompt).split('\n')[0]!) as { end?: string }).end;
      if (end === 'finished') return Promise.resolve({ kind: 'finished', result: 'ok' });
      if (end === 'failed') return Promise.resolve({ kind: 'failed', error: 'broke' });
      return new Promise<ExecutionOutcome>((resolve) => { ctx.signal.addEventListener('abort', () => resolve({ kind: 'failed', error: 'aborted' }), { once: true }); });
    },
    async cleanup(job) { cleaned.push(job.id); return said(job.id); },
  };
  return { executor, cleaned };
}

async function ended(said: (jobId: string) => Reaped, end: 'cancelled' | 'finished' | 'failed' = 'cancelled', session?: string) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const { executor, cleaned } = ledgered(said, session);
  const source = createManualSource();
  app = await startTestApp({ dbPath: db.dbPath, source, seams: { executors: [executor] } });
  const job = await app.pull(end === 'cancelled' ? {} : { end }, { executor: 'ledgered' });
  // The manual source offers an ended job's item again, and a later sync would make a second job of it.
  source.remove(job.source!.key);
  if (end === 'cancelled') {
    await app.waitForStatus(job.id, 'running');
    await waitFor(() => !session || app!.user().store.resourceLedger.forJob(job.id).length === 4);
    expect(app.user().store.resourceLedger.forJob(job.id).map((e) => [e.state, e.machineId])).toEqual((session ? [1, 2, 3, 4] : [1, 2, 3]).map(() => ['live', 'local']));
    expect((await app.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: await app.login() })).status).toBe(200);
  }
  await app.waitForStatus(job.id, end);
  await waitFor(() => cleaned.includes(job.id) && !app!.user().store.jobs.get(job.id)?.cleanupDue);
  return { a: app, job };
}

const states = (a: TestApp, jobId: string) => a.user().store.resourceLedger.forJob(jobId).map((e) => [e.kind, e.locator, e.state]);

describe('the resource ledger (issue #2504)', () => {
  it.each(['cancelled', 'finished', 'failed'] as const)('records what the job made while it runs, and the cleanup when it ends %s reaps every entry', async (end) => {
    const { a, job } = await ended(() => ({ kept: [] }), end);
    expect(states(a, job.id)).toEqual([
      ['job_scope', `hopper-job-${job.id}.scope`, 'reaped'],
      ['job_worktree', `/w/.worktrees/app/${job.id}`, 'reaped'],
      ['scratch_dir', `/w/.worktrees/@scratch/${job.id}`, 'reaped'],
    ]);
    const bom = (await a.api<JobBom>('GET', `/api/jobs/${job.id}/bom`)).body;
    expect(bom.parts.find((p) => p.id === 'cleanup')).toMatchObject({ group: 'machines', status: 'done', label: 'Cleanup: done', detail: '3 of 3 closed' });
    expect(bom.parts.find((p) => p.id === `resource:scratch_dir:/w/.worktrees/@scratch/${job.id}`)).toMatchObject({ group: 'machines', kind: 'scratch_dir', status: 'recorded' });
  });

  it('keeps the scratch dir and the job worktree with work not pushed, and stops the scope', async () => {
    const { a, job } = await ended((id) => ({ kept: [`/w/.worktrees/app/${id}`] }));
    expect(states(a, job.id).map(([kind, , state]) => [kind, state])).toEqual([['job_scope', 'reaped'], ['job_worktree', 'kept'], ['scratch_dir', 'kept']]);
    const bom = (await a.api<JobBom>('GET', `/api/jobs/${job.id}/bom`)).body;
    expect(bom.parts.find((p) => p.id === 'cleanup')).toMatchObject({ status: 'open', label: 'Cleanup: done, work not pushed kept' });
  });

  it('fails an entry the reap could not remove, with why, and says so on the parts list', async () => {
    const { a, job } = await ended((id) => ({ kept: [], left: [`/w/.worktrees/@scratch/${id}/containers`] }));
    const scratch = a.user().store.resourceLedger.forJob(job.id).find((e) => e.kind === 'scratch_dir');
    expect(scratch).toMatchObject({ state: 'failed', reason: `/w/.worktrees/@scratch/${job.id}/containers is still there` });
    const bom = (await a.api<JobBom>('GET', `/api/jobs/${job.id}/bom`)).body;
    expect(bom.parts.find((p) => p.id === 'cleanup')).toMatchObject({ status: 'failed', detail: '3 of 3 closed, 1 failed' });
    expect(bom.parts.find((p) => p.kind === 'scratch_dir')?.status).toBe('failed');
  });

  it('lists an ended job whose removal failed as stuck work once the grace period passed, until a later reap removes it', async () => {
    const { a, job } = await ended((id) => ({ kept: [], left: [`/w/.worktrees/@scratch/${id}/containers`] }));
    const store = a.user().store;
    const stuck = async () => (await a.api<FailuresView>('GET', '/api/failures')).body.stuck.find((c) => c.cause === 'cleanup_leftover')?.ids ?? [];
    expect(store.resourceLedger.open().map((e) => [e.jobId, e.kind, e.state])).toEqual([[job.id, 'scratch_dir', 'failed']]);
    expect(await stuck()).toEqual([]);
    store.jobs.update(job.id, { finishedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    expect(await stuck()).toEqual([job.id]);
    store.resourceLedger.close(job.id, 'scratch_dir', `/w/.worktrees/@scratch/${job.id}`, 'reaped', new Date().toISOString());
    expect(store.resourceLedger.open()).toEqual([]);
    expect(await stuck()).toEqual([]);
  });

  it('counts the cleanup leftovers on the machine they are on (part 3)', async () => {
    const { a, job } = await ended((id) => ({ kept: [], left: [`/w/.worktrees/@scratch/${id}/containers`] }));
    const store = a.user().store;
    const machineId = store.resourceLedger.forJob(job.id)[0]!.machineId;
    const counts = async () => (await a.api<{ machines: MachineView[] }>('GET', '/api/machines')).body.machines.find((m) => m.id === machineId)?.cleanupLeftovers;
    expect(await counts()).toBeUndefined();
    store.jobs.update(job.id, { finishedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    expect(await counts()).toEqual({ jobs: 1, entries: 1, failed: 1 });
  });

  it('keeps when an entry is kept for its retention, and a later close keeps it as the record (part 5)', async () => {
    const { a, job } = await ended((id) => ({ kept: [], left: [`/w/.worktrees/@scratch/${id}/containers`] }));
    const store = a.user().store, scratch = `/w/.worktrees/@scratch/${job.id}`, until = '2026-10-23T00:00:00.000Z';
    store.resourceLedger.retain(job.id, 'scratch_dir', scratch, until);
    expect(store.resourceLedger.open()).toMatchObject([{ kind: 'scratch_dir', state: 'failed', retainedUntil: until }]);
    store.resourceLedger.close(job.id, 'scratch_dir', scratch, 'reaped', new Date().toISOString());
    expect(store.resourceLedger.forJob(job.id).find((e) => e.kind === 'scratch_dir')).toMatchObject({ state: 'reaped', retainedUntil: until });
    store.resourceLedger.retain(job.id, 'scratch_dir', scratch, '2026-10-24T00:00:00.000Z');
    expect(store.resourceLedger.forJob(job.id).find((e) => e.kind === 'scratch_dir')?.retainedUntil).toBe(until);
  });

  it('records an entry with its retention, never over one the ledger has, and lists the entries on a machine (part 6)', async () => {
    const { a, job } = await ended(() => ({ kept: [] }));
    const store = a.user().store, machineId = store.resourceLedger.forJob(job.id)[0]!.machineId, until = '2026-10-23T00:00:00.000Z';
    store.resourceLedger.record({ jobId: job.id, machineId, kind: 'scratch_dir', locator: '/v/.worktrees/@scratch/x', createdAt: until, retainedUntil: until });
    store.resourceLedger.record({ jobId: job.id, machineId, kind: 'scratch_dir', locator: `/w/.worktrees/@scratch/${job.id}`, createdAt: until, retainedUntil: until });
    const here = store.resourceLedger.onMachine(machineId);
    expect(here.find((e) => e.locator === '/v/.worktrees/@scratch/x')).toMatchObject({ state: 'live', retainedUntil: until });
    expect(here.find((e) => e.locator === `/w/.worktrees/@scratch/${job.id}`)).toMatchObject({ state: 'reaped' });
    expect(here.find((e) => e.locator === `/w/.worktrees/@scratch/${job.id}`)?.retainedUntil).toBeUndefined();
    expect(store.resourceLedger.onMachine('elsewhere')).toEqual([]);
  });

  it('records the agent session the executor reports, and the cleanup at the end reaps it with the processes, also with work kept (part 11)', async () => {
    const { a, job } = await ended((id) => ({ kept: [`/w/.worktrees/app/${id}`] }), 'cancelled', 's-1');
    expect(states(a, job.id).find(([kind]) => kind === 'agent_session')).toEqual(['agent_session', 's-1', 'reaped']);
    const bom = (await a.api<JobBom>('GET', `/api/jobs/${job.id}/bom`)).body;
    expect(bom.parts.find((p) => p.id === 'resource:agent_session:s-1')).toMatchObject({ group: 'machines', kind: 'agent_session', label: 'Agent session on local', status: 'recorded' });
  });
});
