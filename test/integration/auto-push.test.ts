// Push it by itself (issue #1472 part 2, design.md "Push it by itself"): a job that ended done with work its reap kept —
// uncommitted, or commits no remote has — goes on by itself in its own session and kept work tree, told to push its work
// and open the pull request, once, with no person. The failures setting `auto.push` (default on) turns it off. Real
// daemon, real database; the fake herdr and its machine at their seams.
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { FailuresView, FailureSettings } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { jobWorktreeOf } from '../../src/executors/herdr/job-worktree.ts';
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

async function boot(herdr: FakeHerdrClient, executors: Executor[] = []): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [], executors } });
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

  it('a finished job whose agent session was not recorded goes on in a fresh session in its kept work tree', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    await a.ui<FailureSettings>('/ui/api/failures/settings', { auto: { push: false } }, { token });
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'finished', 8000);
    await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept' });
    // As a job whose session never came up to be recorded: its pane state is known, its agent session is not.
    a.user().store.jobs.update(job.id, { agentSession: undefined });
    expect((await failuresOf(a)).keptWork.find((k) => k.jobId === job.id)).toMatchObject({ actions: { push: { ok: true } } });

    await a.ui<FailureSettings>('/ui/api/failures/settings', { auto: { push: true } }, { token });
    await waitFor(() => herdr.prompts.length === 2, { what: 'the push brief sent by itself' });
    expect(herdr.agentStarts[1]!.args).not.toContain('--resume');
    const told = herdr.prompts[1]!.text;
    expect(told).toContain('Paint the shed');
    expect(told).toContain('was not pushed');
    expect(told).toContain('fresh session');
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(await continuedOf(a, job.id)).toEqual([expect.objectContaining({ data: { keptWork: true, auto: true } })]);
  });

  it('a finished job with no pane state goes on in a fresh session in the job worktree its kept work names', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE, DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    await a.ui<FailureSettings>('/ui/api/failures/settings', { auto: { push: false } }, { token });
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'finished', 8000);
    await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept' });
    // As a job whose pane state was never recorded: its work tree is known only from what its reap kept.
    const tree = jobWorktreeOf('/tmp', job.id);
    a.user().store.jobs.update(job.id, { executorState: undefined, agentSession: undefined, workTree: undefined });
    a.user().store.events.append({ type: 'job.work_kept', jobId: job.id, data: { paths: [tree, KEPT] } });
    expect((await failuresOf(a)).keptWork.find((k) => k.jobId === job.id)).toMatchObject({ actions: { push: { ok: true } } });

    await a.ui<FailureSettings>('/ui/api/failures/settings', { auto: { push: true } }, { token });
    await waitFor(() => herdr.prompts.length === 2, { what: 'the push brief sent by itself' });
    expect(herdr.agentStarts[1]!.args).not.toContain('--resume');
    const told = herdr.prompts[1]!.text;
    expect(told).toContain('Paint the shed');
    expect(told).toContain('fresh session');
    await a.waitForStatus(job.id, 'finished', 8000);
    expect((await a.job(job.id)).workTree).toBe(tree);
  });

  it('a finished job with no pane state whose kept work names no job worktree: Push it is refused, and says why', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE], reapKeeps: [KEPT] });
    const a = await boot(herdr);
    const token = await a.login();
    await a.ui<FailureSettings>('/ui/api/failures/settings', { auto: { push: false } }, { token });
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'finished', 8000);
    await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept' });
    a.user().store.jobs.update(job.id, { executorState: undefined });
    expect((await failuresOf(a)).keptWork.find((k) => k.jobId === job.id)!.actions.push).toEqual({ ok: false, why: expect.stringContaining('its work tree cannot reopen') });
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

  // As a print-mode agent's (issue #1472 part 2): no pane to park, its work tree in its state; Push it starts a fresh turn there.
  const printLike = (name: string, reopensKept: boolean) => {
    const resumed: string[] = [];
    let reaps = 0;
    const executor: Executor = {
      name, idempotent: false, validate: () => null, ...(reopensKept ? { reopensKept: true as const } : {}),
      async run(ctx) { ctx.saveState({ cwd: '/tmp' }); return { kind: 'finished', result: {} }; },
      async resume(_ctx, answer) { resumed.push(answer); return { kind: 'finished', result: {} }; },
      async cleanup() { reaps += 1; return { kept: reaps === 1 ? [KEPT] : [] }; },
    };
    return { executor, resumed };
  };

  it('a finished job of an executor that cannot park, but reopens its kept work tree, goes on there in a fresh turn', { timeout: 30_000 }, async () => {
    const p = printLike('print-like', true);
    const a = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }), [p.executor]);
    const job = await a.pull({}, { executor: 'print-like', prompt: 'Paint the shed' });
    await waitFor(() => p.resumed.length === 1, { what: 'the push brief sent by itself' });
    expect(p.resumed[0]).toContain('was not pushed');
    expect(p.resumed[0]).toContain('fresh session');
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(await continuedOf(a, job.id)).toEqual([expect.objectContaining({ data: { keptWork: true, auto: true } })]);
  });

  it('an executor that neither parks nor reopens: Push it is refused, and says why', { timeout: 30_000 }, async () => {
    const p = printLike('plain', false);
    const a = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }), [p.executor]);
    const job = await a.pull({}, { executor: 'plain', prompt: 'Paint the shed' });
    await a.waitForStatus(job.id, 'finished', 8000);
    const kept = await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept' });
    expect(kept.actions.push).toEqual({ ok: false, why: expect.stringContaining('its work tree cannot reopen') });
    expect(p.resumed).toEqual([]);
  });
});
