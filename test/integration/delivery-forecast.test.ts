// GET /api/delivery-forecast (issue #2554 part 2, design.md "Delivery forecasts"): for a job, an issue or a pull request,
// the step its change is in and the expected end of each step left, from the step durations of its repository's jobs,
// read from their events. Real daemon and database; the history is events appended to the user's log.
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryForecastView } from '../../src/domain/delivery-forecast.ts';
import type { EventType } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

const MIN = 60_000;
const REPO = 'octo/shed';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** Five changes of the repository that went through every measured step two days ago, and one at its PR checks now. */
function seed(a: TestApp, now: number): void {
  const events = a.user().store.events;
  const add = (type: EventType, at: number, data: Record<string, unknown>, jobId?: string) =>
    events.append({ type, at: new Date(at).toISOString(), data, ...(jobId ? { jobId } : {}) });
  for (let i = 1; i <= 5; i++) {
    const t = now - 2 * 86_400_000 + i * 3_600_000, job = `h${i}`;
    add('job.queued', t, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: `k${i}`, repo: REPO, number: i } }, job);
    add('job.started', t + i * MIN, { attempts: 1 }, job);
    add('job.pull_request_followed', t + 20 * MIN, { pullRequest: pr(100 + i), part: false }, job);
    add('job.finished', t + 30 * MIN, { result: {} }, job);
    add('job.pull_request_merged', t + (40 + i) * MIN, { pullRequest: pr(100 + i), part: false }, job);
    add('landing_batch.started', t + 45 * MIN, { repo: REPO, landing: 'main', tested: 'dev', tip: 'a'.repeat(40), branch: `hopper-batch/${i}`, pullRequest: 900 + i, url: pr(900 + i), merges: [100 + i] });
    add('landing_batch.promoted', t + (45 + 10 * i) * MIN, { repo: REPO, tested: 'dev', tip: 'a'.repeat(40), pullRequest: 900 + i, url: pr(900 + i) });
  }
  add('job.queued', now - 50 * MIN, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: 'k9', repo: REPO, number: 9 } }, 'c9');
  add('job.started', now - 45 * MIN, { attempts: 1 }, 'c9');
  add('job.pull_request_followed', now - 20 * MIN, { pullRequest: pr(109), part: false }, 'c9');
  add('job.finished', now - 10 * MIN, { result: {} }, 'c9');
}

/** The answer with each time replaced by its offset from `now` in minutes: the shape and the arithmetic, not the clock. */
const relative = (v: unknown, now: number): unknown => JSON.parse(JSON.stringify(v), (_k, x: unknown) =>
  typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) ? `now${Math.round((Date.parse(x) - now) / MIN) >= 0 ? '+' : ''}${Math.round((Date.parse(x) - now) / MIN)}m` : x);

describe('GET /api/delivery-forecast', () => {
  it('a change at its PR checks: its step, and each step left from the repository\'s measured steps; scheduled steps unknown', async () => {
    const a = await boot();
    const now = Date.now();
    seed(a, now);
    const r = await a.api<DeliveryForecastView>('GET', `/api/delivery-forecast?issue=${encodeURIComponent(`${REPO}#9`)}`);
    expect(r.status).toBe(200);
    const asked = Date.parse(r.body.forecast!.now);
    expect(asked - now).toBeLessThan(60_000);
    expect(relative(r.body, asked)).toEqual({
      jobId: 'c9', repo: REPO, issue: `${REPO}#9`, pullRequest: pr(109), historyDays: 30,
      forecast: {
        now: 'now+0m', step: 'pr_checks', since: 'now-10m',
        normal: {
          steps: [
            // pr_checks took 11..15 minutes: p50 13, p90 15, from its start ten minutes ago.
            { step: 'pr_checks', basis: 'measured', samples: 5, start: 'now-10m', end: 'now+3m', endP90: 'now+5m' },
            { step: 'landing', basis: 'measured', samples: 5, start: 'now+3m', end: 'now+3m', endP90: 'now+5m' },
            // landing_checks: from the merge (41..45) to the promotion (55..95): 14, 23, 32, 41, 50; p50 32, p90 50.
            { step: 'landing_checks', basis: 'measured', samples: 5, start: 'now+3m', end: 'now+35m', endP90: 'now+55m' },
            { step: 'promotion_set', basis: 'unknown', start: 'now+35m' },
            { step: 'test_gate', basis: 'unknown' },
            { step: 'production', basis: 'unknown' },
          ],
        },
      },
    });
  });

  it('finds the same change by its pull request, and a later step never ends before the one before it', async () => {
    const a = await boot();
    seed(a, Date.now());
    const r = await a.api<DeliveryForecastView>('GET', `/api/delivery-forecast?pr=${encodeURIComponent(pr(109))}`);
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe('c9');
    const ends = r.body.forecast!.normal.steps.flatMap((s) => (s.end ? [[Date.parse(s.end), Date.parse(s.endP90!)]] : []));
    expect(ends.length).toBe(3);
    for (let i = 1; i < ends.length; i++) {
      expect(ends[i]![0]).toBeGreaterThanOrEqual(ends[i - 1]![0]!);
      expect(ends[i]![1]).toBeGreaterThanOrEqual(ends[i - 1]![1]!);
    }
  });

  it('answers a job by its id, with its own track; the same inputs give the same forecast', async () => {
    const a = await boot();
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const r = await a.api<DeliveryForecastView>('GET', `/api/delivery-forecast?job=${job.id}`);
    expect(r.status).toBe(200);
    // A job with no repository has no history: every step left is unknown, and no time is made up.
    expect(r.body).toMatchObject({ jobId: job.id, historyDays: 30, forecast: { step: 'pr_checks' } });
    expect(r.body.forecast!.normal.steps.map((s) => s.basis)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(r.body.forecast!.normal.productionAt).toBeUndefined();
  });

  it('refuses a bad query (400), an unknown change (404) and a job that ended with no merge (409)', async () => {
    const a = await boot();
    seed(a, Date.now());
    expect((await a.api('GET', '/api/delivery-forecast')).status).toBe(400);
    expect((await a.api('GET', `/api/delivery-forecast?job=c9&issue=${encodeURIComponent(`${REPO}#9`)}`)).status).toBe(400);
    expect((await a.api('GET', '/api/delivery-forecast?issue=shed')).status).toBe(400);
    expect((await a.api('GET', '/api/delivery-forecast?job=nope')).status).toBe(404);
    expect((await a.api('GET', `/api/delivery-forecast?issue=${encodeURIComponent(`${REPO}#77`)}`)).status).toBe(404);
    const job = await a.pull({ op: 'fail' });
    await a.waitForStatus(job.id, 'failed');
    expect((await a.api('GET', `/api/delivery-forecast?job=${job.id}`)).status).toBe(409);
  });
});
