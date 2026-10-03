import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decision, DomainEvent, Job, Lane } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp;
let cleanup: () => void;

beforeEach(async () => {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env: { JOB_HOPPER_LOCAL_LANES: '2' } });
});
afterEach(async () => {
  await t.stop();
  cleanup();
});

const lanes = async (): Promise<Lane[]> => (await t.api('GET', '/api/machines')).body.machines[0].lanes;

describe('machines, lanes and decisions', () => {
  it('machines show the local machine with its open lanes and usage', async () => {
    const job = await t.push({ executor: 'test', payload: { op: 'sleep', ms: 2000 } });
    await t.waitForStatus(job.id, 'running');
    const { machines } = (await t.api('GET', '/api/machines')).body;
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({ id: 'local', maxLanes: 2, online: true, executors: ['test'] });
    expect(machines[0].lanes).toEqual([expect.objectContaining({ state: 'busy', jobId: job.id, machineId: 'local' })]);
    expect(machines[0].usage).toEqual([expect.objectContaining({ source: 'fake', used: 0, limit: 100 })]);
  });

  it('decisions are listed newest first with inputs and reasons, and fetched by id', async () => {
    const job = await t.push({ executor: 'test', payload: { op: 'echo' } });
    await t.waitForStatus(job.id, 'finished');
    const { decisions } = (await t.api<{ decisions: Decision[] }>('GET', '/api/decisions?limit=50')).body;
    expect(decisions.length).toBeGreaterThan(0);
    const starting = decisions.find((d) => d.start.some((s) => s.jobId === job.id))!;
    expect(starting.reasons.length).toBeGreaterThan(0);
    expect(starting.inputs.waiting.map((j) => j.id)).toContain(job.id);
    expect(starting.inputs.policy).toMatchObject({ softLimit: 0.7, hardLimit: 0.95 });
    const one = await t.api<Decision>('GET', `/api/decisions/${starting.id}`);
    expect(one.body.id).toBe(starting.id);
    expect((await t.api('GET', '/api/decisions/missing')).status).toBe(404);
    const ats = decisions.map((d) => d.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it('a usage hard limit closes lanes and holds work; lowering usage resumes it', async () => {
    const first = await t.push({ executor: 'test', payload: { op: 'echo' } });
    await t.waitForStatus(first.id, 'finished');
    const put = await t.api('PUT', '/api/usage/fake', { used: 97, limit: 100 });
    expect(put.status).toBe(200);
    expect(put.body.readings).toEqual([expect.objectContaining({ used: 97, limit: 100 })]);
    expect((await t.api('GET', '/api/usage')).body.readings[0].used).toBe(97);
    await waitFor(async () => (await lanes()).length === 0, { what: 'lanes to close' });
    const held = await t.push({ executor: 'test', payload: { op: 'echo' } });
    const h = await t.waitForStatus(held.id, 'held');
    expect(h.holdReason).toMatch(/usage hard limit/);
    const heldEvents = (await t.events()).filter((e) => e.type === 'job.held' && e.jobId === held.id);
    expect(heldEvents).toHaveLength(1);
    await t.api('PUT', '/api/usage/fake', { used: 10, limit: 100 });
    const done = await t.waitForStatus(held.id, 'finished');
    expect(done.holdReason).toBeUndefined();
    expect((await t.api('PUT', '/api/usage/fake', { used: 'x' })).status).toBe(400);
  });

  it('an idle tick records no decision', async () => {
    const job = await t.push({ executor: 'test', payload: { op: 'echo' } });
    await t.waitForStatus(job.id, 'finished');
    await waitFor(async () => (await lanes()).length === 0, { what: 'idle lane to close after grace' });
    const before = (await t.api('GET', '/api/decisions')).body.decisions.length;
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.api('GET', '/api/decisions')).body.decisions.length).toBe(before);
  });
});

describe('Jev through the API', () => {
  const madeFor = (events: DomainEvent[], jobId: string) => events.filter((e) => e.type === 'decision.made'
    && (e.data.divergences as { jobId: string }[]).some((d) => d.jobId === jobId));

  it('shadow mode runs an account job and records the divergence', async () => {
    await t.api('PUT', '/api/usage/fake', { used: 100, limit: 100 });
    const job = await t.push({ executor: 'test', payload: { op: 'echo' }, kind: 'account', goal: 'change password' });
    const advised = await waitFor(async () => (await t.job(job.id)).jevAdvice);
    expect(advised.action).toBe('ask_human');
    const prioritized = (await t.events()).find((e) => e.type === 'job.prioritized' && e.jobId === job.id)!;
    expect(prioritized.data).toMatchObject({ mode: 'shadow', advice: { action: 'ask_human' } });
    await t.api('PUT', '/api/usage/fake', { used: 0, limit: 100 });
    await t.waitForStatus(job.id, 'finished');
    const made = madeFor(await t.events(), job.id);
    expect(made.length).toBeGreaterThan(0);
    expect(made[0]!.data.divergences).toEqual([expect.objectContaining({ advice: 'ask_human', native: 'start', withJev: 'hold' })]);
  });

  it('active mode holds an account job until approved; the switch emits jev.mode_changed', async () => {
    expect((await t.api('GET', '/api/jev')).body).toEqual({ mode: 'shadow', advisor: 'fake' });
    const put = await t.api('PUT', '/api/jev', { mode: 'active' });
    expect(put.body).toEqual({ mode: 'active', advisor: 'fake' });
    expect((await t.api('PUT', '/api/jev', { mode: 'loud' })).status).toBe(400);
    const changed = (await t.events()).filter((e) => e.type === 'jev.mode_changed');
    expect(changed).toEqual([expect.objectContaining({ data: { from: 'shadow', to: 'active' } })]);
    expect((await t.api('GET', '/api/health')).body.jevMode).toBe('active');

    const job = await t.push({ executor: 'test', payload: { op: 'echo' }, kind: 'account' });
    const held = await waitFor(async () => {
      const j = await t.job(job.id);
      return j.holdReason === 'jev ask_human: awaiting approval' ? j : undefined;
    });
    expect(held.status).toBe('held');
    const approved = await t.api<Job>('POST', `/api/jobs/${job.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.approved).toBe(true);
    await t.waitForStatus(job.id, 'finished');
    expect((await t.events()).some((e) => e.type === 'job.approved' && e.jobId === job.id)).toBe(true);
  });

  it('active mode boosts cheap jobs ahead in the queue', async () => {
    await t.api('PUT', '/api/jev', { mode: 'active' });
    await t.api('PUT', '/api/usage/fake', { used: 100, limit: 100 });
    const plain = await t.push({ executor: 'test', payload: { op: 'echo' }, priority: 55 });
    const lookup = await t.push({ executor: 'test', payload: { op: 'echo' }, priority: 50, kind: 'lookup' });
    await waitFor(async () => (await t.job(lookup.id)).jevAdvice && (await t.job(plain.id)).jevAdvice);
    const queue = (await t.api('GET', '/api/queue')).body;
    expect(queue.waiting.map((j: Job) => j.id)).toEqual([lookup.id, plain.id]);
  });
});
