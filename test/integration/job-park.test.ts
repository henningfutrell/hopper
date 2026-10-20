// Issue #2167, the last part: a running job parks and picks up its user's proposals and research reports, with its own
// proxy token (`GET`/`POST /job/park`, design.md "Parking a proposal or a research report"), through the `park` skill.
// Real daemon over the fake herdr, as park-review-item.test.ts: the item's job runs on herdr-claude, the job that parks
// it on the test executor.
//
// Feature: a job parks a proposal or a research report
//   Scenario: a running job lists the open items, parks one with a reason, and picks it up again
//   Scenario: a job never picks up an item a person parked, never parks a running job, and never parks an item twice
//   Scenario: no token, a token that is no job's, and the token of a job that ended are refused
//   Scenario: the park skill tells a job to call it at HOPPER_URL with its token file
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, ReviewItemView } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { JOB_PARK_PATH } from '../../src/http/job-park.ts';
import { skillOf } from '../../src/skills/catalog.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const PROPOSAL = {
  output: ['● TL;DR: Leave the shed as it is.', '  Problem: The shed is bare wood.', '  Paths: none — no change is needed now.', '  Context: the shed.', '  HOPPER_PROPOSAL'],
};
const REPORT = {
  output: ['● Question: Which paint lasts?', '  Findings: Oil paint lasts ten years.', '  Sources and evidence: the tin.', '  Confidence: high.', '  Open threads: none.', '  Next step: buy oil paint.', '  HOPPER_RESEARCH_REPORT'],
};
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(2) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

const tokenOf = (a: TestApp, job: string): string => proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);
const auth = (bearer?: string): Record<string, string> => (bearer ? { authorization: `Bearer ${bearer}` } : {});
const list = (a: TestApp, bearer?: string) => fetch(`${a.url}${JOB_PARK_PATH}`, { headers: auth(bearer) });
const act = (a: TestApp, bearer: string | undefined, body: Record<string, unknown>) =>
  fetch(`${a.url}${JOB_PARK_PATH}`, { method: 'POST', headers: { ...auth(bearer), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const listed = async (a: TestApp, section: string, status: string) => (await a.api<{ items: ReviewItemView[] }>('GET', `/api/${section}?status=${status}`)).body.items;

type Listed = { kind: string; id: string; jobId: string; status: string; stage: string; parked?: { at: string; by?: string; via?: string; reason?: string } };

/** A job on its proposal at the human stage, and a running job that parks it. */
async function setUp(turns: unknown[], section: 'proposals' | 'research') {
  const herdr = createFakeHerdrClient({ session: 'jh-test', turns: turns as never });
  const a = await boot(herdr);
  const target = await a.pull({}, item);
  const found = await waitFor(async () => (await listed(a, section, 'open')).find((p) => p.jobId === target.id && p.stage === 'human'), { what: 'the item' });
  await a.waitForStatus(target.id, 'waiting_answer');
  const caller = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(caller.id, 'running', 10000);
  return { a, target, found, caller, token: tokenOf(a, caller.id) };
}

describe('a job parks a proposal or a research report (issue #2167)', () => {
  it('lists the open items, parks one with a reason, and picks it up again', async () => {
    const { a, target, found, caller, token } = await setUp([PROPOSAL], 'proposals');

    const before = await list(a, token);
    expect(before.status).toBe(200);
    expect(before.headers.get('cache-control')).toBe('no-store');
    expect(((await before.json()) as { items: Listed[] }).items).toEqual([expect.objectContaining({ kind: 'proposal', id: found.id, jobId: target.id, status: 'open', stage: 'human' })]);

    const parked = await act(a, token, { act: 'park', item: found.id, reason: 'Wait for the spring.' });
    expect(parked.status).toBe(200);
    expect(await parked.text()).toMatch(/^ok: /);
    const job = await a.waitForStatus(target.id, 'parked');
    expect(job.parked).toMatchObject({ from: 'waiting_answer', by: `job ${caller.id}`, via: 'job', reason: 'Wait for the spring.' });
    expect(await listed(a, 'proposals', 'open')).toEqual([]);
    expect((await listed(a, 'proposals', 'parked')).map((p) => p.id)).toEqual([found.id]);
    const event = (await a.events('types=job.parked')).find((e) => e.jobId === target.id)!;
    expect(event.data).toMatchObject({ by: `job ${caller.id}`, via: 'job', reason: 'Wait for the spring.' });
    const shown = ((await (await list(a, token)).json()) as { items: Listed[] }).items;
    expect(shown).toEqual([expect.objectContaining({ id: found.id, parked: expect.objectContaining({ by: `job ${caller.id}`, via: 'job' }) })]);

    const again = await act(a, token, { act: 'park', item: found.id });
    expect(again.status).toBe(409);

    const back = await act(a, token, { act: 'pick-up', item: found.id });
    expect(back.status).toBe(200);
    expect(await a.job(target.id)).toMatchObject({ status: 'waiting_answer', proposalId: found.id });
    expect((await listed(a, 'proposals', 'open')).map((p) => p.id)).toEqual([found.id]);
    const unparked = (await a.events('types=job.unparked')).find((e) => e.jobId === target.id)!;
    expect(unparked.data).toMatchObject({ to: 'waiting_answer', by: `job ${caller.id}`, via: 'job' });
  });

  it('a research report is parked the same way', async () => {
    const { a, target, found, token } = await setUp([REPORT], 'research');
    expect((await act(a, token, { act: 'park', item: found.id })).status).toBe(200);
    await a.waitForStatus(target.id, 'parked');
    expect((await listed(a, 'research', 'parked')).map((p) => p.id)).toEqual([found.id]);
    expect((await act(a, token, { act: 'pick-up', item: found.id })).status).toBe(200);
    expect((await listed(a, 'research', 'open')).map((p) => p.id)).toEqual([found.id]);
  });

  it('never picks up an item a person parked, never parks a running job, and refuses a bad call', async () => {
    const { a, target, found, caller, token } = await setUp([PROPOSAL], 'proposals');
    const session = await a.login();
    expect((await a.ui<Job>(`/ui/api/jobs/${target.id}/park`, { reason: 'Mine.' }, { token: session })).status).toBe(200);
    await a.waitForStatus(target.id, 'parked');

    const refused = await act(a, token, { act: 'pick-up', item: found.id });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toMatch(/a person parked it/);
    expect((await a.job(target.id)).status).toBe('parked');

    // The caller is a running job with no item: there is nothing of it to park.
    expect((await act(a, token, { act: 'park', item: caller.id })).status).toBe(404);
    expect((await act(a, token, { act: 'park', item: 'proposal_nope' })).status).toBe(404);
    expect((await act(a, token, { act: 'sleep', item: found.id })).status).toBe(400);
    expect((await act(a, token, { act: 'park', item: found.id, reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await a.job(caller.id)).status).toBe('running');
  });

  it('refuses no token, a token that is no job\'s, and the token of a job that ended', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [] });
    const a = await boot(herdr);
    expect((await list(a)).status).toBe(401);
    expect((await list(a, 'not-a-token')).status).toBe(401);
    expect((await act(a, undefined, { act: 'park', item: 'proposal_x' })).status).toBe(401);
    const job = await a.pull({ op: 'sleep', ms: 200 });
    await a.waitForStatus(job.id, 'finished', 10000);
    const ended = await list(a, tokenOf(a, job.id));
    expect(ended.status).toBe(401);
    expect(await ended.text()).toMatch(new RegExp(`^no: job ${job.id} is finished, not at work`));
  });

  it('the park skill tells a job to call it at HOPPER_URL with its token file, never at 127.0.0.1', () => {
    const text = skillOf('park')!.text;
    expect(text).toContain(`"$HOPPER_URL${JOB_PARK_PATH}"`);
    expect(text).toContain('$HOPPER_TOKEN_FILE');
    expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
  });
});
