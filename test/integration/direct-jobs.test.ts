// Issue #901: direct job intake. A person — or an agent with a box token a person minted — submits a job straight to the
// hopper with a title, a brief, routing labels and what they authorize; no GitHub issue is behind it. Its job runs from
// the `direct` job source, and its result and open questions read back through the API. The daemon, store and HTTP edge
// are real; OpenFGA is the in-memory double.
//
// Feature: Direct jobs
//   Scenario: a person submits a direct job, it runs, and its result reads back
//     When the person submits a direct job with labels and authorizations
//     Then its job is queued from the source direct, made from the brief, its labels on it
//     And direct_job.submitted names who submitted it and what they authorized, never the title or the brief
//     And once it finished, the direct job reads back with the job's result, and the list has it
//   Scenario: a question of a direct job reads back, and its answer resumes it
//   Scenario: an agent submits through a box token; an API token that is no box token is refused
//   Scenario: a submission with no brief, or a repository that is not owner/name, is refused, and nothing is kept
//   Scenario: Run again takes the same submission again
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import type { DirectJobView } from '../../src/domain/direct-jobs.ts';
import { rawRequest } from '../support/http.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function start() {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  apps.push(app);
  return { app, token: await app.login() };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const submission = (op: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  title: 'Unlock a sign-in', brief: `${JSON.stringify(op)}\nLook up the lockout and clear it.`, labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'], executor: 'scripted', ...more,
});
const readBack = (a: TestApp, id: string, ok: (d: DirectJobView) => boolean) => waitFor(async () => {
  const d = (await a.api<DirectJobView>('GET', `/api/direct-jobs/${id}`)).body;
  return ok(d) ? d : undefined;
}, { what: `direct job ${id}` });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
async function agent(a: TestApp, token: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await rawRequest(a.url, { method: 'POST', path: '/ui/api/direct-jobs', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
}

describe('Direct jobs (issue #901)', () => {
  it('submits a direct job; it runs from the direct source, and its result reads back', async () => {
    const { app, token } = await start();
    const r = await app.ui<{ directJob: DirectJobView; job: { id: string; source: { source: string; kind: string; key: string; labels: string[]; origin?: string } } }>('/ui/api/direct-jobs', submission({ op: 'echo', message: 'cleared' }), { token });
    expect(r.status).toBe(200);
    const { directJob, job } = r.body;
    expect(directJob).toMatchObject({ title: 'Unlock a sign-in', labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'], submittedBy: { via: 'ui' } });
    expect(job.source).toMatchObject({ source: 'direct', kind: 'direct', key: `direct:${directJob.id}`, labels: ['sme:identity'], origin: 'trusted' });
    const payload = (await app.job(job.id)).spec.payload as { prompt: string; env: Record<string, string> };
    expect(payload.prompt).toContain('Look up the lockout and clear it.');
    expect(payload.prompt).toContain('authorized by the submitter: keycloak:otp-reset');
    expect(payload.env.HOPPER_DIRECT_JOB).toBe(directJob.id);

    const [submitted] = eventsOf(app, 'direct_job.submitted');
    expect(submitted?.data).toEqual({ id: directJob.id, by: expect.any(String), via: 'ui', labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'] });
    expect(JSON.stringify(submitted?.data)).not.toContain('lockout');

    const done = await readBack(app, directJob.id, (d) => d.job?.status === 'finished');
    expect(done.job).toMatchObject({ id: job.id, status: 'finished', result: { echo: 'cleared' }, questions: [] });
    expect((await app.api<{ directJobs: DirectJobView[] }>('GET', '/api/direct-jobs')).body.directJobs.map((d) => d.id)).toEqual([directJob.id]);
    expect((await app.api('GET', '/api/direct-jobs/no-such-id')).status).toBe(404);
  });

  it('reads back an open question of a direct job; its answer resumes the job', async () => {
    const { app, token } = await start();
    const { directJob } = (await app.ui<{ directJob: DirectJobView }>('/ui/api/direct-jobs', submission({ op: 'ask', message: 'Which realm? This is hard.' }), { token })).body;
    const asked = await readBack(app, directJob.id, (d) => (d.job?.questions.length ?? 0) > 0 && d.job!.questions[0]!.tier === 'human');
    const q = asked.job!.questions[0]!;
    expect(q.text).toContain('Which realm?');
    expect((await app.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'the staff realm' }, { token })).status).toBe(200);
    const done = await readBack(app, directJob.id, (d) => d.job?.status === 'finished');
    expect(done.job!.questions).toEqual([]);
  });

  it('takes an agent\'s submission through a box token, and refuses an API token that is no box token', async () => {
    const { app, token } = await start();
    const mint = async (box: boolean) => (await app.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'cos', scopes: ['*'], box }, { token })).body.token;
    const plain = await agent(app, await mint(false), submission({ op: 'echo' }));
    expect(plain.status).toBe(403);
    expect(plain.body.error).toMatch(/box action/);
    expect((await app.api('GET', '/api/direct-jobs')).body.directJobs).toEqual([]);

    const boxed = await agent(app, await mint(true), submission({ op: 'echo', message: 'ok' }));
    expect(boxed.status).toBe(200);
    expect(boxed.body.directJob.submittedBy).toEqual({ person: expect.any(String), via: 'api' });
    await readBack(app, boxed.body.directJob.id, (d) => d.job?.status === 'finished');
  });

  it('refuses a submission with no brief, or a repository that is not owner/name, and keeps nothing', async () => {
    const { app, token } = await start();
    expect((await app.ui('/ui/api/direct-jobs', submission({ op: 'echo' }, { brief: ' ' }), { token })).status).toBe(400);
    expect((await app.ui('/ui/api/direct-jobs', submission({ op: 'echo' }, { repo: 'not a repo' }), { token })).status).toBe(400);
    expect((await app.api('GET', '/api/direct-jobs')).body.directJobs).toEqual([]);
    expect(eventsOf(app, 'direct_job.submitted')).toEqual([]);
  });

  it('runs a direct job again from the same submission', async () => {
    const { app, token } = await start();
    const { directJob, job } = (await app.ui<{ directJob: DirectJobView; job: { id: string } }>('/ui/api/direct-jobs', submission({ op: 'fail', message: 'realm down' }), { token })).body;
    await app.waitForStatus(job.id, 'failed');
    // Run again waits for the failure's report to the source.
    const again = await waitFor(async () => {
      const r = await app.ui<{ id: string; rerunOf?: string }>(`/ui/api/jobs/${job.id}/rerun`, {}, { token });
      return r.status === 200 ? r.body : undefined;
    }, { what: 'Run again' });
    expect(again.rerunOf).toBe(job.id);
    expect((await readBack(app, directJob.id, (d) => d.job?.id === again.id)).job!.id).toBe(again.id);
  });
});
