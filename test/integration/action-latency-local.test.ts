// The latency budget of the acts on a job that are the hopper's own (issue #1194, part 5): Answer, End wait and Pick up
// record and answer within the budget; the job's machine is told after. Real daemon, real database; the fake herdr.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { BUDGET_MS } from '../support/latency.ts';
import { waitFor } from '../support/wait.ts';

const ASK = { output: ['● Which colour should the shed be?', '  HOPPER_QUESTION'] };
const WAIT = {
  output: ['● The fix is committed. The push needs write access.', '  HOPPER_WAITING', '  for: write access to the repository', '  until: a background poll of the push'],
  background: { work: '1 shell', polls: 1_000_000 },
};
/** A turn that never ends by itself: the job is mid-turn when it is parked. */
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function timed<T>(act: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t0 = performance.now();
  const r = await act();
  return { r, ms: performance.now() - t0 };
}

async function boot(herdr: FakeHerdrClient) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return { a, token: await a.login() };
}

describe('Answer, End wait and Pick up answer within the budget (issue #1194)', () => {
  it('Answer: recorded and answered at once; the job is told after, and finishes', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const { a, token } = await boot(herdr);
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.status === 'open', 8000);
    const { r, ms } = await timed(() => a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token }));
    expect(r.status).toBe(200);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect((await a.questionsOf(job.id))[0]).toMatchObject({ status: 'answered', answer: 'Blue.' });
    await a.waitForStatus(job.id, 'finished', 8000);
  });

  it('End wait: recorded and answered at once; the job is told after, and finishes', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const { a, token } = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'waiting_on', 8000);
    const { r, ms } = await timed(() => a.ui(`/ui/api/jobs/${job.id}/end-wait`, { note: 'Granted.' }, { token }));
    expect(r.status).toBe(200);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect((await a.events('types=job.wait_ended')).filter((e) => e.jobId === job.id)).toHaveLength(1);
    await a.waitForStatus(job.id, 'finished', 8000);
  });

  it('Pick up: recorded and answered at once; the job goes back to its machine after', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE] });
    const { a, token } = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running', 8000);
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    expect((await a.ui(`/ui/api/jobs/${job.id}/park`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'parked');
    const { r, ms } = await timed(() => a.ui<Job>(`/ui/api/jobs/${job.id}/requeue`, {}, { token }));
    expect(r.status).toBe(200);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(r.body.status).not.toBe('parked');
    await a.waitForStatus(job.id, 'finished', 8000);
  });
});
