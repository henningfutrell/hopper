// A person's delivery hold and its release (issue #2775 part 8, design.md "Part 8: the hold and release routes"), over the real HTTP server and
// database: POST /ui/api/delivery-tracks/hold pauses the change at its step, or takes ownership of it (`owner` `person`);
// POST /ui/api/delivery-tracks/release lets it go on, or hands it back. GET /api/delivery-tracks answers the acts each
// track's step allows. A refused act appends no event and leaves the track as it was.
//
// Feature: the hold and release routes
//   Scenario: a fix merged but not promoted is held, then released; each act is kept on its track and its acts follow
//   Scenario: a person takes ownership of a change and hands it back
//   Scenario: an act the step does not allow is refused (409) and changes nothing; an unknown job, 404; a bad body, 400
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryTracksView, KeptTrack } from '../../src/domain/kept-tracks.ts';
import type { EventType } from '../../src/domain/types.ts';
import { keepDeliveryTracks } from '../../src/engine/kept-tracks.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const MIN = 60_000;
const REPO = 'octo/shed';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

async function boot(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  const t = Date.now() - 60 * MIN;
  const add = (type: EventType, at: number, data: Record<string, unknown>, jobId: string) =>
    a.user().store.events.append({ type, at: new Date(at).toISOString(), data, jobId });
  const queued = (id: string, n: number) => add('job.queued', t, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: `k${n}`, repo: REPO, number: n } }, id);
  queued('fix', 1);
  add('job.started', t + MIN, { attempts: 1 }, 'fix');
  add('job.pull_request_followed', t + 2 * MIN, { pullRequest: pr(11), part: false }, 'fix');
  add('job.finished', t + 10 * MIN, { result: {} }, 'fix');
  add('job.pull_request_merged', t + 20 * MIN, { pullRequest: pr(11), part: false }, 'fix');
  queued('fresh', 2);
  queued('research', 3);
  add('job.started', t + MIN, { attempts: 1 }, 'research');
  add('job.finished', t + 5 * MIN, { result: {} }, 'research');
  keepDeliveryTracks(a.user().store, new Date());
  return { a, token: await a.login() };
}

type WithActs = KeptTrack & { acts?: string[] };
const trackOf = async (a: TestApp, job: string) => (await a.api<DeliveryTracksView>('GET', `/api/delivery-tracks?job=${job}`)).body.tracks[0] as WithActs;
const holdEvents = (a: TestApp) => a.user().store.events.recent(20, ['delivery_track.held', 'delivery_track.released']);

describe('the hold and release routes (issue #2775 part 8)', () => {
  it('a fix merged but not promoted is held, then released; each act is kept on its track and its acts follow', async () => {
    const { a, token } = await boot();
    expect((await trackOf(a, 'fix')).acts).toEqual(['hold', 'take_ownership']);
    const held = await a.ui<WithActs>('/ui/api/delivery-tracks/hold', { job: 'fix', reason: 'wait for the docs' }, { token });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ state: 'open', hold: { step: 'landing_checks', owner: 'hopper', reason: 'wait for the docs', by: expect.any(String) }, acts: ['release'] });
    expect(held.body.interventions).toEqual([expect.objectContaining({ act: 'hold', step: 'landing_checks', owner: 'hopper' })]);
    expect(holdEvents(a).map((e) => [e.type, e.jobId, (e.data as { step: string }).step])).toEqual([['delivery_track.held', 'fix', 'landing_checks']]);
    expect(await trackOf(a, 'fix')).toMatchObject({ hold: { owner: 'hopper' }, acts: ['release'] });
    // The pass folds the same event again: the intervention is kept once.
    keepDeliveryTracks(a.user().store, new Date());
    expect((await trackOf(a, 'fix')).interventions).toHaveLength(1);
    // Held already: a second hold is refused.
    expect((await a.ui('/ui/api/delivery-tracks/hold', { job: 'fix' }, { token })).status).toBe(409);
    const released = await a.ui<WithActs>('/ui/api/delivery-tracks/release', { job: 'fix' }, { token });
    expect(released.status).toBe(200);
    expect(released.body.hold).toBeUndefined();
    expect(released.body.acts).toEqual(['hold', 'take_ownership']);
    expect(released.body.interventions?.map((i) => i.act)).toEqual(['hold', 'release']);
    expect((await a.ui('/ui/api/delivery-tracks/release', { job: 'fix' }, { token })).status).toBe(409);
    expect(holdEvents(a)).toHaveLength(2);
  });

  it('a person takes ownership of a change and hands it back', async () => {
    const { a, token } = await boot();
    const taken = await a.ui<WithActs>('/ui/api/delivery-tracks/hold', { job: 'fix', owner: 'person', reason: 'I ship this one by hand' }, { token });
    expect(taken.status).toBe(200);
    expect(taken.body.hold).toMatchObject({ owner: 'person', reason: 'I ship this one by hand' });
    const back = await a.ui<WithActs>('/ui/api/delivery-tracks/release', { job: 'fix', reason: 'back to the hopper' }, { token });
    expect(back.body.interventions?.at(-1)).toMatchObject({ act: 'release', reason: 'back to the hopper' });
  });

  it('refuses an act the step does not allow (409) and changes nothing; an unknown job, 404; a bad body, 400', async () => {
    const { a, token } = await boot();
    // A queued job's change: Park and Pick up reach it, not a hold.
    expect((await trackOf(a, 'fresh')).acts).toEqual([]);
    expect((await a.ui('/ui/api/delivery-tracks/hold', { job: 'fresh' }, { token })).status).toBe(409);
    // A closed track allows no act.
    expect((await trackOf(a, 'research')).acts).toEqual([]);
    expect((await a.ui('/ui/api/delivery-tracks/hold', { job: 'research', owner: 'person' }, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/delivery-tracks/release', { job: 'research' }, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/delivery-tracks/hold', { job: 'nope' }, { token })).status).toBe(404);
    for (const body of [{}, { job: 'fix', owner: 'nobody' }, { job: 'fix', reason: '' }, { job: 'fix', step: 'production' }]) {
      expect((await a.ui('/ui/api/delivery-tracks/hold', body, { token })).status, JSON.stringify(body)).toBe(400);
    }
    expect(holdEvents(a)).toEqual([]);
    expect((await trackOf(a, 'fix')).interventions).toBeUndefined();
  });
});
