// A job's resource ledger (issue #2504): what its executor saved that it made — its scratch dir, job worktree and job scope —
// is recorded on its machine as it runs, and the cleanup at its end closes each entry as the reap says: reaped, kept with
// work not pushed, or failed with why. The parts list shows the cleanup status and each entry. Real database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, ExecutionOutcome, Reaped } from '../../src/domain/ports.ts';
import type { JobBom } from '../../src/domain/types.ts';
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
function ledgered(said: (jobId: string) => Reaped) {
  const cleaned: string[] = [];
  const executor: Executor = {
    name: 'ledgered', idempotent: false, validate: () => null,
    run(ctx) {
      ctx.saveState({ cwd: '/w', jobWorktree: `/w/.worktrees/app/${ctx.job.id}`, scope: `hopper-job-${ctx.job.id}.scope`, paneId: 'p1' });
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

async function ended(said: (jobId: string) => Reaped, end: 'cancelled' | 'finished' | 'failed' = 'cancelled') {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const { executor, cleaned } = ledgered(said);
  app = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [executor] } });
  const job = await app.pull(end === 'cancelled' ? {} : { end }, { executor: 'ledgered' });
  if (end === 'cancelled') {
    await app.waitForStatus(job.id, 'running');
    expect(app.user().store.resourceLedger.forJob(job.id).map((e) => [e.state, e.machineId])).toEqual([['live', 'local'], ['live', 'local'], ['live', 'local']]);
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
});
