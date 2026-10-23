// Issue #935: GET /api/jobs/:id/bom answers a job's parts list — its issue, runs, pull request, questions, artifacts and
// the rest, grouped, each with its status and page —, a plain-words header and summary, and its events newest first.
// Real database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobBom, ResourceReading } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(localResources?: () => ResourceReading): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, seams: { levels: [], ...(localResources ? { localResources } : {}) } });
  return t;
}

const PR = 'https://github.com/acme/app/pull/12';
const ISSUE = 'https://github.com/acme/app/issues/7';

describe('GET /api/jobs/:id/bom (issue #935)', () => {
  it('answers the parts of a job that asked a question and opened a pull request', async () => {
    const a = await start();
    const asks = await a.pull({ op: 'ask', message: 'Which store should the cache use?' }, { key: 'item-7' });
    const q = await a.waitForQuestion(asks.id, (x) => x.status === 'open');
    const { store } = a.user();
    store.jobs.update(asks.id, {
      source: { source: 'manual', kind: 'item', key: ISSUE, url: ISSUE, repo: 'acme/app', number: 7, title: 'Make the cache faster' },
      sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'pending', headRef: 'issue-7' } } },
    });

    const r = await a.api<JobBom>('GET', `/api/jobs/${asks.id}/bom`);
    expect(r.status).toBe(200);
    const bom = r.body;
    expect(bom.jobId).toBe(asks.id);
    expect(bom.header).toMatchObject({ asked: 'Make the cache faster (acme/app#7)', stands: 'Waiting on you: answer a question', next: 'You: answer the question.' });
    expect(bom.parts[0]).toMatchObject({ id: `question:${q.id}`, group: 'decisions', status: 'waiting_on_you', href: '#questions' });
    expect(bom.parts.find((p) => p.id === 'issue:acme/app#7')).toMatchObject({ group: 'asked', url: ISSUE });
    expect(bom.parts.find((p) => p.id === `pr:${PR}`)).toMatchObject({ group: 'code', status: 'open' });
    expect(bom.parts.filter((p) => p.kind === 'run').length).toBeGreaterThanOrEqual(1);
    expect(bom.summary).toMatch(/1 waiting on you\.$/);
    const seqs = bom.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x));
    expect(bom.events.map((e) => e.type)).toEqual(expect.arrayContaining(['job.queued', 'job.started', 'question.asked']));
    expect(bom.events.every((e) => e.jobId === asks.id)).toBe(true);
  });

  it('answers the usage its runs burned and what they used of the machine (part 2)', async () => {
    const a = await start();
    const { store } = a.user();
    const MIN = 60_000;
    const GIB = 1024 ** 3;
    const at = Date.now() - 24 * 60 * MIN;
    const iso = (min: number) => new Date(at + min * MIN).toISOString();
    store.machineHistory.record(Array.from({ length: 50 }, (_, i) => ({
      machineId: 'm1', at: iso(i), cores: 8, cpuBusyFrac: i >= 20 ? 0.3 : 0.1, memTotalBytes: 16 * GIB, memAvailableBytes: (i >= 20 ? 10 : 12) * GIB,
      diskFreeBytes: 50 * GIB, diskTotalBytes: 100 * GIB, lanesBusy: i >= 20 ? 1 : 0, lanesMax: 2,
    })));
    store.usageHistory.record(Array.from({ length: 30 }, (_, i) => ({ source: 'plan', machineId: 'm1', window: 'session', used: 10 + i * 0.2, limit: 100, unit: '%', at: iso(20 + i) })));
    const job = store.tx(() => {
      const j = store.jobs.create({ executor: 'test', payload: {}, machineId: 'nowhere' }, 50, { source: 'github', kind: 'github', key: ISSUE, repo: 'acme/app', number: 7 });
      store.jobs.update(j.id, { status: 'finished' });
      store.events.append({ type: 'job.claimed', jobId: j.id, machineId: 'm1', laneId: 'm1:1', at: iso(20), data: { attempts: 1, effectivePriority: 50, reason: 'test' } });
      store.events.append({ type: 'job.finished', jobId: j.id, laneId: 'm1:1', at: iso(50), data: { result: 'ok' } });
      return j;
    });

    const bom = (await a.api<JobBom>('GET', `/api/jobs/${job.id}/bom`)).body;
    const usage = bom.parts.find((p) => p.id === 'usage');
    expect(usage).toMatchObject({ group: 'work', label: 'Usage: 5.8% of session', status: 'recorded' });
    expect(usage!.detail).toMatch(/^1 run, 30 samples: CPU 20% on average/);
  });

  // Issue #2498 part 3: while it runs, what its scope uses now, as its machine's meter last read it.
  it('answers what a running job\'s scope uses now on its machine', async () => {
    const GIB = 1024 ** 3;
    let jobId = '';
    const a = await start(() => ({
      cores: 8, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB,
      ...(jobId ? { jobMemoryBytes: { [jobId]: 2 * GIB }, jobUse: { [jobId]: { memoryPeakBytes: 3 * GIB, cpuSeconds: 90, cpuCores: 2 } } } : {}),
    }));
    const asks = await a.pull({ op: 'ask', message: 'Which store?' }, { key: 'item-8' });
    await a.waitForQuestion(asks.id, (x) => x.status === 'open');
    jobId = asks.id;
    const bom = (await a.api<JobBom>('GET', `/api/jobs/${asks.id}/bom`)).body;
    expect(bom.parts.find((p) => p.id.startsWith('resources-now:'))).toMatchObject({
      group: 'machines', label: 'Memory 2 GiB now, peak 3 GiB, CPU 2 cores', status: 'running', detail: expect.stringMatching(/^CPU 1m 30s so far, on /),
    });
  });

  it('answers 404 for a job it does not know', async () => {
    const a = await start();
    expect((await a.api('GET', '/api/jobs/nope/bom')).status).toBe(404);
  });
});
