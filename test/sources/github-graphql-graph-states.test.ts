// The issue graph's refresh (issue #1036): one GraphQL request reads the state of up to GRAPH_STATES_MAX issues and pull
// requests, each an alias in it (`issueOrPullRequest`). An item or a repository GitHub does not answer for fails only
// itself. Against the node:http fake GitHub, through the App adapter's port.
import { afterEach, describe, expect, it } from 'vitest';
import { GRAPH_STATES_MAX } from '../../src/sources/github/app/graphql-graph-states.ts';
import { itemKey } from '../../src/sources/github/api.ts';
import type { FakeIssueInput, FakeRepoInput } from '../../src/sources/github/app/fake-state.ts';
import { startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const graphqlRequests = (a: AppHarness) => a.fake.state.requests.filter((r) => r.path === '/graphql');
const repo = (name: string, issues: FakeIssueInput[], owner = 'owner'): FakeRepoInput => ({ owner, name, issues });

describe('the states of issue graph items in one batched read (issue #1036)', () => {
  it('reads issues and pull requests of two repositories, with why a closed issue closed, in one request', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [
      repo('a', [
        { number: 1 },
        { number: 2, state: 'closed', stateReason: 'completed' },
        { number: 3, state: 'closed', stateReason: 'not_planned' },
        { number: 4, body: 'Closes #1', pullRequest: true, pull: { state: 'MERGED' }, state: 'closed' },
      ]),
      repo('b', [{ number: 5, body: '', pullRequest: true, pull: {} }]),
    ] }] });
    const got = await h.api.graphStates!([
      { repo: 'owner/a', number: 1 }, { repo: 'owner/a', number: 2 }, { repo: 'owner/a', number: 3 },
      { repo: 'owner/a', number: 4 }, { repo: 'owner/b', number: 5 },
    ]);
    expect(got.errors.size).toBe(0);
    expect(got.items.get(itemKey('owner/a', 1))).toEqual({ kind: 'issue', state: 'open' });
    expect(got.items.get(itemKey('owner/a', 2))).toEqual({ kind: 'issue', state: 'closed', stateReason: 'completed' });
    expect(got.items.get(itemKey('owner/a', 3))).toEqual({ kind: 'issue', state: 'closed', stateReason: 'not_planned' });
    expect(got.items.get(itemKey('owner/a', 4))).toEqual({ kind: 'pull_request', state: 'merged' });
    expect(got.items.get(itemKey('owner/b', 5))).toEqual({ kind: 'pull_request', state: 'open' });
    expect(graphqlRequests(h)).toHaveLength(1);
  });

  it(`${GRAPH_STATES_MAX + 1} items are two requests`, async () => {
    const n = GRAPH_STATES_MAX + 1;
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', Array.from({ length: n }, (_, i) => ({ number: i + 1 })))] }] });
    const got = await h.api.graphStates!(Array.from({ length: n }, (_, i) => ({ repo: 'owner/a', number: i + 1 })));
    expect(got.items.size).toBe(n);
    expect(graphqlRequests(h)).toHaveLength(2);
  });

  it('an item GitHub does not know, or a repository the app is not installed on, fails only itself', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [{ number: 1 }])] }] });
    const got = await h.api.graphStates!([{ repo: 'owner/a', number: 1 }, { repo: 'owner/a', number: 9 }, { repo: 'owner/gone', number: 1 }]);
    expect(got.items.get(itemKey('owner/a', 1))).toMatchObject({ state: 'open' });
    expect(got.errors.get(itemKey('owner/a', 9))).toMatch(/Could not resolve/);
    expect(got.errors.get(itemKey('owner/gone', 1))).toMatch(/not installed/);
  });

  it('none asked is no request', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [])] }] });
    expect((await h.api.graphStates!([])).items.size).toBe(0);
    expect(graphqlRequests(h)).toHaveLength(0);
  });
});
