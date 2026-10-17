// Push it by itself (issue #1472 part 2, design.md "Push it by itself"): a job that ended done with work its reap kept —
// uncommitted, or commits no remote has — goes on by itself in its own session and kept work tree, told to push its work
// and open the pull request, once, with no person. The failures setting `auto.push` (default on) turns it off. Real
// daemon, real database; the fake herdr and its machine at their seams.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, FailureSettings } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const DONE = { output: ['● Painted the shed.', '  HOPPER_DONE'] };
const FAIL = { output: ['● The paint ran out halfway.', '  HOPPER_FAILED the paint ran out'] };
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
const continuedOf = async (a: TestApp, jobId: string) => (await a.events('types=job.continued')).filter((e) => e.jobId === jobId);

describe('Push it by itself (issue #1472)', () => {
  it('a finished job whose work was kept goes on by itself, told to push; once only', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'finished', 8000);
    const session = (await a.job(job.id)).agentSession!;

    await waitFor(() => herdr.prompts.length === 2, { what: 'the push brief sent by itself' });
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    const told = herdr.prompts[1]!.text;
    expect(told).toContain('was not pushed');
    expect(told).toContain('The hopper asks you');
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(await continuedOf(a, job.id)).toEqual([expect.objectContaining({ data: { keptWork: true, auto: true } })]);

    // Its reap kept the same work again: it stays for a person, and is not pushed by itself again.
    await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept again' });
    await new Promise((r) => setTimeout(r, 500));
    expect(herdr.prompts.length).toBe(2);
    expect(await continuedOf(a, job.id)).toHaveLength(1);
  });

  it('with auto.push off, the kept work waits for a person', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    const s = await a.ui<FailureSettings>('/ui/api/failures/settings', { auto: { push: false } }, { token });
    expect(s.status).toBe(200);
    expect(s.body.auto.push).toBe(false);
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept' })).toMatchObject({ actions: { push: { ok: true } } });
    await new Promise((r) => setTimeout(r, 500));
    expect(herdr.prompts.length).toBe(1);
    expect(await continuedOf(a, job.id)).toEqual([]);
  });

  it('a failed job whose work was kept is not pushed by itself: its failure goes to the assessor and a person', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [FAIL, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'failed', 8000);
    await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept' });
    await new Promise((r) => setTimeout(r, 500));
    expect((await continuedOf(a, job.id)).filter((e) => (e.data as { keptWork?: true }).keptWork)).toEqual([]);
  });
});
