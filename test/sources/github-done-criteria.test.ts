// The done criteria of a job's conditional skills (issue #1924): the GitHub done check verifies them itself on the job's own
// open pull request — its head commit's checks and their output, its comments since that commit — before the job is done,
// and does not trust the job. A plan that destroys or replaces a resource, or a plan check not passed, keeps it not done.
import { describe, expect, it } from 'vitest';
import type { DoneCriterion } from '../../src/domain/conditional-skills.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
const IAC: DoneCriterion[] = [{ kind: 'checks-passed', checks: '*plan*' }, { kind: 'plan-destroy', checks: '*plan*' }];

function withCriteria(done: DoneCriterion[] | undefined, headCommittedAt = AFTER) {
  const { gh, source } = setup({}, done ? { doneCriteria: () => [{ skill: 'iac', done }] } : {});
  gh.createIssue({ repo: REPO, labels: ['hopper'] });
  const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER, headCommittedAt, checks: 'passing' });
  return { gh, source, job: jobForIssue(1), pr, n: Number(pr.url.split('/').pop()) };
}

const plan = (destroy: number) => `Terraform will perform the following actions\n\nPlan: 1 to add, 0 to change, ${destroy} to destroy.`;

describe('the done criteria of a conditional skill (issue #1924)', () => {
  it('a ready pull request whose plan checks passed and destroy nothing is done', async () => {
    const { gh, source, job, pr } = withCriteria(IAC);
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text: plan(0) }, { name: 'lint', state: 'passing', text: '' }]);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('a plan that replaces a resource is not done, though every check is green; the miss names the pull request and the skill', async () => {
    const { gh, source, job, pr, n } = withCriteria(IAC);
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (control-plane)', state: 'passing', text: plan(1) }]);
    const why = await source.notComplete!(job);
    expect(why).toBe(`the issue https://github.com/${REPO}/issues/1 is open, and PR #${n}: done criteria of skill iac not met: a terraform plan destroys or replaces 1 resource (terraform plan (control-plane)); at most 0 may be`);
    // The assessor reads it as Done criteria unmet: the job is sent back to rework, not handed to a person at once.
    expect(matchCause(`not complete: ${why}`, 'sig', [])?.id).toBe('done-criteria-unmet');
  });

  it('a plan check still running, or none yet, is not done: checks still running do not count as passed here', async () => {
    const { gh, source, job, pr } = withCriteria(IAC);
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (prod)', state: 'pending' }]);
    expect(await source.notComplete!(job)).toMatch(/done criteria of skill iac not met: check terraform plan \(prod\) is pending; no terraform plan summary/);
    gh.setCheckRuns(pr.url, []);
    expect(await source.notComplete!(job)).toMatch(/no check named \*plan\* ran yet/);
  });

  it('a plan summary in a comment on the pull request counts, when written since its head commit', async () => {
    // The fake writes a comment at its own clock's time: the head commit is before it.
    const { gh, source, job, pr, n } = withCriteria([{ kind: 'plan-destroy' }], '2026-10-01T00:00:00.000Z');
    gh.addComment(REPO, n, 'ci-bot', `## Plan summary\n\n${plan(2)}`);
    expect(await source.notComplete!(job)).toMatch(/destroys or replaces 2 resources \(a comment\)/);
    gh.pushToPullRequest(pr.url, new Date(Date.now() + 60_000).toISOString());
    expect(await source.notComplete!(job)).toMatch(/no terraform plan summary in the checks or the pull request's comments/);
  });

  it('a job with no conditional skill, or one whose issue is closed, is judged as before', async () => {
    const { source, job } = withCriteria(undefined);
    expect(await source.notComplete!(job)).toBeUndefined();
    const closed = withCriteria(IAC);
    closed.gh.closeIssue(REPO, 1, 'owner', { at: AFTER });
    expect(await closed.source.notComplete!(closed.job)).toBeUndefined();
  });
});
