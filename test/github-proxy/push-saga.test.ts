// Issue #1806: a job's push is a durable work item (issue #1524, design.md "A push kept as a saga"). The git broker keeps
// each push as a `git-push` saga before it reaches GitHub; the push's event is recorded once. A hopper that stops while
// GitHub has the push leaves the saga to the next one, which reads the refs on GitHub and records what the push did. The
// git broker, its saga and the coordinator on the real database; GitHub a fake at the fetch.
//
// Feature: a push kept as a saga
//   Scenario: a push GitHub answers: the saga ends done, one event
//   Scenario: the hopper stops while GitHub has the push, and GitHub took it: the next hopper records it done
//   Scenario: the hopper stops while GitHub has the push, and GitHub did not take it: the next hopper records it failed
//   Scenario: the event was recorded before the stop: the next hopper records nothing again
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import { createGitProxy, holdsProxyToken, proxyToken, type GitConnection, type GitUser } from '../../src/github-proxy/index.ts';
import { createGitPushes, GIT_PUSH_SAGA } from '../../src/github-proxy/push-saga.ts';
import { createSagaCoordinator, type SagaCoordinator } from '../../src/sagas/coordinator.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const temp = useTempStore();
const quiet = { info: () => {}, warn: () => {} };
const key = mintLinkKey().privateKey;
const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'acme/api' } } as Job;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BRANCH = 'refs/heads/issue-7-fix';

const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const auth = `Basic ${Buffer.from(`x:${proxyToken(key, 'u1', 'job-1')}`).toString('base64')}`;
const push = { method: 'POST', path: 'acme/api.git/git-receive-pack', authorization: auth, body: Buffer.from(`${pkt(`${A} ${B} ${BRANCH}\0report-status\n`)}0000PACK`) };

/** GitHub as the fetch reaches it: the refs it holds, and a receive-pack that answers, or takes the push and never answers. */
interface GitHub { refs: Map<string, string>; hang?: 'took' | 'lost'; asked: string[]; hung?: () => void }

function fakeFetch(gh: GitHub): typeof fetch {
  return (async (url: string) => {
    gh.asked.push(url);
    if (url.endsWith('/git-receive-pack')) {
      if (gh.hang === 'took') gh.refs.set(BRANCH, B);
      if (gh.hang) { gh.hung?.(); return new Promise(() => {}); }
      gh.refs.set(BRANCH, B);
      return new Response('0000', { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
    }
    if (url.endsWith('/info/refs?service=git-upload-pack')) {
      const lines = [...gh.refs].map(([ref, sha], i) => pkt(`${sha} ${ref}${i === 0 ? '\0multi_ack side-band-64k' : ''}\n`));
      return new Response(`${pkt('# service=git-upload-pack\n')}0000${lines.join('')}0000`, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    }
    return new Response('not here', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('a push kept as a saga (issue #1806)', () => {
  const stores: InstanceStore[] = [], coordinators: SagaCoordinator[] = [];
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((c) => c.stop()));
    for (const s of stores.splice(0)) s.close();
  });

  /** One hopper start on the shared database: its git broker, its pushes and its coordinator; `events`, the user's log. */
  const hopper = (url: string, gh: GitHub, events: NewEvent[], owner: string) => {
    const clock = fixedClock();
    const store = openInstanceStore({ url, clock });
    stores.push(store);
    const connection: GitConnection = {
      url: 'https://github.example', login: 'ada', token: async () => 'tok', renew: async () => 'tok',
      repo: async () => ({ canPush: true, defaultBranch: 'dev', fork: false }) as never, pullRequestBase: async () => undefined,
    };
    const user: GitUser = {
      user: { id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); } },
      jobRepositories: () => ['acme/api'], contribution: () => false, git: () => connection,
      recorded: (jobId, requestId) => events.some((e) => e.jobId === jobId && (e.data as { requestId?: string }).requestId === requestId),
    };
    const fetch = fakeFetch(gh);
    const held: { c?: SagaCoordinator } = {};
    const pushes = createGitPushes({ user: (id) => (id === 'u1' ? user : undefined), begin: (k, data, userId) => { held.c!.begin(GIT_PUSH_SAGA, k, data, { userId }); }, fetch });
    const c = held.c = createSagaCoordinator({ repo: store.sagas, definitions: [pushes.saga], owner, clock, idGen: randomUUID, logger: quiet });
    coordinators.push(c);
    const git = createGitProxy({ user: (id) => (id === 'u1' ? user : undefined), log: () => undefined, fetch, traffic: { gitFetch: () => undefined } as never, pushes });
    return { store, c, git };
  };

  const pushEvents = (events: NewEvent[]) => events.filter((e) => e.type.startsWith('github_proxy.'));
  const sagasOf = (store: InstanceStore) => store.sagas.open().filter((s) => s.kind === GIT_PUSH_SAGA);

  it('a push GitHub answers: the saga ends done, and the push is one event', async () => {
    const gh: GitHub = { refs: new Map([['refs/heads/dev', A]]), asked: [] };
    const events: NewEvent[] = [];
    const a = hopper(temp.url(), gh, events, 'host-a');
    expect((await a.git.handle(push)).status).toBe(200);
    await vi.waitFor(() => { expect(sagasOf(a.store)).toEqual([]); });
    expect(pushEvents(events)).toEqual([expect.objectContaining({ type: 'github_proxy.done', jobId: 'job-1', data: expect.objectContaining({ op: 'git.push', repo: 'acme/api', refs: [BRANCH] }) })]);
    expect(gh.asked.filter((u) => u.includes('info/refs'))).toEqual([]);
  });

  /** A first hopper stops while GitHub has the push; a second one, on the same database, takes the saga. */
  const stoppedMidPush = async (hang: 'took' | 'lost', events: NewEvent[]) => {
    const url = temp.url();
    const gh: GitHub = { refs: new Map([['refs/heads/dev', A]]), hang, asked: [] };
    const a = hopper(url, gh, events, 'host-a');
    const hung = new Promise<void>((resolve) => { gh.hung = resolve; });
    void a.git.handle(push);
    await hung;
    expect(sagasOf(a.store)).toHaveLength(1);
    await a.c.stop();
    const b = hopper(url, { ...gh, hang: undefined, asked: [] }, events, 'host-b');
    await b.c.pass();
    return { b, gh };
  };

  it('the hopper stops while GitHub has the push, and GitHub took it: the next hopper records it done', async () => {
    const events: NewEvent[] = [];
    const { b } = await stoppedMidPush('took', events);
    expect(pushEvents(events)).toEqual([expect.objectContaining({ type: 'github_proxy.done', data: expect.objectContaining({ op: 'git.push', repo: 'acme/api', refs: [BRANCH], as: 'ada', machine: 'm' }) })]);
    expect(sagasOf(b.store)).toEqual([]);
  });

  it('the hopper stops while GitHub has the push, and GitHub did not take it: the next hopper records it failed', async () => {
    const events: NewEvent[] = [];
    const { b } = await stoppedMidPush('lost', events);
    expect(pushEvents(events)).toEqual([expect.objectContaining({
      type: 'github_proxy.failed',
      data: expect.objectContaining({ op: 'git.push', refs: [BRANCH], error: 'the hopper stopped before GitHub answered the push, and GitHub does not have it: push again' }),
    })]);
    expect(sagasOf(b.store)).toEqual([]);
  });

  it('the event was recorded before the stop: the next hopper records nothing again', async () => {
    const events: NewEvent[] = [];
    const url = temp.url();
    const gh: GitHub = { refs: new Map([['refs/heads/dev', A]]), hang: 'took', asked: [] };
    const a = hopper(url, gh, events, 'host-a');
    const hung = new Promise<void>((resolve) => { gh.hung = resolve; });
    void a.git.handle(push);
    await hung;
    const [saga] = sagasOf(a.store);
    events.push({ type: 'github_proxy.done', jobId: 'job-1', data: { requestId: (saga!.data as { requestId: string }).requestId, op: 'git.push', repo: 'acme/api', refs: [BRANCH] } });
    await a.c.stop();
    const b = hopper(url, { ...gh, hang: undefined, asked: [] }, events, 'host-b');
    await b.c.pass();
    expect(pushEvents(events)).toHaveLength(1);
    expect(sagasOf(b.store)).toEqual([]);
  });
});
