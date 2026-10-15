// Issue #1169 part 4: a person reads a job's transcript — its agent session as the latest checkpoint keeps it, scrubbed —
// a page of turns at a time, newest first, through the UI session. Access decides as for the job's terminal: the
// transcript is what the job's pane showed. Real daemon; OpenFGA is the double at its port.
//
// Feature: the job's transcript
//   Scenario: a person reads the newest turns, then the turns before them
//   Scenario: no transcript without a kept session, a job, or Access
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobTranscript } from '../../src/domain/transcript.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createManualSource } from '../support/manual-source.ts';

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
