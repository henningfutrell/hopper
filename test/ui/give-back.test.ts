// @vitest-environment happy-dom
// Issue #1194: Run again, Rework, Retry, a hand-off's Continue and I fixed it, Push it and Tend again are answered before
// the job's source gives the item back. The page keeps each one it sent until the stream says how it ended — the new job
// queued or the job going on, or the give-back failed —, and sends nothing more meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Event = { seq: number; type: string; jobId?: string; data: Record<string, unknown> };
interface Store {
  useGivingBack: { getState(): Record<string, string>; setState(s: Record<string, string>, replace?: boolean): void };
  giveBack(jobId: string, act: string, o?: { path?: string; body?: unknown; ended?: () => void }): Promise<boolean>;
  onGiveBackEvent(e: Event): void;
}
const path = '../../ui/src/store/give-back.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
let store: Store;
const posts: { path: string; body: unknown }[] = [];
let answer = { status: 202, body: { jobId: 'j1', giveBack: 'rerun' } as unknown };

beforeEach(async () => {
  posts.length = 0;
  answer = { status: 202, body: { jobId: 'j1', giveBack: 'rerun' } };
  vi.stubGlobal('fetch', vi.fn(async (p: string, init: { body: string }) => {
    posts.push({ path: p, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }));
  store = (await import(path)) as Store;
  store.useGivingBack.setState({}, true);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Run again and Rework wait for their give-back on the stream (issue #1194)', () => {
  it('sends once, waits from the click on, and ends with the new job\'s event', async () => {
    expect(await store.giveBack('j1', 'rerun')).toBe(true);
    expect(store.useGivingBack.getState()).toEqual({ j1: 'rerun' });
    expect(await store.giveBack('j1', 'rerun')).toBe(false);
    expect(posts.map((p) => p.path)).toEqual(['/ui/api/jobs/j1/rerun']);
    store.onGiveBackEvent({ seq: 1, type: 'job.rerun', jobId: 'j2', data: {} });
    expect(store.useGivingBack.getState()).toEqual({ j1: 'rerun' });
    store.onGiveBackEvent({ seq: 2, type: 'job.rerun', jobId: 'j1', data: { by: 'user' } });
    expect(store.useGivingBack.getState()).toEqual({});
  });

  it('Rework sends its notes; a failed give-back ends it, and it can be sent again', async () => {
    expect(await store.giveBack('j1', 'rework', { body: { notes: 'Rename the flag.' } })).toBe(true);
    expect(posts).toEqual([{ path: '/ui/api/jobs/j1/rework', body: { notes: 'Rename the flag.' } }]);
    store.onGiveBackEvent({ seq: 1, type: 'job.give_back_failed', jobId: 'j1', data: { act: 'rework', error: 'GitHub answered 502' } });
    expect(store.useGivingBack.getState()).toEqual({});
    expect(await store.giveBack('j1', 'rework', { body: { notes: 'Rename the flag.' } })).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it('the acts of Failures and Pull requests go to their own route, and end with the job going on or the tend (part 4)', async () => {
    let ended = 0;
    expect(await store.giveBack('j1', 'push', { path: '/ui/api/failures/kept-work/j1/push', body: { note: 'x' }, ended: () => { ended += 1; } })).toBe(true);
    expect(await store.giveBack('j2', 'tend', { path: '/ui/api/pull-requests/tend', body: { jobId: 'j2' } })).toBe(true);
    expect(await store.giveBack('j3', 'retry', { path: '/ui/api/failures/f3/retry' })).toBe(true);
    expect(posts).toEqual([
      { path: '/ui/api/failures/kept-work/j1/push', body: { note: 'x' } }, { path: '/ui/api/pull-requests/tend', body: { jobId: 'j2' } }, { path: '/ui/api/failures/f3/retry', body: {} },
    ]);
    expect(store.useGivingBack.getState()).toEqual({ j1: 'push', j2: 'tend', j3: 'retry' });
    store.onGiveBackEvent({ seq: 1, type: 'job.continued', jobId: 'j1', data: { keptWork: true } });
    store.onGiveBackEvent({ seq: 2, type: 'job.pull_request_tended', jobId: 'j2', data: {} });
    store.onGiveBackEvent({ seq: 3, type: 'job.give_back_failed', jobId: 'j3', data: { act: 'retry', error: 'its job is done at its source' } });
    expect(store.useGivingBack.getState()).toEqual({});
    expect(ended).toBe(1);
  });

  it('a refusal ends it at once', async () => {
    answer = { status: 409, body: { error: 'job j1 cannot run again: a newer job of its item exists' } };
    expect(await store.giveBack('j1', 'rerun')).toBe(false);
    expect(store.useGivingBack.getState()).toEqual({});
  });
});
