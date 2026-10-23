// Delivery settings (issue #2554 part 3, design.md "Delivery forecasts") over the real HTTP server and database: an admin
// gives a repository its promotion set schedule and its delivery gates; then the forecast of a change has times for the
// scheduled steps, a change at a gated step waits on its owner, and a promotion set is read by its number with its changes.
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliverySettingsView } from '../../src/domain/delivery-settings.ts';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';
import { promotionSetOf } from '../../src/domain/promotion-sets.ts';
import type { EventType } from '../../src/domain/types.ts';
import type { DeliveryForecastView, PromotionSetForecastView } from '../../src/http/delivery-forecast.ts';
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

const MIN = 60_000, DAY = 86_400_000;
const REPO = 'octo/shed';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** A cutoff each day at 00:00 UTC; the test gate an hour after it, production an hour after that. */
const schedule = (now: number): PromotionSetSchedule => ({
  timeZone: 'UTC',
  cutoffs: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, time: '00:00' })),
  testGateAfterMinutes: 60,
  productionAfterMinutes: 60,
  epoch: new Date(Math.floor((now - 40 * DAY) / DAY) * DAY).toISOString(),
  expedite: 'out_of_cadence',
});

/** Five changes that went through every measured step two days ago; `c9` at its PR checks now; `g1` promoted three days ago. */
function seed(a: TestApp, now: number): number {
  const events = a.user().store.events;
  const add = (type: EventType, at: number, data: Record<string, unknown>, jobId?: string) =>
    events.append({ type, at: new Date(at).toISOString(), data, ...(jobId ? { jobId } : {}) });
  const change = (job: string, n: number, t: number, landingMin: number) => {
    add('job.queued', t, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: `k${n}`, repo: REPO, number: n } }, job);
    add('job.started', t + MIN, { attempts: 1 }, job);
    add('job.pull_request_followed', t + 20 * MIN, { pullRequest: pr(100 + n), part: false }, job);
    add('job.finished', t + 30 * MIN, { result: {} }, job);
    add('job.pull_request_merged', t + 40 * MIN, { pullRequest: pr(100 + n), part: false }, job);
    add('landing_batch.started', t + 45 * MIN, { repo: REPO, landing: 'main', tested: 'dev', tip: 'a'.repeat(40), branch: `hopper-batch/${n}`, pullRequest: 900 + n, url: pr(900 + n), merges: [100 + n] });
    add('landing_batch.promoted', t + landingMin * MIN, { repo: REPO, tested: 'dev', tip: 'a'.repeat(40), pullRequest: 900 + n, url: pr(900 + n) });
  };
  for (let i = 1; i <= 5; i++) change(`h${i}`, i, now - 2 * DAY + i * 3_600_000, 50 + i);
  const promoted = now - 3 * DAY + 50 * MIN;
  change('g1', 20, now - 3 * DAY, 50);
  add('job.queued', now - 50 * MIN, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: 'k9', repo: REPO, number: 9 } }, 'c9');
  add('job.started', now - 45 * MIN, { attempts: 1 }, 'c9');
  add('job.pull_request_followed', now - 20 * MIN, { pullRequest: pr(109), part: false }, 'c9');
  add('job.finished', now - 10 * MIN, { result: {} }, 'c9');
  return promoted;
}

const forecastOf = (a: TestApp, q: string) => a.api<DeliveryForecastView>('GET', `/api/delivery-forecast?${q}`);

describe('delivery settings', () => {
  it('none by default; an admin sets a repository, which reads back whole and is recorded; null takes it away', async () => {
    const a = await boot();
    expect((await a.api<DeliverySettingsView>('GET', '/api/delivery-settings')).body.settings).toEqual({ repos: {} });
    const token = await a.login();
    const repo = { schedule: schedule(Date.now()), gates: { test_gate: { owner: 'release-owner' } } };
    const saved = await a.ui<DeliverySettingsView>('/ui/api/delivery-settings', { repos: { 'Octo/Shed': repo } }, { token });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual({ repos: { [REPO]: repo } });
    expect((await a.api<DeliverySettingsView>('GET', '/api/delivery-settings')).body.settings).toEqual({ repos: { [REPO]: repo } });
    expect((await a.events('types=delivery_settings.changed')).map((e) => e.data)).toEqual([{ from: { repos: {} }, to: { repos: { [REPO]: repo } }, by: expect.any(String) }]);
    // The same again records nothing.
    await a.ui('/ui/api/delivery-settings', { repos: { [REPO]: repo } }, { token });
    expect(await a.events('types=delivery_settings.changed')).toHaveLength(1);
    expect((await a.ui<DeliverySettingsView>('/ui/api/delivery-settings', { repos: { [REPO]: null } }, { token })).body.settings).toEqual({ repos: {} });
  });

  it('refuses a bad time zone, a bad cutoff time, a gate on no step, and a change with no UI session', async () => {
    const a = await boot();
    const token = await a.login();
    const s = schedule(Date.now());
    for (const repo of [{ schedule: { ...s, timeZone: 'Mars/Olympus' }, gates: {} }, { schedule: { ...s, cutoffs: [{ weekday: 1, time: '24:00' }] }, gates: {} }, { gates: { review: { owner: 'x' } } }]) {
      expect((await a.ui('/ui/api/delivery-settings', { repos: { [REPO]: repo } }, { token })).status).toBe(400);
    }
    expect((await a.api('POST', '/ui/api/delivery-settings', { repos: {} })).status).toBe(403);
  });
});

describe('forecasts with a promotion set schedule', () => {
  async function withSchedule(gates: Record<string, { owner: string }>) {
    const a = await boot();
    const now = Date.now();
    const promoted = seed(a, now);
    const token = await a.login();
    expect((await a.ui('/ui/api/delivery-settings', { repos: { [REPO]: { schedule: schedule(now), gates } } }, { token })).status).toBe(200);
    return { a, now, promoted, firstCutoff: Math.floor(promoted / DAY) * DAY + DAY };
  }

  it('a change at its PR checks: the scheduled steps have times, a set, and the gate\'s owner', async () => {
    const { a } = await withSchedule({ test_gate: { owner: 'release-owner' } });
    const r = await forecastOf(a, `issue=${encodeURIComponent(`${REPO}#9`)}`);
    expect(r.status).toBe(200);
    const steps = r.body.forecast!.normal.steps;
    const set = steps.find((s) => s.step === 'promotion_set')!;
    expect(set).toMatchObject({ basis: 'scheduled', set: promotionSetOf(schedule(Date.parse(r.body.forecast!.now)), set.start!)!.set });
    expect(steps.find((s) => s.step === 'test_gate')).toMatchObject({ basis: 'scheduled', gate: { owner: 'release-owner' } });
    expect(Date.parse(r.body.forecast!.normal.productionAt!) - Date.parse(set.end!)).toBe(120 * MIN);
    for (let i = 1; i < steps.length; i++) expect(Date.parse(steps[i]!.end!)).toBeGreaterThanOrEqual(Date.parse(steps[i - 1]!.end!));
  });

  it('a change past its cutoff at a gated test gate waits on the owner since the cutoff, and slips', async () => {
    const { a, firstCutoff } = await withSchedule({ test_gate: { owner: 'release-owner' } });
    const f = (await forecastOf(a, `issue=${encodeURIComponent(`${REPO}#20`)}`)).body.forecast!;
    const since = new Date(firstCutoff).toISOString();
    expect(f).toMatchObject({ step: 'test_gate', since, wait: { kind: 'human_gate', owner: 'release-owner', since }, slipping: { blocker: 'human_gate' } });
    expect(f.normal.remaining!.humanMs).toBe(0);
    expect(f.normal.remaining!.machineMs).toBe(60 * MIN);
  });

  it('with no gate, a change past the end of production is delivered', async () => {
    const { a, firstCutoff } = await withSchedule({});
    const r = await forecastOf(a, `issue=${encodeURIComponent(`${REPO}#20`)}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jobId: 'g1', deliveredAt: new Date(firstCutoff + 120 * MIN).toISOString() });
    expect(r.body.forecast).toBeUndefined();
  });

  it('a promotion set by its number: its times, its step, and the changes in it', async () => {
    const { a, promoted, now } = await withSchedule({ test_gate: { owner: 'release-owner' } });
    const n = promotionSetOf(schedule(now), new Date(promoted).toISOString())!.set;
    const r = await a.api<PromotionSetForecastView>('GET', `/api/delivery-forecast?repo=${encodeURIComponent(REPO)}&set=${n}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ repo: REPO, set: { set: n }, forecast: { step: 'test_gate', wait: { owner: 'release-owner' } } });
    expect(r.body.changes).toEqual([{ jobId: 'g1', issue: `${REPO}#20`, pullRequest: pr(120), step: 'test_gate' }]);
  });

  it('refuses a set with no repository or set 0 (400), and a repository with no schedule (404)', async () => {
    const a = await boot();
    expect((await a.api('GET', '/api/delivery-forecast?set=3')).status).toBe(400);
    expect((await a.api('GET', `/api/delivery-forecast?repo=${encodeURIComponent(REPO)}&set=0`)).status).toBe(400);
    expect((await a.api('GET', `/api/delivery-forecast?repo=${encodeURIComponent(REPO)}&set=3`)).status).toBe(404);
  });
});
