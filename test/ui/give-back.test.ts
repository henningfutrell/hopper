// @vitest-environment happy-dom
// Issue #1194: Run again and Rework are answered before the job's source gives the item back. The page keeps each one it
// sent until the stream says how it ended — the new job queued, or the give-back failed —, and sends nothing more meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Event = { seq: number; type: string; jobId?: string; data: Record<string, unknown> };
interface Store {
  useGivingBack: { getState(): Record<string, string>; setState(s: Record<string, string>, replace?: boolean): void };
  giveBack(jobId: string, act: 'rerun' | 'rework', body?: unknown): Promise<boolean>;
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
    expect(await store.giveBack('j1', 'rework', { notes: 'Rename the flag.' })).toBe(true);
    expect(posts).toEqual([{ path: '/ui/api/jobs/j1/rework', body: { notes: 'Rename the flag.' } }]);
    store.onGiveBackEvent({ seq: 1, type: 'job.give_back_failed', jobId: 'j1', data: { act: 'rework', error: 'GitHub answered 502' } });
    expect(store.useGivingBack.getState()).toEqual({});
    expect(await store.giveBack('j1', 'rework', { notes: 'Rename the flag.' })).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it('a refusal ends it at once', async () => {
    answer = { status: 409, body: { error: 'job j1 cannot run again: a newer job of its item exists' } };
    expect(await store.giveBack('j1', 'rerun')).toBe(false);
    expect(store.useGivingBack.getState()).toEqual({});
  });
});
