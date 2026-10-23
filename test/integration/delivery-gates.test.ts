// Gate clearances (issue #2554 part 5, design.md "Delivery forecasts") over the real HTTP server and database: a person
// clears a delivery gate for one promotion set; then each change of that set goes on past the gate from the clearance, and
// a cleared production gate delivers it. The same clearance again records nothing.
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryGateClearanceView } from '../../src/domain/delivery-gates.ts';
import { promotionSetOf, type PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';
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

/** A cutoff each day at 00:00 UTC; the test gate an hour after it, production an hour after that. */
const schedule = (now: number): PromotionSetSchedule => ({
  timeZone: 'UTC', cutoffs: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, time: '00:00' })), testGateAfterMinutes: 60,
  productionAfterMinutes: 60, epoch: new Date(Math.floor((now - 40 * DAY) / DAY) * DAY).toISOString(), expedite: 'out_of_cadence',
});

/** `g1`, promoted three days ago, held at the gated test gate of its set since the cutoff after that. */
async function boot(gates: Record<string, { owner: string }>): Promise<{ a: TestApp; token: string; set: number; cutoff: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  const now = Date.now(), t = now - 3 * DAY;
  const add = (type: EventType, at: number, data: Record<string, unknown>, jobId?: string) =>
    a.user().store.events.append({ type, at: new Date(at).toISOString(), data, ...(jobId ? { jobId } : {}) });
  add('job.queued', t, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: 'k20', repo: REPO, number: 20 } }, 'g1');
  add('job.started', t + MIN, { attempts: 1 }, 'g1');
  add('job.pull_request_followed', t + 20 * MIN, { pullRequest: pr(120), part: false }, 'g1');
  add('job.finished', t + 30 * MIN, { result: {} }, 'g1');
  add('job.pull_request_merged', t + 40 * MIN, { pullRequest: pr(120), part: false }, 'g1');
  add('landing_batch.started', t + 45 * MIN, { repo: REPO, landing: 'main', tested: 'dev', tip: 'a'.repeat(40), branch: 'hopper-batch/1', pullRequest: 901, url: pr(901), merges: [120] });
  add('landing_batch.promoted', t + 50 * MIN, { repo: REPO, tested: 'dev', tip: 'a'.repeat(40), pullRequest: 901, url: pr(901) });
  const token = await a.login();
  expect((await a.ui('/ui/api/delivery-settings', { repos: { [REPO]: { schedule: schedule(now), gates } } }, { token })).status).toBe(200);
  const set = promotionSetOf(schedule(now), new Date(t + 50 * MIN).toISOString())!;
  return { a, token, set: set.set, cutoff: set.cutoffAt };
}

const forecastOf = async (a: TestApp) => (await a.api<DeliveryForecastView>('GET', `/api/delivery-forecast?issue=${encodeURIComponent(`${REPO}#20`)}`)).body;

describe('gate clearances', () => {
  it('a cleared test gate: the change is in production since the clearance, and its set too', async () => {
    const { a, token, set, cutoff } = await boot({ test_gate: { owner: 'release-owner' } });
    expect((await forecastOf(a)).forecast).toMatchObject({ step: 'test_gate', since: cutoff, wait: { owner: 'release-owner' } });
    const r = await a.ui<DeliveryGateClearanceView>('/ui/api/delivery-gate', { repo: 'Octo/Shed', set, step: 'test_gate' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ repo: REPO, set, step: 'test_gate', by: expect.any(String), at: expect.any(String) });
    const f = (await forecastOf(a)).forecast!;
    expect(f).toMatchObject({ step: 'production', since: r.body.at });
    expect(f.wait).toBeUndefined();
    expect(Date.parse(f.normal.productionAt!)).toBe(Date.parse(r.body.at) + 60 * MIN);
    const s = (await a.api<PromotionSetForecastView>('GET', `/api/delivery-forecast?set=${set}&repo=${REPO}`)).body;
    expect(s.forecast).toMatchObject({ step: 'production', since: r.body.at });
    expect(s.changes).toEqual([expect.objectContaining({ jobId: 'g1', step: 'production' })]);
  });

  it('a cleared production gate delivers the change at the clearance; the same clearance again records nothing', async () => {
    const { a, token, set } = await boot({ test_gate: { owner: 'release-owner' }, production: { owner: 'release-owner' } });
    await a.ui('/ui/api/delivery-gate', { repo: REPO, set, step: 'test_gate' }, { token });
    expect((await forecastOf(a)).forecast).toMatchObject({ step: 'production', wait: { owner: 'release-owner' } });
    const first = (await a.ui<DeliveryGateClearanceView>('/ui/api/delivery-gate', { repo: REPO, set, step: 'production' }, { token })).body;
    const again = (await a.ui<DeliveryGateClearanceView>('/ui/api/delivery-gate', { repo: REPO, set, step: 'production' }, { token })).body;
    expect(again).toEqual(first);
    expect(await a.events('types=delivery_gate.cleared')).toHaveLength(2);
    const r = await forecastOf(a);
    expect(r).toMatchObject({ jobId: 'g1', deliveredAt: first.at });
    expect(r.forecast).toBeUndefined();
  });

  it('refuses a step with no gate (409), no schedule or no such set (404), a bad body (400), and no UI session (403)', async () => {
    const { a, token, set } = await boot({ test_gate: { owner: 'release-owner' } });
    expect((await a.ui('/ui/api/delivery-gate', { repo: REPO, set, step: 'production' }, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/delivery-gate', { repo: 'octo/other', set, step: 'test_gate' }, { token })).status).toBe(404);
    for (const body of [{ repo: REPO, set, step: 'coding' }, { repo: REPO, set: 0, step: 'test_gate' }, { repo: 'shed', set, step: 'test_gate' }, { repo: REPO, set, step: 'test_gate', note: 'x' }]) {
      expect((await a.ui('/ui/api/delivery-gate', body, { token })).status).toBe(400);
    }
    expect((await a.api('POST', '/ui/api/delivery-gate', { repo: REPO, set, step: 'test_gate' })).status).toBe(403);
    expect(await a.events('types=delivery_gate.cleared')).toHaveLength(0);
  });
});
