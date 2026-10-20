// The newest run of each check (issue #2129): a check that ran again on the same head commit — a new workflow run that an
// edit of the pull request's body started, for example — supersedes its older runs, as GitHub's required checks read them.
// An older run that failed does not fail the checks when a newer run of the same check passed. Read by GraphQL (a read by
// number, the batched read), by REST (the checks fallback, the done criteria's check runs), and by the GitHub proxy's own
// read of a pull request the hopper does not follow.
import { afterEach, describe, expect, it } from 'vitest';
import { runChecks } from '../../src/github-proxy/api.ts';
import { pullKey } from '../../src/sources/github/api.ts';
import { ACCOUNT_CONNECTION, checksFallback } from '../../src/sources/github/checks-fallback.ts';
import { pullRequestFrom } from '../../src/sources/github/closer.ts';
import type { FakeIssueInput, FakeLack, FakePullFields } from '../../src/sources/github/http/fake-state.ts';
import type { Request } from '../../src/sources/github/http/http.ts';
import { checkRuns } from '../../src/sources/github/http/rest-checks.ts';
import { newestRuns } from '../../src/sources/github/newest-runs.ts';
import { startApp, type AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const AT = '2026-10-19T10:00:00Z';
const run = (databaseId: number, name: string, conclusion: string | null, status = conclusion ? 'COMPLETED' : 'IN_PROGRESS') =>
  ({ __typename: 'CheckRun', databaseId, name, status, conclusion });
/** Run A (a push) failed two checks; run B (a body edit) on the same head passed every check. */
const RERUN = [run(1, 'plan', 'FAILURE'), run(2, 'verdict', 'FAILURE'), run(3, 'lint', 'SUCCESS'), run(4, 'plan', 'SUCCESS'), run(5, 'verdict', 'SUCCESS')];
const withRollup = (state: string, nodes: unknown[], totalCount = nodes.length) => ({ data: { repository: { issueOrPullRequest: {
  __typename: 'PullRequest', url: 'https://github.com/owner/repo/pull/7', createdAt: AT, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { committedDate: AT, statusCheckRollup: { state, contexts: { totalCount, nodes } } } }] },
} } } });

describe('the newest run of each check (issue #2129)', () => {
  it('keeps the newest run of each name by id, else the later one, in order; a run with no name stays', () => {
    const runs = [{ n: 'a', id: 5 }, { n: 'b', id: 2 }, { n: 'a', id: 3 }, { n: 'b', id: 4 }, { n: undefined, id: 1 }, { n: 'c' }, { n: 'c' }];
    expect(newestRuns(runs, (r) => r.n, (r) => r.id)).toEqual([{ n: 'a', id: 5 }, { n: 'b', id: 4 }, { n: undefined, id: 1 }, runs[6]]);
  });

  it('GraphQL: an older run failed, a newer run of each failed check passed: passing, and no failed checks', () => {
    const r = pullRequestFrom(withRollup('FAILURE', RERUN), 'pull request');
    expect(r?.checks).toBe('passing');
    expect(r?.failedChecks).toBeUndefined();
  });

  it('GraphQL: a newer run still runs: pending; a newer run failed: failing, with the newer run only', () => {
    expect(pullRequestFrom(withRollup('FAILURE', [run(1, 'plan', 'FAILURE'), run(2, 'plan', null)]), 'pull request')?.checks).toBe('pending');
    expect(pullRequestFrom(withRollup('PENDING', [run(1, 'plan', 'FAILURE'), run(2, 'plan', null)]), 'pull request')?.checks).toBe('pending');
    const failed = pullRequestFrom(withRollup('FAILURE', [{ ...run(1, 'plan', 'SUCCESS'), detailsUrl: 'https://x/1' }, { ...run(2, 'plan', 'FAILURE'), detailsUrl: 'https://x/2' }]), 'pull request');
    expect(failed).toMatchObject({ checks: 'failing', failedChecks: [{ name: 'plan', url: 'https://x/2' }] });
  });

  it('GraphQL: GitHub gave only some of the checks: the rollup\'s state stands', () => {
    expect(pullRequestFrom(withRollup('FAILURE', RERUN, 150), 'pull request')?.checks).toBe('failing');
  });

  it('the batched read and a read by number, against the fake GitHub: passing', async () => {
    const contexts = RERUN;
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [
      { number: 1, labels: ['hopper'] },
      { number: 2, body: 'Closes #1', pullRequest: true, pull: { headRef: 'issue-1', base: 'dev', mergeable: 'MERGEABLE', checks: 'FAILURE', contexts } },
    ] }] }] });
    const got = await h.api.pullRequestStates([{ repo: 'owner/a', pullRequest: 2, issue: 1 }]);
    expect(got.pulls.get(pullKey('owner/a', 2))).toMatchObject({ checks: 'passing' });
    const pr = await h.api.pullRequest('owner/a', 2);
    expect(pr).toMatchObject({ checks: 'passing' });
    expect(pr?.failedChecks).toBeUndefined();
  });

  it('REST, the checks fallback: an older run failed, a newer run passed: passing', async () => {
    const rest = (id: number, name: string, conclusion: string) => ({ id, name, status: 'completed', conclusion });
    const pull = (number: number, fields: FakePullFields): FakeIssueInput =>
      ({ number, body: 'Closes #1', pullRequest: true, pull: { headRef: `issue-${number}`, headOid: `h${number}`, base: 'dev', mergeable: 'MERGEABLE', checks: 'SUCCESS', ...fields } });
    const lacks: FakeLack[] = ['rollup'];
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', lacks, issues: [
      { number: 1, labels: ['hopper'] },
      pull(2, { checkRuns: [rest(1, 'plan', 'failure'), rest(2, 'plan', 'success')] }),
      pull(3, { checkRuns: [rest(2, 'plan', 'failure'), rest(1, 'plan', 'success')] }),
    ] }] }] });
    const api = checksFallback(h.api, ACCOUNT_CONNECTION, () => Date.parse(AT));
    const got = await api.pullRequestStates([2, 3].map((n) => ({ repo: 'owner/a', pullRequest: n, issue: 1 })));
    expect(got.pulls.get(pullKey('owner/a', 2))).toMatchObject({ checks: 'passing' });
    expect(got.pulls.get(pullKey('owner/a', 3))).toMatchObject({ checks: 'failing' });
  });

  it('REST, the done criteria\'s check runs: the newest run of each check only', async () => {
    const req = (async (route: string) => ({
      data: route.endsWith('/check-runs')
        ? { check_runs: [{ id: 1, name: 'plan', status: 'completed', conclusion: 'failure' }, { id: 2, name: 'plan', status: 'completed', conclusion: 'success' }] }
        : { statuses: [] },
    })) as unknown as Request;
    expect(await checkRuns(req, 't', 'owner/a', 'abc')).toEqual([{ name: 'plan', state: 'passing', text: '' }]);
  });

  it('the GitHub proxy\'s read of a pull request it does not follow: passing, and no failed checks', () => {
    const rest = (id: number, name: string, conclusion: string | null, status = 'completed') => ({ id, name, status, conclusion, html_url: `https://x/${id}` });
    expect(runChecks([rest(1, 'plan', 'failure'), rest(2, 'verdict', 'failure'), rest(3, 'plan', 'success'), rest(4, 'verdict', 'success')]))
      .toEqual({ checks: 'passing', failedChecks: [] });
    expect(runChecks([rest(1, 'plan', 'failure'), rest(2, 'plan', null, 'in_progress')])).toEqual({ checks: 'pending', failedChecks: [] });
    expect(runChecks([rest(1, 'plan', 'success'), rest(2, 'plan', 'failure')])).toEqual({ checks: 'failing', failedChecks: [{ name: 'plan', url: 'https://x/2' }] });
  });
});
