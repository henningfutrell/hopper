// Issue #652: a job holds no GitHub token. Its git fetch and push go to the hopper, which does them on GitHub with the
// connection of the job's own user; a push changes only a branch of the job's own repository, never its default or a
// release branch. The daemon, store and HTTP edge are real; GitHub is a fake on loopback whose git is git's own
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
//   Scenario: a job pushes to another repository than its own
//     Then the push is refused with the reason
//   Scenario: a job of a repository outside the job repositories pushes to its own repository (issue #1131)
//     Given a job whose own repository is no job repository (a source other than the account's, or one chosen no more)
//     When the job pushes a branch, then pushes it again with --force-with-lease, as a tend job's rebase does
//     Then both pushes are on GitHub
//   Scenario: a job reads a repository its jobs do not use (issue #1015)
//     Given a private repository outside the job repositories that the user's connection sees
//     Then the hopper reads it with the user's connection, and pushes nothing there
//   Scenario: the job's variables carry no GitHub token and no ssh agent
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubTraffic } from '../../src/github-limiter/traffic.ts';
import { branchesOf, cleanups, eventsOf, running, start, stopGitProxies } from '../support/git-proxy.ts';

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
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'octo/tools', refs: ['refs/heads/issue-7-fix'], own: true }) }),
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

  it('refuses a push to another repository than the job\'s own', async () => {
    const t = await start();
    const { home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/octo/site.git`, 'site'])).code).toBe(0);
    const work = join(home, 'site');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Not mine'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-elsewhere'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('a job pushes only to its own repository (octo/tools)');
    expect((await branchesOf(t, 'octo/site')).stdout).not.toContain('issue-7-elsewhere');
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

  it('reads a private repository its jobs do not use with its user\'s connection, and pushes nothing there (issue #1015)', async () => {
    const t = await start();
    writeFileSync(join(t.gitRoot, 'elsewhere/lib.git', 'hopper-private'), '');
    const { home, git } = await running(t);
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const reads = t.github.gitRequests.filter((r) => r.path.startsWith('/elsewhere/lib'));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.auth).not.toBe('');
    const work = join(home, 'lib');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Not mine'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-elsewhere'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('a job pushes only to its own repository (octo/tools)');
    expect(t.github.gitRequests.filter((x) => x.path.startsWith('/elsewhere/lib') && x.path.endsWith('/git-receive-pack'))).toEqual([]);
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
