// The hopper continues with a proposal's recommended paths (issues #1059, #1174), over the real HTTP server and database:
// where a person would decide, a proposal that recommends one viable path, or a combination of viable paths, with no gaps,
// no risk rule on any of them, no reviewer level that escalated it and no Needs a person: line, is signed off by the
// hopper and each path runs as a follow-on. Every other one goes to a person, and the escalation says which rule did not
// settle it.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, ReviewItemView, ReviewVerdict } from '../../src/domain/types.ts';
import type { EscalationLevel } from '../../src/domain/ports.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { FOUR_PATHS, ONE_PATH } from '../support/proposal-paths.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(o: Omit<Parameters<typeof startTestApp>[0], 'dbPath'> = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, ...o });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const propose = (message: string) => ({ op: 'propose', message });
const reviewer = (name: string, verdict: ReviewVerdict): EscalationLevel => createFakeLevel({
  name, script: () => ({ answer: 'not a question', escalate: true, reason: 'never asked' }), review: () => ({ verdict, notes: `${name}: ${verdict}` }),
});
const proposalsOf = async (a: TestApp, jobId: string): Promise<ReviewItemView[]> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=all')).body.items.filter((p) => p.jobId === jobId);
const waitForProposal = (a: TestApp, jobId: string, ok: (p: ReviewItemView) => boolean) => waitFor(async () => {
  const p = (await proposalsOf(a, jobId))[0];
  return p && ok(p) ? p : undefined;
}, { what: `a matching proposal on job ${jobId}` });
const ofJob = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId);
const settings = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<Record<string, unknown>>('/ui/api/proposals/settings', body, { token });

describe('a proposal with one recommended path inside the rules (issue #1059)', () => {
  const reasonOf = async (a: TestApp, jobId: string) => ofJob(await a.events(), jobId).find((e) => e.type === 'proposal.escalated_to_human')?.data.reason;

  it('continues with that path with no person: the hopper signs it off, and the path runs as a follow-on', async () => {
    const a = await start();
    const job = await a.pull(propose(ONE_PATH));
    const done = await a.waitForStatus(job.id, 'finished');
    const [p] = await proposalsOf(a, job.id);
    expect(p).toMatchObject({ status: 'accepted', stage: 'hopper', signOff: { decision: 'accept', stage: 'hopper', version: 1, selected: [{ id: '1', title: 'Loopback port' }] } });
    expect(p!.signOff!.notes).toMatch(/recommended path/);
    expect(done.result).toEqual({ proposal: { id: p!.id, version: 1, decision: 'accept', followOns: [{ path: '1', jobId: expect.any(String) }] } });
    const events = ofJob(await a.events(), job.id);
    expect(events.find((e) => e.type === 'proposal.accepted')!.data).toMatchObject({ stage: 'hopper', selected: [{ id: '1' }] });
    expect(events.some((e) => e.type === 'proposal.escalated_to_human')).toBe(false);
  });

  it('goes to a person when the job says a person must decide, and says why', async () => {
    const a = await start();
    const job = await a.pull(propose(`${ONE_PATH}\nNeeds a person: the paths differ in cost, and no rule settles it.`));
    await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(await reasonOf(a, job.id)).toBe('the job says a person must decide: the paths differ in cost, and no rule settles it.');
  });

  it('goes to a person when a risk rule matches the recommended path, and names the rule', async () => {
    const a = await start();
    const job = await a.pull(propose(ONE_PATH.replace('Bind the UI to the loopback port only.', 'Drop table jobs and start again.')));
    await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(await reasonOf(a, job.id)).toBe('a risk rule matches the recommended path: delete');
  });

  it('continues with a combination of paths when each is viable and no rule holds it (issue #1174): one follow-on each', async () => {
    const a = await start();
    const job = await a.pull(propose(FOUR_PATHS));
    const done = await a.waitForStatus(job.id, 'finished');
    const [p] = await proposalsOf(a, job.id);
    expect(p).toMatchObject({ status: 'accepted', stage: 'hopper', signOff: { stage: 'hopper', selected: [{ id: '2', title: 'Brush the front' }, { id: '4', title: 'Oil the door' }] } });
    expect(p!.signOff!.notes).toBe('the hopper continued with the recommended paths 2, 4: no rule needs a person to decide');
    expect(done.result).toMatchObject({ proposal: { decision: 'accept', followOns: [{ path: '2' }, { path: '4' }] } });
    expect(ofJob(await a.events(), job.id).some((e) => e.type === 'proposal.escalated_to_human')).toBe(false);
  });

  it('goes to a person when a risk rule matches one path of the combination, and names the path', async () => {
    const a = await start();
    const job = await a.pull(propose(FOUR_PATHS.replace('Oil the hinges once.', 'Buy a new door and oil it.')));
    await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(await reasonOf(a, job.id)).toBe('a risk rule matches the recommended path 4: spend');
  });

  it('goes to a person when the job says a person must pick from the combination', async () => {
    const a = await start();
    const job = await a.pull(propose(`${FOUR_PATHS}\nNeeds a person: paths 2 and 4 cost differently, and no rule settles it.`));
    await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(await reasonOf(a, job.id)).toBe('the job says a person must decide: paths 2 and 4 cost differently, and no rule settles it.');
  });

  it('goes to a person when the setting is off', async () => {
    const a = await start();
    const token = await a.login();
    await settings(a, token, { autoContinue: false });
    const job = await a.pull(propose(ONE_PATH));
    await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(await reasonOf(a, job.id)).toBe('no reviewer levels configured');
  });

  it('after the reviewer levels approve, continues with that path too; a level that escalates sends it to a person', async () => {
    const a = await start({ seams: { levels: [reviewer('low', 'approve'), reviewer('high', 'escalate')] } });
    const token = await a.login();
    await settings(a, token, { reviewers: ['low'] });
    const job = await a.pull(propose(ONE_PATH));
    await a.waitForStatus(job.id, 'finished');
    expect((await proposalsOf(a, job.id))[0]).toMatchObject({ status: 'accepted', signOff: { stage: 'hopper' } });
    await settings(a, token, { reviewers: ['low', 'high'] });
    const next = await a.pull(propose(ONE_PATH));
    await waitForProposal(a, next.id, (x) => x.stage === 'human');
    expect(await reasonOf(a, next.id)).toMatch(/^a reviewer level escalated it: high: /);
  });
});
