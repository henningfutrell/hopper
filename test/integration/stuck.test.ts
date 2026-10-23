// Stuck work (issue #1010): the Failures view counts every item that waits on a person by its stuck cause, and one press
// runs a cause's bulk action on each of its items, through the same path as its own button. Real daemon, real database;
// the manual source at its seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, JobWait, StuckActResult } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), plugins: { machines: lanes(2) } });
  apps.push(a);
  return a;
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const handoffOf = async (a: TestApp, jobId: string) =>
  waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === jobId && h.status === 'open'), { what: `job ${jobId} handed off` });

describe('Stuck work (issue #1010)', () => {
  it('counts the open hand-offs by cause, and one press runs the cause\'s action on each', async () => {
    const a = await boot();
    const token = await a.login();
    const one = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    const two = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    const h1 = await handoffOf(a, one.id);
    const h2 = await handoffOf(a, two.id);
    const view = await failuresOf(a);
    const cause = view.stuck.find((c) => c.ids.includes(h1.id))!;
    expect(cause).toMatchObject({ cause: h1.card.recommended === 'fixed' ? 'run_again' : h1.card.recommended, act: expect.any(String) });
    expect(cause.ids).toContain(h2.id);
    // Each item in one cause only.
    const ids = view.stuck.flatMap((c) => c.ids);
    expect(new Set(ids).size).toBe(ids.length);

    const r = await a.ui<StuckActResult>(`/ui/api/failures/stuck/${cause.cause}`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cause: cause.cause, refused: [] });
    expect([...r.body.done].sort()).toEqual([h1.id, h2.id].sort());
    // Answered at once (issue #1194): each give-back runs after, and closes its hand-off.
    const after = await waitFor(async () => {
      const v = await failuresOf(a);
      return v.handoffs.some((h) => h.status === 'open' && (h.id === h1.id || h.id === h2.id)) ? undefined : v;
    }, { what: 'both hand-offs closed' });
    expect(after.stuck.flatMap((c) => c.ids)).not.toContain(h1.id);
  });

  it('a job that only still waits is neither listed nor counted, also past its deadline with its agent ended; one whose wait broke is listed (issue #2684)', async () => {
    const a = await boot();
    const store = a.user().store;
    const later = new Date(Date.now() + 3600_000).toISOString(), since = new Date(Date.now() - 2 * 86400_000).toISOString();
    const seed = (check: Partial<NonNullable<JobWait['check']>>) => {
      const job = store.jobs.create({ executor: 'x', payload: {} }, 50);
      const wait: JobWait = { for: 'issue 9 to close', since, on: { kind: 'item', number: 9 }, check: { condition: { kind: 'none' }, nextCheckAt: later, everyMs: 3600_000, attempts: 30, deadline: since, overdueAt: since, ...check } };
      return store.jobs.update(job.id, { status: 'waiting_on', wait, waitReleased: { at: since, machineId: 'local' } });
    };
    const parked = seed({ result: 'not ended yet: issue 9' });
    const broken = seed({ result: 'the hopper cannot read the items now', brokenAt: since });
    const view = await failuresOf(a);
    expect(view.stuck.flatMap((c) => c.ids)).not.toContain(parked.id);
    expect(view.stuck.find((c) => c.cause === 'own_wait')?.ids).toEqual([broken.id]);
    const sections = (await a.api<{ sections: { kind: string; open: number }[] }>('GET', '/api/sections')).body.sections;
    expect(sections.find((x) => x.kind === 'failures')).toMatchObject({ open: 0 });
  });

  it('a cause with no bulk action, or none at all, is refused', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await a.ui(`/ui/api/failures/stuck/own_wait`, {}, { token })).status).toBe(400);
    expect((await a.ui(`/ui/api/failures/stuck/nonsense`, {}, { token })).status).toBe(400);
    // Nothing stuck: nothing done, nothing refused.
    const r = await a.ui<StuckActResult>(`/ui/api/failures/stuck/retry`, {}, { token });
    expect(r.body).toEqual({ cause: 'retry', done: [], refused: [] });
  });
});
