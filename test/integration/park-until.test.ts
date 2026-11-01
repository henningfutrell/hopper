// Issue #2890: a person parks a job with a park condition, and the hopper picks it up by itself once the condition holds:
// `job.unparked` `by` `hopper`, with the condition and what fired it, and the job is told why it resumes. A condition the
// hopper cannot read is refused. Real daemon over the fake herdr, as park.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(2) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

const park = (a: TestApp, token: string, id: string, body: Record<string, string>) => a.ui<Job>(`/ui/api/jobs/${id}/park`, body, { token });

describe('a park condition (issue #2890)', () => {
  it('the hopper picks the job up once the job it names ends, and tells it why', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    const other = await a.pull({ op: 'sleep', ms: 1500 });
    await a.waitForStatus(other.id, 'running');

    expect((await park(a, token, job.id, { reason: 'builds on the other', until: `job ${other.id}` })).status).toBe(200);
    const parked = await a.waitForStatus(job.id, 'parked');
    expect(parked.parked).toMatchObject({ from: 'running', reason: 'builds on the other', until: { kind: 'job', jobId: other.id } });
    expect((await a.events('types=job.parked'))[0]!.data).toMatchObject({ until: `job ${other.id} ends` });

    await a.waitForStatus(other.id, 'finished', 10000);
    const done = await a.waitForStatus(job.id, 'finished', 15000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed blue.') });
    expect((await a.events('types=job.unparked')).find((e) => e.jobId === job.id)!.data)
      .toEqual({ to: 'queued', by: 'hopper', until: `job ${other.id} ends`, fired: `job ${other.id} finished` });
    expect(herdr.prompts[1]!.text).toContain(`This job was parked until job ${other.id} ends. That happened: job ${other.id} finished.`);
  }, 30000);

  it('refuses a condition it cannot read, and parks nothing', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    const r = await park(a, token, job.id, { until: 'when it is ready' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/names no condition/);
    // The job has no repository: `#6` names none.
    expect((await park(a, token, job.id, { until: '#6' })).status).toBe(400);
    expect((await a.job(job.id)).status).toBe('running');
  });
});
