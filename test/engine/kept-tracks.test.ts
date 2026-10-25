// The kept-track pass (issue #2775, design.md "Kept delivery tracks") on the real database (tenant migration 101): each
// job's track is kept from its start, every step it starts and ends is recorded on it, and it closes only with its one
// deployment record. The pass goes on from its cursor after a restart, by a new hopper on the same database.
//
// Feature: kept delivery tracks
//   Scenario: a job queued has a kept track at the next pass; a pass with nothing new writes nothing
//   Scenario: a fix merged on the landing branch but not promoted is kept open in landing_checks; after a restart, its batch run moves it on
//   Scenario: a change past production closes with a deploy record; a failed job and a research job close with a none record
//   Scenario: the deployment records are queried on their own, by job, repository, target and kind
//   Scenario: a closed track is final: a save of it open writes nothing over it
import { describe, expect, it } from 'vitest';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';
import type { UserStore } from '../../src/domain/store.ts';
import type { EventType } from '../../src/domain/types.ts';
import { keepDeliveryTracks } from '../../src/engine/kept-tracks.ts';
import { fixedClock, spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const REPO = 'octo/shed';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const T = Date.parse('2026-10-20T08:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const add = (s: UserStore, type: EventType, at: number, data: Record<string, unknown>, jobId?: string) =>
  s.events.append({ type, at: iso(at), data, ...(jobId ? { jobId } : {}) });
const queue = (s: UserStore, n: number, at: number): string => {
  const job = s.jobs.create(spec, 50);
  add(s, 'job.queued', at, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: `k${n}`, repo: REPO, number: n } }, job.id);
  return job.id;
};
/** Started, its pull request opened, finished and merged: 10 minutes each. */
const merge = (s: UserStore, id: string, n: number, at: number) => {
  add(s, 'job.started', at, { attempts: 1 }, id);
  add(s, 'job.pull_request_followed', at + MIN, { pullRequest: pr(n), part: false }, id);
  add(s, 'job.finished', at + 10 * MIN, { result: {} }, id);
  s.jobs.update(id, { status: 'finished' });
  add(s, 'job.pull_request_merged', at + 20 * MIN, { pullRequest: pr(n), part: false }, id);
};
const promote = (s: UserStore, merges: number[], batch: number, at: number) => {
  add(s, 'landing_batch.started', at, { repo: REPO, landing: 'main', tested: 'dev', tip: 'a'.repeat(40), branch: `hopper-batch/${batch}`, pullRequest: batch, url: pr(batch), merges });
  add(s, 'landing_batch.promoted', at + 10 * MIN, { repo: REPO, tested: 'dev', tip: 'a'.repeat(40), pullRequest: batch, url: pr(batch) });
};

/** Each day at 12:00 UTC; test gate an hour after it, production an hour after that. */
const schedule: PromotionSetSchedule = {
  timeZone: 'UTC', cutoffs: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, time: '12:00' })), testGateAfterMinutes: 60,
  productionAfterMinutes: 60, epoch: '2026-10-01T00:00:00.000Z', expedite: 'none',
};

describe('the kept-track pass', () => {
  it('keeps each track from its start, goes on after a restart, and closes each with one deployment record', () => {
    const url = t.url();
    let s = t.open(url, fixedClock(iso(T)));
    const j1 = queue(s, 1, T);
    expect(keepDeliveryTracks(s, new Date(T + MIN))).toBe(1);
    expect(s.keptTracks.get(j1)).toMatchObject({ state: 'open', repo: REPO, issue: `${REPO}#1`, current: { step: 'queued', since: iso(T) } });
    expect(keepDeliveryTracks(s, new Date(T + MIN))).toBe(0);

    // Merged on the landing branch, not promoted: open in landing_checks, not done.
    merge(s, j1, 11, T + 2 * MIN);
    const research = queue(s, 2, T + 3 * MIN);
    add(s, 'job.started', T + 4 * MIN, { attempts: 1 }, research);
    add(s, 'job.finished', T + 9 * MIN, { result: {} }, research);
    s.jobs.update(research, { status: 'finished', researchId: 'r1' });
    const failed = queue(s, 3, T + 3 * MIN);
    s.jobs.update(failed, { status: 'failed' });
    expect(keepDeliveryTracks(s, new Date(T + 30 * MIN))).toBe(3);
    expect(s.keptTracks.get(j1)).toMatchObject({ state: 'open', pullRequest: pr(11), current: { step: 'landing_checks', since: iso(T + 22 * MIN), blocker: 'ci_red' } });
    expect(s.keptTracks.get(j1)!.steps.map((x) => x.step)).toEqual(['queued', 'coding', 'pr_checks', 'landing', 'landing_checks']);
    expect(s.keptTracks.get(research)!.deployment).toEqual({ jobId: research, repo: REPO, at: iso(T + 9 * MIN), kind: 'none', source: `${REPO}#2`, outcome: { status: 'finished', report: 'research' } });
    expect(s.keptTracks.get(failed)!.deployment).toMatchObject({ kind: 'none', outcome: { status: 'failed' } });
    expect(s.keptTracks.list({ state: 'open' }).map((x) => x.jobId)).toEqual([j1]);
    s.close();

    // A new hopper on the same database: its batch run is folded from the cursor on, and the schedule delivers it.
    s = t.open(url, fixedClock(iso(T + 60 * MIN)));
    promote(s, [11], 900, T + 40 * MIN);
    s.settings.setDeliverySettings({ repos: { [REPO]: { schedule, gates: {} } } });
    expect(keepDeliveryTracks(s, new Date(T + 4.5 * 60 * MIN))).toBe(1);
    expect(s.keptTracks.get(j1)).toMatchObject({ state: 'open', current: { step: 'test_gate', since: '2026-10-20T12:00:00.000Z' } });
    expect(keepDeliveryTracks(s, new Date(Date.parse('2026-10-20T14:30:00.000Z')))).toBe(1);
    const done = s.keptTracks.get(j1)!;
    expect(done).toMatchObject({ state: 'closed', closedAt: '2026-10-20T14:00:00.000Z' });
    expect(done.deployment).toMatchObject({ kind: 'deploy', artifact: { pullRequest: pr(11) }, target: 'production', expected: 'delivered' });
    expect(done.steps.map((x) => [x.step, x.end])).toEqual([
      ['queued', iso(T + 2 * MIN)], ['coding', iso(T + 12 * MIN)], ['pr_checks', iso(T + 22 * MIN)], ['landing', iso(T + 22 * MIN)],
      ['landing_checks', iso(T + 50 * MIN)], ['promotion_set', '2026-10-20T12:00:00.000Z'], ['test_gate', '2026-10-20T13:00:00.000Z'], ['production', '2026-10-20T14:00:00.000Z'],
    ]);
    expect(keepDeliveryTracks(s, new Date(Date.parse('2026-10-21T14:30:00.000Z')))).toBe(0);

    // Every job has exactly one deployment record, queried on its own.
    expect(s.keptTracks.deployments().map((d) => [d.jobId, d.kind]).sort()).toEqual([[j1, 'deploy'], [failed, 'none'], [research, 'none']].sort());
    expect(s.keptTracks.deployments({ target: 'production' }).map((d) => d.jobId)).toEqual([j1]);
    expect(s.keptTracks.deployments({ kind: 'none', repo: 'Octo/Shed' })).toHaveLength(2);
    expect(s.keptTracks.deployments({ job: research })).toHaveLength(1);

    // A closed track is final: a save of it open writes nothing over it, nor a second deployment record.
    s.keptTracks.save([{ ...done, state: 'open' }]);
    expect(s.keptTracks.get(j1)!.state).toBe('closed');
    s.close();
  });

  it('the first pass keeps the tracks of the last 30 days only', () => {
    const s = t.open(t.url(), fixedClock(iso(T)));
    queue(s, 1, T - 40 * 86_400_000);
    const recent = queue(s, 2, T - 86_400_000);
    keepDeliveryTracks(s, new Date(T));
    expect(s.keptTracks.list().map((x) => x.jobId)).toEqual([recent]);
    expect(s.keptTracks.cursor()).toBeGreaterThan(0);
    s.close();
  });
});
