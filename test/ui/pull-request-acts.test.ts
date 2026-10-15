// @vitest-environment happy-dom
// Issue #1194, part 5: Merge now and Close PR are answered before GitHub merges or closes the pull request. The page keeps
// each one it sent until the stream says how it ended — merged, closed, or the act failed with why —, and sends nothing
// more meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Event = { seq: number; type: string; jobId?: string; data: Record<string, unknown> };
interface Store {
  useActingOnPullRequest: { getState(): Record<string, string>; setState(s: Record<string, string>, replace?: boolean): void };
  actOnPullRequest(jobId: string, act: 'merge' | 'close', ended?: () => void): Promise<boolean>;
  onPullRequestActEvent(e: Event): void;
}
const path = '../../ui/src/store/pull-request-acts.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
let store: Store;
const posts: { path: string; body: unknown }[] = [];
let answer = { status: 202, body: { jobId: 'j1', act: 'merge' } as unknown };

beforeEach(async () => {
  posts.length = 0;
  answer = { status: 202, body: { jobId: 'j1', act: 'merge' } };
  vi.stubGlobal('fetch', vi.fn(async (p: string, init: { body: string }) => {
    posts.push({ path: p, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }));
  store = (await import(path)) as Store;
  store.useActingOnPullRequest.setState({}, true);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Merge now and Close PR wait for GitHub on the stream (issue #1194)', () => {
  it('sends once, waits from the click on, and ends with the merge', async () => {
    let ended = 0;
    expect(await store.actOnPullRequest('j1', 'merge', () => { ended += 1; })).toBe(true);
    expect(store.useActingOnPullRequest.getState()).toEqual({ j1: 'merge' });
    expect(await store.actOnPullRequest('j1', 'close')).toBe(false);
    expect(posts).toEqual([{ path: '/ui/api/pull-requests/merge', body: { jobId: 'j1' } }]);
    store.onPullRequestActEvent({ seq: 1, type: 'job.pull_request_merged', jobId: 'j2', data: {} });
    expect(store.useActingOnPullRequest.getState()).toEqual({ j1: 'merge' });
    store.onPullRequestActEvent({ seq: 2, type: 'job.pull_request_merged', jobId: 'j1', data: { person: 'Pat', via: 'ui' } });
    expect(store.useActingOnPullRequest.getState()).toEqual({});
    expect(ended).toBe(1);
  });

  it('Close PR ends with the close; a failed act ends it, and it can be sent again', async () => {
    expect(await store.actOnPullRequest('j1', 'close')).toBe(true);
    store.onPullRequestActEvent({ seq: 1, type: 'job.pull_request_closed', jobId: 'j1', data: {} });
    expect(store.useActingOnPullRequest.getState()).toEqual({});
    expect(await store.actOnPullRequest('j1', 'merge')).toBe(true);
    store.onPullRequestActEvent({ seq: 2, type: 'job.pull_request_act_failed', jobId: 'j1', data: { act: 'merge', error: 'merge refused: not mergeable' } });
    expect(store.useActingOnPullRequest.getState()).toEqual({});
    expect(await store.actOnPullRequest('j1', 'merge')).toBe(true);
    expect(posts.map((p) => p.path)).toEqual(['/ui/api/pull-requests/close', '/ui/api/pull-requests/merge', '/ui/api/pull-requests/merge']);
  });

  it('a refusal ends it at once', async () => {
    answer = { status: 409, body: { error: 'job j1 has no open pull request' } };
    expect(await store.actOnPullRequest('j1', 'merge')).toBe(false);
    expect(store.useActingOnPullRequest.getState()).toEqual({});
  });
});
