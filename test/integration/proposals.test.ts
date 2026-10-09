// Proposals (issue #537) over the real HTTP server and database: the scripted executor's `propose` op writes one
// (and, resumed, a revision), reviewer levels are doubles at the EscalationLevel seam, and a person decides through
// the UI session routes. A proposal is apart from the questions: its own routes, events and settings.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, ReviewItemView, ReviewVerdict } from '../../src/domain/types.ts';
import type { EscalationLevel, ReviewRequest } from '../../src/domain/ports.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeWebhooks } from '../support/files.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let receiver: Receiver | undefined;

async function start(o: Omit<Parameters<typeof startTestApp>[0], 'dbPath'> & { before?: (dbPath: string) => void } = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  o.before?.(db.dbPath);
  t = await startTestApp({ dbPath: db.dbPath, ...o });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  await receiver?.close();
  receiver = undefined;
  cleanup?.();
});

const PROPOSAL = [
  'Goal: paint the shed',
  'Approach: two coats with a brush',
  'Alternatives considered: a spray gun',
  'Risks: rain on the second day',
  'Effort: an afternoon',
  'Context: the shed is bare wood',
].join('\n');
const propose = (message = PROPOSAL) => ({ op: 'propose', message });

/** A reviewer level that answers each review with the next verdict of `verdicts` (the last one repeats). */
function reviewer(name: string, verdicts: ReviewVerdict[], seen: ReviewRequest[] = []): EscalationLevel {
  return createFakeLevel({
    name,
    script: () => ({ answer: 'not a question', escalate: true, reason: 'never asked' }),
    review: (req) => {
      seen.push(req);
      const verdict = verdicts[Math.min(seen.length - 1, verdicts.length - 1)]!;
      return { verdict, notes: verdict === 'request_changes' ? `${name}: say which paint` : `${name}: ${verdict}` };
    },
  });
}

const proposalsOf = async (a: TestApp, jobId: string): Promise<ReviewItemView[]> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=all')).body.items.filter((p) => p.jobId === jobId);
const waitForProposal = (a: TestApp, jobId: string, ok: (p: ReviewItemView) => boolean) => waitFor(async () => {
  const p = (await proposalsOf(a, jobId))[0];
  return p && ok(p) ? p : undefined;
}, { what: `a matching proposal on job ${jobId}` });
const ofJob = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId);
const settings = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<Record<string, unknown>>('/ui/api/proposals/settings', body, { token });
const decide = (a: TestApp, token: string, id: string, how: 'accept' | 'reject' | 'request-changes', body: Record<string, unknown> = {}) =>
  a.ui<ReviewItemView>(`/ui/api/proposals/${id}/${how}`, body, { token });

describe('a job that comes back with a proposal', () => {
  it('waits on it; the proposal has its parts, is apart from the questions, and reaches a person with no reviewer levels', async () => {
    const a = await start();
    const job = await a.pull(propose(), { title: 'paint the shed' });
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(p).toMatchObject({ status: 'open', stage: 'human', priority: 50, high: false, source: { title: 'paint the shed' } });
    expect(p.versions).toEqual([expect.objectContaining({
      number: 1, text: PROPOSAL, missing: [],
      sections: { goal: 'paint the shed', approach: 'two coats with a brush', alternatives: 'a spray gun', risks: 'rain on the second day', effort: 'an afternoon', context: 'the shed is bare wood' },
    })]);
    expect(await a.job(job.id)).toMatchObject({ status: 'waiting_answer', proposalId: p.id });
    expect(await a.questionsOf(job.id)).toEqual([]);
    expect((await a.api('GET', `/api/proposals/${p.id}`)).body).toMatchObject({ id: p.id, status: 'open' });
    const events = ofJob(await a.events(), job.id);
    expect(events.find((e) => e.type === 'proposal.submitted')!.data).toMatchObject({ proposalId: p.id, version: 1, goal: 'paint the shed', missing: [], priority: 50, high: false });
    expect(events.filter((e) => e.type === 'proposal.escalated').map((e) => e.data.target)).toEqual(['human']);
    expect(events.filter((e) => e.type === 'proposal.escalated_to_human')).toHaveLength(1);
    expect(events.some((e) => e.type.startsWith('question.'))).toBe(false);
  });

  it('a proposal that leaves parts out says which', async () => {
    const a = await start();
    const job = await a.pull(propose('Goal: paint it\nApproach: a brush'));
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(p.versions[0]).toMatchObject({ sections: { goal: 'paint it', approach: 'a brush' }, missing: ['alternatives', 'risks', 'effort', 'context'] });
  });
});

describe('review through the reviewer levels', () => {
  it('each level checks it with the job\'s context and records its verdict; past the top level, a person signs off', async () => {
    const seen: ReviewRequest[] = [];
    const a = await start({ seams: { levels: [reviewer('low', ['approve'], seen), reviewer('high', ['approve'])] } });
    const token = await a.login();
    expect((await settings(a, token, { reviewers: ['low', 'high'] })).status).toBe(200);
    const job = await a.pull(propose(), { title: 'paint the shed' });
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(p.reviews.map((r) => [r.stage, r.role, r.verdict, r.notes, r.version])).toEqual([['low', 'level', 'approve', 'low: approve', 1], ['high', 'level', 'approve', 'high: approve', 1]]);
    expect(seen[0]).toMatchObject({ jobGoal: 'paint the shed', level: { number: 1, of: 2 }, version: { number: 1, text: PROPOSAL } });
    expect(seen[0]!.jobPrompt).toContain('"op":"propose"');
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'proposal.escalated').map((e) => e.data.target)).toEqual(['low', 'high', 'human']);
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'proposal.reviewed').map((e) => [e.data.stage, e.data.verdict])).toEqual([['low', 'approve'], ['high', 'approve']]);
  });

  it('where the top level may sign off, its approval accepts the proposal and the job ends with it', async () => {
    const a = await start({ seams: { levels: [reviewer('low', ['approve']), reviewer('high', ['approve'])] } });
    const token = await a.login();
    await settings(a, token, { reviewers: ['low', 'high'], signOff: 'top-level' });
    const job = await a.pull(propose());
    const done = await a.waitForStatus(job.id, 'finished');
    const [p] = await proposalsOf(a, job.id);
    expect(p).toMatchObject({ status: 'accepted', signOff: { decision: 'accept', stage: 'high', version: 1 } });
    expect(done.result).toEqual({ proposal: { id: p!.id, version: 1, decision: 'accept' } });
    expect(ofJob(await a.events(), job.id).find((e) => e.type === 'proposal.accepted')!.data).toMatchObject({ proposalId: p!.id, stage: 'high', version: 1 });
  });

  it('a level that escalates or fails passes it up; one that cannot review at all is an error on the trail', async () => {
    const broken = createFakeLevel({ name: 'broken', script: () => ({ escalate: true, reason: 'x' }), review: () => ({ verdict: 'maybe' }) as never });
    const a = await start({ seams: { levels: [reviewer('low', ['escalate']), broken] } });
    const token = await a.login();
    await settings(a, token, { reviewers: ['low', 'broken'] });
    const job = await a.pull(propose());
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(p.reviews.map((r) => [r.stage, r.verdict])).toEqual([['low', 'escalate'], ['broken', 'escalate']]);
    expect(p.reviews[1]!.error).toMatch(/malformed/);
  });

  it('a level that asks for changes sends it back: the job is told why and writes version 2, reviewed again; past the limit it goes to a person', async () => {
    const seen: ReviewRequest[] = [];
    const a = await start({ seams: { levels: [reviewer('low', ['request_changes'], seen)] } });
    const token = await a.login();
    await settings(a, token, { reviewers: ['low'], levelRevisions: 1 });
    const job = await a.pull(propose());
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect(p.versions.map((v) => v.number)).toEqual([1, 2]);
    expect(p.versions[1]!.text).toContain('low: say which paint');
    expect(p.levelRevisions).toBe(1);
    expect(p.reviews.map((r) => [r.stage, r.verdict, r.version])).toEqual([['low', 'request_changes', 1], ['low', 'request_changes', 2]]);
    expect(seen.map((r) => r.version.number)).toEqual([1, 2]);
    const types = ofJob(await a.events(), job.id).map((e) => e.type);
    expect(types.filter((x) => x === 'proposal.submitted')).toHaveLength(2);
    expect(types.filter((x) => x === 'proposal.revision_requested')).toHaveLength(1);
  });
});

describe('a person signs off', () => {
  it('accept: who and when are recorded, the job ends, and proposal.accepted goes out as a webhook', async () => {
    receiver = await startReceiver();
    const a = await start({
      secrets: { WEBHOOK_SECRET_R: 's' },
      before: (db) => writeWebhooks(db, [{ name: 'r', url: receiver!.url, events: ['proposal.accepted'], secretEnv: 'WEBHOOK_SECRET_R' }]),
    });
    const token = await a.login();
    const job = await a.pull(propose());
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    const r = await decide(a, token, p.id, 'accept', { notes: 'go ahead' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'accepted', signOff: { decision: 'accept', stage: 'human', version: 1, notes: 'go ahead' } });
    expect(r.body.signOff!.by).toEqual(expect.any(String));
    expect(Date.parse(r.body.signOff!.at)).not.toBeNaN();
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'accept' } });
    const got = await waitFor(() => receiver!.received[0], { what: 'a proposal.accepted delivery' });
    expect(JSON.parse(got.body)).toMatchObject({ type: 'proposal.accepted', jobId: job.id, data: { proposalId: p.id, stage: 'human', version: 1 } });
    expect((await decide(a, token, p.id, 'reject', { notes: 'no' })).status).toBe(409);
  });

  it('reject needs a reason; the job ends with the rejection', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose());
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect((await decide(a, token, p.id, 'reject')).status).toBe(400);
    expect((await decide(a, token, p.id, 'reject', { notes: 'too costly' })).body).toMatchObject({ status: 'rejected', signOff: { decision: 'reject', notes: 'too costly' } });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'reject' } });
    expect(ofJob(await a.events(), job.id).find((e) => e.type === 'proposal.rejected')!.data).toMatchObject({ proposalId: p.id, notes: 'too costly' });
  });

  it('request changes: the job revises with the feedback, both versions are kept, and the new one is reviewed', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose());
    const p = await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect((await decide(a, token, p.id, 'request-changes')).status).toBe(400);
    expect((await decide(a, token, p.id, 'request-changes', { notes: 'use oil paint' })).body).toMatchObject({ status: 'revising' });
    const revised = await waitForProposal(a, job.id, (x) => x.versions.length === 2 && x.stage === 'human');
    expect(revised.status).toBe('open');
    expect(revised.versions[1]!.text).toContain('use oil paint');
    expect(revised.reviews).toEqual([expect.objectContaining({ stage: 'human', role: 'human', verdict: 'request_changes', notes: 'use oil paint', version: 1 })]);
  });

  it('an unknown proposal is 404', async () => {
    const a = await start();
    const token = await a.login();
    expect((await decide(a, token, 'nope', 'accept')).status).toBe(404);
  });
});

describe('the proposal settings', () => {
  it('live in the database, apply at once, and refuse a reviewer that is not an escalation level', async () => {
    const a = await start();
    const token = await a.login();
    const read = (await a.api('GET', '/api/proposals')).body;
    expect(read.settings).toEqual({ reviewers: [], signOff: 'owner', levelRevisions: 1, levels: ['opus', 'fable'] });
    expect((await settings(a, token, { reviewers: ['nobody'] })).status).toBe(400);
    expect((await settings(a, token, { signOff: 'anyone' })).status).toBe(400);
    expect((await settings(a, token, { levelRevisions: 99 })).status).toBe(400);
    const ok = await settings(a, token, { reviewers: ['fable', 'opus'], signOff: 'top-level' });
    expect(ok.body).toEqual({ reviewers: ['fable', 'opus'], signOff: 'top-level', levelRevisions: 1, levels: ['opus', 'fable'] });
    expect((await a.api('GET', '/api/proposals')).body.settings).toEqual(ok.body);
  });
});

describe('asking for a proposal', () => {
  it('a source item labelled hopper:proposal makes a job asked for a proposal', async () => {
    const a = await start();
    const job = await a.pull(propose(), { labels: ['hopper', 'hopper:proposal'] });
    expect(job.spec.proposal).toBe(true);
  });

  it('a person asks a job that has not started for a proposal; a started one cannot be', async () => {
    const a = await start();
    const token = await a.login();
    expect((await a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(200);
    const job = await a.pull(propose());
    await a.waitForStatus(job.id, 'held');
    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/propose`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.spec.proposal).toBe(true);
    await a.ui('/ui/api/queue/order', { jobIds: [job.id] }, { token });
    await waitForProposal(a, job.id, (x) => x.stage === 'human');
    expect((await a.ui(`/ui/api/jobs/${job.id}/propose`, {}, { token })).status).toBe(409);
  });
});

describe('the job and its proposal', () => {
  it('a high-priority job\'s proposal is tagged and listed first', async () => {
    const a = await start();
    const plain = await a.pull(propose());
    await waitForProposal(a, plain.id, (x) => x.stage === 'human');
    const urgent = await a.pull(propose(), { priority: 80, priorityReason: 'label:hopper:high' });
    await waitForProposal(a, urgent.id, (x) => x.stage === 'human');
    const open = (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=open')).body.items;
    expect(open.map((p) => [p.jobId, p.priority, p.high])).toEqual([[urgent.id, 80, true], [plain.id, 50, false]]);
  });

  it('a job cancelled while its proposal waits takes the proposal with it', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose());
    await waitForProposal(a, job.id, (x) => x.stage === 'human');
    await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token });
    await waitForProposal(a, job.id, (x) => x.status === 'cancelled');
  });
});
