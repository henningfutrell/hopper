// Push requirements (issue #2555, design.md "Push requirements"), through git's way to the hopper (issue #652): a job runs
// the requirements of its commit with `hopper-requirements` before it pushes, and the git proxy takes a push of that
// commit only after a passing evaluation, where the repository keeps requirements.
//
// Feature: push requirements
//   Scenario: a change to a Kotlin file, in a repository whose requirements hold a coverage gate for Kotlin files
//     Then the dry run lists the coverage requirement and its command, and the migration requirement skipped with why
//     And a push with no evaluation is refused, saying what to run
//     And a check under its threshold fails the evaluation, with the check's output, and the push is still refused
//     And once the fix passes, the evaluation is recorded on the job, and the push goes through
//   Scenario: a branch made before its repository kept a requirements file (issue #2712)
//     Then the base's requirements apply: a push with no evaluation is refused, and the check runs them
//   Scenario: a check that exits 1 or 2 (issue #2712: a gate that cannot run where the job runs exits 2)
//     Then the requirement fails, and the push is refused, saying the exit code
//   Scenario: a repository with no requirements file
//     Then a push goes through with no evaluation
//   Scenario: the hopper's default requirements (Settings → Push requirements), an admin's setting
//     Then a repository with no requirements file gets them: a push they apply to needs a passing evaluation
//     And a push they all skip goes through with no evaluation
//     And a repository's requirement of the same id replaces the default, with its looser threshold
//   Scenario: a direct job's own push requirements (part 3), set by the person who submits it
//     Then a requirement of the same id replaces the repository's, with a stricter or a looser threshold
//     And a push they apply to in a repository with no requirements file needs a passing evaluation
//     And a submission whose requirements cannot be read is refused, and nothing is kept
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { branchesOf, eventsOf, running, seedCommit, start, stopGitProxies, type Started } from '../support/git-proxy.ts';
import { jobOnBranch, REQUIREMENTS } from '../support/push-requirements.ts';

afterEach(stopGitProxies);

const KOTLIN_DEFAULT = {
  id: 'kotlin-coverage', when: { paths: ['src/**/*.kt'] },
  checks: [{ name: 'changed-files coverage', run: 'cat coverage.txt', thresholds: { changedLines: { min: 80 } } }],
};
const WORKFLOWS_DEFAULT = { id: 'workflows', when: { workflows: true }, checks: [{ name: 'actionlint', run: 'false' }] };

async function setDefaults(t: Started, requirements: unknown[]) {
  const token = await t.app.login();
  expect(await t.app.ui('/ui/api/push-requirements', { requirements }, { token })).toMatchObject({ status: 200, body: { requirements } });
}

/** A direct job on the holder executor, for octo/tools, with its own push requirements. */
async function directJob(t: Started, pushRequirements: unknown[]): Promise<Job> {
  const token = await t.app.login();
  const r = await t.app.ui<{ job: Job }>('/ui/api/direct-jobs', { title: 'Add B', brief: 'Add class B.', repo: 'octo/tools', executor: 'holder', pushRequirements }, { token });
  expect(r.status).toBe(200);
  return r.body.job;
}

describe('push requirements (issue #2555)', () => {
  it('the dry run lists what applies and what is skipped and why, and runs nothing', async () => {
    const t = await start();
    const r = await jobOnBranch(t);
    const dry = await r.requirements('dry-run', '--json');
    expect(dry.stderr).toBe('');
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout.slice(dry.stdout.indexOf('{')))).toEqual({
      matched: [{
        id: 'kotlin-coverage', level: 'repo', why: 'changed files match `src/**/*.kt`: src/a/B.kt',
        checks: [{ name: 'changed-files coverage', run: 'cat coverage.txt', thresholds: { changedLines: { min: 80 } } }],
      }],
      skipped: [{ id: 'migrations', level: 'repo', reason: 'no changed files match `**/*.sql`; and no changed files match `**/migrations/**`' }],
    });
    const text = await r.requirements('dry-run');
    expect(text.stdout).toContain('octo/tools issue-7 at');
    expect(text.stdout).toContain('against dev: 2 changed files');
    expect(text.stdout).toContain('  run cat coverage.txt  [changedLines >= 80]');
    expect(eventsOf(t.app, 'push_requirements.evaluated')).toEqual([]);
  }, 30_000);

  it('refuses a push with no passing evaluation, returns a failure with its output, and takes the push once the fix passes', async () => {
    const t = await start();
    const r = await jobOnBranch(t);
    const before = (await branchesOf(t, 'octo/tools')).stdout;

    const unchecked = await r.push();
    expect(unchecked.code).not.toBe(0);
    expect(unchecked.stderr).toContain('octo/tools has push requirements');
    expect(unchecked.stderr).toContain('sh "$HOPPER_REQUIREMENTS" check');
    expect((await branchesOf(t, 'octo/tools')).stdout).toBe(before);

    const failed = await r.requirements('check');
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('failed  kotlin-coverage (repo)');
    expect(failed.stdout).toContain('changedLines 70 is under its minimum 80');
    expect(failed.stdout).toContain('| covered 70 of 100 changed lines');
    expect(failed.stdout).toContain('skipped migrations (repo): no changed files match');
    const refused = await r.push();
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('the push requirements failed for');
    expect(refused.stderr).toContain('kotlin-coverage');

    writeFileSync(join(r.work, 'coverage.txt'), 'hopper-measure changedLines=84\n');
    await r.git(['commit', '--quiet', '-am', 'Cover B'], r.work);
    const passed = await r.requirements('check');
    expect(passed.stdout).toContain('passed: the hopper takes a push of');
    expect(passed.code).toBe(0);
    expect(await r.push()).toMatchObject({ code: 0 });

    const head = (await r.git(['rev-parse', 'HEAD'], r.work)).stdout.trim();
    const evaluated = eventsOf(t.app, 'push_requirements.evaluated');
    expect(evaluated).toHaveLength(2);
    expect(evaluated[0]).toMatchObject({
      jobId: r.job.id,
      data: {
        repo: 'octo/tools', branch: 'issue-7', base: 'dev', head, passed: true,
        requirements: [
          { id: 'kotlin-coverage', level: 'repo', status: 'passed', checks: [{ name: 'changed-files coverage', run: 'cat coverage.txt', exit: 0, thresholds: { changedLines: { min: 80 } }, measured: { changedLines: 84 }, passed: true }] },
          { id: 'migrations', level: 'repo', status: 'skipped', reason: expect.stringContaining('no changed files match `**/*.sql`') },
        ],
      },
    });
    t.held.get(r.job.id)!.end();
    await t.app.waitForStatus(r.job.id, 'finished');
  }, 60_000);

  it('a branch made before its repository kept a requirements file meets the base\'s requirements (issue #2712)', async () => {
    const t = await start();
    const r = await jobOnBranch(t, null);
    await seedCommit(t, 'octo/tools', 'dev', { '.hopper/requirements.yaml': REQUIREMENTS });
    const unchecked = await r.push();
    expect(unchecked.code).not.toBe(0);
    expect(unchecked.stderr).toContain('octo/tools has push requirements');
    const failed = await r.requirements('check');
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('failed  kotlin-coverage (repo)');
    expect((await r.push()).code).not.toBe(0);
    writeFileSync(join(r.work, 'coverage.txt'), 'hopper-measure changedLines=84\n');
    await r.git(['commit', '--quiet', '-am', 'Cover B'], r.work);
    expect(await r.requirements('check')).toMatchObject({ code: 0 });
    expect(await r.push()).toMatchObject({ code: 0 });
  }, 60_000);

  it.each([1, 2])('a check that exits %i fails its requirement, and the push is refused with the exit code (issue #2712)', async (exit) => {
    const t = await start();
    const r = await jobOnBranch(t, REQUIREMENTS.replace('run: cat coverage.txt', `run: echo no JDK here; exit ${exit}`));
    const failed = await r.requirements('check');
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(`it exited ${exit}`);
    expect(failed.stdout).toContain('| no JDK here');
    const refused = await r.push();
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`kotlin-coverage (changed-files coverage: it exited ${exit})`);
    const head = (await r.git(['rev-parse', 'HEAD'], r.work)).stdout.trim();
    expect(eventsOf(t.app, 'push_requirements.evaluated')).toEqual([expect.objectContaining({
      jobId: r.job.id, data: expect.objectContaining({ head, passed: false, requirements: expect.arrayContaining([expect.objectContaining({ id: 'kotlin-coverage', status: 'failed' })]) }),
    })]);
  }, 60_000);

  it('a check is of a commit: changes not committed are refused', async () => {
    const t = await start();
    const r = await jobOnBranch(t);
    writeFileSync(join(r.work, 'coverage.txt'), 'hopper-measure changedLines=90\n');
    const dirty = await r.requirements('check');
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain('commit your changes first');
  }, 30_000);

  it('a repository with no requirements file takes a push with no evaluation', async () => {
    const t = await start();
    const r = await running(t);
    expect((await r.git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(r.home, 'tools');
    writeFileSync(join(work, 'B.kt'), 'class B\n');
    await r.git(['add', '.'], work);
    await r.git(['commit', '--quiet', '-m', 'Add B'], work);
    expect(await r.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7'], work)).toMatchObject({ code: 0 });
  });

  it('the default requirements are an admin\'s setting: none at first, refused when they cannot be read, recorded when they change', async () => {
    const t = await start();
    expect((await t.app.api('GET', '/api/push-requirements')).body).toEqual({ requirements: [] });
    expect((await t.app.ui('/ui/api/push-requirements', { requirements: [KOTLIN_DEFAULT] })).status).toBe(403);
    const token = await t.app.login();
    const noChecks = await t.app.ui<string>('/ui/api/push-requirements', { requirements: [{ id: 'x', checks: [] }] }, { token });
    expect(noChecks.status).toBe(400);
    expect(JSON.stringify(noChecks.body)).toContain('a requirement names at least one check');
    expect(JSON.stringify((await t.app.ui('/ui/api/push-requirements', { requirements: [KOTLIN_DEFAULT, KOTLIN_DEFAULT] }, { token })).body)).toContain('the id kotlin-coverage is named twice');
    expect((await t.app.ui('/ui/api/push-requirements', { requirements: [] }, { token })).status).toBe(200);
    expect(eventsOf(t.app, 'push_requirements.defaults_changed')).toEqual([]);

    await setDefaults(t, [KOTLIN_DEFAULT]);
    await setDefaults(t, [KOTLIN_DEFAULT]);
    expect((await t.app.api('GET', '/api/push-requirements')).body).toEqual({ requirements: [KOTLIN_DEFAULT] });
    expect(eventsOf(t.app, 'push_requirements.defaults_changed')).toEqual([expect.objectContaining({ data: expect.objectContaining({ from: [], to: ['kotlin-coverage'] }) })]);
  });

  it('a repository with no requirements file gets the defaults: a push they apply to needs a passing evaluation', async () => {
    const t = await start();
    await setDefaults(t, [KOTLIN_DEFAULT, WORKFLOWS_DEFAULT]);
    const r = await jobOnBranch(t, null);
    const dry = await r.requirements('dry-run', '--json');
    expect(JSON.parse(dry.stdout.slice(dry.stdout.indexOf('{')))).toEqual({
      matched: [{ id: 'kotlin-coverage', level: 'default', why: 'changed files match `src/**/*.kt`: src/a/B.kt', checks: KOTLIN_DEFAULT.checks }],
      skipped: [{ id: 'workflows', level: 'default', reason: 'no workflow file changed' }],
    });

    const unchecked = await r.push();
    expect(unchecked.code).not.toBe(0);
    expect(unchecked.stderr).toContain('the hopper\'s default push requirements apply to');
    expect(unchecked.stderr).toContain('(kotlin-coverage)');
    expect((await r.requirements('check')).stdout).toContain('failed  kotlin-coverage (default)');

    writeFileSync(join(r.work, 'coverage.txt'), 'hopper-measure changedLines=80\n');
    await r.git(['commit', '--quiet', '-am', 'Cover B'], r.work);
    expect(await r.requirements('check')).toMatchObject({ code: 0 });
    expect(await r.push()).toMatchObject({ code: 0 });
  }, 60_000);

  it('a push the defaults all skip goes through with no evaluation', async () => {
    const t = await start();
    await setDefaults(t, [KOTLIN_DEFAULT, WORKFLOWS_DEFAULT]);
    const r = await running(t);
    expect((await r.git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(r.home, 'tools');
    writeFileSync(join(work, 'README.md'), 'more\n');
    await r.git(['commit', '--quiet', '-am', 'Readme'], work);
    expect(await r.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7'], work)).toMatchObject({ code: 0 });
  }, 30_000);

  it('a repository\'s requirement of the same id replaces the default: a looser threshold', async () => {
    const t = await start();
    await setDefaults(t, [KOTLIN_DEFAULT]);
    const r = await jobOnBranch(t, REQUIREMENTS.replace('min: 80', 'min: 60'));
    const checked = await r.requirements('check');
    expect(checked.stdout).toContain('passed  kotlin-coverage (repo)');
    expect(checked.code).toBe(0);
    expect(await r.push()).toMatchObject({ code: 0 });
  }, 60_000);

  it('a direct job\'s own requirement replaces the repository\'s: a looser threshold, then a stricter one', async () => {
    const t = await start();
    const looser = { ...KOTLIN_DEFAULT, checks: [{ ...KOTLIN_DEFAULT.checks[0]!, thresholds: { changedLines: { min: 60 } } }] };
    const r = await jobOnBranch(t, REQUIREMENTS, await directJob(t, [looser]));
    const dry = await r.requirements('dry-run', '--json');
    expect(JSON.parse(dry.stdout.slice(dry.stdout.indexOf('{'))).matched).toEqual([expect.objectContaining({ id: 'kotlin-coverage', level: 'job', checks: looser.checks })]);
    expect((await r.requirements('check')).stdout).toContain('passed  kotlin-coverage (job)');
    expect(await r.push()).toMatchObject({ code: 0 });
    expect(eventsOf(t.app, 'direct_job.submitted')[0]!.data).toMatchObject({ pushRequirements: ['kotlin-coverage'] });

    const stricter = { ...KOTLIN_DEFAULT, checks: [{ ...KOTLIN_DEFAULT.checks[0]!, thresholds: { changedLines: { min: 90 } } }] };
    const s = await jobOnBranch(t, null, await directJob(t, [stricter]));
    writeFileSync(join(s.work, 'coverage.txt'), 'hopper-measure changedLines=84\n');
    await s.git(['commit', '--quiet', '-am', 'Cover B'], s.work);
    const failed = await s.requirements('check');
    expect(failed.stdout).toContain('failed  kotlin-coverage (job)');
    expect(failed.stdout).toContain('changedLines 84 is under its minimum 90');
    expect((await s.push()).code).not.toBe(0);
  }, 90_000);

  it('a direct job\'s own requirements apply at the push in a repository with no requirements file', async () => {
    const t = await start();
    const r = await jobOnBranch(t, null, await directJob(t, [KOTLIN_DEFAULT]));
    const unchecked = await r.push();
    expect(unchecked.code).not.toBe(0);
    expect(unchecked.stderr).toContain('the job\'s own push requirements apply to');
    expect(unchecked.stderr).toContain('(kotlin-coverage)');
    writeFileSync(join(r.work, 'coverage.txt'), 'hopper-measure changedLines=80\n');
    await r.git(['commit', '--quiet', '-am', 'Cover B'], r.work);
    expect(await r.requirements('check')).toMatchObject({ code: 0 });
    expect(await r.push()).toMatchObject({ code: 0 });
  }, 60_000);

  it('a direct job whose requirements cannot be read is refused, and nothing is kept', async () => {
    const t = await start();
    const token = await t.app.login();
    const submit = (pushRequirements: unknown[]) => t.app.ui('/ui/api/direct-jobs', { title: 'Add B', brief: 'Add class B.', executor: 'holder', pushRequirements }, { token });
    const twice = await submit([KOTLIN_DEFAULT, KOTLIN_DEFAULT]);
    expect(twice.status).toBe(400);
    expect(JSON.stringify(twice.body)).toContain('the id kotlin-coverage is named twice');
    expect((await submit([{ id: 'x', checks: [] }])).status).toBe(400);
    expect((await t.app.api('GET', '/api/direct-jobs')).body).toEqual({ directJobs: [] });
  });
});
