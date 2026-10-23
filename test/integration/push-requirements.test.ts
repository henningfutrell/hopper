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
//   Scenario: a repository with no requirements file
//     Then a push goes through with no evaluation
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchesOf, eventsOf, run, running, seedCommit, start, stopGitProxies, type Started } from '../support/git-proxy.ts';

afterEach(stopGitProxies);

const REQUIREMENTS = [
  'requirements:',
  '  - id: kotlin-coverage',
  '    when: { paths: ["src/**/*.kt"] }',
  '    checks:',
  '      - name: changed-files coverage',
  '        run: cat coverage.txt',
  '        thresholds: { changedLines: { min: 80 } }',
  '  - id: migrations',
  '    when: { any: [{ paths: ["**/*.sql"] }, { paths: ["**/migrations/**"] }] }',
  '    checks:',
  '      - name: migration tests',
  '        run: "false"',
].join('\n');

async function jobOnBranch(t: Started) {
  await seedCommit(t, 'octo/tools', 'dev', { '.hopper/requirements.yaml': REQUIREMENTS });
  const r = await running(t);
  expect((await r.git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
  const work = join(r.home, 'tools');
  await r.git(['checkout', '--quiet', '-b', 'issue-7'], work);
  mkdirSync(join(work, 'src/a'), { recursive: true });
  writeFileSync(join(work, 'src/a/B.kt'), 'class B\n');
  writeFileSync(join(work, 'coverage.txt'), 'covered 70 of 100 changed lines\nhopper-measure changedLines=70\n');
  await r.git(['add', '.'], work);
  await r.git(['commit', '--quiet', '-m', 'Add B'], work);
  const env = { ...process.env, HOPPER_URL: r.env.HOPPER_URL, HOPPER_TOKEN_FILE: join(t.root, r.env.HOPPER_TOKEN_FILE!), HOME: r.home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...Object.fromEntries(Object.entries(r.env).filter(([k]) => k.startsWith('GIT_CONFIG_'))) };
  // The launcher the job runs, which runs the client beside it.
  const requirements = (...args: string[]) => run('sh', [join(t.root, r.env.HOPPER_REQUIREMENTS!), ...args], { cwd: work, env });
  const push = () => r.git(['push', 'origin', 'HEAD:refs/heads/issue-7'], work);
  return { ...r, work, requirements, push };
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
});
