// The delivery ledger (issue #2554 part 6, design.md "Delivery forecasts") over the real HTTP server and database: the
// ledger pass keeps, for each step of each change, the first prediction that gave the step a time and the actual start and
// end once they happen; GET /api/delivery-ledger answers the rows and the forecast accuracy computed from them.
//
// Feature: the delivery ledger
//   Scenario: a change run end to end has a predicted and an actual time for every step, and the accuracy report its error
//   Scenario: a later pass keeps the first prediction
//   Scenario: the error over time, per day or week in the owner's time zone (part 7)
//   Scenario: a bad query is refused
import { afterEach, describe, expect, it } from 'vitest';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';
import type { EventType } from '../../src/domain/types.ts';
import { recordDeliveryLedger } from '../../src/engine/delivery-ledger.ts';
import type { DeliveryLedgerView } from '../../src/domain/forecast-accuracy.ts';
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
/** 02:00 UTC two days ago: a cutoff each day at 00:00 UTC is far from every step of the change. */
const T = Math.floor(Date.now() / DAY) * DAY - 2 * DAY + 2 * 3_600_000;

const schedule: PromotionSetSchedule = {
  timeZone: 'UTC', cutoffs: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, time: '00:00' })), testGateAfterMinutes: 60,
  productionAfterMinutes: 60, epoch: new Date(T - 20 * DAY).toISOString(), expedite: 'out_of_cadence',
};

type Add = (type: EventType, at: number, data: Record<string, unknown>, jobId?: string) => void;

/** A job from its queue to its promotion: queued 1 minute, `codingMin` coding, 10 minutes of checks, 10 of landing checks. */
function run(add: Add, id: string, n: number, t: number, codingMin: number, upTo: 'queued' | 'all'): void {
  add('job.queued', t, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: `k${n}`, repo: REPO, number: n } }, id);
  if (upTo === 'queued') return;
  const started = t + MIN, finished = started + codingMin * MIN, merged = finished + 10 * MIN;
  add('job.started', started, { attempts: 1 }, id);
  add('job.pull_request_followed', started + MIN, { pullRequest: pr(100 + n), part: false }, id);
  add('job.finished', finished, { result: {} }, id);
  add('job.pull_request_merged', merged, { pullRequest: pr(100 + n), part: false }, id);
  add('landing_batch.started', merged + MIN, { repo: REPO, landing: 'main', tested: 'dev', tip: 'a'.repeat(40), branch: `hopper-batch/${n}`, pullRequest: 900 + n, url: pr(900 + n), merges: [100 + n] });
  add('landing_batch.promoted', merged + 10 * MIN, { repo: REPO, tested: 'dev', tip: 'a'.repeat(40), pullRequest: 900 + n, url: pr(900 + n) });
}

/** Five changes of the repository before T, each 30 minutes of coding; then `c1` queued at T. */
async function boot(): Promise<{ a: TestApp; add: Add }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  const add: Add = (type, at, data, jobId) => { a.user().store.events.append({ type, at: new Date(at).toISOString(), data, ...(jobId ? { jobId } : {}) }); };
  for (let k = 1; k <= 5; k++) run(add, `h${k}`, k, T - k * DAY, 30, 'all');
  const token = await a.login();
  expect((await a.ui('/ui/api/delivery-settings', { repos: { [REPO]: { schedule, gates: {} } } }, { token })).status).toBe(200);
  run(add, 'c1', 20, T, 40, 'queued');
  return { a, add };
}

const ledgerOf = async (a: TestApp, q: string) => (await a.api<DeliveryLedgerView>('GET', `/api/delivery-ledger?${q}`)).body;

describe('the delivery ledger', () => {
  it('a change run end to end: a predicted and an actual time for every step, and the error of each', async () => {
    const { a, add } = await boot();
    const iso = (ms: number) => new Date(ms).toISOString();
    recordDeliveryLedger(a.user().store, new Date(T + 30_000));
    // c1 codes 40 minutes, not the 30 its history says: each step from coding on ends 10 minutes after its prediction.
    for (const e of [['job.started', T + MIN, { attempts: 1 }], ['job.pull_request_followed', T + 2 * MIN, { pullRequest: pr(120), part: false }],
      ['job.finished', T + 41 * MIN, { result: {} }], ['job.pull_request_merged', T + 51 * MIN, { pullRequest: pr(120), part: false }]] as const) {
      add(e[0], e[1], e[2], 'c1');
    }
    add('landing_batch.started', T + 52 * MIN, { repo: REPO, landing: 'main', tested: 'dev', tip: 'b'.repeat(40), branch: 'hopper-batch/20', pullRequest: 920, url: pr(920), merges: [120] });
    add('landing_batch.promoted', T + 61 * MIN, { repo: REPO, tested: 'dev', tip: 'b'.repeat(40), pullRequest: 920, url: pr(920) });
    recordDeliveryLedger(a.user().store, new Date(T + 2 * DAY));

    const cutoff = Math.ceil(T / DAY) * DAY;
    const { rows, accuracy } = await ledgerOf(a, 'job=c1');
    expect(rows).toEqual([
      { repo: REPO, key: 'job:c1', step: 'queued', predictedStart: iso(T), predictedEnd: iso(T + MIN), actualStart: iso(T), actualEnd: iso(T + MIN), predictedAt: iso(T + 30_000) },
      { repo: REPO, key: 'job:c1', step: 'coding', predictedStart: iso(T + MIN), predictedEnd: iso(T + 31 * MIN), actualStart: iso(T + MIN), actualEnd: iso(T + 41 * MIN), predictedAt: iso(T + 30_000) },
      { repo: REPO, key: 'job:c1', step: 'pr_checks', predictedStart: iso(T + 31 * MIN), predictedEnd: iso(T + 41 * MIN), actualStart: iso(T + 41 * MIN), actualEnd: iso(T + 51 * MIN), predictedAt: iso(T + 30_000) },
      { repo: REPO, key: 'job:c1', step: 'landing', predictedStart: iso(T + 41 * MIN), predictedEnd: iso(T + 41 * MIN), actualStart: iso(T + 51 * MIN), actualEnd: iso(T + 51 * MIN), predictedAt: iso(T + 30_000) },
      { repo: REPO, key: 'job:c1', step: 'landing_checks', predictedStart: iso(T + 41 * MIN), predictedEnd: iso(T + 51 * MIN), actualStart: iso(T + 51 * MIN), actualEnd: iso(T + 61 * MIN), predictedAt: iso(T + 30_000) },
      { repo: REPO, key: 'job:c1', step: 'promotion_set', predictedStart: iso(T + 51 * MIN), predictedEnd: iso(cutoff), actualStart: iso(T + 61 * MIN), actualEnd: iso(cutoff), predictedAt: iso(T + 30_000) },
      { repo: REPO, key: 'job:c1', step: 'test_gate', predictedStart: iso(cutoff), predictedEnd: iso(cutoff + 60 * MIN), actualStart: iso(cutoff), actualEnd: iso(cutoff + 60 * MIN), predictedAt: iso(T + 30_000) },
      { repo: REPO, key: 'job:c1', step: 'production', predictedStart: iso(cutoff + 60 * MIN), predictedEnd: iso(cutoff + 120 * MIN), actualStart: iso(cutoff + 60 * MIN), actualEnd: iso(cutoff + 120 * MIN), predictedAt: iso(T + 30_000) },
    ]);
    const err = (step: string, ms: number) => ({ step, samples: 1, meanAbsErrorMs: ms });
    const expected = [err('queued', 0), err('coding', 10 * MIN), err('pr_checks', 10 * MIN), err('landing', 10 * MIN), err('landing_checks', 10 * MIN),
      err('promotion_set', 0), err('test_gate', 0), err('production', 0)];
    expect(accuracy.byStep).toEqual(expected);
    expect(accuracy.byRepo).toEqual(expected.map((e) => ({ repo: REPO, ...e })));
    // The changes before it have only actual times: they were delivered before the first pass, so nothing was predicted.
    const all = await ledgerOf(a, `repo=${encodeURIComponent(REPO)}`);
    expect(all.rows.filter((r) => r.key === 'job:h1').map((r) => [r.step, r.predictedEnd, r.actualEnd !== undefined]))
      .toEqual(['queued', 'coding', 'pr_checks', 'landing', 'landing_checks', 'promotion_set', 'test_gate', 'production'].map((s) => [s, undefined, true]));
    expect(all.accuracy).toEqual(accuracy);
    // Over time (part 7): per day of the actual end, in the repository's schedule time zone (UTC here) unless the query names one.
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect((await ledgerOf(a, 'job=c1&period=day')).overTime).toEqual({
      period: 'day', timeZone: 'UTC',
      points: expected.map((e, i) => ({ start: day(i < 5 ? T : cutoff), ...e })),
    });
    // UTC+14: T (02:00) and the cutoff (00:00 next day) are 16:00 and 14:00 there, so each keeps its day.
    expect((await ledgerOf(a, 'job=c1&period=day&timeZone=Pacific%2FKiritimati')).overTime.timeZone).toBe('Pacific/Kiritimati');
    expect((await ledgerOf(a, 'job=c1')).overTime.period).toBe('week');
  });

  it('a later pass keeps the first prediction, and fills a step the first one could not time', async () => {
    const { a, add } = await boot();
    recordDeliveryLedger(a.user().store, new Date(T + 30_000));
    add('job.started', T + 5 * MIN, { attempts: 1 }, 'c1');
    recordDeliveryLedger(a.user().store, new Date(T + 6 * MIN));
    const queued = (await ledgerOf(a, 'job=c1')).rows.find((r) => r.step === 'queued')!;
    expect(queued).toMatchObject({ predictedEnd: new Date(T + MIN).toISOString(), predictedAt: new Date(T + 30_000).toISOString(), actualEnd: new Date(T + 5 * MIN).toISOString() });
    const coding = (await ledgerOf(a, 'job=c1')).rows.find((r) => r.step === 'coding')!;
    expect(coding).toMatchObject({ predictedEnd: new Date(T + 31 * MIN).toISOString(), actualStart: new Date(T + 5 * MIN).toISOString() });
    expect(coding.actualEnd).toBeUndefined();
  });

  it('refuses a bad query (400) and answers an empty ledger', async () => {
    const { a } = await boot();
    for (const q of ['repo=shed', 'job=', 'job=c1&repo=octo%2Fshed', 'note=x', 'period=month', 'timeZone=Mars%2FBase']) expect((await a.api('GET', `/api/delivery-ledger?${q}`)).status).toBe(400);
    expect(await ledgerOf(a, 'job=nope')).toEqual({ rows: [], accuracy: { byStep: [], byRepo: [] }, overTime: { period: 'week', timeZone: 'UTC', points: [] } });
  });
});
