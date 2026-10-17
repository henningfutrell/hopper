// Issue #1659: a person rejects a whole proposal — with paths or with none, with a note or without, while a reviewer
// level holds it, or while its job writes the next version. It ends rejected, its job ends, and the decision is on its
// trail. Several are rejected at once, each with its own result: one that cannot be rejected does not stop the rest.
import { afterEach, describe, expect, it } from 'vitest';
import type { EscalationLevel } from '../../src/domain/ports.ts';
import type { ReviewItemView } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { NO_PATHS, THREE_PATHS } from '../support/proposal-paths.ts';
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

const propose = (message: string, ms?: number) => ({ op: 'propose', message, ...(ms ? { ms } : {}) });
const proposalOf = async (a: TestApp, jobId: string): Promise<ReviewItemView | undefined> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=all')).body.items.find((p) => p.jobId === jobId);
const waitForProposal = (a: TestApp, jobId: string, ok: (p: ReviewItemView) => boolean) => waitFor(async () => {
  const p = await proposalOf(a, jobId);
  return p && ok(p) ? p : undefined;
}, { what: `a matching proposal on job ${jobId}` });
const forPerson = (a: TestApp, jobId: string) => waitForProposal(a, jobId, (p) => p.status === 'open' && p.stage === 'human');
const reject = (a: TestApp, token: string, id: string, body: Record<string, unknown> = {}) => a.ui<ReviewItemView>(`/ui/api/proposals/${id}/reject`, body, { token });

describe('reject a whole proposal', () => {
  it('with paths and no note: it ends rejected, and its job ends with the rejection', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS));
    const p = await forPerson(a, job.id);
    const r = await reject(a, token, p.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', signOff: { decision: 'reject', stage: 'human' } });
    expect(r.body.signOff!.notes).toBeUndefined();
    expect(r.body.reviews.at(-1)).toMatchObject({ role: 'human', verdict: 'reject' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'reject' } });
  });

  it('with zero paths: it ends rejected with the note', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(NO_PATHS));
    const p = await forPerson(a, job.id);
    expect((await reject(a, token, p.id, { notes: 'not now' })).body).toMatchObject({ status: 'rejected', signOff: { decision: 'reject', notes: 'not now' } });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'reject' } });
  });

  it('while a reviewer level holds it: the level is stopped, and the proposal and its job end', async () => {
    let aborted = false;
    const level: EscalationLevel = createFakeLevel({
      name: 'fable',
      script: () => ({ escalate: true, reason: 'never asked' }),
      review: (_req, signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve({ error: 'stopped' }); })),
    });
    const a = await start({ seams: { levels: [level] } });
    const token = await a.login();
    await a.ui('/ui/api/proposals/settings', { reviewers: ['fable'] }, { token });
    const job = await a.pull(propose(THREE_PATHS));
    const p = await waitForProposal(a, job.id, (x) => x.status === 'open' && x.stage === 'fable');
    expect((await reject(a, token, p.id)).body).toMatchObject({ status: 'rejected', signOff: { decision: 'reject', stage: 'human' } });
    expect(aborted).toBe(true);
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'reject' } });
    expect((await proposalOf(a, job.id))!.reviews.filter((r) => r.stage === 'fable')).toEqual([]);
  });

  it('while its job writes the next version: it ends rejected, and its job ends', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS, 3000));
    const p = await forPerson(a, job.id);
    expect((await a.ui(`/ui/api/proposals/${p.id}/steer`, { notes: 'a cheaper one' }, { token })).body).toMatchObject({ status: 'revising' });
    expect((await reject(a, token, p.id)).body).toMatchObject({ status: 'rejected', versions: [expect.anything()] });
    await a.waitForStatus(job.id, 'cancelled');
    expect((await proposalOf(a, job.id))!.status).toBe('rejected');
  });

  it('a proposal already decided is refused with its reason', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS));
    const p = await forPerson(a, job.id);
    await reject(a, token, p.id);
    const again = await reject(a, token, p.id);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('is rejected');
  });
});

describe('reject several proposals at once', () => {
  it('rejects each one; one that is not open reports its own error and does not stop the rest', async () => {
    const a = await start();
    const token = await a.login();
    const jobs = [await a.pull(propose(THREE_PATHS)), await a.pull(propose(NO_PATHS)), await a.pull(propose(THREE_PATHS))];
    const ps = await Promise.all(jobs.map((j) => forPerson(a, j.id)));
    await reject(a, token, ps[2]!.id);
    const r = await a.ui<{ results: { id: string; ok: boolean; status?: number; error?: string; item?: ReviewItemView }[] }>(
      '/ui/api/proposals/reject', { ids: ps.map((p) => p.id), notes: 'not this year' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x) => [x.id, x.ok, x.item?.status, x.status])).toEqual([
      [ps[0]!.id, true, 'rejected', undefined], [ps[1]!.id, true, 'rejected', undefined], [ps[2]!.id, false, undefined, 409],
    ]);
    expect(r.body.results[2]!.error).toContain('is rejected');
    expect(r.body.results[0]!.item!.signOff).toMatchObject({ decision: 'reject', notes: 'not this year' });
    for (const j of jobs) await a.waitForStatus(j.id, 'finished');
  });

  it('names each item once, at least one', async () => {
    const a = await start();
    const token = await a.login();
    expect((await a.ui('/ui/api/proposals/reject', { ids: [] }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/proposals/reject', { ids: ['x', 'x'] }, { token })).status).toBe(400);
    const missing = await a.ui<{ results: { ok: boolean; status: number }[] }>('/ui/api/proposals/reject', { ids: ['nope'] }, { token });
    expect(missing.body.results).toEqual([expect.objectContaining({ ok: false, status: 404 })]);
  });
});
