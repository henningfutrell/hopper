// Research (issue #543, #538) over the real HTTP server and database: a section of its own, built from the same
// section model as Proposals. The scripted executor's `research` op comes back with a research report (and, resumed,
// the next round, or the proposal it is asked for next); reviewer levels are doubles at the EscalationLevel seam, and
// a person accepts, asks to dig deeper or steers through the UI session routes. An item structured with Research and
// Proposal headings is read into both sections: its job researches first, then proposes.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, ReviewItemView } from '../../src/domain/types.ts';
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

const REPORT = [
  'Question: what does the machine probe learn today?',
  'Findings: the home probe reads the home directory and the shell',
  'Sources: src/machines/probe.ts',
  'Confidence: high',
  'Open threads: credentials; containers',
  'Next step: a tool probe beside the home probe',
].join('\n');
const research = (message = REPORT) => ({ op: 'research', message });

type Section = 'research' | 'proposals';
const itemsOf = async (a: TestApp, section: Section, jobId: string): Promise<ReviewItemView[]> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', `/api/${section}?status=all`)).body.items.filter((p) => p.jobId === jobId);
const waitForItem = (a: TestApp, section: Section, jobId: string, ok: (p: ReviewItemView) => boolean) => waitFor(async () => {
  const p = (await itemsOf(a, section, jobId))[0];
  return p && ok(p) ? p : undefined;
}, { what: `a matching ${section} item on job ${jobId}` });
const forPerson = (p: ReviewItemView) => p.status === 'open' && p.stage === 'human';
const ofJob = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId);
const decide = (a: TestApp, token: string, section: Section, id: string, how: string, body: Record<string, unknown> = {}) =>
  a.ui<ReviewItemView>(`/ui/api/${section}/${id}/${how}`, body, { token });

describe('a job asked to research', () => {
  it('a source item labelled hopper:research makes a research job; its report waits on a person in Research, apart from questions and proposals', async () => {
    const a = await start();
    const job = await a.pull(research(), { labels: ['hopper', 'hopper:research'], title: 'machine reach' });
    expect(job.spec.research).toBe(true);
    const r = await waitForItem(a, 'research', job.id, forPerson);
    expect(r).toMatchObject({ kind: 'research', status: 'open', stage: 'human', priority: 50, high: false, source: { title: 'machine reach' } });
    expect(r.versions).toEqual([expect.objectContaining({
      number: 1, text: REPORT, missing: [],
      sections: {
        question: 'what does the machine probe learn today?', findings: 'the home probe reads the home directory and the shell',
        sources: 'src/machines/probe.ts', confidence: 'high', openThreads: 'credentials; containers', nextStep: 'a tool probe beside the home probe',
      },
    })]);
    expect(await a.job(job.id)).toMatchObject({ status: 'waiting_answer', researchId: r.id });
    expect(await a.questionsOf(job.id)).toEqual([]);
    expect(await itemsOf(a, 'proposals', job.id)).toEqual([]);
    expect((await a.api('GET', `/api/research/${r.id}`)).body).toMatchObject({ id: r.id, kind: 'research', status: 'open' });
    const events = ofJob(await a.events(), job.id);
    expect(events.find((e) => e.type === 'research.submitted')!.data).toMatchObject({ researchId: r.id, version: 1, missing: [], priority: 50, high: false });
    expect(events.filter((e) => e.type === 'research.escalated_to_human')).toHaveLength(1);
    expect(events.some((e) => e.type.startsWith('question.') || e.type.startsWith('proposal.'))).toBe(false);
  });

  it('dig deeper and steer start the next round in the same job; every round is kept with what led to it; accept ends the job', async () => {
    receiver = await startReceiver();
    const a = await start({
      secrets: { WEBHOOK_SECRET_R: 's' },
      before: (db) => writeWebhooks(db, [{ name: 'r', url: receiver!.url, events: ['research.accepted'], secretEnv: 'WEBHOOK_SECRET_R' }]),
    });
    const token = await a.login();
    const job = await a.pull(research(), { labels: ['hopper:research'] });
    const r = await waitForItem(a, 'research', job.id, forPerson);
    expect((await decide(a, token, 'research', r.id, 'dig-deeper', {})).body).toMatchObject({ status: 'revising' });
    const second = await waitForItem(a, 'research', job.id, (x) => x.versions.length === 2 && forPerson(x));
    expect(second.versions[1]!.text).toContain('Dig deeper');
    // Steering says where to go: never empty.
    expect((await decide(a, token, 'research', r.id, 'steer', {})).status).toBe(400);
    expect((await decide(a, token, 'research', r.id, 'steer', { notes: 'only the AWS side' })).body).toMatchObject({ status: 'revising' });
    const third = await waitForItem(a, 'research', job.id, (x) => x.versions.length === 3 && forPerson(x));
    expect(third.versions[2]!.text).toContain('only the AWS side');
    expect(third.reviews.map((x) => [x.verdict, x.version, x.role])).toEqual([['dig_deeper', 1, 'human'], ['steer', 2, 'human']]);
    const accepted = await decide(a, token, 'research', r.id, 'accept', { notes: 'enough' });
    expect(accepted.body).toMatchObject({ status: 'accepted', signOff: { decision: 'accept', stage: 'human', version: 3, notes: 'enough' } });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ research: { id: r.id, version: 3, decision: 'accept' } });
    const events = ofJob(await a.events(), job.id);
    expect(events.filter((e) => e.type === 'research.revision_requested').map((e) => e.data.decision)).toEqual(['dig_deeper', 'steer']);
    const got = await waitFor(() => receiver!.received[0], { what: 'a research.accepted delivery' });
    expect(JSON.parse(got.body)).toMatchObject({ type: 'research.accepted', jobId: job.id, data: { researchId: r.id, version: 3 } });
    // Research is never rejected: the server takes only the decisions the section declares.
    expect((await decide(a, token, 'research', r.id, 'reject', { notes: 'no' })).status).toBe(404);
    expect((await decide(a, token, 'research', r.id, 'accept')).status).toBe(409);
  });

  it('a reviewer level reviews a research report when the research settings name it; a reviewer that is no escalation level is refused', async () => {
    const seen: ReviewRequest[] = [];
    const level: EscalationLevel = createFakeLevel({
      name: 'low', script: () => ({ escalate: true, reason: 'never asked' }),
      review: (req) => { seen.push(req); return { verdict: 'approve', notes: 'well sourced' }; },
    });
    const a = await start({ seams: { levels: [level] } });
    const token = await a.login();
    expect((await a.ui('/ui/api/research/settings', { reviewers: ['nobody'] }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/research/settings', { reviewers: ['low'] }, { token })).body).toMatchObject({ reviewers: ['low'], levels: ['low'] });
    expect((await a.api('GET', '/api/proposals')).body.settings).toMatchObject({ reviewers: [] });
    const job = await a.pull(research(), { labels: ['hopper:research'] });
    const r = await waitForItem(a, 'research', job.id, forPerson);
    expect(r.reviews.map((x) => [x.stage, x.verdict])).toEqual([['low', 'approve']]);
    expect(seen[0]).toMatchObject({ kind: 'research', level: { number: 1, of: 1 }, version: { number: 1, text: REPORT } });
  });

  it('a high-priority job\'s report is tagged and listed first; a job cancelled while its report waits takes the report with it', async () => {
    const a = await start();
    const token = await a.login();
    const plain = await a.pull(research(), { labels: ['hopper:research'] });
    await waitForItem(a, 'research', plain.id, forPerson);
    const urgent = await a.pull(research(), { labels: ['hopper:research'], priority: 80, priorityReason: 'label:hopper:high' });
    await waitForItem(a, 'research', urgent.id, forPerson);
    const open = (await a.api<{ items: ReviewItemView[] }>('GET', '/api/research?status=open')).body.items;
    expect(open.map((p) => [p.jobId, p.priority, p.high])).toEqual([[urgent.id, 80, true], [plain.id, 50, false]]);
    await a.ui(`/ui/api/jobs/${plain.id}/cancel`, {}, { token });
    await waitForItem(a, 'research', plain.id, (x) => x.status === 'cancelled');
    expect(ofJob(await a.events(), plain.id).some((e) => e.type === 'research.cancelled')).toBe(true);
  });

  it('a person asks a job that has not started to research first', async () => {
    const a = await start();
    const token = await a.login();
    expect((await a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(200);
    const job = await a.pull(research());
    await a.waitForStatus(job.id, 'held');
    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/research`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.spec.research).toBe(true);
    expect(ofJob(await a.events(), job.id).find((e) => e.type === 'research.asked')!.data).toEqual({ by: 'user' });
  });
});

describe('an item structured with Research and Proposal sections', () => {
  const BODY = [
    '## Proposal', '', '**Goal.** Know what each machine can reach.', '',
    '## Research', '', '- **R1.** What the machine probe learns today.', '',
    '## Special jobs (inferred)', '', '- **S1.** A discovery probe job.',
  ].join('\n');

  it('is read into both sections: its job researches first, and once the research is accepted it writes the proposal', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(research(), { body: BODY, labels: ['hopper'] });
    expect(job.spec).toMatchObject({ research: true, proposal: true });
    const r = await waitForItem(a, 'research', job.id, forPerson);
    expect(await itemsOf(a, 'proposals', job.id)).toEqual([]);
    expect((await decide(a, token, 'research', r.id, 'accept')).body).toMatchObject({ status: 'accepted' });
    // Accepted research moves the job on to the next section it asks for: the proposal, in the same job.
    const p = await waitForItem(a, 'proposals', job.id, forPerson);
    expect(p.versions[0]!.sections.goal).toBe('act on the research');
    expect(await a.job(job.id)).toMatchObject({ status: 'waiting_answer', researchId: r.id, proposalId: p.id });
    expect((await decide(a, token, 'proposals', p.id, 'accept')).status).toBe(200);
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({
      research: { id: r.id, version: 1, decision: 'accept' }, proposal: { id: p.id, version: 1, decision: 'accept' },
    });
    const types = ofJob(await a.events(), job.id).map((e) => e.type);
    expect(types.indexOf('research.accepted')).toBeLessThan(types.indexOf('proposal.submitted'));
  });
});

describe('the sections', () => {
  it('GET /api/sections lists every section type with its open items, the ones waiting on a person, and how many are high priority', async () => {
    const a = await start();
    const job = await a.pull(research(), { labels: ['hopper:research'], priority: 80, priorityReason: 'label:hopper:high' });
    await waitForItem(a, 'research', job.id, forPerson);
    const { sections } = (await a.api<{ sections: { kind: string; label: string; open: number; waiting: number; high: number; events: string[] }[] }>('GET', '/api/sections')).body;
    expect(sections.map((s) => s.kind)).toEqual(['questions', 'proposals', 'research', 'logins', 'failures']);
    expect(sections.find((s) => s.kind === 'research')).toMatchObject({ label: 'Research', open: 1, waiting: 1, high: 1 });
    expect(sections.find((s) => s.kind === 'proposals')).toMatchObject({ label: 'Proposals', open: 0, waiting: 0, high: 0 });
    expect(sections.find((s) => s.kind === 'research')!.events).toContain('research.accepted');
    expect(sections.find((s) => s.kind === 'questions')!.events).toContain('question.asked');
  });
});
