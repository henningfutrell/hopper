// Work not pushed (issue #1010): a job that ended with work its reap kept — uncommitted or not pushed — shows in Failures
// with two ways out: Push it (the failed job goes on in its own session and kept work tree, told to push its work and open
// the pull request) and Discard (its scratch dir removed on its machine, whatever it holds). Real daemon, real database;
// the fake herdr and its machine at their seams.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { pushIt } from '../support/give-back.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const FAIL = { output: ['● The paint ran out halfway.', '  HOPPER_FAILED the paint ran out'] };
const DONE = { output: ['● Pushed the work and opened the pull request.', '  HOPPER_DONE'] };
/** A turn that never ends by itself: the job is mid-turn when it is cancelled. */
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const herdrItem = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const KEPT = '/tmp/.worktrees/@scratch/kept/repo';

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

    // Answered before its source takes the item back (issue #1194): the job, once it goes on.
    const r = await pushIt(a, job.id, { note: 'The branch is shed-blue.' }, token);
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ id: job.id, resumeOn: 'local' });
    // Out of the list once it goes on.
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
    // Its own scratch dir, as the reap at its end named it.
    const scratch = herdr.reaps.find((x) => x.jobId === job.id && x.scratch)!.scratch!;

    const r = await a.ui<{ jobId: string; paths: string[] }>(`/ui/api/failures/kept-work/${job.id}/discard`, {}, { token });
    expect(r.status).toBe(200);
    // The removal on the machine runs after the answer (issue #1194).
    const removed = await waitFor(async () => { const es = (await a.events('types=job.work_removed')).filter((e) => e.jobId === job.id); return es.length ? es : undefined; }, { what: 'its work removed' });
    expect(herdr.reaps.at(-1)).toEqual({ jobId: job.id, scratch, discard: true });
    expect(removed).toEqual([expect.objectContaining({ data: expect.objectContaining({ paths: [scratch], discarded: true, via: 'ui' }) })]);
    expect((await failuresOf(a)).keptWork.find((k) => k.jobId === job.id)).toBeUndefined();
    // Nothing kept now: a second discard is refused, and says why.
    const again = await a.ui<{ error: string }>(`/ui/api/failures/kept-work/${job.id}/discard`, {}, { token });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('has no work kept');
  });

  it('a finished job whose work was kept: Push it goes on in its own session, told to push', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    // A person's Push it: the hopper's own (issue #1472, auto-push.test.ts) is off.
    expect((await a.ui('/ui/api/failures/settings', { auto: { push: false } }, { token })).status).toBe(200);
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'finished', 8000);
    const session = (await a.job(job.id)).agentSession!;
    expect(await keptOf(a, job.id)).toMatchObject({ status: 'finished', actions: { push: { ok: true } } });

    const r = await pushIt(a, job.id, {}, token);
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ id: job.id, resumeOn: 'local' });
    await waitFor(() => herdr.prompts.length === 2, { what: 'the push brief sent' });
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    expect(herdr.prompts[1]!.text).toContain('was not pushed');
    await a.waitForStatus(job.id, 'finished', 8000);
    expect((await a.events('types=job.continued')).filter((e) => e.jobId === job.id)).toEqual([expect.objectContaining({ data: { keptWork: true } })]);

    // Its reap kept the same work again (issue #1470: a clone of another repository, whose push the hopper refuses):
    // Push it is not offered again, so the job is not asked the same thing in a loop. Discard still is.
    const again = await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id && !k.actions.push.ok), { what: 'its work kept again' });
    expect(again.actions.discard).toEqual({ ok: true });
    expect(again.actions.push).toMatchObject({ ok: false, why: expect.stringContaining('kept the same work') });
    const refused = await pushIt(a, job.id, {}, token);
    expect(refused.status).toBe(409);
    expect(herdr.prompts.length).toBe(2);
  });

  it('a cancelled job whose work was kept: Push it goes on in its own session, told to push', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'running', 8000);
    await waitFor(() => herdr.prompts.length === 1, { what: 'the task sent' });
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'cancelled', 8000);
    const session = (await a.job(job.id)).agentSession!;
    expect(await keptOf(a, job.id)).toMatchObject({ status: 'cancelled', actions: { push: { ok: true } } });

    const r = await pushIt(a, job.id, {}, token);
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ id: job.id });
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    expect(herdr.prompts[1]!.text).toContain('was not pushed');
  });
});
