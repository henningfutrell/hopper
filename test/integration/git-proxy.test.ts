// Issue #652: a job holds no GitHub token. Its git fetch and push go to the hopper, which does them on GitHub with the
// connection of the job's own user; a push changes only a branch of a repository its user can push to (issue #1806: its
// own, another job repository (issue #1275), or one the hopper does not work on), never its default or a release branch. The daemon, store and HTTP edge are real; GitHub is a fake on loopback whose git is git's own
// `git-http-backend` over bare repositories (test/support/fake-forges.ts); the job runs the real git with the variables
// it was given, and the credential files the hopper kept for it on its machine.
//
// Feature: git through the hopper
//   Scenario: a job clones its repository, and pushes a branch of its work
//     Given a hopper whose GitHub is connected, working on octo/tools
//     And a job of octo/tools running on this machine, with no GitHub login of its own
//     When the job clones https://github.com/octo/tools and pushes a new branch
//     Then the hopper fetches and pushes on GitHub with its user's connection, and the branch is on GitHub
//     And the push is on the job's timeline
//   Scenario: a job pushes to the default branch, or a release branch
//     Then the push is refused with the reason, nothing changes on GitHub, and the refusal is on its timeline
//   Scenario: a job pushes to another of its user's job repositories (issue #1275)
//     Given a job of octo/tools whose change belongs in octo/site, another job repository its user can push to
//     When the job pushes a new branch to octo/site, then pushes it again with --force-with-lease
//     Then both pushes are on GitHub, and on the job's timeline
//     But a push to octo/site's default branch, or to a job repository its user cannot push to, is refused
//   Scenario: a job pushes to a repository that is neither its own nor a job repository (issue #1806)
//     Given a repository the hopper does not work on, which the user can push to
//     When the job pushes a new branch there and opens a pull request there
//     Then both are on GitHub and on the job's timeline; an issue there, or a push to its default branch, is refused
//     But when the user cannot push there, the push is refused with the reason
//     And when GitHub refuses the push itself, git shows GitHub's reason, not a bare HTTP 403 (issue #2042)
//   Scenario: with direct push on for a repository, a job pushes straight to its target branch (issue #1806)
//     Given a person named the repository for direct push
//     When the job pushes a commit on top of the default branch
//     Then it is on GitHub, and on the job's timeline as direct
//     But a push that rewrites the branch, or one to another release branch, is refused
//   Scenario: a job of a repository outside the job repositories pushes to its own repository (issue #1131)
//     Given a job whose own repository is no job repository (a source other than the account's, or one chosen no more)
//     When the job pushes a branch, then pushes it again with --force-with-lease, as a tend job's rebase does
//     Then both pushes are on GitHub
//   Scenario: a job reads a repository its jobs do not use (issue #1015)
//     Given a private repository outside the job repositories that the user's connection sees
//     Then the hopper reads it with the user's connection
//   Scenario: the job's variables carry no GitHub token and no ssh agent
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubTraffic } from '../../src/github-limiter/traffic.ts';
import { branchesOf, cleanups, eventsOf, running, start, stopGitProxies } from '../support/git-proxy.ts';
import { hopperGh } from '../support/job-holder.ts';

afterEach(stopGitProxies);

const basicOf = (auth: string): string => Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8');

describe('git through the hopper (issue #652)', () => {
  it('a job clones its repository and pushes a branch of its work, with its user\'s connection, on its timeline', async () => {
    const t = await start();
    const { job, home, git } = await running(t);
    const remote = `${t.github.url}/octo/tools.git`;

    expect(await git(['clone', '--quiet', remote, 'tools'])).toMatchObject({ code: 0 });
    const work = join(home, 'tools');
    writeFileSync(join(work, 'fix.txt'), 'fixed\n');
    expect((await git(['add', '.'], work)).code).toBe(0);
    expect((await git(['commit', '--quiet', '-m', 'Fix'], work)).code).toBe(0);
    const pushed = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-fix'], work);
    expect(pushed).toMatchObject({ code: 0 });

    const head = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branchesOf(t, 'octo/tools')).stdout).toContain(`issue-7-fix ${head}`);
    // The job asked the hopper, never GitHub: GitHub saw the hopper's user's token, in every git request.
    const toGitHub = t.github.gitRequests.filter((r) => r.path.startsWith('/octo/tools'));
    expect(toGitHub.length).toBeGreaterThan(0);
    for (const r of toGitHub) expect(basicOf(r.auth)).toBe('x-access-token:test-account-token');
    expect(eventsOf(t.app, 'github_proxy.done')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'octo/tools', refs: ['refs/heads/issue-7-fix'], as: 'owner' }) }),
    ]));

    // Updated and forced on its own branch: a rebase pushes with --force-with-lease.
    expect((await git(['commit', '--quiet', '--amend', '-m', 'Fix, again'], work)).code).toBe(0);
    expect(await git(['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/issue-7-fix'], work)).toMatchObject({ code: 0 });
  });

  // Issue #858: each fetch through the hopper is counted for its repository and its job, and the next sync pass tells it.
  it('counts each fetch of a job, never its push, in the next sync pass line', async () => {
    const t = await start();
    const { job, home, git } = await running(t);
    const logged = vi.spyOn(console, 'warn');
    cleanups.push(() => logged.mockRestore());
    await githubTraffic.pass('before', async () => undefined);
    expect((await git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(home, 'tools');
    expect((await git(['fetch', '--quiet', 'origin'], work)).code).toBe(0);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Fix'], work);
    expect((await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7-fix'], work)).code).toBe(0);
    await githubTraffic.pass('probe', async () => undefined);
    const lines = logged.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('hopper: GitHub traffic of sync pass'));
    const fetches = lines.join('\n').match(new RegExp(`octo/tools (\\d+); by ${job.id.slice(0, 8)} (\\d+)`, 'g')) ?? [];
    const sum = fetches.map((f) => Number(/octo\/tools (\d+)/.exec(f)![1])).reduce((a, b) => a + b, 0);
    expect(sum).toBe(2);
  });

  it('refuses a push to the default branch or a release branch, saying why; nothing changes on GitHub', async () => {
    const t = await start();
    const { job, home, git } = await running(t);
    await git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools']);
    const work = join(home, 'tools');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Straight to dev'], work);
    const before = (await branchesOf(t, 'octo/tools')).stdout;

    for (const branch of ['dev', 'stable']) {
      const r = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], work);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`a job pushes only to a branch of its own work, never to ${branch}`);
    }
    const deleted = await git(['push', 'origin', ':refs/heads/dev'], work);
    expect(deleted.code).not.toBe(0);
    expect((await branchesOf(t, 'octo/tools')).stdout).toBe(before);
    expect(t.github.gitRequests.filter((r) => r.path.endsWith('/git-receive-pack'))).toEqual([]);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'octo/tools', reason: expect.stringContaining('never to dev') }) }),
    ]));
  });

  it('pushes a branch to another of its user\'s job repositories, forced too, on its timeline (issue #1275)', async () => {
    const t = await start();
    const { job, home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/octo/site.git`, 'site'])).code).toBe(0);
    const work = join(home, 'site');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'The change belongs here'], work);
    expect(await git(['push', 'origin', 'HEAD:refs/heads/issue-7-site'], work)).toMatchObject({ code: 0 });
    await git(['commit', '--quiet', '--amend', '--allow-empty', '-m', 'The change belongs here, rebased'], work);
    expect(await git(['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/issue-7-site'], work)).toMatchObject({ code: 0 });
    const head = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branchesOf(t, 'octo/site')).stdout).toContain(`issue-7-site ${head}`);
    expect(eventsOf(t.app, 'github_proxy.done')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'octo/site', refs: ['refs/heads/issue-7-site'] }) }),
    ]));

    const toDev = await git(['push', 'origin', 'HEAD:refs/heads/dev'], work);
    expect(toDev.code).not.toBe(0);
    expect(toDev.stderr).toContain('a job pushes only to a branch of its own work, never to dev');
  });

  it('refuses a push to another job repository its user cannot push to', async () => {
    const t = await start();
    t.github.notPushable = ['octo/site'];
    const { home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/octo/site.git`, 'site'])).code).toBe(0);
    const work = join(home, 'site');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Not pushable'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-site'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('your user cannot push to octo/site');
    expect((await branchesOf(t, 'octo/site')).stdout).not.toContain('issue-7-site');
  });

  it('pushes to the job\'s own repository when it is no job repository, forced too (issue #1131)', async () => {
    const t = await start();
    const { job, home, git } = await running(t, 'elsewhere/lib');
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const work = join(home, 'lib');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Fix'], work);
    expect(await git(['push', 'origin', 'HEAD:refs/heads/issue-7-fix'], work)).toMatchObject({ code: 0 });
    await git(['commit', '--quiet', '--amend', '--allow-empty', '-m', 'Fix, rebased'], work);
    expect(await git(['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/issue-7-fix'], work)).toMatchObject({ code: 0 });
    const head = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branchesOf(t, 'elsewhere/lib')).stdout).toContain(`issue-7-fix ${head}`);
    expect(eventsOf(t.app, 'github_proxy.refused').filter((e) => e.jobId === job.id)).toEqual([]);
  });

  it('reads a private repository its jobs do not use with its user\'s connection (issue #1015)', async () => {
    const t = await start();
    writeFileSync(join(t.gitRoot, 'elsewhere/lib.git', 'hopper-private'), '');
    const { home, git } = await running(t);
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const reads = t.github.gitRequests.filter((r) => r.path.startsWith('/elsewhere/lib'));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.auth).not.toBe('');
    expect(existsSync(join(home, 'lib', '.git'))).toBe(true);
  });

  it('pushes a branch to a repository the hopper does not work on, and opens a pull request there (issue #1806)', async () => {
    const t = await start();
    const { job, env, home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const work = join(home, 'lib');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'The change belongs here'], work);
    expect(await git(['push', 'origin', 'HEAD:refs/heads/issue-7-lib'], work)).toMatchObject({ code: 0 });
    const head = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branchesOf(t, 'elsewhere/lib')).stdout).toContain(`issue-7-lib ${head}`);
    expect(eventsOf(t.app, 'github_proxy.done')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'elsewhere/lib', refs: ['refs/heads/issue-7-lib'], as: 'owner' }) }),
    ]));

    const pr = await hopperGh(t.root, env, ['pr', 'create', '--repo', 'elsewhere/lib', '--head', 'issue-7-lib', '--title', 'The change', '--body', 'Closes octo/tools#7']);
    expect(pr).toMatchObject({ code: 0 });
    expect(JSON.parse(pr.stdout)).toMatchObject({ ok: true, op: 'pr.create', repo: 'elsewhere/lib', number: 1 });
    expect(await hopperGh(t.root, env, ['pr', 'ready', '1', '--repo', 'elsewhere/lib'])).toMatchObject({ code: 0 });
    const issue = await hopperGh(t.root, env, ['issue', 'create', '--repo', 'elsewhere/lib', '--title', 'x', '--body', 'y']);
    expect(JSON.parse(issue.stdout).error).toBe('refused: elsewhere/lib is not one of the repositories the hopper works on, so it does nothing there for a job but open a pull request from a branch it pushed');

    const toMain = await git(['push', 'origin', 'HEAD:refs/heads/dev'], work);
    expect(toMain.code).not.toBe(0);
    expect(toMain.stderr).toContain('a job pushes only to a branch of its own work, never to dev');
  });

  it('refuses a push to a repository the hopper does not work on when its user cannot push there (issue #1806)', async () => {
    const t = await start();
    t.github.notPushable = ['elsewhere/lib'];
    const { job, home, git } = await running(t);
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const work = join(home, 'lib');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Not mine'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-elsewhere'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('your user cannot push to elsewhere/lib: GitHub gives its connection no write access there');
    expect(t.github.gitRequests.filter((x) => x.path.startsWith('/elsewhere/lib') && x.path.endsWith('/git-receive-pack'))).toEqual([]);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'elsewhere/lib', reason: expect.stringContaining('cannot push to elsewhere/lib') }) }),
    ]));
  });

  it('a push GitHub refuses says GitHub\'s reason, not a bare HTTP 403 (issue #2042)', async () => {
    const t = await start();
    writeFileSync(join(t.gitRoot, 'elsewhere/lib.git', 'hopper-push-refused'), 'Resource protected by organization SAML enforcement.\n');
    const { job, home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const work = join(home, 'lib');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'The change belongs here'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/feature/x'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('GitHub refused the push (HTTP 403): Resource protected by organization SAML enforcement.');
    expect(r.stderr).not.toContain('RPC failed');
    expect((await branchesOf(t, 'elsewhere/lib')).stdout).not.toContain('feature/x');
    expect(eventsOf(t.app, 'github_proxy.failed')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'elsewhere/lib', error: expect.stringContaining('GitHub refused the push (HTTP 403)') }) }),
    ]));
  });

  it('with direct push on, pushes straight to the target branch as a fast-forward; a rewrite of it is refused (issue #1806)', async () => {
    const t = await start();
    const { job, home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const work = join(home, 'lib');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Straight to dev'], work);
    const off = await git(['push', 'origin', 'HEAD:refs/heads/dev'], work);
    expect(off.stderr).toContain('a job pushes only to a branch of its own work, never to dev');

    t.app.user().store.settings.setYoloMode({ on: false, repos: {}, push: ['elsewhere/lib'] });
    expect(await git(['push', 'origin', 'HEAD:refs/heads/dev'], work)).toMatchObject({ code: 0 });
    const head = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branchesOf(t, 'elsewhere/lib')).stdout).toContain(`dev ${head}`);
    expect(eventsOf(t.app, 'github_proxy.done')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'elsewhere/lib', refs: ['refs/heads/dev'], direct: ['refs/heads/dev'] }) }),
    ]));

    await git(['reset', '--quiet', '--hard', 'HEAD~1'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Rewrites dev'], work);
    const rewrite = await git(['push', '--force', 'origin', 'HEAD:refs/heads/dev'], work);
    expect(rewrite.code).not.toBe(0);
    expect(rewrite.stderr).toContain('a job pushes to dev only a fast-forward');
    expect((await branchesOf(t, 'elsewhere/lib')).stdout).toContain(`dev ${head}`);
    expect(await git(['push', 'origin', 'HEAD:refs/heads/stable'], work)).toMatchObject({ stderr: expect.stringContaining('never to stable') });
  });

  it('refuses a token that is no job\'s, and a job no longer at work', async () => {
    const t = await start();
    const { job, env } = await running(t);
    const token = readFileSync(join(t.root, env.HOPPER_TOKEN_FILE!), 'utf8');
    const refs = (password: string) => fetch(`${t.app.url}/job/git/octo/tools.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`hopper-job:${password}`).toString('base64')}` },
    });
    expect((await refs(`${token.slice(0, -2)}xx`)).status).toBe(401);
    expect((await fetch(`${t.app.url}/job/git/octo/tools.git/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect((await refs(token)).status).toBe(200);
    t.held.get(job.id)!.end();
    await t.app.waitForStatus(job.id, 'finished');
    expect((await refs(token)).status).toBe(401);
  });

  it('gives the job git\'s way to the hopper and its token file, never a GitHub token or an ssh agent', async () => {
    const t = await start();
    const { env } = await running(t);
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GH_CONFIG_DIR');
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(JSON.stringify(env)).not.toContain('test-account-token');
    expect(env).toMatchObject({ GIT_CONFIG_KEY_0: `url.${t.app.url}/job/git/.insteadOf`, GIT_CONFIG_VALUE_0: `${t.github.url}/` });
  });
});
