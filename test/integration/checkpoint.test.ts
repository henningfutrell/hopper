// Checkpoints and resume elsewhere (issue #921): while a job runs, the hopper copies its agent session and its work not
// pushed from its machine, scrubbed, and keeps the latest; a parked job with one may be picked up to resume elsewhere —
// not pinned to its machine, its claim makes a new job worktree, restores the checkpoint in it from the hopper, resumes
// the same agent session and tells it that it moved. Real daemon over the fake herdr, as park.test.ts.
import { homedir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} };
const GH = `ghp_${'a1B2'.repeat(9)}`;
const BASE = 'b'.repeat(40);
/** The machine's work tree, a repository's top, so each job gets a worktree of it. */
const tree = (): string => `${homedir()}/shed`;

const CAPTURE: CheckpointCapture = {
  taken: {
    branch: 'hopper/shed', base: BASE, head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'],
    patch: gzipSync(`diff --git a/shed.txt b/shed.txt\n+++ b/shed.txt\n+colour=blue\n+GH_TOKEN=${GH}\n`),
    session: gzipSync(`${JSON.stringify({ type: 'user', message: `use ${GH}` })}\n`),
  },
};

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: [{ name: 'local', plugin: 'local', options: { lanes: 1, workTree: '~/shed' } }] }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const park = (a: TestApp, token: string, id: string) => a.ui<Job>(`/ui/api/jobs/${id}/park`, {}, { token });
const requeue = (a: TestApp, token: string, id: string, body: Record<string, unknown> = {}) => a.ui<Job>(`/ui/api/jobs/${id}/requeue`, body, { token });

async function runningJob(a: TestApp, herdr: FakeHerdrClient): Promise<Job> {
  const job = await a.pull({}, item);
  await a.waitForStatus(job.id, 'running');
  await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
  return a.job(job.id);
}

async function parkedWithCheckpoint(a: TestApp, herdr: FakeHerdrClient, token: string): Promise<Job> {
  const job = await runningJob(a, herdr);
  expect((await park(a, token, job.id)).status).toBe(200);
  await a.waitForStatus(job.id, 'parked');
  await waitFor(async () => (await a.job(job.id)).checkpoint !== undefined, { what: 'the checkpoint at the park' });
  return a.job(job.id);
}

describe('taking a checkpoint', () => {
  it('reads the job\'s worktree and session on its machine, scrubs them, and keeps the latest', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    const job = await runningJob(a, herdr);

    const k = await a.user().engine.checkpoints.take(job.id);
    expect(k).toMatchObject({ machineId: 'local', branch: 'hopper/shed', base: BASE, commits: ['ccccccc Sand the shed'], session: true });
    expect(herdr.checkpoints).toEqual([{ jobId: job.id, worktree: `${tree()}/.worktrees/shed/${job.id}`, session: job.agentSession }]);
    expect((await a.job(job.id)).checkpoint).toEqual(k);
    const kept = a.user().store.checkpoints.get(job.id)!;
    const patch = gunzipSync(kept.patch).toString('utf8');
    expect(patch).toContain('+colour=blue');
    expect(patch).not.toContain(GH);
    expect(gunzipSync(kept.session!).toString('utf8')).not.toContain(GH);
    const [event] = await a.events('types=job.checkpointed');
    expect(event!.data).toEqual({ machineId: 'local', bytes: kept.patch.length + kept.session!.length, session: true, commits: 1 });

    // A pass takes none of a job checkpointed less than ten minutes ago.
    await a.user().engine.checkpoints.run();
    expect(herdr.checkpoints).toHaveLength(1);
  });

  it('takes no new checkpoint when nothing changed since the last one (issue #1975)', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    const job = await runningJob(a, herdr);

    const k = await a.user().engine.checkpoints.take(job.id);
    expect(await a.user().engine.checkpoints.take(job.id)).toEqual(k);
    expect(herdr.checkpoints).toHaveLength(2);
    expect((await a.job(job.id)).checkpoint).toEqual(k);
    expect(await a.events('types=job.checkpointed')).toHaveLength(1);
  });

  it('says why it took none, and keeps nothing', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: { none: 'too large: 99 bytes compressed' } });
    const a = await boot(herdr);
    const job = await runningJob(a, herdr);
    expect(await a.user().engine.checkpoints.take(job.id)).toBe('too large: 99 bytes compressed');
    expect((await a.job(job.id)).checkpoint).toBeUndefined();
    expect(a.user().store.checkpoints.get(job.id)).toBeUndefined();
  });

  it('says what its machine said when the script fails there, never that the machine could not be reached (issue #1353)', async () => {
    const said = 'the checkpoint on local did not finish (exit 2): not the job\'s worktree: /w/elsewhere';
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: new Error(said) });
    const a = await boot(herdr);
    const job = await runningJob(a, herdr);
    const got = await a.user().engine.checkpoints.take(job.id);
    expect(got).toContain(said);
    expect(got).not.toContain('could not be reached');
    expect((await a.job(job.id)).checkpoint).toBeUndefined();
  });
});

describe('resuming elsewhere', () => {
  it('unpins the parked job; its claim restores the checkpoint in a new worktree and resumes the same session, told it moved', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    const token = await a.login();
    const parked = await parkedWithCheckpoint(a, herdr, token);
    expect(parked.resumeOn).toBe('local');

    const r = await requeue(a, token, parked.id, { elsewhere: true });
    expect(r.status).toBe(200);
    expect(r.body.resumeOn).toBeUndefined();
    expect(r.body.parked?.elsewhere).toMatchObject({ checkpointAt: parked.checkpoint!.at, from: 'local' });
    const done = await a.waitForStatus(parked.id, 'finished', 8000);

    expect(herdr.restores).toHaveLength(1);
    expect(herdr.restores[0]).toContain(`'${BASE}' 'hopper/shed' '${parked.agentSession}' '1'`);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', parked.agentSession!]));
    const told = herdr.prompts[1]!.text;
    expect(told).toContain('resumes now on another machine');
    expect(told).toContain('- ccccccc Sand the shed');
    expect(told).toContain('on branch hopper/shed');
    expect(done.parked).toBeUndefined();
    expect((await a.events('types=job.unparked'))[0]!.data).toEqual({ to: 'queued', elsewhere: true, by: expect.any(String), via: 'ui' });
  });

  it('a head the hopper pushed for the job (issue #2459): restored on its branch at it, and not told its commits were not pushed', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await runningJob(a, herdr);
    a.user().store.events.append({ type: 'github_proxy.done', jobId: job.id, data: { requestId: 'r1', op: 'git.push', repo: 'octo/shed', refs: ['refs/heads/hopper/shed'], heads: ['c'.repeat(40)] } });
    expect((await park(a, token, job.id)).status).toBe(200);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(async () => (await a.job(job.id)).checkpoint !== undefined, { what: 'the checkpoint at the park' });
    expect((await a.job(job.id)).checkpoint).toMatchObject({ base: BASE, head: 'c'.repeat(40), pushedTo: 'hopper/shed' });

    expect((await requeue(a, token, job.id, { elsewhere: true })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.restores[0]).toContain(`'${BASE}' 'hopper/shed' '${job.agentSession}' '1' '${'c'.repeat(40)}'`);
    const told = herdr.prompts[1]!.text;
    expect(told).toContain(`commit ${'c'.repeat(12)} on branch hopper/shed, which the remote holds`);
    expect(told).not.toContain('were not pushed');
  });

  it('fails the job, saying why, when the checkpoint cannot be restored', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE], repositories: [tree()], checkpoint: CAPTURE, restore: 'failed' });
    const a = await boot(herdr);
    const token = await a.login();
    const parked = await parkedWithCheckpoint(a, herdr, token);
    await requeue(a, token, parked.id, { elsewhere: true });
    const failed = await a.waitForStatus(parked.id, 'failed', 8000);
    expect(failed.error).toContain('the checkpoint could not be restored on local');
    expect(herdr.agentStarts).toHaveLength(1);
  });

  it('is refused for a parked job with no checkpoint, which still picks up on its own machine', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE], repositories: [tree()] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await runningJob(a, herdr);
    await park(a, token, job.id);
    await a.waitForStatus(job.id, 'parked');
    const r = await requeue(a, token, job.id, { elsewhere: true });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('no checkpoint');
    expect((await requeue(a, token, job.id)).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
  });

  it('serves the checkpoint\'s parts only to the job itself, and only while it resumes elsewhere', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, WORKING], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    const token = await a.login();
    const parked = await parkedWithCheckpoint(a, herdr, token);
    const proxy = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, parked.id);
    const get = (part: string, bearer = proxy) => fetch(`${a.url}/job/checkpoint/${part}`, { headers: { authorization: `Bearer ${bearer}` } });

    // Parked, it is not resuming elsewhere: nothing is served.
    expect((await get('patch')).status).toBe(409);
    await requeue(a, token, parked.id, { elsewhere: true });
    await waitFor(() => herdr.prompts.length > 1, { what: 'the resumed session told it moved' });
    const patch = await get('patch');
    expect(patch.status).toBe(200);
    expect(await patch.text()).toContain('+colour=blue');
    expect(await (await get('session')).text()).toContain('"type":"user"');
    expect((await get('other')).status).toBe(404);
    expect((await get('patch', `${proxy.slice(0, -2)}xx`)).status).toBe(401);
  });
});

describe('a checkpoint at a missed heartbeat (issue #1569)', () => {
  it('is taken at once when a watch of the job\'s pane fails, not ten minutes later, and at most once a minute', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    const job = await runningJob(a, herdr);
    expect(herdr.checkpoints).toHaveLength(0);

    herdr.failNext('getAgent', 'server_error');
    await waitFor(() => herdr.checkpoints.length === 1, { what: 'the checkpoint at the missed heartbeat' });
    await waitFor(async () => (await a.job(job.id)).checkpoint !== undefined, { what: 'the checkpoint kept' });

    // A second missed heartbeat within the minute takes none; the job works on.
    herdr.failNext('getAgent', 'server_error');
    await new Promise((r) => setTimeout(r, 300));
    expect(herdr.checkpoints).toHaveLength(1);
    expect((await a.job(job.id)).status).toBe('running');
  });

  it('is taken at once when a PING of its machine\'s link is not answered in time', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    const job = await runningJob(a, herdr);
    herdr.lateLink();
    await waitFor(() => herdr.checkpoints.length === 1, { what: 'the checkpoint at the late PING' });
    expect(herdr.checkpoints[0]!.jobId).toBe(job.id);
  });

  it('is not taken when the watch fails on a link that is down: the machine cannot be read', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: CAPTURE });
    const a = await boot(herdr);
    await runningJob(a, herdr);
    herdr.setUnreachable(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(herdr.checkpoints).toHaveLength(0);
  });
});
