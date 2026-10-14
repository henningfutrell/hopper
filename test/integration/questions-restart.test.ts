// Restart recovery for phase 2 (design.md "Recovery at startup"): two app instances over one
// database, sharing one manual source. The store is opened directly only to stage a crash
// window no API can produce.
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSeams } from '../../src/main.ts';
import { openAdminStore } from '../support/files.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createStickyExecutor } from '../support/doubles.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

let source = createManualSource();

async function boot(dbPath: string, o: { env?: Record<string, string>; seams?: AppSeams } = {}) {
  const a = await startTestApp({ dbPath, source, ...o });
  apps.push(a);
  return a;
}

function freshDb(): string {
  source = createManualSource();
  const db = tempDbPath();
  cleanup = db.cleanup;
  return db.dbPath;
}

describe('restart with questions', () => {
  it('keeps a waiting job and its open human question; answering after restart resumes it', async () => {
    const dbPath = freshDb();
    const first = await boot(dbPath);
    const job = await first.pull({ op: 'ask', message: 'Is this risky?' });
    const q = await first.waitForQuestion(job.id, (x) => x.tier === 'human');
    await first.stop();

    const second = await boot(dbPath);
    expect((await second.job(job.id)).status).toBe('waiting_answer');
    expect((await second.api('GET', '/api/questions')).body.questions.map((x: { id: string }) => x.id)).toEqual([q.id]);
    const token = await second.login();
    expect((await second.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'after restart' }, { token })).status).toBe(200);
    expect((await second.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'after restart' });
  });

  it('requeues a job whose question was answered but the job not yet requeued', async () => {
    const dbPath = freshDb();
    const first = await boot(dbPath);
    const job = await first.pull({ op: 'ask', message: 'Is this risky?' });
    const q = await first.waitForQuestion(job.id, (x) => x.tier === 'human');
    await first.stop();
    // The crash window B3 guards against: question answered, job still waiting_answer.
    const store = openAdminStore(databaseUrlFor(dbPath));
    store.questions.update(q.id, { status: 'answered', answer: 'answered in the gap', answeredBy: 'human' });
    store.close();

    const second = await boot(dbPath);
    expect((await second.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'answered in the gap' });
    const requeued = (await second.events()).find((e) => e.type === 'job.requeued' && e.jobId === job.id);
    expect(requeued!.data).toEqual({ from: 'waiting_answer', reason: 'answered' });
  });

  it('fails a waiting job whose question was cancelled while the daemon was down', async () => {
    const dbPath = freshDb();
    const first = await boot(dbPath);
    const job = await first.pull({ op: 'ask', message: 'Is this risky?' });
    const q = await first.waitForQuestion(job.id, (x) => x.tier === 'human');
    await first.stop();
    const store = openAdminStore(databaseUrlFor(dbPath));
    store.questions.update(q.id, { status: 'cancelled' });
    store.close();

    const second = await boot(dbPath);
    expect((await second.waitForStatus(job.id, 'failed')).error).toBe('question cancelled');
  });

  it('keeps the pending answer of an idempotent job interrupted mid-resume', async () => {
    const dbPath = freshDb();
    const first = await boot(dbPath);
    const job = await first.pull({ op: 'ask', message: 'Is this risky?', ms: 600 });
    const q = await first.waitForQuestion(job.id, (x) => x.tier === 'human', 5000);
    expect((await first.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'kept' }, { token: await first.login() })).status).toBe(200);
    await waitFor(async () => (await first.job(job.id)).status === 'running');
    await first.stop();

    const second = await boot(dbPath);
    const done = await second.waitForStatus(job.id, 'finished', 8000);
    expect(done.result).toEqual({ answer: 'kept' });
    expect(done.pendingAnswer).toBeUndefined();
  });

  it('fails and cleans up a non-idempotent running job at restart, never re-running it', async () => {
    const dbPath = freshDb();
    const sticky = createStickyExecutor();
    const first = await boot(dbPath, { seams: { executors: [sticky] } });
    const job = await first.pull({}, { executor: 'sticky' });
    await first.waitForStatus(job.id, 'running');
    await first.stop();
    expect(sticky.abortReasons).toEqual(['shutdown']);
    expect(sticky.cleaned).toEqual([]);

    const second = await boot(dbPath, { seams: { executors: [sticky] } });
    const failed = await second.waitForStatus(job.id, 'failed');
    expect(failed.error).toBe('interrupted by daemon restart');
    await waitFor(() => sticky.cleaned.includes(job.id));
    await new Promise((r) => setTimeout(r, 200));
    expect(sticky.runs).toEqual([job.id]);
    const failedEvent = (await second.events()).find((e) => e.type === 'job.failed' && e.jobId === job.id);
    expect(failedEvent!.data).toEqual({ error: 'interrupted by daemon restart', priority: 50, high: false });
  });

  it('cancelling a running job aborts it with reason cancel and cleans it up', async () => {
    const dbPath = freshDb();
    const sticky = createStickyExecutor();
    const a = await boot(dbPath, { seams: { executors: [sticky] } });
    const job = await a.pull({}, { executor: 'sticky' });
    await a.waitForStatus(job.id, 'running');
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: await a.login() })).status).toBe(200);
    await a.waitForStatus(job.id, 'cancelled');
    expect(sticky.abortReasons).toEqual(['cancel']);
    await waitFor(() => sticky.cleaned.includes(job.id));
  });

  it('HOPPER_KEEP_PANES=true skips cleanup on terminal outcomes', async () => {
    const dbPath = freshDb();
    const sticky = createStickyExecutor();
    const a = await boot(dbPath, { env: { HOPPER_KEEP_PANES: 'true' }, seams: { executors: [sticky] } });
    const job = await a.pull({}, { executor: 'sticky' });
    await a.waitForStatus(job.id, 'running');
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: await a.login() })).status).toBe(200);
    await a.waitForStatus(job.id, 'cancelled');
    await new Promise((r) => setTimeout(r, 100));
    expect(sticky.cleaned).toEqual([]);
  });
});
