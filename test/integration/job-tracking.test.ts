// Issue #426: the job tracking layer above lanes (design.md "Job tracking above lanes"). A job flows
// source → job queue → lane: the source only ingests its item into the queue, the queue gate and the
// priority order decide which waiting job a Decision hands to a free lane, and a restart keeps the
// queue as it was — the gate, the priorities, the user's acceptance — with no job lost or made twice.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const claimsOf = async (a: TestApp, ids: string[]) =>
  (await a.events('types=job.claimed')).map((e) => e.jobId).filter((id) => id !== undefined && ids.includes(id));

describe('job tracking above lanes', () => {
  it('a restart keeps the queue: the gate, the priority order and every job once', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const source = createManualSource();
    const first = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) }, source });
    apps.push(first);
    const token = await first.login();
    expect((await first.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(200);

    // One lane, held by the blocker; the source's items wait in the queue, not on a lane.
    const blocker = await first.pull({ op: 'sleep', ms: 4000 });
    expect((await first.ui('/ui/api/queue/order', { jobIds: [blocker.id] }, { token })).status).toBe(200);
    await first.waitForStatus(blocker.id, 'running');
    const low = await first.pull({ op: 'echo' }, { priority: 10 });
    const high = await first.pull({ op: 'echo' }, { priority: 90 });
    const unaccepted = await first.pull({ op: 'echo' });
    expect((await first.ui('/ui/api/queue/order', { jobIds: [low.id, high.id] }, { token })).status).toBe(200);
    expect((await first.waitForStatus(unaccepted.id, 'held')).holdReason).toBe('awaiting acceptance');
    await first.stop();

    const second = await startTestApp({ dbPath: db.dbPath, source });
    apps.push(second);
    await second.sync();
    const jobs = (await second.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs;
    expect(jobs.map((j) => j.id).sort()).toEqual([blocker.id, low.id, high.id, unaccepted.id].sort());

    // The interrupted job is back in the queue; the higher priority still runs first, the gate still holds.
    for (const j of [high, blocker, low]) await second.waitForStatus(j.id, 'finished', 12000);
    expect(await claimsOf(second, [blocker.id, low.id, high.id])).toEqual([blocker.id, high.id, blocker.id, low.id]);
    expect(await second.job(unaccepted.id)).toMatchObject({ status: 'held', accepted: false, holdReason: 'awaiting acceptance' });
    expect((await second.api('GET', '/api/queue')).body.gate).toEqual({ mode: 'review', autoAcceptPerHour: null });

    const again = await second.login();
    expect((await second.ui('/ui/api/queue/order', { jobIds: [unaccepted.id] }, { token: again })).status).toBe(200);
    await second.waitForStatus(unaccepted.id, 'finished');
    await second.sync();
    expect((await second.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs).toHaveLength(4);
  }, 40000);
});
