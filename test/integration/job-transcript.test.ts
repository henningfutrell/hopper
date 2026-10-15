// Issue #1169 part 4: a person reads a job's transcript — its agent session as the latest checkpoint keeps it, scrubbed —
// a page of turns at a time, newest first, through the UI session. Access decides as for the job's terminal: the
// transcript is what the job's pane showed. Real daemon; OpenFGA is the double at its port.
//
// Feature: the job's transcript
//   Scenario: a person reads the newest turns, then the turns before them
//   Scenario: no transcript without a kept session, a job, or Access
//   Scenario: a fresh read of a running job takes a checkpoint first, at most once a minute
//   Scenario: a fresh read whose checkpoint fails answers the kept session and says why
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture } from '../../src/domain/types.ts';
import type { JobTranscript } from '../../src/domain/transcript.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

async function boot(fga = createFakeAuthorizationServer()): Promise<{ a: TestApp; fga: FakeAuthorizationServer }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), plugins: { machines: lanes(1) }, seams: { levels: [], authorizationServer: fga } });
  apps.push(a);
  return { a, fga };
}

const AT = '2026-10-14T12:00:00.000Z';
const session = Array.from({ length: 3 }, (_, i) => [
  JSON.stringify({ type: 'user', timestamp: AT, message: { role: 'user', content: `prompt ${i}` } }),
  JSON.stringify({ type: 'assistant', timestamp: AT, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }),
].join('\n')).join('\n');

describe('the job transcript', () => {
  it('reads the newest turns of the kept session, then the turns before them', async () => {
    const { a } = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'sleep', ms: 60_000 });
    a.user().store.checkpoints.put({ jobId: job.id, at: AT, patch: gzipSync(''), session: gzipSync(session) });

    const newest = await a.ui<JobTranscript>(`/ui/api/jobs/${job.id}/transcript`, { limit: 2 }, { token });
    expect(newest.status).toBe(200);
    expect(newest.body).toMatchObject({ jobId: job.id, checkpointAt: AT, total: 3, start: 1 });
    expect(newest.body.turns.map((t) => t.prompt)).toEqual(['prompt 1', 'prompt 2']);
    expect(newest.body.turns[1]!.parts).toEqual([{ kind: 'text', text: 'answer 2' }]);

    const before = await a.ui<JobTranscript>(`/ui/api/jobs/${job.id}/transcript`, { before: 1, limit: 2 }, { token });
    expect(before.body).toMatchObject({ total: 3, start: 0 });
    expect(before.body.turns.map((t) => t.prompt)).toEqual(['prompt 0']);
  });

  it('refuses a job with no kept session, no such job, a bad page, and a read Access denies', async () => {
    const { a, fga } = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'sleep', ms: 60_000 });
    expect((await a.ui(`/ui/api/jobs/${job.id}/transcript`, {}, { token })).status).toBe(409);
    a.user().store.checkpoints.put({ jobId: job.id, at: AT, patch: gzipSync('') });
    expect((await a.ui(`/ui/api/jobs/${job.id}/transcript`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/jobs/nope/transcript', {}, { token })).status).toBe(404);
    expect((await a.ui(`/ui/api/jobs/${job.id}/transcript`, { limit: 0 }, { token })).status).toBe(400);

    a.user().store.checkpoints.put({ jobId: job.id, at: AT, patch: gzipSync(''), session: gzipSync(session) });
    fga.reachable = false;
    const denied = await a.ui<{ error: string }>(`/ui/api/jobs/${job.id}/transcript`, {}, { token });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('answer');
  });
});

const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const capture = (text: string): CheckpointCapture => ({ taken: { base: 'b'.repeat(40), head: 'c'.repeat(40), commits: [], patch: gzipSync(''), session: gzipSync(text) } });

async function bootHerdr(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({
    dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: [{ name: 'local', plugin: 'local', options: { lanes: 1, workTree: '~/shed' } }] },
    seams: { herdr, levels: [], authorizationServer: createFakeAuthorizationServer() },
  });
  apps.push(a);
  return a;
}

async function running(a: TestApp, herdr: FakeHerdrClient): Promise<string> {
  const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} });
  await a.waitForStatus(job.id, 'running');
  await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
  return job.id;
}

describe('the live transcript of a running job', () => {
  it('takes a checkpoint first when the read asks for it fresh, at most once a minute', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [`${homedir()}/shed`], checkpoint: capture(session) });
    const a = await bootHerdr(herdr);
    const token = await a.login();
    const id = await running(a, herdr);

    const fresh = await a.ui<JobTranscript>(`/ui/api/jobs/${id}/transcript`, { fresh: true }, { token });
    expect(fresh.status).toBe(200);
    expect(herdr.checkpoints).toHaveLength(1);
    expect(fresh.body).toMatchObject({ jobId: id, checkpointAt: (await a.job(id)).checkpoint!.at, total: 3 });
    expect(fresh.body.stale).toBeUndefined();
    expect(fresh.body.turns.at(-1)!.prompt).toBe('prompt 2');

    // A second fresh read within the minute answers the checkpoint just taken.
    const again = await a.ui<JobTranscript>(`/ui/api/jobs/${id}/transcript`, { fresh: true }, { token });
    expect(again.body.checkpointAt).toBe(fresh.body.checkpointAt);
    expect(herdr.checkpoints).toHaveLength(1);
    // A read that does not ask for it fresh takes none.
    await a.ui(`/ui/api/jobs/${id}/transcript`, {}, { token });
    expect(herdr.checkpoints).toHaveLength(1);
  });

  it('answers the kept session and says why when the checkpoint cannot be taken; with none kept, 409 and why', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [`${homedir()}/shed`], checkpoint: { none: 'too large: 99 bytes compressed' } });
    const a = await bootHerdr(herdr);
    const token = await a.login();
    const id = await running(a, herdr);

    const missing = await a.ui<{ error: string }>(`/ui/api/jobs/${id}/transcript`, { fresh: true }, { token });
    expect(missing.status).toBe(409);
    expect(missing.body.error).toContain('too large');

    const OLD = '2026-10-14T11:00:00.000Z';
    a.user().store.checkpoints.put({ jobId: id, at: OLD, patch: gzipSync(''), session: gzipSync(session) });
    const stale = await a.ui<JobTranscript>(`/ui/api/jobs/${id}/transcript`, { fresh: true }, { token });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ checkpointAt: OLD, total: 3 });
    expect(stale.body.stale).toContain('too large');
  });
});
