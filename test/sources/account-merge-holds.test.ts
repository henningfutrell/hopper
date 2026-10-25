// A connected account's source gives its GitHub source what holds yolo mode's merge (issue #2775 part 7): a delivery hold of
// the job's change, and the done criteria of the job's conditional skills (issue #1924), which it did not pass on before.
// Fake at the GitHubApi seam.
//
// Feature: the account source's merge holds
//   Scenario: a delivery hold holds yolo mode's merge of the job's ready pull request
//   Scenario: a person-merges done criterion holds it too
//   Scenario: with neither, yolo mode merges it
import { describe, expect, it } from 'vitest';
import type { DoneCriterion } from '../../src/domain/conditional-skills.ts';
import type { ConnectedAccountTokens } from '../../src/domain/ports.ts';
import { createAccountSource } from '../../src/sources/compose.ts';
import { githubAccountOptions } from '../../src/sources/config.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { jobForIssue, testTrust } from './fixtures/github-support.ts';

const REPO = 'owner/repo';
const accounts: ConnectedAccountTokens = {
  account: () => 'owner', ended: () => undefined, expired: () => false, token: async () => 'token', renew: async () => 'token',
  endpoints: () => ({ url: 'https://github.com', apiUrl: 'https://api.github.com' }), jobRepositories: () => [REPO],
};
const GITOPS: DoneCriterion[] = [{ kind: 'person-merges', paths: ['**/overlays/production/**'] }];

async function ended(o: { hold?: string; done?: DoneCriterion[] }) {
  const gh = createFakeGitHub();
  const s = createAccountSource({
    name: 'github-account', key: 'github', accounts, api: gh, yoloMode: () => true,
    clock: { now: () => new Date('2026-10-02T10:00:00.000Z') }, knownKeys: () => new Set(), rerunnable: () => new Set(), trust: testTrust(),
    deliveryHold: () => o.hold, ...(o.done ? { doneCriteria: () => [{ skill: 'gitops', done: o.done! }] } : {}),
  }, githubAccountOptions.parse({}));
  gh.createIssue({ repo: REPO, labels: ['hopper'] });
  gh.openPullRequest(REPO, 1, { createdAt: '2026-10-02T09:50:00.000Z', checks: 'passing', files: ['overlays/production/app.yaml'] });
  const base = jobForIssue(1, { status: 'finished', createdAt: '2026-10-02T09:00:00.000Z' }, REPO, 'github-account');
  const state = await s.report({ kind: 'finished', job: base });
  return { gh, s, job: { ...base, sourceState: { source: state } } };
}

describe("the account source's merge holds (issue #2775 part 7)", () => {
  it("a delivery hold holds yolo mode's merge of the job's ready pull request", async () => {
    const { gh, s, job } = await ended({ hold: 'its delivery is held: paused at pr_checks' });
    expect(await s.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { mergeError: 'its delivery is held: paused at pr_checks' } } });
    expect(gh.calls.filter((c) => c.method === 'merge')).toEqual([]);
  });

  it('a person-merges done criterion holds it too', async () => {
    const { s, job } = await ended({ done: GITOPS });
    expect(await s.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { mergeError: expect.stringMatching(/a person merges/) } } });
  });

  it('with neither, yolo mode merges it', async () => {
    const { s, job } = await ended({});
    expect(await s.follow!(job)).toMatchObject({ outcome: 'merged' });
  });
});
