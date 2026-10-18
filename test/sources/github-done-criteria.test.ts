// The done criteria of a job's conditional skills (issue #1924): the GitHub done check verifies them itself on the job's own
// open pull request — its head commit's checks and their output, its comments since that commit — before the job is done,
// and does not trust the job. A plan that destroys or replaces a resource, or a plan check not passed, keeps it not done.
import { describe, expect, it } from 'vitest';
import type { DoneCriterion } from '../../src/domain/conditional-skills.ts';
import { judge } from '../../src/domain/pull-requests.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
const IAC: DoneCriterion[] = [{ kind: 'checks-passed', checks: '*plan*' }, { kind: 'plan-destroy', checks: '*plan*' }];

function withCriteria(done: DoneCriterion[] | undefined, headCommittedAt = AFTER, o: { paths?: string[]; files?: string[]; allowed?: string[] } = {}) {
  const { gh, source } = setup({}, {
    ...(done ? { doneCriteria: () => [{ skill: 'iac', done, ...(o.paths ? { paths: o.paths } : {}) }] } : {}),
    ...(o.allowed ? { allowedDeletes: () => o.allowed! } : {}),
  });
  gh.createIssue({ repo: REPO, labels: ['hopper'] });
  const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER, headCommittedAt, checks: 'passing', ...(o.files ? { files: o.files } : {}) });
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

  it('a skill a paths rule gave is checked only when the pull request changes a file its paths match (issue #1924 part 2)', async () => {
    const red = [{ name: 'terraform plan (prod)', state: 'failing' as const, text: plan(1) }];
    const docs = withCriteria(IAC, AFTER, { paths: ['*.tf'], files: ['README.md'] });
    docs.gh.setCheckRuns(docs.pr.url, red);
    expect(await docs.source.notComplete!(docs.job)).toBeUndefined();
    const tf = withCriteria(IAC, AFTER, { paths: ['*.tf'], files: ['README.md', 'envs/prod/main.tf'] });
    tf.gh.setCheckRuns(tf.pr.url, red);
    expect(await tf.source.notComplete!(tf.job)).toMatch(/done criteria of skill iac not met/);
    // The changed files not known (no mirror): the criteria apply.
    const unknown = withCriteria(IAC, AFTER, { paths: ['*.tf'] });
    unknown.gh.setCheckRuns(unknown.pr.url, red);
    expect(await unknown.source.notComplete!(unknown.job)).toMatch(/done criteria of skill iac not met/);
  });

  it('a delete the job\'s issue allows by address does not keep the job not done; another one does', async () => {
    const text = `  # module.bastion[0].aws_instance.bastion must be replaced\n\n${plan(1)}`;
    const allowed = withCriteria(IAC, AFTER, { allowed: ['module.bastion[0].aws_instance.bastion'] });
    allowed.gh.setCheckRuns(allowed.pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text }]);
    expect(await allowed.source.notComplete!(allowed.job)).toBeUndefined();
    const other = withCriteria(IAC, AFTER, { allowed: ['aws_s3_bucket.logs'] });
    other.gh.setCheckRuns(other.pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text }]);
    expect(await other.source.notComplete!(other.job)).toMatch(/module\.bastion\[0\]\.aws_instance\.bastion, which the issue does not allow/);
  });

  it('a pull request that ships a part is checked too: its plan that replaces a resource is no part done (issue #1924 part 4)', async () => {
    const { gh, source } = setup({}, { doneCriteria: () => [{ skill: 'iac', done: IAC }] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER, headCommittedAt: AFTER, checks: 'passing' });
    const n = Number(pr.url.split('/').pop());
    const job = jobForIssue(1);
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text: plan(1) }]);
    const verdict = await judge(source, job);
    expect(verdict).toEqual({ done: false, why: `the issue https://github.com/${REPO}/issues/1 is open, and PR #${n}: done criteria of skill iac not met: a terraform plan destroys or replaces 1 resource (terraform plan (prod)); at most 0 may be` });
    expect(matchCause(`not complete: ${(verdict as { why: string }).why}`, 'sig', [])?.id).toBe('done-criteria-unmet');
    // Met: the part is done as before.
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text: plan(0) }]);
    expect(await judge(source, job)).toEqual({ done: false, partlyDone: pr.url });
  });

  it('a merged part is not read again: yolo mode read its criteria before its merge, or a person merged it', async () => {
    const { gh, source } = setup({}, { doneCriteria: () => [{ skill: 'iac', done: IAC }] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER, headCommittedAt: AFTER, checks: 'passing' });
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text: plan(1) }]);
    gh.mergePullRequest(pr.url);
    expect(await judge(source, jobForIssue(1))).toEqual({ done: false, partlyDone: pr.url });
  });
});
