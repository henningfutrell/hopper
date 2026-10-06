// Nothing hangs on a question and everything runs in parallel (design.md "The engine" →
// "Parallel by default", "Questions"). The tick is set out of reach (10 min), so every Decision
// here was woken by an event: a pass proves the engine reacts to the event, not to a timer.
// Characterization (T005, 2026-10-03): these held on main at 7052964; they pin the behaviour.
import { afterEach, describe, expect, it } from 'vitest';
import type { LevelReply, SourceItem } from '../../src/domain/ports.ts';
import type { Decision, DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const NO_TICK = { HOPPER_TICK_MS: '600000' };

async function start(laneCount: number, o: Omit<Parameters<typeof startTestApp>[0], 'dbPath' | 'env'> = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env: NO_TICK, ...o, plugins: { machines: lanes(laneCount), ...(o.plugins || {}) } });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** Offer every script as its own item, then one sync: the jobs arrive together. */
async function pullAll(a: TestApp, scripts: Array<Record<string, unknown> | Partial<SourceItem>>, herdr = false): Promise<Job[]> {
  // Descending priority: the order the jobs claim lanes is the order given.
  const items = scripts.map((s, i) => manualItem({ priority: 90 - i, ...(herdr ? s as Partial<SourceItem> : { prompt: JSON.stringify(s) }) }));
  for (const item of items) a.source.add(item);
  await a.sync();
  const jobs = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
  return items.map((i) => jobs.find((j) => j.source?.key === i.key)!);
}

const decisions = async (a: TestApp): Promise<Decision[]> => (await a.api<{ decisions: Decision[] }>('GET', '/api/decisions?limit=1000')).body.decisions;
const ofType = async (a: TestApp, type: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.type === type);

/** A level that replies only when the test lets it, and records whether it was aborted. */
function heldLevel() {
  let release: ((d: LevelReply) => void) | undefined;
  const aborted: unknown[] = [];
  const level = createFakeLevel({
    name: 'drafter',
    script: (_req, signal) => new Promise<LevelReply>((resolve) => {
      release = resolve;
      signal.addEventListener('abort', () => { aborted.push(signal.reason); resolve({ answer: 'late answer', escalate: false, reason: 'late' }); }, { once: true });
    }),
  });
  return { level, aborted, started: () => release !== undefined, release: (d: LevelReply) => release?.(d) };
}

describe('everything runs in parallel', () => {
  it('N free lanes and N queued jobs: all N are claimed and run at once, each as soon as the router advised it', async () => {
    const a = await start(4);
    const jobs = await pullAll(a, [1, 2, 3, 4].map(() => ({ op: 'sleep', ms: 3000 })));
    await waitFor(() => a.scripted.payloads.length === 4, { what: '4 executors started' });
    expect((await ofType(a, 'job.started')).map((e) => e.jobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    const claimed = await ofType(a, 'job.claimed');
    expect(claimed.map((e) => e.jobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    // The router's advice is applied (issue #211): a Decision claims every job advised by then, so the
    // claims may span Decisions as the advice arrives — but no Decision with room holds an advised job.
    for (const d of await decisions(a)) expect(d.hold.filter((h) => h.reason.startsWith('all lanes busy'))).toEqual([]);
    expect((await a.api<{ running: Job[] }>('GET', '/api/queue')).body.running).toHaveLength(4);
  });

  it('more queued than lanes: every lane fills; the rest are held for lanes alone', async () => {
    const a = await start(2);
    const jobs = await pullAll(a, [1, 2, 3].map(() => ({ op: 'sleep', ms: 3000 })));
    await waitFor(async () => (await a.api<{ running: Job[] }>('GET', '/api/queue')).body.running.length === 2, { what: '2 running' });
    const third = await waitFor(async () => { const j = await a.job(jobs[2]!.id); return j.status === 'held' ? j : undefined; });
    expect(third.holdReason).toBe('all lanes busy (cap 2)');
  });
});

describe('a question frees its lane at once', () => {
  it('the parked job\'s lane goes to the next queued job in the Decision the question woke', async () => {
    const held = heldLevel();
    const a = await start(1, { seams: { levels: [held.level] } });
    const [asker, next] = await pullAll(a, [{ op: 'ask', message: 'Which colour?', ms: 100 }, { op: 'sleep', ms: 3000 }]);
    await waitFor(async () => (await a.job(next!.id)).status === 'running', { what: 'next job running', timeoutMs: 3000 });
    expect((await a.job(asker!.id)).status).toBe('waiting_answer');
    const claims = await ofType(a, 'job.claimed');
    const askerLane = claims.find((e) => e.jobId === asker!.id)!.laneId;
    const nextClaim = claims.find((e) => e.jobId === next!.id)!;
    expect(nextClaim.laneId).toBe(askerLane);
    expect(held.started()).toBe(true); // the level is still working: nothing waited on it
  });
});

describe('a herdr-claude question frees its lane at once', () => {
  it('the parked pane stays open; the next herdr job runs on the same lane while a level works on the question', async () => {
    const herdr = createFakeHerdrClient({
      session: 'jh-test',
      turns: [{ output: ['● Which colour should the shed be?', '  HOPPER_QUESTION'] }, { steps: ['● Working'], output: [], end: 'working' }],
    });
    const held = heldLevel();
    const a = await start(
      1,
      { seams: { herdr, levels: [held.level] }, plugins: { executors: [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }] } },
    );
    const herdrItem = (prompt: string) => ({ executor: 'herdr-claude', prompt, cwd: '/tmp', env: {} });
    const [asker, next] = await pullAll(a, [herdrItem('Paint the shed'), herdrItem('Mow the lawn')], true);
    await waitFor(async () => (await a.job(next!.id)).status === 'running' && herdr.prompts.length === 2, { what: 'next job prompted', timeoutMs: 4000 });
    const parked = await a.job(asker!.id);
    expect(parked.status).toBe('waiting_answer');
    expect(parked.laneId).toBeUndefined();
    expect(herdr.closed).toEqual([]);
    const claims = await ofType(a, 'job.claimed');
    const nextClaim = claims.find((e) => e.jobId === next!.id)!;
    expect(nextClaim.laneId).toBe(claims.find((e) => e.jobId === asker!.id)!.laneId);
    const lanes = (await a.api('GET', '/api/machines')).body.machines[0].lanes;
    expect(lanes).toEqual([expect.objectContaining({ id: nextClaim.laneId, state: 'busy', jobId: next!.id })]);
  });
});

describe('a question is the owner\'s the moment it is asked', () => {
  it('visible and answerable in the UI while a level works on it; their answer wins and aborts the climb', async () => {
    const held = heldLevel();
    const judged: string[] = [];
    const judge = createFakeLevel({ name: 'judge', script: (req) => { judged.push(req.question.text); return { answer: 'fine', escalate: false, reason: 'fine' }; } });
    const a = await start(1, { seams: { levels: [held.level, judge] } });
    const token = await a.login();
    const [job] = await pullAll(a, [{ op: 'ask', message: 'Tabs or spaces?' }]);
    const q = await waitFor(async () => (await a.api<{ questions: Question[] }>('GET', '/api/questions')).body.questions.find((x) => x.jobId === job!.id));
    expect(q).toMatchObject({ status: 'open', tier: 'drafter', text: 'Tabs or spaces?' });
    expect((await a.api('GET', '/api/queue')).body.waitingAnswer.map((j: Job) => j.id)).toEqual([job!.id]);
    await waitFor(() => held.started());

    const res = await a.ui<Question>(`/ui/api/questions/${q.id}/answer`, { answer: 'tabs' }, { token });
    expect(res.status).toBe(200);
    expect((await a.waitForStatus(job!.id, 'finished')).result).toEqual({ answer: 'tabs' });
    await waitFor(() => held.aborted.length > 0, { what: 'the level aborted' });
    expect(held.aborted).toEqual(['superseded']);
    const after = await a.waitForQuestion(job!.id, (x) => x.attempts.some((t) => t.reason === 'superseded'));
    expect(after).toMatchObject({ status: 'answered', answeredBy: 'human', answer: 'tabs' });
    expect(after.attempts.map((t) => [t.tier, t.outcome, t.reason])).toEqual([['human', 'accepted', undefined], ['drafter', 'escalated', 'superseded']]);
    expect(judged).toEqual([]);
    // The escalation gate is untouched: the owner answered first, so nothing was pushed.
    expect((await ofType(a, 'question.escalated')).map((e) => e.data.target)).toEqual(['drafter']);
  });
});
