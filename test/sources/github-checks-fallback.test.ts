// Checks fallback (issue #1244): GitHub refuses a pull request's GraphQL rollup (`statusCheckRollup`, issue #855), so its
// checks are `unknown`. The hopper reads them again over REST with the same connection — the head commit's check runs and
// combined status —, so yolo mode merges it when they pass. Where REST refuses them too, they stay `unknown` and say which
// permission the connection lacks and the fix; that repository is not asked again for UNREADABLE_KEEP_MS. Against the
// node:http fake GitHub through the App adapter, and the in-memory fake through the source's follow.
import { afterEach, describe, expect, it } from 'vitest';
import { pullKey } from '../../src/sources/github/api.ts';
import { ACCOUNT_CONNECTION, APP_CONNECTION, UNREADABLE_KEEP_MS, checksFallback } from '../../src/sources/github/checks-fallback.ts';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import type { FakeIssueInput, FakeLack, FakePullFields } from '../../src/sources/github/app/fake-state.ts';
import type { HeadChecks } from '../../src/sources/github/api.ts';
import type { ChecksState } from '../../src/domain/pull-requests.ts';
import { startApp, type AppHarness } from './fixtures/app/setup.ts';
import { REPO, githubConfig, jobForIssue, testTrust } from './fixtures/github-support.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const pull = (number: number, fields: FakePullFields): FakeIssueInput =>
  ({ number, body: 'Closes #1', pullRequest: true, pull: { headRef: `issue-${number}`, headOid: `h${number}`, base: 'dev', mergeable: 'MERGEABLE', checks: 'SUCCESS', ...fields } });

async function app(lacks: FakeLack[], pulls: FakeIssueInput[]) {
  h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', lacks, issues: [{ number: 1, labels: ['hopper'] }, ...pulls] }] }] });
  let now = Date.parse('2026-10-15T10:00:00Z');
  const api = checksFallback(h.api, APP_CONNECTION, () => now);
  const refs = pulls.map((p) => ({ repo: 'owner/a', pullRequest: p.number, issue: 1 }));
  const states = async () => [...(await api.pullRequestStates(refs)).pulls.values()];
  const reads = (what: string) => h!.fake.state.requests.filter((r) => r.path.endsWith(`/${what}`)).length;
  return { api, states, reads, later: (ms: number) => { now += ms; } };
}

describe('checks the rollup would not give, read again over REST (issue #1244)', () => {
  it('the rollup forbidden: the batched read and a read by number give the checks from the check runs and statuses', async () => {
    const a = await app(['rollup'], [pull(2, { checkRuns: [{ status: 'completed', conclusion: 'success' }], statuses: [{ state: 'success' }] })]);
    expect((await h!.api.pullRequestStates([{ repo: 'owner/a', pullRequest: 2, issue: 1 }])).pulls.get(pullKey('owner/a', 2))).toMatchObject({ checks: 'unknown' });
    expect(await a.states()).toMatchObject([{ checks: 'passing' }]);
    expect(await a.api.pullRequest('owner/a', 2)).toMatchObject({ checks: 'passing', headOid: 'h2' });
    expect(await a.states()).not.toContainEqual(expect.objectContaining({ checksWhy: expect.any(String) }));
  });

  it('one failed fails them, one running keeps them pending, none: no checks', async () => {
    const a = await app(['rollup'], [
      pull(2, { checkRuns: [{ status: 'in_progress' }, { status: 'completed', conclusion: 'failure' }] }),
      pull(3, { checkRuns: [{ status: 'completed', conclusion: 'success' }], statuses: [{ state: 'pending' }] }),
      pull(4, {}),
    ]);
    const [failing, pending, none] = await a.states();
    expect(failing).toMatchObject({ checks: 'failing' });
    expect(pending).toMatchObject({ checks: 'pending' });
    expect(none).not.toHaveProperty('checks');
  });

  it('REST refused too: unknown, saying the connection, the permission it lacks and the fix; the repository is asked once', async () => {
    const a = await app(['checks'], [pull(2, {}), pull(3, {}), pull(4, {})]);
    const why = 'the GitHub App lacks Checks: read: add them to the GitHub App and accept them on its installation';
    expect(await a.states()).toEqual([2, 3, 4].map(() => expect.objectContaining({ checks: 'unknown', checksWhy: why, checksRefused: true })));
    expect(a.reads('check-runs')).toBe(1);
    expect(await a.api.pullRequest('owner/a', 2)).toMatchObject({ checks: 'unknown', checksWhy: why });
    expect(a.reads('check-runs')).toBe(1);
    a.later(UNREADABLE_KEEP_MS);
    await a.states();
    expect(a.reads('check-runs')).toBe(2);
  });

  it('both permissions missing: says both', async () => {
    const a = await app(['checks', 'statuses'], [pull(2, {})]);
    expect(await a.states()).toMatchObject([{ checks: 'unknown', checksWhy: expect.stringMatching(/^the GitHub App lacks Checks: read and Commit statuses: read: /) }]);
  });

  it('a REST read that fails otherwise: unknown with GitHub\'s error, not refused, so no checks read problem', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const pr = gh.openPullRequest(REPO, 1, { checks: 'unknown' as ChecksState, headRef: 'issue-1' });
    const failing = Object.assign(Object.create(gh) as typeof gh, { headChecks: async () => { throw new Error('timeout'); } });
    const got = await checksFallback(failing, APP_CONNECTION).pullRequest(REPO, Number(pr.url.split('/').pop()));
    expect(got).toMatchObject({ checks: 'unknown', checksWhy: 'GitHub did not answer the read of its checks: timeout' });
    expect(got).not.toHaveProperty('checksRefused');
  });

  it('checks the rollup gives: no REST read', async () => {
    const a = await app([], [pull(2, { checks: 'PENDING' })]);
    expect(await a.states()).toMatchObject([{ checks: 'pending' }]);
    expect(a.reads('check-runs') + a.reads('status')).toBe(0);
  });
});

describe('a follow in yolo mode over the fallback (issue #1244)', () => {
  // The source's clock is 2026-10-02T10:00; the pull request was opened well before.
  const LONG_AGO = '2026-10-02T09:50:00.000Z';

  async function followed(rest: HeadChecks | undefined) {
    const gh = createFakeGitHub();
    const clock = { now: () => new Date('2026-10-02T10:00:00.000Z') };
    const source = createGitHubSource({
      name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config: githubConfig(),
      api: checksFallback(gh, ACCOUNT_CONNECTION, () => clock.now().getTime()), clock, trust: testTrust(), yoloMode: () => true,
    });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const pr = gh.openPullRequest(REPO, 1, { createdAt: LONG_AGO, checks: 'unknown' as ChecksState, headRef: 'issue-1' });
    if (rest) gh.setHeadChecks(pr.url, rest);
    const base = jobForIssue(1, { status: 'finished', createdAt: '2026-10-02T09:00:00.000Z' });
    const state = await source.report({ kind: 'finished', job: base });
    const outcome = await source.follow!({ ...base, sourceState: { source: state } });
    return { gh, pr, outcome, merges: gh.calls.filter((c) => c.method === 'merge').length };
  }

  it('the rollup forbidden, the REST read says passing: the hopper merges it', async () => {
    const f = await followed({ checks: 'passing' });
    expect(f.outcome).toMatchObject({ outcome: 'merged', pullRequest: f.pr.url, byHopper: true });
    expect(f.merges).toBe(1);
  });

  it('the REST read says pending or failing: it waits', async () => {
    for (const checks of ['pending', 'failing'] as const) {
      const f = await followed({ checks });
      expect(f.outcome).toMatchObject({ outcome: 'open', state: { seen: { checks } } });
      expect(f.merges).toBe(0);
    }
  });

  it('no read works: unknown never merges, and what is seen says why', async () => {
    const f = await followed(undefined);
    expect(f.outcome).toMatchObject({ outcome: 'open', state: { seen: {
      checks: 'unknown', checksRefused: true,
      checksWhy: expect.stringMatching(/^the connected GitHub account lacks Checks: read and Commit statuses: read: .*connect GitHub again$/),
    } } });
    expect(f.merges).toBe(0);
  });
});
