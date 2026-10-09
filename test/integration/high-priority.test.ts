// Issue #535: a high-priority job is tagged and first wherever it waits, through the real daemon, store and HTTP
// server. Its question and login sort first and carry its priority in the API and in their events (webhooks send
// events as they are); its failure and hand-off carry it too; a label change follows everywhere at the next sync,
// a started job's too, without a restart.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job, LoginView, Question } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(4) }, seams: { levels: [] } });
  return t;
}

const HIGH = { priority: 80, priorityReason: 'label:hopper:high' };
type Tagged<T> = T & { priority: number; high: boolean };

const openQuestions = async (a: TestApp) => (await a.api<{ questions: Tagged<Question>[] }>('GET', '/api/questions?status=open')).body.questions;

describe('high priority, everywhere', () => {
  it('a high-priority job\'s question sorts first and carries its priority in the API and its events', async () => {
    const a = await start();
    const plain = await a.pull({ op: 'ask', message: 'plain?' });
    await a.waitForQuestion(plain.id, (q) => q.tier === 'human');
    const urgent = await a.pull({ op: 'ask', message: 'urgent?' }, HIGH);
    await a.waitForQuestion(urgent.id, (q) => q.tier === 'human');

    const qs = await openQuestions(a);
    expect(qs.map((q) => [q.jobId, q.priority, q.high])).toEqual([[urgent.id, 80, true], [plain.id, 50, false]]);
    const one = (await a.api<Tagged<Question>>('GET', `/api/questions/${qs[0]!.id}`)).body;
    expect(one).toMatchObject({ priority: 80, high: true });

    const events = await a.events('types=question.asked,question.escalated,question.escalated_to_human');
    for (const e of events.filter((x) => x.jobId === urgent.id)) expect(e.data, e.type).toMatchObject({ priority: 80, high: true });
    for (const e of events.filter((x) => x.jobId === plain.id)) expect(e.data, e.type).toMatchObject({ priority: 50, high: false });
  });

  it('a label change re-sorts at the next sync, a job on a question too, without a restart', async () => {
    const a = await start();
    const first = await a.pull({ op: 'ask', message: 'first?' });
    await a.waitForQuestion(first.id, (q) => q.tier === 'human');
    const second = await a.pull({ op: 'ask', message: 'second?' }, HIGH);
    await a.waitForQuestion(second.id, (q) => q.tier === 'human');
    expect((await openQuestions(a)).map((q) => q.jobId)).toEqual([second.id, first.id]);

    // hopper:high moves from the second issue to the first.
    a.source.add(manualItem({ key: first.source!.key, prompt: JSON.stringify({ op: 'ask', message: 'first?' }), ...HIGH }));
    a.source.add(manualItem({ key: second.source!.key, prompt: JSON.stringify({ op: 'ask', message: 'second?' }), priority: 50 }));
    await a.sync();

    expect((await a.job(first.id)).priority).toBe(80);
    expect((await a.job(second.id)).priority).toBe(50);
    expect((await openQuestions(a)).map((q) => [q.jobId, q.high])).toEqual([[first.id, true], [second.id, false]]);
    const moved = (await a.events('types=job.reprioritized')).map((e) => [e.jobId, e.data.from, e.data.to]);
    expect(moved).toEqual(expect.arrayContaining([[first.id, 50, 80], [second.id, 80, 50]]));
  });

  it('a high-priority job\'s login is listed first and carries its priority', async () => {
    const a = await start();
    const plain = await a.pull({ op: 'sleep', ms: 30_000 });
    const urgent = await a.pull({ op: 'sleep', ms: 30_000 }, HIGH);
    await a.waitForStatus(plain.id, 'running');
    const running = await a.waitForStatus(urgent.id, 'running');
    const { logins } = a.user();
    const report = (tool: string) => ({ kind: 'device_code' as const, tool, verificationUrl: 'https://github.com/login/device', userCode: 'ABCD-1234', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    logins.report(report('gh'), { jobId: plain.id, run: 'scripted', renewable: false });
    logins.report(report('claude'), { jobId: urgent.id, laneId: running.laneId!, run: 'scripted', renewable: false });

    const listed = (await a.api<{ logins: Tagged<LoginView>[] }>('GET', '/api/logins?status=open')).body.logins;
    expect(listed.map((l) => [l.jobId, l.priority, l.high])).toEqual([[urgent.id, 80, true], [plain.id, 50, false]]);
    const pending = await a.events('types=auth.pending');
    expect(pending.find((e) => e.jobId === urgent.id)!.data).toMatchObject({ priority: 80, high: true });
    expect(pending.find((e) => e.jobId === plain.id)!.data).toMatchObject({ priority: 50, high: false });
  });

  it('a high-priority job\'s failure and hand-off carry its priority, and so does its job.failed', async () => {
    const a = await start();
    const job: Job = await a.pull({ op: 'fail', message: 'invalid payload: no body' }, HIGH);
    await a.waitForStatus(job.id, 'failed');
    const view = await waitFor(async () => {
      const v = (await a.api<FailuresView>('GET', '/api/failures')).body;
      return v.handoffs.some((h) => h.jobId === job.id) ? v : undefined;
    });
    expect(view.handoffs.find((h) => h.jobId === job.id)).toMatchObject({ priority: 80, high: true });
    expect(view.recent.find((r) => r.jobId === job.id)).toMatchObject({ priority: 80, high: true });
    const failed = (await a.events('types=job.failed,job.assessed,handoff.opened')).filter((e) => e.jobId === job.id);
    expect(failed.map((e) => e.type).sort()).toEqual(['handoff.opened', 'job.assessed', 'job.failed']);
    for (const e of failed) expect(e.data, e.type).toMatchObject({ priority: 80, high: true });
  });

  it('the queue answers the high-priority threshold, so every list of jobs tags them alike', async () => {
    const a = await start();
    expect((await a.api('GET', '/api/queue')).body.highPriority).toBe(75);
  });
});
