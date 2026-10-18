// The done criteria of a GitLab job's conditional skills (issue #1924 part 4, design.md "Conditional skills"): the GitLab done
// check verifies them itself on the job's ready merge request — its head pipeline's jobs, the log of each job a plan criterion
// names, its comments since its head commit, its changed files — and does not trust the job; yolo mode reads them again just
// before the hopper's merge. Over a fake GitLab on loopback.
//
// Feature: done criteria on a GitLab merge request
//   Scenario: a plan job whose log replaces a resource keeps the job not done, though the pipeline passed; the miss names MR !N
//   Scenario: a plan job not passed, or none, is not done; every plan job passed with no delete is done
//   Scenario: a plan summary in a merge request comment since its head commit counts; one before it does not
//   Scenario: a paths skill is checked only when the merge request changes a file its paths match
//   Scenario: an issue closed by a merged merge request is judged as before
//   Scenario: yolo mode holds the merge while a criterion is not met, or a person-merges path is touched; met, it merges
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import type { DoneCriterion } from '../../src/domain/conditional-skills.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import type { Job } from '../../src/domain/types.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { createFakeGitLab, type FakeGitLabIssue, type FakeGitLabMergeRequest } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const BEGAN = '2026-10-17T10:00:00Z';
const COMMITTED = '2026-10-17T10:30:00Z';
const AFTER = '2026-10-17T11:00:00Z';
const IAC: DoneCriterion[] = [{ kind: 'checks-passed', checks: '*plan*' }, { kind: 'plan-destroy', checks: '*plan*' }];
const ISSUE: FakeGitLabIssue = { project: 'ada/infra', iid: 1, title: 'Tag the bastion', description: 'x', author: 'ada', assignees: ['ada'], labels: ['hopper', 'hopper:claimed'] };

const plan = (destroy: number) => `$ terraform plan\nTerraform will perform the following actions\n\nPlan: 1 to add, 0 to change, ${destroy} to destroy.\n`;

async function setup(o: { mergeRequest?: Partial<FakeGitLabMergeRequest>; done?: DoneCriterion[]; paths?: string[]; yolo?: boolean } = {}) {
  const gitlab = await createFakeGitLab({ issues: [ISSUE] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/infra'] });
  gitlab.mergeRequests.push({ project: 'ada/infra', iid: 4, closes: [1], state: 'opened', createdAt: AFTER, updatedAt: AFTER, pipeline: 'success', committedAt: COMMITTED, ...o.mergeRequest });
  let kept: GitLabAccountRecord | undefined;
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined },
  });
  await account.connect({ token: 'glpat-ada', baseUrl: gitlab.url });
  account.choose(['ada/infra']);
  const done = o.done ?? IAC;
  const source = createGitLabSource({
    name: 'gitlab-account', account, yoloMode: () => o.yolo ?? false,
    doneCriteria: () => [{ skill: 'iac', done, ...(o.paths ? { paths: o.paths } : {}) }],
  });
  return { gitlab, source, mr: () => gitlab.mergeRequests[0]! };
}

const job = (source?: Record<string, unknown>): Job => ({
  id: 'j1', status: source ? 'finished' : 'running', createdAt: BEGAN,
  source: { source: 'gitlab-account', kind: 'gitlab-account', key: 'k', url: 'u', title: 't', author: 'ada', assignee: 'ada', repo: 'ada/infra', number: 1, labels: [] },
  ...(source ? { sourceState: { source } } : {}),
} as unknown as Job);

describe('done criteria on a GitLab merge request (issue #1924 part 4)', () => {
  it('a plan job whose log replaces a resource keeps the job not done, though its pipeline passed', async () => {
    const s = await setup({ mergeRequest: { jobs: [{ name: 'plan:control-plane', status: 'success', trace: plan(1) }, { name: 'lint', status: 'success' }] } });
    const why = await s.source.notComplete!(job());
    expect(why).toBe(`the issue ${s.gitlab.url}/ada/infra/-/issues/1 is open, and MR !4: done criteria of skill iac not met: a terraform plan destroys or replaces 1 resource (plan:control-plane); at most 0 may be`);
    // The assessor reads it as Done criteria unmet: the job is sent back to rework.
    expect(matchCause(`not complete: ${why}`, 'sig', [])?.id).toBe('done-criteria-unmet');
    // Only the log of a job a plan criterion names is read.
    expect(s.gitlab.requests.filter((r) => r.path.includes('/trace')).length).toBe(1);
  });

  it('a plan job not passed, or none, is not done; every plan job passed with no delete is done', async () => {
    const running = await setup({ mergeRequest: { jobs: [{ name: 'plan:prod', status: 'running' }] } });
    expect(await running.source.notComplete!(job())).toMatch(/MR !4: done criteria of skill iac not met: check plan:prod is pending; no terraform plan summary/);
    const none = await setup({ mergeRequest: { jobs: [] } });
    expect(await none.source.notComplete!(job())).toMatch(/no check named \*plan\* ran yet/);
    const green = await setup({ mergeRequest: { jobs: [{ name: 'plan:prod', status: 'success', trace: plan(0) }] } });
    expect(await green.source.notComplete!(job())).toBeUndefined();
  });

  it('a plan summary in a merge request comment since its head commit counts; one before it does not', async () => {
    const since = await setup({ done: [{ kind: 'plan-destroy' }], mergeRequest: { jobs: [], notes: [{ body: `## Plan\n\n${plan(2)}`, at: AFTER }] } });
    expect(await since.source.notComplete!(job())).toMatch(/destroys or replaces 2 resources \(a comment\)/);
    const before = await setup({ done: [{ kind: 'plan-destroy' }], mergeRequest: { jobs: [], notes: [{ body: plan(2), at: BEGAN }, { body: 'a system line', at: AFTER, system: true }] } });
    expect(await before.source.notComplete!(job())).toMatch(/no terraform plan summary in the checks or the pull request's comments/);
  });

  it('a paths skill is checked only when the merge request changes a file its paths match', async () => {
    const red = [{ name: 'plan:prod', status: 'failed', trace: plan(1) }];
    const docs = await setup({ paths: ['*.tf'], mergeRequest: { jobs: red, files: ['README.md'] } });
    expect(await docs.source.notComplete!(job())).toBeUndefined();
    const tf = await setup({ paths: ['*.tf'], mergeRequest: { jobs: red, files: ['README.md', 'envs/prod/main.tf'] } });
    expect(await tf.source.notComplete!(job())).toMatch(/MR !4: done criteria of skill iac not met: check plan:prod is failing/);
  });

  it('an issue closed by a merged merge request is judged as before', async () => {
    const s = await setup({ mergeRequest: { state: 'merged', mergedAt: AFTER, jobs: [{ name: 'plan:prod', status: 'success', trace: plan(1) }] } });
    s.gitlab.issues[0]!.state = 'closed';
    expect(await s.source.notComplete!(job())).toBeUndefined();
  });

  it('yolo mode holds the merge while a criterion is not met, and merges once it is met', async () => {
    const s = await setup({ yolo: true, mergeRequest: { jobs: [{ name: 'plan:prod', status: 'success', trace: plan(1) }] } });
    const url = `${s.gitlab.url}/ada/infra/-/merge_requests/4`;
    const up = await s.source.follow!(job({ reported: 'finished', pullRequest: url, follow: 'open' }));
    expect(up?.outcome).toBe('open');
    expect((up?.state as { seen?: { mergeError?: string } }).seen?.mergeError).toBe('done criteria of skill iac not met: a terraform plan destroys or replaces 1 resource (plan:prod); at most 0 may be');
    expect(s.mr().state).toBe('opened');
    s.mr().jobs = [{ name: 'plan:prod', status: 'success', trace: plan(0) }];
    expect((await s.source.follow!(job(up!.state)))?.outcome).toBe('merged');
  });

  it('yolo mode leaves a change a person-merges criterion names to a person', async () => {
    const done: DoneCriterion[] = [{ kind: 'person-merges', paths: ['**/overlays/production/**'] }];
    const url = (s: { gitlab: { url: string } }) => `${s.gitlab.url}/ada/infra/-/merge_requests/4`;
    const prod = await setup({ yolo: true, done, mergeRequest: { files: ['apps/web/overlays/production/kustomization.yaml'] } });
    const up = await prod.source.follow!(job({ reported: 'finished', pullRequest: url(prod), follow: 'open' }));
    expect((up?.state as { seen?: { mergeError?: string } }).seen?.mergeError).toBe('done criteria of skill iac: a person merges a change to **/overlays/production/**, not the hopper');
    // No miss at the done check: the job is done once its merge request is ready.
    expect(await prod.source.notComplete!(job())).toBeUndefined();
    const dev = await setup({ yolo: true, done, mergeRequest: { files: ['apps/web/overlays/dev/kustomization.yaml'] } });
    expect((await dev.source.follow!(job({ reported: 'finished', pullRequest: url(dev), follow: 'open' })))?.outcome).toBe('merged');
  });
});
