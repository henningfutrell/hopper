// Work not pushed (issue #1010): a job that ended with work its reap kept — uncommitted or not pushed — shows in Failures
// with two ways out: Push it (the failed job goes on in its own session and kept work tree, told to push its work and open
// the pull request) and Discard (its scratch dir removed on its machine, whatever it holds). Real daemon, real database;
// the fake herdr and its machine at their seams.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const FAIL = { output: ['● The paint ran out halfway.', '  HOPPER_FAILED the paint ran out'] };
const DONE = { output: ['● Pushed the work and opened the pull request.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const herdrItem = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const KEPT = '/tmp/.hopper-scratch/kept/repo';

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const keptOf = async (a: TestApp, jobId: string) =>
  waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === jobId), { what: `job ${jobId}'s work kept` });

describe('Work not pushed (issue #1010)', () => {
  it('lists a failed job whose work was kept; Push it goes on in its own session, told to push, and its hand-off closes', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [FAIL, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'failed', 8000);
    const session = (await a.job(job.id)).agentSession!;
    const kept = await keptOf(a, job.id);
    expect(kept).toMatchObject({ jobId: job.id, paths: [KEPT], status: 'failed', machineId: 'local', actions: { push: { ok: true }, discard: { ok: true } } });
    // Counted in the Failures section, as a thing that waits on a person.
    const sections = (await a.api<{ sections: { kind: string; waiting: number }[] }>('GET', '/api/sections')).body.sections;
    expect(sections.find((s) => s.kind === 'failures')!.waiting).toBeGreaterThanOrEqual(1);

    const r = await a.ui<{ job: Job; error?: string }>(`/ui/api/failures/kept-work/${job.id}/push`, { note: 'The branch is shed-blue.' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ id: job.id, status: 'queued', resumeOn: 'local' });
    // Out of the list at once: the job goes on.
    expect((await failuresOf(a)).keptWork.find((k) => k.jobId === job.id)).toBeUndefined();

    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    const told = herdr.prompts[1]!.text;
    expect(told).toContain('was not pushed');
    expect(told).toContain('The branch is shed-blue.');
    // A hand-off was open for it: Push it resolved it as Continue.
    const closed = await waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === job.id && h.status === 'closed'), { what: 'its hand-off closed' });
    expect(closed).toMatchObject({ end: 'continued', resolution: { action: 'continue', resumed: true } });
  });

  it('Discard removes its scratch dir on its machine, recorded with who; then it is gone from the list', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [FAIL], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'failed', 8000);
    await keptOf(a, job.id);

    const r = await a.ui<{ jobId: string; paths: string[] }>(`/ui/api/failures/kept-work/${job.id}/discard`, {}, { token });
    expect(r.status).toBe(200);
    expect(herdr.reaps.at(-1)).toEqual({ jobId: job.id, scratch: `/tmp/.hopper-scratch/${job.id}`, discard: true });
    const removed = (await a.events('types=job.work_removed')).filter((e) => e.jobId === job.id);
    expect(removed).toEqual([expect.objectContaining({ data: expect.objectContaining({ paths: [`/tmp/.hopper-scratch/${job.id}`], discarded: true, via: 'ui' }) })]);
    expect((await failuresOf(a)).keptWork.find((k) => k.jobId === job.id)).toBeUndefined();
    // Nothing kept now: a second discard is refused, and says why.
    const again = await a.ui<{ error: string }>(`/ui/api/failures/kept-work/${job.id}/discard`, {}, { token });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('has no work kept');
  });
});
