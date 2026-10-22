// Issue #652: git through the hopper — the parts. A job's git fetch and push go to the hopper, which does them on
// GitHub with its own connection; the job holds no GitHub token. What a push may change is read from the ref updates
// at the head of git's receive-pack request, before anything reaches GitHub. The whole path through the daemon, with a
// real git and a real git server, is test/integration/git-proxy.test.ts.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { checkPush, gitPath, jobGitConfig, receivePackCommands } from '../../src/github-proxy/index.ts';
import { GITHUB_PROXY_LINE } from '../../src/job-rules/index.ts';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const pkt = (s: string): string => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const request = (...lines: string[]): Buffer => Buffer.concat([Buffer.from(lines.map(pkt).join('') + '0000'), Buffer.from('PACK…')]);

describe('the ref updates of a push', () => {
  it('are read from the pkt-lines before the pack, the capabilities left off; the pack after them (issue #1096)', () => {
    expect(receivePackCommands(request(`${A} ${B} refs/heads/issue-7-fast\0report-status side-band-64k`, `${ZERO} ${B} refs/heads/two\n`))).toEqual({
      ok: true, commands: [{ old: A, new: B, ref: 'refs/heads/issue-7-fast' }, { old: ZERO, new: B, ref: 'refs/heads/two' }], pack: Buffer.from('PACK…'),
    });
  });

  it('a signed push, a shallow line or text that is no pkt-line is not read; a shallow push keeps its ref updates (issue #2481)', () => {
    expect(receivePackCommands(request(`push-cert\0report-status`))).toEqual({ ok: false, reason: 'a signed push (push-cert) is not taken', commands: [] });
    expect(receivePackCommands(request(`shallow ${A}`, `${A} ${B} refs/heads/x\0report-status`))).toEqual({
      ok: false, reason: 'a push from a shallow clone is not taken: fetch the full history first (git fetch --unshallow), then push again', commands: [{ old: A, new: B, ref: 'refs/heads/x' }],
    });
    expect(receivePackCommands(Buffer.from('zzzz'))).toEqual({ ok: false, reason: 'not a git push', commands: [] });
    expect(receivePackCommands(request())).toEqual({ ok: false, reason: 'the push names no ref', commands: [] });
  });
});

describe('what a job may push', () => {
  const at = { defaultBranch: 'dev' };

  it('a branch of its own work: new, updated, or forced', () => {
    expect(checkPush([{ old: ZERO, new: B, ref: 'refs/heads/issue-7-fast' }], at)).toEqual({ ok: true });
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/issue-7-fast' }], at)).toEqual({ ok: true });
  });

  it('never the default branch, a release branch, a tag, or a delete', () => {
    for (const branch of ['dev', 'main', 'master', 'beta', 'stable', 'DEV']) {
      expect(checkPush([{ old: A, new: B, ref: `refs/heads/${branch}` }], at)).toEqual({ ok: false, reason: `a job pushes only to a branch of its own work, never to ${branch}: push a new branch and open a pull request` });
    }
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/trunk' }], { defaultBranch: 'trunk' })).toMatchObject({ ok: false });
    expect(checkPush([{ old: ZERO, new: B, ref: 'refs/tags/v1' }], at)).toEqual({ ok: false, reason: 'a job pushes branches only, not refs/tags/v1' });
    expect(checkPush([{ old: A, new: ZERO, ref: 'refs/heads/issue-7-fast' }], at)).toEqual({ ok: false, reason: 'a job deletes no branch (refs/heads/issue-7-fast)' });
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/ok' }, { old: A, new: B, ref: 'refs/heads/main' }], at)).toMatchObject({ ok: false });
  });

  it('with direct push on (issue #1806): the target branch is taken; every other kept branch, a tag and a delete are still refused', () => {
    const direct = { defaultBranch: 'main', direct: 'main' };
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/main' }], direct)).toEqual({ ok: true });
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/MAIN' }], direct)).toEqual({ ok: true });
    for (const branch of ['dev', 'beta', 'stable']) expect(checkPush([{ old: A, new: B, ref: `refs/heads/${branch}` }], direct)).toMatchObject({ ok: false });
    expect(checkPush([{ old: A, new: ZERO, ref: 'refs/heads/main' }], direct)).toEqual({ ok: false, reason: 'a job deletes no branch (refs/heads/main)' });
    expect(checkPush([{ old: ZERO, new: B, ref: 'refs/tags/v1' }], direct)).toMatchObject({ ok: false });
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/hopper-batch/0123456789ab' }], { ...direct, direct: 'hopper-batch/0123456789ab' })).toMatchObject({ ok: false });
  });

  it('never a batch run\'s branch (issue #1073): what its checks test is what the hopper merges', () => {
    expect(checkPush([{ old: A, new: B, ref: 'refs/heads/hopper-batch/0123456789ab' }], at))
      .toEqual({ ok: false, reason: 'a job pushes only to a branch of its own work, never to a batch run\'s branch (hopper-batch/0123456789ab)' });
  });
});

describe('the path of a git request', () => {
  it('names the repository and the git service, with or without .git', () => {
    expect(gitPath('octo/tools.git/info/refs', 'git-upload-pack')).toEqual({ repo: 'octo/tools', service: 'git-upload-pack', advertise: true });
    expect(gitPath('octo/tools/info/refs', 'git-receive-pack')).toEqual({ repo: 'octo/tools', service: 'git-receive-pack', advertise: true });
    expect(gitPath('octo/tools.git/git-receive-pack', undefined)).toEqual({ repo: 'octo/tools', service: 'git-receive-pack', advertise: false });
    expect(gitPath('octo/tools.git/info/refs', undefined)).toBeUndefined();
    expect(gitPath('octo/tools.git/objects/info/packs', undefined)).toBeUndefined();
    expect(gitPath('../etc/info/refs', 'git-upload-pack')).toBeUndefined();
  });

  it('takes a repository whose name starts with a dot, never . or .. (issue #867)', () => {
    expect(gitPath('octo/.github.git/info/refs', 'git-upload-pack')).toEqual({ repo: 'octo/.github', service: 'git-upload-pack', advertise: true });
    expect(gitPath('octo/.github/git-upload-pack', undefined)).toEqual({ repo: 'octo/.github', service: 'git-upload-pack', advertise: false });
    expect(gitPath('octo/.github.git/git-receive-pack', undefined)).toEqual({ repo: 'octo/.github', service: 'git-receive-pack', advertise: false });
    for (const name of ['.', '..', '.git', '...git']) expect(gitPath(`octo/${name}/info/refs`, 'git-upload-pack')).toBeUndefined();
    expect(gitPath('.octo/tools.git/info/refs', 'git-upload-pack')).toBeUndefined();
  });
});

describe('the git config a job runs with', () => {
  it('sends every GitHub remote to the hopper, and answers git\'s credential ask from the job\'s token file', () => {
    expect(jobGitConfig('http://hopper:4790', 'https://github.com')).toEqual({
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'url.http://hopper:4790/job/git/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_KEY_1: 'url.http://hopper:4790/job/git/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.http://hopper:4790/job/git/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'credential.http://hopper:4790/job/git/.helper', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'credential.http://hopper:4790/job/git/.helper',
      GIT_CONFIG_VALUE_4: '!f() { test "$1" = get || exit 0; echo username=hopper-job; printf \'password=%s\\n\' "$(cat "$HOPPER_TOKEN_FILE")"; }; f',
    });
  });

  it('a GitLab job\'s (issue #1448 part 3): also its GitLab, to the hopper\'s GitLab git route, its credential ask answered the same way', () => {
    const vars = jobGitConfig('http://hopper:4790/', 'https://github.com', { url: 'https://gitlab.example/', path: '/job/gitlab-git/' });
    expect(vars.GIT_CONFIG_COUNT).toBe('8');
    expect([vars.GIT_CONFIG_KEY_5, vars.GIT_CONFIG_VALUE_5]).toEqual(['url.http://hopper:4790/job/gitlab-git/.insteadOf', 'https://gitlab.example/']);
    expect([vars.GIT_CONFIG_KEY_6, vars.GIT_CONFIG_VALUE_6]).toEqual(['credential.http://hopper:4790/job/gitlab-git/.helper', '']);
    expect([vars.GIT_CONFIG_KEY_7, vars.GIT_CONFIG_VALUE_7]).toEqual(['credential.http://hopper:4790/job/gitlab-git/.helper', vars.GIT_CONFIG_VALUE_4]);
  });
});

describe('a job\'s git carries its trace (issue #1486 part 6)', () => {
  const PARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  /** What git reads as the extra header for `url`, with the job's variables: real git, no repository (run from `/`, so the
   * config of the checkout the tests run in, such as CI's own extra header for GitHub, is not read). */
  const extraHeader = (vars: Record<string, string>, url: string): string =>
    spawnSync('/usr/bin/git', ['config', '--get-urlmatch', 'http.extraheader', url], { cwd: '/', env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', ...vars }, encoding: 'utf8' }).stdout.trim();

  it('sends the job\'s trace parent as the traceparent header to the hopper, GitHub and GitLab routes alike, and to nothing else', () => {
    const vars = jobGitConfig('http://hopper:4790', 'https://github.com', { url: 'https://gitlab.example/', path: '/job/gitlab-git/' }, PARENT);
    expect(extraHeader(vars, 'http://hopper:4790/job/git/o/r.git')).toBe(`traceparent: ${PARENT}`);
    expect(extraHeader(vars, 'http://hopper:4790/job/gitlab-git/g/p.git')).toBe(`traceparent: ${PARENT}`);
    expect(extraHeader(vars, 'https://github.com/o/r.git')).toBe('');
    expect(extraHeader(vars, 'https://elsewhere.example/o/r.git')).toBe('');
  });

  it('sends none with no trace parent, or one that is not a W3C trace parent', () => {
    expect(jobGitConfig('http://hopper:4790', 'https://github.com')).toEqual(jobGitConfig('http://hopper:4790', 'https://github.com', undefined, undefined));
    for (const bad of [`${PARENT}\nx-added: 1`, 'NOT A PARENT', '']) {
      const vars = jobGitConfig('http://hopper:4790', 'https://github.com', undefined, bad);
      expect(vars.GIT_CONFIG_COUNT).toBe('5');
      expect(extraHeader(vars, 'http://hopper:4790/job/git/o/r.git')).toBe('');
    }
  });
});

describe('what a job is told', () => {
  it('that its machine holds no GitHub token, and its git goes through the hopper by itself', () => {
    expect(GITHUB_PROXY_LINE).toContain('This machine holds no GitHub token: git fetch and git push to GitHub go through the hopper by themselves');
  });

  // Issue #698: a job that could not reach the hopper fell back to a device sign-in on GitHub.
  it('that when the hopper cannot be reached it fails, and never signs in to GitHub another way', () => {
    expect(GITHUB_PROXY_LINE).toContain('If the hopper cannot be reached from here (HOPPER_URL is not set, or hopper-gh or git to GitHub cannot connect to it), do not sign in to GitHub another way: end with HOPPER_FAILED and say that this machine cannot reach the hopper.');
  });
});
