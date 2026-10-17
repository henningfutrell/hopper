// Several hoppers on one database (issue #1662): a running job is held by a lease of the hopper that drives it. Another
// hopper on the same database leaves it alone while that lease lives, and takes the job once the lease ends: here its
// hopper stops, and the other reattaches the job's pane, which is still alive on its machine. The task is sent once.
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../../src/domain/ports.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

/** One machine's panes, which outlive the hopper that opened them: each job's pane, and what ends it. */
function machine() {
  const panes = new Map<string, { end(): void; ended: Promise<void> }>();
  /** Each task sent into a pane: the job, and which hopper sent it. */
  const sent: { jobId: string; by: string }[] = [];
  /** Each reattach: the job, and which hopper watches it again. */
  const reattached: { jobId: string; by: string }[] = [];
  /** The job's pane ends done; or the watch ends with the hopper (abort), and the pane lives on. */
  const watch = (ctx: ExecutionContext): Promise<ExecutionOutcome> => new Promise((resolve) => {
    if (ctx.signal.aborted) { resolve({ kind: 'failed', error: 'aborted' }); return; }
    void panes.get(ctx.job.id)!.ended.then(() => resolve({ kind: 'finished', result: 'done' }));
    ctx.signal.addEventListener('abort', () => resolve({ kind: 'failed', error: 'aborted' }), { once: true });
  });
  /** The executor as hopper `by` runs it: not idempotent, and it reattaches a pane that is alive. */
  const executor = (by: string): Executor => ({
    name: 'pane', idempotent: false, validate: () => null,
    run(ctx) {
      let end!: () => void;
      const ended = new Promise<void>((r) => { end = r; });
      panes.set(ctx.job.id, { end, ended });
      sent.push({ jobId: ctx.job.id, by });
      return watch(ctx);
    },
    async canReattach(job) { return panes.has(job.id); },
    reattach(ctx) {
      reattached.push({ jobId: ctx.job.id, by });
      return watch(ctx);
    },
  });
  return { panes, sent, reattached, executor };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

async function twoHoppers(n: number) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const m = machine();
  cleanups.push(() => { for (const p of m.panes.values()) p.end(); });
  const first = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(n) }, source: createManualSource(), seams: { executors: [m.executor('first')] } });
  apps.push(first);
  return { m, first, start: async () => {
    // Its own manual source, which offers nothing: only the first hopper takes items in.
    const second = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [m.executor('second')] } });
    apps.push(second);
    return second;
  } };
}

describe('several hoppers on one database (issue #1662)', () => {
  it('the other hopper leaves a running job alone, and takes it over once its hopper stops: the task is sent once', async () => {
    const { m, first, start } = await twoHoppers(1);
    const job = await first.pull({}, { executor: 'pane' });
    await first.waitForStatus(job.id, 'running');
    await waitFor(() => m.sent.length === 1, { what: 'the task sent into the pane' });
    const laneId = (await first.job(job.id)).laneId;

    const second = await start();
    // Its start and its ticks leave the job, and its lane, to the first hopper.
    await new Promise((r) => setTimeout(r, 1000));
    expect((await second.job(job.id))).toMatchObject({ status: 'running', laneId });
    expect(eventsOf(second, 'job.requeued').filter((e) => e.jobId === job.id)).toEqual([]);
    expect(eventsOf(second, 'lane.closed').filter((e) => e.laneId === laneId)).toEqual([]);
    expect(m.reattached).toEqual([]);

    await first.stop();
    apps.splice(apps.indexOf(first), 1);
    await waitFor(() => m.reattached.length === 1, { what: 'the second hopper to reattach the job', timeoutMs: 8000 });
    expect(m.reattached).toEqual([{ jobId: job.id, by: 'second' }]);
    const reattached = eventsOf(second, 'job.reattached').filter((e) => e.jobId === job.id);
    expect(reattached.map((e) => e.data.reason)).toEqual(['its hopper stopped']);

    m.panes.get(job.id)!.end();
    expect((await second.waitForStatus(job.id, 'finished', 8000)).attempts).toBe(1);
    expect(m.sent).toEqual([{ jobId: job.id, by: 'first' }]);
  });

  it('two hoppers deciding at once claim each job once: each task is sent once', async () => {
    const { m, first, start } = await twoHoppers(4);
    await start();
    const jobs = [];
    for (let i = 0; i < 4; i += 1) jobs.push(await first.pull({}, { executor: 'pane' }));
    await waitFor(() => m.sent.length === 4, { what: 'four tasks sent', timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 500));
    expect(m.sent.map((s) => s.jobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    for (const j of jobs) {
      expect((await first.job(j.id)).attempts).toBe(1);
      m.panes.get(j.id)!.end();
    }
    for (const j of jobs) await first.waitForStatus(j.id, 'finished', 8000);
    expect(m.sent).toHaveLength(4);
  });
});
