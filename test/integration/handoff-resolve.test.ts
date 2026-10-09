// Resolving a hand-off (issue #551): a person says what they did about a failed job in Needs a person, with a note —
// Continue (the job's own agent session and work tree, the note and the failure handed to it; a new job told the same
// when the session cannot resume), I fixed it (a new job, told the note), Done by hand (with a link) or Won't do (with
// the reason). Each resolution is kept on the hand-off with who, when, the note and the link, goes back to the item's
// source, and links the job that follows. Real daemon, real database; the fake herdr and the manual source at their seams.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Handoff, HandoffView, Job } from '../../src/domain/types.ts';
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
const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
const herdrItem = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };

async function boot(herdr?: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({
    dbPath: db.dbPath,
    plugins: herdr ? { executors: EXECUTORS, machines: lanes(1) } : { machines: lanes(2) },
    ...(herdr ? { seams: { herdr, levels: [] } } : {}),
  });
  apps.push(a);
  return a;
}

type Resolved = { handoff: HandoffView; job?: Job };
const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const handoffOf = async (a: TestApp, jobId: string) =>
  waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === jobId && h.status === 'open'), { what: `job ${jobId} handed off` });
const resolve = (a: TestApp, token: string, h: Handoff, body: Record<string, unknown>) =>
  a.ui<Resolved & { error?: string }>(`/ui/api/failures/handoffs/${h.id}/resolve`, body, { token });
const viewOf = async (a: TestApp, id: string) => (await failuresOf(a)).handoffs.find((x) => x.id === id)!;

describe('Continue with a note', () => {
  it('resumes the failed job in its own agent session and work tree, told the note and the failure', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [FAIL, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, herdrItem);
    await a.waitForStatus(job.id, 'failed', 8000);
    const session = (await a.job(job.id)).agentSession!;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    const h = await handoffOf(a, job.id);
    // The card says what Continue does for this job: its own session resumes.
    expect(h.actions.continue).toEqual({ ok: true });
    expect(h.continueResumes).toBe(true);

    const r = await resolve(a, token, h, { action: 'continue', note: 'Buy more paint first; it is in the garage.' });
    expect(r.status).toBe(200);
    expect(r.body.handoff).toMatchObject({
      status: 'closed', end: 'continued', nextJobId: job.id,
      resolution: { action: 'continue', resumed: true, note: 'Buy more paint first; it is in the garage.', by: expect.any(String), at: expect.any(String) },
    });
    // The same job, not a new one: it waits pinned to its machine, its session to resume.
    expect(r.body.job).toMatchObject({ id: job.id, status: 'queued', resumeOn: 'local' });

    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed blue.') });
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    // The resumed session is told the note and why it failed, not the task again.
    const told = herdr.prompts[1]!.text;
    expect(told).toContain('Buy more paint first; it is in the garage.');
    expect(told).toContain('the paint ran out');
    expect(told).not.toContain('Paint the shed');
    // Its end is told to its source again; the resolution was told too.
    await waitFor(() => a.source.reports.filter((x) => x.job.id === job.id && x.kind === 'finished').length === 1, { what: 'finished reported' });
    expect(a.source.resolutions).toEqual([expect.objectContaining({ jobId: job.id, resolution: expect.objectContaining({ action: 'continue', resumed: true }) })]);
    const continued = (await a.events('types=job.continued')).filter((e) => e.jobId === job.id);
    expect(continued).toHaveLength(1);
  });

  it('a job whose session cannot resume runs again as a new job, told the earlier error, the assessment and the note', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    const h = await handoffOf(a, job.id);
    expect(h.actions.continue).toEqual({ ok: true });
    expect(h.continueResumes).toBe(false);

    const r = await resolve(a, token, h, { action: 'continue', note: 'Skip the flaky test in ci.yml.' });
    expect(r.status).toBe(200);
    const next = r.body.job!;
    expect(next).toMatchObject({ rerunOf: job.id });
    expect(next.id).not.toBe(job.id);
    const prompt = String(next.spec.payload.prompt);
    expect(prompt).toContain('Skip the flaky test in ci.yml.');
    expect(prompt).toContain('the tests do not pass');
    expect(prompt).toContain(h.summary);
    expect(r.body.handoff).toMatchObject({ status: 'closed', end: 'run_again', nextJobId: next.id, resolution: { action: 'continue', resumed: false } });
  });
});

describe('I fixed it', () => {
  it('runs the item again as a new job, told what the person fixed', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED no credentials for the registry', ms: 0 });
    const h = await handoffOf(a, job.id);
    const r = await resolve(a, token, h, { action: 'fixed', note: 'Added the registry token to the machine.' });
    expect(r.status).toBe(200);
    expect(String(r.body.job!.spec.payload.prompt)).toContain('Added the registry token to the machine.');
    expect(r.body.handoff).toMatchObject({ end: 'run_again', nextJobId: r.body.job!.id, resolution: { action: 'fixed' } });
    // Its failure record says a person ran it again: not left waiting.
    const record = (await failuresOf(a)).recent.find((x) => x.jobId === job.id);
    expect(record?.outcome ?? 'gone').not.toBe('surfaced');
  });
});

describe('Done by hand and Won\'t do', () => {
  it('Done by hand: the job ends finished, with the link, and its source is told', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    const h = await handoffOf(a, job.id);
    expect((await resolve(a, token, h, { action: 'done_by_hand', link: 'not a link' })).status).toBe(400);

    const r = await resolve(a, token, h, { action: 'done_by_hand', note: 'Fixed it on my laptop.', link: 'https://example.invalid/pull/7' });
    expect(r.status).toBe(200);
    expect(r.body.handoff).toMatchObject({
      status: 'closed', end: 'done_by_hand',
      resolution: { action: 'done_by_hand', note: 'Fixed it on my laptop.', link: 'https://example.invalid/pull/7' },
    });
    expect((await a.job(job.id)).status).toBe('finished');
    await waitFor(() => a.source.resolutions.some((x) => x.jobId === job.id), { what: 'the source told' });
    expect(a.source.resolutions.find((x) => x.jobId === job.id)!.resolution).toMatchObject({ action: 'done_by_hand', link: 'https://example.invalid/pull/7' });
    await waitFor(async () => (await viewOf(a, h.id)).resolution?.writeBack === 'written', { what: 'written back' });
    // Closed: nothing more is offered, and why is said.
    const shown = await viewOf(a, h.id);
    expect(shown.actions.continue).toEqual({ ok: false, why: 'already resolved: done by hand' });
    expect((await resolve(a, token, h, { action: 'wont_do', note: 'x' })).status).toBe(409);
  });

  it('Won\'t do needs the reason; the job leaves the queue and its source is told', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    const h = await handoffOf(a, job.id);
    expect((await resolve(a, token, h, { action: 'wont_do' })).status).toBe(400);
    const r = await resolve(a, token, h, { action: 'wont_do', note: 'Not a real failure: the issue was a duplicate.' });
    expect(r.status).toBe(200);
    expect(r.body.handoff).toMatchObject({ end: 'wont_do', resolution: { action: 'wont_do', note: 'Not a real failure: the issue was a duplicate.' } });
    await waitFor(async () => (await a.job(job.id)).dismissedAt, { what: 'the locked entry dismissed' });
    await waitFor(() => a.source.resolutions.some((x) => x.jobId === job.id && x.resolution.action === 'wont_do'), { what: 'the source told' });
    // Its failure record is settled: out of Recent failures.
    expect((await failuresOf(a)).recent.find((x) => x.jobId === job.id)).toBeUndefined();
  });

  it('a refused action says why instead of disappearing', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    const h = await handoffOf(a, job.id);
    // Its item ran again by another way: Continue and I fixed it are refused, with the reason.
    expect((await a.ui(`/ui/api/jobs/${job.id}/rerun`, {}, { token })).status).toBe(200);
    const closed = await waitFor(async () => { const v = await viewOf(a, h.id); return v.status === 'closed' ? v : undefined; }, { what: 'closed by the run again' });
    expect(closed.actions.continue.ok).toBe(false);
    expect(closed.actions.fixed).toEqual({ ok: false, why: expect.stringMatching(/already closed/) });
    expect(closed.nextJobId).toBeDefined();
  });
});
