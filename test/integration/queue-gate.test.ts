// Issue #159: the queue gate through the real daemon. A new job waits at the gate until it is
// accepted: by the pre-sort (the queue sorter's order and rejections) when the gate auto-accepts,
// else by the user, who moves it into the user order. A rejected job is not deleted: it ends
// `rejected`, its source is told, and its item is not offered again. Auto-accept is throttled by
// `autoAcceptPerHour`; past it, a new job waits for the user.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function boot(plugins: Record<string, unknown> = {}, before?: (dataDir: string) => void): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  before?.(join(db.dbPath, '..'));
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1), ...plugins } });
  return t;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setGate(a: TestApp, token: string, gate: { mode: string; autoAcceptPerHour: number | null }) {
  const r = await a.ui<{ gate: unknown }>('/ui/api/queue-gate', gate, { token });
  expect(r.status).toBe(200);
  expect(r.body.gate).toEqual(gate);
}

const queue = async (a: TestApp) => (await a.api('GET', '/api/queue')).body;

describe('the queue gate', () => {
  it('by default the gate auto-accepts: the pre-sort accepts a new job and it runs', async () => {
    const a = await boot();
    expect((await queue(a)).gate).toEqual({ mode: 'auto-accept', autoAcceptPerHour: null });
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const accepted = await a.events('types=job.accepted');
    expect(accepted.find((e) => e.jobId === job.id)?.data).toEqual({ by: 'pre-sort' });
  });

  it('review: a new job waits unaccepted, listed in the pre-sort, until the user orders it', async () => {
    const a = await boot();
    const token = await a.login();
    await setGate(a, token, { mode: 'review', autoAcceptPerHour: null });
    const job = await a.pull({ op: 'echo' });
    const held = await a.waitForStatus(job.id, 'held');
    expect(held).toMatchObject({ accepted: false, holdReason: 'awaiting acceptance' });
    expect((await queue(a)).presort).toMatchObject({ sorter: 'priority', jobIds: [job.id], reject: [] });

    const r = await a.ui('/ui/api/queue/order', { jobIds: [job.id] }, { token });
    expect(r.status).toBe(200);
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.accepted).toBe(true);
    expect((await a.events('types=job.accepted')).find((e) => e.jobId === job.id)?.data).toEqual({ by: 'user' });
    expect((await a.events('types=queue.ordered')).at(-1)?.data).toEqual({ jobIds: [job.id] });
  });

  it('the user order runs before the sorter\'s: a low-priority job ordered first starts first', async () => {
    const a = await boot();
    const token = await a.login();
    await setGate(a, token, { mode: 'review', autoAcceptPerHour: null });
    const blocker = await a.pull({ op: 'sleep', ms: 30000 });
    expect((await a.ui('/ui/api/queue/order', { jobIds: [blocker.id] }, { token })).status).toBe(200);
    await a.waitForStatus(blocker.id, 'running');
    const high = await a.pull({ op: 'echo' }, { priority: 90 });
    await pause(5);
    const low = await a.pull({ op: 'echo' }, { priority: 10 });
    expect((await queue(a)).presort.jobIds).toEqual([high.id, low.id]);

    expect((await a.ui('/ui/api/queue/order', { jobIds: [low.id, high.id] }, { token })).status).toBe(200);
    expect((await queue(a)).waiting.map((j: Job) => j.id)).toEqual([low.id, high.id]);
    expect((await a.ui(`/ui/api/jobs/${blocker.id}/cancel`, {}, { token })).status).toBe(200);
    for (const id of [low.id, high.id]) await a.waitForStatus(id, 'finished');
    const claims = (await a.events('types=job.claimed')).map((e) => e.jobId).filter((id) => id === low.id || id === high.id);
    expect(claims[0]).toBe(low.id);
  });

  it('an order naming a job that is not waiting, or one twice, is refused', async () => {
    const a = await boot();
    const token = await a.login();
    await setGate(a, token, { mode: 'review', autoAcceptPerHour: null });
    const job = await a.pull({ op: 'echo' });
    expect((await a.ui('/ui/api/queue/order', { jobIds: [job.id, job.id] }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/queue/order', { jobIds: ['nope'] }, { token })).status).toBe(409);
    expect((await a.job(job.id)).accepted).toBe(false);
  });

  it('a rejected job is neutralized, not deleted: it ends rejected, its source is told, it is not offered again', async () => {
    const a = await boot();
    const token = await a.login();
    await setGate(a, token, { mode: 'review', autoAcceptPerHour: null });
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'held');
    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/reject`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: job.id, status: 'rejected' });
    expect((await queue(a)).ended.map((j: Job) => j.id)).toContain(job.id);
    expect((await a.events('types=job.rejected')).find((e) => e.jobId === job.id)?.data).toEqual({ by: 'user', reason: 'rejected by the user' });
    await waitFor(async () => a.source.reports.some((x) => x.kind === 'rejected' && x.job.id === job.id), { what: 'the rejected report' });
    await a.sync();
    expect((await a.api('GET', '/api/jobs?limit=1000')).body.jobs.filter((j: Job) => j.source?.key === job.source?.key)).toHaveLength(1);
    expect((await a.ui(`/ui/api/jobs/${job.id}/reject`, {}, { token })).status).toBe(409);
  });

  it('a running job cannot be rejected (cancel it instead)', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'sleep', ms: 30000 });
    await a.waitForStatus(job.id, 'running');
    expect((await a.ui(`/ui/api/jobs/${job.id}/reject`, {}, { token })).status).toBe(409);
  });

  it('accept the pre-sort: every unaccepted job is accepted in the pre-sort\'s order', async () => {
    const a = await boot();
    const token = await a.login();
    await setGate(a, token, { mode: 'review', autoAcceptPerHour: null });
    const one = await a.pull({ op: 'echo' });
    const two = await a.pull({ op: 'echo' });
    await a.waitForStatus(two.id, 'held');
    expect((await a.ui('/ui/api/queue/accept-presort', {}, { token })).status).toBe(200);
    for (const j of [one, two]) await a.waitForStatus(j.id, 'finished');
    const by = (await a.events('types=job.accepted')).filter((e) => e.jobId === one.id || e.jobId === two.id).map((e) => e.data.by);
    expect(by).toEqual(['pre-sort', 'pre-sort']);
  });

  it('throttle: past autoAcceptPerHour a new job waits for the user', async () => {
    const a = await boot();
    const token = await a.login();
    await setGate(a, token, { mode: 'auto-accept', autoAcceptPerHour: 1 });
    const first = await a.pull({ op: 'echo' });
    await a.waitForStatus(first.id, 'finished');
    const second = await a.pull({ op: 'echo' });
    const held = await a.waitForStatus(second.id, 'held');
    expect(held).toMatchObject({ accepted: false, holdReason: 'awaiting acceptance' });
  });

  it('a sorter that rejects: auto-accept rejects what the pre-sort rejects; review lists it and accept-presort applies it', async () => {
    const a = await boot({ queueSorter: { name: 'spam-filter', plugin: 'spam-sorter' } }, (dataDir) => {
      mkdirSync(join(dataDir, 'plugins', 'spam-sorter'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dataDir, 'plugins', 'spam-sorter', 'index.js'), `export default {
  id: 'spam-sorter', role: 'queue-sorter', describe: 'rejects spam',
  async detect() { return { status: 'available' }; },
  create() { return {
    name: 'spam-sorter',
    sort(entries) { return entries.map((e) => e.job.id); },
    reject(entries) { return entries.filter((e) => e.job.spec.goal.includes('spam')).map((e) => ({ jobId: e.job.id, reason: 'looks like spam' })); },
  }; },
};
`);
    });
    const spam = await a.pull({ op: 'echo' }, { title: 'buy spam now' });
    const fine = await a.pull({ op: 'echo' }, { title: 'fix the bug' });
    await a.waitForStatus(fine.id, 'finished');
    const rejected = await a.waitForStatus(spam.id, 'rejected');
    expect(rejected.error).toBe('looks like spam');
    expect((await a.events('types=job.rejected')).find((e) => e.jobId === spam.id)?.data).toEqual({ by: 'pre-sort', reason: 'looks like spam' });

    const token = await a.login();
    await setGate(a, token, { mode: 'review', autoAcceptPerHour: null });
    const spam2 = await a.pull({ op: 'echo' }, { title: 'more spam' });
    await a.waitForStatus(spam2.id, 'held');
    expect((await queue(a)).presort.reject).toEqual([{ jobId: spam2.id, reason: 'looks like spam' }]);
    expect((await a.ui('/ui/api/queue/accept-presort', {}, { token })).status).toBe(200);
    await a.waitForStatus(spam2.id, 'rejected');
  });
});
