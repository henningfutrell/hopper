// Issue #2693: a job of an issue that ends on a proposal a person rejects made no pull request, so the rejection is no end:
// the same job goes back to the issue's work, in its session, told the outcome and the person's notes. A job of no issue
// still ends with the rejection as its result (issue #1659).
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewItemView } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { THREE_PATHS } from '../support/proposal-paths.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const propose = (message: string) => ({ op: 'propose', message });
const forPerson = (a: TestApp, jobId: string) => waitFor(async () => {
  const p = (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=all')).body.items.find((x) => x.jobId === jobId);
  return p?.status === 'open' && p.stage === 'human' ? p : undefined;
}, { what: `the proposal of job ${jobId} at a person` });
const reject = (a: TestApp, token: string, id: string, notes: string) => a.ui<ReviewItemView>(`/ui/api/proposals/${id}/reject`, { notes }, { token });

describe('a rejected proposal of an issue\'s job (issue #2693)', () => {
  it('sends the job back to the issue\'s work with the outcome, not to an end with no pull request', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS), { repo: 'o/r', number: 7 });
    const p = await forPerson(a, job.id);
    expect((await reject(a, token, p.id, 'use the other route')).body).toMatchObject({ status: 'rejected' });
    const done = await a.waitForStatus(job.id, 'finished');
    const told = (done.result as { answer: string }).answer;
    expect(told).toContain('proposal was rejected');
    expect(told).toContain('use the other route');
    expect(told).toContain('pull request');
    const events = (await a.events()).filter((e) => e.jobId === job.id);
    expect(events.find((e) => e.type === 'job.requeued')?.data).toMatchObject({ from: 'waiting_answer', reason: 'proposal rejected: back to the issue\'s work' });
  });

  it('a job of no issue still ends with the rejection', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS));
    const p = await forPerson(a, job.id);
    await reject(a, token, p.id, 'no');
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'reject' } });
  });
});
