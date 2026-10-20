// Parking a proposal or a research report (issue #2167): a person parks the job that waits on it, with a reason if they
// like. The item leaves its section's open list and counts for Parked, with who parked it and why; no decision is taken
// on it and no reviewer level reviews it while it is parked; parking it again is refused; picked up, its job waits on it
// again as it was. The park survives a restart. A running job's park keeps who parked it too. Real daemon over the fake
// herdr, as park.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { EscalationLevel } from '../../src/domain/ports.ts';
import type { Job, ReviewItemView, SectionSummary } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

const PROPOSAL = {
  output: ['● TL;DR: Leave the shed as it is.', '  Problem: The shed is bare wood.', '  Paths: none — no change is needed now.', '  Context: the shed.', '  HOPPER_PROPOSAL'],
};
const REPORT = {
  output: ['● Question: Which paint lasts?', '  Findings: Oil paint lasts ten years.', '  Sources and evidence: the tin.', '  Confidence: high.', '  Open threads: none.', '  Next step: buy oil paint.', '  HOPPER_RESEARCH_REPORT'],
};
const DONE = { output: ['● Painted the shed.', '  HOPPER_DONE'] };
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };

async function boot(herdr: FakeHerdrClient, o: { dbPath?: string; levels?: EscalationLevel[] } = {}): Promise<TestApp> {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  const a = await startTestApp({ dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: o.levels ?? [] } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const park = (a: TestApp, token: string, id: string, body: Record<string, unknown> = {}) => a.ui<Job>(`/ui/api/jobs/${id}/park`, body, { token });
const pickUp = (a: TestApp, token: string, id: string) => a.ui<Job>(`/ui/api/jobs/${id}/requeue`, {}, { token });
const listed = async (a: TestApp, section: string, status: string) => (await a.api<{ items: ReviewItemView[] }>('GET', `/api/${section}?status=${status}`)).body.items;
const sections = async (a: TestApp) => Object.fromEntries((await a.api<{ sections: SectionSummary[] }>('GET', '/api/sections')).body.sections.map((s) => [s.kind, s.open]));

/** A job on its proposal, at the human stage. */
async function onProposal(a: TestApp): Promise<{ job: Job; proposal: ReviewItemView }> {
  const job = await a.pull({}, item);
  const proposal = await waitFor(async () => (await listed(a, 'proposals', 'open')).find((p) => p.jobId === job.id && p.stage === 'human'), { what: 'the proposal' });
  return { job: await a.waitForStatus(job.id, 'waiting_answer'), proposal };
}

describe('parking a job on its proposal', () => {
  it('moves the proposal out of Proposals into Parked, with who parked it and why; picked up, it is back as it was', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [PROPOSAL] });
    const a = await boot(herdr);
    const token = await a.login();
    const { job, proposal } = await onProposal(a);
    expect(await sections(a)).toMatchObject({ proposals: 1, parked: 0 });

    const r = await park(a, token, job.id, { reason: 'Wait for the spring.' });
    expect(r.status).toBe(200);
    const parked = await a.waitForStatus(job.id, 'parked');
    expect(parked).toMatchObject({ proposalId: proposal.id, parked: { from: 'waiting_answer', by: expect.any(String), via: 'ui', reason: 'Wait for the spring.' } });
    expect(parked.parkAsk).toBeUndefined();
    expect(await listed(a, 'proposals', 'open')).toEqual([]);
    const shelf = await listed(a, 'proposals', 'parked');
    expect(shelf).toEqual([expect.objectContaining({ id: proposal.id, status: 'open', stage: 'human', parked: { at: parked.parked!.at, by: parked.parked!.by, via: 'ui', reason: 'Wait for the spring.' } })]);
    expect(await sections(a)).toMatchObject({ proposals: 0, parked: 1 });
    const event = (await a.events('types=job.parked')).find((e) => e.jobId === job.id)!;
    expect(event.data).toMatchObject({ from: 'waiting_answer', by: parked.parked!.by, via: 'ui', reason: 'Wait for the spring.' });

    // No decision while it is parked, and no second park.
    const accept = await a.ui(`/ui/api/proposals/${proposal.id}/accept`, { paths: [] }, { token });
    expect(accept.status).toBe(409);
    expect(JSON.stringify(accept.body)).toContain('parked');
    const again = await park(a, token, job.id);
    expect(again.status).toBe(409);
    expect((await a.job(job.id)).parked).toEqual(parked.parked);

    expect((await pickUp(a, token, job.id)).status).toBe(200);
    const back = await a.job(job.id);
    expect(back).toMatchObject({ status: 'waiting_answer', proposalId: proposal.id });
    expect(back.pendingAnswer).toBeUndefined();
    const open = await listed(a, 'proposals', 'open');
    expect(open).toEqual([expect.objectContaining({ id: proposal.id, status: 'open', stage: 'human', versions: proposal.versions })]);
    expect(open[0]!.parked).toBeUndefined();
    expect(await listed(a, 'proposals', 'parked')).toEqual([]);
    expect(await sections(a)).toMatchObject({ proposals: 1, parked: 0 });

    // A decision is taken again: the job ends with it.
    expect((await a.ui(`/ui/api/proposals/${proposal.id}/accept`, { paths: [] }, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished');
  });

  it('a research report is parked the same way', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [REPORT] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const report = await waitFor(async () => (await listed(a, 'research', 'open')).find((p) => p.jobId === job.id), { what: 'the report' });
    await a.waitForStatus(job.id, 'waiting_answer');
    expect((await park(a, token, job.id)).status).toBe(200);
    expect(await listed(a, 'research', 'open')).toEqual([]);
    expect((await listed(a, 'research', 'parked')).map((p) => p.id)).toEqual([report.id]);
    expect((await a.ui(`/ui/api/research/${report.id}/accept`, {}, { token })).status).toBe(409);
    expect((await pickUp(a, token, job.id)).status).toBe(200);
    expect((await listed(a, 'research', 'open')).map((p) => p.id)).toEqual([report.id]);
  });

  it('survives a restart: still parked, still out of Proposals; picked up after, it waits on it again', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [PROPOSAL] });
    const first = await boot(herdr);
    const token = await first.login();
    const { job, proposal } = await onProposal(first);
    await park(first, token, job.id, { reason: 'Later.' });
    await first.waitForStatus(job.id, 'parked');
    await first.stop();
    apps.splice(apps.indexOf(first), 1);

    const second = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }), { dbPath: first.dbPath });
    expect(await second.job(job.id)).toMatchObject({ status: 'parked', parked: { reason: 'Later.' } });
    expect(await listed(second, 'proposals', 'open')).toEqual([]);
    expect((await listed(second, 'proposals', 'parked')).map((p) => p.id)).toEqual([proposal.id]);
    const token2 = await second.login();
    expect((await pickUp(second, token2, job.id)).status).toBe(200);
    expect(await second.job(job.id)).toMatchObject({ status: 'waiting_answer', proposalId: proposal.id });
    expect((await listed(second, 'proposals', 'open')).map((p) => p.id)).toEqual([proposal.id]);
  });
});

describe('a reviewer level and a parked proposal', () => {
  it('a review that comes back while its job is parked is dropped; picked up, the level reviews it again', async () => {
    let release: (() => void) | undefined;
    let reviews = 0;
    const level = createFakeLevel({
      name: 'opus',
      script: () => ({ answer: 'not a question', escalate: true, reason: 'never asked' }),
      review: async () => {
        reviews += 1;
        if (reviews === 1) await new Promise<void>((r) => { release = r; });
        return { verdict: 'approve', notes: 'fine' };
      },
    });
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [PROPOSAL] });
    const a = await boot(herdr, { levels: [level] });
    const token = await a.login();
    expect((await a.ui('/ui/api/proposals/settings', { reviewers: ['opus'], signOff: 'top-level', levelRevisions: 1 }, { token })).status).toBe(200);
    const job = await a.pull({}, item);
    await waitFor(() => release !== undefined, { what: 'the level asked' });
    await a.waitForStatus(job.id, 'waiting_answer');
    expect((await park(a, token, job.id)).status).toBe(200);
    await a.waitForStatus(job.id, 'parked');

    // The level approves while the job is parked: with top-level sign-off that would accept it. It does not.
    release!();
    const shelf = await waitFor(async () => {
      const p = (await listed(a, 'proposals', 'parked'))[0];
      return p && !p.call ? p : undefined;
    }, { what: 'the call cleared' });
    expect(shelf).toMatchObject({ status: 'open', stage: 'opus', reviews: [] });
    expect((await a.job(job.id)).status).toBe('parked');

    expect((await pickUp(a, token, job.id)).status).toBe(200);
    // Asked again, the level approves, and its top-level sign-off accepts it: the job ends.
    await a.waitForStatus(job.id, 'finished');
    expect(reviews).toBe(2);
  });
});

describe('parking a running job', () => {
  it('keeps who parked it and why once its executor stepped aside', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    expect((await park(a, token, job.id, { reason: 'Needs the new paint.' })).status).toBe(200);
    const parked = await a.waitForStatus(job.id, 'parked');
    expect(parked.parked).toMatchObject({ from: 'running', by: expect.any(String), via: 'ui', reason: 'Needs the new paint.' });
    expect(parked.parkAsk).toBeUndefined();
    expect((await park(a, token, job.id)).status).toBe(409);
  });

  it('refuses a reason longer than 500 characters', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    expect((await park(a, token, job.id, { reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await a.job(job.id)).status).toBe('running');
  });
});
