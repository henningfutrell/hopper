import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decision, Job, Lane } from '../../src/domain/types.ts';
import { lanes as laneCount, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp;
let cleanup: () => void;

beforeEach(async () => {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: laneCount(2) } });
});
afterEach(async () => {
  await t.stop();
  cleanup();
});

const lanes = async (): Promise<Lane[]> => (await t.api('GET', '/api/machines')).body.machines[0].lanes;

describe('machines, lanes and decisions', () => {
  it('machines show the local machine with its open lanes and usage', async () => {
    const job = await t.pull({ op: 'sleep', ms: 2000 });
    await t.waitForStatus(job.id, 'running');
    const { machines } = (await t.api('GET', '/api/machines')).body;
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({ id: 'local', maxLanes: 2, online: true, executors: ['test', 'scripted'] });
    expect(machines[0].lanes).toEqual([expect.objectContaining({ state: 'busy', jobId: job.id, machineId: 'local' })]);
    expect(machines[0].usage).toEqual([expect.objectContaining({ source: 'fake', used: 0, limit: 100 })]);
  });

  it('decisions are listed newest first with inputs and reasons, and fetched by id', async () => {
    const job = await t.pull({ op: 'echo' });
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

  it('a usage hard limit closes lanes and work waits for a lane; lowering usage resumes it', async () => {
    const first = await t.pull({ op: 'echo' });
    await t.waitForStatus(first.id, 'finished');
    t.setUsage(97);
    expect((await t.api('GET', '/api/usage')).body.readings[0].used).toBe(97);
    await waitFor(async () => (await lanes()).length === 0, { what: 'lanes to close' });
    const held = await t.pull({ op: 'echo' });
    const h = await waitFor(async () => { const j = await t.job(held.id); return j.waitReason ? j : undefined; });
    expect(h.status).toBe('queued');
    expect(h.waitReason).toMatch(/usage hard limit/);
    expect((await t.events()).filter((e) => e.type === 'job.held' && e.jobId === held.id)).toEqual([]);
    t.setUsage(10);
    const done = await t.waitForStatus(held.id, 'finished');
    expect(done.holdReason).toBeUndefined();
  });

  it('an idle tick records no decision', async () => {
    const job = await t.pull({ op: 'echo' });
    await t.waitForStatus(job.id, 'finished');
    await waitFor(async () => (await lanes()).length === 0, { what: 'idle lane to close after grace' });
    const before = (await t.api('GET', '/api/decisions')).body.decisions.length;
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.api('GET', '/api/decisions')).body.decisions.length).toBe(before);
  });
});

describe('the router and approval through the UI session', () => {
  it('there is no router mode: the router reads its status only, and no route switches a mode', async () => {
    const token = await t.login();
    expect((await t.api('GET', '/api/router')).body).toEqual({ router: 'fake', plugin: 'fake', fallback: false });
    expect((await t.ui('/ui/api/router-mode', { mode: 'active' }, { token })).status).toBe(404);
    expect((await t.ui('/ui/api/jev', { mode: 'shadow' }, { token })).status).toBe(404);
    expect((await t.api('GET', '/api/health')).body).not.toHaveProperty('routerMode');
  });

  it('the UI approves a waiting job (job.approved); terminal and unknown jobs are refused', async () => {
    const token = await t.login();
    t.setUsage(100);
    const job = await t.pull({ op: 'echo' });
    const approved = await t.ui<Job>(`/ui/api/jobs/${job.id}/approve`, {}, { token });
    expect(approved.status).toBe(200);
    expect(approved.body.approved).toBe(true);
    expect((await t.events()).some((e) => e.type === 'job.approved' && e.jobId === job.id)).toBe(true);
    t.setUsage(0);
    await t.waitForStatus(job.id, 'finished');
    expect((await t.ui(`/ui/api/jobs/${job.id}/approve`, {}, { token })).status).toBe(409);
    expect((await t.ui('/ui/api/jobs/missing/approve', {}, { token })).status).toBe(404);
  });
});
