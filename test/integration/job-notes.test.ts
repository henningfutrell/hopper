// Issue #997: a person (or an agent over the API) sends a note to a job. A running job's session gets it at the next
// turn boundary; a job that waits — on its own wait, a question, a hold, parked — keeps it queued, through a daemon
// restart, until it resumes; a new job of the same item (run again, rework, I fixed it) carries the notes not yet
// delivered. Each note is in the job's timeline: added, delivered, carried. Real daemon over the fake herdr.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, JobNote } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;
let dbPath = '';
let source = createManualSource();

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const LONG: FakeTurn = { steps: Array.from({ length: 60 }, (_, i) => `● Checking port ${i + 1}`), output: ['● The port does not answer.', '  HOPPER_DONE'] };
const DONE: FakeTurn = { output: ['● Used the address in the note. Done.', '  HOPPER_DONE'] };
const WAIT: FakeTurn = {
  output: ['● The instance is up, but its port does not answer.', '  HOPPER_WAITING', '  for: AWS access to the instance', '  until: a background poll of the port'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const item = { executor: 'herdr-claude', prompt: 'Reach the service', cwd: '/tmp', env: {} };
const NOTE = 'The instance is i-0abc in eu-west-1; the port is 8443.';

function freshDb(): void {
  source = createManualSource();
  const db = tempDbPath();
  cleanup = db.cleanup;
  dbPath = db.dbPath;
}

async function boot(herdr?: FakeHerdrClient): Promise<TestApp> {
  const a = await startTestApp({ dbPath, source, plugins: { executors: EXECUTORS, machines: lanes(2) }, seams: { ...(herdr ? { herdr } : {}), levels: [] } });
  apps.push(a);
  return a;
}

const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events('limit=1000')).filter((e) => e.jobId === jobId);
const notesOf = async (a: TestApp, jobId: string): Promise<JobNote[]> => (await a.api<{ notes: JobNote[] }>('GET', `/api/jobs/${jobId}/notes`)).body.notes;
const send = (a: TestApp, token: string, jobId: string, text: string) => a.ui<JobNote>(`/ui/api/jobs/${jobId}/notes`, { text }, { token });

describe('notes to a job', () => {
  it('a note to a running job reaches its session at the next turn boundary; the job goes on and finishes', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running', 8000);
    await waitFor(() => herdr.prompts.length === 1);

    const r = await send(a, token, job.id, NOTE);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ text: NOTE, state: 'queued', by: expect.any(String), via: 'ui', at: expect.any(String) });
    // Mid-turn: nothing typed yet.
    expect(herdr.prompts).toHaveLength(1);
    const done = await a.waitForStatus(job.id, 'finished', 15_000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Used the address in the note.') });
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toContain(NOTE);
    const [note] = await notesOf(a, job.id);
    expect(note).toMatchObject({ id: r.body.id, state: 'delivered', delivery: 'turn', deliveredAt: expect.any(String) });
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.note_added')!.data).toMatchObject({ noteId: r.body.id, text: NOTE, via: 'ui' });
    expect(events.find((e) => e.type === 'job.note_delivered')!.data).toEqual({ noteIds: [r.body.id], delivery: 'turn' });
  });

  it('a note to a job on its own wait is queued, typed nothing, kept across a restart, and goes in when the wait ends', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const first = await boot(herdr);
    const token = await first.login();
    const job = await first.pull({}, item);
    await first.waitForStatus(job.id, 'waiting_on', 8000);

    expect((await send(first, token, job.id, NOTE)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(herdr.prompts).toHaveLength(1);
    expect((await first.job(job.id)).status).toBe('waiting_on');
    await first.stop();
    apps.splice(apps.indexOf(first), 1);

    const second = await boot(herdr);
    expect(await notesOf(second, job.id)).toEqual([expect.objectContaining({ text: NOTE, state: 'queued' })]);
    const token2 = await second.login();
    expect((await second.ui(`/ui/api/jobs/${job.id}/end-wait`, {}, { token: token2 })).status).toBe(200);

    await second.waitForStatus(job.id, 'finished', 15_000);
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toContain('AWS access to the instance');
    expect(herdr.prompts[1]!.text).toContain(NOTE);
    expect(await notesOf(second, job.id)).toEqual([expect.objectContaining({ state: 'delivered', delivery: 'resume' })]);
  });

  it('notes not delivered carry over to the job that runs its item again', async () => {
    freshDb();
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the port does not answer', ms: 0 });
    await a.waitForStatus(job.id, 'failed', 8000);
    await waitFor(async () => (await a.job(job.id)).sourceState?.sync?.finalReported === true, { what: 'its failure reported' });
    const added = await send(a, token, job.id, NOTE);
    expect(added.status).toBe(200);

    const again = await a.ui<Job>(`/ui/api/jobs/${job.id}/rerun`, {}, { token });

    expect(again.status).toBe(200);
    const next = again.body;
    expect(await notesOf(a, job.id)).toEqual([expect.objectContaining({ id: added.body.id, state: 'carried', carriedTo: next.id })]);
    expect(await notesOf(a, next.id)).toEqual([expect.objectContaining({ id: added.body.id, text: NOTE, state: 'queued', carriedFrom: job.id })]);
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.note_carried')!.data).toEqual({ noteIds: [added.body.id], nextJobId: next.id });
  });

  it('refuses a note to an ended job, an empty note, and a job it does not know', async () => {
    freshDb();
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'echo', message: 'done' });
    await a.waitForStatus(job.id, 'finished', 8000);
    expect((await send(a, token, job.id, NOTE)).status).toBe(409);
    const empty = await a.ui(`/ui/api/jobs/${job.id}/notes`, { text: '   ' }, { token });
    expect(empty.status).toBe(400);
    expect((await send(a, token, 'no-such-job', NOTE)).status).toBe(404);
    expect((await a.api('GET', '/api/jobs/no-such-job/notes')).status).toBe(404);
  });

  it('needs a UI session: no session, no note', async () => {
    freshDb();
    const a = await boot();
    const job = await a.pull({ op: 'sleep', ms: 5000 });
    expect((await a.ui(`/ui/api/jobs/${job.id}/notes`, { text: NOTE })).status).toBe(403);
  });
});
