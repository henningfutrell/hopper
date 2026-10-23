// The expedite flag (issue #2554 part 4, design.md "Delivery forecasts") over the real HTTP server and database: a person
// flags a change — a job, an issue or a pull request — as expedited; then its forecast shows the expedited path beside
// the normal one, never later, and a promotion set lists it as expedited. Turned off, the forecast has the normal path only.
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryExpediteView } from '../../src/domain/delivery-expedite.ts';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';
import type { EventType } from '../../src/domain/types.ts';
import type { DeliveryForecastView, PromotionSetForecastView } from '../../src/domain/delivery-forecast.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const MIN = 60_000, DAY = 86_400_000;
const REPO = 'octo/shed';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** A cutoff each Monday at 00:00 UTC, so a change waits for it; the test gate and production an hour each. */
const schedule = (now: number): PromotionSetSchedule => ({
  timeZone: 'UTC', cutoffs: [{ weekday: 1, time: '00:00' }], testGateAfterMinutes: 60, productionAfterMinutes: 60,
  epoch: new Date(Math.floor((now - 40 * DAY) / DAY) * DAY).toISOString(), expedite: 'out_of_cadence',
});

/** Five changes that went through every measured step two days ago, and `c9` at its PR checks now. */
async function boot(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  const now = Date.now();
  const add = (type: EventType, at: number, data: Record<string, unknown>, jobId?: string) =>
    a.user().store.events.append({ type, at: new Date(at).toISOString(), data, ...(jobId ? { jobId } : {}) });
  const queued = (job: string, n: number, t: number) =>
    add('job.queued', t, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: `k${n}`, repo: REPO, number: n } }, job);
  for (let n = 1; n <= 5; n++) {
    const t = now - 2 * DAY + n * 3_600_000, job = `h${n}`;
    queued(job, n, t);
    add('job.started', t + MIN, { attempts: 1 }, job);
    add('job.pull_request_followed', t + 20 * MIN, { pullRequest: pr(100 + n), part: false }, job);
    add('job.finished', t + 30 * MIN, { result: {} }, job);
    add('job.pull_request_merged', t + 40 * MIN, { pullRequest: pr(100 + n), part: false }, job);
    add('landing_batch.started', t + 45 * MIN, { repo: REPO, landing: 'main', tested: 'dev', tip: 'a'.repeat(40), branch: `hopper-batch/${n}`, pullRequest: 900 + n, url: pr(900 + n), merges: [100 + n] });
    add('landing_batch.promoted', t + 50 * MIN, { repo: REPO, tested: 'dev', tip: 'a'.repeat(40), pullRequest: 900 + n, url: pr(900 + n) });
  }
  queued('c9', 9, now - 50 * MIN);
  add('job.started', now - 45 * MIN, { attempts: 1 }, 'c9');
  add('job.pull_request_followed', now - 20 * MIN, { pullRequest: pr(109), part: false }, 'c9');
  add('job.finished', now - 10 * MIN, { result: {} }, 'c9');
  const token = await a.login();
  expect((await a.ui('/ui/api/delivery-settings', { repos: { [REPO]: { schedule: schedule(now), gates: {} } } }, { token })).status).toBe(200);
  return { a, token };
}

const forecastOf = async (a: TestApp) => (await a.api<DeliveryForecastView>('GET', `/api/delivery-forecast?issue=${encodeURIComponent(`${REPO}#9`)}`)).body;

describe('the expedite flag', () => {
  it('a flag on the issue: the forecast shows the expedited path beside the normal one, out of cadence and never later', async () => {
    const { a, token } = await boot();
    expect((await forecastOf(a)).forecast!.expedited).toBeUndefined();
    const set = await a.ui<DeliveryExpediteView>('/ui/api/delivery-expedite', { issue: 'Octo/Shed#9', expedite: true }, { token });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ issue: `${REPO}#9`, expedite: true, by: expect.any(String), at: expect.any(String) });
    const r = await forecastOf(a);
    expect(r.expedited).toEqual({ by: set.body.by, at: set.body.at });
    const { normal, expedited } = r.forecast!;
    expect(expedited!.steps.find((s) => s.step === 'promotion_set')).toMatchObject({ basis: 'scheduled', outOfCadence: true });
    expect(Date.parse(expedited!.productionAt!)).toBeLessThanOrEqual(Date.parse(normal.productionAt!));
    expect(expedited!.remaining!.scheduleMs).toBe(0);
    // A promotion set lists the change as expedited.
    const n = normal.steps.find((s) => s.step === 'promotion_set')!.set!;
    const listed = (await a.api<PromotionSetForecastView>('GET', `/api/delivery-forecast?set=${n}&repo=${REPO}`)).body.changes;
    expect(listed.find((c) => c.jobId === 'c9')).toMatchObject({ expected: true, expedited: true });
  });

  it('is recorded once; the same again records nothing; turned off on the job, the forecast has the normal path only', async () => {
    const { a, token } = await boot();
    await a.ui('/ui/api/delivery-expedite', { pr: pr(109), expedite: true }, { token });
    await a.ui('/ui/api/delivery-expedite', { pr: pr(109), expedite: true }, { token });
    expect((await a.events('types=delivery_expedite.changed')).map((e) => e.data)).toEqual([{ pullRequest: pr(109), expedite: true, by: expect.any(String) }]);
    expect((await forecastOf(a)).forecast!.expedited).toBeDefined();
    // Off on another target of the same change: the newest flag wins.
    expect((await a.ui<DeliveryExpediteView>('/ui/api/delivery-expedite', { job: 'c9', expedite: false }, { token })).body).toEqual({ job: 'c9', expedite: false });
    const r = await forecastOf(a);
    expect(r.expedited).toBeUndefined();
    expect(r.forecast!.expedited).toBeUndefined();
    expect(await a.events('types=delivery_expedite.changed')).toHaveLength(2);
  });

  it('refuses no target or two, a bad one, and a change with no UI session', async () => {
    const { a, token } = await boot();
    for (const body of [{ expedite: true }, { job: 'c9', issue: `${REPO}#9`, expedite: true }, { issue: 'shed#9', expedite: true }, { job: 'c9' }, { job: 'c9', expedite: true, note: 'x' }]) {
      expect((await a.ui('/ui/api/delivery-expedite', body, { token })).status).toBe(400);
    }
    expect((await a.api('POST', '/ui/api/delivery-expedite', { job: 'c9', expedite: true })).status).toBe(403);
  });
});
