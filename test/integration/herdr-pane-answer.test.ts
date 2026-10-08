// The owner answers a parked herdr-claude job by typing into its pane, not the UI (design.md
// "Questions" → "Answered in the pane"). The fake herdr stands in for the pane: the test calls
// `herdr.prompt` itself, as the owner's keyboard would. The hopper notices Claude working again,
// marks the question answered by the human with the typed text, aborts the answer chain, and
// watches the new turn on a lane (reattach) until the job ends.
import { afterEach, describe, expect, it } from 'vitest';
import type { LevelReply } from '../../src/domain/ports.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import type { AppSeams } from '../../src/main.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const ASK = { output: ['● Which colour should the shed be?', '  HOPPER_QUESTION'] };
const DONE = { steps: ['● Painting', '● Still painting', '● Almost'], output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };

async function start(herdr: FakeHerdrClient, seams: AppSeams = {}, laneCount = 4): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(laneCount) }, seams: { herdr, levels: [], ...seams } });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);

describe('a question answered by typing into the pane', () => {
  it('the question is answered by the human with the typed text, the job runs again and finishes; the hopper types nothing', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await start(herdr);
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const parked = await a.job(job.id);
    expect(parked.status).toBe('waiting_answer');
    const { agentName } = parked.executorState as { agentName: string };

    await herdr.prompt(agentName, 'Blue.');

    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed blue.') });
    const [after] = await a.questionsOf(job.id);
    expect(after).toMatchObject({ id: q.id, status: 'answered', answeredBy: 'human', answer: 'Blue.' });
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('Paint the shed'), 'Blue.']);
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'question.answered')!.data).toEqual({ questionId: q.id, by: 'human', answer: 'Blue.', via: 'pane', raisedBy: q.raisedBy });
    const reattached = events.find((e) => e.type === 'job.reattached')!;
    expect(reattached.data).toEqual({ reason: 'answered in the pane' });
    expect(reattached.laneId).toEqual(expect.any(String));
    const types = events.map((e) => e.type);
    expect(types.indexOf('question.answered')).toBeLessThan(types.indexOf('job.reattached'));
    expect(types.at(-1)).toBe('job.finished');
    expect(types.filter((x) => x === 'job.requeued')).toEqual([]);
  });

  it('the level in flight is aborted, as for a UI answer', async () => {
    const aborted: unknown[] = [];
    const level = createFakeLevel({
      name: 'drafter',
      script: (_req, signal) => new Promise<LevelReply>((resolve) => {
        signal.addEventListener('abort', () => { aborted.push(signal.reason); resolve({ answer: 'late', escalate: false, reason: 'late' }); }, { once: true });
      }),
    });
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await start(herdr, { levels: [level] });
    const job = await a.pull({}, item);
    await a.waitForQuestion(job.id, (x) => x.tier === 'drafter');
    const { agentName } = (await a.job(job.id)).executorState as { agentName: string };

    await herdr.prompt(agentName, 'Blue.');

    await a.waitForStatus(job.id, 'finished', 8000);
    await waitFor(() => aborted.length > 0, { what: 'the level aborted' });
    expect(aborted).toEqual(['superseded']);
    const [after] = await a.questionsOf(job.id);
    expect(after).toMatchObject({ status: 'answered', answeredBy: 'human', answer: 'Blue.' });
    expect(herdr.prompts.map((p) => p.text)).not.toContain('late');
  });

  it('no free lane: it runs anyway on one more lane, over the cap until it ends', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, { ...DONE, steps: Array.from({ length: 30 }, (_, i) => `● Plank ${i}`) }] });
    const a = await start(herdr, {}, 1);
    const job = await a.pull({}, item);
    await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const other = await a.pull({ op: 'sleep', ms: 4000 });
    await a.waitForStatus(other.id, 'running');
    const { agentName } = (await a.job(job.id)).executorState as { agentName: string };

    await herdr.prompt(agentName, 'Blue.');

    const running = await a.waitForStatus(job.id, 'running', 4000);
    const lanesNow = (await a.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; state: string; jobId?: string }[];
    expect(lanesNow.filter((l) => l.jobId === job.id || l.jobId === other.id).map((l) => l.jobId).sort()).toEqual([job.id, other.id].sort());
    expect(lanesNow.find((l) => l.jobId === job.id)!.id).toBe(running.laneId);
    await a.waitForStatus(job.id, 'finished', 8000);
  });
});

// Issue #376: Claude Code denies some dialogs by itself when their countdown runs out. Claude goes on, but
// nobody answered: the question lapsed, it was never answered by the human.
describe('a dialog Claude Code denies by itself', () => {
  const dialog = (countdown: string) => ({
    output: ['● Bash(rm -rf scratch)'],
    dialog: [' Bash command', '   rm -rf scratch', ` ⚠ Claude Code will automatically deny this request in ${countdown}, to avoid blocking progress on an unattended session`, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'],
    end: 'blocked' as const,
  });

  it('the question lapses, not answered by the human; the human was told when it would; the job goes on', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [dialog('0:01'), DONE] });
    const a = await start(herdr);
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.lapsesAt).toEqual(expect.any(String));
    const toHuman = (await ofJob(a, job.id)).find((e) => e.type === 'question.escalated_to_human')!;
    expect(toHuman.data).toMatchObject({ lapsesAt: q.lapsesAt });
    const { agentName } = (await a.job(job.id)).executorState as { agentName: string };
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(q.lapsesAt!) - Date.now())));

    herdr.lapseDialog(agentName);

    await a.waitForStatus(job.id, 'finished', 8000);
    const [after] = await a.questionsOf(job.id);
    expect(after).toMatchObject({ id: q.id, status: 'lapsed' });
    expect(after!.answeredBy).toBeUndefined();
    expect(after!.answer).toBeUndefined();
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'question.answered')).toBeUndefined();
    expect(events.find((e) => e.type === 'question.lapsed')!.data).toEqual({ questionId: q.id, lapsesAt: q.lapsesAt, raisedBy: q.raisedBy });
    expect(events.find((e) => e.type === 'job.reattached')!.data).toEqual({ reason: 'the dialog lapsed' });
    expect(herdr.prompts).toHaveLength(1);
  });

  it('an option picked in the pane before the countdown runs out is the human\'s answer', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [dialog('1:59'), DONE] });
    const a = await start(herdr);
    const job = await a.pull({}, item);
    await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const { paneId } = (await a.job(job.id)).executorState as { paneId: string };

    await herdr.sendText(paneId, '1');

    await a.waitForStatus(job.id, 'finished', 8000);
    const [after] = await a.questionsOf(job.id);
    expect(after).toMatchObject({ status: 'answered', answeredBy: 'human', answer: '(answered in the pane)' });
  });
});
